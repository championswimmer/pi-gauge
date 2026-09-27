import assert from "node:assert/strict";
import test from "node:test";

import {
  contentChars,
  tokenCount,
  formatTps,
  formatDuration,
  glyphFor,
  renderText,
  MIN_TPS_WINDOW_MS,
  demoPreview,
  settingsEqual,
  rowValue,
  cycleRowValue,
  DEFAULTS,
} from "../dist/index.js";

function textMsg(text, usage) {
  const msg = { content: [{ type: "text", text }] };
  if (usage !== undefined) msg.usage = usage;
  return msg;
}

// ---------------------------------------------------------------------------
// contentChars / tokenCount
// ---------------------------------------------------------------------------

test("contentChars sums text block lengths", () => {
  assert.equal(contentChars({ content: [{ type: "text", text: "hello" }] }), 5);
  assert.equal(
    contentChars({
      content: [
        { type: "text", text: "ab" },
        { type: "text", text: "cde" },
      ],
    }),
    5,
  );
  assert.equal(contentChars({ content: [] }), 0);
});

test("contentChars includes thinking blocks", () => {
  assert.equal(
    contentChars({ content: [{ type: "thinking", thinking: "abcd" }] }),
    4,
  );
});

test("contentChars counts toolCall args via JSON.stringify", () => {
  const args = { a: 1 };
  const msg = {
    content: [{ type: "toolCall", id: "1", name: "fn", arguments: args }],
  };
  assert.equal(contentChars(msg), JSON.stringify(args).length);
});

test("contentChars combines text + thinking + toolCall", () => {
  const args = { x: "yz" };
  const msg = {
    content: [
      { type: "text", text: "hi" }, // 2
      { type: "thinking", thinking: "abc" }, // 3
      { type: "toolCall", id: "1", name: "fn", arguments: args },
    ],
  };
  assert.equal(contentChars(msg), 2 + 3 + JSON.stringify(args).length);
});

test("tokenCount returns exact usage.output when > 0", () => {
  assert.equal(tokenCount(textMsg("hello world, this is long", { output: 42 })), 42);
  assert.equal(tokenCount(textMsg("x", { output: 1 })), 1);
});

test("tokenCount estimates ceil(chars/4) when usage missing", () => {
  // 10 chars -> ceil(10/4) = 3
  assert.equal(tokenCount(textMsg("0123456789")), 3);
  // 8 chars -> exactly 2
  assert.equal(tokenCount(textMsg("12345678")), 2);
  // 9 chars -> ceil(9/4) = 3
  assert.equal(tokenCount(textMsg("123456789")), 3);
});

test("tokenCount estimates ceil(chars/4) when usage.output is 0", () => {
  assert.equal(tokenCount(textMsg("0123456789", { output: 0 })), 3);
});

test("tokenCount estimate covers thinking + toolCall chars", () => {
  const args = { a: 1 };
  const msg = {
    content: [
      { type: "text", text: "abcd" }, // 4
      { type: "thinking", thinking: "ef" }, // 2
      { type: "toolCall", id: "1", name: "fn", arguments: args },
    ],
    usage: { output: 0 },
  };
  const expected = Math.ceil(
    (4 + 2 + JSON.stringify(args).length) / 4,
  );
  assert.equal(tokenCount(msg), expected);
});

// ---------------------------------------------------------------------------
// formatTps: >= 100 rounds, else 1 decimal
// ---------------------------------------------------------------------------

test("formatTps rounds values >= 100", () => {
  assert.equal(formatTps(150.4), "150");
  assert.equal(formatTps(100), "100");
  assert.equal(formatTps(199.6), "200");
});

test("formatTps keeps 1 decimal below 100", () => {
  assert.equal(formatTps(42.06), "42.1");
  assert.equal(formatTps(0), "0.0");
  assert.equal(formatTps(99.9), "99.9");
});

test("formatTps just under 100 still uses 1 decimal (99.96 -> 100.0)", () => {
  assert.equal(formatTps(99.96), "100.0");
});

