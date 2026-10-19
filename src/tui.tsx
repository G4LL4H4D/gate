/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { Gate, type Stats, type ChildEntry } from "./rpc"
import type { RpcClient } from "@opencode/client/promise"
import type { Settings } from "./settings"
import { withRerouteModel } from "./settings"
import { Show, For, createMemo } from "solid-js"
import { splitRoutedTitle, shortModel } from "./title"

export default Plugin.define({
  id: "gate-tui",
  async setup(ctx) {
    let gate: RpcClient<typeof Gate> | null
    try {
      gate = ctx.client.rpc(Gate)
    } catch {
      gate = null
    }

    const describeError = (err: unknown): string => {
      if (err instanceof Error) return err.message
      if (err && typeof err === "object") {
        if ("message" in err && typeof (err as any).message === "string") return (err as any).message
        if ("data" in err && typeof (err as any).data === "object" && (err as any).data && "message" in (err as any).data && typeof (err as any).data.message === "string") return (err as any).data.message
      }
      return String(err)
    }

    const [stats, setStats] = ctx.storage.memory(
      "gate",
      { initial: { loaded: false as boolean, data: null as Stats | null } }
    )
    const seen = new Set<string>()
    let seeded = false
    let disposed = false

    function color(pick: any): string | undefined {
      try { return pick(ctx.theme) } catch { return undefined }
    }

    function apply(s: Stats) {
      if (typeof s !== "object" || s === null || !Array.isArray(s.recent)) return
      const isNew = !seeded
      seeded = true
      setStats(d => { d.loaded = true; d.data = s })
      const keys: string[] = []
      for (const e of s.recent) {
        const key = `${e.time}|${e.kind}|${e.parentID}|${e.agent ?? ""}|${e.model ?? ""}`
        keys.push(key)
        if (!seen.has(key)) {
          seen.add(key)
          if (!isNew) {
            try {
              ctx.ui.toast.show({
                title: "Subagent gate",
                message: e.kind === "reroute"
                  ? `Rerouted ${e.agent ?? "(unnamed)"} → ${e.model}`
                  : `Denied ${e.agent ?? "(unnamed)"}`,
                variant: e.kind === "reroute" ? "warning" : "error",
                sessionID: e.parentID,
              })
            } catch {}
          }
        }
      }
      if (keys.length > 0) {
        const toRemove = seen.size - keys.length
        if (toRemove > 0) {
          let i = 0
          for (const k of seen) {
            if (i >= toRemove) break
            seen.delete(k)
            i++
          }
        }
      }
    }

    async function refresh() {
      if (disposed || !gate) return
      try {
        const s = (await gate.stats({})) as Stats
        apply(s)
        if (!subscribed) {
          try {
            off = gate.events.on("changed", (ev: any) => {
              try {
                const data = (ev && typeof ev === "object" && "data" in ev ? ev.data : ev) as Stats
                apply(data)
              } catch {}
            })
            subscribed = true
          } catch {}
        }
      } catch {}
    }

    let id: ReturnType<typeof setInterval>
    let off: () => void = () => {}
    let subscribed = false

    void refresh()
    id = setInterval(refresh, 10_000)

    const disposers: Array<() => void> = []

    try {
      disposers.push(ctx.ui.slot({ append: "prompt.footer.status", render }))
    } catch {}
    try {
      disposers.push(ctx.ui.slot({ append: "home.footer.status", render }))
    } catch {}
    try {
      disposers.push(ctx.ui.slot({ append: "sidebar.content", render: (props: { sessionID: string }) => <SubagentPanel sessionID={props.sessionID} /> }))
    } catch {}
    try {
      disposers.push(ctx.ui.slot({ append: "session.composer.top", render: (props: { sessionID: string }) => <SubagentPanel sessionID={props.sessionID} compact /> }))
    } catch {}

    function render() {
      try {
        return (
          <Show when={stats.loaded && stats.data}>
            {(s) => {
              const fg = () => {
                const atCap = s().active >= s().cap
                let c: string | undefined
                if (atCap) {
                  c = color((t: any) => t.text.feedback.warning.base)
                  if (!c) c = color((t: any) => t.text.base)
                } else {
                  c = color((t: any) => t.text.muted)
                }
                return c
              }
              return (
                <text fg={fg()}>
                  {s().active}/{s().cap} · ↪ {s().rerouted}
                  {s().denied > 0 ? ` · ✗ ${s().denied}` : ""}
                </text>
              )
            }}
          </Show>
        )
      } catch {
        return null
      }
    }

    function truncate(s: string, n: number): string {
      return s.length > n ? s.slice(0, n) : s
    }

    function SubagentPanel(props: { sessionID: string; compact?: boolean }) {
      const family = createMemo(() => ctx.data.session.family(props.sessionID).filter(id => id !== props.sessionID))

      function getEntry(id: string) {
        return stats.data?.children?.find((c: ChildEntry) => c.childID === id)
      }

      function getLabel(id: string): string {
        const session = ctx.data.session.get(id)
        const title = session?.title
        if (title) {
          const label = splitRoutedTitle(title).label
          if (label) return label
        }
        const entry = getEntry(id)
        const agent = entry?.agent
        if (agent) return agent
        return id
      }

      function getRoute(id: string): string | undefined {
        const entry = getEntry(id)
        if (entry?.local === false && entry?.model) return `→ ${shortModel(entry.model)}`
        if (entry?.local === true) return "local"
        // entry dropped at execution end — parse session title for reroute tag
        const session = ctx.data.session.get(id)
        const title = session?.title
        if (title) {
          const parsed = splitRoutedTitle(title)
          if (parsed.model) return `→ ${shortModel(parsed.model)}`
        }
        return undefined
      }

      const statsAccessor = () => stats.data

      function Row(idProps: { id: string; stacked?: boolean }) {
        const running = () => ctx.data.session.status(idProps.id) === "running"
        const route = () => getRoute(idProps.id)
        const label = () => {
          const raw = getLabel(idProps.id)
          const r = route()
          if (!r) return raw
          const maxLabel = Math.max(10, 28 - r.length - 1)
          return raw.length > maxLabel ? raw.slice(0, maxLabel) + "…" : raw
        }
        const labelTruncated = () => {
          const raw = getLabel(idProps.id)
          return raw.length > 28 ? raw.slice(0, 28) + "…" : raw
        }

        if (idProps.stacked) {
          return (
            <box flexDirection="column" onMouseUp={() => ctx.ui.router.navigate({ type: "session", sessionID: idProps.id })}>
              <box flexDirection="row" gap={1}>
                <text fg={color((t: any) => (running() ? t.text.feedback.success.base : t.text.muted))}>
                  {running() ? "●" : "○"}
                </text>
                <text fg={color((t: any) => t.text.base)}>
                  {labelTruncated()}
                </text>
              </box>
              <Show when={route()} keyed>{(r: string) => (
                <text fg={color((t: any) => t.text.feedback.warning.base)} marginLeft={2}>
                  {r.length > 30 ? r.slice(0, 30) + "…" : r}
                </text>
              )}</Show>
            </box>
          )
        }

        return (
          <box flexDirection="row" gap={1} onMouseUp={() => ctx.ui.router.navigate({ type: "session", sessionID: idProps.id })}>
            <text fg={color((t: any) => (running() ? t.text.feedback.success.base : t.text.muted))}>
              {running() ? "●" : "○"}
            </text>
            <text fg={color((t: any) => t.text.base)}>
              {label()}
            </text>
            <Show when={route()}>
              <text fg={color((t: any) => t.text.feedback.warning.base)}>
                {route()}
              </text>
            </Show>
          </box>
        )
      }

      if (props.compact) {
        const runningRows = createMemo(() => {
          const fam = family()
          return fam.filter(id => ctx.data.session.status(id) === "running")
        })
        return (
          <For each={runningRows()}>
            {(id) => <Row id={id} />}
          </For>
        )
      }

      const active = () => statsAccessor()?.active ?? 0
      const cap = () => statsAccessor()?.cap ?? 0
      const rerouted = () => statsAccessor()?.rerouted ?? 0
      const headerFg = () => {
        const atCap = active() >= cap()
        return color((t: any) => atCap ? t.text.feedback.warning.base : t.text.muted)
      }

      return (
        <Show when={family().length > 0}>
          <box flexDirection="column" border={true} borderColor={color((t: any) => t.border.base)} backgroundColor={color((t: any) => t.background.raised.base)}>
            <text fg={headerFg()}>
              Subagents {active()}/{cap()} · ↪ {rerouted()}
            </text>
            <For each={family()}>
              {(id) => <Row id={id} stacked />}
            </For>
          </box>
        </Show>
      )
    }

    try {
      ctx.keymap.layer(() => ({
        mode: "global",
        commands: [
          {
            id: "gate.stats",
            title: "Subagent gate stats",
            group: "Subagent gate",
            palette: true,
            slash: { name: "gate" },
            run,
          },
          {
            id: "gate.settings",
            title: "GATE: Settings",
            group: "Subagent gate",
            palette: true,
            slash: { name: "gate-settings" },
            run: settingsFlow,
          },
        ],
      }))
    } catch {}

    async function run() {
      try {
        if (!stats.loaded) await refresh()
        if (!stats.data) {
          await ctx.ui.dialog.alert({
            title: "Subagent gate",
            message: "Subagent gate unavailable (server plugin not responding)",
          })
          return
        }
        const s = stats.data
        const recent = (s.recent ?? []).slice().reverse().slice(0, 20)

        if (recent.length === 0) {
          await ctx.ui.dialog.alert({
            title: "Subagent gate",
            message: `Active: ${s.active}/${s.cap} · Launched local: ${s.launchedLocal} · Rerouted: ${s.rerouted} · Denied: ${s.denied}`,
          })
          return
        }

        const options: Array<{ title: string; value: string | null; description?: string; category?: string; disabled?: boolean }> = []

        if (s.debug) {
          options.push({
            title: `Active ${s.active}/${s.cap} · launched ${s.launchedLocal} · rerouted ${s.rerouted} · denied ${s.denied} · last: ${s.debug.lastDecision} (active ${s.debug.active}, resv ${s.debug.reservations})`,
            value: null,
            disabled: true,
          })
        }

        options.push({
          title: "Settings…",
          value: "__settings__",
          category: "GATE",
        })

        for (const e of recent) {
          options.push({
            title: `${e.kind} ${e.agent ?? "?"}`,
            value: e.childID ?? e.parentID,
            description: e.model ?? "",
            category: e.kind,
          })
        }

        const result = await ctx.ui.dialog.select({
          title: "Subagent gate",
          options,
        })

        if (result === "__settings__") {
          try { await settingsFlow() } catch (err) {
            await ctx.ui.toast.show({
              title: "GATE: Settings",
              message: describeError(err),
              variant: "error",
            })
          }
        } else if (result) {
          ctx.ui.router.navigate({ type: "session", sessionID: result })
        }
      } catch {}
    }

    async function settingsFlow() {
      if (!gate) {
        await ctx.ui.toast.show({
          title: "GATE: Settings",
          message: "gate unavailable",
          variant: "error",
        })
        return
      }
      const g = gate
      let current: Settings
      for (;;) {
        try {
          current = await g.settingsGet({}) as Settings
        } catch (err) {
          await ctx.ui.toast.show({
            title: "GATE: Settings",
            message: describeError(err),
            variant: "error",
          })
          return
        }
        const result = await ctx.ui.dialog.select({
          title: "GATE: Settings",
          options: [
            {
              title: "Concurrent local cap",
              value: "cap",
              description: String(current.cap),
              category: "GATE",
            },
            {
              title: "Reroute model",
              value: "rerouteModel",
              description: current.rerouteModel ?? "(auto)",
              category: "GATE",
            },
            {
              title: "Extra cloud providers",
              value: "extraCloudProviders",
              description: current.extraCloudProviders.join(", "),
              category: "GATE",
            },
            {
              title: "Debug logging",
              value: "debug",
              description: current.debug ? "on" : "off",
              category: "GATE",
            },
          ],
        })
        if (!result) return // dismissed (Esc)

        if (result === "cap") {
          const input = await ctx.ui.dialog.prompt({
            title: "Concurrent local cap",
            description: "Integer 1..32",
            value: String(current.cap),
          })
          if (input === undefined) continue
          const n = Number(input)
          if (!Number.isInteger(n) || n < 1 || n > 32) {
            await ctx.ui.toast.show({
              title: "GATE: Settings",
              message: "cap must be an integer 1..32",
              variant: "error",
            })
            continue
          }
          try {
            current = await g.settingsSet({ ...current, cap: n }) as Settings
            await ctx.ui.toast.show({
              title: "GATE: Settings",
              message: "cap updated",
              variant: "success",
            })
          } catch (err) {
            await ctx.ui.toast.show({
              title: "GATE: Settings",
              message: describeError(err),
              variant: "error",
            })
          }
        } else if (result === "rerouteModel") {
          const models = (() => {
            try {
              return ctx.data.location.model.list()
            } catch {
              return undefined
            }
          })()
          if (models && models.length > 0) {
            const opts: Array<{ title: string; value: string | null; description?: string }> = [
              { title: "Auto (default)", value: null, description: "use the default model" },
            ]
            for (const m of models) {
              // Filter: only show models that look usable as cloud reroute targets
              // (enabled, active status, tool-call capability).
              // Cannot know the server's cloud allowlist here; server rejects local models
              // with validation_error and the TUI shows that message.
              if (
                m.enabled &&
                m.status === "active" &&
                m.capabilities?.tools
              ) {
                opts.push({ title: m.name, value: `${m.providerID}/${m.id}`, description: m.providerID })
              }
            }
            const pick = await ctx.ui.dialog.select({
              title: "Reroute model",
              options: opts,
              current: current.rerouteModel ?? null,
            })
            if (pick === undefined) continue
            try {
              current = await g.settingsSet(withRerouteModel(current, pick ?? undefined)) as Settings
              await ctx.ui.toast.show({
                title: "GATE: Settings",
                message: pick ? "reroute model set" : "reroute model cleared",
                variant: "success",
              })
            } catch (err) {
              await ctx.ui.toast.show({
                title: "GATE: Settings",
                message: describeError(err),
                variant: "error",
              })
            }
          } else {
            const input = await ctx.ui.dialog.prompt({
              title: "Reroute model",
              description: "providerID/id, or empty for auto",
              value: current.rerouteModel ?? "",
            })
            if (input === undefined) continue
            try {
              current = await g.settingsSet(withRerouteModel(current, input.trim() || undefined)) as Settings
              await ctx.ui.toast.show({
                title: "GATE: Settings",
                message: input.trim() ? "reroute model set" : "reroute model cleared",
                variant: "success",
              })
            } catch (err) {
              await ctx.ui.toast.show({
                title: "GATE: Settings",
                message: describeError(err),
                variant: "error",
              })
            }
          }
        } else if (result === "extraCloudProviders") {
          const input = await ctx.ui.dialog.prompt({
            title: "Extra cloud providers",
            description: "comma-separated provider IDs",
            value: current.extraCloudProviders.join(", "),
          })
          if (input === undefined) continue
          try {
            current = await g.settingsSet({
              ...current,
              extraCloudProviders: input.split(",").map((s) => s.trim()).filter(Boolean),
            }) as Settings
            await ctx.ui.toast.show({
              title: "GATE: Settings",
              message: "extra cloud providers updated",
              variant: "success",
            })
          } catch (err) {
            await ctx.ui.toast.show({
              title: "GATE: Settings",
              message: describeError(err),
              variant: "error",
            })
          }
        } else if (result === "debug") {
          try {
            current = await g.settingsSet({ ...current, debug: !current.debug }) as Settings
            await ctx.ui.toast.show({
              title: "GATE: Settings",
              message: "debug logging " + (current.debug ? "on" : "off"),
              variant: "success",
            })
          } catch (err) {
            await ctx.ui.toast.show({
              title: "GATE: Settings",
              message: describeError(err),
              variant: "error",
            })
          }
        }
      }
    }

    function cleanup() {
      disposed = true
      try { clearInterval(id) } catch {}
      try { off() } catch {}
      for (const d of disposers) {
        try { d() } catch {}
      }
    }

    return cleanup
  },
})
