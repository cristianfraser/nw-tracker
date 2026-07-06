import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { db } from "./db.js";
import { overrideFxDaily } from "./test/fxDailyFixture.js";
import { validateMovementCreate, type AccountRow } from "./movementUnitsPolicy.js";
import { loadEquityBrokerageCapitalInflowEvents } from "./equityBrokerageCapitalFlows.js";
import { getMergedDepositInflowEventsForAccount } from "./accountDeposits.js";
import { brokerageShareUnitsThroughDate } from "./brokerageFlowMovement.js";
import { usdCashBalanceUsdAt } from "./usdCashAccounts.js";
import { usdToClpReferenceRounded } from "./fxRates.js";

const FIXTURE_USD = "vitest-dividend-payout-usd";
const FIXTURE_STOCK = "vitest-dividend-payout-stock";
const FIXTURE_NOTE = "vitest-dividend-payout";

const DIV_DATE = "2026-05-28";
const DIV_USD = 20;

function insertValidatedTransfer(v: {
  from_account_id: number;
  to_account_id: number;
  amount_clp: number;
  occurred_on: string;
  note: string | null;
  units_delta: number | null;
  flow_kind: string | null;
  amount_usd: number | null;
  ticker: string | null;
}): number {
  return Number(
    db
      .prepare(
        `INSERT INTO movements (
           account_id, from_account_id, to_account_id, amount_clp, occurred_on, note,
           units_delta, flow_kind, amount_usd, ticker
         ) VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        v.from_account_id,
        v.to_account_id,
        v.amount_clp,
        v.occurred_on,
        v.note ?? FIXTURE_NOTE,
        v.units_delta,
        v.flow_kind,
        v.amount_usd,
        v.ticker
      ).lastInsertRowid
  );
}

let restoreFx: (() => void) | null = null;

describe("dividend_payout (stock cash dividend → USD cash)", () => {
  let usdId = 0;
  let stockId = 0;
  let usdAccountRow: AccountRow;

  beforeAll(() => {
    const stockLeaf = db
      .prepare(`SELECT id, slug FROM asset_groups WHERE slug LIKE 'brokerage_acciones__%' LIMIT 1`)
      .get() as { id: number; slug: string } | undefined;
    const usdLeaf = db
      .prepare(`SELECT id, slug FROM asset_groups WHERE slug LIKE '%__usd' LIMIT 1`)
      .get() as { id: number; slug: string } | undefined;
    if (!stockLeaf || !usdLeaf) return;

    db.prepare(`DELETE FROM movements WHERE note = ?`).run(FIXTURE_NOTE);
    db.prepare(`DELETE FROM accounts WHERE name IN (?, ?)`).run(FIXTURE_USD, FIXTURE_STOCK);

    const ins = db.prepare(`INSERT INTO accounts (asset_group_id, name, equity_ticker) VALUES (?, ?, ?)`);
    usdId = Number(ins.run(usdLeaf.id, FIXTURE_USD, null).lastInsertRowid);
    stockId = Number(ins.run(stockLeaf.id, FIXTURE_STOCK, "VITEST").lastInsertRowid);
    usdAccountRow = { bucket_slug: usdLeaf.slug, group_slug: usdLeaf.slug };

    restoreFx = overrideFxDaily([
      ["2026-05-05", 900],
      [DIV_DATE, 950],
    ]);

    // Seed a stock_buy so the stock has positive deposited capital and 3 shares.
    insertValidatedTransfer({
      from_account_id: usdId,
      to_account_id: stockId,
      amount_clp: 0,
      occurred_on: "2026-05-05",
      note: FIXTURE_NOTE,
      units_delta: 3,
      flow_kind: "stock_buy",
      amount_usd: 300,
      ticker: "VITEST",
    });
  });

  afterAll(() => {
    restoreFx?.();
    db.prepare(`DELETE FROM movements WHERE note = ?`).run(FIXTURE_NOTE);
    db.prepare(`DELETE FROM accounts WHERE name IN (?, ?)`).run(FIXTURE_USD, FIXTURE_STOCK);
  });

  it("validates as a from-stock → to-usd-cash transfer with amount_usd", () => {
    if (!usdId || !stockId) return;
    const v = validateMovementCreate(
      usdAccountRow,
      {
        occurred_on: DIV_DATE,
        flow_kind: "dividend_payout",
        amount_usd: DIV_USD,
        counterpart_account_id: stockId,
        counterpart_role: "from",
      },
      usdId
    );
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.mode).toBe("transfer");
    if (v.mode !== "transfer") return;
    expect(v.from_account_id).toBe(stockId);
    expect(v.to_account_id).toBe(usdId);
    expect(v.flow_kind).toBe("dividend_payout");
    expect(v.amount_usd).toBe(DIV_USD);
    expect(v.units_delta).toBeNull();
  });

  it("rejects dividend_payout with a non-equity origin", () => {
    if (!usdId || !stockId) return;
    // origin = USD cash (not an equity account) → must be rejected fail-fast.
    const v = validateMovementCreate(
      usdAccountRow,
      {
        occurred_on: DIV_DATE,
        flow_kind: "dividend_payout",
        amount_usd: DIV_USD,
        counterpart_account_id: usdId,
        counterpart_role: "from",
      },
      stockId
    );
    // current=stock, counterpart=usd/from → from=usd, to=stock; to is not USD cash → error.
    expect(v.ok).toBe(false);
  });

  it("credits USD cash, reduces stock deposited, leaves shares unchanged", () => {
    if (!usdId || !stockId) return;

    const depositedBefore = getMergedDepositInflowEventsForAccount(stockId).reduce(
      (s, e) => s + e.amt,
      0
    );
    const sharesBefore = brokerageShareUnitsThroughDate(stockId, "2026-12-31");
    const usdBefore = usdCashBalanceUsdAt(usdId, "2026-12-31");

    const v = validateMovementCreate(
      usdAccountRow,
      {
        occurred_on: DIV_DATE,
        flow_kind: "dividend_payout",
        amount_usd: DIV_USD,
        counterpart_account_id: stockId,
        counterpart_role: "from",
      },
      usdId
    );
    expect(v.ok).toBe(true);
    if (!v.ok || v.mode !== "transfer") return;
    insertValidatedTransfer(v);

    // USD cash balance goes up by the dividend USD.
    const usdAfter = usdCashBalanceUsdAt(usdId, "2026-12-31");
    expect(usdAfter - usdBefore).toBeCloseTo(DIV_USD, 6);

    // Stock deposited / cost-basis line drops by the USD reference CLP at the dividend date.
    const refClp = usdToClpReferenceRounded(DIV_USD, DIV_DATE)!;
    const depositedAfter = getMergedDepositInflowEventsForAccount(stockId).reduce(
      (s, e) => s + e.amt,
      0
    );
    expect(depositedBefore - depositedAfter).toBeCloseTo(refClp, 0);

    // The capital-flow event for the dividend is negative (return of capital).
    const divEvent = (loadEquityBrokerageCapitalInflowEvents([stockId]).get(stockId) ?? [])
      .filter((e) => e.occurred_on === DIV_DATE);
    expect(divEvent).toHaveLength(1);
    expect(divEvent[0]!.amt).toBeLessThan(0);

    // Shares are unchanged — a cash dividend, not a sale.
    const sharesAfter = brokerageShareUnitsThroughDate(stockId, "2026-12-31");
    expect(sharesAfter).toBeCloseTo(sharesBefore, 6);
  });
});
