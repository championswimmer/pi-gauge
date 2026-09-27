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
  SAMPLE_TYPE,
  isGaugeSample,
  loadSamples,
  distinctModels,
  sampleLabel,
  sampleTps,
  barFor,
  renderGraph,
  summarizeSamples,
  gaugeCompletions,
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

// ---------------------------------------------------------------------------
// History: samples, loading, bars, graph (plan 004)
// ---------------------------------------------------------------------------

function sample(over = {}) {
  return {
    v: 1, ts: 1000, provider: "anthropic", model: "claude-x",
    ttftMs: 400, tokens: 100, e2eMs: 2000, streamMs: 1600, ...over,
  };
}

function customEntry(data, customType = SAMPLE_TYPE) {
  return { type: "custom", id: "e1", parentId: "p", timestamp: "t", customType, data };
}

test("isGaugeSample accepts v1 shape, rejects junk", () => {
  assert.ok(isGaugeSample(sample()));
  assert.ok(!isGaugeSample(null));
  assert.ok(!isGaugeSample({ v: 2, ts: 1, provider: "a", model: "b", ttftMs: 1, tokens: 1, e2eMs: 1, streamMs: 1 }));
  assert.ok(!isGaugeSample(sample({ tokens: "100" })));
  assert.ok(isGaugeSample(sample({ ttftMs: null, streamMs: null })));
});

test("loadSamples keeps only pi-gauge-sample customs, drops corrupt", () => {
  const entries = [
    customEntry(sample({ model: "a" })),
    customEntry({ hello: 1 }, "other-ext"),
    customEntry({ v: 1, nope: true }),
    { type: "message", id: "m", parentId: "p", timestamp: "t", message: {} },
    customEntry(sample({ model: "b" })),
  ];
  const out = loadSamples(entries);
  assert.equal(out.length, 2);
  assert.equal(out[0].model, "a");
  assert.equal(out[1].model, "b");
});

test("loadSamples returns [] for empty/foreign entries", () => {
  assert.deepEqual(loadSamples([]), []);
});

test("sampleLabel falls back to provider then unknown", () => {
  assert.equal(sampleLabel(sample({ model: "m" })), "m");
  assert.equal(sampleLabel(sample({ model: "", provider: "p" })), "p");
  assert.equal(sampleLabel(sample({ model: "", provider: "" })), "unknown");
});

test("distinctModels preserves first-seen order", () => {
  const xs = [sample({ model: "b" }), sample({ model: "a" }), sample({ model: "b" })];
  assert.deepEqual(distinctModels(xs), ["b", "a"]);
});

test("sampleTps uses e2e vs stream windows, null on degenerate", () => {
  const s = sample({ tokens: 100, e2eMs: 2000, streamMs: 1000 });
  assert.equal(sampleTps(s, "e2e"), 50);
  assert.equal(sampleTps(s, "stream"), 100);
  assert.equal(sampleTps(sample({ tokens: 100, e2eMs: 2000, streamMs: null }), "stream"), 50);
  assert.equal(sampleTps(sample({ tokens: 0, e2eMs: 2000 }), "e2e"), null);
  assert.equal(sampleTps(sample({ tokens: 100, e2eMs: 0 }), "e2e"), null);
});

test("barFor scales, blanks on non-positive", () => {
  assert.equal(barFor(50, 100, 10).length <= 10, true);
  assert.ok(barFor(100, 100, 10).startsWith("█".repeat(10).slice(0, 10)));
  assert.equal(barFor(0, 100, 10), "");
  assert.equal(barFor(-5, 100, 10), "");
  assert.equal(barFor(50, 0, 10), "");
  // half value ~ half width
  assert.equal(barFor(50, 100, 8).replace(/[▁▂▃▄▅▆▇]/u, "X").length, 4);
});

test("renderGraph empty state", () => {
  const lines = renderGraph([], { mode: "e2e", filter: "all", width: 20, offset: 0, maxRows: 8 });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].kind, "empty");
  assert.ok(lines[0].text.includes("No gauge samples"));
  const noMatch = renderGraph([sample()], { mode: "e2e", filter: "zzz", width: 20, offset: 0, maxRows: 8 });
  assert.ok(noMatch[0].text.includes("zzz"));
});

test("renderGraph single model: title, sections, rows, footer, legend", () => {
  const xs = [sample({ tokens: 100, e2eMs: 2000 }), sample({ tokens: 200, e2eMs: 2000 })];
  const lines = renderGraph(xs, { mode: "e2e", filter: "all", width: 20, offset: 0, maxRows: 8 });
  const kinds = lines.map((l) => l.kind);
  assert.ok(kinds.includes("title"));
  assert.equal(kinds.filter((k) => k === "section").length, 2);
  assert.equal(kinds.filter((k) => k === "row").length, 4); // 2 tps + 2 ttft
  assert.ok(lines[0].text.includes("2 calls"));
  assert.ok(lines.find((l) => l.kind === "footer").text.includes("avg"));
  assert.ok(lines.find((l) => l.kind === "legend").text.includes("esc close"));
  // max row scales: faster call has longer bar
  const tpsRows = lines.filter((l) => l.kind === "row").slice(0, 2);
  assert.ok(tpsRows[1].text.indexOf("t/s") > tpsRows[0].text.indexOf("t/s") || tpsRows[1].text.length >= tpsRows[0].text.length);
});

