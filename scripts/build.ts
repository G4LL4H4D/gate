#!/usr/bin/env bun
import { build } from "bun"
import solidPlugin from "@opentui/solid/bun-plugin"

// Build src/index.ts → dist/index.js
const indexResult = await build({
  entrypoints: ["src/index.ts"],
  outdir: "dist",
  target: "bun",
  external: [
    "@opencode/plugin",
    "@opentui/solid",
    "solid-js",
  ],
  format: "esm",
  minify: false,
  development: false,
})

if (!indexResult || !indexResult.success) {
  console.error("index build failed")
  process.exit(1)
}
for (const l of indexResult.logs) console.error(l)
console.log("Built dist/index.js")

// Build src/tui.tsx → dist/tui.js (Solid JSX via bun-plugin, not bun's jsx transform)
const tuiResult = await build({
  entrypoints: ["src/tui.tsx"],
  outdir: "dist",
  target: "bun",
  external: [
    "@opencode/plugin",
    "@opentui/solid",
    "solid-js",
  ],
  // solidPlugin handles JSX → Solid reactive primitives (createComponent, effect, insert)
  plugins: [solidPlugin],
  format: "esm",
  minify: false,
  development: false,
})

if (!tuiResult || !tuiResult.success) {
  console.error("tui build failed")
  process.exit(1)
}
for (const l of tuiResult.logs) console.error(l)
console.log("Built dist/tui.js")

console.log("Build complete")