// ---------------------------------------------------------------------------
// formatDuration: <1000ms -> Nms, else N.NNs
// ---------------------------------------------------------------------------

test("formatDuration renders ms under a second", () => {
  assert.equal(formatDuration(412), "412ms");
  assert.equal(formatDuration(0), "0ms");
});

test("formatDuration renders seconds with 2 decimals at/above a second", () => {
  assert.equal(formatDuration(1234), "1.23s");
  assert.equal(formatDuration(1500), "1.50s");
});

test("formatDuration boundary 999ms vs 1000ms", () => {
  assert.equal(formatDuration(999), "999ms");
  assert.equal(formatDuration(1000), "1.00s");
});

// ---------------------------------------------------------------------------
// glyphFor
// ---------------------------------------------------------------------------

test("glyphFor emoji set", () => {
  assert.equal(glyphFor("tps", "emoji"), "⚡");
  assert.equal(glyphFor("ttft", "emoji"), "⏱");
});

test("glyphFor nerd set uses PUA codepoints", () => {
  assert.equal(glyphFor("tps", "nerd"), "\uF0E4");
  assert.equal(glyphFor("ttft", "nerd"), "\uF017");
});

// ---------------------------------------------------------------------------
// renderText
// ---------------------------------------------------------------------------

const PILL_EMOJI = {
  showThroughput: true,
  showLatency: true,
  measurementMode: "e2e",
  displayMode: "pill",
  iconSet: "emoji",
};

test("renderText e2e vs stream produce different TPS from same inputs", () => {
  const tpsOnly = {
    showThroughput: true,
    showLatency: false,
    displayMode: "icon",
    iconSet: "emoji",
  };
  // tokens=100 over 2s e2e (end-anchorStart) vs 1.2s stream (end-firstDelta);
  // both windows are above MIN_TPS_WINDOW_MS so both render.
  const e2e = renderText({ ...tpsOnly, measurementMode: "e2e" }, 100, 800, 2000, 0, 800);
  const stream = renderText({ ...tpsOnly, measurementMode: "stream" }, 100, 800, 2000, 0, 800);
  assert.notEqual(e2e, stream);
  assert.match(e2e, /50\.0/); // 100 tokens / 2s
  assert.match(stream, /83\.3/); // 100 tokens / 1.2s
});

test("renderText stream mode uses end-firstDelta denominator", () => {
  const settings = {
    showThroughput: true,
    showLatency: false,
    measurementMode: "stream",
    displayMode: "icon",
    iconSet: "emoji",
  };
  // 50 tokens / (2000-1500)ms = 100 t/s; an e2e denominator would give 25 t/s.
  const out = renderText(settings, 50, 100, 2000, 0, 1500);
  assert.match(out, /100/);
  assert.ok(!out.includes("25.0"));
});

test("renderText with measurementMode e2e uses anchorStart denominator", () => {
  const settings = {
    showThroughput: true,
    showLatency: false,
    measurementMode: "e2e",
    displayMode: "icon",
    iconSet: "emoji",
  };
  // 50 tokens / (2000-1000)ms = 50 t/s; a stream denominator would give 500 t/s.
  const out = renderText(settings, 50, 100, 2000, 1000, 1900);
  assert.ok(out.includes("50.0"));
  assert.ok(!out.includes("500"));
});

test("renderText pill wraps in brackets, icon does not", () => {
  const pill = renderText(PILL_EMOJI, 42.06, 412, 1000, 0, 100);
  assert.ok(pill.startsWith("["));
  assert.ok(pill.endsWith("]"));

  const icon = renderText({ ...PILL_EMOJI, displayMode: "icon" }, 42.06, 412, 1000, 0, 100);
  assert.ok(!icon.includes("["));
  assert.ok(!icon.includes("]"));
});

test("renderText shows both metrics with glyphs and formatted values", () => {
  const out = renderText(PILL_EMOJI, 42.06, 412, 1000, 0, 100);
  assert.ok(out.includes("⚡"));
  assert.ok(out.includes("⏱"));
  assert.ok(out.includes("412ms"));
});

