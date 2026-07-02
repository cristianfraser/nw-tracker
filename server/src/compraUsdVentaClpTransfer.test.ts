import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { db } from "./db.js";
import { overrideFxDaily } from "./test/fxDailyFixture.js";
import { validateMovementCreate, type AccountRow } from "./movementUnitsPolicy.js";
import { getMergedDepositInflowEventsForAccount } from "./accountDeposits.js";
import { clpCashBalanceClpAt } from "./clpCashAccounts.js";
import { usdCashBalanceUsdAt } from "./usdCashAccounts.js";

const FIXTURE_USD = "vitest-compra-usd";
const FIXTURE_CLP = "vitest-compra-clp";
const FIXTURE_NOTE = "vitest-compra-transfer";

const DATE = "2026-07-01";
const CLP_SPENT = 5_000_000;
const USD_BOUGHT = 5344.04;

function insertTransfer(v: {
  from_account_id: number;
  to_account_id: number;
  amount_clp: number;
  occurred_on: string;
  flow_kind: string | null;
  amount_usd: number | null;
}): number {
  return Number(
    db
      .prepare(
        `INSERT INTO movements (
           account_id, from_account_id, to_account_id, amount_clp, occurred_on, note,
           units_delta, flow_kind, amount_usd, ticker
         ) VALUES (NULL, ?, ?, ?, ?, ?, NULL, ?, ?, NULL)`
      )
      .run(
        v.from_account_id,
        v.to_account_id,
        v.amount_clp,
        v.occurred_on,
        FIXTURE_NOTE,
        v.flow_kind,
        v.amount_usd
      ).lastInsertRowid
  );
}

let restoreFx: (() => void) | null = null;

describe("compra_usd_venta_clp with a CLP source counterpart", () => {
  let usdId = 0;
  let clpId = 0;
  let usdAccountRow: AccountRow;

  beforeAll(() => {
    const usdLeaf = db
      .prepare(`SELECT id, slug FROM asset_groups WHERE slug LIKE '%__usd' LIMIT 1`)
      .get() as { id: number; slug: string } | undefined;
    const clpLeaf = db
      .prepare(`SELECT id, slug FROM asset_groups WHERE slug LIKE '%__clp' LIMIT 1`)
      .get() as { id: number; slug: string } | undefined;
    if (!usdLeaf || !clpLeaf) return;

    db.prepare(`DELETE FROM movements WHERE note = ?`).run(FIXTURE_NOTE);
    db.prepare(`DELETE FROM accounts WHERE name IN (?, ?)`).run(FIXTURE_USD, FIXTURE_CLP);

    const ins = db.prepare(`INSERT INTO accounts (asset_group_id, name) VALUES (?, ?)`);
    usdId = Number(ins.run(usdLeaf.id, FIXTURE_USD).lastInsertRowid);
    clpId = Number(ins.run(clpLeaf.id, FIXTURE_CLP).lastInsertRowid);
    usdAccountRow = { bucket_slug: usdLeaf.slug, group_slug: usdLeaf.slug };

    restoreFx = overrideFxDaily([[DATE, 935]]);

    // Seed the CLP account with an opening balance so it has funds to spend.
    db.prepare(
      `INSERT INTO movements (account_id, amount_clp, occurred_on, note) VALUES (?, ?, '2026-06-01', ?)`
    ).run(clpId, 8_000_000, FIXTURE_NOTE);
  });

  afterAll(() => {
    restoreFx?.();
    db.prepare(`DELETE FROM movements WHERE note = ?`).run(FIXTURE_NOTE);
    db.prepare(`DELETE FROM accounts WHERE name IN (?, ?)`).run(FIXTURE_USD, FIXTURE_CLP);
  });

  it("validates as a from-CLP → to-USD-cash transfer with both amounts", () => {
    if (!usdId || !clpId) return;
    const v = validateMovementCreate(
      usdAccountRow,
      {
        occurred_on: DATE,
        flow_kind: "compra_usd_venta_clp",
        amount_clp: -CLP_SPENT,
        amount_usd: USD_BOUGHT,
        counterpart_account_id: clpId,
        counterpart_role: "from",
      },
      usdId
    );
    expect(v.ok).toBe(true);
    if (!v.ok || v.mode !== "transfer") return;
    expect(v.from_account_id).toBe(clpId);
    expect(v.to_account_id).toBe(usdId);
    expect(v.flow_kind).toBe("compra_usd_venta_clp");
    expect(v.amount_clp).toBe(CLP_SPENT);
    expect(v.amount_usd).toBe(USD_BOUGHT);
  });

  it("rejects when the destination is not a USD cash account", () => {
    if (!usdId || !clpId) return;
    // current = CLP account, counterpart = USD/from → from=USD, to=CLP → to not USD cash → reject.
    const v = validateMovementCreate(
      { bucket_slug: "brokerage_cash__clp", group_slug: "brokerage_cash__clp" },
      {
        occurred_on: DATE,
        flow_kind: "compra_usd_venta_clp",
        amount_clp: -CLP_SPENT,
        amount_usd: USD_BOUGHT,
        counterpart_account_id: usdId,
        counterpart_role: "from",
      },
      clpId
    );
    expect(v.ok).toBe(false);
  });

  it("debits CLP source, credits USD cash, keeps CLP deposited in step with balance", () => {
    if (!usdId || !clpId) return;

    const clpBalBefore = clpCashBalanceClpAt(clpId, "2026-12-31");
    const clpDepBefore = getMergedDepositInflowEventsForAccount(clpId).reduce((s, e) => s + e.amt, 0);
    const usdBefore = usdCashBalanceUsdAt(usdId, "2026-12-31");

    const v = validateMovementCreate(
      usdAccountRow,
      {
        occurred_on: DATE,
        flow_kind: "compra_usd_venta_clp",
        amount_clp: -CLP_SPENT,
        amount_usd: USD_BOUGHT,
        counterpart_account_id: clpId,
        counterpart_role: "from",
      },
      usdId
    );
    expect(v.ok).toBe(true);
    if (!v.ok || v.mode !== "transfer") return;
    insertTransfer({
      from_account_id: v.from_account_id,
      to_account_id: v.to_account_id,
      amount_clp: v.amount_clp,
      occurred_on: v.occurred_on,
      flow_kind: v.flow_kind,
      amount_usd: v.amount_usd,
    });

    // CLP source balance drops by the pesos spent.
    expect(clpCashBalanceClpAt(clpId, "2026-12-31")).toBeCloseTo(clpBalBefore - CLP_SPENT, 0);
    // USD cash balance rises by the USD bought.
    expect(usdCashBalanceUsdAt(usdId, "2026-12-31") - usdBefore).toBeCloseTo(USD_BOUGHT, 6);
    // CLP deposited line drops in step with the balance — an internal conversion, not a loss.
    const clpDepAfter = getMergedDepositInflowEventsForAccount(clpId).reduce((s, e) => s + e.amt, 0);
    expect(clpDepBefore - clpDepAfter).toBeCloseTo(CLP_SPENT, 0);
  });
});
