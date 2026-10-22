import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	bar,
	cols,
	fit,
	fmtClock,
	fmtCost,
	fmtCount,
	fmtDuration,
	fmtPercent,
	fmtRate,
	shorten,
	sparkline,
	statusGlyph,
	statusLabel,
	statusTone,
} from "./paint.ts";
import type { CockpitSnapshot } from "./types.ts";
import type { TelemetryStore } from "./telemetry.ts";

const FRAME_INTERVAL_MS = 140;

export function renderHud(width: number, snapshot: CockpitSnapshot, theme: Theme, frame: number): string[] {
	if (width < 16) {
		const tone = statusTone(snapshot.status);
		return [
			fit(
				theme.fg("accent", "π") +
					" " +
					theme.fg(tone, statusLabel(snapshot.status, snapshot.statusDetail)) +
					" " +
					theme.fg("dim", `${fmtClock(snapshot.elapsedMs)}`),
				width,
			),
		];
	}

	const border = theme.fg("borderMuted", "│");
	const body = (text: string): string => `${border} ${fit(text, width - 4)} ${border}`;
	const tone = statusTone(snapshot.status);
	const glyph = statusGlyph(snapshot.status, frame);
	const label = statusLabel(snapshot.status, snapshot.statusDetail);

	const title = theme.style("π COCKPIT", { fg: "accent", bold: true });
	let statusText = theme.fg(tone, `${glyph} ${label}`);
	statusText = shorten(statusText, Math.max(8, width - 14));

	const topLeft = theme.fg("borderMuted", "─ ") + title + " ";
	const topRight = " " + statusText + theme.fg("borderMuted", " ─");
	let fill = width - 2 - visibleWidth(topLeft) - visibleWidth(topRight);
	let top: string;
	if (fill >= 0) {
		top = theme.fg("borderMuted", "╭") + topLeft + theme.fg("borderMuted", "─".repeat(fill)) + topRight + theme.fg("borderMuted", "╮");
	} else {
		top = theme.fg("borderMuted", `╭${"─".repeat(Math.max(0, width - 2))}╮`);
	}

	const inner = Math.max(1, width - 4);
	const now = Date.now();
	const model = snapshot.model ? `${snapshot.model.id}` : "no model";
	const thinking = snapshot.model?.reasoning ? ` · ${snapshot.thinking}` : "";
	const modelText = theme.fg("muted", shorten(`${model}${thinking}`, Math.max(10, Math.floor(inner * 0.45))));

	const line1 = cols(
		inner,
		`${theme.fg("dim", "MODE")} ${theme.fg("accent", snapshot.thinking.toUpperCase())}`,
		theme.fg("dim", `T+${fmtClock(snapshot.elapsedMs)}`),
		modelText,
	);

	const percent = snapshot.context?.percent;
	const ratio = percent === null || percent === undefined ? 0 : percent / 100;
	const percentText = fmtPercent(percent);
	const gaugeWidth = Math.max(4, Math.min(12, Math.floor(inner / 8)));
	const tokens = snapshot.usage;
	const line2 = cols(
		inner,
		`${theme.fg("dim", "CTX")} ${bar(theme, ratio, gaugeWidth)} ${theme.fg(
			percent !== null && percent !== undefined && percent > 85 ? "warning" : "muted",
			percentText,
		)}`,
		theme.fg("dim", `↑${fmtCount(tokens.input)} ↓${fmtCount(tokens.output)} ${fmtCost(tokens.cost)}`),
		theme.fg("muted", `${fmtRate(snapshot.rate)} t/s`),
	);

	const active = snapshot.activeTools[0];
	const detail = active
		? `${active.name}${active.summary ? ` · ${active.summary}` : ""} · ${fmtDuration(now - active.startedAt)}`
		: snapshot.log.length > 0
			? snapshot.log[snapshot.log.length - 1]!.text
			: "awaiting instructions";
	const sparkWidth = Math.max(6, Math.min(20, Math.floor(inner / 3)));
	const line3 = cols(
		inner,
		`${theme.fg("dim", "FLUX")} ${sparkline(theme, snapshot.flux, sparkWidth)}`,
		theme.fg("dim", `${snapshot.turns}t · ${snapshot.toolCalls}tools · ${snapshot.assistantMessages}resp`),
		theme.fg(active ? "accent" : "muted", shorten(detail, Math.max(10, Math.floor(inner * 0.5)))),
	);

	const bottom = theme.fg("borderMuted", `╰${"─".repeat(Math.max(0, width - 2))}╯`);
	return [fit(top, width), body(line1), body(line2), body(line3), fit(bottom, width)];
}

/** Persistent five-line telemetry HUD rendered above the editor. */
export class CockpitHud implements Component {
	private frame = 0;
	private readonly timer: ReturnType<typeof setInterval>;
	private disposed = false;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly telemetry: TelemetryStore,
	) {
		this.timer = setInterval(() => {
			if (this.disposed) return;
			this.frame++;
			this.telemetry.tick();
			this.tui.requestRender();
		}, FRAME_INTERVAL_MS);
	}

	render(width: number): string[] {
		this.telemetry.tick();
		return renderHud(width, this.telemetry.snapshot(), this.theme, this.frame);
	}

	invalidate(): void {
		// Stateless rendering; nothing cached.
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		clearInterval(this.timer);
	}
}
