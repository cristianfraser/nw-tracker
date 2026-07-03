import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "./db.js";
import { equityBrokeragePositionMeta } from "./accountPosition.js";
import { LIVE_FX_SYMBOL } from "./liveMarketQuotesConfig.js";
import { clearLiveMarketQuotesForTest, insertLiveMarketQuote } from "./liveMarketQuotesDb.js";
import { BROKERAGE_SHARE_UNITS_FLOW_KINDS } from "./brokerageFlowMovement.js";

afterEach(() => {
  clearLiveMarketQuotesForTest();
});

describe("equityBrokeragePositionMeta", () => {
  it("uses live_market_quotes for Chile today during NYSE session", () => {
    const row = db
      .prepare(
        `SELECT a.id, a.equity_ticker FROM accounts a
         WHERE a.notes = 'import:excel|key=spy' LIMIT 1`
      )
      .get() as { id: number; equity_ticker: string } | undefined;
    if (!row?.equity_ticker) return;

    const hasUnits = db
      .prepare(
        `SELECT 1 FROM movements WHERE account_id = ? AND flow_kind IN (${BROKERAGE_SHARE_UNITS_FLOW_KINDS.map(() => "?").join(", ")}) AND COALESCE(units_delta, 0) != 0 LIMIT 1`
      )
      .get(row.id, ...BROKERAGE_SHARE_UNITS_FLOW_KINDS);
    if (!hasUnits) return;

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-19T15:00:00.000Z"));
    try {
      const fetchedAt = new Date().toISOString();
      insertLiveMarketQuote({
        symbol: "SPY",
        kind: "equity",
        currency: "usd",
        value: 600,
        session_ymd: "2026-05-19",
        previous_value: 590,
        fetched_at: fetchedAt,
      });
      insertLiveMarketQuote({
        symbol: LIVE_FX_SYMBOL,
        kind: "fx_clp_per_usd",
        currency: null,
        value: 900,
        session_ymd: "2026-05-19",
        previous_value: 895,
        fetched_at: fetchedAt,
      });

      const meta = equityBrokeragePositionMeta(row.id, "SPY", "2026-05-19", new Date("2026-05-19T15:00:00.000Z"));
      const units = meta?.units;
      if (units == null || units <= 0) return;

      expect(meta!.afp_override_valor_cuota_clp).toBeCloseTo(600 * 900, 0);
      expect(meta!.afp_override_value_clp).toBeCloseTo(units * 600 * 900, -2);
    } finally {
      vi.useRealTimers();
    }
  });
});
