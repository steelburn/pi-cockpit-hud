import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { ContextUsage, SessionEntry, ToolInfo } from "@earendil-works/pi-coding-agent";
import { fmtCost, fmtCount, fmtDuration, shorten } from "./paint.ts";
import {
	type ActiveToolInfo,
	type CockpitModel,
	type CockpitSnapshot,
	type CockpitStatus,
	emptyUsage,
	type FlightLogEntry,
	type SessionMeta,
	type ToolInfoLite,
	type ToolStat,
	type Tone,
	type UsageTotals,
} from "./types.ts";

export interface TelemetryProviders {
	contextUsage: () => ContextUsage | undefined;
	tools: () => { active: readonly string[]; all: readonly ToolInfo[] };
}

const MAX_LOG_ENTRIES = 240;
const MAX_FLUX_SAMPLES = 80;

function safeUsage(usage: Usage | undefined): UsageTotals {
	if (!usage) return emptyUsage();
	return {
		input: usage.input || 0,
		output: usage.output || 0,
		cacheRead: usage.cacheRead || 0,
		cacheWrite: usage.cacheWrite || 0,
		totalTokens: usage.totalTokens || 0,
		cost: usage.cost?.total || 0,
	};
}

function addUsage(target: UsageTotals, usage: Usage | undefined): void {
	const next = safeUsage(usage);
	target.input += next.input;
	target.output += next.output;
	target.cacheRead += next.cacheRead;
	target.cacheWrite += next.cacheWrite;
	target.totalTokens += next.totalTokens;
	target.cost += next.cost;
}

function flattenArgValue(value: unknown): string {
	if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) return value.map(flattenArgValue).join(" ");
	if (value && typeof value === "object") {
		try {
			return JSON.stringify(value);
		} catch {
			return "";
		}
	}
	return "";
}

/** Produce a one-line, human-readable summary of a tool's arguments. */
export function summarizeToolArgs(args: unknown): string {
	if (args === undefined || args === null) return "";
	if (typeof args === "string") return shorten(args, 56);
	if (typeof args !== "object") return shorten(String(args), 56);

	const record = args as Record<string, unknown>;
	const preferred = [
		"command",
		"path",
		"file_path",
		"pattern",
		"query",
		"url",
		"prompt",
		"description",
		"name",
		"to",
	];
	for (const key of preferred) {
		if (key in record) {
			const text = flattenArgValue(record[key]);
			if (text) return shorten(text, 56);
		}
	}
	const first = Object.entries(record).find(([, value]) => flattenArgValue(value).length > 0);
	return first ? shorten(`${first[0]}=${flattenArgValue(first[1])}`, 56) : "";
}

function modelOf(model: { id: string; name?: string; provider: string; contextWindow?: number; reasoning?: boolean } | undefined): CockpitModel | undefined {
	if (!model) return undefined;
	return {
		id: model.id,
		name: model.name ?? model.id,
		provider: model.provider,
		contextWindow: model.contextWindow ?? 0,
		reasoning: model.reasoning ?? false,
	};
}

export class TelemetryStore {
	private readonly providers: TelemetryProviders;
	private readonly startedAt = Date.now();
	private sessionStartedAt = Date.now();
	private status: CockpitStatus = "STANDBY";
	private statusDetail = "";
	private statusSince = Date.now();

	private model: CockpitModel | undefined;
	private thinking = "off";
	private context: ContextUsage | undefined;
	private usage: UsageTotals = emptyUsage();

	private logEntries: FlightLogEntry[] = [];
	private flux: number[] = [];
	private rate = 0;
	private peakRate = 0;
	private streamChars = 0;
	private messageStartChars = 0;
	private lastSampleAt = Date.now();
	private lastSampleChars = 0;

	private activeTools = new Map<string, ActiveToolInfo>();
	private toolStats = new Map<string, ToolStat>();
	private tools: ToolInfoLite[] = [];
	private activeToolNames: string[] = [];

	private prompts = 0;
	private turns = 0;
	private assistantMessages = 0;
	private toolCalls = 0;
	private toolFailures = 0;
	private lastHttpStatus: number | undefined;
	private lastToolsRefresh = 0;

	private session: SessionMeta = {
		cwd: "",
		name: undefined,
		id: undefined,
		file: undefined,
		gitBranch: undefined,
	};

	constructor(providers: TelemetryProviders) {
		this.providers = providers;
	}

