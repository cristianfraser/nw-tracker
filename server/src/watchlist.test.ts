import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "./db.js";
import {
  addManualWatchlistTicker,
  deleteManualWatchlistRow,
  getWatchlistPayload,
  normalizeManualWatchlistTicker,
  patchWatchlistRow,
  syncWatchlistFromApp,
} from "./watchlist.js";
import { RISKY_NORRIS_PROXY_BUCKET } from "./watchlistComposite.js";

vi.mock("./globalSyncScheduler.js", () => ({
  notifyGlobalSyncScheduler: vi.fn(),
}));

import { notifyGlobalSyncScheduler } from "./globalSyncScheduler.js";

const TEST_TICKER = "ZZZWL";
const ACCOUNT_TICKER = "ZZWLACC";
const AFP_SERIES = "afp_uno_cuota_a";
const SEED_DAY = "2026-01-02";

/** UNO-A / RN-proxy builtins are inserted only when their backing data exists (demo lacks it). */
function seedAfpUnoFundUnit(): void {
  db.prepare(
    `INSERT OR IGNORE INTO fund_unit_daily (series_key, day, unit_value_clp) VALUES (?, ?, 1000)`
  ).run(AFP_SERIES, SEED_DAY);
}

function seedRiskyNorrisProxyComposite(): void {
  db.prepare(
    `INSERT OR IGNORE INTO watchlist_composite_meta (
       bucket_slug, fintual_managed_fund_id, composition_date,
       anchor_fund_unit_clp, anchor_apv_fund_unit_clp, anchor_basket_usd, anchor_fx_clp, last_sync_ymd
     ) VALUES (?, 4, ?, 4000, NULL, 100, 900, ?)`
  ).run(RISKY_NORRIS_PROXY_BUCKET, SEED_DAY, SEED_DAY);
  db.prepare(
    `INSERT OR IGNORE INTO watchlist_composite_holdings (bucket_slug, ticker, weight, synced_at)
     VALUES (?, 'SPY', 1, ?)`
  ).run(RISKY_NORRIS_PROXY_BUCKET, SEED_DAY);
}

function firstAssetGroupId(): number {
  return (db.prepare(`SELECT id FROM asset_groups ORDER BY id LIMIT 1`).get() as { id: number }).id;
}

afterEach(() => {
  db.prepare(`DELETE FROM market_display_series WHERE series_key IN (?, ?)`).run(
    TEST_TICKER,
    ACCOUNT_TICKER
  );
  db.prepare(`DELETE FROM accounts WHERE equity_ticker = ?`).run(ACCOUNT_TICKER);
  db.prepare(`DELETE FROM fund_unit_daily WHERE series_key = ? AND day = ?`).run(AFP_SERIES, SEED_DAY);
  db.prepare(`DELETE FROM watchlist_composite_meta WHERE bucket_slug = ?`).run(RISKY_NORRIS_PROXY_BUCKET);
  // Drop the personal builtins so a data-less state is restored for the next test / file.
  db.prepare(
    `DELETE FROM market_display_series WHERE slug IN ('afp_uno_cuota_a', 'fintual_risky_norris_proxy')`
  ).run();
  vi.mocked(notifyGlobalSyncScheduler).mockClear();
});

