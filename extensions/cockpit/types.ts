import type { ContextUsage } from "@earendil-works/pi-coding-agent";

/** High-level flight state shown by the HUD and flight deck. */
export type CockpitStatus =
	| "STANDBY"
	| "NOMINAL"
	| "IGNITION"
	| "THINKING"
	| "STREAMING"
	| "TOOL"
	| "AWAIT"
	| "COMPACT"
	| "ERROR";

/** Theme foreground tokens used by cockpit renderers. */
export type Tone = "text" | "muted" | "dim" | "accent" | "success" | "warning" | "error";

export interface CockpitModel {
	id: string;
	name: string;
	provider: string;
	contextWindow: number;
	reasoning: boolean;
}

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
}

export interface FlightLogEntry {
	/** Unix ms timestamp. */
	at: number;
	/** Short uppercase category, for example SYS, TOOL, MODEL. */
	kind: string;
	text: string;
	tone: Tone;
}

export interface ActiveToolInfo {
	id: string;
	name: string;
	summary: string;
	startedAt: number;
}

export interface ToolStat {
	name: string;
	calls: number;
	errors: number;
	totalMs: number;
	lastMs: number | undefined;
	avgMs: number;
}

export interface ToolInfoLite {
	name: string;
	description: string;
	exposure: string;
	active: boolean;
}

export interface SessionMeta {
	cwd: string;
	name: string | undefined;
	id: string | undefined;
	file: string | undefined;
	gitBranch: string | undefined;
}

export interface CockpitSnapshot {
	status: CockpitStatus;
	statusDetail: string;
	/** Milliseconds since this extension/session started. */
	elapsedMs: number;
	/** Milliseconds since the process started. */
	uptimeMs: number;
	model: CockpitModel | undefined;
	thinking: string;
	context: ContextUsage | undefined;
	usage: UsageTotals & { liveOutput: number };
	rate: number;
	peakRate: number;
	flux: number[];
	log: readonly FlightLogEntry[];
	activeTools: ActiveToolInfo[];
	toolStats: ToolStat[];
	tools: ToolInfoLite[];
	activeToolNames: readonly string[];
	prompts: number;
	turns: number;
	assistantMessages: number;
	toolCalls: number;
	toolFailures: number;
	lastHttpStatus: number | undefined;
	session: SessionMeta;
}

export function emptyUsage(): UsageTotals {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: 0,
	};
}
