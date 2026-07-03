import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { checkingAccountId } from "./checkingCartolaImport.js";
import { checkingCartolaStablePurchaseKey } from "./checkingCartolaParse.js";
import { createPanelAccount } from "./createPanelAccount.js";
import { buildDepositsReconciliationPayload } from "./flowsDepositsReconciliation.js";
import { buildFlowsCheckingIncomePayload } from "./flowsCheckingInflows.js";
import { buildFlowsCreditCardExpensesPayload } from "./flowsCreditCardExpenses.js";
import { seedNavTree } from "./seedNavTree.js";

/**
 * End-to-end coverage for the generic CLP-cash buffer pattern (e.g. a "Fintual CLP" panel
 * account, identical to "Racional CLP"): a Fintual fund redemption is wired to checking as
 * *split* wires (13M leaves the fund, 7M + 6M arrive on the cartola). Routed through a CLP
 * cash buffer the ledger is:
 *
 *   fund −13M  →  buffer +13M      (internal net-worth transfer, no checking counterpart)
 *   buffer −7M →  checking +7M     (plain redemption, exact-amount match)
 *   buffer −6M →  checking +6M     (plain redemption, exact-amount match)
 *
 * No buffer-specific code paths exist (unlike the legacy Buda wallet): everything must flow
 * through the shared matcher + deposits reconciliation as generic CLP-cash behavior.
 */

const FIXTURE_NOTE = "vitest:clp-buffer";

type CartolaFixture = {
  accountId: number;
  occurredOn: string;
  amountClp: number;
  idx: number;
  month: string;
};

const cartolaFixtures: CartolaFixture[] = [];

function insertCartolaMovement(
  accountId: number,
  occurredOn: string,
  amountClp: number,
  description: string,
  idx: number
): number {
  const month = occurredOn.slice(0, 7);
  const note =
    `import:cartola|${month}|Agustinas|${description}` +
    `|on:${occurredOn}|amt:${amountClp}|idx:${idx}`;
  const ins = db
    .prepare(
      `INSERT INTO movements (account_id, amount_clp, occurred_on, note, units_delta)
       VALUES (?, ?, ?, ?, NULL)`
    )
    .run(accountId, amountClp, occurredOn, note);
  cartolaFixtures.push({ accountId, occurredOn, amountClp, idx, month });
  return Number(ins.lastInsertRowid);
}

function insertLedgerMovement(
  accountId: number,
  occurredOn: string,
  amountClp: number,
  flowKind: string | null = null
): number {
  const ins = db
    .prepare(
      `INSERT INTO movements (account_id, amount_clp, occurred_on, note, flow_kind, units_delta)
       VALUES (?, ?, ?, ?, ?, NULL)`
    )
    .run(accountId, amountClp, occurredOn, FIXTURE_NOTE, flowKind);
  return Number(ins.lastInsertRowid);
}

function cleanupFixtureRows(): void {
  db.prepare(`DELETE FROM movements WHERE note = ?`).run(FIXTURE_NOTE);
  db.prepare(`DELETE FROM movements WHERE note LIKE 'import:cartola|%vitest-clp-buffer%'`).run();
  for (const f of cartolaFixtures) {
    db.prepare(
      `DELETE FROM movements WHERE account_id = ? AND occurred_on = ? AND note LIKE ?`
    ).run(f.accountId, f.occurredOn, `import:cartola|%|idx:${f.idx}`);
    for (const portion of ["gastos", "deposit"] as const) {
      const key = checkingCartolaStablePurchaseKey(
        f.accountId,
        `import:cartola|${f.month}|x|d|on:${f.occurredOn}|amt:${f.amountClp}|idx:${f.idx}`,
        portion
      );
      if (key) {
        db.prepare(`DELETE FROM cc_expense_unique_purchases WHERE purchase_key = ?`).run(key);
        db.prepare(`DELETE FROM expense_deposit_links WHERE purchase_key = ?`).run(key);
      }
    }
  }
  cartolaFixtures.length = 0;
}