describe("syncWatchlistFromApp", () => {
  it("ensures builtin UF and USD rows exist", () => {
    syncWatchlistFromApp();
    const uf = db.prepare(`SELECT source FROM market_display_series WHERE slug = 'uf'`).get() as
      | { source: string }
      | undefined;
    const usd = db.prepare(`SELECT source FROM market_display_series WHERE slug = 'usd'`).get() as
      | { source: string }
      | undefined;
    expect(uf?.source).toBe("builtin");
    expect(usd?.source).toBe("builtin");
  });

  it("inserts the Risky Norris proxy composite row only once its composition is synced", () => {
    // No composite meta/holdings (e.g. the demo DB) → row absent.
    db.prepare(`DELETE FROM market_display_series WHERE slug = 'fintual_risky_norris_proxy'`).run();
    db.prepare(`DELETE FROM watchlist_composite_meta WHERE bucket_slug = ?`).run(RISKY_NORRIS_PROXY_BUCKET);
    syncWatchlistFromApp();
    expect(
      db.prepare(`SELECT 1 FROM market_display_series WHERE slug = 'fintual_risky_norris_proxy'`).get()
    ).toBeUndefined();

    // Once the composition exists, the builtin appears.
    seedRiskyNorrisProxyComposite();
    syncWatchlistFromApp();
    const row = db
      .prepare(`SELECT kind, series_key FROM market_display_series WHERE slug = 'fintual_risky_norris_proxy'`)
      .get() as { kind: string; series_key: string } | undefined;
    expect(row?.kind).toBe("composite");
    expect(row?.series_key).toBe("fintual_risky_norris_proxy");
  });

  it("inserts the AFP UNO row only once its fund-unit series has data", () => {
    // No afp_uno_cuota_a fund units (e.g. the demo DB) → row absent.
    db.prepare(`DELETE FROM market_display_series WHERE slug = 'afp_uno_cuota_a'`).run();
    db.prepare(`DELETE FROM fund_unit_daily WHERE series_key = ?`).run(AFP_SERIES);
    syncWatchlistFromApp();
    expect(
      db.prepare(`SELECT 1 FROM market_display_series WHERE slug = 'afp_uno_cuota_a'`).get()
    ).toBeUndefined();

    // Once the series has data, a single UNO-A row appears (not legacy afp_uno_rates).
    seedAfpUnoFundUnit();
    syncWatchlistFromApp();
    const rows = db
      .prepare(
        `SELECT slug, label, show_in_rates, rates_chart_title
         FROM market_display_series WHERE series_key = 'afp_uno_cuota_a'`
      )
      .all() as { slug: string; label: string; show_in_rates: number; rates_chart_title: string | null }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.slug).toBe("afp_uno_cuota_a");
    expect(rows[0]?.label).toBe("UNO-A");
    expect(rows[0]?.show_in_rates).toBe(1);
    expect(rows[0]?.rates_chart_title).toBe("UNO-A");
  });

  it("defaults account-derived equity tickers to marquee-checked", () => {
    db.prepare(`INSERT INTO accounts (asset_group_id, name, equity_ticker) VALUES (?, ?, ?)`).run(
      firstAssetGroupId(),
      "Watchlist default fixture",
      ACCOUNT_TICKER
    );
    syncWatchlistFromApp();
    const row = db
      .prepare(`SELECT source, show_in_marquee FROM market_display_series WHERE series_key = ?`)
      .get(ACCOUNT_TICKER) as { source: string; show_in_marquee: number } | undefined;
    expect(row?.source).toBe("account");
    expect(row?.show_in_marquee).toBe(1);
  });
});

describe("manual watchlist CRUD", () => {
  it("adds, patches marquee, and deletes manual ticker rows", () => {
    syncWatchlistFromApp();
    const row = addManualWatchlistTicker(TEST_TICKER);
    expect(row.source).toBe("manual");
    expect(row.show_in_marquee).toBe(1);
    expect(row.series_key).toBe(TEST_TICKER);

    const patched = patchWatchlistRow(row.id, { show_in_marquee: 0 });
    expect(patched.show_in_marquee).toBe(0);

    expect(() => addManualWatchlistTicker(TEST_TICKER)).toThrow(/already/i);

    deleteManualWatchlistRow(row.id);
    const gone = db.prepare(`SELECT 1 FROM market_display_series WHERE id = ?`).get(row.id);
    expect(gone).toBeUndefined();
  });

  it("notifies the sync scheduler without pinning userForcedStale", () => {
    syncWatchlistFromApp();
    addManualWatchlistTicker(TEST_TICKER);
    expect(notifyGlobalSyncScheduler).toHaveBeenCalledTimes(1);
  });

  it("rejects delete on builtin rows", () => {
    syncWatchlistFromApp();
    const uf = db.prepare(`SELECT id FROM market_display_series WHERE slug = 'uf'`).get() as {
      id: number;
    };
    expect(() => deleteManualWatchlistRow(uf.id)).toThrow(/manual/i);
  });
});

describe("normalizeManualWatchlistTicker", () => {
  it("accepts valid symbols and rejects empty", () => {
    expect(normalizeManualWatchlistTicker("  qqq  ")).toBe("QQQ");
    expect(() => normalizeManualWatchlistTicker("")).toThrow(/invalid/i);
    expect(() => normalizeManualWatchlistTicker("bad ticker!")).toThrow(/invalid/i);
  });
});

describe("getWatchlistPayload", () => {
  it("splits app and manual lists", async () => {
    addManualWatchlistTicker(TEST_TICKER);
    const payload = await getWatchlistPayload();
    expect(payload.manual.some((r) => r.series_key === TEST_TICKER)).toBe(true);
    expect(payload.app.some((r) => r.slug === "uf")).toBe(true);
    expect(payload.app.every((r) => r.source !== "manual")).toBe(true);
  });
});
