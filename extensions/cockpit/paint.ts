import { homedir } from "node:os";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { type Color, mixColors, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { CockpitStatus, Tone } from "./types.ts";

const SPARK_GLYPHS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
const SPINNER_FRAMES = ["◜", "◝", "◞", "◟"];

/** Pad or truncate a styled string to exactly `width` columns. */
export function fit(text: string, width: number): string {
	if (width <= 0) return "";
	return truncateToWidth(text, width, "", true);
}

/** Shorten a styled string, adding an ellipsis when it does not fit. */
export function shorten(text: string, width: number): string {
	if (width <= 0) return "";
	if (visibleWidth(text) <= width) return text;
	if (width === 1) return "…";
	return truncateToWidth(text, width, "…", false);
}

export function center(text: string, width: number): string {
	const w = visibleWidth(text);
	if (w >= width) return fit(text, width);
	const left = Math.floor((width - w) / 2);
	return " ".repeat(left) + text + " ".repeat(width - w - left);
}

/**
 * Lay out a left, center and right segment on one line. The center is dropped
 * before the outer segments are sacrificed, which keeps the HUD readable at
 * narrow widths.
 */
export function cols(width: number, left: string, middle: string, right: string): string {
	if (width <= 0) return "";
	let l = left;
	let m = middle;
	let r = right;
	let lw = visibleWidth(l);
	let mw = visibleWidth(m);
	let rw = visibleWidth(r);

	if (lw + mw + rw + 2 > width) {
		m = "";
		mw = 0;
	}
	if (lw + rw + 1 > width) {
		const rightBudget = Math.max(0, Math.min(rw, Math.floor(width * 0.5)));
		r = shorten(r, rightBudget);
		rw = visibleWidth(r);
		l = shorten(l, Math.max(0, width - rw - 1));
		lw = visibleWidth(l);
	}
	if (lw + rw > width) {
		r = "";
		rw = 0;
	}

	const gap = Math.max(0, width - lw - mw - rw);
	const leftGap = mw > 0 ? Math.floor(gap / 2) : gap;
	return l + " ".repeat(leftGap) + m + " ".repeat(gap - leftGap) + r;
}

/** Rounded panel with an accent title. Every returned line is exactly `width`. */
export function panel(theme: Theme, width: number, title: string, rows: string[], tone: ThemeColor = "accent"): string[] {
	const w = Math.max(1, width);
	if (w < 8) return rows.map((row) => fit(row, w));

	const titleText = shorten(title.toUpperCase(), Math.max(1, w - 6));
	const fill = Math.max(0, w - 5 - visibleWidth(titleText));
	const top =
		theme.fg("borderMuted", "╭─ ") +
		theme.style(titleText, { fg: tone, bold: true }) +
		theme.fg("borderMuted", ` ${"─".repeat(fill)}╮`);
	const body = rows.map(
		(row) => `${theme.fg("borderMuted", "│")} ${fit(row, w - 4)} ${theme.fg("borderMuted", "│")}`,
	);
	const bottom = theme.fg("borderMuted", `╰${"─".repeat(w - 2)}╯`);
	return [fit(top, w), ...body, fit(bottom, w)];
}

/** Join two equal-width panel stacks side by side. */
export function hjoin(left: string[], right: string[], gap = 1): string[] {
	const leftWidth = left.length > 0 ? visibleWidth(left[0] ?? "") : 0;
	const rightWidth = right.length > 0 ? visibleWidth(right[0] ?? "") : 0;
	const height = Math.max(left.length, right.length);
	const lines: string[] = [];
	for (let index = 0; index < height; index++) {
		lines.push(
			fit(left[index] ?? "", leftWidth) +
				" ".repeat(Math.max(0, gap)) +
				fit(right[index] ?? "", rightWidth),
		);
	}
	return lines;
}

/** Bilinear-ish color gradient applied per character. */
export function gradient(theme: Theme, text: string, colors: readonly Color[]): string {
	const characters = [...text];
	if (characters.length === 0 || colors.length === 0) return text;
	const palette = colors.length === 1 ? [colors[0]!, colors[0]!] : colors;
	return characters
		.map((character, index) => {
			if (character === " ") return character;
			const position = characters.length === 1 ? 0 : (index / (characters.length - 1)) * (palette.length - 1);
			const segment = Math.min(palette.length - 2, Math.floor(position));
			const color = mixColors(palette[segment]!, palette[segment + 1]!, position - segment, "oklch");
			return theme.style(character, { fg: color, bold: true });
		})
		.join("");
}

export function cockpitLogo(theme: Theme): string {
	return gradient(theme, "π // C O C K P I T", [
		theme.colors.accent,
		theme.colors.success ?? theme.colors.accent,
		theme.colors.warning ?? theme.colors.accent,
	]);
}

export function bar(theme: Theme, ratio: number, width: number, tone: Tone = "accent"): string {
	const w = Math.max(1, Math.floor(width));
	const clamped = Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0;
	const filled = clamped > 0 ? Math.max(1, Math.round(clamped * w)) : 0;
	return theme.fg(tone, "█".repeat(filled)) + theme.fg("borderMuted", "░".repeat(w - filled));
}

/** Sparkline for the most recent `width` samples. */
export function sparkline(theme: Theme, samples: readonly number[], width: number): string {
	const w = Math.max(1, Math.floor(width));
	const values = samples.slice(-w);
	const padding = " ".repeat(Math.max(0, w - values.length));
	if (values.length === 0) return padding + theme.fg("dim", "·".repeat(Math.min(w, 8)));
	const max = Math.max(0.001, ...values);
	return (
		padding +
		values
			.map((value) => {
				if (value <= 0.001) return theme.fg("dim", "▁");
				const level = Math.min(SPARK_GLYPHS.length - 1, Math.floor((value / max) * (SPARK_GLYPHS.length - 1)));
				const tone: Tone = value / max > 0.66 ? "success" : value / max > 0.25 ? "accent" : "muted";
				return theme.fg(tone, SPARK_GLYPHS[level]!);
			})
			.join("")
	);
}

export function statusTone(status: CockpitStatus): Tone {
	switch (status) {
		case "ERROR":
			return "error";
		case "AWAIT":
		case "COMPACT":
			return "warning";
		case "NOMINAL":
			return "success";
		case "STANDBY":
			return "muted";
		default:
			return "accent";
	}
}

export function statusGlyph(status: CockpitStatus, frame: number): string {
	switch (status) {
		case "IGNITION":
		case "THINKING":
		case "STREAMING":
		case "TOOL":
			return SPINNER_FRAMES[frame % SPINNER_FRAMES.length]!;
		case "ERROR":
			return "✖";
		case "AWAIT":
			return "◈";
		case "COMPACT":
			return "◍";
		case "NOMINAL":
			return "◉";
		default:
			return "◌";
	}
}

export function statusLabel(status: CockpitStatus, detail: string): string {
	if (status === "TOOL" && detail) return `EXEC ${detail}`;
	if (status === "THINKING") return "THINKING";
	if (status === "STREAMING") return "STREAMING";
	if (status === "IGNITION") return "IGNITION";
	return status;
}

export function fmtCount(value: number): string {
	const n = Math.max(0, value);
	if (n < 1_000) return `${Math.round(n)}`;
	if (n < 1_000_000) {
		const scaled = n / 1_000;
		return `${scaled >= 100 ? scaled.toFixed(0) : scaled.toFixed(1)}k`;
	}
	const scaled = n / 1_000_000;
	return `${scaled >= 100 ? scaled.toFixed(0) : scaled.toFixed(2)}M`;
}

export function fmtCost(value: number): string {
	const n = Math.max(0, value);
	if (n >= 100) return `$${n.toFixed(0)}`;
	if (n >= 1) return `$${n.toFixed(2)}`;
	if (n >= 0.01) return `$${n.toFixed(3)}`;
	return `$${n.toFixed(4)}`;
}

export function fmtPercent(percent: number | null | undefined): string {
	if (percent === null || percent === undefined || !Number.isFinite(percent)) return "SYNC";
	if (percent < 10) return `${percent.toFixed(1)}%`;
	return `${Math.round(percent)}%`;
}

export function fmtRate(value: number): string {
	if (!Number.isFinite(value) || value <= 0.05) return "0";
	return value >= 100 ? `${Math.round(value)}` : value.toFixed(1);
}

export function fmtDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "—";
	if (ms < 1_000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) {
		const seconds = ms / 1_000;
		return `${seconds >= 10 ? seconds.toFixed(0) : seconds.toFixed(1)}s`;
	}
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.floor((ms % 60_000) / 1_000);
	if (minutes < 60) return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${(minutes % 60).toString().padStart(2, "0")}m`;
}

/** Elapsed clock, e.g. 04:12 or 01:04:12. */
export function fmtClock(ms: number, withHours = false): string {
	const total = Math.max(0, Math.floor(ms / 1_000));
	const seconds = total % 60;
	const minutes = Math.floor(total / 60) % 60;
	const hours = Math.floor(total / 3_600);
	if (withHours || hours > 0) {
		return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${seconds
			.toString()
			.padStart(2, "0")}`;
	}
	return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

