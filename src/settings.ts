export type Settings = {
	cap: number
	rerouteModel?: string
	extraCloudProviders: string[]
	debug: boolean
}

export const DEFAULT_SETTINGS: Settings = { cap: 2, extraCloudProviders: [], debug: false }

/**
 * Strict settings parser.
 *
 * Rules:
 * - cap: must be integer 1..32. Throws on anything else.
 * - rerouteModel: optional; if present must be a non-empty string matching "providerID/modelID".
 *   "" or absent → absent (undefined).
 * - extraCloudProviders: array of strings; each non-empty, trimmed + lowercased. Deduped.
 *   Non-string entries throw.
 * - debug: must be boolean.
 * - Unknown keys: silently ignored.
 * - Missing keys: filled from DEFAULT_SETTINGS.
 */
export function parseSettings(raw: unknown): Settings {
	if (raw === null || raw === undefined || typeof raw !== "object") {
		throw new Error("settings: expected an object, got " + (raw === null ? "null" : typeof raw))
	}

	const obj = raw as Record<string, unknown>

	// cap
	let cap: number
	if ("cap" in obj && obj.cap !== undefined) {
		const v = obj.cap
		if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 32) {
			throw new Error(`settings.cap: expected integer 1..32, got ${JSON.stringify(v)}`)
		}
		cap = v
	} else {
		cap = DEFAULT_SETTINGS.cap
	}

	// rerouteModel
	let rerouteModel: string | undefined
	if ("rerouteModel" in obj && obj.rerouteModel !== undefined) {
		const v = obj.rerouteModel
		if (typeof v !== "string") {
			throw new Error(`settings.rerouteModel: expected string, got ${JSON.stringify(v)}`)
		}
		const trimmed = v.trim()
		if (trimmed === "") {
			rerouteModel = undefined
		} else if (!/^[^/\s]+\/\S+$/.test(trimmed)) {
			throw new Error(`settings.rerouteModel: must be providerID/modelID (e.g. "openai/gpt-4"), got "${trimmed}"`)
		} else {
			rerouteModel = trimmed
		}
	} else {
		rerouteModel = DEFAULT_SETTINGS.rerouteModel
	}

	// extraCloudProviders
	let extraCloudProviders: string[]
	if ("extraCloudProviders" in obj && obj.extraCloudProviders !== undefined) {
		const v = obj.extraCloudProviders
		if (!Array.isArray(v)) {
			throw new Error(`settings.extraCloudProviders: expected array, got ${JSON.stringify(v)}`)
		}
		const seen = new Set<string>()
		const out: string[] = []
		for (let i = 0; i < v.length; i++) {
			const item = v[i]
			if (typeof item !== "string") {
				throw new Error(
					`settings.extraCloudProviders[${i}]: expected string, got ${JSON.stringify(item)}`,
				)
			}
			const normalized = item.trim().toLowerCase()
			if (normalized === "") {
				throw new Error(
					`settings.extraCloudProviders[${i}]: non-empty string required (after trim)`,
				)
			}
			if (!seen.has(normalized)) {
				seen.add(normalized)
				out.push(normalized)
			}
		}
		extraCloudProviders = out
	} else {
		extraCloudProviders = DEFAULT_SETTINGS.extraCloudProviders
	}

	// debug
	let debug: boolean
	if ("debug" in obj && obj.debug !== undefined) {
		const v = obj.debug
		if (typeof v !== "boolean") {
			throw new Error(`settings.debug: expected boolean, got ${JSON.stringify(v)}`)
		}
		debug = v
	} else {
		debug = DEFAULT_SETTINGS.debug
	}

	return { cap, extraCloudProviders, debug, ...(rerouteModel !== undefined && { rerouteModel }) }
}

/**
 * Strip any key whose value is undefined from a Settings object.
 *
 * Guarantees JSON.stringify / JSON.parse round-trip equals the input
 * (bun toStrictEqual distinguishes present-undefined from absent).
 */
export function wireSettings(s: Settings): Settings {
	const out: Record<string, unknown> = {}
	for (const k of Object.keys(s)) {
		const v = (s as any)[k]
		if (v !== undefined) out[k] = v
	}
	return out as Settings
}

/**
 * Return a Settings copy without rerouteModel when model is undefined.
 */
export function withRerouteModel(s: Settings, model: string | undefined): Settings {
	if (model === undefined) {
		const out: Record<string, unknown> = {}
		for (const k of Object.keys(s)) {
			const v = (s as any)[k]
			if (v !== undefined) out[k] = v
		}
		return out as Settings
	}
	return { ...s, rerouteModel: model }
}

/**
 * Merge stored > options > defaults, then validate the result.
 *
 * null/undefined sources treated as {}.
 */
export function resolveSettings(stored: unknown, options: unknown): Settings {
	const pickKnown = (src: unknown): Record<string, unknown> => {
		if (src === null || src === undefined || typeof src !== "object") return {}
		const obj = src as Record<string, unknown>
		const out: Record<string, unknown> = {}
		for (const key of ["cap", "rerouteModel", "extraCloudProviders", "debug"] as const) {
			if (key in obj) out[key] = obj[key]
		}
		return out
	}

	const merged = { ...DEFAULT_SETTINGS, ...pickKnown(options), ...pickKnown(stored) }
	return parseSettings(merged)
}
