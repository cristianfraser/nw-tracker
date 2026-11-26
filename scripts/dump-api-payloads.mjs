#!/usr/bin/env node
/**
 * Dump the API's GET payloads from a running server, one JSON file per request, so two code
 * versions serving the same database can be compared with `diff -r` or
 * `scripts/diff-api-payloads.mjs`.
 *
 *   node scripts/dump-api-payloads.mjs --base=http://127.0.0.1:3391 --out=<dir> [--units=clp,usd,eur]
 *                                      [--days=400] [--only=<substring>] [--timeout-ms=180000]
 *
 * What to fetch is discovered from the API itself (currencies, the sidebar nav tree, the
 * account list, benchmarks, tax years, big groups, facturaciones): no id or slug is written
 * here. Requests run one at a time. A non-200 answer is recorded (status + body), never fatal.
 *
 * Output: `<out>/<sanitised path+query>.json` with object keys sorted recursively (array
 * order kept), pretty-printed; `<out>/index.json` lists every request with its status, byte
 * size and file (stable between runs) and `<out>/timings.json` the durations (not stable).
 *
 * Left out on purpose: endpoints that call an external service on request (watchlist search),
 * binary exports (.xlsx), usage / analytics, ingest and job-queue endpoints, anything that
 * writes, `/api/health` and `/api/live-quotes/stamp` (process state), and
 * `/api/import-sync/document-coverage` (reads the statement files on disk, not the database).
 *
 * VOLATILE FIELDS — values that differ between two runs of the same code on the same data are
 * replaced by "<normalised>". The lists below were found by dumping twice and diffing; every
 * entry says why it moves. Everything else that follows the clock (today's marks, «due soon»
 * flags, stale flags of the sync sources) only moves when the wall clock crosses a boundary:
 * make the two dumps you compare close in time, on the same Chile day.
 *
 * NORMALISED_KEYS: replaced wherever the key appears, in any file.
 */
const NORMALISED_KEYS = new Map([
  // Ingest scheduler: the next :30 / 22:00 slot after «now» (moves every half hour).
  ["next_slot_at", "next schedule slot after the request clock"],
]);
/**
 * NORMALISED_PATHS: dotted paths (`*` = any key / array index) replaced in the files whose
 * name matches, for values whose key is too generic to replace everywhere.
 */
const NORMALISED_PATHS = [
  // The Chile wall clock of the request (hour, minute).
  { file: /^sync_status\.json$/, path: "chile" },
  // The in-process scheduler snapshot (timers of this server instance).
  { file: /^sync_status\.json$/, path: "scheduler" },
];

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

function arg(name, fallback = null) {
  const hit = process.argv.slice(2).find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const eq = hit.indexOf("=");
  return eq === -1 ? "1" : hit.slice(eq + 1);
}

const base = (arg("base") ?? "").replace(/\/+$/, "");
const outDir = arg("out");
if (!base || !outDir) {
  console.error("usage: node scripts/dump-api-payloads.mjs --base=http://127.0.0.1:<port> --out=<dir> [--units=clp,usd,eur] [--days=400] [--only=<substring>]");
  process.exit(2);
}
const days = Number(arg("days", "400"));
const only = arg("only");
const timeoutMs = Number(arg("timeout-ms", "180000"));

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = sortKeys(value[k]);
    return out;
  }
  return value;
}

function normaliseKeys(value) {
  if (Array.isArray(value)) return value.map(normaliseKeys);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = NORMALISED_KEYS.has(k) && v != null ? "<normalised>" : normaliseKeys(v);
    return out;
  }
  return value;
}

function normalisePath(value, parts) {
  if (value == null || typeof value !== "object") return;
  const [head, ...rest] = parts;
  const keys = head === "*" ? Object.keys(value) : head in value ? [head] : [];
  for (const k of keys) {
    if (rest.length === 0) {
      if (value[k] != null) value[k] = "<normalised>";
    } else normalisePath(value[k], rest);
  }
}