test("renderGraph multi-model filter omits others and rescales", () => {
  const xs = [sample({ model: "a", tokens: 100, e2eMs: 2000 }), sample({ model: "b", tokens: 100, e2eMs: 2000 })];
  const all = renderGraph(xs, { mode: "e2e", filter: "all", width: 20, offset: 0, maxRows: 8 });
  assert.ok(all.some((l) => l.text.includes(" a") || l.text.includes(" b")));
  const onlyA = renderGraph(xs, { mode: "e2e", filter: "a", width: 20, offset: 0, maxRows: 8 });
  assert.ok(onlyA[0].text.includes("1 call"));
  assert.ok(!onlyA.some((l) => l.kind === "row" && l.text.includes(" b")));
});

test("renderGraph TTFT-null renders blank gap, not zero", () => {
  const xs = [sample({ ttftMs: null, streamMs: null })];
  const lines = renderGraph(xs, { mode: "e2e", filter: "all", width: 20, offset: 0, maxRows: 8 });
  const ttftRow = lines.filter((l) => l.kind === "row")[1];
  assert.ok(ttftRow.text.includes("—"));
  assert.ok(!ttftRow.text.includes("0ms"));
});

test("renderGraph honors offset/maxRows window with footer range", () => {
  const xs = Array.from({ length: 5 }, (_, i) => sample({ ts: i }));
  const lines = renderGraph(xs, { mode: "e2e", filter: "all", width: 20, offset: 3, maxRows: 2 });
  assert.equal(lines.filter((l) => l.kind === "row").length, 4); // 2 per section
  assert.ok(lines.find((l) => l.kind === "footer").text.includes("showing 4–5"));
  assert.ok(lines.filter((l) => l.kind === "row")[0].text.startsWith("# 4"));
});

test("summarizeSamples groups per model with counts", () => {
  assert.ok(summarizeSamples([], "e2e").includes("no samples"));
  const xs = [
    sample({ model: "a", tokens: 100, e2eMs: 1000, ttftMs: 100 }),
    sample({ model: "a", tokens: 100, e2eMs: 1000, ttftMs: 300 }),
    sample({ model: "b", tokens: 50, e2eMs: 1000, ttftMs: 200 }),
  ];
  const out = summarizeSamples(xs, "e2e");
  assert.ok(out.includes("3 calls"));
  assert.ok(out.includes("a: n=2"));
  assert.ok(out.includes("b: n=1"));
  assert.ok(out.includes("100 t/s")); // model a avg
});

test("gaugeCompletions empty prefix offers all subcommands", () => {
  const items = gaugeCompletions("");
  assert.ok(items);
  const names = items.map((i) => i.value).sort();
  assert.deepEqual(names, ["display", "graph", "icons", "latency", "mode", "throughput", "tps", "ttft"]);
  for (const i of items) {
    assert.equal(i.label, i.value);
    assert.ok(typeof i.description === "string" && i.description.length > 0);
  }
});

test("gaugeCompletions filters first token case-insensitively", () => {
  const names = gaugeCompletions("t").map((i) => i.value).sort();
  assert.deepEqual(names, ["throughput", "tps", "ttft"]);
  assert.deepEqual(gaugeCompletions("MODE").map((i) => i.value), ["mode"]);
  assert.equal(gaugeCompletions("zzz"), null);
});

test("gaugeCompletions second position offers values with full-text value", () => {
  const all = gaugeCompletions("mode ");
  assert.deepEqual(all.map((i) => i.value).sort(), ["mode e2e", "mode stream"]);
  assert.deepEqual(all.map((i) => i.label).sort(), ["e2e", "stream"]);
  // partial second token narrows
  assert.deepEqual(gaugeCompletions("mode e").map((i) => i.value), ["mode e2e"]);
  assert.deepEqual(gaugeCompletions("tps o").map((i) => i.label).sort(), ["off", "on"]);
  // legacy aliases share the primary value set but keep their own prefix
  assert.deepEqual(gaugeCompletions("throughput ").map((i) => i.value).sort(), [
    "throughput off",
    "throughput on",
  ]);
  assert.equal(gaugeCompletions("tps zzz"), null);
});

test("gaugeCompletions null past the completed pair or unknown subs", () => {
  assert.equal(gaugeCompletions("mode e2e "), null);
  assert.equal(gaugeCompletions("mode e2e extra"), null);
  assert.equal(gaugeCompletions("zzz "), null);
  // graph's model filter is dynamic (no ctx) -> no suggestions
  assert.equal(gaugeCompletions("graph "), null);
});
