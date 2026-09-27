#!/usr/bin/env node
// Demo script for the VHS tape (vhs/gauge.tape).
// Imports the REAL renderText from dist/ so every line shown
// is exactly what the extension puts in pi's status bar.
import { renderText } from "../dist/index.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

const pill = { showThroughput: true, showLatency: true, measurementMode: "e2e", displayMode: "pill", iconSet: "emoji" };

function show(label, settings, tokens, ttft, end, anchor, first) {
  const out = renderText(settings, tokens, ttft, end, anchor, first);
  console.log(`  ${dim(label.padEnd(22))} ${green(out ?? "(hidden)")}`);
}

console.clear();
console.log(bold("  pi-gauge  ") + dim("— live LLM speed in pi's status bar"));
console.log(dim("  ─────────────────────────────────────────────"));
await sleep(800);

// --- 1. default -----------------------------------------------------------
console.log(`\n  ${cyan("$ pi")}  ${dim("# just ask something — the status bar shows:")}`);
console.log(`  ${dim("status:")} ${bold(renderText(pill, 84.2, 412, 2000, 0, 412))}`);
await sleep(1500);

// --- 2. toggles ------------------------------------------------------------
console.log(`\n  ${cyan("$ /gauge tps off")}     ${dim("# hide throughput")}`);
show("tps off", { ...pill, showThroughput: false }, 84.2, 412, 2000, 0, 412);
await sleep(900);

console.log(`\n  ${cyan("$ /gauge ttft off")}    ${dim("# hide latency (tps back on)")}`);
show("ttft off", { ...pill, showLatency: false }, 84.2, 412, 2000, 0, 412);
await sleep(900);

// --- 3. display + icon sets -------------------------------------------------
console.log(`\n  ${cyan("$ /gauge display icon")}  ${dim("# compact, no brackets / t/s")}`);
show("icon + emoji", { ...pill, displayMode: "icon" }, 84.2, 412, 2000, 0, 412);
await sleep(900);

console.log(`\n  ${cyan("$ /gauge icons nerd")}    ${dim("# nerd-font glyphs (needs a Nerd Font)")}`);
const nerd = renderText({ ...pill, iconSet: "nerd" }, 84.2, 412, 2000, 0, 412);
console.log(`  ${dim("icon + nerd".padEnd(22))} ${green(nerd)} ${dim("←  +  in a Nerd Font terminal")}`);
await sleep(900);

// --- 4. slow vs fast model ---------------------------------------------------
console.log(`\n  ${dim("same prompt, different models:")}`);
show("fast model", pill, 284, 210, 2000, 0, 210);
show("slow model", pill, 24.8, 1850, 4000, 0, 1850);
await sleep(900);

// --- 5. live streaming simulation --------------------------------------------
console.log(`\n  ${bold("live during streaming:")} ${dim("(~68 t/s fake stream)")}`);
const fakeTTFT = 380;
for (let i = 1; i <= 18; i++) {
  const end = fakeTTFT + i * 160; // ms since request start (e2e denominator)
  const tokens = i * 11;
  const g = renderText(pill, tokens, fakeTTFT, end, 0, fakeTTFT);
  process.stdout.write(`\r  ${dim("status:")} ${yellow(g)} `);
  await sleep(160);
}
process.stdout.write("\n");
await sleep(800);

console.log(`\n  ${dim("waiting for first token:")} ${green(renderText(pill, 0, null, 1000, 0, null))} ${dim("(TTFT unknown yet)")}`);
await sleep(1200);

console.log(`\n  ${green("✔")} ${dim("done — try it:")} ${cyan("pi install pi-gauge")}`);
await sleep(2500);