	beginSession(meta: Omit<SessionMeta, "gitBranch">, reason: string): void {
		this.sessionStartedAt = Date.now();
		this.session = { ...meta, gitBranch: this.session.gitBranch };
		this.status = "STANDBY";
		this.statusDetail = "";
		this.statusSince = Date.now();
		this.context = undefined;
		this.usage = emptyUsage();
		this.logEntries = [];
		this.flux = [];
		this.rate = 0;
		this.peakRate = 0;
		this.streamChars = 0;
		this.messageStartChars = 0;
		this.lastSampleAt = Date.now();
		this.lastSampleChars = 0;
		this.activeTools.clear();
		this.toolStats.clear();
		this.prompts = 0;
		this.turns = 0;
		this.assistantMessages = 0;
		this.toolCalls = 0;
		this.toolFailures = 0;
		this.lastHttpStatus = undefined;
		this.refreshTools();
		this.log("SYS", `flight deck online · ${reason}`, "accent");
	}

	/** Rebuild token and message totals from a session branch. */
	recompute(entries: readonly SessionEntry[]): void {
		this.usage = emptyUsage();
		this.prompts = 0;
		this.assistantMessages = 0;
		for (const entry of entries) {
			if (entry.type !== "message") continue;
			const message = entry.message;
			if (message.role === "user") {
				this.prompts++;
			} else if (message.role === "assistant") {
				this.assistantMessages++;
				addUsage(this.usage, message.usage);
			}
		}
		this.log("SYS", `telemetry rebuilt · ${entries.length} entries`, "muted");
	}

	setModel(model: Parameters<typeof modelOf>[0]): void {
		this.model = modelOf(model);
	}

	setThinking(level: string): void {
		this.thinking = level;
	}

	setSessionName(name: string | undefined): void {
		this.session.name = name;
	}

	setGitBranch(branch: string | undefined): void {
		this.session.gitBranch = branch;
	}

	refreshTools(): void {
		try {
			const current = this.providers.tools();
			this.activeToolNames = [...current.active];
			const active = new Set(this.activeToolNames);
			this.tools = current.all.map((tool) => ({
				name: tool.name,
				description: tool.description,
				exposure: tool.exposure,
				active: active.has(tool.name),
			}));
			this.lastToolsRefresh = Date.now();
		} catch {
			// Tool introspection must never take down the cockpit.
		}
	}

	setStatus(status: CockpitStatus, detail = ""): void {
		if (this.status !== status) {
			this.status = status;
			this.statusSince = Date.now();
		}
		this.statusDetail = detail;
	}

	resumeStatus(idle: boolean): void {
		const active = [...this.activeTools.values()][0];
		if (active) {
			this.setStatus("TOOL", active.name);
		} else {
			this.setStatus(idle ? "NOMINAL" : "THINKING");
		}
	}

	log(kind: string, text: string, tone: Tone = "muted"): void {
		this.logEntries.push({ at: Date.now(), kind: kind.slice(0, 6).toUpperCase(), text, tone });
		if (this.logEntries.length > MAX_LOG_ENTRIES) {
			this.logEntries.splice(0, this.logEntries.length - MAX_LOG_ENTRIES);
		}
	}

	clearLog(): void {
		this.logEntries = [];
		this.log("SYS", "flight log cleared", "muted");
	}

	notePrompt(text: string): void {
		this.prompts++;
		this.setStatus("THINKING");
		const summary = text.replace(/\s+/g, " ").trim();
		this.log("PROMPT", summary ? shorten(summary, 80) : "(empty prompt)", "text");
	}

	noteTurn(index: number): void {
		this.turns = Math.max(this.turns, index);
		this.log("TURN", `turn ${index} engaged`, "muted");
	}

	beginAssistant(): void {
		this.messageStartChars = this.streamChars;
		this.setStatus("STREAMING");
	}

	addStreamChars(count: number): void {
		if (count <= 0) return;
		this.streamChars += count;
		this.setStatus("STREAMING");
	}

	recordAssistant(message: AssistantMessage): void {
		this.assistantMessages++;
		addUsage(this.usage, message.usage);
		this.messageStartChars = this.streamChars;

		const usage = safeUsage(message.usage);
		const duration = message.durationMs ? ` · ${fmtDuration(message.durationMs)}` : "";
		this.log(
			"MODEL",
			`${fmtCount(usage.input)} in · ${fmtCount(usage.output)} out · ${fmtCost(usage.cost)}${duration}`,
			"accent",
		);

		if (message.stopReason === "error") {
			this.setStatus("ERROR", message.errorMessage ?? "provider error");
			this.log("ERROR", message.errorMessage ?? "provider returned an error", "error");
		} else if (message.stopReason === "aborted") {
			this.log("ABORT", "response aborted", "warning");
			this.resumeStatus(false);
		} else {
			this.resumeStatus(false);
		}
	}