/** Wall clock time for flight-log rows. */
export function fmtTime(timestamp: number): string {
	const date = new Date(timestamp);
	return `${date.getHours().toString().padStart(2, "0")}:${date
		.getMinutes()
		.toString()
		.padStart(2, "0")}:${date.getSeconds().toString().padStart(2, "0")}`;
}

export function shortenPath(path: string, max = 48): string {
	const home = homedir();
	const friendly = home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
	if (visibleWidth(friendly) <= max) return friendly;
	const parts = friendly.split(/[\\/]/);
	if (parts.length <= 2) return shorten(friendly, max);
	const head = parts[0] ?? "";
	const tail = parts.slice(-2).join("/");
	return shorten(`${head}/…/${tail}`, max);
}

export function labelValue(theme: Theme, label: string, value: string, width: number): string {
	const prefix = theme.fg("dim", label.toUpperCase().padEnd(9));
	return prefix + shorten(value, Math.max(0, width - 9));
}

export function rule(theme: Theme, width: number, tone: ThemeColor = "borderMuted"): string {
	return theme.fg(tone, "─".repeat(Math.max(0, width)));
}

export function plainText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const item of content) {
		if (item && typeof item === "object" && "type" in item && item.type === "text" && "text" in item) {
			parts.push(String(item.text));
		}
	}
	return parts.join(" ");
}

/** Right-align a styled string to exactly `width` columns. */
export function padLeft(text: string, width: number): string {
	if (width <= 0) return "";
	const shortened = shorten(text, width);
	return " ".repeat(Math.max(0, width - visibleWidth(shortened))) + shortened;
}
