import { Plugin } from "@opencode/plugin"
import { Gate, type ChildEntry, type DebugInfo, type RecentEntry, type Stats } from "./rpc"
import { createGate, claimRerouteForChild, shouldDropActive, withTimeout, stripUndefined } from "./gate"
import { DEFAULT_SETTINGS, parseSettings, resolveSettings, wireSettings } from "./settings"
import type { Settings } from "./settings"

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

function isLocalProvider(providerID: string | undefined, extraCloudProviders?: string[]): boolean {
	if (!providerID) return false
	if (CLOUD_PROVIDERS.has(providerID)) return false
	if (extraCloudProviders?.includes(providerID.toLowerCase())) return false
	return true
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const describeError = (err: unknown) => (err instanceof Error ? err.message : String(err))

export default Plugin.define({
	id: "gate",
	async setup(ctx) {
		const localChildren = new Set<string>()
		const createdAt = new Map<string, number>()
		const startedAt = new Map<string, number>()
		// ── Settings ──────────────────────────────────────────────────────

		let settings: Settings
		let stored: unknown
		try {
			stored = await ctx.storage.get("settings")
		} catch (err) {
			console.warn("[gate] storage read failed, using options + defaults:", describeError(err))
			stored = undefined
		}
		try {
			settings = resolveSettings(stored, ctx.options)
		} catch (err) {
			console.warn("[gate] invalid stored settings, ignoring:", describeError(err))
			settings = resolveSettings(undefined, ctx.options)
		}
		// If only options are invalid, resolveSettings → parseSettings throws (fail loud).

		const logDebug = (...args: Parameters<typeof console.info>): void => {
			if (settings.debug) console.info("[gate]", ...args)
		}

		const gate = createGate({ getCap: () => settings.cap, ttlMs: TTL_MS, now: () => Date.now() })
		// Tool-call IDs rerouted to a cloud model, so execute.after can note it on the result.
		const reroutedCalls = new Map<string, { model: string; at: number }>()
		const pendingReroutes: RerouteEntry[] = []
		const claimedReroutes = new Map<string, RerouteEntry>()
		const recent: RecentRecord[] = []
		const counters = { launchedLocal: 0, rerouted: 0, denied: 0 }
		let chain: Promise<void> = Promise.resolve()
		let settingsChain: Promise<void> = Promise.resolve()

		const childInfo = new Map<string, ChildEntry>()
		const reroutedTitles = new Map<string, string>()
		const localChildEntries = new Map<string, ChildEntry>()
		let debug: DebugInfo = { lastDecision: "none", active: 0, reservations: 0, at: 0 }

		const snapshot = (): Stats => {
			const c = gate.counts()
			return {
				active: c.active + c.reservations,
				cap: c.cap,
				...counters,
				recent: recent.slice(-RECENT_LIMIT).map(({ callID: _callID, ...entry }) => stripUndefined({ ...entry })),
				children: [...childInfo.values()],
				debug: { ...debug },
			}
		}

		const reg = await ctx.rpc.register(Gate, {
			stats: async () => snapshot(),
			settingsGet: async () => wireSettings(settings),
			settingsSet: async (input, context) => {
				let parsed: Settings
				try {
					parsed = parseSettings(input)
				} catch (err) {
					return context.error("validation_error", describeError(err), { message: describeError(err) })
				}
				// Validate rerouteModel provider is cloud (only if model list is readable).
				if (parsed.rerouteModel) {
					try {
						const models = await withTimeout(ctx.model.list(), 5_000, "settingsSet-model.list")
						const found = models.data?.find((m) => m.providerID + "/" + m.id === parsed.rerouteModel)
						if (found && isLocalProvider(found.providerID, parsed.extraCloudProviders)) {
							return context.error("validation_error", "rerouteModel provider is local, must be cloud: " + parsed.rerouteModel, { message: "rerouteModel provider is local" })
						}
					} catch (err) {
						// Model list unreadable within timeout — accept the value.
						console.warn("[gate] model.list unavailable during settingsSet, accepting rerouteModel:", parsed.rerouteModel)
					}
				}
				// Persist → assign → emit through settingsChain; await the link and return its result.
				const run = settingsChain.then(async () => {
					try {
						const wired = wireSettings(parsed)
						await ctx.storage.set("settings", wired)
					} catch (e) {
						return context.error("validation_error", "could not persist settings: " + describeError(e), { message: describeError(e) })
					}
					settings = parsed
					reg.events.emit("settingsChanged", wireSettings(settings)).catch((e) => console.warn("[gate] settingsChanged emit failed:", e))
					emit()
					return wireSettings(parsed)
				})
				settingsChain = run.then(() => {}, () => {})
				return run
			},
		})

		const emit = () => {
			reg.events.emit("changed", snapshot()).catch((err) => console.warn("[gate] emit failed:", err))
		}

		const record = (entry: RecentRecord) => {
			recent.push(entry)
			if (recent.length > RECENT_LIMIT) recent.shift()
		}

		const pruneExpired = () => {
			gate.expire()
			while (pendingReroutes.length > 0 && pendingReroutes[0].at < Date.now() - TTL_MS) pendingReroutes.shift()
			// Prune stale createdAt entries.
			for (const [id, ts] of createdAt) {
				if (ts < Date.now() - TTL_MS) createdAt.delete(id)
			}
			// Prune stale reroutedCalls entries.
			for (const [id, entry] of reroutedCalls) {
				if (entry.at < Date.now() - TTL_MS) reroutedCalls.delete(id)
			}
		}

		const isFull = () => {
			const c = gate.counts()
			return c.active + c.reservations >= c.cap
		}

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
				.filter((m) => m.enabled === true && m.status === "active" && m.capabilities?.tools === true && !isLocalProvider(m.providerID, settings.extraCloudProviders))
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
				[...gate.activeIDs()].map(async (id) => {
					if (now - (createdAt.get(id) ?? 0) < GRACE_MS) return
					try {
						const session = await withTimeout(ctx.session.get({ sessionID: id }), 5_000, "reconcile-session.get")
						const sa = startedAt.get(id)
						if (!shouldDropActive(session.time.idle, sa)) return
						// idle >= started → session finished but we missed the event
						dropped.push(id)
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
						console.warn("[gate] reconcile ctx.session.get error for", id, ":", msg)
						return
					}
				}),
			)
			if (dropped.length === 0) return
			for (const id of dropped) {
				gate.deactivate(id)
				startedAt.delete(id)
				childInfo.delete(id)
			}
			logDebug("[gate] reconcile dropped", dropped.length, "→ active", gate.counts().active)

			// Prune stale localChildEntries.
			for (const id of [...localChildEntries.keys()]) {
				if (!childInfo.has(id) && !localChildren.has(id)) localChildEntries.delete(id)
			}

			emit()
		}

		// Cap decision, reservation and reroute choice. Must only run inside the chain lock.
		const decide = async (event: { id: string; sessionID: string; input: unknown }, providerID: string | undefined) => {
			const input = (event.input ?? {}) as Record<string, unknown>
			pruneExpired()
			if (isFull() && gate.activeIDs().length > 0) await reconcile()

			if (!isFull()) {
				const res = gate.reserve(event.id, event.sessionID)
				if (res.ok) {
					counters.launchedLocal++
					debug = { lastDecision: "local", active: gate.counts().active, reservations: gate.counts().reservations, at: Date.now() }
					logDebug("[gate] decision", "local", "active", gate.counts().active, "reservations", gate.counts().reservations, "cap", gate.getCap())
					emit()
					return
				}
				// reserve returned {ok:false} — gate is full (shouldn't happen after isFull check, but be safe)
			}

			const agent = typeof input.agent === "string" ? input.agent : undefined
			const c = gate.counts()
			const status = "Local-model subagent cap reached (" + (c.active + c.reservations) + "/" + c.cap + " active)."

			let suggestion: string | undefined
			let suggestionError: unknown

			// Use settings.rerouteModel if set and available in the model list.
			if (settings.rerouteModel) {
				try {
					const models = await withTimeout(ctx.model.list(), 5_000, "model.list")
					const found = models.data?.find((m) => m.providerID + "/" + m.id === settings.rerouteModel)
					if (found && found.enabled === true && found.status === "active" && found.capabilities?.tools === true && !isLocalProvider(found.providerID, settings.extraCloudProviders)) {
						suggestion = settings.rerouteModel
					} else {
						console.warn("[gate] rerouteModel", settings.rerouteModel, "not suitable for reroute (missing or local provider) — falling back to auto-pick")
					}
				} catch (err) {
					console.warn("[gate] model.list failed for rerouteModel check:", describeError(err))
					// Leave suggestion unset so it falls through to suggestCloudModel.
				}
			}

			if (!suggestion) {
				try {
					suggestion = await withTimeout(getParentProvider(event.sessionID).then(suggestCloudModel), 5_000, "suggestCloudModel")
				} catch (err) {
					suggestionError = err
				}
			}

			if (suggestion) {
				event.input = { ...input, model: suggestion }
				reroutedCalls.set(event.id, { model: suggestion, at: Date.now() })
				pendingReroutes.push({ callID: event.id, parentID: event.sessionID, model: suggestion, agent, description: typeof input.description === "string" ? input.description : undefined, at: Date.now() })
				counters.rerouted++
				record({ time: Date.now(), kind: "reroute", ...(agent !== undefined && { agent }), parentID: event.sessionID, ...(suggestion !== undefined && { model: suggestion }), callID: event.id })
				debug = { lastDecision: "reroute", active: c.active, reservations: c.reservations, at: Date.now() }
				logDebug("[gate] decision", "reroute", "active", c.active, "reservations", c.reservations, "cap", c.cap)
				logDebug("[gate] reroute:", agent ?? "(unnamed)", "→", suggestion, "-", status)
				emit()
				return
			}

			counters.denied++
			record({ time: Date.now(), kind: "deny", ...(agent !== undefined && { agent }), parentID: event.sessionID, ...(providerID !== undefined && { model: providerID }), callID: event.id })
			debug = { lastDecision: "deny", active: c.active, reservations: c.reservations, at: Date.now() }
			console.warn("[gate] decision", "deny", "active", c.active, "reservations", c.reservations, "cap", c.cap)
			console.warn("[gate] deny:", agent ?? "(unnamed)", "-", status)
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

		// Shared helper: link a claimed reroute entry to a session.
		// Called by linkReroute (session.created) and the title hook.
		const linkClaimedReroute = (sessionID: string, parentID: string, entry: RerouteEntry): void => {
			// Mark recent entry's childID.
			const match = recent.find((r) => r.callID === entry.callID)
			if (match) match.childID = sessionID
			// Track child info for rerouted child.
			childInfo.set(sessionID, { childID: sessionID, parentID, ...(entry.agent && { agent: entry.agent }), ...(entry.model && { model: entry.model }), local: false })
			// Track desired title when description exists.
			if (entry.description) {
				const desiredTitle = entry.description + " [routed to " + entry.model + "]"
				reroutedTitles.set(sessionID, desiredTitle)
				// Belt-and-braces: if title already set, update once.
				ctx.session
					.update({ sessionID, title: desiredTitle })
					.catch((err) => console.warn("[gate] belt title update failed:", err))
			}
			emit()
		}

		// Returns true when the child is the target of a rerouted call.
		// Checks claimedReroutes first to prevent double-handling.
		const linkReroute = (data: CreatedData, parentID: string, allowParentOnlyMatch: boolean): boolean => {
			// Check claimedReroutes first — prevent double-handling.
			if (claimedReroutes.has(data.sessionID)) return true

			const childModel = data.model ? data.model.providerID + "/" + data.model.id : undefined
			const entry = claimRerouteForChild(pendingReroutes, parentID, childModel, false)
			if (entry) {
				claimedReroutes.set(data.sessionID, entry)
				linkClaimedReroute(data.sessionID, parentID, entry)
				return true
			} else if (allowParentOnlyMatch) {
				const fallback = claimRerouteForChild(pendingReroutes, parentID, undefined, true)
				if (!fallback) return false
				claimedReroutes.set(data.sessionID, fallback)
				linkClaimedReroute(data.sessionID, parentID, fallback)
				return true
			} else {
				return false
			}
		}

		const onChildCreated = async (data: CreatedData, parentID: string) => {
			pruneExpired()

			// Resolve provider first so linkReroute can decide correctly.
			let providerID: string | undefined
			if (data.model?.providerID) {
				providerID = data.model.providerID
			} else {
				try {
					providerID = await withTimeout(resolveProvider(data.agent, undefined, parentID), 5_000, "onChildCreated-resolveProvider")
				} catch (err) {
					console.warn("[gate] onChildCreated: resolveProvider timeout/error for", data.sessionID, describeError(err))
					providerID = undefined
				}
			}
			if (!providerID) {
				console.warn("[gate] onChildCreated: unknown provider for", data.sessionID)
				return
			}

			// Only allow parentID-only reroute match when child has no model AND provider is cloud.
			const allowParentOnlyMatch = !data.model && !isLocalProvider(providerID, settings.extraCloudProviders)
			if (linkReroute(data, parentID, allowParentOnlyMatch)) return

			if (!isLocalProvider(providerID, settings.extraCloudProviders)) return

			gate.activate(data.sessionID, parentID)
			localChildren.add(data.sessionID)
			createdAt.set(data.sessionID, Date.now())
			startedAt.set(data.sessionID, Date.now())
			// Track child info for local child.
			const modelStr = data.model ? data.model.providerID + "/" + data.model.id : providerID
			const entry: ChildEntry = { childID: data.sessionID, parentID, ...(data.agent && { agent: data.agent }), ...(modelStr && { model: modelStr }), local: true }
			childInfo.set(data.sessionID, entry)
			localChildEntries.set(data.sessionID, entry)
			logDebug("[gate] local child created:", data.sessionID, "active", gate.counts().active)
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
					if (localChildren.has(event.data.sessionID)) {
						const parentID = localChildEntries.get(event.data.sessionID)?.parentID ?? ""
						// Only call gate.activate when NOT already active — first-run children
						// are already activated in onChildCreated (which consumed its reservation).
						if (!gate.activeIDs().includes(event.data.sessionID)) {
							gate.activate(event.data.sessionID, parentID)
						}
						startedAt.set(event.data.sessionID, Date.now())
						// Restore childInfo for re-prompted local children.
						const stored = localChildEntries.get(event.data.sessionID)
						if (stored && !childInfo.has(event.data.sessionID)) {
							childInfo.set(event.data.sessionID, stored)
						}
						emit()
					}
					return
				}
				case "session.execution.succeeded":
				case "session.execution.failed":
				case "session.execution.interrupted": {
					const id = event.data.sessionID
					if (gate.deactivate(id)) {
						createdAt.delete(id)
						startedAt.delete(id)
						childInfo.delete(id)
						reroutedTitles.delete(id)
						claimedReroutes.delete(id)
						emit()
					}
					// Rerouted children are not in active but may be in childInfo.
					if (childInfo.has(id)) {
						childInfo.delete(id)
						reroutedTitles.delete(id)
						claimedReroutes.delete(id)
						emit()
					}
					return
				}
				case "session.deleted": {
					const id = event.data.sessionID
					const wasActive = gate.deactivate(id)
					localChildren.delete(id)
					localChildEntries.delete(id)
					createdAt.delete(id)
					startedAt.delete(id)
					const hadInfo = childInfo.delete(id)
					reroutedTitles.delete(id)
					claimedReroutes.delete(id)
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
							console.warn("[gate] event handler failed:", event.type, err)
						}
					}
				} catch (err) {
					if (controller.signal.aborted) return
					console.warn("[gate] event stream error:", err)
				}
				if (controller.signal.aborted) return
				console.warn("[gate] event stream ended, reconnecting")
				await sleep(delay).catch(() => {}) // sleep may be aborted
				if (controller.signal.aborted) return
				await reconcile().catch((err) => console.warn("[gate] reconcile failed:", err))
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
				console.warn("[gate] resolveProvider failed:", describeError(err))
				// Fall back to parent session's provider.
				try {
					providerID = (await ctx.session.get({ sessionID: event.sessionID })).model?.providerID
				} catch {
					// Can't resolve provider at all — skip the gate, allow the call.
					return
				}
			}
			if (!isLocalProvider(providerID, settings.extraCloudProviders)) return

			const run = chain.then(() => decide(event, providerID))
			chain = run.then(
				() => {},
				() => {},
			)
			try {
				await run
			} catch (err) {
				// decide may throw after making a reservation; release it.
				if (gate.release(event.id)) emit()
				throw err
			}
		})

		await ctx.tool.hook("execute.after", async (event) => {
			if (event.status !== "completed") {
				// Call failed — release its reservation so the slot frees up.
				if (gate.release(event.id)) emit()
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
				appendRerouteNote(event.result, "[gate: rerouted to " + model.model + "]")
			} catch {
				// best-effort note; never fail the call over this
			}
		})

		await ctx.session.hook("context", (event) => {
			if (localChildren.has(event.sessionID)) return
			if (event.model && isLocalProvider(event.model.providerID, settings.extraCloudProviders)) return
			event.system.push({
				type: "text",
				text:
					"When delegating independent work to subagents, prefer launching multiple in parallel (background: true) rather than one at a time — there is no concurrency limit for cloud-model subagents. Local-model subagents are capped at " +
					settings.cap +
					" concurrent; overflow is routed to a cloud model automatically when one is available.",
			})
		})

		await ctx.session.hook("title", async (event) => {
			if (localChildren.has(event.sessionID)) return
			const t = reroutedTitles.get(event.sessionID)
			if (t) {
				event.result = t
				return
			}
			if (event.model) {
				let parentID: string | undefined
				try {
					const parent = await withTimeout(ctx.session.get({ sessionID: event.sessionID }), 5_000, "session.get-title")
					parentID = parent.parentID
				} catch {
					return
				}
				if (parentID) {
					const childModel = event.model.providerID + "/" + event.model.id
					const entry = claimRerouteForChild(pendingReroutes, parentID, childModel, false)
					if (entry) {
						claimedReroutes.set(event.sessionID, entry)
						linkClaimedReroute(event.sessionID, parentID, entry)
						if (entry.description) {
							event.result = entry.description + " [routed to " + entry.model + "]"
						}
						return
					}
				}
			}
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
