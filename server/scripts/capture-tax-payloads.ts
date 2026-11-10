/**
 * Report-only: writes every tax payload the app builds for the database `NW_TRACKER_TEST_DB` names
 * to one JSON file — the F22 draft (default parameters, and the other dollar-lot route and posture)
 * and the /tax-return payload for every `availableF22TaxYears()`, and the 1040 payload for every
 * `availableUsTaxYears()`. A year that throws is captured as its error message. Two captures of the
 * same database taken before and after a refactor must be byte-identical (the parity test of the
 * tax-facts split, docs/demo-app-features-plan.md §5 wave T0).
 *
 *   NW_TRACKER_TEST_DB=/abs/path/demo.db npx tsx scripts/capture-tax-payloads.ts --out=<file> [--today=YYYY-MM-DD]
 *
 * Keys are written sorted (array order kept), so the comparison is about content, not the order a
 * builder happened to insert keys in. Importing `db.ts` applies pending migrations to the database it
 * opens: always set `NW_TRACKER_TEST_DB`.
 */
import fs from "node:fs";
import { chileWallClockNow } from "../src/chileDate.js";
import { buildF22Draft } from "../src/f22Draft.js";
import { availableF22TaxYears, buildF22Payload } from "../src/f22DraftPayload.js";
import { availableUsTaxYears } from "../src/f1040Draft.js";
import { buildF1040Payload } from "../src/f1040Payload.js";

if (!process.env.NW_TRACKER_TEST_DB?.trim()) throw new Error("set NW_TRACKER_TEST_DB to the database to capture");
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const out = arg("out");
if (!out) throw new Error("--out=<file> is required");
const today = arg("today") ?? chileWallClockNow().ymd;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value instanceof Map) return { __map: [...value.entries()].map(([k, v]) => [canonical(k), canonical(v)]) };
  if (value instanceof Set) return { __set: [...value].map(canonical) };
  if (value != null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])])
    );
  }
  return value;
}

function attempt(build: () => unknown): unknown {
  try {
    return { ok: canonical(build()) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

const capture: Record<string, unknown> = { today, f22: {}, us1040: {} };
const f22 = capture.f22 as Record<string, unknown>;
for (const y of availableF22TaxYears(today)) {
  f22[`AT${y}`] = {
    draft: attempt(() => buildF22Draft(y, today)),
    draft_igc_1032_2390: attempt(() => buildF22Draft(y, today, { usdFx: { route: "igc_1032", posture: "oficio_2390" } })),
    payload: attempt(() => buildF22Payload(y)),
  };
}
const us = capture.us1040 as Record<string, unknown>;
for (const y of availableUsTaxYears(today)) us[`${y}`] = attempt(() => buildF1040Payload(y, today));

fs.writeFileSync(out, `${JSON.stringify(capture, null, 1)}\n`);
console.log(`captured ${Object.keys(f22).length} F22 year(s), ${Object.keys(us).length} 1040 year(s) → ${out}`);
