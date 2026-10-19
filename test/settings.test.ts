import { describe, it, expect } from "bun:test"
import { DEFAULT_SETTINGS, parseSettings, resolveSettings, wireSettings, withRerouteModel } from "../src/settings.js"

describe("DEFAULT_SETTINGS", () => {
	it("has correct defaults", () => {
		expect(DEFAULT_SETTINGS).toEqual({ cap: 2, extraCloudProviders: [], debug: false })
		expect(DEFAULT_SETTINGS.rerouteModel).toBeUndefined()
	})
})

describe("parseSettings", () => {
	it("returns defaults for empty object", () => {
		expect(parseSettings({})).toEqual(DEFAULT_SETTINGS)
	})

	it("accepts full valid object", () => {
		const input = { cap: 4, rerouteModel: "openai/gpt-4", extraCloudProviders: ["aws-bedrock"], debug: true }
		const result = parseSettings(input)
		expect(result).toEqual(input)
	})

	// --- cap validation ---
	it("throws for cap 0", () => {
		expect(() => parseSettings({ cap: 0 })).toThrow("settings.cap: expected integer 1..32")
	})

	it("throws for cap 1.5", () => {
		expect(() => parseSettings({ cap: 1.5 })).toThrow("settings.cap: expected integer 1..32")
	})

	it("throws for cap 33", () => {
		expect(() => parseSettings({ cap: 33 })).toThrow("settings.cap: expected integer 1..32")
	})

	it("throws for cap \"2\"", () => {
		expect(() => parseSettings({ cap: "2" })).toThrow("settings.cap: expected integer 1..32")
	})

	it("throws for cap NaN", () => {
		expect(() => parseSettings({ cap: NaN })).toThrow("settings.cap: expected integer 1..32")
	})

	it("accepts cap 1", () => {
		expect(parseSettings({ cap: 1 }).cap).toBe(1)
	})

	it("accepts cap 32", () => {
		expect(parseSettings({ cap: 32 }).cap).toBe(32)
	})

	// --- rerouteModel ---
	it("rerouteModel '' becomes absent", () => {
		const result = parseSettings({ rerouteModel: "" })
		expect(result.rerouteModel).toBeUndefined()
	})

	it("rerouteModel ' ' becomes absent (whitespace only)", () => {
		const result = parseSettings({ rerouteModel: " " })
		expect(result.rerouteModel).toBeUndefined()
	})

	it("rerouteModel undefined is absent", () => {
		const result = parseSettings({ rerouteModel: undefined })
		expect(result.rerouteModel).toBeUndefined()
	})

	it("rerouteModel absent is absent", () => {
		const result = parseSettings({})
		expect(result.rerouteModel).toBeUndefined()
	})

	it("rerouteModel valid string is kept", () => {
		const result = parseSettings({ rerouteModel: "openai/gpt-4" })
		expect(result.rerouteModel).toBe("openai/gpt-4")
	})

	it("rerouteModel 'foo' (no slash) throws", () => {
		expect(() => parseSettings({ rerouteModel: "foo" })).toThrow('must be providerID/modelID')
	})

	it("rerouteModel 'a/' (no model after slash) throws", () => {
		expect(() => parseSettings({ rerouteModel: "a/" })).toThrow('must be providerID/modelID')
	})

	it("rerouteModel '/b' (no provider before slash) throws", () => {
		expect(() => parseSettings({ rerouteModel: "/b" })).toThrow('must be providerID/modelID')
	})

	it("rerouteModel as number throws", () => {
		expect(() => parseSettings({ rerouteModel: 123 })).toThrow("settings.rerouteModel: expected string")
	})

	// --- extraCloudProviders ---
	it("normalises trim+lowercase+dedupe", () => {
		const input = { extraCloudProviders: ["  AWS-BedRock  ", "aws-bedrock", "  azure-openai  ", "AZURE-OPENAI"] }
		const result = parseSettings(input)
		expect(result.extraCloudProviders).toEqual(["aws-bedrock", "azure-openai"])
	})

	it("non-string entries throw", () => {
		expect(() => parseSettings({ extraCloudProviders: [123] })).toThrow("settings.extraCloudProviders[0]")
		expect(() => parseSettings({ extraCloudProviders: [null] })).toThrow("settings.extraCloudProviders[0]")
		expect(() => parseSettings({ extraCloudProviders: [true] })).toThrow("settings.extraCloudProviders[0]")
	})

	it("empty-after-trim throws", () => {
		expect(() => parseSettings({ extraCloudProviders: ["  "] })).toThrow("settings.extraCloudProviders[0]: non-empty")
	})

	it("non-array throws", () => {
		expect(() => parseSettings({ extraCloudProviders: "aws" })).toThrow("settings.extraCloudProviders: expected array")
	})

	// --- debug ---
	it("debug as number throws", () => {
		expect(() => parseSettings({ debug: 1 })).toThrow("settings.debug: expected boolean")
	})

	it("debug as string throws", () => {
		expect(() => parseSettings({ debug: "true" })).toThrow("settings.debug: expected boolean")
	})

	it("debug true accepted", () => {
		expect(parseSettings({ debug: true }).debug).toBe(true)
	})

	it("debug false accepted", () => {
		expect(parseSettings({ debug: false }).debug).toBe(false)
	})

	// --- unknown keys ---
	it("unknown keys ignored", () => {
		const result = parseSettings({ foo: "bar", baz: 123 })
		expect(result).toEqual(DEFAULT_SETTINGS)
	})

	// --- raw input validation ---
	it("null input throws", () => {
		expect(() => parseSettings(null)).toThrow("settings: expected an object")
	})

	it("undefined input throws", () => {
		expect(() => parseSettings(undefined)).toThrow("settings: expected an object")
	})

	it("string input throws", () => {
		expect(() => parseSettings("hello")).toThrow("settings: expected an object")
	})

	it("number input throws", () => {
		expect(() => parseSettings(42)).toThrow("settings: expected an object")
	})
})

