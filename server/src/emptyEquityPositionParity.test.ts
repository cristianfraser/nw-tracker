/**
 * The position of a stock with no shares (`equityBrokeragePositionMeta`) is answered from the
 * shares: same position as the priced rule it replaced, for every stock account on two dates
 * at several instants, and no live quote read for an empty position.
 */
import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import { accountUsesEquityMtm } from "./brokerageEquityMtm.js";
import { requireEquityTicker } from "./accountEquityTicker.js";
import {
  equityCloseEod,
  equityHeldSessionQuote,
  equityQuoteCurrency,
  equitySessionYmdForTicker,
  getLiveEquityQuoteFromDb,
  shouldUseLiveEquityQuote,
} from "./equityQuote.js";
import { fxForLiveMtm } from "./fxRates.js";
import { brokerageShareUnitsThroughDate } from "./brokerageFlowMovement.js";
import { equityBrokeragePositionMeta, type AccountPositionMeta } from "./accountPosition.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import {
  PARITY_INSTANTS,
  allAccountIds,
  holdingFixtures,
  observeLiveReads,
  storedStockTicker,
} from "./test/holdingParityFixtures.js";

const fixtures = holdingFixtures();

/** The rule as it was: the price first, the shares last. */
function priorEquityPositionMeta(
  accountId: number,
  ticker: string,
  asOfYmd: string,
  now: Date
): AccountPositionMeta | null {
  const units = brokerageShareUnitsThroughDate(accountId, asOfYmd);
  const out: AccountPositionMeta = {
    ticker,
    units_kind: "shares",
    units: units > 1e-12 && Number.isFinite(units) ? units : null,
  };
  const today = chileCalendarTodayYmd();
  const session = equitySessionYmdForTicker(ticker, now);
  const useLive = asOfYmd === today && shouldUseLiveEquityQuote(ticker, session, now);
  let close: number | null = null;
  let markDate = asOfYmd;
  if (useLive) {
    const live = getLiveEquityQuoteFromDb(ticker);
    if (live) {
      close = live.price;
      markDate = live.trade_date;
    }
  }
  if (close == null && asOfYmd === today) {
    const held = equityHeldSessionQuote(ticker, now);
    if (held) {
      close = held.price;
      markDate = held.trade_date;
    }
  }
  if (close == null) {
    const closeRow = db
      .prepare(
        `SELECT trade_date, close FROM equity_daily WHERE ticker = ? AND trade_date <= ? ORDER BY trade_date DESC LIMIT 1`
      )
      .get(ticker, asOfYmd) as { trade_date: string; close: number } | undefined;
    close = closeRow?.close ?? equityCloseEod(ticker, asOfYmd);
    markDate = closeRow?.trade_date ?? asOfYmd;
  }
  if (close == null || !Number.isFinite(close)) return out;
  const u = out.units;
  if (u == null || u <= 1e-12) return out;
  if (equityQuoteCurrency(ticker) === "clp") {
    out.afp_override_value_clp = Math.round(u * close * 100) / 100;
    out.afp_override_value_as_of = markDate;
    out.afp_override_valor_cuota_clp = Math.round(close * 10000) / 10000;
    return out;
  }
  const fx = fxForLiveMtm(markDate, now);
  if (!fx || fx.clp_per_usd <= 0) return out;
  out.afp_override_value_clp = Math.round(u * close * fx.clp_per_usd * 100) / 100;
  out.afp_override_value_as_of = markDate;
  out.afp_override_valor_cuota_clp = Math.round(close * fx.clp_per_usd * 10000) / 10000;
  return out;
}

describe("the position of a stock with no shares reads no price", () => {
  it("matches the priced rule for every stock account, and reads no quote when empty", () => {
    const soldOut = fixtures.account("sold-out stock", "brokerage_acciones__%", storedStockTicker("VHFU"));
    fixtures.singleLeg(soldOut, "2024-03-01", 1000, 10, "stock_buy", "usd");
    fixtures.singleLeg(soldOut, "2025-03-01", 1200, -10, "stock_sell", "usd");
    const held = fixtures.account("held stock", "brokerage_acciones__%", "VHFU2");
    fixtures.singleLeg(held, "2024-03-01", 1000, 4, "stock_buy", "usd");

    let compared = 0;
    for (const id of allAccountIds()) {
      if (!accountUsesEquityMtm(id)) continue;
      const ticker = requireEquityTicker(id);
      for (const now of PARITY_INSTANTS) {
        for (const asOf of [chileCalendarTodayYmd(), "2025-06-30"]) {
          const before = observeLiveReads(() => priorEquityPositionMeta(id, ticker, asOf, now));
          const after = observeLiveReads(() => equityBrokeragePositionMeta(id, ticker, asOf, now));
          expect(after.out, `stock ${id} position on ${asOf} at ${now.toISOString()}`).toEqual(before.out);
          if (after.out != null && typeof after.out === "object" && after.out.units == null) {
            expect(after.tickers, `empty position ${id} reads no quote`).toEqual([]);
          }
          compared++;
        }
      }
    }
    expect(compared).toBeGreaterThanOrEqual(4 * PARITY_INSTANTS.length);
    const today = chileCalendarTodayYmd();
    const now = PARITY_INSTANTS[1]!;
    const ticker = requireEquityTicker(soldOut);
    expect(observeLiveReads(() => equityBrokeragePositionMeta(soldOut, ticker, today, now)).out).toMatchObject({
      units: null,
    });
    expect(observeLiveReads(() => priorEquityPositionMeta(soldOut, ticker, today, now)).tickers).not.toEqual([]);
  });
});
