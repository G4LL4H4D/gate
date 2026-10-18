import { Plugin } from "@opencode/plugin"
import { Gate, type ChildEntry, type DebugInfo, type RecentEntry, type Stats } from "./rpc"

// Cloud provider IDs — runtime Provider.ID values (kebab-case). Anything not in this set is local.
const CLOUD_PROVIDERS = new Set([
	"opencode",
	"anthropic",
	"openai",
	"google",
	"google-vertex",
	"github-copilot",
	"amazon-bedrock",
	"azure",
	"openrouter",
	"mistral",
	"gitlab",
	"groq",
	"xai",
	"deepseek",
	"together",
	"fireworks",
	"cerebras",
])

const LOCAL_CHILD_CAP = 2
const GRACE_MS = 5_000
const TTL_MS = 60_000
const RECONNECT_DELAY_MS = 1_000
const RECENT_LIMIT = 20

interface Reservation {
	parentID: string
	at: number
}

interface RerouteEntry {
	callID: string
	parentID: string
	model: string
	agent?: string
	description?: string
	at: number
}

type RecentRecord = RecentEntry & { callID: string }

function isLocalProvider(providerID: string | undefined): boolean {
	return !!providerID && !CLOUD_PROVIDERS.has(providerID)
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const describeError = (err: unknown) => (err instanceof Error ? err.message : String(err))

export default Plugin.define({
	id: "subagent-gate",
	async setup(ctx) {
		const localChildren = new Set<string>()
		const activeLocalChildren = new Set<string>()
		const createdAt = new Map<string, number>()
		const startedAt = new Map<string, number>()
		const reservations = new Map<string, Reservation>()
		// Tool-call IDs rerouted to a cloud model, so execute.after can note it on the result.
		const reroutedCalls = new Map<string, { model: string; at: number }>()
		const pendingReroutes: RerouteEntry[] = []
		const recent: RecentRecord[] = []
		const counters = { launchedLocal: 0, rerouted: 0, denied: 0 }
		let chain: Promise<void> = Promise.resolve()

		const childInfo = new Map<string, ChildEntry>()
		const reroutedTitles = new Map<string, string>()
		let debug: DebugInfo = { lastDecision: "none", active: 0, reservations: 0, at: 0 }

		const snapshot = (): Stats => ({
			active: activeLocalChildren.size + reservations.size,
			cap: LOCAL_CHILD_CAP,
			...counters,
			recent: recent.slice(-RECENT_LIMIT).map(({ callID: _callID, ...entry }) => ({ ...entry })),
			children: [...childInfo.values()],
			debug: { ...debug },
		})

		const reg = await ctx.rpc.register(Gate, { stats: async () => snapshot() })

		const emit = () => {
			reg.events.emit("changed", snapshot()).catch((err) => console.warn("[subagent-gate] emit failed:", err))
		}

		const record = (entry: RecentRecord) => {
			recent.push(entry)
			if (recent.length > RECENT_LIMIT) recent.shift()
		}

		const pruneExpired = () => {
			const cutoff = Date.now() - TTL_MS
			for (const [id, reservation] of reservations) {
				if (reservation.at < cutoff) reservations.delete(id)
			}
			while (pendingReroutes.length > 0 && pendingReroutes[0].at < cutoff) pendingReroutes.shift()
			// Prune stale createdAt entries.
			for (const [id, ts] of createdAt) {
				if (ts < cutoff) createdAt.delete(id)
			}
			// Prune stale reroutedCalls entries.
			for (const [id, entry] of reroutedCalls) {
				if (entry.at < cutoff) reroutedCalls.delete(id)
			}
		}

		const isFull = () => activeLocalChildren.size + reservations.size >= LOCAL_CHILD_CAP

		// Order: explicit model override → agent model → parent session model → default model.
		const resolveProvider = async (
			agentID: string | undefined,
			modelString: string | undefined,
			parentID: string,
		): Promise<string | undefined> => {
			if (typeof modelString === "string" && modelString.includes("/")) return modelString.split("/")[0]
			if (agentID) {
				const { data: agents } = await ctx.agent.list()
				const agent = agents.find((a) => a.id === agentID || a.name === agentID)
				if (agent?.model?.providerID) return agent.model.providerID
			}
			const parentProvider = await getParentProvider(parentID)
			if (parentProvider) return parentProvider
			// Fallback: use the configured default model's provider.
			try {
				const def = await ctx.model.default()
				return def.data?.providerID
			} catch {
				return undefined
			}
		}

		const getParentProvider = async (parentID: string): Promise<string | undefined> => {
			try {
				return (await ctx.session.get({ sessionID: parentID })).model?.providerID
			} catch {
				return undefined
			}
		}

		// Cheapest tool-capable cloud model, preferring the parent's provider.
		const suggestCloudModel = async (parentProviderID: string | undefined): Promise<string | undefined> => {
			const { data: models } = await ctx.model.list()
			const candidates = models
				.filter((m) => m.enabled === true && m.status === "active" && m.capabilities?.tools === true && !isLocalProvider(m.providerID))
				.map((m) => ({ providerID: m.providerID, id: m.id, costOutput: m.cost?.[0]?.output ?? Infinity }))
			if (candidates.length === 0) return undefined
			const parentMatches = candidates.filter((m) => m.providerID === parentProviderID)
			const cheapest = (parentMatches.length > 0 ? parentMatches : candidates).sort((a, b) => a.costOutput - b.costOutput || 0)[0]
			return cheapest.providerID + "/" + cheapest.id
		}

		// Drop active entries whose session is gone or finished. Mutates in place: events may arrive meanwhile.
		const reconcile = async () => {
			const now = Date.now()
			const dropped: string[] = []
			await Promise.all(
				[...activeLocalChildren].map(async (id) => {
					if (now - (createdAt.get(id) ?? 0) < GRACE_MS) return
					try {
						const session = await ctx.session.get({ sessionID: id })
						const sa = startedAt.get(id)
						if (!sa) return
						if (!session.time.idle || session.time.idle < sa) return
					} catch (err) {
						const msg = describeError(err)
						const isNotFound =
							(err instanceof Error && (err.name === "NotFoundError" || (err as any)._tag === "NotFoundError")) ||
							(err instanceof Error && (err.message.includes("not found") || err.message.includes("NotFound"))) ||
							(typeof err === "object" && err !== null && "status" in err && (err as any).status === 404)
						if (isNotFound) {
							dropped.push(id)
							return
						}
						console.warn("[subagent-gate] reconcile ctx.session.get error for", id, ":", msg)
						return
					}
					dropped.push(id)
				}),
			)
			if (dropped.length === 0) return
			for (const id of dropped) {
				activeLocalChildren.delete(id)
				startedAt.delete(id)
				childInfo.delete(id)
			}
			console.info("[subagent-gate] reconcile dropped", dropped.length, "→ active", activeLocalChildren.size)
			emit()
		}

		// Cap decision, reservation and reroute choice. Must only run inside the chain lock.
		const decide = async (event: { id: string; sessionID: string; input: unknown }, providerID: string | undefined) => {
			const input = (event.input ?? {}) as Record<string, unknown>
			pruneExpired()
			if (isFull() && activeLocalChildren.size > 0) await reconcile()

			if (!isFull()) {
				reservations.set(event.id, { parentID: event.sessionID, at: Date.now() })
				counters.launchedLocal++
				debug = { lastDecision: "local", active: activeLocalChildren.size, reservations: reservations.size, at: Date.now() }
				console.info("[subagent-gate] decision", "local", "active", activeLocalChildren.size, "reservations", reservations.size, "cap", LOCAL_CHILD_CAP)
				emit()
				return
			}

			const agent = typeof input.agent === "string" ? input.agent : undefined
			const status = "Local-model subagent cap reached (" + (activeLocalChildren.size + reservations.size) + "/" + LOCAL_CHILD_CAP + " active)."

			let suggestion: string | undefined
			let suggestionError: unknown
			try {
				suggestion = await suggestCloudModel(await getParentProvider(event.sessionID))
			} catch (err) {
				suggestionError = err
			}

			if (suggestion) {
				event.input = { ...input, model: suggestion }
				reroutedCalls.set(event.id, { model: suggestion, at: Date.now() })
				pendingReroutes.push({ callID: event.id, parentID: event.sessionID, model: suggestion, agent, description: typeof input.description === "string" ? input.description : undefined, at: Date.now() })
				counters.rerouted++
				record({ time: Date.now(), kind: "reroute", agent, parentID: event.sessionID, model: suggestion, callID: event.id })
				debug = { lastDecision: "reroute", active: activeLocalChildren.size, reservations: reservations.size, at: Date.now() }
				console.info("[subagent-gate] decision", "reroute", "active", activeLocalChildren.size, "reservations", reservations.size, "cap", LOCAL_CHILD_CAP)
				console.info("[subagent-gate] reroute:", agent ?? "(unnamed)", "→", suggestion, "-", status)
				emit()
				return
			}

			counters.denied++
			record({ time: Date.now(), kind: "deny", agent, parentID: event.sessionID, model: providerID, callID: event.id })
			debug = { lastDecision: "deny", active: activeLocalChildren.size, reservations: reservations.size, at: Date.now() }
			console.warn("[subagent-gate] decision", "deny", "active", activeLocalChildren.size, "reservations", reservations.size, "cap", LOCAL_CHILD_CAP)
			console.warn("[subagent-gate] deny:", agent ?? "(unnamed)", "-", status)
			emit()
			throw new Error(
				suggestionError
					? status + " Could not resolve a cloud model (" + describeError(suggestionError) + "); wait for a local subagent to finish, then retry."
					: status + " No cloud model available; wait for a local subagent to finish, then retry.",
			)
		}

		// ── Event handling ──────────────────────────────────────────────

		type CreatedData = {
			sessionID: string
			parentID?: string
			model?: { providerID: string; id: string }
			agent?: string
			title?: string
			slug: string
		}

		// Returns true when the child is the target of a rerouted call.
		// allowParentOnlyMatch: when data.model is missing/unmatched, allow matching pending reroutes by parentID only.
		// shortcut: reservations matched by parentID not call, upgrade if session.created exposes callID
		const linkReroute = (data: CreatedData, parentID: string, allowParentOnlyMatch: boolean): boolean => {
			const childModel = data.model ? data.model.providerID + "/" + data.model.id : undefined
			let index = childModel
				? pendingReroutes.findIndex((r) => r.parentID === parentID && r.model === childModel)
				: -1
			if (index === -1 && allowParentOnlyMatch) {
				index = pendingReroutes.findIndex((r) => r.parentID === parentID)
			}
			if (index === -1) return false
			const [entry] = pendingReroutes.splice(index, 1)
			const match = recent.find((r) => r.callID === entry.callID)
			if (match) match.childID = data.sessionID
			emit()
			// Track child info for rerouted child.
			childInfo.set(data.sessionID, { childID: data.sessionID, parentID, ...(entry.agent && { agent: entry.agent }), ...(entry.model && { model: entry.model }), local: false })
			// Track desired title when description exists.
			if (entry.description) {
				const desiredTitle = entry.description + " [routed to " + entry.model + "]"
				reroutedTitles.set(data.sessionID, desiredTitle)
				// Belt-and-braces: if title already set, update once.
				if (data.title && !data.title.includes("[routed to ")) {
					ctx.session
						.update({ sessionID: data.sessionID, title: desiredTitle })
						.catch((err) => console.warn("[subagent-gate] belt title update failed:", err))
				}
			} else {
				// Fallback: rename when no description was provided.
				ctx.session
					.update({ sessionID: data.sessionID, title: (data.title ?? data.slug) + " [routed to " + entry.model + "]" })
					.catch((err) => console.warn("[subagent-gate] title update failed:", err))
			}
			return true
		}

		const onChildCreated = async (data: CreatedData, parentID: string) => {
			pruneExpired()

			// Resolve provider first so linkReroute can decide correctly.
			let providerID: string | undefined
			try {
				providerID = data.model?.providerID ?? (await resolveProvider(data.agent, undefined, parentID))
			} catch (err) {
				providerID = data.model?.providerID
			}
			if (!providerID) {
				console.warn("[subagent-gate] onChildCreated: unknown provider for", data.sessionID)
				return
			}

			// Only allow parentID-only reroute match when provider is not local or no reservation for this parent.
			const hasReservation = [...reservations].some(([, r]) => r.parentID === parentID)
			const allowParentOnlyMatch = !isLocalProvider(providerID) || !hasReservation
			if (linkReroute(data, parentID, allowParentOnlyMatch)) return

			if (!isLocalProvider(providerID)) return

			if (hasReservation) {
				const oldest = [...reservations].find(([, r]) => r.parentID === parentID)
				if (oldest) reservations.delete(oldest[0])
			}
			localChildren.add(data.sessionID)
			activeLocalChildren.add(data.sessionID)
			createdAt.set(data.sessionID, Date.now())
			startedAt.set(data.sessionID, Date.now())
			// Track child info for local child.
			const modelStr = data.model ? data.model.providerID + "/" + data.model.id : providerID
			childInfo.set(data.sessionID, { childID: data.sessionID, parentID, ...(data.agent && { agent: data.agent }), ...(modelStr && { model: modelStr }), local: true })
			console.info("[subagent-gate] local child created:", data.sessionID, "active", activeLocalChildren.size)
			emit()
		}

		type GateEvent = ReturnType<typeof ctx.event.subscribe> extends AsyncIterable<infer E> ? E : never

		const handle = async (event: GateEvent) => {
			switch (event.type) {
				case "session.created": {
					const parentID = event.data.parentID
					if (parentID) await onChildCreated(event.data, parentID)
					return
				}
				case "session.execution.started": {
					if (localChildren.has(event.data.sessionID) && !activeLocalChildren.has(event.data.sessionID)) {
						activeLocalChildren.add(event.data.sessionID)
						startedAt.set(event.data.sessionID, Date.now())
						emit()
					}
					return
				}
				case "session.execution.succeeded":
				case "session.execution.failed":
				case "session.execution.interrupted": {
					const id = event.data.sessionID
					if (activeLocalChildren.delete(id)) {
						createdAt.delete(id)
						startedAt.delete(id)
						childInfo.delete(id)
						reroutedTitles.delete(id)
						emit()
					}
					// Rerouted children are not in activeLocalChildren but may be in childInfo.
					if (childInfo.has(id)) {
						childInfo.delete(id)
						reroutedTitles.delete(id)
						emit()
					}
					return
				}
				case "session.deleted": {
					const id = event.data.sessionID
					const wasActive = activeLocalChildren.delete(id)
					localChildren.delete(id)
					createdAt.delete(id)
					startedAt.delete(id)
					const hadInfo = childInfo.delete(id)
					reroutedTitles.delete(id)
					if (wasActive || hadInfo) emit()
					return
				}
			}
		}

		const controller = new AbortController()

		const runEventLoop = async () => {
			let delay = RECONNECT_DELAY_MS
			while (!controller.signal.aborted) {
				try {
					for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
						if (delay > RECONNECT_DELAY_MS) delay = RECONNECT_DELAY_MS
						try {
							await handle(event)
						} catch (err) {
							console.warn("[subagent-gate] event handler failed:", event.type, err)
						}
					}
				} catch (err) {
					if (controller.signal.aborted) return
					console.warn("[subagent-gate] event stream error:", err)
				}
				if (controller.signal.aborted) return
				console.warn("[subagent-gate] event stream ended, reconnecting")
				await sleep(delay).catch(() => {}) // sleep may be aborted
				if (controller.signal.aborted) return
				await reconcile().catch((err) => console.warn("[subagent-gate] reconcile failed:", err))
				// Exponential backoff capped at 30s; reset after successful reconnect.
				delay = Math.min(delay * 2, 30_000)
			}
		}
		void runEventLoop()

		// ── Hooks ───────────────────────────────────────────────────────

		// Uses execute.before (not permission.evaluate) because only the tool input
		// carries the orchestrator's `model` override, so a rerouted call takes effect.
		try {
			await ctx.tool.hook("execute.before", async (event) => {
			if (event.tool !== "subagent") return
			const input = (event.input ?? {}) as Record<string, unknown>
			let providerID: string | undefined
			try {
				providerID = await resolveProvider(
					typeof input.agent === "string" ? input.agent : undefined,
					typeof input.model === "string" ? input.model : undefined,
					event.sessionID,
				)
			} catch (err) {
				console.warn("[subagent-gate] resolveProvider failed:", describeError(err))
				// Fall back to parent session's provider.
				try {
					providerID = (await ctx.session.get({ sessionID: event.sessionID })).model?.providerID
				} catch {
					// Can't resolve provider at all — skip the gate, allow the call.
					return
				}
			}
			if (!isLocalProvider(providerID)) return

			const run = chain.then(() => decide(event, providerID))
			chain = run.then(
				() => {},
				() => {},
			)
			try {
				await run
			} catch (err) {
				// decide may throw after making a reservation; release it.
				if (reservations.delete(event.id)) emit()
				throw err
			}
		})

		await ctx.tool.hook("execute.after", async (event) => {
			if (event.status !== "completed") {
				// Call failed — release its reservation so the slot frees up.
				if (reservations.delete(event.id)) emit()
				// Also clean up reroute tracking for failed calls.
				reroutedCalls.delete(event.id)
				const pi = pendingReroutes.findIndex((r) => r.callID === event.id)
				if (pi !== -1) {
					pendingReroutes.splice(pi, 1)
					emit()
				}
				return
			}
			const model = reroutedCalls.get(event.id)
			if (!model) return
			reroutedCalls.delete(event.id)
			try {
				appendRerouteNote(event.result, "[subagent-gate: rerouted to " + model.model + "]")
			} catch {
				// best-effort note; never fail the call over this
			}
		})

		await ctx.session.hook("context", (event) => {
			if (localChildren.has(event.sessionID)) return
			if (event.model && isLocalProvider(event.model.providerID)) return
			event.system.push({
				type: "text",
				text:
					"When delegating independent work to subagents, prefer launching multiple in parallel (background: true) rather than one at a time — there is no concurrency limit for cloud-model subagents. Local-model subagents are capped at " +
					LOCAL_CHILD_CAP +
					" concurrent; overflow is routed to a cloud model automatically when one is available.",
			})
		})

		await ctx.session.hook("title", (event) => {
			const title = reroutedTitles.get(event.sessionID)
			if (!title) return
			event.result = title
		})

		// Catch registration errors during setup: abort controller, dispose rpc reg, rethrow.
		} catch (err) {
			controller.abort()
			await reg.dispose()
			throw err
		}

		return async () => {
			controller.abort()
			await reg.dispose()
		}
	},
})

// Appends a short note to a tool result's visible text, tolerating unconfirmed result shapes.
function appendRerouteNote(result: any, note: string): void {
	if (typeof result?.output === "string") {
		result.output += "\n\n" + note
		return
	}
	if (Array.isArray(result?.content)) {
		const textPart = result.content.find((p: any) => p?.type === "text" && typeof p.text === "string")
		if (textPart) {
			textPart.text += "\n\n" + note
			return
		}
		result.content.push({ type: "text", text: note })
	}
}
