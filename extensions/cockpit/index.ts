import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import {
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { fmtCost, fmtCount, fmtPercent, plainText, statusGlyph, statusTone } from "./paint.ts";
import { CockpitHud } from "./hud.ts";
import { CockpitOverlay, type CockpitOverlayControls } from "./overlay.ts";
import { TelemetryStore } from "./telemetry.ts";

const HUD_KEY = "pi-cockpit-hud";
const STATUS_KEY = "pi-cockpit";
const STATE_ENTRY = "pi-cockpit-state";

interface CockpitPersistedState {
	hud?: boolean;
}

function sessionMeta(ctx: ExtensionContext) {
	return {
		cwd: ctx.cwd,
		name: ctx.sessionManager.getSessionName(),
		id: ctx.sessionManager.getSessionId(),
		file: ctx.sessionManager.getSessionFile(),
	};
}

function readHudPreference(ctx: ExtensionContext): boolean | undefined {
	let preference: boolean | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom" && entry.customType === STATE_ENTRY) {
			const data = entry.data as Partial<CockpitPersistedState> | undefined;
			if (data && typeof data.hud === "boolean") preference = data.hud;
		}
	}
	return preference;
}

export default function cockpitExtension(pi: ExtensionAPI) {
	let ctxRef: ExtensionContext | undefined;
	let hudEnabled = true;
	let overlayOpen = false;
	let suppressPromptEnd = false;
	let booted = false;
	let lastStatusAt = 0;

	const telemetry = new TelemetryStore({
		contextUsage: () => ctxRef?.getContextUsage(),
		tools: () => ({ active: pi.getActiveTools(), all: pi.getAllTools() }),
	});

	function refreshStatus(ctx: ExtensionContext, force = false): void {
		if (!ctx.hasUI) return;
		const now = Date.now();
		if (!force && now - lastStatusAt < 800) return;
		lastStatusAt = now;

		const snapshot = telemetry.snapshot();
		const theme = ctx.ui.theme;
		const tone = statusTone(snapshot.status);
		const glyph = statusGlyph(snapshot.status, Math.floor(now / 400));
		const percent = snapshot.context?.percent;
		const context = percent === null || percent === undefined ? "" : ` ${fmtPercent(percent)}`;
		ctx.ui.setStatus(
			STATUS_KEY,
			`${theme.fg(tone, glyph)} ${theme.fg("dim", "COCKPIT")} ${theme.fg(tone, snapshot.status)}${theme.fg(
				"dim",
				context,
			)}`,
		);
	}

	function mountHud(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui") return;
		ctx.ui.setWidget(HUD_KEY, (tui, theme) => new CockpitHud(tui, theme, telemetry), {
			placement: "aboveEditor",
		});
	}

	function unmountHud(ctx: ExtensionContext): void {
		if (ctx.mode === "tui") ctx.ui.setWidget(HUD_KEY, undefined);
	}

	function toggleHud(ctx: ExtensionContext): boolean {
		hudEnabled = !hudEnabled;
		pi.appendEntry(STATE_ENTRY, { hud: hudEnabled } satisfies CockpitPersistedState);
		if (hudEnabled) {
			mountHud(ctx);
		} else {
			unmountHud(ctx);
		}
		telemetry.log("SYS", `hud ${hudEnabled ? "online" : "offline"}`, "accent");
		refreshStatus(ctx, true);
		return hudEnabled;
	}

	async function refreshGit(ctx: ExtensionContext): Promise<void> {
		try {
			const result = await pi.exec("git", ["branch", "--show-current"], { cwd: ctx.cwd, timeout: 2_000 });
			if (result.code === 0) {
				telemetry.setGitBranch(result.stdout.trim() || "detached");
			} else {
				telemetry.setGitBranch(undefined);
			}
		} catch {
			telemetry.setGitBranch(undefined);
		}
	}

	async function openCockpit(ctx: ExtensionContext): Promise<void> {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("The Cockpit flight deck needs interactive mode. Try /cockpit status instead.", "warning");
			return;
		}
		if (overlayOpen) return;
		overlayOpen = true;

		const controls: CockpitOverlayControls = {
			getSnapshot: () => telemetry.snapshot(),
			tick: () => telemetry.tick(),
			clearLog: () => telemetry.clearLog(),
			toggleHud: () => toggleHud(ctx),
		};

		try {
			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) => {
					return new CockpitOverlay(tui, theme, controls, !booted, () => {
						booted = true;
						done(undefined);
					});
				},
				{
					overlay: true,
					overlayOptions: {
						width: "92%",
						maxHeight: "92%",
						anchor: "center",
						margin: 1,
					},
				},
			);
		} finally {
			overlayOpen = false;
		}
	}

	// ---------------------------------------------------------------------
	// Session lifecycle
	// ---------------------------------------------------------------------

	pi.on("session_start", async (event, ctx) => {
		ctxRef = ctx;
		suppressPromptEnd = false;
		telemetry.beginSession(sessionMeta(ctx), event.reason);
		telemetry.recompute(ctx.sessionManager.getBranch());
		telemetry.setModel(ctx.model);
		telemetry.setThinking(ctx.thinkingLevel ?? pi.getThinkingLevel());

		const storedHud = readHudPreference(ctx);
		if (storedHud !== undefined) hudEnabled = storedHud;

		if (hudEnabled) {
			mountHud(ctx);
		} else {
			unmountHud(ctx);
		}

		telemetry.log(
			"SYS",
			`${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no model"} · thinking ${ctx.thinkingLevel ?? pi.getThinkingLevel()}`,
			"muted",
		);
		telemetry.tick();
		refreshStatus(ctx, true);
		void refreshGit(ctx);
	});

	pi.on("session_info_changed", async (event, ctx) => {
		telemetry.setSessionName(event.name);
		refreshStatus(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		telemetry.recompute(ctx.sessionManager.getBranch());
		telemetry.log("SYS", "branch navigation · telemetry rebuilt", "warning");
		refreshStatus(ctx, true);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		suppressPromptEnd = false;
		telemetry.setStatus("STANDBY");
		unmountHud(ctx);
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	// ---------------------------------------------------------------------
	// Agent, message and tool telemetry
	// ---------------------------------------------------------------------

	pi.on("model_select", async (event, ctx) => {
		telemetry.setModel(event.model);
		telemetry.log("MODEL", `locked onto ${event.model.provider}/${event.model.id}`, "accent");
		refreshStatus(ctx, true);
	});

	pi.on("thinking_level_select", async (event, ctx) => {
		telemetry.setThinking(event.level);
		telemetry.log("SYS", `thinking level ${event.level}`, "muted");
		refreshStatus(ctx);
	});

	pi.on("agent_start", async (_event, ctx) => {
		telemetry.setStatus("IGNITION");
		telemetry.log("SYS", "ignition sequence", "accent");
		refreshStatus(ctx, true);
	});

	pi.on("turn_start", async (event, ctx) => {
		telemetry.noteTurn(event.turnIndex);
		refreshStatus(ctx);
	});

	pi.on("message_start", async (event, ctx) => {
		if (event.message.role === "user") {
			telemetry.notePrompt(plainText(event.message.content));
		} else if (event.message.role === "assistant") {
			telemetry.beginAssistant();
		}
		refreshStatus(ctx);
	});

	pi.on("message_update", async (event, ctx) => {
		const streamEvent = event.assistantMessageEvent;
		if (
			streamEvent.type === "text_delta" ||
			streamEvent.type === "thinking_delta" ||
			streamEvent.type === "toolcall_delta"
		) {
			telemetry.addStreamChars(streamEvent.delta.length);
		}
		refreshStatus(ctx);
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role === "assistant") {
			telemetry.recordAssistant(event.message as AssistantMessage);
		}
		refreshStatus(ctx);
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		telemetry.recordToolStart(event.toolCallId, event.toolName, event.args);
		refreshStatus(ctx, true);
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		telemetry.recordToolEnd(event.toolCallId, event.toolName, event.isError, event.durationMs);
		refreshStatus(ctx, true);
	});

	pi.on("agent_end", async (_event, ctx) => {
		telemetry.log("LOOP", "agent loop complete", "muted");
		refreshStatus(ctx);
	});

	pi.on("agent_settled", async (event, ctx) => {
		telemetry.settle(event.aborted);
		telemetry.log("SYS", event.aborted ? "mission aborted" : "systems nominal", event.aborted ? "warning" : "success");
		refreshStatus(ctx, true);
	});

	pi.on("ui_prompt_start", async (event, ctx) => {
		// The flight deck itself is a custom prompt; keep showing the real flight state.
		if (overlayOpen) {
			suppressPromptEnd = true;
			return;
		}
		telemetry.setStatus("AWAIT", event.kind);
		refreshStatus(ctx, true);
	});

	pi.on("ui_prompt_end", async (_event, ctx) => {
		if (suppressPromptEnd) {
			suppressPromptEnd = false;
			return;
		}
		telemetry.resumeStatus(ctx.isIdle());
		refreshStatus(ctx, true);
	});

	pi.on("after_provider_response", async (event, ctx) => {
		telemetry.noteHttp(event.status);
		refreshStatus(ctx);
	});

	pi.on("session_before_compact", async (event, ctx) => {
		telemetry.noteCompaction(event.preparation.tokensBefore, event.reason);
		refreshStatus(ctx, true);
	});

	pi.on("session_compact", async (event, ctx) => {
		telemetry.log(
			"CTX",
			`compaction complete${event.compactionEntry.tokensBefore ? ` · ${fmtCount(event.compactionEntry.tokensBefore)} tokens before` : ""}`,
			"success",
		);
		telemetry.resumeStatus(ctx.isIdle());
		refreshStatus(ctx, true);
	});

	pi.on("session_compact_failed", async (event, ctx) => {
		if (event.aborted) {
			telemetry.log("CTX", "compaction aborted", "warning");
			telemetry.resumeStatus(ctx.isIdle());
		} else {
			telemetry.noteCompactionFailed(event.errorMessage);
		}
		refreshStatus(ctx, true);
	});

	// ---------------------------------------------------------------------
	// Commands, shortcut and model-facing telemetry tool
	// ---------------------------------------------------------------------

	pi.registerCommand("cockpit", {
		description: "Open the Pi Cockpit flight deck. Manage the HUD with /cockpit hud on|off|toggle.",
		getArgumentCompletions: (prefix) => {
			const options = ["hud on", "hud off", "hud toggle", "status", "clear", "open"];
			const filtered = options.filter((option) => option.startsWith(prefix));
			return filtered.length > 0 ? filtered.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx: ExtensionCommandContext) => {
			const tokens = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
			const command = tokens[0];

			if (!command || command === "open") {
				await openCockpit(ctx);
				return;
			}

			if (command === "hud") {
				const mode = tokens[1] ?? "toggle";
				if (mode !== "on" && mode !== "off" && mode !== "toggle") {
					ctx.ui.notify("Usage: /cockpit hud [on|off|toggle]", "warning");
					return;
				}
				const shouldToggle = mode === "toggle" || (mode === "on" && !hudEnabled) || (mode === "off" && hudEnabled);
				if (shouldToggle) toggleHud(ctx);
				ctx.ui.notify(`Cockpit HUD ${hudEnabled ? "online" : "offline"}`, "info");
				return;
			}

			if (command === "status") {
				const snapshot = telemetry.snapshot();
				const percent = snapshot.context?.percent;
				ctx.ui.notify(
					`COCKPIT ${snapshot.status} · ${snapshot.model?.id ?? "no model"} · ctx ${fmtPercent(
						percent,
					)} · ${snapshot.turns} turns · ${snapshot.toolCalls} tools · ${fmtCost(snapshot.usage.cost)}`,
					"info",
				);
				return;
			}

			if (command === "clear") {
				telemetry.clearLog();
				ctx.ui.notify("Cockpit flight log cleared", "info");
				return;
			}

			if (command === "off") {
				if (hudEnabled) toggleHud(ctx);
				ctx.ui.notify("Cockpit HUD offline", "info");
				return;
			}

			ctx.ui.notify("Usage: /cockpit [open] | hud on|off|toggle | status | clear", "warning");
		},
	});

	pi.registerShortcut(Key.ctrlShift("k"), {
		description: "Open the Pi Cockpit flight deck",
		handler: async (ctx) => {
			await openCockpit(ctx);
		},
	});

	pi.registerTool(
		defineTool({
			name: "cockpit_status",
			label: "Cockpit Telemetry",
			description:
				"Read Pi Cockpit telemetry for this session: flight status, model, thinking level, context usage, token totals, throughput, tool statistics, and recent flight-log events.",
			promptSnippet: "Read cockpit telemetry for the current session",
			parameters: Type.Object({}),
			exposure: "codemode",
			annotations: { readOnlyHint: true, openWorldHint: false },
			async execute() {
				telemetry.tick();
				const snapshot = telemetry.snapshot();
				const payload = {
					status: snapshot.status,
					model: snapshot.model,
					thinking: snapshot.thinking,
					context: snapshot.context,
					usage: snapshot.usage,
					throughput: { current: snapshot.rate, peak: snapshot.peakRate },
					uptimeMs: snapshot.uptimeMs,
					lastHttpStatus: snapshot.lastHttpStatus,
					session: {
						name: snapshot.session.name,
						cwd: snapshot.session.cwd,
						gitBranch: snapshot.session.gitBranch,
						elapsedMs: snapshot.elapsedMs,
					},
					counts: {
						turns: snapshot.turns,
						prompts: snapshot.prompts,
						responses: snapshot.assistantMessages,
						toolCalls: snapshot.toolCalls,
						toolFailures: snapshot.toolFailures,
					},
					activeTools: snapshot.activeTools,
					toolStats: snapshot.toolStats,
					recentEvents: snapshot.log.slice(-12),
				};
				return {
					content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
					details: undefined,
				};
			},
		}),
	);
}
