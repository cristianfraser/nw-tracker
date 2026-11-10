import Database from "better-sqlite3";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  assertDemoMarketArtifactCovers,
  assertDemoMarketArtifactFresh,
  assertOnlyMarketTablesChanged,
  countAllTables,
  decodeDemoMarketArtifact,
  DEMO_MARKET_ARTIFACT_SCHEMA_VERSION,
  DEMO_MARKET_PUBLISH_RESULT_PREFIX,
  demoMarketArtifactMeta,
  encodeDemoMarketArtifact,
  exportDemoMarketArtifact,
  loadDemoMarketArtifactIntoDb,
  parseDemoMarketPublishOutcome,
  type DemoMarketArtifact,
} from "./demoMarketArtifact.js";

// A toy schema shaped like two of the market tables: the module takes its table list as a parameter.
const TABLES = ["equity_daily", "uf_daily"] as const;
function toyDb(): Database.Database {
  const d = new Database(":memory:");
  d.exec(`CREATE TABLE equity_daily (ticker TEXT NOT NULL, trade_date TEXT NOT NULL, close REAL NOT NULL, currency TEXT NOT NULL,
            PRIMARY KEY (ticker, trade_date));
          CREATE TABLE uf_daily (date TEXT PRIMARY KEY, clp_per_uf REAL NOT NULL);
          CREATE TABLE accounts (id INTEGER PRIMARY KEY, name TEXT);
          CREATE TABLE mark_input_changes (id INTEGER PRIMARY KEY, what TEXT);`);
  return d;
}

function filledDb(): Database.Database {
  const d = toyDb();
  const eq = d.prepare(`INSERT INTO equity_daily VALUES (?, ?, ?, ?)`);
  eq.run("SPY", "2024-01-02", 472.65, "usd");
  eq.run("SPY", "2024-01-03", 468.79, "usd");
  eq.run("BTC-USD", "2024-01-01", 44167.333, "usd");
  d.prepare(`INSERT INTO uf_daily VALUES (?, ?)`).run("2024-01-01", 36789.36);
  return d;
}

const HEADER = {
  generated_at: "2026-11-09T04:00:00.000Z",
  complete_through: "2026-11-08",
  spec: { fromMonth: "2015-06", tickers: [{ ticker: "SPY", firstUse: "2024-01-05" }], withAfp: true },
};

