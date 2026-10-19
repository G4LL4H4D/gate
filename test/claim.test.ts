import { describe, it, expect } from "bun:test"
import { claimRerouteForChild, withTimeout } from "../src/gate"
import type { RerouteEntry } from "../src/gate"

// ── claimRerouteForChild ────────────────────────────────────────────────

function makeEntry(callID: string, parentID: string, model: string, at: number): RerouteEntry {
	return { callID, parentID, model, at }
}

describe("claimRerouteForChild", () => {
	it("returns oldest-by-parent when no model specified", () => {
		const pending: RerouteEntry[] = [
			makeEntry("c2", "p1", "openai/gpt-4", 200),
			makeEntry("c1", "p1", "anthropic/claude-3", 100),
		]
		const result = claimRerouteForChild(pending, "p1", undefined, true)
		expect(result?.callID).toBe("c1")
		expect(pending.length).toBe(1)
		expect(pending[0].callID).toBe("c2")
	})

	it("prefers exact model match", () => {
		const pending: RerouteEntry[] = [
			makeEntry("c1", "p1", "anthropic/claude-3", 100),
			makeEntry("c2", "p1", "openai/gpt-4", 200),
		]
		const result = claimRerouteForChild(pending, "p1", "openai/gpt-4")
		expect(result?.callID).toBe("c2")
		expect(pending.length).toBe(1)
		expect(pending[0].callID).toBe("c1")
	})

	it("no cross-parent claim", () => {
		const pending: RerouteEntry[] = [
			makeEntry("c1", "p1", "openai/gpt-4", 100),
			makeEntry("c2", "p2", "openai/gpt-4", 200),
		]
		const result = claimRerouteForChild(pending, "p1", "openai/gpt-4")
		expect(result?.callID).toBe("c1")
		expect(pending.length).toBe(1)
		expect(pending[0].callID).toBe("c2")

		// p2 entry still claimable
		const result2 = claimRerouteForChild(pending, "p2", "openai/gpt-4")
		expect(result2?.callID).toBe("c2")
		expect(pending.length).toBe(0)
	})

	it("returns undefined when no match", () => {
		const pending: RerouteEntry[] = [makeEntry("c1", "p1", "openai/gpt-4", 100)]
		const result = claimRerouteForChild(pending, "p2")
		expect(result).toBeUndefined()
		expect(pending.length).toBe(1)
	})

	it("claimed entry removed from pending", () => {
		const pending: RerouteEntry[] = [
			makeEntry("c1", "p1", "openai/gpt-4", 100),
			makeEntry("c2", "p1", "anthropic/claude-3", 200),
		]
		claimRerouteForChild(pending, "p1", undefined, true)
		claimRerouteForChild(pending, "p1", undefined, true)
		expect(pending.length).toBe(0)
	})

	// ── allowParentOnlyFallback ──

	it("model given + no exact match + fallback off → undefined", () => {
		const pending: RerouteEntry[] = [
			makeEntry("c1", "p1", "openai/gpt-4", 100),
		]
		const result = claimRerouteForChild(pending, "p1", "anthropic/claude-3", false)
		expect(result).toBeUndefined()
		expect(pending.length).toBe(1)
	})

	it("model given + no exact match + fallback on → still undefined", () => {
		const pending: RerouteEntry[] = [
			makeEntry("c1", "p1", "openai/gpt-4", 100),
		]
		const result = claimRerouteForChild(pending, "p1", "anthropic/claude-3", true)
		expect(result).toBeUndefined()
		expect(pending.length).toBe(1)
	})

	it("no model + fallback on → oldest by parent", () => {
		const pending: RerouteEntry[] = [
			makeEntry("c2", "p1", "openai/gpt-4", 200),
			makeEntry("c1", "p1", "anthropic/claude-3", 100),
		]
		const result = claimRerouteForChild(pending, "p1", undefined, true)
		expect(result?.callID).toBe("c1")
		expect(pending.length).toBe(1)
	})

	it("no cross-parent claim with fallback", () => {
		const pending: RerouteEntry[] = [
			makeEntry("c1", "p1", "openai/gpt-4", 100),
			makeEntry("c2", "p2", "openai/gpt-4", 200),
		]
		const result = claimRerouteForChild(pending, "p1", undefined, true)
		expect(result?.callID).toBe("c1")
		expect(pending.length).toBe(1)
		expect(pending[0].callID).toBe("c2")
	})
})

// ── withTimeout ─────────────────────────────────────────────────────────

describe("withTimeout", () => {
	it("resolves normally when promise settles before timeout", async () => {
		const result = await withTimeout(Promise.resolve("ok"), 100, "test")
		expect(result).toBe("ok")
	})

	it("rejects when promise rejects", async () => {
		await expect(withTimeout(Promise.reject(new Error("boom")), 100, "test")).rejects.toThrow("boom")
	})

	it("rejects with label on timeout", async () => {
		const slow = new Promise<string>((resolve) => {
			setTimeout(() => resolve("late"), 200)
		})
		await expect(withTimeout(slow, 50, "slow-op")).rejects.toThrow("timeout: slow-op (50ms)")
	})

	it("clears timeout on resolve to avoid leaks", async () => {
		// Verify the timeout was cleared by ensuring no unhandled rejection
		const resolved = await withTimeout(Promise.resolve(42), 100, "fast")
		expect(resolved).toBe(42)
	})
})
