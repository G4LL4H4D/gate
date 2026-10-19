# opencode-gate

Concurrency gate for OpenCode: caps concurrent local-model subagents and reroutes overflow to a cloud model.

## Why

A single local model server handles only a few concurrent requests. When many parallel subagents launch, they queue or time out. GATE caps concurrent local-model subagents globally and reroutes overflow to a cloud model so work keeps moving.

## What you get

**Global cap** — both foreground and background subagents across all sessions count toward the limit (default 2).

**Live sidebar panel** (in the sidebar):

```
Subagents 0/2 · ↪ 2
○ Read README subagent 1
○ Read README subagent 2
○ Read README subagent 3
  → nemotron-3.5-super-vl-free
○ Read README subagent 4
  → nemotron-3.5-super-vl-free
```

● = running, ○ = finished. A secondary compact panel listing only running children appears above the prompt composer.

**Home footer** — shows `active/cap · ↪ rerouted` (and `· ✗ denied` when any have been denied).

**[routed to X] title tag** on rerouted subagent sessions.

**`/gate`** — debug summary plus a list of recent reroutes and denials; selecting one opens that session.

**`/gate-settings`** — settings dialog (cap, reroute model picker with an Auto option, extra cloud providers, debug logging). Values persist across restarts. Invalid cap input gives an error toast.

<!-- screenshot: sidebar panel -->

## How it decides

**Local vs. cloud** — a provider is treated as local unless it is on the cloud allowlist below or listed in `extraCloudProviders`.

**Cloud allowlist** (any provider not in this set is local):

`opencode`, `anthropic`, `openai`, `google`, `google-vertex`, `github-copilot`, `amazon-bedrock`, `azure`, `openrouter`, `mistral`, `gitlab`, `groq`, `xai`, `deepseek`, `together`, `fireworks`, `cerebras`

**Reroute target** — resolved in order: `rerouteModel` setting (if set and available in the model list) → auto-pick cheapest tool-capable cloud model (preferring the parent session's provider). If no cloud model is found, the launch is denied with the message: `Local-model subagent cap reached (X/Y active). No cloud model available; wait for a local subagent to finish, then retry.`

**Cap** — counts both foreground and background subagents of **all** sessions. Lowering the cap never kills running subagents.

**Reservation** — when a launch is approved, a reservation is held for up to 60 seconds, keyed by the launch call; when the child session appears it is paired with its parent's oldest reservation.

## Install

**npm** (not yet verified — package not published):

```json
{ "plugins": ["opencode-gate"] }
```

or with options:

```json
{ "plugins": [{ "package": "opencode-gate", "options": { "cap": 2 } }] }
```

For the TUI, add `"opencode-gate"` to the plugins list of `cli.json` (on older OpenCode versions the key is `plugin` in `tui.json`).

**Local dev** (verified): build this repo, then copy `dist/index.js`, `dist/tui.js` and `package.json` into a folder and point the plugin spec at that folder. A plain directory plugin spec does NOT resolve `package.json` `exports` — the host loads `<dir>/index.js` (server) and `<dir>/tui.js` (TUI).

See https://opencode.ai/v2/docs/plugins for the plugin reference.

## Configuration

Pass options to the package in `opencode.json`. Precedence: stored settings > config options > defaults.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `cap` | integer (1–32) | `2` | Max concurrent local-model subagents across all sessions |
| `rerouteModel` | `"provider/model"` or absent | auto | Cloud model to reroute overflow to; omit (or clear in the dialog) to use auto-pick |
| `extraCloudProviders` | `string[]` | `[]` | Additional providers treated as cloud (lowercased, deduped) |
| `debug` | `boolean` | `false` | Verbose `[gate]` logging via console.info (where this ends up depends on the host; the /gate debug summary always works) |

Example:

```json
{
  "plugins": [{
    "package": "opencode-gate",
    "options": {
      "cap": 4,
      "rerouteModel": "openai/gpt-4o",
      "extraCloudProviders": ["my-provider"],
      "debug": true
    }
  }]
}
```

Clearing the reroute model in the `/gate-settings` dialog removes the saved override; a `rerouteModel` set in config applies again after a restart.

## Troubleshooting

**Plugin not listed in the Plugins dialog** — check the OpenCode logs for `[gate]` or `[gate-tui]` errors during startup.

**Sidebar panel empty** — the panel only appears when the current session has spawned subagents (children). It is scoped to the active session's family.

**Nothing reroutes** — verify the provider is actually cloud. A provider is local if it is not on the allowlist above and not in `extraCloudProviders`. If all providers are local, the cap is the only gate and overflow is denied.

**Settings error toast** — `cap` must be an integer 1–32; `rerouteModel` must be `providerID/modelID` format; `extraCloudProviders` entries must be non-empty strings.

## Known limits

- The `[routed to X]` title tag can be lost if the session title is generated before the reroute link fires (not observed in testing).
- The `↳ X finished` line is drawn by OpenCode core and does not carry the `[routed to X]` tag. (unverified)
- When a child session is created, GATE links it to the oldest outstanding reservation of its parent session (the host does not expose the originating call id). With several concurrent launches from one parent the pairing is by age, not by call.
- npm-installed TUI plugins may hit upstream issue [anomalyco/opencode#33884](https://github.com/anomalyco/opencode/issues/33884) (unverified).

## Development

```sh
bun install
bun run typecheck
bun test
bun run build
```

**Repo layout:**

| File | Purpose |
|---|---|
| `src/index.ts` | Server plugin (cap logic, event hooks, RPC, reroute) |
| `src/tui.tsx` | TUI plugin (sidebar panel, footer, commands, settings dialog) |
| `src/gate.ts` | Pure cap/reservation framework (no Effect coupling) |
| `src/settings.ts` | Settings type, parser (cap 1–32), merge (stored > options > defaults) |
| `src/rpc.ts` | Shared RPC contract (Gate schema, Stats, Settings) |
| `src/title.ts` | Title parsing helpers (`splitRoutedTitle`, `shortModel`) |

CI runs `typecheck`, `test`, and `build` on push and PR to `main`.

## License

MIT
