#!/usr/bin/env node
/**
 * Renders the Open Graph image (client/public/og-image.png, 1200×630) for link previews of the
 * hosted demo: a screenshot of the demo's dashboard, tilted in perspective, beside the app's
 * name and a line of what it does.
 *
 *   node scripts/render-og-image.mjs [--url=http://localhost:5210] [--out=client/public/og-image.png]
 *
 * Point --url at a demo instance (the `client-demo` launch config, or the hosted demo). It runs
 * the user's installed Chrome through playwright-core; re-run it when the dashboard changes.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    if (!m) throw new Error(`Unknown argument: ${a}`);
    return [m[1], m[2]];
  })
);
const url = args.url ?? "http://localhost:5210";
const out = path.resolve(repoRoot, args.out ?? "client/public/og-image.png");

const SHOT_W = 1600;
const SHOT_H = 1000;

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  // 1. The dashboard, settled, with the demo tour closed.
  const app = await browser.newPage({ viewport: { width: SHOT_W, height: SHOT_H }, deviceScaleFactor: 1 });
  await app.addInitScript(() => {
    try {
      localStorage.setItem("nw-tracker.demoTour", "closed");
    } catch {
      // ignore
    }
  });
  // The demo's `/` is the About page (the dashboard drawn tilted); shoot the dashboard itself.
  await app.goto(new URL("/dashboard", url).href, { waitUntil: "load" });
  await app.waitForSelector(".cards-strip", { timeout: 60_000 });
  await app.waitForSelector('[data-tile="net-worth-chart"] svg', { timeout: 60_000 });
  // Let the queries settle and the number animations finish.
  await app.waitForFunction(() => !document.querySelector(".loadable.is-loading"), null, { timeout: 60_000 });
  await app.waitForTimeout(3_000);
  const shot = (await app.screenshot({ type: "png" })).toString("base64");
  await app.close();

  // 2. The card: text on the left, the screenshot tilted on the right.
  const html = `<!doctype html>
<html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,600;9..40,700&display=swap" rel="stylesheet">
<style>
  * { box-sizing: border-box; margin: 0; }
  html, body { width: 1200px; height: 630px; }
  body {
    position: relative; overflow: hidden;
    background: radial-gradient(120% 120% at 85% 40%, #13202f 0%, #0c0f14 55%);
    font-family: "DM Sans", system-ui, sans-serif; color: #e8edf4;
  }
  .text { position: absolute; left: 72px; top: 0; bottom: 0; width: 470px;
    display: flex; flex-direction: column; justify-content: center; gap: 22px; }
  .brand { display: flex; align-items: center; gap: 16px; font-size: 30px; font-weight: 600; }
  .mark { width: 40px; height: 40px; border-radius: 9px; background: #000; border: 1px solid #2a3544; }
  h1 { font-size: 54px; line-height: 1.06; font-weight: 700; letter-spacing: -0.02em; }
  h1 em { font-style: normal; color: #3d9cf9; }
  p { font-size: 22px; line-height: 1.4; color: #8b98a8; }
  .tag { align-self: flex-start; font-size: 18px; font-weight: 600; color: #0c0f14;
    background: #3d9cf9; padding: 10px 20px; border-radius: 999px; }
  .stage { position: absolute; left: 560px; top: 60px; width: 900px; height: 562px; perspective: 1800px; }
  .screen { width: 900px; height: 562px; border-radius: 14px; overflow: hidden;
    border: 1px solid #2a3544; background: #0c0f14 url(data:image/png;base64,${shot}) top left / cover no-repeat;
    transform: rotateY(-24deg) rotateX(8deg) rotateZ(-2deg); transform-origin: left center;
    box-shadow: -30px 40px 80px rgba(0,0,0,0.6), 0 0 0 1px rgba(61,156,249,0.15); }
</style></head>
<body>
  <div class="text">
    <div class="brand"><span class="mark"></span>NW Tracker</div>
    <h1>Every account, <em>valued every day</em></h1>
    <p>An automated net-worth and expense tracker, connected to banks, cards, brokers and pension funds.</p>
    <span class="tag">Live demo · fictional data</span>
  </div>
  <div class="stage"><div class="screen"></div></div>
</body></html>`;
  const dir = mkdtempSync(path.join(tmpdir(), "og-image-"));
  const htmlPath = path.join(dir, "card.html");
  writeFileSync(htmlPath, html);
  const card = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await card.goto(`file://${htmlPath}`, { waitUntil: "networkidle" });
  await card.evaluate(() => document.fonts.ready);
  await card.screenshot({ path: out, type: "png" });
  console.log(`wrote ${path.relative(repoRoot, out)}`);
} finally {
  await browser.close();
}