test("renderText omits hidden throughput", () => {
  const out = renderText({ ...PILL_EMOJI, showThroughput: false }, 100, 412, 1000, 0, 100);
  assert.ok(!out.includes("⚡"));
  assert.ok(out.includes("⏱"));
  assert.ok(out.includes("412ms"));
});

test("renderText omits hidden latency", () => {
  const out = renderText({ ...PILL_EMOJI, showLatency: false }, 100, 412, 1000, 0, 100);
  assert.ok(out.includes("⚡"));
  assert.ok(!out.includes("⏱"));
});

test("renderText with null ttft shows latency em-dash and skips TPS", () => {
  const out = renderText(PILL_EMOJI, 100, null, 1000, 0, null);
  assert.ok(out.includes("⏱"));
  assert.ok(out.includes("—"));
  assert.ok(!out.includes("⚡"));
});

test("renderText returns undefined when both metrics hidden", () => {
  const out = renderText(
    {
      showThroughput: false,
      showLatency: false,
      measurementMode: "e2e",
      displayMode: "pill",
      iconSet: "emoji",
    },
    100,
    412,
    1000,
    0,
    100,
  );
  assert.equal(out, undefined);
});

test("renderText skips TPS on zero/negative duration", () => {
  const tpsOnly = {
    showThroughput: true,
    showLatency: false,
    measurementMode: "e2e",
    displayMode: "icon",
    iconSet: "emoji",
  };
  // endTime === anchorStart -> duration 0
  assert.equal(renderText(tpsOnly, 100, 50, 1000, 1000, 900), undefined);
  // endTime < anchorStart -> negative duration
  assert.equal(renderText(tpsOnly, 100, 50, 900, 1000, 950), undefined);
});

test("renderText keeps latency when TPS skipped for zero duration", () => {
  const out = renderText(PILL_EMOJI, 100, 412, 1000, 1000, null);
  // TPS skipped (no first delta); latency still renders (value or em-dash)
  assert.ok(!out.includes("⚡"));
  assert.ok(out.includes("⏱"));
});

// ---------------------------------------------------------------------------
// renderText min-window floor (mid-stream spike guard, plan 003)
// ---------------------------------------------------------------------------

const STREAM_PILL = { ...PILL_EMOJI, measurementMode: "stream" };

test("renderText hides mid-stream TPS while the window is below MIN_TPS_WINDOW_MS", () => {
  // The reported bug: 40 cumulative tokens 8ms after the first delta in
  // stream mode used to render "5000 t/s" of pure quantization noise.
  const out = renderText(STREAM_PILL, 40, 410, 418, 0, 410);
  assert.ok(!out.includes("⚡"));
  assert.ok(!out.includes("5000"));
  assert.ok(out.includes("⏱"));
  assert.ok(out.includes("410ms")); // TTFT still shown
});

test("renderText shows mid-stream TPS once the window reaches MIN_TPS_WINDOW_MS", () => {
  const just = renderText(STREAM_PILL, 40, 410, 410 + MIN_TPS_WINDOW_MS - 1, 0, 410);
  assert.ok(!just.includes("⚡"));
  const at = renderText(STREAM_PILL, 40, 410, 410 + MIN_TPS_WINDOW_MS, 0, 410);
  assert.ok(at.includes("⚡"));
  assert.ok(at.includes("80.0")); // 40 tokens / 0.5s
});

test("renderText mid-stream floor also applies in e2e mode", () => {
  // Cached prompt: TTFT 60ms, 25 tokens at the first delta render.
  const out = renderText(PILL_EMOJI, 25, 60, 60, 0, 60);
  assert.ok(!out.includes("⚡"));
  assert.ok(out.includes("60ms"));
});

test("renderText final render bypasses the min-window floor", () => {
  // message_end: exact tokens over the full (short) stream — the true average
  // for a fast response, so it is shown even below MIN_TPS_WINDOW_MS.
  const out = renderText(STREAM_PILL, 40, 410, 418, 0, 410, true);
  assert.ok(out.includes("⚡"));
  assert.ok(out.includes("5000")); // 40 tokens / 8ms, exact
});

