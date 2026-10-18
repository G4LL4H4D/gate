/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { Gate, type Stats, type ChildEntry } from "./rpc"
import { Show, For, createMemo } from "solid-js"

export default Plugin.define({
  id: "subagent-gate-tui",
  async setup(ctx) {
    let gate: any
    try {
      gate = ctx.client.rpc(Gate)
    } catch {
      gate = null
    }

    const [stats, setStats] = ctx.storage.memory(
      "subagent-gate",
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
      if (disposed) return
      try {
        const s = await gate.stats({})
        apply(s)
        if (!subscribed) {
          try {
            off = gate.events.on("changed", (ev: any) => {
              try {
                const data = ev && typeof ev === "object" && "data" in ev ? ev.data : (ev as Stats)
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
        const entry = getEntry(id)
        const session = ctx.data.session.get(id)
        return entry?.agent ?? session?.title ?? id
      }

      function getRoute(id: string): string | undefined {
        const entry = getEntry(id)
        if (entry?.local === false && entry?.model) return `→ ${entry.model}`
        if (entry?.local === true) return "local"
        return undefined
      }

      const statsAccessor = () => stats.data

      function Row(idProps: { id: string }) {
        const running = () => ctx.data.session.status(idProps.id) === "running"
        const route = () => getRoute(idProps.id)
        const label = () => truncate(getLabel(idProps.id), 28)
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
              {(id) => <Row id={id} />}
            </For>
          </box>
        </Show>
      )
    }

    try {
      ctx.keymap.layer(() => ({
        mode: "global",
        commands: [{
          id: "subagent-gate.stats",
          title: "Subagent gate stats",
          group: "Subagent gate",
          palette: true,
          slash: { name: "gate" },
          run,
        }],
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

        if (result) {
          ctx.ui.router.navigate({ type: "session", sessionID: result })
        }
      } catch {}
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