function fileNameFor(apiPath) {
  const [p, q = ""] = apiPath.replace(/^\/api\//, "").split("?");
  let name = p.replace(/\//g, "_").replace(/[^A-Za-z0-9._-]/g, "-");
  if (q) name += "__" + q.replace(/&/g, "+").replace(/[^A-Za-z0-9._=+-]/g, "-");
  if (name.length > 180) name = name.slice(0, 160) + "-" + crypto.createHash("sha1").update(apiPath).digest("hex").slice(0, 12);
  return `${name}.json`;
}

const index = [];
const timings = [];
const seen = new Set();
let totalBytes = 0;

/** Fetch one path; write its file; return the parsed body (null when not JSON / not 200). */
async function get(apiPath, { record = true } = {}) {
  if (record && seen.has(apiPath)) return null;
  if (record && only && !apiPath.includes(only)) return null;
  const started = performance.now();
  let status = 0;
  let text = "";
  try {
    const res = await fetch(base + apiPath, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
    status = res.status;
    text = await res.text();
  } catch (e) {
    text = JSON.stringify({ dump_error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) });
  }
  const ms = Math.round(performance.now() - started);
  let body = null;
  let parsed = false;
  try {
    body = JSON.parse(text);
    parsed = true;
  } catch {
    body = { non_json_body: text.slice(0, 2000) };
  }
  if (!record) return status === 200 && parsed ? body : null;
  seen.add(apiPath);
  const file = fileNameFor(apiPath);
  let out = normaliseKeys(body);
  for (const rule of NORMALISED_PATHS) if (rule.file.test(file)) normalisePath(out, rule.path.split("."));
  out = sortKeys(out);
  const stored = status === 200 ? out : { status, body: out };
  fs.writeFileSync(path.join(outDir, file), JSON.stringify(stored, null, 2) + "\n");
  const bytes = Buffer.byteLength(text);
  totalBytes += bytes;
  index.push({ path: apiPath, file, status, bytes });
  timings.push({ path: apiPath, ms });
  const n = String(index.length).padStart(4);
  console.log(`${n} ${status === 200 ? "200" : `${status} !`} ${String(ms).padStart(6)}ms ${String(bytes).padStart(9)}b ${apiPath}`);
  return status === 200 && parsed ? body : null;
}

const qs = (params) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null) u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : "";
};
const enc = encodeURIComponent;

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  for (const f of fs.readdirSync(outDir)) if (f.endsWith(".json")) fs.rmSync(path.join(outDir, f));
  const startedAt = Date.now();

  const health = await get("/api/health", { record: false });
  if (!health) throw new Error(`no server answering at ${base}/api/health`);

  // ---- discovery -------------------------------------------------------------------------
  const currencies = (await get("/api/currencies"))?.currencies ?? [];
  const coreUnits = currencies.filter((c) => c.tier === "core").map((c) => c.code);
  const indexUnits = currencies.filter((c) => c.tier !== "core").map((c) => c.code);
  const units = arg("units") ? arg("units").split(",").map((s) => s.trim()).filter(Boolean) : coreUnits;
  if (units.length === 0) throw new Error("no display units (GET /api/currencies listed no core currency)");
  const homeUnit = units[0];

  const nav = await get("/api/meta/sidebar-nav");
  if (!nav) throw new Error("GET /api/meta/sidebar-nav failed");
  // Group pages: every group node of the net-worth tree and of the liabilities tree(s).
  const groupSlugs = [];
  const navAccountIds = new Set();
  const accountNodeSlugs = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.account_id != null) {
      navAccountIds.add(node.account_id);
      if (!accountNodeSlugs.includes(node.slug)) accountNodeSlugs.push(node.slug);
    }
    else if ((node.portfolio_group_id != null || node.liability_group_id != null) && !groupSlugs.includes(node.slug)) groupSlugs.push(node.slug);
    for (const id of node.member_account_ids ?? []) navAccountIds.add(id);
    for (const c of node.children ?? []) walk(c);
  };
  const rootSlug = nav.net_worth?.slug;
  walk(nav.net_worth);
  for (const n of nav.main ?? []) if (n.group_kind === "liability_group") walk(n);

  const accountRows = (await get("/api/accounts"))?.accounts ?? [];
  const accountIds = [...new Set([...accountRows.map((a) => a.id), ...navAccountIds])].filter((id) => Number.isInteger(id) && id > 0).sort((a, b) => a - b);

  const benchmarks = ((await get("/api/benchmarks"))?.benchmarks ?? []).map((b) => b.slug);
  console.log(`discovered: units ${units.join(",")} · ${groupSlugs.length} groups · ${accountIds.length} accounts · ${benchmarks.length} benchmarks`);

  // ---- meta, market, sync ------------------------------------------------------------------
  for (const p of [
    "/api/meta/panel-net-worth-tree",
    "/api/fx",
    "/api/fx/latest",
    "/api/fx/bid-ask/gaps",
    "/api/sync/status",
    "/api/import-sync/ingest-runs",
    "/api/import-sync/jobs",
    "/api/import-sync/generic-unique-merchants",
    "/api/messages?kind=notification",
    "/api/messages?kind=log",
    "/api/messages/unread-count",
    "/api/reminders/mortgage-uf",
    "/api/upcoming-payments/recurring",
    "/api/movement-mirrors/candidates",
    "/api/tax-residency",
    "/api/expenses",
    "/api/income/rent-places",
    "/api/flows/expenses/financing-links",
    "/api/flows/expenses/real-estate",
    "/api/flows/expenses/real-estate/property-accounts",
    "/api/groceries/summary",
    "/api/groceries/brands",
  ]) await get(p);

  // ---- tax returns ---------------------------------------------------------------------------
  const f22 = await get("/api/tax-return");
  for (const y of f22?.available_tax_years ?? []) await get(`/api/tax-return?tax_year=${y}`);
  const f1040 = await get("/api/tax-return/us");
  for (const y of f1040?.available_tax_years ?? []) await get(`/api/tax-return/us?tax_year=${y}`);

  // ---- per display unit: dashboard, flows, market ------------------------------------------
  let expenseMonths = [];
  let bigGroups = [];
  for (const unit of units) {
    await get(`/api/dashboard/page-bundle${qs({ unit })}`);
    await get(`/api/dashboard/nav-snapshot${qs({ unit })}`);
    await get(`/api/dashboard/valuation-timeseries${qs({ unit })}`);
    await get(`/api/dashboard/overview-daily${qs({ unit, days })}`);
    await get(`/api/dashboard/latest-movements${qs({ limit: 15, unit })}`);
    await get(`/api/dashboard/latest-movements${qs({ limit: 100, unit })}`);

    const overview = await get(`/api/flows/overview${qs({ unit, installment_mode: "split" })}`);
    await get(`/api/flows/overview${qs({ unit, installment_mode: "total" })}`);
    await get(`/api/flows/overview${qs({ unit, installment_mode: "split", days })}`);
    const spentBase = { unit, mode: "split", level: "category", exclude_big_groups: "" };
    await get(`/api/flows/expenses/spent${qs({ ...spentBase, range: "90d" })}`);
    await get(`/api/flows/expenses/spent${qs({ ...spentBase, range: "1y", mode: "total", include_pre_tax: 1 })}`);
    const summary = await get(`/api/flows/expenses/summary${qs({ unit })}`);
    await get(`/api/flows/expenses/financing-candidates${qs({ unit })}`);
    if (expenseMonths.length === 0) expenseMonths = (overview?.months ?? []).map((m) => m.period_month).filter(Boolean).sort().slice(-6);
    if (bigGroups.length === 0) bigGroups = (summary?.big_groups ?? []).map((g) => g.slug);
    for (const month of expenseMonths) {
      await get(`/api/flows/expenses/spent/lines${qs({ ...spentBase, month })}`);
      await get(`/api/flows/expenses/spent/lines${qs({ ...spentBase, month, include_pre_tax: 1 })}`);
    }
    await get(`/api/flows/expenses/lines${qs({ unit, list: "uncategorized", page: 1, page_size: 100 })}`);
    await get(`/api/flows/expenses/lines${qs({ unit, list: "deposit_matched" })}`);
    for (const slug of bigGroups) await get(`/api/flows/expenses/lines${qs({ unit, big_group: slug })}`);
    await get(`/api/flows/deposits${qs({ unit })}`);
    await get(`/api/flows/deposits/reconciliation${qs({ unit })}`);
    await get(`/api/flows/pl${qs({ unit })}`);
    await get(`/api/flows/pl${qs({ unit, days })}`);
    await get(`/api/income${qs({ unit })}`);

    await get(`/api/watchlist${qs({ unit })}`);
    await get(`/api/market-ticker${qs({ unit })}`);
    await get(`/api/market-series${qs({ unit })}`);
    await get(`/api/projections${qs({ unit })}`);
    await get(`/api/wealth-percentile${qs({ unit })}`);
  }
  for (const unit of indexUnits) await get(`/api/dashboard/valuation-timeseries${qs({ unit })}`);
  // Full history, once (the widest daily build).
  if (rootSlug) await get(`/api/daily-series${qs({ portfolio_group: rootSlug, unit: homeUnit, days: 0 })}`);
  await get(`/api/dashboard/overview-daily${qs({ unit: homeUnit, days: 0 })}`);

  // ---- group pages ---------------------------------------------------------------------------
  for (const slug of groupSlugs) {
    const g = enc(slug);
    await get(`/api/accounts${qs({ portfolio_group: slug })}`);
    await get(`/api/groups/${g}/flows`);
    await get(`/api/groups/${g}/flows${qs({ page: 2 })}`);
    await get(`/api/portfolio-groups/${g}/cc-ledger`);
    await get(`/api/portfolio-groups/${g}/mortgage-ledger`);
    for (const unit of units) {
      await get(`/api/dashboard/nav-context${qs({ unit, root: slug })}`);
      await get(`/api/dashboard/valuation-timeseries${qs({ unit, portfolio_group: slug })}`);
      await get(`/api/groups/${g}/consolidated-tables${qs({ unit })}`);
      await get(`/api/groups/${g}/consolidated-monthly${qs({ unit, period: "month" })}`);
      await get(`/api/groups/${g}/consolidated-monthly${qs({ unit, period: "year" })}`);
      await get(`/api/groups/${g}/performance-monthly${qs({ unit })}`);
      await get(`/api/groups/${g}/period-returns${qs({ unit })}`);
      await get(`/api/daily-series${qs({ portfolio_group: slug, unit, days, perf_levels: 1 })}`);
      if (benchmarks.length > 0) await get(`/api/benchmark-comparison${qs({ benchmark: benchmarks[0], unit, portfolio_group: slug })}`);
    }
  }
  if (rootSlug) {
    const g = enc(rootSlug);
    await get(`/api/groups/${g}/flows${qs({ exclude_spending: 1 })}`);
    for (const unit of units) {
      await get(`/api/groups/${g}/consolidated-monthly${qs({ unit, period: "month", installment_mode: "split" })}`);
      await get(`/api/groups/${g}/consolidated-monthly${qs({ unit, period: "month", installment_mode: "total" })}`);
      for (const b of benchmarks.slice(1)) await get(`/api/benchmark-comparison${qs({ benchmark: b, unit, portfolio_group: rootSlug })}`);
    }
  }

  // An account page's nav strip (its own nav node as the root).
  for (const slug of accountNodeSlugs) await get(`/api/dashboard/nav-context${qs({ unit: homeUnit, root: slug })}`);

  // ---- account pages -------------------------------------------------------------------------
  for (const id of accountIds) {
    let bundle = null;
    for (const unit of units) {
      const b = await get(`/api/accounts/${id}/detail-bundle${qs({ unit })}`);
      if (unit === homeUnit) bundle = b;
      await get(`/api/accounts/${id}/performance-monthly${qs({ unit })}`);
      await get(`/api/daily-series${qs({ account_id: id, unit, days, perf_levels: 1 })}`);
    }
    await get(`/api/accounts/${id}/detail-bundle${qs({ unit: homeUnit, granularity: "daily" })}`);
    await get(`/api/accounts/${id}/flows`);
    await get(`/api/accounts/${id}/flows${qs({ personal_only: 1 })}`);
    await get(`/api/accounts/${id}/valuations`);
    if (benchmarks.length > 0) await get(`/api/benchmark-comparison${qs({ benchmark: benchmarks[0], unit: homeUnit, account_id: id })}`);

    // Card masters: config, import specs and the latest facturaciones' lines.
    // (The config route answers 404 for any other account: probe before recording.)
    if (bundle?.ccLedger && (await get(`/api/accounts/${id}/credit-card-config`, { record: false }))) {
      await get(`/api/accounts/${id}/credit-card-config`);
      await get(`/api/accounts/${id}/import-specs`);
      const months = (bundle.ccLedger.facturaciones ?? []).map((f) => f.billing_month).filter(Boolean).sort().slice(-4);
      for (const unit of units) for (const m of months) await get(`/api/flows/expenses/lines${qs({ unit, account_id: id, billing_month: m })}`);
    }
    // Mortgage: the payments list's prepayment block per benchmark.
    if (bundle?.depto_glance?.kind === "mortgage") {
      for (const b of benchmarks) for (const unit of units) await get(`/api/accounts/${id}/depto-prepayments${qs({ benchmark: b, unit })}`);
    }
  }

  index.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  fs.writeFileSync(path.join(outDir, "index.json"), JSON.stringify(index, null, 2) + "\n");
  fs.writeFileSync(path.join(outDir, "timings.json"), JSON.stringify(timings, null, 2) + "\n");

  const non200 = index.filter((r) => r.status !== 200);
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\n${index.length} requests · ${non200.length} non-200 · ${(totalBytes / 1e6).toFixed(1)} MB · ${seconds}s · ${outDir}`);
  const byStatus = new Map();
  for (const r of non200) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
  for (const [s, n] of [...byStatus].sort()) console.log(`  status ${s}: ${n}`);
  for (const r of non200.filter((r) => r.status >= 500 || r.status === 0)) console.log(`  ${r.status} ${r.path}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