test("renderText final render still skips TPS on zero duration", () => {
  const tpsOnly = {
    showThroughput: true,
    showLatency: false,
    measurementMode: "stream",
    displayMode: "icon",
    iconSet: "emoji",
  };
  assert.equal(renderText(tpsOnly, 100, 50, 1000, 1000, 1000, true), undefined);
});

// ---------------------------------------------------------------------------
// demoPreview / settingsEqual / rowValue / cycleRowValue (settings dialog)
// ---------------------------------------------------------------------------

test("demoPreview renders README example under defaults", () => {
  assert.equal(demoPreview({ ...DEFAULTS }), "[⚡ 42.1 t/s ⏱ 412ms]");
});

test("demoPreview follows display and icon settings", () => {
  assert.equal(
    demoPreview({ ...DEFAULTS, displayMode: "icon" }),
    "⚡ 42.1 ⏱ 412ms",
  );
  const nerd = demoPreview({ ...DEFAULTS, iconSet: "nerd" });
  assert.ok(nerd.includes("\uF0E4") || nerd.includes(""));
  assert.ok(nerd.startsWith("["));
});

test("demoPreview hides a toggled-off metric live", () => {
  const noTps = demoPreview({ ...DEFAULTS, showThroughput: false });
  assert.ok(!noTps.includes("⚡"));
  assert.ok(noTps.includes("⏱"));
  const noTtft = demoPreview({ ...DEFAULTS, showLatency: false });
  assert.ok(noTtft.includes("⚡"));
  assert.ok(!noTtft.includes("⏱"));
});

test("demoPreview returns (hidden) when both metrics off", () => {
  assert.equal(
    demoPreview({ ...DEFAULTS, showThroughput: false, showLatency: false }),
    "(hidden)",
  );
});

test("settingsEqual compares all five keys", () => {
  assert.ok(settingsEqual({ ...DEFAULTS }, { ...DEFAULTS }));
  assert.ok(!settingsEqual({ ...DEFAULTS }, { ...DEFAULTS, showThroughput: false }));
  assert.ok(!settingsEqual({ ...DEFAULTS }, { ...DEFAULTS, measurementMode: "stream" }));
  assert.ok(!settingsEqual({ ...DEFAULTS }, { ...DEFAULTS, displayMode: "icon" }));
  assert.ok(!settingsEqual({ ...DEFAULTS }, { ...DEFAULTS, iconSet: "nerd" }));
  assert.ok(!settingsEqual({ ...DEFAULTS }, { ...DEFAULTS, showLatency: false }));
});

test("rowValue reads each row's display value", () => {
  assert.equal(rowValue({ ...DEFAULTS }, "throughput"), "on");
  assert.equal(rowValue({ ...DEFAULTS, showThroughput: false }, "throughput"), "off");
  assert.equal(rowValue({ ...DEFAULTS }, "latency"), "on");
  assert.equal(rowValue({ ...DEFAULTS }, "mode"), "e2e");
  assert.equal(rowValue({ ...DEFAULTS }, "display"), "pill");
  assert.equal(rowValue({ ...DEFAULTS }, "icons"), "emoji");
});

test("cycleRowValue toggles forward and back", () => {
  const s = { ...DEFAULTS };
  cycleRowValue(s, "display", 1);
  assert.equal(s.displayMode, "icon");
  cycleRowValue(s, "display", -1);
  assert.equal(s.displayMode, "pill");
  cycleRowValue(s, "mode", 1);
  assert.equal(s.measurementMode, "stream");
  cycleRowValue(s, "mode", -1);
  assert.equal(s.measurementMode, "e2e");
  cycleRowValue(s, "throughput", 1);
  assert.equal(s.showThroughput, false);
  cycleRowValue(s, "throughput", -1);
  assert.equal(s.showThroughput, true);
});
