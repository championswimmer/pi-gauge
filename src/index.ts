/**
 * pi-gauge — live LLM latency (TTFT) and throughput (tokens/sec) in pi's status bar.
 *
 * Measures:
 *  - TPS  : output tokens / duration, where the denominator depends on
 *           `measurementMode` ("e2e": message_end − requestStart;
 *           "stream": message_end − firstDelta).
 *  - TTFT : time from provider request to first content delta (both modes).
 *
 * Timing model:
 *   before_provider_request ──► first *_delta ──► ...deltas... ──► message_end
 *           │ requestStart           │ firstDeltaTime                    │ end
 *           └───────── TTFT ─────────┘
 *           └────────────── e2e duration ──────────────┘
 *                                    └── stream duration ──┘  TPS = tokens / duration
 *
 * Mid-stream token count uses partial.usage.output when the provider streams
 * cumulative usage (Anthropic, Google); OpenAI only sends usage in the final
 * chunk, so we fall back to a chars/4 estimate until message_end snaps to exact.
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { matchesKey, visibleWidth, type Component } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type MeasurementMode = "e2e" | "stream";
export type DisplayMode = "pill" | "icon";
export type IconSet = "emoji" | "nerd";

export interface GaugeSettings {
	showThroughput: boolean;
	showLatency: boolean;
	measurementMode: MeasurementMode;
	displayMode: DisplayMode;
	iconSet: IconSet;
}

export const DEFAULTS: GaugeSettings = {
	showThroughput: true,
	showLatency: true,
	measurementMode: "e2e",
	displayMode: "pill",
	iconSet: "emoji",
};

const SETTINGS_PATH = join(homedir(), ".pi", "agent", "pi-gauge.json");

function coerceMeasurementMode(raw: unknown): MeasurementMode {
	return raw === "e2e" || raw === "stream" ? raw : DEFAULTS.measurementMode;
}

function coerceDisplayMode(raw: unknown): DisplayMode {
	return raw === "pill" || raw === "icon" ? raw : DEFAULTS.displayMode;
}

function coerceIconSet(raw: unknown): IconSet {
	return raw === "emoji" || raw === "nerd" ? raw : DEFAULTS.iconSet;
}

function loadSettings(): GaugeSettings {
	try {
		const raw = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
		return {
			showThroughput:
				typeof raw.showThroughput === "boolean" ? raw.showThroughput : DEFAULTS.showThroughput,
			showLatency: typeof raw.showLatency === "boolean" ? raw.showLatency : DEFAULTS.showLatency,
			measurementMode: coerceMeasurementMode(raw.measurementMode),
			displayMode: coerceDisplayMode(raw.displayMode),
			iconSet: coerceIconSet(raw.iconSet),
		};
	} catch {
		return { ...DEFAULTS }; // missing or corrupt file -> defaults
	}
}

function saveSettings(s: GaugeSettings): void {
	try {
		mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
		writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2) + "\n");
	} catch {
		// Persistence is best-effort; don't break the session on write failure.
	}
}

// ---------------------------------------------------------------------------
// Helpers (pure — exported for testability)
// ---------------------------------------------------------------------------

const STATUS_KEY = "gauge";
const THROTTLE_MS = 250;

export type GaugeKind = "tps" | "ttft";

/** Sum character lengths of all text/thinking/toolcall content (for chars/4 estimate). */
export function contentChars(message: AssistantMessage): number {
	let chars = 0;
	for (const block of message.content) {
		if (block.type === "text") chars += block.text.length;
		else if (block.type === "thinking") chars += block.thinking.length;
		else if (block.type === "toolCall") chars += JSON.stringify(block.arguments).length;
	}
	return chars;
}

/** Cumulative output token count: exact if the provider streams usage, else chars/4 estimate. */
export function tokenCount(message: AssistantMessage): number {
	if (message.usage && message.usage.output > 0) return message.usage.output;
	return Math.ceil(contentChars(message) / 4);
}

/** "42.1" below 100 t/s, "142" at/above. */
export function formatTps(tps: number): string {
	return tps >= 100 ? String(Math.round(tps)) : tps.toFixed(1);
}

