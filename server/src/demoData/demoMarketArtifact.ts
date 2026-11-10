/**
 * The demo's market data as one file (2026-11-09, docs/demo-market-publish-plan.md). The home
 * server builds it every night from the real sources (`loadDemoRealMarket` against a scratch DB,
 * `scripts/publish-demo-market.ts`) and uploads it as a GitHub Release asset; the Render build
 * downloads it and loads the rows into the fresh demo DB instead of fetching from Yahoo, the
 * Banco Central, AFP UNO and the Bolsa itself — Render's servers are a bad place to fetch from
 * (two builds failed on 2026-11-09 at that step).
 *
 * The file is gzipped JSON: a header (`schema_version`, `generated_at`, `complete_through`, the
 * spec it was built for) and, per market table, its columns and rows exactly as the loader left
 * them. Loading checks the version, the freshness, that the spec it was built for covers the
 * build's, and that every table's columns are the build's schema's; anything else throws.
 */
import { gunzipSync, gzipSync } from "node:zlib";
import type Database from "better-sqlite3";
import { chileCalendarAddDays } from "../chileDate.js";

/** Bumped when the file's shape changes (not when a table gains a column: that fails the column check). */
export const DEMO_MARKET_ARTIFACT_SCHEMA_VERSION = 1;

/**
 * Every table `loadDemoRealMarket` writes. The publish script checks that nothing else changed
 * in its scratch DB (`assertOnlyMarketTablesChanged`), so a loader that starts writing a new
 * table fails the publish until the table is listed here.
 */
export const DEMO_MARKET_TABLES = [
  "equity_daily",
  "equity_dividends",
  "fx_daily",
  "fx_daily_bcentral",
  "eur_daily",
  "uf_daily",
  "utm_daily",
  "ipc_daily",
  "pension_fund_unit_official",
  "fund_unit_daily",
] as const;

/**
 * Tables a load writes into as a side effect, never exported: the change log the caches read, and
 * the Yahoo fx bars the loader refused (a diagnostics list for the sync panel, not market data).
 */
export const DEMO_MARKET_SIDE_EFFECT_TABLES: readonly string[] = ["mark_input_changes", "fx_daily_yahoo_rejected"];

/**
 * How many days before the build's yesterday (Chile) the asset may be complete through. The
 * nightly publish runs at 01:00 Chile, so a healthy asset is complete through the build's
 * yesterday; three days absorb a missed night and its retries, not a dead job.
 */
export const DEMO_MARKET_ASSET_MAX_AGE_DAYS = 3;

export type DemoMarketArtifactSpec = {
  fromMonth: string;
  tickers: { ticker: string; firstUse: string }[];
  withAfp: boolean;
};

export type DemoMarketArtifactTable = { columns: string[]; rows: (string | number | null)[][] };

export type DemoMarketArtifact = {
  schema_version: number;
  /** ISO instant the market was fetched. */
  generated_at: string;
  /** The Chile day the history is complete through (the publish run's yesterday). */
  complete_through: string;
  spec: DemoMarketArtifactSpec;
  tables: Record<string, DemoMarketArtifactTable>;
};

/** What the release page lists beside the asset, and what `release-demo.sh` reads. */
export type DemoMarketArtifactMeta = Omit<DemoMarketArtifact, "tables"> & { rows: Record<string, number> };

/** The publish script's last line starts with this, followed by a {@link DemoMarketPublishOutcome} as JSON. */
export const DEMO_MARKET_PUBLISH_RESULT_PREFIX = "demo-market-publish: result ";

export type DemoMarketPublishOutcome = {
  complete_through: string;
  generated_at: string;
  bytes: number;
  file: string;
  uploaded: boolean;
  url: string | null;
};

/** The outcome the publish script printed, from its whole output; throws when it printed none. */
export function parseDemoMarketPublishOutcome(output: string): DemoMarketPublishOutcome {
  // The server's log stamp (`serverLog.ts`) prefixes every console line, so the result sits after it.
  const line = output
    .split(/\r?\n/)
    .reverse()
    .find((l) => l.includes(DEMO_MARKET_PUBLISH_RESULT_PREFIX));
  if (line == null) throw new Error("demo market publish: the script printed no result line");
  const json = line.slice(line.indexOf(DEMO_MARKET_PUBLISH_RESULT_PREFIX) + DEMO_MARKET_PUBLISH_RESULT_PREFIX.length);
  const j = JSON.parse(json) as Partial<DemoMarketPublishOutcome>;
  if (typeof j.complete_through !== "string" || !YMD.test(j.complete_through) || typeof j.uploaded !== "boolean") {
    throw new Error(`demo market publish: unreadable result line «${line}»`);
  }
  return j as DemoMarketPublishOutcome;
}

/** The name the home-server job is known by in error messages. */
export const DEMO_MARKET_PUBLISH_JOB_HINT =
  "the home server's nightly demo-market publish (server/src/demoMarketPublishJob.ts; run it by hand: npm run demo:publish-market -w nw-tracker-server)";

