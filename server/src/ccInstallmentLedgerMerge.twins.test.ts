import { afterAll, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { installmentPlanBreakdownByMonth } from "./ccInstallmentLedgerDb.js";
import { mergeInstallmentLedgerFromParsedRows } from "./ccInstallmentLedgerMerge.js";
import { mergeInstallmentPurchaseTotalsIntoLines } from "./ccInstallmentPurchaseTotalLines.js";
import type { CcStatementCsvRecord } from "./ccStatementsImport.js";
import { getVitestSantanderCcMasterAccountId, wipeVitestCcFixtureData } from "./test/vitestDbSeed.js";

const emptyMaps = {
  lineOverrides: new Map(),
  merchantRules: new Map(),
  uniquePurchases: new Map(),
  uniquePurchaseModeKeys: new Set<string>(),
};

function fixtureMasterId(): number {
  const id = getVitestSantanderCcMasterAccountId();
  if (id == null) throw new Error("vitest CC fixture master missing — run `npm run test` from server/");
  return id;
}

/**
 * One statement's cuota rows for identical purchases made the same day: identical lines, told
 * apart only by the parser's `#dupN` dedupe keys. `rowIds[n]` is the row of occurrence n.
 */
function twinCuotaRows(opts: {
  merchant: string;
  statementDate: string;
  payBy: string;
  cuota: number;
  keyBase: string;
  rowIds: string[];
}): CcStatementCsvRecord[] {
  return opts.rowIds.map((rowId, n) => ({
    card_group: "A",
    installment_flag: "true",
    transaction_date: "10/01/2025",
    amount_clp: "60000",
    nro_cuota_total: "3",
    nro_cuota_current: String(opts.cuota),
    valor_cuota_mensual_clp: "20000",
    merchant: opts.merchant,
    pay_by: opts.payBy,
    statement_date: opts.statementDate,
    period_to: opts.statementDate,
    source_pdf: `vitest-twin-${opts.statementDate.replace(/\//g, "")}.pdf`,
    dedupe_key: n === 0 ? opts.keyBase : `${opts.keyBase}#dup${n}`,
    row_id: rowId,
    canonical_row_id: rowId,
    is_duplicate_across_statements: "false",
  })) as CcStatementCsvRecord[];
}

type PlanRow = {
  id: number;
  canonical_row_id: string;
  twin_index: number;
  purchase_date: string;
  total_amount_clp: number;
  cuotas_totales: number;
};

function plansFor(accountId: number, merchant: string): PlanRow[] {
  return db
    .prepare(
      `SELECT id, canonical_row_id, twin_index, purchase_date, total_amount_clp, cuotas_totales
       FROM cc_installment_purchases WHERE account_id = ? AND merchant = ? ORDER BY twin_index`
    )
    .all(accountId, merchant) as PlanRow[];
}

function statementPaymentRowIds(purchaseId: number): string[] {
  return (
    db
      .prepare(
        `SELECT parser_row_id FROM cc_installment_payments
         WHERE purchase_id = ? AND parser_row_id NOT LIKE 'synthetic:%' ORDER BY pay_by_date`
      )
      .all(purchaseId) as { parser_row_id: string }[]
  ).map((r) => r.parser_row_id);
}

describe("same-statement twin installment purchases", () => {
  afterAll(() => {
    wipeVitestCcFixtureData();
  });

  it("builds one plan per twin, each paid by its own statement lines", () => {
    const accountId = fixtureMasterId();
    const merchant = "VITEST TWIN SHOP";
    // Row ids deliberately out of `#dup` order: a chain follows the parser's occurrence.
    const jan = twinCuotaRows({
      merchant,
      statementDate: "23/01/2025",
      payBy: "10/02/2025",
      cuota: 1,
      keyBase: "vitest-twin-jan",
      rowIds: ["vt-jan-c", "vt-jan-a", "vt-jan-b"],
    });
    const feb = twinCuotaRows({
      merchant,
      statementDate: "24/02/2025",
      payBy: "10/03/2025",
      cuota: 2,
      keyBase: "vitest-twin-feb",
      rowIds: ["vt-feb-b", "vt-feb-c", "vt-feb-a"],
    });
    mergeInstallmentLedgerFromParsedRows(accountId, [...jan, ...feb]);

    const plans = plansFor(accountId, merchant);
    expect(plans.map((p) => p.twin_index)).toEqual([0, 1, 2]);
    for (const p of plans) {
      expect(p).toMatchObject({ purchase_date: "2025-01-10", total_amount_clp: 60_000, cuotas_totales: 3 });
    }
    expect(plans.map((p) => statementPaymentRowIds(p.id))).toEqual([
      ["vt-jan-c", "vt-feb-b"],
      ["vt-jan-a", "vt-feb-c"],
      ["vt-jan-b", "vt-feb-a"],
    ]);

    // An incremental import (only the newer statement) lands on the same three plans.
    mergeInstallmentLedgerFromParsedRows(accountId, feb);
    expect(plansFor(accountId, merchant).map((p) => p.id)).toEqual(plans.map((p) => p.id));

    // The ledger loader accepts the twins and schedules all three cuotas in every month.
    const canonicalIds = new Set(plans.map((p) => p.canonical_row_id));
    const perMonth = [...installmentPlanBreakdownByMonth(accountId).values()]
      .map((slots) =>
        slots.filter((s) => canonicalIds.has(s.purchase_id)).reduce((sum, s) => sum + s.amount_clp, 0)
      )
      .filter((sum) => sum > 0);
    expect(perMonth).toEqual([60_000, 60_000, 60_000]);

    // «Total» mode keeps one purchase total per twin.
    const totals = mergeInstallmentPurchaseTotalsIntoLines([], [accountId], emptyMaps).filter(
      (ln) => ln.line_role === "installment_purchase_total" && ln.merchant === merchant
    );
    expect(totals.map((t) => t.amount_clp)).toEqual([60_000, 60_000, 60_000]);
  });

  it("refuses a twin that first appears after its twin 0 in one import", () => {
    const accountId = fixtureMasterId();
    const merchant = "VITEST TWIN LATE";
    const jan = twinCuotaRows({
      merchant,
      statementDate: "23/01/2025",
      payBy: "10/02/2025",
      cuota: 1,
      keyBase: "vitest-twin-late-jan",
      rowIds: ["vt-late-jan-a"],
    });
    const feb = twinCuotaRows({
      merchant,
      statementDate: "24/02/2025",
      payBy: "10/03/2025",
      cuota: 2,
      keyBase: "vitest-twin-late-feb",
      rowIds: ["vt-late-feb-a", "vt-late-feb-b"],
    });
    expect(() => mergeInstallmentLedgerFromParsedRows(accountId, [...jan, ...feb])).toThrow(
      /Twin plans start on the same statement/
    );
    expect(plansFor(accountId, merchant)).toEqual([]);
  });

  it("refuses a twin that appears mid-life against the stored ledger", () => {
    const accountId = fixtureMasterId();
    const merchant = "VITEST TWIN MIDLIFE";
    mergeInstallmentLedgerFromParsedRows(
      accountId,
      twinCuotaRows({
        merchant,
        statementDate: "23/01/2025",
        payBy: "10/02/2025",
        cuota: 1,
        keyBase: "vitest-twin-mid-jan",
        rowIds: ["vt-mid-jan-a"],
      })
    );
    const before = plansFor(accountId, merchant);
    expect(before).toHaveLength(1);

    const feb = twinCuotaRows({
      merchant,
      statementDate: "24/02/2025",
      payBy: "10/03/2025",
      cuota: 2,
      keyBase: "vitest-twin-mid-feb",
      rowIds: ["vt-mid-feb-a", "vt-mid-feb-b"],
    });
    expect(() => mergeInstallmentLedgerFromParsedRows(accountId, feb)).toThrow(
      /Twin plans start on the same statement/
    );
    expect(plansFor(accountId, merchant)).toEqual(before);
    expect(statementPaymentRowIds(before[0]!.id)).toEqual(["vt-mid-jan-a"]);
  });
});
