import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDaysIso } from "nw-tracker-contracts";
import { accountRowForId } from "./accountRowForMovement.js";
import { accountUsesEquityMtm } from "./brokerageEquityMtm.js";
import { pocketDepositsClpForAccount } from "./accountDeposits.js";
import { clearAggregationCache } from "./cacheRegistry.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { createPanelAccount } from "./createPanelAccount.js";
import { db } from "./db.js";
import { totalDividendsClpForAccount } from "./equityReturns.js";
import { registerInstrument, reloadMarketSymbols } from "./marketSymbols.js";
import { insertMovement } from "./movementWrites.js";
import { validateMovementCreate } from "./movementUnitsPolicy.js";
import { getAccountValuationTimeseries } from "./valuationTimeseries.js";

/**
 * A synthetic peso-quoted stock bought from peso cash, whose dividend is paid to the cash account
 * and reinvested the same day (a DRIP pair). Every row goes through the create API's validator.
 */
const NOTE = "vitest:deposit-series|drip";
const TICKER = "VTDRIPDEP.SN";
const DEPOSIT = 5_000_000;
const BUY = 2_000_000;
const SHARES = 2_000;
const DIVIDEND = 60_000;
const DRIP_SHARES = 50;

describe("getAccountValuationTimeseries deposit lines", () => {
  const created: { account_id: number; asset_group_id: number; created_leaf_bucket: boolean }[] = [];
  let cashId = 0;
  let stockId = 0;
  const today = chileCalendarTodayYmd();
  const depositDay = addDaysIso(today, -100);
  const buyDay = addDaysIso(today, -90);
  const dividendDay = addDaysIso(today, -50);

  function create(accountId: number, body: Record<string, unknown>): number {
    const v = validateMovementCreate(accountRowForId(accountId)!, body, accountId);
    if (!v.ok) throw new Error(`create refused: ${v.error}`);
    if (v.mode === "transfer") {
      return insertMovement({
        fromAccountId: v.from_account_id,
        toAccountId: v.to_account_id,
        amount: v.amount,
        currency: v.currency,
        occurredOn: v.occurred_on,
        note: NOTE,
        unitsDelta: v.units_delta,
        flowKind: v.flow_kind,
      });
    }
    return insertMovement({
      accountId,
      amount: v.amount,
      currency: v.currency,
      occurredOn: v.occurred_on,
      note: NOTE,
      unitsDelta: v.units_delta,
      flowKind: v.flow_kind,
    });
  }

  function removeFixture(): void {
    db.prepare(`DELETE FROM movements WHERE note = ?`).run(NOTE);
    db.prepare(`DELETE FROM equity_daily WHERE ticker = ?`).run(TICKER);
    db.prepare(`DELETE FROM market_symbols WHERE ticker = ?`).run(TICKER);
    reloadMarketSymbols();
    clearAggregationCache();
  }

  beforeAll(() => {
    removeFixture();
    registerInstrument(
      TICKER,
      { quote_currency: "clp", market_kind: "santiago", display_symbol: "VTDRIPDEP", name: "Vitest DRIP stock", exchange: null, instrument_type: null },
      "declared"
    );
    const insClose = db.prepare(`INSERT INTO equity_daily (ticker, trade_date, close, currency) VALUES (?, ?, ?, 'clp')`);
    for (let d = addDaysIso(buyDay, -5); d <= today; d = addDaysIso(d, 1)) {
      insClose.run(TICKER, d, d < dividendDay ? 1_000 : 1_200);
    }
    const panelAccount = (input: Parameters<typeof createPanelAccount>[0]) => {
      const out = createPanelAccount(input);
      created.push(out);
      return out;
    };
    cashId = panelAccount({
      account: {
        account_type: "clp_cash",
        name: "Vitest DRIP deposit cash",
        bucket_slug: "cash_savings",
        category_slug: "vitest_drip_deposit_cash",
        exclude_from_group_totals: true,
      },
    }).account_id;
    stockId = panelAccount({
      account: {
        account_type: "equity",
        bucket_slug: "brokerage_acciones",
        ticker: TICKER,
        name: "Vitest DRIP deposit stock",
        category_slug: "vitest_drip_deposit_stock",
        exclude_from_group_totals: true,
      },
    }).account_id;

    create(cashId, { occurred_on: depositDay, flow_kind: "deposit", amount: DEPOSIT, currency: "clp" });
    create(stockId, {
      occurred_on: buyDay,
      flow_kind: "stock_buy",
      amount: BUY,
      currency: "clp",
      units_delta: SHARES,
      counterpart_account_id: cashId,
      counterpart_role: "from",
    });
    create(stockId, {
      occurred_on: dividendDay,
      flow_kind: "dividend_payout",
      amount: DIVIDEND,
      currency: "clp",
      counterpart_account_id: cashId,
      counterpart_role: "to",
    });
    create(stockId, {
      occurred_on: dividendDay,
      flow_kind: "stock_buy",
      amount: DIVIDEND,
      currency: "clp",
      units_delta: DRIP_SHARES,
      counterpart_account_id: cashId,
      counterpart_role: "from",
    });
    clearAggregationCache();
  });

  afterAll(() => {
    db.prepare(`DELETE FROM movements WHERE note = ?`).run(NOTE);
    for (const c of created) {
      db.prepare(`DELETE FROM accounts WHERE id = ?`).run(c.account_id);
      if (c.created_leaf_bucket) db.prepare(`DELETE FROM asset_groups WHERE id = ?`).run(c.asset_group_id);
    }
    removeFixture();
  });

  it("equity MTM chart deposit line tracks pocket deposits; DRIP dividends net to zero", () => {
    expect(accountUsesEquityMtm(stockId)).toBe(true);
    expect(totalDividendsClpForAccount(stockId)).toBe(DIVIDEND);
    // The dividend leaves the stock and the same pesos come back as the DRIP buy: only the
    // first buy is capital put in.
    expect(pocketDepositsClpForAccount(stockId)).toBe(BUY);

    const ts = getAccountValuationTimeseries(stockId, "clp");
    const acc = ts?.accounts.accounts?.[0];
    expect(acc?.depositDataKey).toBeTruthy();

    const last = ts!.accounts.points.at(-1)!;
    expect(last[acc!.depositDataKey!]).toBe(BUY);
    expect(last[acc!.dataKey]).toBe((SHARES + DRIP_SHARES) * 1_200);
  });
});