function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`demo market artifact: unexpected table or column name «${name}»`);
  return `"${name}"`;
}

function tableColumns(handle: Database.Database, table: string): string[] {
  const cols = (handle.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as { name: string }[]).map((c) => c.name);
  if (cols.length === 0) throw new Error(`demo market artifact: no table ${table}`);
  return cols;
}

/** Row counts of every user table (for the publish script's exhaustiveness check). */
export function countAllTables(handle: Database.Database): Map<string, number> {
  const names = (
    handle
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .all() as { name: string }[]
  ).map((r) => r.name);
  const out = new Map<string, number>();
  for (const n of names) out.set(n, (handle.prepare(`SELECT COUNT(*) AS c FROM ${quoteIdent(n)}`).get() as { c: number }).c);
  return out;
}

/**
 * Throws unless every table whose row count moved between `before` and `after` is a market table
 * (or a side-effect log), and every market table was empty before and holds rows after.
 */
export function assertOnlyMarketTablesChanged(
  before: ReadonlyMap<string, number>,
  after: ReadonlyMap<string, number>,
  tables: readonly string[] = DEMO_MARKET_TABLES
): void {
  const allowed = new Set([...tables, ...DEMO_MARKET_SIDE_EFFECT_TABLES]);
  const unexpected: string[] = [];
  for (const [name, n] of after) {
    if ((before.get(name) ?? 0) !== n && !allowed.has(name)) unexpected.push(`${name} ${before.get(name) ?? 0} → ${n}`);
  }
  if (unexpected.length > 0) {
    throw new Error(
      `demo market artifact: the loader wrote tables the artifact does not carry (${unexpected.join(", ")}); list them in DEMO_MARKET_TABLES`
    );
  }
  for (const t of tables) {
    if ((before.get(t) ?? 0) !== 0) throw new Error(`demo market artifact: ${t} held ${before.get(t)} rows before the load — not a fresh DB`);
    if ((after.get(t) ?? 0) === 0) throw new Error(`demo market artifact: the loader left ${t} empty`);
  }
}

/** Reads the market tables out of `handle` into an artifact. */
export function exportDemoMarketArtifact(
  handle: Database.Database,
  header: Omit<DemoMarketArtifact, "tables" | "schema_version">,
  tables: readonly string[] = DEMO_MARKET_TABLES
): DemoMarketArtifact {
  const out: Record<string, DemoMarketArtifactTable> = {};
  for (const t of tables) {
    const columns = tableColumns(handle, t);
    const rows = handle
      .prepare(`SELECT ${columns.map(quoteIdent).join(", ")} FROM ${quoteIdent(t)} ORDER BY rowid`)
      .raw()
      .all() as unknown[][];
    for (const r of rows) {
      for (const v of r) {
        if (v !== null && typeof v !== "string" && typeof v !== "number") {
          throw new Error(`demo market artifact: ${t} holds a ${typeof v} value; only text, numbers and null travel`);
        }
      }
    }
    out[t] = { columns, rows: rows as (string | number | null)[][] };
  }
  return { schema_version: DEMO_MARKET_ARTIFACT_SCHEMA_VERSION, ...header, tables: out };
}

export function demoMarketArtifactMeta(a: DemoMarketArtifact): DemoMarketArtifactMeta {
  const { tables, ...header } = a;
  return { ...header, rows: Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.rows.length])) };
}

export function encodeDemoMarketArtifact(a: DemoMarketArtifact): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(a), "utf8"), { level: 9 });
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** Parses and shape-checks an artifact; throws on another schema version or a malformed file. */
export function decodeDemoMarketArtifact(bytes: Uint8Array, tables: readonly string[] = DEMO_MARKET_TABLES): DemoMarketArtifact {
  let parsed: unknown;
  try {
    parsed = JSON.parse(gunzipSync(bytes).toString("utf8"));
  } catch (e) {
    throw new Error(`demo market artifact: not a gzipped JSON file — ${e instanceof Error ? e.message : e}`, { cause: e });
  }
  const a = parsed as Partial<DemoMarketArtifact> | null;
  if (a == null || typeof a !== "object") throw new Error("demo market artifact: not an object");
  if (a.schema_version !== DEMO_MARKET_ARTIFACT_SCHEMA_VERSION) {
    throw new Error(
      `demo market artifact: schema_version ${String(a.schema_version)}, this build reads ${DEMO_MARKET_ARTIFACT_SCHEMA_VERSION}; republish it with ${DEMO_MARKET_PUBLISH_JOB_HINT}`
    );
  }
  if (typeof a.generated_at !== "string" || Number.isNaN(Date.parse(a.generated_at))) {
    throw new Error("demo market artifact: generated_at is not an instant");
  }
  if (typeof a.complete_through !== "string" || !YMD.test(a.complete_through)) {
    throw new Error("demo market artifact: complete_through is not a day");
  }
  const spec = a.spec;
  if (
    spec == null ||
    typeof spec.fromMonth !== "string" ||
    !/^\d{4}-\d{2}$/.test(spec.fromMonth) ||
    !Array.isArray(spec.tickers) ||
    typeof spec.withAfp !== "boolean"
  ) {
    throw new Error("demo market artifact: malformed spec");
  }
  if (a.tables == null || typeof a.tables !== "object") throw new Error("demo market artifact: no tables");
  const names = Object.keys(a.tables).sort();
  const want = [...tables].sort();
  if (names.join(",") !== want.join(",")) {
    throw new Error(`demo market artifact: carries tables ${names.join(", ")}; this build loads ${want.join(", ")}`);
  }
  for (const [name, t] of Object.entries(a.tables)) {
    if (!Array.isArray(t.columns) || !Array.isArray(t.rows)) throw new Error(`demo market artifact: malformed table ${name}`);
    for (const r of t.rows) {
      if (!Array.isArray(r) || r.length !== t.columns.length) throw new Error(`demo market artifact: ${name} has a row of the wrong width`);
    }
  }
  return a as DemoMarketArtifact;
}

