// Pure cap / reservation framework for the GATE plugin.
// All state is internal; no Effect / plugin coupling. Inject a clock for tests.

export interface GateCounts {
	active: number
	reservations: number
	cap: number
}

export interface ReservationResult {
	ok: boolean
	reservationID?: string
}

export interface Gate {
	/** Reserve a slot under key (caller-supplied, e.g. tool-call ID). */
	reserve(key: string, parentID: string): ReservationResult
	release(reservationID: string): boolean
	activate(childID: string, parentID: string): boolean
	deactivate(childID: string): boolean
	expire(): void
	counts(): GateCounts
	getCap(): number
	hasReservationFor(parentID: string): boolean
	activeIDs(): string[]
}

/**
 * Claim the oldest pending reroute for a given parent (and optional model).
 * Returns the claimed entry or undefined; removes it from pending.
 * When a model is given but no exact match exists, never falls back to
 * parent-only. Parent-only fallback only when no model is given
 * and allowParentOnlyFallback is true.
 */
export function claimRerouteForChild(
	pending: RerouteEntry[],
	parentID: string,
	model?: string,
	allowParentOnlyFallback?: boolean,
): RerouteEntry | undefined {
	// Prefer exact model match.
	if (model) {
		const matches = pending.filter((r) => r.parentID === parentID && r.model === model)
		if (matches.length > 0) {
			const oldest = matches.reduce((a, b) => (a.at < b.at ? a : b))
			const idx = pending.indexOf(oldest)
			if (idx !== -1) return pending.splice(idx, 1)[0]
		}
		// No exact match with a model given — never fall back.
		return undefined
	}
	// Fallback: oldest by parent — only when no model is given and flag is true.
	if (!allowParentOnlyFallback) return undefined
	const parentMatches = pending.filter((r) => r.parentID === parentID)
	if (parentMatches.length > 0) {
		const oldest = parentMatches.reduce((a, b) => (a.at < b.at ? a : b))
		const idx = pending.indexOf(oldest)
		if (idx !== -1) return pending.splice(idx, 1)[0]
	}
	return undefined
}

/** Run a promise with a timeout; rejects with a label-specific error on timeout. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const id = setTimeout(() => reject(new Error(`timeout: ${label} (${ms}ms)`)), ms)
		promise.then(
			(v) => { clearTimeout(id); resolve(v) },
			(e)  => { clearTimeout(id); reject(e) },
		)
	})
}

export interface RerouteEntry {
	callID: string
	parentID: string
	model: string
	agent?: string
	description?: string
	at: number
}

/**
 * Decide whether an active child whose session is still reachable should be dropped
 * because it has been idle since it started (execution finished but event was missed).
 */
export function shouldDropActive(sessionIdle: number | undefined, startedAt: number | undefined): boolean {
	if (!startedAt) return false
	if (!sessionIdle) return false
	return sessionIdle >= startedAt
}

export function createGate({
	getCap,
	ttlMs = 60_000,
	now = Date.now,
}: {
	getCap: () => number
	ttlMs?: number
	now?: () => number
}): Gate {
	const active = new Set<string>()
	const reservations = new Map<string, { parentID: string; at: number }>()

	const isFull = () => active.size + reservations.size >= getCap()

	function expire(): void {
		const cutoff = now() - ttlMs
		for (const [id, r] of reservations) {
			if (r.at < cutoff) reservations.delete(id)
		}
	}

	function reserve(key: string, parentID: string): ReservationResult {
		if (isFull()) return { ok: false }
		reservations.set(key, { parentID, at: now() })
		return { ok: true, reservationID: key }
	}

	function release(reservationID: string): boolean {
		return reservations.delete(reservationID)
	}

	function activate(childID: string, parentID: string): boolean {
		// Idempotent: if already active, return true without consuming a reservation.
		if (active.has(childID)) return true
		// Find oldest reservation for this parent; consume it.
		let foundId: string | undefined
		for (const [id, r] of reservations) {
			if (r.parentID === parentID) {
				foundId = id
				break
			}
		}
		if (foundId !== undefined) reservations.delete(foundId)
		active.add(childID)
		return true
	}

	function deactivate(childID: string): boolean {
		return active.delete(childID)
	}

	function counts(): GateCounts {
		return {
			active: active.size,
			reservations: reservations.size,
			cap: getCap(),
		}
	}

	function hasReservationFor(parentID: string): boolean {
		for (const [, r] of reservations) {
			if (r.parentID === parentID) return true
		}
		return false
	}

	function activeIDs(): string[] {
		return [...active]
	}

	return {
		reserve,
		release,
		activate,
		deactivate,
		expire,
		counts,
		getCap,
		hasReservationFor,
		activeIDs,
	}
}
