import { describe, it, expect } from "bun:test"
import { createGate, shouldDropActive, stripUndefined } from "../src/gate"
import type { Gate } from "../src/gate"

// ── Helpers ────────────────────────────────────────────────────────────

function makeClock(start = 0) {
	let t = start
	return {
		now: () => t,
		advance: (ms: number) => {
			t += ms
		},
	}
}

function makeGate(cap = 2, ttlMs = 60_000) {
	const clock = makeClock()
	return {
		gate: createGate({ getCap: () => cap, ttlMs, now: clock.now }),
		clock,
	}
}

// ── (a) cap holds with 3+ simultaneous reserves ───────────────────────

describe("cap enforcement", () => {
	it("only cap reservations succeed when 3+ simultaneous reserve() calls", () => {
		const { gate } = makeGate(2)
		const r1 = gate.reserve("k1", "p1")
		const r2 = gate.reserve("k2", "p2")
		const r3 = gate.reserve("k3", "p3")

		expect(r1.ok).toBe(true)
		expect(r2.ok).toBe(true)
		expect(r3.ok).toBe(false)
		expect(gate.counts()).toEqual({ active: 0, reservations: 2, cap: 2 })
	})
})

// ── (b) expired reservation frees its slot ─────────────────────────────

describe("expiration", () => {
	it("expired reservation frees its slot after TTL", () => {
		const { gate, clock } = makeGate(2, 1_000)
		gate.reserve("k1", "p1")
		gate.reserve("k2", "p2")
		expect(gate.counts()).toEqual({ active: 0, reservations: 2, cap: 2 })

		// Advance past TTL
		clock.advance(2_000)
		gate.expire()

		// Slot freed
		const r3 = gate.reserve("k3", "p3")
		expect(r3.ok).toBe(true)
		expect(gate.counts()).toEqual({ active: 0, reservations: 1, cap: 2 })
	})
})

// ── (c) reservation consumed by activate() ─────────────────────────────

describe("consume reservation", () => {
	it("activate moves reservation to active, total stays within cap", () => {
		const { gate } = makeGate(2)
		const res = gate.reserve("k1", "p1")
		expect(res.ok).toBe(true)

		// Activate a child for the same parent — consumes the reservation
		const activated = gate.activate("child1", "p1")
		expect(activated).toBe(true)

		expect(gate.counts()).toEqual({ active: 1, reservations: 0, cap: 2 })

		// Total stays within cap: 1 active + 0 reservations = 1 < 2
		const res2 = gate.reserve("k2", "p2")
		expect(res2.ok).toBe(true)
		expect(gate.counts()).toEqual({ active: 1, reservations: 1, cap: 2 })
	})
})

// ── (d) release() of a failed call frees its slot ─────────────────────

describe("release", () => {
	it("release of a reservation frees its slot", () => {
		const { gate } = makeGate(2)
		const res1 = gate.reserve("k1", "p1")
		const res2 = gate.reserve("k2", "p2")
		expect(gate.counts()).toEqual({ active: 0, reservations: 2, cap: 2 })

		// Simulate a failed call — release its reservation
		gate.release(res1.reservationID!)
		expect(gate.counts()).toEqual({ active: 0, reservations: 1, cap: 2 })

		// Slot freed — new reserve succeeds
		const res3 = gate.reserve("k3", "p3")
		expect(res3.ok).toBe(true)
	})
})

// ── (e) deactivate() frees ────────────────────────────────────────────

describe("deactivate", () => {
	it("deactivate frees its slot", () => {
		const { gate } = makeGate(2)
		gate.reserve("k1", "p1")
		gate.reserve("k2", "p2")
		gate.activate("child1", "p1")
		expect(gate.counts()).toEqual({ active: 1, reservations: 1, cap: 2 })

		gate.deactivate("child1")
		expect(gate.counts()).toEqual({ active: 0, reservations: 1, cap: 2 })

		// Slot freed
		const res3 = gate.reserve("k3", "p3")
		expect(res3.ok).toBe(true)
		expect(gate.counts()).toEqual({ active: 0, reservations: 2, cap: 2 })
	})
})

// ── (f) getCap() lowered while children active ─────────────────────────

