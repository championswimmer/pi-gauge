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
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
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
export declare const DEFAULTS: GaugeSettings;
/**
 * Minimum denominator window (ms) before a mid-stream TPS value is shown.
 * Below this, cumulative-tokens / elapsed is quantization noise (a few dozen
 * tokens over a few ms renders as thousands of t/s). The final message_end
 * render bypasses this floor — its tokens and window are both exact.
 */
export declare const MIN_TPS_WINDOW_MS = 500;
export type GaugeKind = "tps" | "ttft";
/** Sum character lengths of all text/thinking/toolcall content (for chars/4 estimate). */
export declare function contentChars(message: AssistantMessage): number;
/** Cumulative output token count: exact if the provider streams usage, else chars/4 estimate. */
export declare function tokenCount(message: AssistantMessage): number;
/** "42.1" below 100 t/s, "142" at/above. */
export declare function formatTps(tps: number): string;
/** Compact duration: "412ms" under a second, "1.23s" above. */
export declare function formatDuration(ms: number): string;
/** Glyph for a metric kind: emoji (⚡/⏱) or nerd-font (tachometer/clock). */
export declare function glyphFor(kind: GaugeKind, iconSet: IconSet): string;
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
export declare function renderText(settings: GaugeSettings, tokens: number, ttftMs: number | null, endTime: number, anchorStart: number, firstDeltaTime?: number | null, final?: boolean): string | undefined;
/**
 * Demo preview string for the given settings, rendered from mocked values
 * (84.2 tokens in 2s with 412ms TTFT). Returns "(hidden)" when both
 * metrics are off. Pure — exported for testability.
 */
export declare function demoPreview(settings: GaugeSettings): string;
/** True when two settings objects hold identical values. */
export declare function settingsEqual(a: GaugeSettings, b: GaugeSettings): boolean;
type GaugeRowId = "throughput" | "latency" | "mode" | "display" | "icons";
/** Current display value of a dialog row for the given settings. */
export declare function rowValue(settings: GaugeSettings, id: GaugeRowId): string;
/** Cycle a row's value forward (dir=1) or backward (dir=-1), mutating in place. */
export declare function cycleRowValue(settings: GaugeSettings, id: GaugeRowId, dir: 1 | -1): void;
/** customType for per-LLM-call gauge records (see plan 004). */
export declare const SAMPLE_TYPE = "pi-gauge-sample";
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
export declare function sampleLabel(s: GaugeSample): string;
/** Defensively validate an unknown value as a v1 GaugeSample. */
export declare function isGaugeSample(raw: unknown): raw is GaugeSample;
/**
 * Extract gauge samples from session entries (getBranch() output).
 * Foreign custom entries and corrupt shapes are dropped.
 */
export declare function loadSamples(entries: SessionEntry[]): GaugeSample[];
/** Distinct model labels in first-seen order (for the filter cycle). */
export declare function distinctModels(samples: GaugeSample[]): string[];
/**
 * TPS for one sample under the given mode. Stream mode falls back to the
 * e2e window when streamMs is missing; null when no positive window exists.
 */
export declare function sampleTps(s: GaugeSample, mode: MeasurementMode): number | null;
/**
 * Horizontal bar (≤ width cols) with fractional end block for sub-cell
 * precision. Empty string for non-positive values — gaps stay blank, never
 * zero-height noise.
 */
export declare function barFor(value: number, max: number, width: number): string;
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
export declare function renderGraph(samples: GaugeSample[], opts: GraphOpts): GraphLine[];
/** Multi-line per-model summary for non-TUI modes (notify fallback). */
export declare function summarizeSamples(samples: GaugeSample[], mode: MeasurementMode): string;
export default function (pi: ExtensionAPI): void;
export {};