/** Compact duration: "412ms" under a second, "1.23s" above. */
export function formatDuration(ms: number): string {
	return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

/** Glyph for a metric kind: emoji (⚡/⏱) or nerd-font (tachometer/clock). */
export function glyphFor(kind: GaugeKind, iconSet: IconSet): string {
	if (iconSet === "nerd") return kind === "tps" ? "\uF0E4" : "\uF017";
	return kind === "tps" ? "⚡" : "⏱";
}

/**
 * Render the status-bar text for the current metrics, or undefined when
 * nothing should be shown.
 *
 * - TPS denominator follows `settings.measurementMode`: "e2e" uses
 *   `endTime - anchorStart` (request start); "stream" uses
 *   `endTime - firstDeltaTime` when passed, else `endTime - anchorStart`
 *   (callers may pass the first-delta time as `anchorStart` directly).
 * - `ttftMs === null` (no first delta yet) renders TTFT as "—" and skips TPS.
 * - `durationSec <= 0` or `tokens <= 0` skips the TPS part.
 * - `displayMode === "pill"` wraps the body in "[...]".
 */
export function renderText(
	settings: GaugeSettings,
	tokens: number,
	ttftMs: number | null,
	endTime: number,
	anchorStart: number,
	firstDeltaTime?: number | null,
): string | undefined {
	const parts: string[] = [];

	if (settings.showThroughput && ttftMs !== null) {
		const start =
			settings.measurementMode === "stream" && firstDeltaTime != null
				? firstDeltaTime
				: anchorStart;
		const durationSec = (endTime - start) / 1000;
		if (durationSec > 0 && tokens > 0) {
			const suffix = settings.displayMode === "pill" ? " t/s" : "";
			parts.push(
				`${glyphFor("tps", settings.iconSet)} ${formatTps(tokens / durationSec)}${suffix}`,
			);
		}
	}

	if (settings.showLatency) {
		parts.push(
			ttftMs !== null
				? `${glyphFor("ttft", settings.iconSet)} ${formatDuration(ttftMs)}`
				: `${glyphFor("ttft", settings.iconSet)} —`,
		);
	}

	if (parts.length === 0) return undefined;
	const body = parts.join(" ");
	return settings.displayMode === "pill" ? `[${body}]` : body;
}

// ---------------------------------------------------------------------------
// Settings dialog (TUI overlay)
// ---------------------------------------------------------------------------

/** Mocked metrics for the demo preview: the README example reply. */
const DEMO_TOKENS = 84.2;
const DEMO_TTFT_MS = 412;
const DEMO_END = 2000;
const DEMO_START = 0;

/**
 * Demo preview string for the given settings, rendered from mocked values
 * (84.2 tokens in 2s with 412ms TTFT). Returns "(hidden)" when both
 * metrics are off. Pure — exported for testability.
 */
export function demoPreview(settings: GaugeSettings): string {
	return (
		renderText(settings, DEMO_TOKENS, DEMO_TTFT_MS, DEMO_END, DEMO_START, DEMO_TTFT_MS) ??
		"(hidden)"
	);
}

/** True when two settings objects hold identical values. */
export function settingsEqual(a: GaugeSettings, b: GaugeSettings): boolean {
	return (
		a.showThroughput === b.showThroughput &&
		a.showLatency === b.showLatency &&
		a.measurementMode === b.measurementMode &&
		a.displayMode === b.displayMode &&
		a.iconSet === b.iconSet
	);
}

type GaugeRowId = "throughput" | "latency" | "mode" | "display" | "icons";

interface GaugeRow {
	id: GaugeRowId;
	label: string;
	values: [string, string];
}

const GAUGE_ROWS: GaugeRow[] = [
	{ id: "throughput", label: "throughput (t/s)", values: ["on", "off"] },
	{ id: "latency", label: "latency (TTFT)", values: ["on", "off"] },
	{ id: "mode", label: "measurement mode", values: ["e2e", "stream"] },
	{ id: "display", label: "display style", values: ["pill", "icon"] },
	{ id: "icons", label: "icon set", values: ["emoji", "nerd"] },
];

/** Current display value of a dialog row for the given settings. */
export function rowValue(settings: GaugeSettings, id: GaugeRowId): string {
	switch (id) {
		case "throughput":
			return settings.showThroughput ? "on" : "off";
		case "latency":
			return settings.showLatency ? "on" : "off";
		case "mode":
			return settings.measurementMode;
		case "display":
			return settings.displayMode;
		case "icons":
			return settings.iconSet;
	}
}

/** Cycle a row's value forward (dir=1) or backward (dir=-1), mutating in place. */
export function cycleRowValue(settings: GaugeSettings, id: GaugeRowId, dir: 1 | -1): void {
	const row = GAUGE_ROWS.find((r) => r.id === id)!;
	const cur = row.values.indexOf(rowValue(settings, id));
	const next = row.values[(cur + dir + row.values.length) % row.values.length]!;
	switch (id) {
		case "throughput":
			settings.showThroughput = next === "on";
			break;
		case "latency":
			settings.showLatency = next === "on";
			break;
		case "mode":
			settings.measurementMode = next as MeasurementMode;
			break;
		case "display":
			settings.displayMode = next as DisplayMode;
			break;
		case "icons":
			settings.iconSet = next as IconSet;
			break;
	}
}

const DIALOG_WIDTH = 54;
const VALUE_COL_WIDTH = 6; // widest value ("stream") keeps < ... > blocks aligned

/**
 * Bordered settings dialog: all five settings as toggle rows plus a live
 * demo preview rendered from mocked values. Edits mutate `draft` only;
 * the caller commits on save. ctrl+s → done(true), esc → done(false).
 */
class GaugeDialog implements Component {
	private selected = 0;

	constructor(
		private theme: Theme,
		private draft: GaugeSettings,
		private baseline: GaugeSettings,
		private done: (saved: boolean) => void,
	) {}

	private get dirty(): boolean {
		return !settingsEqual(this.draft, this.baseline);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.done(false);
			return;
		}
		// ctrl+s saves (raw \x13 fallback in case the key parser differs).
		if (data === "\x13" || matchesKey(data, "ctrl+s")) {
			this.done(true);
			return;
		}

		const row = GAUGE_ROWS[this.selected]!;
		if (matchesKey(data, "up")) {
			this.selected = (this.selected + GAUGE_ROWS.length - 1) % GAUGE_ROWS.length;
		} else if (matchesKey(data, "down")) {
			this.selected = (this.selected + 1) % GAUGE_ROWS.length;
		} else if (matchesKey(data, "left")) {
			cycleRowValue(this.draft, row.id, -1);
		} else if (matchesKey(data, "right")) {
			cycleRowValue(this.draft, row.id, 1);
		} else if (matchesKey(data, "return") || data === " ") {
			cycleRowValue(this.draft, row.id, 1);
		}
	}

	render(_width: number): string[] {
		const th = this.theme;
		const innerW = DIALOG_WIDTH - 2;
		const border = (s: string) => th.fg("border", s);
		const pad = (s: string) => s + " ".repeat(Math.max(0, innerW - visibleWidth(s)));
		const row = (content: string) => border("│") + pad(content) + border("│");
		const divider = () => border(`├${"─".repeat(innerW)}┤`);

		const lines: string[] = [];
		lines.push(border(`╭${"─".repeat(innerW)}╮`));

		// Title + dirty flag.
		const title = ` ${th.bold("pi-gauge settings")}`;
		const flag = this.dirty ? th.fg("warning", "● unsaved") : th.fg("dim", "saved");
		const gap = " ".repeat(Math.max(0, innerW - visibleWidth(title) - visibleWidth(flag)));
		lines.push(row(`${title}${gap}${flag}`));
		lines.push(divider());

		// Toggle rows.
		for (let i = 0; i < GAUGE_ROWS.length; i++) {
			const r = GAUGE_ROWS[i]!;
			const isSelected = i === this.selected;
			const cursor = isSelected ? th.fg("accent", "▶") : " ";
			const label = isSelected ? th.fg("accent", r.label) : th.fg("text", r.label);
			const value = rowValue(this.draft, r.id).padEnd(VALUE_COL_WIDTH);
			const field = isSelected ? th.fg("accent", `< ${value} >`) : th.fg("dim", `< ${value} >`);
			const left = ` ${cursor} ${label} `;
			const fieldGap = " ".repeat(
				Math.max(0, innerW - visibleWidth(left) - visibleWidth(field) - 1),
			);
			lines.push(row(`${left}${fieldGap}${field} `));
		}
		lines.push(divider());

		// Demo preview with mocked values.
		const preview = demoPreview(this.draft);
		const demoLabel = th.fg("dim", "demo");
		const demoValue = preview === "(hidden)" ? th.fg("dim", preview) : th.fg("text", preview);
		lines.push(row(` ${demoLabel}  ${demoValue}`));
		lines.push(row(` ${th.fg("dim", "↑↓ move · ←→ toggle · ctrl+s save · esc")}`));

		lines.push(border(`╰${"─".repeat(innerW)}╯`));
		return lines;
	}

	invalidate(): void {}
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let settings = loadSettings();

	// Per-LLM-call state, re-anchored on every before_provider_request.
	let requestStart = 0;
	let firstDeltaTime: number | null = null;
	let lastStatusUpdate = 0;
	let streaming = false;
	// Last computed metrics, kept so /gauge toggles can re-render immediately.
	let lastTokens = 0;
	let lastTtftMs: number | null = null;

	function settingsLine(): string {
		return (
			`pi-gauge: tps=${settings.showThroughput ? "on" : "off"}` +
			` ttft=${settings.showLatency ? "on" : "off"}` +
			` mode=${settings.measurementMode}` +
			` display=${settings.displayMode}` +
			` icons=${settings.iconSet}`
		);
	}

	function hasMetrics(): boolean {
		return lastTokens > 0 || lastTtftMs !== null;
	}

	function refreshStatus(ctx: any, endTime: number) {
		ctx.ui.setStatus(
			STATUS_KEY,
			renderText(settings, lastTokens, lastTtftMs, endTime, requestStart, firstDeltaTime),
		);
	}

	pi.on("before_provider_request", () => {
		requestStart = performance.now();
		firstDeltaTime = null;
		lastStatusUpdate = 0;
		streaming = true;
		lastTokens = 0;
		lastTtftMs = null;
	});

	pi.on("message_update", (event, ctx) => {
		if (!streaming) return;
		const streamEvent = event.assistantMessageEvent as AssistantMessageEvent | undefined;
		if (
			!streamEvent ||
			(streamEvent.type !== "text_delta" &&
				streamEvent.type !== "thinking_delta" &&
				streamEvent.type !== "toolcall_delta")
		)
			return;

		const now = performance.now();
		if (firstDeltaTime === null) {
			firstDeltaTime = now;
			lastTtftMs = requestStart > 0 ? now - requestStart : null;
		}
		lastTokens = tokenCount((streamEvent as { partial: AssistantMessage }).partial);

		// Throttle status writes: deltas arrive far faster than the UI needs.
		if (now - lastStatusUpdate >= THROTTLE_MS) {
			lastStatusUpdate = now;
			refreshStatus(ctx, now);
		}
	});

	pi.on("message_end", (event, ctx) => {
		if (!streaming) return;
		const message = event.message;
		if (!message || message.role !== "assistant") return;
		streaming = false;

		const now = performance.now();
		// Snap to exact final usage when available; otherwise keep the estimate.
		if (message.usage && message.usage.output > 0) lastTokens = message.usage.output;
		// Guard: empty/error streams never produce a first delta — renderText
		// then shows TTFT as "—" and skips TPS.
		refreshStatus(ctx, now);
	});

	function settle() {
		streaming = false;
		lastStatusUpdate = 0;
		// Final values stay in the status bar; nothing else to clean up.
	}
	pi.on("agent_end", settle);
	pi.on("session_shutdown", settle);

	pi.registerCommand("gauge", {
		description:
			"Configure pi-gauge display: /gauge [tps|ttft on|off] [mode e2e|stream] [display pill|icon] [icons emoji|nerd]",
		handler: async (args, ctx) => {
			const [rawSub, rawValue] = args.trim().toLowerCase().split(/\s+/);

			if (!rawSub) {
				// No args: interactive settings dialog in TUI mode, plain
				// settings line everywhere else (rpc/json/print have no overlay).
				if (ctx.mode !== "tui") {
					ctx.ui.notify(settingsLine(), "info");
					return;
				}
				const draft: GaugeSettings = { ...settings };
				const baseline: GaugeSettings = { ...settings };
				const saved = await ctx.ui.custom<boolean>(
					(_tui, theme, _kb, done) =>
						new GaugeDialog(theme, draft, baseline, done),
					{
						overlay: true,
						overlayOptions: { anchor: "center", width: DIALOG_WIDTH + 4 },
					},
				);
				if (!saved) {
					if (!settingsEqual(draft, baseline))
						ctx.ui.notify("pi-gauge: discarded unsaved changes", "warning");
					return;
				}
				settings = draft;
				saveSettings(settings);
				ctx.ui.notify(settingsLine(), "info");
				if (hasMetrics()) refreshStatus(ctx, performance.now());
				else ctx.ui.setStatus(STATUS_KEY, undefined);
				return;
			}

			// Legacy aliases.
			const sub = rawSub === "throughput" ? "tps" : rawSub === "latency" ? "ttft" : rawSub;

			let changed = false;
			if ((sub === "tps" || sub === "ttft") && (rawValue === "on" || rawValue === "off")) {
				const on = rawValue === "on";
				if (sub === "tps") settings.showThroughput = on;
				else settings.showLatency = on;
				changed = true;
			} else if (sub === "mode" && (rawValue === "e2e" || rawValue === "stream")) {
				settings.measurementMode = rawValue;
				changed = true;
			} else if (sub === "display" && (rawValue === "pill" || rawValue === "icon")) {
				settings.displayMode = rawValue;
				changed = true;
			} else if (sub === "icons" && (rawValue === "emoji" || rawValue === "nerd")) {
				settings.iconSet = rawValue;
				changed = true;
			}

			if (!changed) {
				ctx.ui.notify(
					"Usage: /gauge [tps|ttft on|off] [mode e2e|stream] [display pill|icon] [icons emoji|nerd]",
					"warning",
				);
				return;
			}

			saveSettings(settings);
			ctx.ui.notify(settingsLine(), "info");
			if (hasMetrics()) refreshStatus(ctx, performance.now());
			else ctx.ui.setStatus(STATUS_KEY, undefined);
		},
	});
}
