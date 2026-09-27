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
 *
 * Mid-stream TPS is hidden until the denominator window reaches
 * MIN_TPS_WINDOW_MS — right after the first delta the window is single-digit
 * milliseconds while cumulative usage has already jumped (tool-call arguments
 * stream in fast bursts), so the ratio reads as thousands of t/s of pure
 * quantization noise. The final render at message_end is exempt: exact tokens
 * over the full window is the true average, even for short/fast responses.
 */

import type { ExtensionAPI, SessionEntry, Theme } from "@earendil-works/pi-coding-agent";
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

/**
 * Minimum denominator window (ms) before a mid-stream TPS value is shown.
 * Below this, cumulative-tokens / elapsed is quantization noise (a few dozen
 * tokens over a few ms renders as thousands of t/s). The final message_end
 * render bypasses this floor — its tokens and window are both exact.
 */
export const MIN_TPS_WINDOW_MS = 500;

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
 * - Mid-stream (`final === false`) TPS is skipped while the denominator window
 *   is below MIN_TPS_WINDOW_MS (quantization noise); `tokens <= 0` or a
 *   non-positive duration always skips TPS.
 * - `displayMode === "pill"` wraps the body in "[...]".
 */
export function renderText(
	settings: GaugeSettings,
	tokens: number,
	ttftMs: number | null,
	endTime: number,
	anchorStart: number,
	firstDeltaTime?: number | null,
	final = false,
): string | undefined {
	const parts: string[] = [];

	if (settings.showThroughput && ttftMs !== null) {
		const start =
			settings.measurementMode === "stream" && firstDeltaTime != null
				? firstDeltaTime
				: anchorStart;
		const durationMs = endTime - start;
		const windowOk = final ? durationMs > 0 : durationMs >= MIN_TPS_WINDOW_MS;
		if (windowOk && tokens > 0) {
			const suffix = settings.displayMode === "pill" ? " t/s" : "";
			parts.push(
				`${glyphFor("tps", settings.iconSet)} ${formatTps(tokens / (durationMs / 1000))}${suffix}`,
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
// History (per-call samples in session JSONL + graph view)
// ---------------------------------------------------------------------------

/** customType for per-LLM-call gauge records (see plan 004). */
export const SAMPLE_TYPE = "pi-gauge-sample";

/**
 * One persisted record per assistant message_end. Raw values only — TPS is
 * derived at render time via the active measurementMode, so toggling modes
 * re-interprets history without re-recording.
 */
export interface GaugeSample {
	v: 1;
	/** Wall-clock ms (Date.now()) at message_end — chart x-axis. */
	ts: number;
	provider: string;
	model: string;
	/** Null when no content delta arrived (aborted/empty stream). */
	ttftMs: number | null;
	/** Final output tokens (exact usage, else chars/4 estimate). */
	tokens: number;
	/** message_end − requestStart (performance.now basis). */
	e2eMs: number;
	/** message_end − firstDelta, null when no delta arrived. */
	streamMs: number | null;
}

/** Short display label for a sample's model (never empty). */
export function sampleLabel(s: GaugeSample): string {
	if (s.model) return s.model;
	if (s.provider) return s.provider;
	return "unknown";
}

/** Defensively validate an unknown value as a v1 GaugeSample. */
export function isGaugeSample(raw: unknown): raw is GaugeSample {
	if (typeof raw !== "object" || raw === null) return false;
	const s = raw as Record<string, unknown>;
	return (
		s.v === 1 &&
		typeof s.ts === "number" &&
		typeof s.provider === "string" &&
		typeof s.model === "string" &&
		(s.ttftMs === null || typeof s.ttftMs === "number") &&
		typeof s.tokens === "number" &&
		typeof s.e2eMs === "number" &&
		(s.streamMs === null || typeof s.streamMs === "number")
	);
}

/**
 * Extract gauge samples from session entries (getBranch() output).
 * Foreign custom entries and corrupt shapes are dropped.
 */
export function loadSamples(entries: SessionEntry[]): GaugeSample[] {
	const out: GaugeSample[] = [];
	for (const e of entries) {
		if (e.type === "custom" && e.customType === SAMPLE_TYPE && isGaugeSample(e.data)) {
			out.push(e.data);
		}
	}
	return out;
}

/** Distinct model labels in first-seen order (for the filter cycle). */
export function distinctModels(samples: GaugeSample[]): string[] {
	const seen: string[] = [];
	for (const s of samples) {
		const l = sampleLabel(s);
		if (!seen.includes(l)) seen.push(l);
	}
	return seen;
}

/**
 * TPS for one sample under the given mode. Stream mode falls back to the
 * e2e window when streamMs is missing; null when no positive window exists.
 */
export function sampleTps(s: GaugeSample, mode: MeasurementMode): number | null {
	const ms = mode === "stream" && s.streamMs != null ? s.streamMs : s.e2eMs;
	if (!(ms > 0) || !(s.tokens > 0)) return null;
	return s.tokens / (ms / 1000);
}

const BAR_FULL = "█";
const BAR_FRAC = ["", "▁", "▂", "▃", "▄", "▅", "▆", "▇"];

/**
 * Horizontal bar (≤ width cols) with fractional end block for sub-cell
 * precision. Empty string for non-positive values — gaps stay blank, never
 * zero-height noise.
 */
export function barFor(value: number, max: number, width: number): string {
	if (!(value > 0) || !(max > 0) || !(width > 0)) return "";
	const eighths = Math.round((value / max) * width * 8);
	const full = Math.floor(eighths / 8);
	const rest = eighths % 8;
	return (
		BAR_FULL.repeat(Math.min(width, full)) + (full < width && rest > 0 ? BAR_FRAC[rest]! : "")
	);
}

function avg(nums: number[]): number | null {
	if (nums.length === 0) return null;
	return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function truncateLabel(label: string): string {
	return label.length > 18 ? label.slice(0, 17) + "…" : label;
}

export interface GraphOpts {
	mode: MeasurementMode;
	/** "all" or a sampleLabel(). */
	filter: string;
	/** Max bar width in columns. */
	width: number;
	/** First visible sample index (into the filtered list). */
	offset: number;
	/** Max visible samples (scroll window). */
	maxRows: number;
}

export type GraphLineKind = "title" | "section" | "row" | "footer" | "legend" | "empty";
export interface GraphLine {
	kind: GraphLineKind;
	text: string;
}

/**
 * Plain-text history chart (no ANSI — the overlay component adds theme
 * colors). Two stacked sections (TPS + TTFT, separate scales) over one
 * shared call index; scroll via offset/maxRows.
 */
export function renderGraph(samples: GaugeSample[], opts: GraphOpts): GraphLine[] {
	const models = distinctModels(samples);
	const filtered =
		opts.filter === "all" ? samples : samples.filter((s) => sampleLabel(s) === opts.filter);
	if (filtered.length === 0) {
		return [
			{
				kind: "empty",
				text:
				samples.length === 0
						? "No gauge samples yet — finish a turn first."
						: `No samples for "${opts.filter}".`,
			},
		];
	}

	const lines: GraphLine[] = [];
	lines.push({
		kind: "title",
		text: `pi-gauge history · ${filtered.length} call${filtered.length === 1 ? "" : "s"}`,
	});

	const tpsVals = filtered.map((s) => sampleTps(s, opts.mode));
	const ttftVals = filtered.map((s) => s.ttftMs);
	const maxTps = Math.max(0, ...tpsVals.filter((v): v is number => v !== null));
	const maxTtft = Math.max(0, ...ttftVals.filter((v): v is number => v !== null));

	const offset = Math.max(0, Math.min(opts.offset, Math.max(0, filtered.length - 1)));
	const window = filtered
		.map((s, i) => ({ s, i }))
		.slice(offset, offset + Math.max(1, opts.maxRows));
	const mixed = opts.filter === "all" && models.length > 1;

	lines.push({
		kind: "section",
		text: `TPS (${opts.mode})${maxTps > 0 ? ` — max ${formatTps(maxTps)} t/s` : ""}`,
	});
	for (const { s, i } of window) {
		const v = sampleTps(s, opts.mode);
		const bar = (v !== null ? barFor(v, maxTps, opts.width) : "").padEnd(opts.width);
		const val = (v !== null ? `${formatTps(v)} t/s` : "—").padEnd(8);
		const tag = mixed ? ` ${truncateLabel(sampleLabel(s))}` : "";
		lines.push({ kind: "row", text: `#${String(i + 1).padStart(2)} ${bar} ${val}${tag}` });
	}

	lines.push({
		kind: "section",
		text: `TTFT${maxTtft > 0 ? ` — max ${formatDuration(maxTtft)}` : ""}`,
	});
	for (const { s, i } of window) {
		const v = s.ttftMs;
		const bar = (v !== null ? barFor(v, maxTtft, opts.width) : "").padEnd(opts.width);
		const val = (v !== null ? formatDuration(v) : "—").padEnd(8);
		const tag = mixed ? ` ${truncateLabel(sampleLabel(s))}` : "";
		lines.push({ kind: "row", text: `#${String(i + 1).padStart(2)} ${bar} ${val}${tag}` });
	}

	// Footer averages cover the full filtered set (stable while scrolling).
	const avgT = avg(tpsVals.filter((v): v is number => v !== null));
	const avgL = avg(ttftVals.filter((v): v is number => v !== null));
	const shown =
		window.length < filtered.length ? ` · showing ${offset + 1}–${offset + window.length}` : "";
	lines.push({
		kind: "footer",
		text: `avg ${avgT !== null ? `${formatTps(avgT)} t/s` : "—"} · avg TTFT ${
			avgL !== null ? formatDuration(avgL) : "—"
		}${shown}`,
	});
	lines.push({
		kind: "legend",
		text: `filter < ${opts.filter} > · ↑↓ scroll · ←→ filter · esc close`,
	});
	return lines;
}

/** Multi-line per-model summary for non-TUI modes (notify fallback). */
export function summarizeSamples(samples: GaugeSample[], mode: MeasurementMode): string {
	if (samples.length === 0) return "pi-gauge: no samples recorded this session yet.";
	const byModel = new Map<string, GaugeSample[]>();
	for (const s of samples) {
		const l = sampleLabel(s);
		byModel.set(l, [...(byModel.get(l) ?? []), s]);
	}
	const lines = [`pi-gauge: ${samples.length} call${samples.length === 1 ? "" : "s"} (${mode})`];
	for (const [label, xs] of byModel) {
		const t = avg(xs.map((s) => sampleTps(s, mode)).filter((v): v is number => v !== null));
		const l = avg(xs.map((s) => s.ttftMs).filter((v): v is number => v !== null));
		lines.push(
			`${label}: n=${xs.length} avg ${t !== null ? `${formatTps(t)} t/s` : "—"} avg TTFT ${
				l !== null ? formatDuration(l) : "—"
			}`,
		);
	}
	return lines.join("\n");
}

const GRAPH_WIDTH = 72;
const GRAPH_MAX_ROWS = 8;

/**
 * Bordered history overlay: renderGraph() output with theme colors plus
 * filter/scroll state. ←→ cycles all → model…, ↑↓/PgUp/PgDn scroll the
 * window, esc closes. Read-only — no save path.
 */
class GaugeGraph implements Component {
	private filterIdx = 0; // 0 = all, else models[filterIdx - 1]
	private offset = 0;
	private models: string[];

	constructor(
		private theme: Theme,
		private samples: GaugeSample[],
		private mode: MeasurementMode,
		private done: (result: boolean) => void,
		initialFilter?: string,
	) {
		this.models = distinctModels(samples);
		if (initialFilter) {
			const found = this.models.findIndex(
				(m) => m.toLowerCase() === initialFilter.toLowerCase(),
			);
			if (found >= 0) this.filterIdx = found + 1;
		}
	}

	private get filter(): string {
		return this.filterIdx === 0 ? "all" : this.models[this.filterIdx - 1]!;
	}

	private get filteredCount(): number {
		return this.filter === "all"
			? this.samples.length
			: this.samples.filter((s) => sampleLabel(s) === this.filter).length;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.done(false);
			return;
		}
		const cycle = this.models.length + 1;
		if (matchesKey(data, "left")) {
			this.filterIdx = (this.filterIdx + cycle - 1) % cycle;
			this.offset = 0;
		} else if (matchesKey(data, "right")) {
			this.filterIdx = (this.filterIdx + 1) % cycle;
			this.offset = 0;
		} else if (matchesKey(data, "up")) {
			this.offset = Math.max(0, this.offset - 1);
		} else if (matchesKey(data, "down")) {
			this.offset = Math.min(Math.max(0, this.filteredCount - 1), this.offset + 1);
		} else if (matchesKey(data, "pageUp")) {
			this.offset = Math.max(0, this.offset - GRAPH_MAX_ROWS);
		} else if (matchesKey(data, "pageDown")) {
			this.offset = Math.min(Math.max(0, this.filteredCount - 1), this.offset + GRAPH_MAX_ROWS);
		}
	}

	render(_width: number): string[] {
		const th = this.theme;
		const innerW = GRAPH_WIDTH - 2;
		const border = (s: string) => th.fg("border", s);
		const pad = (s: string) => s + " ".repeat(Math.max(0, innerW - visibleWidth(s)));
		const row = (content: string) => border("│") + pad(content) + border("│");

		// Row layout: `#12 ` (4) + bar + ` ` + value (8) + ` ` + tag (≤19)
		// + 2 chars margin → barW = innerW − 35.
		const barW = Math.max(10, innerW - 35);
		const graph = renderGraph(this.samples, {
			mode: this.mode,
			filter: this.filter,
			width: barW,
			offset: this.offset,
			maxRows: GRAPH_MAX_ROWS,
		});

		const paint = (l: GraphLine): string => {
			switch (l.kind) {
				case "title":
					return ` ${th.bold(l.text)}`;
				case "section":
					return ` ${th.fg("accent", l.text)}`;
				case "row":
					return ` ${th.fg("text", l.text)}`;
				case "footer":
					return ` ${th.fg("text", l.text)}`;
				case "legend":
					return ` ${th.fg("dim", l.text)}`;
				case "empty":
					return ` ${th.fg("dim", l.text)}`;
			}
		};

		const lines: string[] = [];
		lines.push(border(`╭${"─".repeat(innerW)}╮`));
		for (const l of graph) lines.push(row(paint(l)));
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

	function refreshStatus(ctx: any, endTime: number, final = false) {
		ctx.ui.setStatus(
			STATUS_KEY,
			renderText(settings, lastTokens, lastTtftMs, endTime, requestStart, firstDeltaTime, final),
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
		// Persist one sample per call for /gauge graph (best-effort — never
		// break the session if the JSONL write fails). appendEntry lives on
		// the factory-level ExtensionAPI, not the event ctx, hence pi.* here.
		try {
			if (lastTokens > 0 || lastTtftMs !== null) {
				const e2eMs = requestStart > 0 ? now - requestStart : 0;
				pi.appendEntry(SAMPLE_TYPE, {
					v: 1,
					ts: Date.now(),
					provider: String(message.provider ?? ctx.model?.provider ?? "unknown"),
					model: String(message.model ?? ctx.model?.id ?? "unknown"),
					ttftMs: lastTtftMs,
					tokens: lastTokens,
					e2eMs: Math.max(0, Math.round(e2eMs)),
					streamMs:
						firstDeltaTime !== null ? Math.max(0, Math.round(now - firstDeltaTime)) : null,
				} satisfies GaugeSample);
			}
		} catch {
			// History is auxiliary; ignore persistence failures.
		}
		// Guard: empty/error streams never produce a first delta — renderText
		// then shows TTFT as "—" and skips TPS. The final render bypasses the
		// mid-stream window floor: exact tokens over the full window is the
		// true average, even for short responses.
		refreshStatus(ctx, now, true);
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
			"Configure pi-gauge display: /gauge [tps|ttft on|off] [mode e2e|stream] [display pill|icon] [icons emoji|nerd] [graph [model]]",
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

			// History graph: /gauge graph [model].
			if (rawSub === "graph") {
				let entries: SessionEntry[] = [];
				try {
					entries = ctx.sessionManager.getBranch();
				} catch {
					entries = [];
				}
				const samples = loadSamples(entries);
				if (ctx.mode !== "tui") {
					ctx.ui.notify(summarizeSamples(samples, settings.measurementMode), "info");
					return;
				}
				await ctx.ui.custom<boolean>(
					(_tui, theme, _kb, done) =>
						new GaugeGraph(theme, samples, settings.measurementMode, done, rawValue),
					{
						overlay: true,
						overlayOptions: { anchor: "center", width: GRAPH_WIDTH + 4, maxHeight: "90%" },
					},
				);
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
					"Usage: /gauge [tps|ttft on|off] [mode e2e|stream] [display pill|icon] [icons emoji|nerd] [graph [model]]",
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
