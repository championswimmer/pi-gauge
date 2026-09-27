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
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
export const DEFAULTS = {
    showThroughput: true,
    showLatency: true,
    measurementMode: "e2e",
    displayMode: "pill",
    iconSet: "emoji",
};
const SETTINGS_PATH = join(homedir(), ".pi", "agent", "pi-gauge.json");
function coerceMeasurementMode(raw) {
    return raw === "e2e" || raw === "stream" ? raw : DEFAULTS.measurementMode;
}
function coerceDisplayMode(raw) {
    return raw === "pill" || raw === "icon" ? raw : DEFAULTS.displayMode;
}
function coerceIconSet(raw) {
    return raw === "emoji" || raw === "nerd" ? raw : DEFAULTS.iconSet;
}
function loadSettings() {
    try {
        const raw = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
        return {
            showThroughput: typeof raw.showThroughput === "boolean" ? raw.showThroughput : DEFAULTS.showThroughput,
            showLatency: typeof raw.showLatency === "boolean" ? raw.showLatency : DEFAULTS.showLatency,
            measurementMode: coerceMeasurementMode(raw.measurementMode),
            displayMode: coerceDisplayMode(raw.displayMode),
            iconSet: coerceIconSet(raw.iconSet),
        };
    }
    catch {
        return { ...DEFAULTS }; // missing or corrupt file -> defaults
    }
}
function saveSettings(s) {
    try {
        mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
        writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2) + "\n");
    }
    catch {
        // Persistence is best-effort; don't break the session on write failure.
    }
}
// ---------------------------------------------------------------------------
// Helpers (pure — exported for testability)
// ---------------------------------------------------------------------------
const STATUS_KEY = "gauge";
const THROTTLE_MS = 250;
/** Sum character lengths of all text/thinking/toolcall content (for chars/4 estimate). */
export function contentChars(message) {
    let chars = 0;
    for (const block of message.content) {
        if (block.type === "text")
            chars += block.text.length;
        else if (block.type === "thinking")
            chars += block.thinking.length;
        else if (block.type === "toolCall")
            chars += JSON.stringify(block.arguments).length;
    }
    return chars;
}
/** Cumulative output token count: exact if the provider streams usage, else chars/4 estimate. */
export function tokenCount(message) {
    if (message.usage && message.usage.output > 0)
        return message.usage.output;
    return Math.ceil(contentChars(message) / 4);
}
/** "42.1" below 100 t/s, "142" at/above. */
export function formatTps(tps) {
    return tps >= 100 ? String(Math.round(tps)) : tps.toFixed(1);
}
/** Compact duration: "412ms" under a second, "1.23s" above. */
export function formatDuration(ms) {
    return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`;
}
/** Glyph for a metric kind: emoji (⚡/⏱) or nerd-font (tachometer/clock). */
export function glyphFor(kind, iconSet) {
    if (iconSet === "nerd")
        return kind === "tps" ? "\uF0E4" : "\uF017";
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
export function renderText(settings, tokens, ttftMs, endTime, anchorStart, firstDeltaTime) {
    const parts = [];
    if (settings.showThroughput && ttftMs !== null) {
        const start = settings.measurementMode === "stream" && firstDeltaTime != null
            ? firstDeltaTime
            : anchorStart;
        const durationSec = (endTime - start) / 1000;
        if (durationSec > 0 && tokens > 0) {
            const suffix = settings.displayMode === "pill" ? " t/s" : "";
            parts.push(`${glyphFor("tps", settings.iconSet)} ${formatTps(tokens / durationSec)}${suffix}`);
        }
    }
    if (settings.showLatency) {
        parts.push(ttftMs !== null
            ? `${glyphFor("ttft", settings.iconSet)} ${formatDuration(ttftMs)}`
            : `${glyphFor("ttft", settings.iconSet)} —`);
    }
    if (parts.length === 0)
        return undefined;
    const body = parts.join(" ");
    return settings.displayMode === "pill" ? `[${body}]` : body;
}
// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------
export default function (pi) {
    let settings = loadSettings();
    // Per-LLM-call state, re-anchored on every before_provider_request.
    let requestStart = 0;
    let firstDeltaTime = null;
    let lastStatusUpdate = 0;
    let streaming = false;
    // Last computed metrics, kept so /gauge toggles can re-render immediately.
    let lastTokens = 0;
    let lastTtftMs = null;
    function settingsLine() {
        return (`pi-gauge: tps=${settings.showThroughput ? "on" : "off"}` +
            ` ttft=${settings.showLatency ? "on" : "off"}` +
            ` mode=${settings.measurementMode}` +
            ` display=${settings.displayMode}` +
            ` icons=${settings.iconSet}`);
    }
    function hasMetrics() {
        return lastTokens > 0 || lastTtftMs !== null;
    }
    function refreshStatus(ctx, endTime) {
        ctx.ui.setStatus(STATUS_KEY, renderText(settings, lastTokens, lastTtftMs, endTime, requestStart, firstDeltaTime));
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
        if (!streaming)
            return;
        const streamEvent = event.assistantMessageEvent;
        if (!streamEvent ||
            (streamEvent.type !== "text_delta" &&
                streamEvent.type !== "thinking_delta" &&
                streamEvent.type !== "toolcall_delta"))
            return;
        const now = performance.now();
        if (firstDeltaTime === null) {
            firstDeltaTime = now;
            lastTtftMs = requestStart > 0 ? now - requestStart : null;
        }
        lastTokens = tokenCount(streamEvent.partial);
        // Throttle status writes: deltas arrive far faster than the UI needs.
        if (now - lastStatusUpdate >= THROTTLE_MS) {
            lastStatusUpdate = now;
            refreshStatus(ctx, now);
        }
    });
    pi.on("message_end", (event, ctx) => {
        if (!streaming)
            return;
        const message = event.message;
        if (!message || message.role !== "assistant")
            return;
        streaming = false;
        const now = performance.now();
        // Snap to exact final usage when available; otherwise keep the estimate.
        if (message.usage && message.usage.output > 0)
            lastTokens = message.usage.output;
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
        description: "Configure pi-gauge display: /gauge [tps|ttft on|off] [mode e2e|stream] [display pill|icon] [icons emoji|nerd]",
        handler: async (args, ctx) => {
            const [rawSub, rawValue] = args.trim().toLowerCase().split(/\s+/);
            if (!rawSub) {
                ctx.ui.notify(settingsLine(), "info");
                return;
            }
            // Legacy aliases.
            const sub = rawSub === "throughput" ? "tps" : rawSub === "latency" ? "ttft" : rawSub;
            let changed = false;
            if ((sub === "tps" || sub === "ttft") && (rawValue === "on" || rawValue === "off")) {
                const on = rawValue === "on";
                if (sub === "tps")
                    settings.showThroughput = on;
                else
                    settings.showLatency = on;
                changed = true;
            }
            else if (sub === "mode" && (rawValue === "e2e" || rawValue === "stream")) {
                settings.measurementMode = rawValue;
                changed = true;
            }
            else if (sub === "display" && (rawValue === "pill" || rawValue === "icon")) {
                settings.displayMode = rawValue;
                changed = true;
            }
            else if (sub === "icons" && (rawValue === "emoji" || rawValue === "nerd")) {
                settings.iconSet = rawValue;
                changed = true;
            }
            if (!changed) {
                ctx.ui.notify("Usage: /gauge [tps|ttft on|off] [mode e2e|stream] [display pill|icon] [icons emoji|nerd]", "warning");
                return;
            }
            saveSettings(settings);
            ctx.ui.notify(settingsLine(), "info");
            if (hasMetrics())
                refreshStatus(ctx, performance.now());
            else
                ctx.ui.setStatus(STATUS_KEY, undefined);
        },
    });
}
