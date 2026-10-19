import { describe, it, expect } from "bun:test"
import { splitRoutedTitle, shortModel } from "../src/title"

describe("splitRoutedTitle", () => {
  it("extracts label and model from a tagged title", () => {
    const result = splitRoutedTitle("Read README foreground 1 [routed to opencode/nemotron-3.5-super-vl-free]")
    expect(result.label).toBe("Read README foreground 1")
    expect(result.model).toBe("opencode/nemotron-3.5-super-vl-free")
  })

  it("returns title as label when no tag present", () => {
    const result = splitRoutedTitle("Read README foreground 1")
    expect(result.label).toBe("Read README foreground 1")
    expect(result.model).toBe(undefined)
  })

  it("handles tag with provider/model", () => {
    const result = splitRoutedTitle("Test [routed to local/qwen3.6-35b-a3b]")
    expect(result.label).toBe("Test")
    expect(result.model).toBe("local/qwen3.6-35b-a3b")
  })

  it("handles extra spaces around tag", () => {
    const result = splitRoutedTitle("Test  [routed to  local/qwen3.6]  ")
    expect(result.label).toBe("Test")
    expect(result.model).toBe("local/qwen3.6")
  })

  it("does not match tag in the middle", () => {
    const result = splitRoutedTitle("Some [routed to local/q] text after")
    expect(result.label).toBe("Some [routed to local/q] text after")
    expect(result.model).toBe(undefined)
  })

  it("returns empty string as label for empty input", () => {
    const result = splitRoutedTitle("")
    expect(result.label).toBe("")
    expect(result.model).toBe(undefined)
  })
})

describe("shortModel", () => {
  it("strips provider prefix", () => {
    expect(shortModel("opencode/nemotron-3.5-super-vl-free")).toBe("nemotron-3.5-super-vl-free")
  })

  it("returns model unchanged when no slash", () => {
    expect(shortModel("qwen3.6")).toBe("qwen3.6")
  })

  it("returns model unchanged when slash is last char", () => {
    expect(shortModel("local/")).toBe("local/")
  })
})