describe("demo market artifact", () => {
  it("round-trips the tables through the gzipped file into a fresh DB", () => {
    const a = exportDemoMarketArtifact(filledDb(), HEADER, TABLES);
    expect(a.schema_version).toBe(DEMO_MARKET_ARTIFACT_SCHEMA_VERSION);
    const back = decodeDemoMarketArtifact(encodeDemoMarketArtifact(a), TABLES);
    expect(back).toEqual(a);
    const target = toyDb();
    expect(loadDemoMarketArtifactIntoDb(target, back)).toEqual({ equity_daily: 3, uf_daily: 1 });
    expect(target.prepare(`SELECT * FROM equity_daily ORDER BY ticker, trade_date`).all()).toEqual(
      filledDb().prepare(`SELECT * FROM equity_daily ORDER BY ticker, trade_date`).all()
    );
    expect(target.prepare(`SELECT clp_per_uf FROM uf_daily`).get()).toEqual({ clp_per_uf: 36789.36 });
    expect(demoMarketArtifactMeta(a).rows).toEqual({ equity_daily: 3, uf_daily: 1 });
  });

  it("refuses to load into a table that holds rows or has other columns", () => {
    const a = exportDemoMarketArtifact(filledDb(), HEADER, TABLES);
    expect(() => loadDemoMarketArtifactIntoDb(filledDb(), a)).toThrow(/already holds/);
    const other = new Database(":memory:");
    other.exec(`CREATE TABLE equity_daily (ticker TEXT, trade_date TEXT, close REAL, currency TEXT, source TEXT);
                CREATE TABLE uf_daily (date TEXT PRIMARY KEY, clp_per_uf REAL NOT NULL);`);
    expect(() => loadDemoMarketArtifactIntoDb(other, a)).toThrow(/columns/);
    // One transaction: the failed load wrote nothing.
    expect(other.prepare(`SELECT COUNT(*) AS c FROM uf_daily`).get()).toEqual({ c: 0 });
  });

  it("refuses another schema version, another table set, a bad width or a file that is not gzipped JSON", () => {
    const a = exportDemoMarketArtifact(filledDb(), HEADER, TABLES);
    const enc = (x: unknown) => gzipSync(Buffer.from(JSON.stringify(x)));
    expect(() => decodeDemoMarketArtifact(enc({ ...a, schema_version: 99 }), TABLES)).toThrow(/schema_version 99/);
    expect(() => decodeDemoMarketArtifact(enc(a), ["equity_daily"])).toThrow(/carries tables/);
    const narrow = { ...a, tables: { ...a.tables, uf_daily: { columns: ["date", "clp_per_uf"], rows: [["2024-01-01"]] } } };
    expect(() => decodeDemoMarketArtifact(enc(narrow), TABLES)).toThrow(/wrong width/);
    expect(() => decodeDemoMarketArtifact(Buffer.from("not gzip"), TABLES)).toThrow(/gzipped JSON/);
    expect(() => decodeDemoMarketArtifact(enc({ ...a, complete_through: "yesterday" }), TABLES)).toThrow(/complete_through/);
  });

  it("is fresh while complete through at most the allowed days before the build's yesterday", () => {
    const a = { generated_at: HEADER.generated_at, complete_through: "2026-11-05" };
    expect(() => assertDemoMarketArtifactFresh(a, "2026-11-08", 3)).not.toThrow();
    expect(() => assertDemoMarketArtifactFresh(a, "2026-11-09", 3)).toThrow(/older than 2026-11-06.*demo-market publish/);
    expect(() => assertDemoMarketArtifactFresh({ ...a, complete_through: "2026-11-09" }, "2026-11-08", 0)).not.toThrow();
  });

  it("covers a build whose window, tickers and first uses it reaches", () => {
    const a = exportDemoMarketArtifact(filledDb(), HEADER, TABLES);
    expect(() => assertDemoMarketArtifactCovers(a, { fromMonth: "2016-01", tickers: [{ ticker: "SPY", firstUse: "2024-01-02" }], withAfp: true })).not.toThrow();
    expect(() => assertDemoMarketArtifactCovers(a, { fromMonth: "2015-01", tickers: [], withAfp: true })).toThrow(/window opens 2015-06/);
    expect(() => assertDemoMarketArtifactCovers(a, { fromMonth: "2016-01", tickers: [{ ticker: "QQQ", firstUse: "2024-01-02" }], withAfp: false })).toThrow(/no QQQ/);
    expect(() => assertDemoMarketArtifactCovers(a, { fromMonth: "2016-01", tickers: [{ ticker: "SPY", firstUse: "2023-12-29" }], withAfp: false })).toThrow(
      /SPY starts 2024-01-02/
    );
    const noAfp: DemoMarketArtifact = { ...a, spec: { ...a.spec, withAfp: false } };
    expect(() => assertDemoMarketArtifactCovers(noAfp, { fromMonth: "2016-01", tickers: [], withAfp: true })).toThrow(/no AFP/);
  });

  it("accepts a load that only wrote the market tables and the change log", () => {
    const d = toyDb();
    const before = countAllTables(d);
    const filled = filledDb();
    filled.prepare(`INSERT INTO mark_input_changes (what) VALUES ('x')`).run();
    expect(() => assertOnlyMarketTablesChanged(before, countAllTables(filled), TABLES)).not.toThrow();
    filled.prepare(`INSERT INTO accounts (name) VALUES ('stray')`).run();
    expect(() => assertOnlyMarketTablesChanged(before, countAllTables(filled), TABLES)).toThrow(/accounts 0 → 1/);
    // A market table the loader left empty is a failed load, not a smaller file.
    expect(() => assertOnlyMarketTablesChanged(before, countAllTables(d), TABLES)).toThrow(/left equity_daily empty/);
  });

  it("reads the publish script's result line out of its output", () => {
    const out = `noise\n${DEMO_MARKET_PUBLISH_RESULT_PREFIX}${JSON.stringify({
      complete_through: "2026-11-08",
      generated_at: HEADER.generated_at,
      bytes: 10,
      file: "/x",
      uploaded: true,
      url: "https://example.test",
    })}\n`;
    expect(parseDemoMarketPublishOutcome(out)).toMatchObject({ complete_through: "2026-11-08", uploaded: true });
    // On the server every console line carries the log stamp in front.
    const stamped = out.replace(DEMO_MARKET_PUBLISH_RESULT_PREFIX, `[2026-11-09 -- 22:25:24 (-3)] ${DEMO_MARKET_PUBLISH_RESULT_PREFIX}`);
    expect(parseDemoMarketPublishOutcome(stamped)).toMatchObject({ complete_through: "2026-11-08", uploaded: true });
    expect(() => parseDemoMarketPublishOutcome("Error: boom\n")).toThrow(/no result line/);
  });
});