/**
 * Throws unless the artifact is complete through at most `maxAgeDays` before `buildYesterday`
 * (the Chile day before the build), naming the home-server job that should have refreshed it.
 */
export function assertDemoMarketArtifactFresh(
  a: Pick<DemoMarketArtifact, "complete_through" | "generated_at">,
  buildYesterday: string,
  maxAgeDays: number = DEMO_MARKET_ASSET_MAX_AGE_DAYS
): void {
  const oldest = chileCalendarAddDays(buildYesterday, -maxAgeDays);
  if (a.complete_through < oldest) {
    throw new Error(
      `demo market artifact: complete through ${a.complete_through} (generated ${a.generated_at}), older than ${oldest} ` +
        `(${maxAgeDays} days before ${buildYesterday}); check ${DEMO_MARKET_PUBLISH_JOB_HINT}`
    );
  }
}

/**
 * Throws unless the artifact was built for at least what the build needs: its window opens on or
 * before the build's, it holds every ticker the build's person uses from (or before) the day the
 * build first uses it, and the AFP when the build needs it.
 */
export function assertDemoMarketArtifactCovers(a: DemoMarketArtifact, need: DemoMarketArtifactSpec): void {
  const problems: string[] = [];
  if (a.spec.fromMonth > need.fromMonth) problems.push(`window opens ${a.spec.fromMonth}, the build needs ${need.fromMonth}`);
  if (need.withAfp && !a.spec.withAfp) problems.push("no AFP series");
  const equity = a.tables.equity_daily;
  const firstDay = new Map<string, string>();
  if (equity) {
    const ti = equity.columns.indexOf("ticker");
    const di = equity.columns.indexOf("trade_date");
    if (ti < 0 || di < 0) throw new Error("demo market artifact: equity_daily has no ticker / trade_date column");
    for (const r of equity.rows) {
      const t = String(r[ti]);
      const d = String(r[di]);
      const prev = firstDay.get(t);
      if (prev == null || d < prev) firstDay.set(t, d);
    }
  }
  for (const { ticker, firstUse } of need.tickers) {
    const first = firstDay.get(ticker);
    if (first == null) problems.push(`no ${ticker}`);
    else if (first > firstUse) problems.push(`${ticker} starts ${first}, the build uses it from ${firstUse}`);
  }
  if (problems.length > 0) {
    throw new Error(`demo market artifact: does not cover this build (${problems.join("; ")}); republish it with ${DEMO_MARKET_PUBLISH_JOB_HINT}`);
  }
}

/**
 * Inserts the artifact's rows into `handle`, whose market tables must be empty and carry exactly
 * the artifact's columns. One transaction. Returns the rows written per table.
 */
export function loadDemoMarketArtifactIntoDb(handle: Database.Database, a: DemoMarketArtifact): Record<string, number> {
  const written: Record<string, number> = {};
  handle.transaction(() => {
    for (const [table, t] of Object.entries(a.tables)) {
      const have = tableColumns(handle, table);
      const same = have.length === t.columns.length && [...have].sort().join(",") === [...t.columns].sort().join(",");
      if (!same) {
        throw new Error(
          `demo market artifact: ${table} columns ${t.columns.join(", ")} differ from this schema's ${have.join(", ")}; republish with ${DEMO_MARKET_PUBLISH_JOB_HINT}`
        );
      }
      const stored = (handle.prepare(`SELECT COUNT(*) AS c FROM ${quoteIdent(table)}`).get() as { c: number }).c;
      if (stored > 0) throw new Error(`demo market artifact: ${table} already holds ${stored} rows — not a fresh demo DB`);
      const insert = handle.prepare(
        `INSERT INTO ${quoteIdent(table)} (${t.columns.map(quoteIdent).join(", ")}) VALUES (${t.columns.map(() => "?").join(", ")})`
      );
      for (const r of t.rows) insert.run(...r);
      written[table] = t.rows.length;
    }
  })();
  return written;
}