	recordToolStart(id: string, name: string, args: unknown): void {
		this.toolCalls++;
		const summary = summarizeToolArgs(args);
		this.activeTools.set(id, { id, name, summary, startedAt: Date.now() });
		this.setStatus("TOOL", name);
		this.log("TOOL", `${name}${summary ? ` · ${summary}` : ""}`, "accent");
	}

	recordToolEnd(id: string, name: string, isError: boolean, durationMs: number | undefined): void {
		this.activeTools.delete(id);
		const stat = this.toolStats.get(name) ?? {
			name,
			calls: 0,
			errors: 0,
			totalMs: 0,
			lastMs: undefined,
			avgMs: 0,
		};
		const elapsed = Math.max(0, durationMs ?? 0);
		stat.calls++;
		stat.totalMs += elapsed;
		stat.lastMs = durationMs;
		stat.avgMs = stat.totalMs / stat.calls;
		if (isError) {
			stat.errors++;
			this.toolFailures++;
		}
		this.toolStats.set(name, stat);

		const active = [...this.activeTools.values()][0];
		if (active) {
			this.setStatus("TOOL", active.name);
		} else {
			this.setStatus("THINKING");
		}

		this.log(
			isError ? "ERR" : "DONE",
			`${name} ${isError ? "failed" : "complete"} · ${fmtDuration(elapsed)}`,
			isError ? "error" : "success",
		);
	}

	noteHttp(status: number): void {
		this.lastHttpStatus = status;
		if (status >= 400) {
			this.log("HTTP", `provider responded ${status}`, status >= 500 ? "error" : "warning");
		}
	}

	noteCompaction(tokensBefore: number | undefined, detail?: string): void {
		this.setStatus("COMPACT");
		this.log(
			"CTX",
			`compaction ${detail ?? "engaged"}${tokensBefore ? ` · ${fmtCount(tokensBefore)} tokens before` : ""}`,
			"warning",
		);
	}

	noteCompactionFailed(message: string | undefined): void {
		this.setStatus("ERROR", message ?? "compaction failed");
		this.log("ERROR", message ?? "compaction failed", "error");
	}

	settle(aborted: boolean): void {
		if (aborted) {
			this.log("ABORT", "mission aborted by operator", "warning");
		}
		if (this.status !== "ERROR") this.setStatus("NOMINAL");
	}

	tick(): void {
		const now = Date.now();
		this.context = this.providers.contextUsage() ?? this.context;

		if (now - this.lastToolsRefresh > 5_000) {
			this.refreshTools();
		}

		if (now - this.lastSampleAt >= 450) {
			const elapsedSeconds = Math.max(0.001, (now - this.lastSampleAt) / 1_000);
			const deltaChars = Math.max(0, this.streamChars - this.lastSampleChars);
			const instant = deltaChars > 0 ? deltaChars / 4 / elapsedSeconds : 0;
			this.rate = instant > 0 ? this.rate * 0.35 + instant * 0.65 : this.rate * 0.5;
			if (this.rate < 0.1) this.rate = 0;
			this.peakRate = Math.max(this.peakRate, this.rate);
			this.flux.push(this.rate);
			if (this.flux.length > MAX_FLUX_SAMPLES) this.flux.shift();
			this.lastSampleAt = now;
			this.lastSampleChars = this.streamChars;
		}
	}

	snapshot(): CockpitSnapshot {
		const now = Date.now();
		const liveOutput = this.status === "STREAMING" ? (this.streamChars - this.messageStartChars) / 4 : 0;
		const toolStats = [...this.toolStats.values()].map((stat) => ({ ...stat }));
		toolStats.sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));

		return {
			status: this.status,
			statusDetail: this.statusDetail,
			elapsedMs: now - this.sessionStartedAt,
			uptimeMs: now - this.startedAt,
			model: this.model,
			thinking: this.thinking,
			context: this.context,
			usage: {
				...this.usage,
				output: this.usage.output + Math.round(liveOutput),
				liveOutput,
			},
			rate: this.rate,
			peakRate: this.peakRate,
			flux: [...this.flux],
			log: this.logEntries,
			activeTools: [...this.activeTools.values()],
			toolStats,
			tools: this.tools,
			activeToolNames: this.activeToolNames,
			prompts: this.prompts,
			turns: this.turns,
			assistantMessages: this.assistantMessages,
			toolCalls: this.toolCalls,
			toolFailures: this.toolFailures,
			lastHttpStatus: this.lastHttpStatus,
			session: { ...this.session },
		};
	}
}
