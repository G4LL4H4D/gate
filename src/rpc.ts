import { Rpc } from "@opencode/plugin/rpc"
import type { Settings } from "./settings.js"

export type RecentEntry = {
	time: number
	kind: "reroute" | "deny"
	agent?: string
	parentID: string
	childID?: string
	model?: string
}

export type ChildEntry = { childID: string; parentID: string; agent?: string; model?: string; local: boolean }
export type DebugInfo = { lastDecision: "none" | "local" | "reroute" | "deny"; active: number; reservations: number; at: number }

export type Stats = {
	active: number
	cap: number
	launchedLocal: number
	rerouted: number
	denied: number
	recent: Array<RecentEntry>
	children: Array<ChildEntry>
	debug: DebugInfo
}

const statsSchema = {
	type: "object",
	properties: {
		active: { type: "number" },
		cap: { type: "number" },
		launchedLocal: { type: "number" },
		rerouted: { type: "number" },
		denied: { type: "number" },
		recent: {
			type: "array",
			items: {
				type: "object",
				properties: {
					time: { type: "number" },
					kind: { type: "string", enum: ["reroute", "deny"] },
					agent: { type: "string" },
					parentID: { type: "string" },
					childID: { type: "string" },
					model: { type: "string" },
				},
				required: ["time", "kind", "parentID"],
				additionalProperties: false,
			},
		},
		children: {
			type: "array",
			items: {
				type: "object",
				properties: {
					childID: { type: "string" },
					parentID: { type: "string" },
					agent: { type: "string" },
					model: { type: "string" },
					local: { type: "boolean" },
				},
				required: ["childID", "parentID", "local"],
				additionalProperties: false,
			},
		},
		debug: {
			type: "object",
			properties: {
				lastDecision: { type: "string", enum: ["none", "local", "reroute", "deny"] },
				active: { type: "number" },
				reservations: { type: "number" },
				at: { type: "number" },
			},
			required: ["lastDecision", "active", "reservations", "at"],
			additionalProperties: false,
		},
	},
} as const

export const settingsSchema = {
	type: "object",
	properties: {
		cap: { type: "integer" },
		rerouteModel: { type: "string" },
		extraCloudProviders: { type: "array", items: { type: "string" } },
		debug: { type: "boolean" },
	},
	required: ["cap", "extraCloudProviders", "debug"],
	additionalProperties: false,
} as const

// Error schema for settingsSet validation failures.
// The handler must use `context.error("validation_error", message, { message })` to return this.
// If the handler throws instead, the RPC framework converts it to rpc.internal.
const settingsValidationError = {
	type: "object",
	required: ["message"],
	properties: {
		message: { type: "string" },
	},
	additionalProperties: false,
} as const

export const Gate = Rpc.define({
	id: "gate",
	methods: {
		stats: { input: { type: "object" }, output: statsSchema },
		settingsGet: { input: { type: "object" }, output: settingsSchema },
		settingsSet: {
			input: settingsSchema,
			output: settingsSchema,
			errors: {
				validation_error: settingsValidationError,
			},
		},
	},
	events: {
		changed: { schema: statsSchema },
		settingsChanged: { schema: settingsSchema },
	},
})
