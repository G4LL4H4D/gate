#!/usr/bin/env bun
import { build } from "bun"

// Build src/index.ts → dist/index.js
const indexResult = await build({
  entrypoints: ["src/index.ts"],
  outdir: "dist",
  target: "bun",
  external: ["@opencode/plugin"],
  format: "esm",
  minify: false,
})

// bun build returns an array of BuildOutputEntry (not {errors})
if (!indexResult || (Array.isArray(indexResult) && indexResult.length === 0)) {
  console.error("index build produced no output")
  process.exit(1)
}
console.log("Built dist/index.js")

// Build src/tui.tsx → dist/tui.js (Solid JSX transform via bun)
const tuiResult = await build({
  entrypoints: ["src/tui.tsx"],
  outdir: "dist",
  target: "bun",
  external: [
    "@opencode/plugin/tui",
    "@opentui/core",
    "@opentui/solid",
    "solid-js",
  ],
  // bun's JSX transform for Solid: jsx as object with importSource
  jsx: {
    mode: "transform",
    importSource: "@opentui/solid",
  },
  format: "esm",
  minify: false,
})

if (!tuiResult || (Array.isArray(tuiResult) && tuiResult.length === 0)) {
  console.error("tui build produced no output")
  process.exit(1)
}
console.log("Built dist/tui.js")

console.log("Build complete")
