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

vi.mock("./globalSyncScheduler.js", () => ({
  notifyGlobalSyncScheduler: vi.fn(),
}));

import { notifyGlobalSyncScheduler } from "./globalSyncScheduler.js";

const TEST_TICKER = "ZZZWL";

afterEach(() => {
  db.prepare(`DELETE FROM market_display_series WHERE series_key = ?`).run(TEST_TICKER);
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

  it("ensures Risky Norris proxy composite row exists", () => {
    syncWatchlistFromApp();
    const row = db
      .prepare(`SELECT kind, series_key FROM market_display_series WHERE slug = 'fintual_risky_norris_proxy'`)
      .get() as { kind: string; series_key: string } | undefined;
    expect(row?.kind).toBe("composite");
    expect(row?.series_key).toBe("fintual_risky_norris_proxy");
  });

  it("keeps a single AFP UNO row (UNO-A, not legacy afp_uno_rates)", () => {
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