describe("resolveSettings", () => {
	it("null stored + null options → defaults", () => {
		expect(resolveSettings(null, null)).toEqual(DEFAULT_SETTINGS)
	})

	it("undefined stored + undefined options → defaults", () => {
		expect(resolveSettings(undefined, undefined)).toEqual(DEFAULT_SETTINGS)
	})

	it("options override defaults", () => {
		const result = resolveSettings(null, { cap: 4, debug: true })
		expect(result).toEqual({ cap: 4, extraCloudProviders: [], debug: true })
	})

	it("stored overrides options", () => {
		const result = resolveSettings({ cap: 8 }, { cap: 4 })
		expect(result.cap).toBe(8)
	})

	it("stored overrides defaults", () => {
		const result = resolveSettings({ cap: 16 }, null)
		expect(result.cap).toBe(16)
	})

	it("options override defaults when stored is null", () => {
		const result = resolveSettings(null, { debug: true })
		expect(result.debug).toBe(true)
	})

	it("invalid cap in options throws", () => {
		expect(() => resolveSettings(null, { cap: 0 })).toThrow("settings.cap: expected integer 1..32")
	})

	it("invalid cap in stored throws", () => {
		expect(() => resolveSettings({ cap: 33 }, null)).toThrow("settings.cap: expected integer 1..32")
	})

	it("invalid extraCloudProviders in options throws", () => {
		expect(() => resolveSettings(null, { extraCloudProviders: [123] })).toThrow("settings.extraCloudProviders[0]")
	})

	it("extraCloudProviders normalised in stored", () => {
		const result = resolveSettings({ extraCloudProviders: ["  AWS  ", "aws"] }, null)
		expect(result.extraCloudProviders).toEqual(["aws"])
	})

	it("non-object stored treated as {}", () => {
		expect(resolveSettings("hello", null)).toEqual(DEFAULT_SETTINGS)
	})

	it("non-object options treated as {}", () => {
		expect(resolveSettings(null, "hello")).toEqual(DEFAULT_SETTINGS)
	})

	it("rerouteModel key absent when parseSettings({})", () => {
		expect("rerouteModel" in parseSettings({})).toBe(false)
	})

	it("rerouteModel key absent when parseSettings({rerouteModel: ''})", () => {
		expect("rerouteModel" in parseSettings({ rerouteModel: "" })).toBe(false)
	})

	it("rerouteModel key present when valid", () => {
		expect("rerouteModel" in parseSettings({ rerouteModel: "openai/gpt-4" })).toBe(true)
	})

	it("resolveSettings(undefined, undefined) has no rerouteModel key", () => {
		expect("rerouteModel" in resolveSettings(undefined, undefined)).toBe(false)
	})

	it("JSON round-trip equals original (toStrictEqual)", () => {
		const input = { cap: 4, rerouteModel: "openai/gpt-4", extraCloudProviders: ["aws-bedrock"], debug: true }
		const parsed = parseSettings(input)
		expect(JSON.parse(JSON.stringify(parsed))).toStrictEqual(parsed)
	})

	it("JSON round-trip equals original when rerouteModel absent", () => {
		const parsed = parseSettings({})
		expect(JSON.parse(JSON.stringify(parsed))).toStrictEqual(parsed)
	})
})

describe("wireSettings", () => {
	it("strips undefined values", () => {
		const s = { cap: 2, rerouteModel: undefined, extraCloudProviders: [], debug: false } as any
		const result = wireSettings(s)
		expect("rerouteModel" in result).toBe(false)
		expect(result.cap).toBe(2)
	})

	it("keeps all defined values", () => {
		const s = { cap: 4, rerouteModel: "anthropic/claude-3", extraCloudProviders: ["gcp"], debug: true }
		const result = wireSettings(s)
		expect(result).toStrictEqual(s)
	})
})

describe("withRerouteModel", () => {
	it("omits rerouteModel when undefined", () => {
		const s = { cap: 2, rerouteModel: undefined, extraCloudProviders: [], debug: false } as any
		const result = withRerouteModel(s, undefined)
		expect("rerouteModel" in result).toBe(false)
	})

	it("includes rerouteModel when defined", () => {
		const s = { cap: 2, extraCloudProviders: [], debug: false }
		const result = withRerouteModel(s, "openai/gpt-4")
		expect(result.rerouteModel).toBe("openai/gpt-4")
		expect("rerouteModel" in result).toBe(true)
	})
})
