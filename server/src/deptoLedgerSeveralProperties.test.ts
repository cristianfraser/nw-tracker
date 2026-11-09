import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { loanAccountImportKey, propertyAccountImportKey } from "./accountIdentityKeys.js";
import { deptoPropertyIdOfAccount, propertyLoanPairs } from "./accountRoles.js";
import { clearAggregationCache } from "./cacheRegistry.js";
import { deptoPropertyChartOverlayDailyLines } from "./dailyReferenceLines.js";
import {
  deptoPaymentHumanNote,
  insertLoanPaymentRow,
  loanPaymentColumnsFromPaymentRow,
  upsertPropertyAppraisalUf,
  type DeptoDividendosPaymentRow,
} from "./deptoDividendosLedger.js";
import {
  deptoAccountMarkClpAtYmd,
  deptoLedgerForAccount,
  loadAllDeptoLedgers,
  loadDeptoLedgerForProperty,
} from "./deptoLedgerFromMovements.js";
import { buildRealEstateExpensesPayload, createRealEstatePlace } from "./flowsRealEstateExpenses.js";
import { commitMortgagePayment } from "./mortgagePaymentCreate.js";
import { buildUpcomingPayments } from "./upcomingPayments.js";
import { DEPTO_HIPOTECA_CHART_ACCOUNT_ID, DEPTO_VALOR_CHART_ACCOUNT_ID } from "./valuationTimeseries.js";

/**
 * Two properties, each with its own loan (migration 298's key shapes: `import:property|key=…` /
 * `import:loan|property=…`), far in the past so they never meet generated data: each reads its own
 * depto ledger, «Próximos pagos» lists a cuota per loan, the overlays carry both pairs and the
 * real-estate page puts each loan's cuotas on its own place. Synthetic only; cleaned up.
 */
const UF = 40_000;
const FIXTURE_UF = ["1991-01-10", "1991-02-11", "1991-03-11", "1991-04-11"];
const KEYS = ["vitest_two_a", "vitest_two_b"] as const;

function paymentRow(overrides: Partial<DeptoDividendosPaymentRow>): DeptoDividendosPaymentRow {
  return {
    cuota: "1",
    occurred_on: "1991-02-11",
    amount_clp: 0,
    credito_restante_uf: null,
    min_uf: null,
    max_uf: null,
    amortizacion_clp: null,
    amortizacion_ext_clp: null,
    interes_clp: null,
    incendio_clp: null,
    desgravamen_clp: null,
    ...overrides,
  };
}

