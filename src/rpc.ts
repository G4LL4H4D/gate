import { Rpc } from "@opencode/plugin/rpc"

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

export const Gate = Rpc.define({
	id: "subagent-gate",
	methods: {
		stats: { input: { type: "object" }, output: statsSchema },
	},
	events: {
		changed: { schema: statsSchema },
	},
})