describe("CLP cash buffer (panel clp_cash account) reconciliation", () => {
  let checkingId: number;
  let fundId: number;
  let bufferId: number;

  beforeAll(() => {
    checkingId = checkingAccountId();
    const fund = db.prepare(`SELECT id FROM accounts WHERE notes = 'demo:fondo'`).get() as
      | { id: number }
      | undefined;
    if (!fund) throw new Error("expected demo:fondo account in test DB");
    fundId = fund.id;

    const existing = db
      .prepare(`SELECT id FROM accounts WHERE name = 'Vitest Fintual CLP'`)
      .get() as { id: number } | undefined;
    if (existing) {
      bufferId = existing.id;
    } else {
      const created = createPanelAccount({
        account: {
          account_type: "clp_cash",
          name: "Vitest Fintual CLP",
          bucket_slug: "brokerage_cash",
          category_slug: "vitest_fintual_clp",
          exclude_from_group_totals: false,
        },
      });
      bufferId = created.account_id;
    }
  });

  afterEach(() => {
    cleanupFixtureRows();
    // Re-sync the auto links so no expense_deposit_links row points at deleted movements.
    buildFlowsCreditCardExpensesPayload();
  });

  afterAll(() => {
    db.prepare(`DELETE FROM portfolio_group_items WHERE account_id = ? AND item_kind = 'account'`).run(
      bufferId
    );
    db.prepare(`DELETE FROM account_sync_sources WHERE account_id = ?`).run(bufferId);
    db.prepare(`DELETE FROM accounts WHERE id = ?`).run(bufferId);
    db.prepare(`DELETE FROM asset_groups WHERE slug = 'brokerage_cash__vitest_fintual_clp__clp'`).run();
    seedNavTree();
  });

  it("resolves fund → buffer (movement pair) as an internal transfer on both sides", () => {
    insertLedgerMovement(fundId, "2099-05-02", -13_000_000);
    insertLedgerMovement(bufferId, "2099-05-03", 13_000_000, "deposit_clp");

    const payload = buildDepositsReconciliationPayload();

    const depositRow = payload.rows.find(
      (r) => r.account_id === bufferId && Math.round(r.amount_clp) === 13_000_000
    );
    expect(depositRow?.status).toBe("resolved_internal_transfer");

    const redemptionRow = payload.redemptions.find(
      (r) => r.account_id === fundId && Math.round(r.amount_clp) === 13_000_000
    );
    expect(redemptionRow?.status).toBe("resolved_internal_transfer");
  });

  it("resolves fund → buffer recorded as a transfer row without creating a deposit to link", () => {
    db.prepare(
      `INSERT INTO movements (account_id, from_account_id, to_account_id, amount_clp, occurred_on, note)
       VALUES (NULL, ?, ?, ?, ?, ?)`
    ).run(fundId, bufferId, 13_000_000, "2099-05-02", FIXTURE_NOTE);

    const payload = buildDepositsReconciliationPayload();

    // The from-leg is internal by construction (the row itself names the destination).
    const redemptionRow = payload.redemptions.find(
      (r) => r.account_id === fundId && Math.round(r.amount_clp) === 13_000_000
    );
    expect(redemptionRow?.status).toBe("resolved_internal_transfer");

    // The to-leg is a transfer leg, not a movement — nothing shows up demanding a checking link.
    const depositRow = payload.rows.find(
      (r) => r.account_id === bufferId && Math.round(r.amount_clp) === 13_000_000
    );
    expect(depositRow).toBeUndefined();
  });

  it("links buffer → checking split wires (7M + 6M) as two redemptions", () => {
    insertLedgerMovement(bufferId, "2099-05-04", -7_000_000, "withdrawal_clp");
    insertLedgerMovement(bufferId, "2099-05-04", -6_000_000, "withdrawal_clp");
    const wire7 = insertCartolaMovement(
      checkingId,
      "2099-05-05",
      7_000_000,
      "0768106274 Transf. Fintual AGF",
      9973001
    );
    const wire6 = insertCartolaMovement(
      checkingId,
      "2099-05-05",
      6_000_000,
      "0768106274 Transf. Fintual AGF",
      9973002
    );

    // The wires are excluded from income (capital return), consuming the buffer outflows.
    const income = buildFlowsCheckingIncomePayload();
    expect(income.lines.some((l) => l.movement_id === wire7)).toBe(false);
    expect(income.lines.some((l) => l.movement_id === wire6)).toBe(false);

    const payload = buildDepositsReconciliationPayload();
    const bufferRedemptions = payload.redemptions.filter((r) => r.account_id === bufferId);
    expect(bufferRedemptions.map((r) => Math.round(r.amount_clp)).sort()).toEqual([
      6_000_000, 7_000_000,
    ]);
    for (const r of bufferRedemptions) {
      expect(r.status).toBe("linked");
    }
  });

  it("reconciles the full split-withdrawal scenario end-to-end (13M → 7M + 6M)", () => {
    insertLedgerMovement(fundId, "2099-05-02", -13_000_000);
    insertLedgerMovement(bufferId, "2099-05-03", 13_000_000, "deposit_clp");
    insertLedgerMovement(bufferId, "2099-05-04", -7_000_000, "withdrawal_clp");
    insertLedgerMovement(bufferId, "2099-05-04", -6_000_000, "withdrawal_clp");
    insertCartolaMovement(
      checkingId,
      "2099-05-05",
      7_000_000,
      "0768106274 Transf. Fintual AGF",
      9973003
    );
    insertCartolaMovement(
      checkingId,
      "2099-05-05",
      6_000_000,
      "0768106274 Transf. Fintual AGF",
      9973004
    );

    const payload = buildDepositsReconciliationPayload();

    const depositRow = payload.rows.find(
      (r) => r.account_id === bufferId && Math.round(r.amount_clp) === 13_000_000
    );
    expect(depositRow?.status).toBe("resolved_internal_transfer");

    const fundRedemption = payload.redemptions.find((r) => r.account_id === fundId);
    expect(fundRedemption?.status).toBe("resolved_internal_transfer");

    const bufferRedemptions = payload.redemptions.filter((r) => r.account_id === bufferId);
    expect(bufferRedemptions).toHaveLength(2);
    for (const r of bufferRedemptions) {
      expect(r.status).toBe("linked");
    }
  });

  it("links a checking → buffer funding wire as a deposit through the gastos matcher", () => {
    const bufferIn = insertLedgerMovement(bufferId, "2099-06-02", 5_000_000, "deposit_clp");
    insertCartolaMovement(
      checkingId,
      "2099-06-01",
      -5_000_000,
      "0768106274 Transf a Fintual",
      9973005
    );

    // Gastos build runs the matcher and syncs expense_deposit_links.
    buildFlowsCreditCardExpensesPayload();

    const payload = buildDepositsReconciliationPayload();
    const depositRow = payload.rows.find((r) => r.movement_id === bufferIn);
    expect(depositRow?.status).toBe("linked");
  });
});
