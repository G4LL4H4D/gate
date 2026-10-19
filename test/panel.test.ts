import { describe, it, expect } from "bun:test"
import { limitRows } from "../src/panel"

describe("limitRows", () => {
  const isRunning = (id: string) => id.startsWith("running-")

  it("running always shown, finished capped at 8", () => {
    const ids = [
      "running-a", "running-b",
      "finished-1", "finished-2", "finished-3", "finished-4", "finished-5",
      "finished-6", "finished-7", "finished-8", "finished-9", "finished-10",
    ]
    const result = limitRows(ids, isRunning)
    expect(result.rows).toEqual([
      "running-a", "running-b",
      "finished-1", "finished-2", "finished-3", "finished-4", "finished-5",
      "finished-6", "finished-7", "finished-8",
    ])
    expect(result.hidden).toBe(2)
  })

  it("fewer than max finished shows all", () => {
    const ids = ["running-1", "finished-1", "finished-2"]
    const result = limitRows(ids, isRunning)
    expect(result.rows).toEqual(["running-1", "finished-1", "finished-2"])
    expect(result.hidden).toBe(0)
  })

  it("all running shows all", () => {
    const ids = ["running-1", "running-2", "running-3"]
    const result = limitRows(ids, isRunning)
    expect(result.rows).toEqual(["running-1", "running-2", "running-3"])
    expect(result.hidden).toBe(0)
  })

  it("all finished capped", () => {
    const ids = Array.from({ length: 12 }, (_, i) => `finished-${i + 1}`)
    const result = limitRows(ids, isRunning)
    expect(result.rows).toEqual(Array.from({ length: 8 }, (_, i) => `finished-${i + 1}`))
    expect(result.hidden).toBe(4)
  })

  it("order stable — running first, finished in original order", () => {
    const ids = ["finished-5", "running-1", "finished-3", "finished-1", "finished-4"]
    const result = limitRows(ids, isRunning)
    expect(result.rows).toEqual(["running-1", "finished-5", "finished-3", "finished-1", "finished-4"])
    expect(result.hidden).toBe(0)
  })

  it("custom maxFinished", () => {
    const ids = ["finished-1", "finished-2", "finished-3", "finished-4", "finished-5"]
    const result = limitRows(ids, isRunning, 2)
    expect(result.rows).toEqual(["finished-1", "finished-2"])
    expect(result.hidden).toBe(3)
  })
})
