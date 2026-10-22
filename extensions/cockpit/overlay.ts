import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { Key, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import {
	bar,
	center,
	cockpitLogo,
	cols,
	fit,
	fmtClock,
	fmtCost,
	fmtCount,
	fmtDuration,
	fmtPercent,
	fmtRate,
	fmtTime,
	hjoin,
	labelValue,
	padLeft,
	panel,
	rule,
	shorten,
	shortenPath,
	sparkline,
	statusGlyph,
	statusLabel,
	statusTone,
} from "./paint.ts";
import type { CockpitSnapshot, FlightLogEntry } from "./types.ts";

export interface CockpitOverlayControls {
	getSnapshot(): CockpitSnapshot;
	tick(): void;
	clearLog(): void;
	toggleHud(): boolean;
}

type Tab = "log" | "tools" | "help";

const TAB_ORDER: Tab[] = ["log", "tools", "help"];
const TAB_LABELS: Record<Tab, string> = {
	log: "FLIGHT LOG",
	tools: "TOOL MANIFEST",
	help: "CONTROL KEYS",
};
const BOOT_MS = 1_100;
const FRAME_INTERVAL_MS = 140;

function outerFrame(width: number, lines: string[], theme: Theme): string[] {
	const w = Math.max(1, width);
	if (w < 8) return lines.map((line) => fit(line, w));

	const labelText = shorten(" ◈ COCKPIT // FLIGHT DECK ", Math.max(1, w - 6));
	const label = theme.style(labelText, { fg: "accent", bold: true });
	const fill = Math.max(0, w - 3 - visibleWidth(label));
	const top =
		theme.fg("border", "╔═") + label + theme.fg("border", `${"═".repeat(fill)}╗`);
	const body = lines.map(
		(line) => `${theme.fg("border", "║")} ${fit(line, w - 4)} ${theme.fg("border", "║")}`,
	);
	const bottom = theme.fg("border", `╚${"═".repeat(Math.max(0, w - 2))}╝`);
	return [fit(top, w), ...body, fit(bottom, w)];
}

function logRow(entry: FlightLogEntry, width: number, theme: Theme): string {
	const time = theme.fg("dim", fmtTime(entry.at));
	const kind = theme.fg(entry.tone, entry.kind.padEnd(6));
	const text = theme.fg(entry.tone === "error" ? "error" : "text", shorten(entry.text, Math.max(1, width - 16)));
	return `${time} ${kind} ${text}`;
}

function tabBar(width: number, active: Tab, theme: Theme, scroll: number): string {
	const chips = TAB_ORDER.map((tab) => {
		const label = ` ${TAB_LABELS[tab]} `;
		return tab === active
			? theme.style(label, { fg: "text", bg: "selectedBg", bold: true })
			: theme.fg("muted", label);
	}).join(" ");
	const scrollHint = scroll > 0 ? `scroll ${scroll} · ` : "";
	const hint = theme.fg("dim", `${scrollHint}q close · tab next · h hud`);
	return cols(width, chips, "", hint);
}

function coreRows(snapshot: CockpitSnapshot, width: number, theme: Theme): string[] {
	const model = snapshot.model;
	const session = snapshot.session.name ?? snapshot.session.id?.slice(0, 8) ?? "ephemeral";
	const git = snapshot.session.gitBranch ?? "—";
	return [
		labelValue(theme, "MODEL", model?.id ?? "no model", width),
		labelValue(theme, "PROVIDER", model?.provider ?? "—", width),
		labelValue(theme, "THINKING", snapshot.thinking.toUpperCase(), width),
		labelValue(theme, "SESSION", session, width),
		labelValue(theme, "CWD", shortenPath(snapshot.session.cwd, Math.max(4, width - 9)), width),
		labelValue(theme, "GIT", `${git} · ${snapshot.turns} turns · ${snapshot.prompts} prompts`, width),
	];
}

function fluxRows(snapshot: CockpitSnapshot, width: number, theme: Theme): string[] {
	const percent = snapshot.context?.percent;
	const ratio = percent === null || percent === undefined ? 0 : percent / 100;
	const percentText = fmtPercent(percent);
	const gaugeWidth = Math.max(4, Math.min(18, width - 18));
	const usage = snapshot.usage;
	const sparkWidth = Math.max(6, Math.min(40, width - 7));

	return [
		`${theme.fg("dim", "CTX ")}${bar(theme, ratio, gaugeWidth)} ${theme.fg(
			percent !== null && percent !== undefined && percent > 85 ? "warning" : "muted",
			percentText,
		)}`,
		cols(
			width,
			theme.fg("dim", `IN  ${fmtCount(usage.input)}`),
			"",
			theme.fg("dim", `OUT ${fmtCount(usage.output)}`),
		),
		cols(
			width,
			theme.fg("dim", `CACHE ${fmtCount(usage.cacheRead)} read`),
			"",
			theme.fg("dim", `${fmtCount(usage.cacheWrite)} write`),
		),
		cols(
			width,
			theme.fg("dim", "COST"),
			"",
			theme.fg("accent", fmtCost(usage.cost)),
		),
		cols(
			width,
			theme.fg("dim", `RATE ${fmtRate(snapshot.rate)} tok/s`),
			"",
			theme.fg("dim", `PEAK ${fmtRate(snapshot.peakRate)}`),
		),
		`${theme.fg("dim", "FLUX ")}${sparkline(theme, snapshot.flux, sparkWidth)}`,
	];
}

function compactRows(snapshot: CockpitSnapshot, width: number, theme: Theme): string[] {
	const percent = snapshot.context?.percent;
	const ratio = percent === null || percent === undefined ? 0 : percent / 100;
	const percentText = fmtPercent(percent);
	const gaugeWidth = Math.max(4, Math.min(20, width - 18));
	const model = snapshot.model?.id ?? "no model";
	return [
		labelValue(theme, "MODEL", model, width),
		labelValue(theme, "THINKING", `${snapshot.thinking.toUpperCase()} · ${snapshot.status}`, width),
		`${theme.fg("dim", "CTX ")}${bar(theme, ratio, gaugeWidth)} ${theme.fg("muted", percentText)}`,
		cols(
			width,
			theme.fg("dim", `IN ${fmtCount(snapshot.usage.input)}`),
			"",
			theme.fg("dim", `OUT ${fmtCount(snapshot.usage.output)} · ${fmtCost(snapshot.usage.cost)}`),
		),
		cols(
			width,
			theme.fg("dim", `RATE ${fmtRate(snapshot.rate)} tok/s`),
			"",
			theme.fg("dim", `${snapshot.turns}t ${snapshot.toolCalls}tools`),
		),
		`${theme.fg("dim", "FLUX ")}${sparkline(theme, snapshot.flux, Math.max(6, Math.min(40, width - 7)))}`,
	];
}

function toolRows(snapshot: CockpitSnapshot, width: number, rows: number, theme: Theme): string[] {
	const stats = new Map(snapshot.toolStats.map((stat) => [stat.name, stat]));
	const active = new Set(snapshot.activeToolNames);
	const tools = [...snapshot.tools].sort((a, b) => {
		const activeDelta = Number(b.active) - Number(a.active);
		if (activeDelta !== 0) return activeDelta;
		const aCalls = stats.get(a.name)?.calls ?? 0;
		const bCalls = stats.get(b.name)?.calls ?? 0;
		return bCalls - aCalls || a.name.localeCompare(b.name);
	});

	if (tools.length === 0) {
		return Array.from({ length: rows }, (_, index) =>
			index === 0 ? theme.fg("dim", "no tools registered") : "",
		);
	}

	const overflow = tools.length > rows;
	const visible = tools.slice(0, overflow ? Math.max(0, rows - 1) : rows);
	const nameWidth = Math.max(12, Math.min(34, Math.floor(width * 0.42)));
	const exposureWidth = Math.max(8, Math.min(12, Math.floor(width * 0.16)));
	const statsWidth = Math.max(8, width - nameWidth - exposureWidth - 2);
	const lines = visible.map((tool) => {
		const stat = stats.get(tool.name);
		const glyph = tool.active
			? theme.fg("success", "◉")
			: active.has(tool.name)
				? theme.fg("accent", "◉")
				: theme.fg("dim", "○");
		const calls = stat ? `${stat.calls}x` : "—";
		const average = stat && stat.calls > 0 ? fmtDuration(stat.avgMs) : "";
		const errors = stat && stat.errors > 0 ? theme.fg("error", ` ${stat.errors}!`) : "";
		return (
			fit(`${glyph} ${shorten(tool.name, nameWidth - 2)}`, nameWidth) +
			" " +
			fit(theme.fg("dim", tool.exposure), exposureWidth) +
			" " +
			padLeft(`${calls} ${average}${errors}`, statsWidth)
		);
	});
	if (overflow) {
		lines.push(theme.fg("dim", `+${tools.length - visible.length} more tools · use /tools to inspect`));
	}
	while (lines.length < rows) lines.push("");
	return lines.slice(0, rows);
}

function helpRows(width: number, theme: Theme): string[] {
	const keys: Array<[string, string]> = [
		["q / esc", "close flight deck"],
		["tab / shift+tab", "cycle panel"],
		["1 / 2 / 3", "jump to panel"],
		["↑ / ↓", "scroll flight log"],
		["c", "clear flight log"],
		["h", "toggle HUD (live)"],
		["/cockpit hud off", "disable HUD for this session"],
	];
	const keyWidth = Math.max(10, Math.min(20, Math.floor(width * 0.3)));
	return keys.map(([key, description]) =>
		fit(theme.fg("accent", key), keyWidth) + fit(theme.fg("text", description), Math.max(0, width - keyWidth)),
	);
}

function renderLog(snapshot: CockpitSnapshot, width: number, rows: number, scroll: number, theme: Theme): string[] {
	const entries = snapshot.log;
	if (entries.length === 0) {
		return Array.from({ length: rows }, (_, index) =>
			index === 0 ? theme.fg("dim", "flight log empty") : "",
		);
	}
	const end = Math.max(0, entries.length - scroll);
	const start = Math.max(0, end - rows);
	const visible = entries.slice(start, end);
	const lines = visible.map((entry) => logRow(entry, width, theme));
	while (lines.length < rows) lines.push("");
	return lines;
}

/** Full-screen, tabbed telemetry flight deck. */
export class CockpitOverlay implements Component {
	private readonly timer: ReturnType<typeof setInterval>;
	private readonly bootStartedAt = Date.now();
	private bootDone: boolean;
	private frame = 0;
	private tab: Tab = "log";
	private scroll = 0;
	private disposed = false;
	private closed = false;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly controls: CockpitOverlayControls,
		showBoot: boolean,
		private readonly onClose: () => void,
	) {
		this.bootDone = !showBoot;
		this.timer = setInterval(() => {
			if (this.disposed) return;
			this.frame++;
			this.controls.tick();
			this.tui.requestRender();
		}, FRAME_INTERVAL_MS);
	}

	handleInput(data: string): void {
		if (!this.bootDone) {
			this.bootDone = true;
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, Key.escape) || data === "q" || data === "Q") {
			this.close();
			return;
		}
		if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
			this.cycleTab(1);
			return;
		}
		if (matchesKey(data, "shift+tab") || matchesKey(data, Key.left)) {
			this.cycleTab(-1);
			return;
		}
		if (data === "1" || data === "2" || data === "3") {
			this.tab = TAB_ORDER[Number(data) - 1]!;
			this.scroll = 0;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.scroll = Math.min(this.maxScroll(), this.scroll + 1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.scroll = Math.max(0, this.scroll - 1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.pageUp)) {
			this.scroll = Math.min(this.maxScroll(), this.scroll + 5);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.pageDown)) {
			this.scroll = Math.max(0, this.scroll - 5);
			this.tui.requestRender();
			return;
		}
		if (data === "c" || data === "C") {
			this.controls.clearLog();
			this.scroll = 0;
			this.tui.requestRender();
			return;
		}
		if (data === "h" || data === "H") {
			this.controls.toggleHud();
			this.tui.requestRender();
		}
	}

	render(width: number): string[] {
		this.controls.tick();
		const rows = process.stdout.rows ?? 32;
		const maxLines = Math.max(10, Math.floor(rows * 0.92));
		if (!this.bootDone && Date.now() - this.bootStartedAt >= BOOT_MS) {
			this.bootDone = true;
		}
		const snapshot = this.controls.getSnapshot();
		if (!this.bootDone) return this.renderBoot(width, snapshot, maxLines);
		return this.renderDeck(width, snapshot, maxLines);
	}

	invalidate(): void {
		// Rendering is derived from live telemetry.
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		clearInterval(this.timer);
	}

	private close(): void {
		if (this.closed) return;
		this.closed = true;
		this.dispose();
		this.onClose();
	}

	private cycleTab(direction: number): void {
		const index = TAB_ORDER.indexOf(this.tab);
		this.tab = TAB_ORDER[(index + direction + TAB_ORDER.length) % TAB_ORDER.length]!;
		this.scroll = 0;
		this.tui.requestRender();
	}

	private maxScroll(): number {
		return Math.max(0, this.controls.getSnapshot().log.length - 1);
	}

	private renderDeck(width: number, snapshot: CockpitSnapshot, maxLines: number): string[] {
		if (maxLines < 14) return this.renderMinimalDeck(width, snapshot);
		if (width < 24) {
			const tone = statusTone(snapshot.status);
			return [
				fit(this.theme.fg("accent", "π // COCKPIT"), width),
				fit(this.theme.fg(tone, `${statusGlyph(snapshot.status, this.frame)} ${snapshot.status}`), width),
				fit(`${fmtClock(snapshot.elapsedMs, true)} · ${snapshot.model?.id ?? "no model"}`, width),
			];
		}

		const inner = width - 4;
		const wide = inner >= 68;
		const tone = statusTone(snapshot.status);
		const glyph = statusGlyph(snapshot.status, this.frame);

		const topSection = wide
			? (() => {
					const gap = 2;
					const leftWidth = Math.floor((inner - gap) * 0.47);
					const rightWidth = inner - gap - leftWidth;
					return hjoin(
						panel(this.theme, leftWidth, "CORE", coreRows(snapshot, leftWidth - 4, this.theme)),
						panel(this.theme, rightWidth, "TOKEN FLUX", fluxRows(snapshot, rightWidth - 4, this.theme)),
						gap,
					);
				})()
			: panel(this.theme, inner, "CORE // FLUX", compactRows(snapshot, inner - 4, this.theme));

		const header = cols(
			inner,
			this.theme.fg(tone, `${glyph} ${statusLabel(snapshot.status, snapshot.statusDetail)}`),
			cockpitLogo(this.theme),
			this.theme.fg("dim", `T+${fmtClock(snapshot.elapsedMs, true)}`),
		);

		if (maxLines < 19) {
			return outerFrame(
				width,
				[header, rule(this.theme, inner), ...topSection, "", tabBar(inner, this.tab, this.theme, this.scroll)],
				this.theme,
			);
		}

		const bottomRows = Math.max(3, Math.min(10, maxLines - 16));
		const bodyWidth = inner - 4;
		let tabContent: string[];
		if (this.tab === "log") {
			tabContent = renderLog(snapshot, bodyWidth, bottomRows, this.scroll, this.theme);
		} else if (this.tab === "tools") {
			tabContent = toolRows(snapshot, bodyWidth, bottomRows, this.theme);
		} else {
			tabContent = helpRows(bodyWidth, this.theme).slice(0, bottomRows);
			while (tabContent.length < bottomRows) tabContent.push("");
		}

		const bottomPanel = panel(this.theme, inner, TAB_LABELS[this.tab], tabContent, tone);
		const content = [
			header,
			rule(this.theme, inner),
			...topSection,
			"",
			...bottomPanel,
			tabBar(inner, this.tab, this.theme, this.scroll),
		];
		return outerFrame(width, content, this.theme);
	}

	private renderMinimalDeck(width: number, snapshot: CockpitSnapshot): string[] {
		const inner = width - 4;
		const tone = statusTone(snapshot.status);
		const percent = snapshot.context?.percent;
		const ratio = percent === null || percent === undefined ? 0 : percent / 100;
		const gauge = bar(this.theme, ratio, Math.max(4, Math.min(16, inner - 12)));
		const lines = [
			cols(
				inner,
				this.theme.fg(tone, `${statusGlyph(snapshot.status, this.frame)} ${snapshot.status}`),
				"",
				this.theme.fg("dim", `T+${fmtClock(snapshot.elapsedMs)}`),
			),
			`${this.theme.fg("dim", "MODEL")} ${shorten(snapshot.model?.id ?? "no model", Math.max(4, inner - 6))}`,
			`${this.theme.fg("dim", "CTX  ")} ${gauge} ${this.theme.fg("muted", fmtPercent(percent))}`,
			`${this.theme.fg("dim", "TOK  ")} ${fmtCount(snapshot.usage.input)} in · ${fmtCount(snapshot.usage.output)} out · ${fmtCost(snapshot.usage.cost)}`,
			this.theme.fg("dim", "q close · tab next · h hud"),
		];
		return outerFrame(width, lines, this.theme);
	}

	private renderBoot(width: number, snapshot: CockpitSnapshot, maxLines: number): string[] {
		const inner = width - 4;
		const elapsed = Date.now() - this.bootStartedAt;
		const progress = Math.min(1, Math.max(0, elapsed / BOOT_MS));
		const steps = [
			"MOUNTING TELEMETRY BUS",
			"SYNCING SESSION STATE",
			"CALIBRATING TOKEN REACTOR",
			"RAISING FLIGHT DECK",
		];
		const stepLines = steps.map((step, index) => {
			const threshold = (index + 1) / steps.length;
			const started = progress > index / steps.length;
			const done = progress >= threshold;
			const marker = done ? "✓" : started ? "▸" : "·";
			const tone = done ? "success" : started ? "accent" : "dim";
			return center(this.theme.fg(tone, `${marker} ${step}`), inner);
		});

		const gaugeWidth = Math.max(10, Math.min(34, Math.floor(inner * 0.46)));
		const gauge = `${bar(this.theme, progress, gaugeWidth)} ${String(Math.round(progress * 100)).padStart(3, " ")}%`;
		const footer = center(this.theme.fg("dim", "press any key to skip"), inner);
		const lines = [
			center(cockpitLogo(this.theme), inner),
			center(this.theme.fg("dim", "FLIGHT DECK INITIALIZATION"), inner),
			"",
			center(gauge, inner),
			"",
			...stepLines,
		];

		if (maxLines < 14) {
			return outerFrame(
				width,
				[
					center(cockpitLogo(this.theme), inner),
					center(this.theme.fg("dim", "BOOTING FLIGHT DECK"), inner),
					center(gauge, inner),
					"",
					center(this.theme.fg("dim", "press any key to skip"), inner),
				],
				this.theme,
			);
		}

		const available = Math.max(lines.length + 2, maxLines - 2);
		const extra = Math.max(0, available - lines.length - 2);
		const topPad = Math.floor(extra / 2);
		const bottomPad = extra - topPad;
		return outerFrame(
			width,
			[...Array(topPad).fill(""), ...lines, ...Array(bottomPad).fill(""), footer],
			this.theme,
		);
	}
}