describe("dynamic cap", () => {
	it("existing children stay, new reserves denied until counts drop below new cap", () => {
		let cap = 2
		const gate = createGate({ getCap: () => cap })

		// Create 2 active children
		gate.activate("child1", "p1")
		gate.activate("child2", "p2")
		expect(gate.counts()).toEqual({ active: 2, reservations: 0, cap: 2 })

		// Lower cap
		cap = 1
		expect(gate.getCap()).toBe(1)
		expect(gate.counts()).toEqual({ active: 2, reservations: 0, cap: 1 })

		// New reserve denied (2+0 >= 1)
		expect(gate.reserve("k3", "p3").ok).toBe(false)

		// Deactivate one child
		gate.deactivate("child1")
		expect(gate.counts()).toEqual({ active: 1, reservations: 0, cap: 1 })

		// Still full: 1+0 >= 1 = true
		expect(gate.reserve("k4", "p4").ok).toBe(false)

		// Deactivate second child
		gate.deactivate("child2")
		expect(gate.counts()).toEqual({ active: 0, reservations: 0, cap: 1 })

		// Now reserve succeeds (0+0 < 1)
		expect(gate.reserve("k5", "p5").ok).toBe(true)
	})
})

// ── (g) same parent: local + rerouted child not swapped ────────────────

describe("same parent", () => {
	it("local child consumes reservation; rerouted child does not", () => {
		const { gate } = makeGate(2)

		// Reserve for parent P
		const res = gate.reserve("k1", "p1")
		expect(res.ok).toBe(true)

		// Activate local child for parent P — consumes the reservation
		const activatedLocal = gate.activate("localChild", "p1")
		expect(activatedLocal).toBe(true)
		expect(gate.hasReservationFor("p1")).toBe(false)

		// Activate rerouted child for same parent P — no reservation to consume
		const activatedRerouted = gate.activate("reroutedChild", "p1")
		expect(activatedRerouted).toBe(true) // still adds to active, just doesn't consume

		// Total: 2 active, 0 reservations — within cap (2)
		expect(gate.counts()).toEqual({ active: 2, reservations: 0, cap: 2 })

		// A third reserve should fail (cap reached)
		expect(gate.reserve("k2", "p2").ok).toBe(false)
	})
})

// ── (h) activate idempotent — same child twice consumes one reservation ──

describe("activate idempotent", () => {
	it("activating same child twice consumes only one reservation; sibling's reservation stays", () => {
		const { gate } = makeGate(2)

		// Reserve two slots for two different parents
		const res1 = gate.reserve("k1", "p1")
		expect(res1.ok).toBe(true)
		const res2 = gate.reserve("k2", "p2")
		expect(res2.ok).toBe(true)
		expect(gate.counts()).toEqual({ active: 0, reservations: 2, cap: 2 })

		// Activate child1 for p1 — consumes p1's reservation
		const a1 = gate.activate("child1", "p1")
		expect(a1).toBe(true)
		expect(gate.counts()).toEqual({ active: 1, reservations: 1, cap: 2 })

		// Activate child1 again — idempotent, no reservation consumed
		const a2 = gate.activate("child1", "p1")
		expect(a2).toBe(true)
		expect(gate.counts()).toEqual({ active: 1, reservations: 1, cap: 2 })

		// Sibling's reservation for p2 is untouched
		expect(gate.hasReservationFor("p2")).toBe(true)

		// Cap invariant: 1 active + 1 reservation = 2 ≤ cap
		const res3 = gate.reserve("k3", "p3")
		expect(res3.ok).toBe(false) // cap reached
	})
})

// ── shouldDropActive ───────────────────────────────────────────────────

describe("shouldDropActive", () => {
	it("false when startedAt is falsy", () => {
		expect(shouldDropActive(1000, undefined)).toBe(false)
		expect(shouldDropActive(1000, 0)).toBe(false)
	})

	it("false when sessionIdle is undefined", () => {
		expect(shouldDropActive(undefined, 500)).toBe(false)
	})

	it("false when idle is before startedAt", () => {
		expect(shouldDropActive(400, 500)).toBe(false)
	})

	it("true when idle equals startedAt", () => {
		expect(shouldDropActive(500, 500)).toBe(true)
	})

	it("true when idle is after startedAt", () => {
		expect(shouldDropActive(600, 500)).toBe(true)
	})
})

// ── stripUndefined ──────────────────────────────────────────────────────

describe("stripUndefined", () => {
	it("removes keys with undefined values", () => {
		const obj = { a: 1, b: undefined, c: "hello", d: undefined } as Record<string, unknown>
		const result = stripUndefined(obj)
		expect(Object.keys(result)).toEqual(["a", "c"])
		expect(result.a).toBe(1)
		expect(result.c).toBe("hello")
		expect("b" in result).toBe(false)
		expect("d" in result).toBe(false)
	})

	it("returns unchanged for object with no undefined values", () => {
		const obj = { a: 1, b: "x", c: true } as Record<string, unknown>
		const result = stripUndefined(obj)
		expect(Object.keys(result).sort()).toEqual(["a", "b", "c"])
	})

	it("handles empty object", () => {
		const obj = {} as Record<string, unknown>
		const result = stripUndefined(obj)
		expect(Object.keys(result)).toEqual([])
	})
})
