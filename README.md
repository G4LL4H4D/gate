# opencode-gate

Concurrency gate for OpenCode: caps concurrent local-model subagents and reroutes overflow to a cloud model.

## What it does

- Caps concurrent local-model subagents globally at N (default 2).
- Reroutes overflow subagents to a cloud model instead of queueing or rejecting them.
- TUI shows a Subagents panel (sidebar and above the composer) with live usage.
- Footer counter shows current usage against the cap.
- `[routed to X]` title tag marks rerouted subagents.
- `/gate` command shows stats.
- `/gate-settings` command opens the settings dialog.

## How it decides

- A provider is treated as local unless it is on the known-cloud allowlist.
- The default reroute target is an auto-picked cheapest tool-capable cloud model (by output cost).
- The cap counts both foreground and background subagents.
- Reservations expire after 60s.

## Install

**npm (not yet verified: untested until the first published release):**

```json
{ "plugins": ["opencode-gate"] }
```

or with options:

```json
{ "plugins": [{ "package": "opencode-gate", "options": { "cap": 2 } }] }
```

**TUI:** add `"opencode-gate"` to the plugins list of `cli.json` (on older OpenCode versions the key is `plugin` in `tui.json`).

**Local dev:** build this repo, then copy `dist/index.js`, `dist/tui.js` and `package.json` to a folder and point the plugin spec at that folder (verified to work).

See https://opencode.ai/v2/docs/plugins for the plugin reference.

## Configuration

In `opencode.json`, pass options to the package:

```json
{
  "package": "opencode-gate",
  "options": {
    "cap": 2,
    "rerouteModel": "provider/model",
    "extraCloudProviders": [],
    "debug": false
  }
}
```

- `cap` — max concurrent local-model subagents (default 2).
- `rerouteModel` — cloud model to reroute overflow to (default: auto-picked cheapest tool-capable cloud model by output cost).
- `extraCloudProviders` — additional providers treated as cloud (default `[]`).
- `debug` — verbose logging (default `false`).

In-TUI settings dialog is persisted on the server. Precedence: stored settings > config options > defaults.

## Verified

Tested live in an isolated OpenCode instance:

- cap 2 with background + foreground subagents
- reroute to a free cloud model
- sidebar panel with live updates and routed marks
- `/gate`
- `/gate-settings` with persistence

Not yet verified: install from the npm registry; behaviour with the real (non-isolated) config.

## Known limits

- The `[routed to X]` tag can still be lost if the title is generated before the reroute links; not observed in testing.
- The `↳ finished` line is core-drawn and does not show the tag. (unverified)
- Reservations are matched by parent session, not call. (unverified)
- npm-installed TUI plugins may hit upstream issue [anomalyco/opencode#33884](https://github.com/anomalyco/opencode/issues/33884). (unverified)

## Development

```sh
bun install
bun run typecheck
bun test
bun run build
```

Local install: point the config plugin path at the build output folder (see Install).

## License

MIT