describe("several properties, each with its own loan", () => {
  const props: number[] = [];
  const loans: number[] = [];
  const placeSlugs = ["vitest_two_place_a", "vitest_two_place_b"];
  const insertedUf: string[] = [];
  let skip = false;

  beforeAll(() => {
    // A DB with a depto of its own (a dev copy) keeps it; the fixture runs on the lean test DB.
    skip = propertyLoanPairs().length > 0;
    if (skip) return;
    for (const d of FIXTURE_UF) {
      if (!db.prepare(`SELECT 1 FROM uf_daily WHERE date = ?`).get(d)) {
        db.prepare(`INSERT INTO uf_daily (date, clp_per_uf) VALUES (?, ?)`).run(d, UF);
        insertedUf.push(d);
      }
    }
    const group = (slug: string) => {
      const g = db.prepare(`SELECT id FROM asset_groups WHERE slug = ?`).get(slug) as { id: number } | undefined;
      if (!g) throw new Error(`test DB lacks asset group ${slug}`);
      return g.id;
    };
    const ins = db.prepare(`INSERT INTO accounts (asset_group_id, name, notes, import_key) VALUES (?, ?, 'vitest', ?)`);
    // A: the property first; B: the loan first (the triggers pair them either way).
    props[0] = Number(ins.run(group("real_estate__property"), "Two A", propertyAccountImportKey(KEYS[0])).lastInsertRowid);
    loans[0] = Number(ins.run(group("liabilities__mortgage"), "Two A loan", loanAccountImportKey(KEYS[0])).lastInsertRowid);
    loans[1] = Number(ins.run(group("liabilities__mortgage"), "Two B loan", loanAccountImportKey(KEYS[1])).lastInsertRowid);
    props[1] = Number(ins.run(group("real_estate__property"), "Two B", propertyAccountImportKey(KEYS[1])).lastInsertRowid);
    // The lenders, as data.
    const pattern = db.prepare(`INSERT INTO account_roles (account_id, role, param) VALUES (?, 'lender_pattern', ?)`);
    pattern.run(loans[0], "VITESTLENDERA");
    pattern.run(loans[1], "VITESTLENDERB");

    const insMov = db.prepare(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note, flow_kind) VALUES (?, ?, 'clp', ?, ?, ?)`
    );
    // Same cuota numbers and days on both loans: nothing may mix them.
    [0, 1].forEach((i) => {
      const scale = i === 0 ? 1 : 2;
      const rows: DeptoDividendosPaymentRow[] = [
        paymentRow({ cuota: "pie", occurred_on: "1991-01-10", amount_clp: 58_000_000 * scale, credito_restante_uf: 3950 * scale }),
        paymentRow({
          cuota: "1",
          occurred_on: "1991-02-11",
          amount_clp: 1_200_000,
          credito_restante_uf: 3000 * scale,
          amortizacion_clp: 558_400,
          amortizacion_ext_clp: 0,
          interes_clp: 601_500,
          incendio_clp: 20_050,
          desgravamen_clp: 20_050,
          min_uf: 30,
          max_uf: 80,
        }),
      ];
      upsertPropertyAppraisalUf(props[i]!, "1991-01-10", 5400 * scale);
      for (const r of rows) {
        const prop = insMov.run(props[i], r.amount_clp, r.occurred_on, deptoPaymentHumanNote("property", r.cuota, false), null);
        insertLoanPaymentRow({ movement_id: Number(prop.lastInsertRowid), loan_account_id: loans[i]!, leg: "property", origin: "import", ...loanPaymentColumnsFromPaymentRow(r) });
        if (r.cuota !== "pie") {
          const mort = insMov.run(loans[i], r.amount_clp, r.occurred_on, deptoPaymentHumanNote("loan", r.cuota, false), "pago_cuota_hipotecario");
          insertLoanPaymentRow({ movement_id: Number(mort.lastInsertRowid), loan_account_id: loans[i]!, leg: "loan", origin: "import", ...loanPaymentColumnsFromPaymentRow(r) });
        }
      }
    });
    // Cuota 2 of loan A through the payment form's writer (it reads A's ledger only).
    commitMortgagePayment(
      loans[0]!,
      {
        occurred_on: "1991-03-11",
        pago_clp: 800_000,
        interes_clp: 300_000,
        incendio_clp: 40_000,
        desgravamen_clp: 4_000,
        cuota: "2",
        min_uf: 11,
        max_uf: 80,
        credito_restante_uf: 2988.6,
      },
      { origin: "import" }
    );
    createRealEstatePlace({ slug: placeSlugs[0]!, label: "Two place A", propertyAccountId: props[0]! });
    createRealEstatePlace({ slug: placeSlugs[1]!, label: "Two place B", propertyAccountId: props[1]! });
    clearAggregationCache();
  });

  afterAll(() => {
    if (skip) return;
    db.prepare(`DELETE FROM expense_accounts WHERE slug IN (?, ?)`).run(...placeSlugs);
    for (const id of [...props, ...loans]) {
      db.prepare(`DELETE FROM movements WHERE account_id = ?`).run(id);
      db.prepare(`DELETE FROM valuations WHERE account_id = ?`).run(id);
      db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
    }
    for (const d of insertedUf) db.prepare(`DELETE FROM uf_daily WHERE date = ?`).run(d);
    clearAggregationCache();
  });

  it("pairs each property with its own loan through the key shapes", () => {
    if (skip) return;
    expect(propertyLoanPairs()).toEqual([
      { propertyAccountId: props[0], loanAccountId: loans[0] },
      { propertyAccountId: props[1], loanAccountId: loans[1] },
    ]);
    expect(deptoPropertyIdOfAccount(loans[1]!)).toBe(props[1]);
  });

  it("loads the two ledgers apart", () => {
    if (skip) return;
    const a = loadDeptoLedgerForProperty(props[0]!);
    const b = loadDeptoLedgerForProperty(props[1]!);
    expect(a.map((r) => r.cuota)).toEqual(["pie", "1", "2"]);
    expect(b.map((r) => r.cuota)).toEqual(["pie", "1"]);
    expect(b.map((r) => r.credito_restante_uf)).toEqual([7900, 6000]);
    expect(deptoLedgerForAccount(loans[1]!)).toBe(b);
    expect(loadAllDeptoLedgers().map((l) => [l.propertyAccountId, l.loanAccountId, l.rows.length])).toEqual([
      [props[0], loans[0], 3],
      [props[1], loans[1], 2],
    ]);
    // Each loan marks its own balance: A after cuota 2, B after cuota 1.
    expect(deptoAccountMarkClpAtYmd(loans[0]!, "1991-03-11")?.value_clp).toBe(Math.round(2988.6 * UF));
    expect(deptoAccountMarkClpAtYmd(loans[1]!, "1991-03-11")?.value_clp).toBe(Math.round(6000 * UF));
    expect(deptoAccountMarkClpAtYmd(props[1]!, "1991-03-11")?.value_clp).toBe(Math.round((10800 - 6000) * UF));
  });

  it("lists a mortgage cuota per loan in «Próximos pagos»", () => {
    if (skip) return;
    const items = buildUpcomingPayments("1991-03-20").months.flatMap((m) => m.items).filter((p) => p.kind === "mortgage");
    const first = (loanId: number) => items.find((p) => p.key.startsWith(`mortgage|${loanId}|`));
    expect(first(loans[0]!)?.key).toBe(`mortgage|${loans[0]}|3`);
    expect(first(loans[1]!)?.key).toBe(`mortgage|${loans[1]}|2`);
    expect(first(loans[0]!)?.route_path).toBe(`/account/${loans[0]}`);
    expect(first(loans[1]!)?.name).toBe("Two place B");
  });

  it("carries both pairs' overlay lines, the first on the historical ids", () => {
    if (skip) return;
    const lines = deptoPropertyChartOverlayDailyLines([props[1]!, props[0]!], ["1991-03-11", "1991-03-12"], "clp");
    expect(lines.map((l) => l.account_id)).toEqual([
      DEPTO_HIPOTECA_CHART_ACCOUNT_ID,
      DEPTO_VALOR_CHART_ACCOUNT_ID,
      -(10_000 + 2 * props[1]!),
      -(10_001 + 2 * props[1]!),
    ]);
    expect(lines[0]!.values[0]).toBe(Math.round(2988.6 * UF));
    expect(lines[2]!.values[0]).toBe(Math.round(6000 * UF));
    expect(lines[3]!.values[0]).toBe(Math.round(10800 * UF));
  });

  it("puts each loan's cuotas on its own place on the real-estate page", () => {
    if (skip) return;
    const slots = buildRealEstateExpensesPayload().slots.filter((s) => s.kind === "mortgage");
    const cuotasOf = (slug: string) => slots.filter((s) => s.account_slug === slug).map((s) => s.spent_on).sort();
    expect(cuotasOf(placeSlugs[0]!)).toEqual(["1991-02-11", "1991-03-11"]);
    expect(cuotasOf(placeSlugs[1]!)).toEqual(["1991-02-11"]);
  });

  it("refuses a loan payment row the roles cannot place", () => {
    if (skip) return;
    db.prepare(`UPDATE accounts SET import_key = NULL WHERE id = ?`).run(loans[1]);
    try {
      clearAggregationCache();
      expect(() => loadDeptoLedgerForProperty(props[0]!)).toThrow(/is the loan of no property|but property .*'s loan is none/);
    } finally {
      db.prepare(`UPDATE accounts SET import_key = ? WHERE id = ?`).run(loanAccountImportKey(KEYS[1]), loans[1]);
      clearAggregationCache();
    }
  });
});
