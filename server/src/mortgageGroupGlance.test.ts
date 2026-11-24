import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addCalendarMonths } from "nw-tracker-contracts";
import { db } from "./db.js";
import { loanAccountImportKey, propertyAccountImportKey } from "./accountIdentityKeys.js";
import { propertyLoanPairs } from "./accountRoles.js";
import { cachedAccountDetailBundle } from "./accountDetailBundle.js";
import { clearAggregationCache } from "./cacheRegistry.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import {
  deptoPaymentHumanNote,
  insertLoanPaymentRow,
  loanPaymentColumnsFromPaymentRow,
  upsertPropertyAppraisalUf,
  type DeptoDividendosPaymentRow,
} from "./deptoDividendosLedger.js";
import { buildMortgageGroupGlance, MORTGAGE_GROUP_SLUG } from "./mortgageGroupGlance.js";

/**
 * Two synthetic properties, each with its own loan, paid inside the test person's market window
 * (so every day has its UF and dollar): the group page lists each loan with its own page's
 * figures and sums them in the request's unit. Cleaned up.
 */
const KEYS = ["vitest_group_a", "vitest_group_b"] as const;

function paymentRow(overrides: Partial<DeptoDividendosPaymentRow>): DeptoDividendosPaymentRow {
  return {
    cuota: "1",
    occurred_on: "",
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

describe("mortgage group glance", () => {
  const props: number[] = [];
  const loans: number[] = [];
  let skip = false;

  beforeAll(() => {
    // A DB with a depto of its own (a dev copy) keeps it; the fixture runs on the lean test DB.
    skip = propertyLoanPairs().length > 0;
    if (skip) return;
    const group = (slug: string) => {
      const g = db.prepare(`SELECT id FROM asset_groups WHERE slug = ?`).get(slug) as { id: number } | undefined;
      if (!g) throw new Error(`test DB lacks asset group ${slug}`);
      return g.id;
    };
    const ins = db.prepare(`INSERT INTO accounts (asset_group_id, name, notes, import_key) VALUES (?, ?, 'vitest', ?)`);
    KEYS.forEach((key, i) => {
      props[i] = Number(ins.run(group("real_estate__property"), `Group ${i}`, propertyAccountImportKey(key)).lastInsertRowid);
      loans[i] = Number(ins.run(group("liabilities__mortgage"), `Group loan ${i}`, loanAccountImportKey(key)).lastInsertRowid);
    });
    // Filed under Pasivos › mortgage, as the boot seed files a loan.
    const mortgageGroup = db.prepare(`SELECT id FROM liability_groups WHERE slug = ?`).get(MORTGAGE_GROUP_SLUG) as { id: number } | undefined;
    if (!mortgageGroup) throw new Error("test DB lacks the mortgage liability group");
    const file = db.prepare(`INSERT INTO liability_group_items (group_id, item_kind, account_id, sort_order) VALUES (?, 'account', ?, ?)`);
    loans.forEach((id, i) => file.run(mortgageGroup.id, id, 90 + i));
    const insMov = db.prepare(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note, flow_kind) VALUES (?, ?, 'clp', ?, ?, ?)`
    );
    const month = (back: number) => `${addCalendarMonths(chileCalendarTodayYmd().slice(0, 7), -back)}-11`;
    [0, 1].forEach((i) => {
      const scale = i === 0 ? 1 : 2;
      const cuota = (n: number, back: number, balance: number): DeptoDividendosPaymentRow =>
        paymentRow({
          cuota: String(n),
          occurred_on: month(back),
          amount_clp: 1_200_000,
          credito_restante_uf: balance,
          amortizacion_clp: 558_400,
          amortizacion_ext_clp: 0,
          interes_clp: 601_500,
          incendio_clp: 20_050,
          desgravamen_clp: 20_050,
          min_uf: 30,
          max_uf: 80,
        });
      const rows = [
        paymentRow({ cuota: "pie", occurred_on: month(5), amount_clp: 58_000_000 * scale, credito_restante_uf: 3000 * scale }),
        cuota(1, 4, 3000 * scale - 14),
        cuota(2, 3, 3000 * scale - 28),
        cuota(3, 2, 3000 * scale - 42),
      ];
      upsertPropertyAppraisalUf(props[i]!, month(5), 5400 * scale);
      for (const r of rows) {
        const prop = insMov.run(props[i], r.amount_clp, r.occurred_on, deptoPaymentHumanNote("property", r.cuota, false), null);
        insertLoanPaymentRow({ movement_id: Number(prop.lastInsertRowid), loan_account_id: loans[i]!, leg: "property", origin: "import", ...loanPaymentColumnsFromPaymentRow(r) });
        if (r.cuota !== "pie") {
          const mort = insMov.run(loans[i], r.amount_clp, r.occurred_on, deptoPaymentHumanNote("loan", r.cuota, false), "pago_cuota_hipotecario");
          insertLoanPaymentRow({ movement_id: Number(mort.lastInsertRowid), loan_account_id: loans[i]!, leg: "loan", origin: "import", ...loanPaymentColumnsFromPaymentRow(r) });
        }
      }
    });
    clearAggregationCache();
  });

  afterAll(() => {
    if (skip) return;
    for (const id of loans) db.prepare(`DELETE FROM liability_group_items WHERE account_id = ?`).run(id);
    for (const id of [...props, ...loans]) {
      db.prepare(`DELETE FROM movements WHERE account_id = ?`).run(id);
      db.prepare(`DELETE FROM valuations WHERE account_id = ?`).run(id);
      db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
    }
    clearAggregationCache();
  });

  it("is only the mortgage group's", async () => {
    expect(await buildMortgageGroupGlance("liabilities", "clp")).toBeNull();
  });

  it.each(["clp", "usd"] as const)("lists each loan with its page's figures and sums them in %s", async (unit) => {
    if (skip) return;
    const g = await buildMortgageGroupGlance(MORTGAGE_GROUP_SLUG, unit);
    if (g == null) throw new Error("no glance");
    expect(g.unit).toBe(unit);
    expect(g.loans.map((l) => l.account_id)).toEqual(loans);

    let balance = 0;
    let total = 0;
    let costTotal = 0;
    let paymentRows = 0;
    let paidPay = 0;
    for (const loan of g.loans) {
      const page = (await cachedAccountDetailBundle(loan.account_id, unit, "monthly"))?.depto_glance;
      if (page?.kind !== "mortgage") throw new Error(`account ${loan.account_id} has no mortgage glance`);
      expect(loan.balance_loan).toBe(page.header.hero_loan);
      expect(loan.balance).toBe(page.header.hero ?? page.header.hero_loan);
      expect(loan.paid_share).toBe(page.mortgage.balance.paid_share);
      expect(loan.prepaid_loan).toBe(page.mortgage.balance.prepaid_loan);
      expect(loan.next?.date ?? null).toBe(page.mortgage.payments.next?.date ?? null);
      expect(loan.payoff?.date ?? null).toBe(page.mortgage.projection?.usual.end_date ?? null);
      balance += loan.balance;
      total += page.header.strip.total;
      costTotal += page.mortgage.balance.financing_cost.total;
      paymentRows += page.mortgage.payments.rows.length;
      paidPay += page.mortgage.payments.totals.paid_pay;
      // Each loan's rows are its page's, keyed by account, tagged with the loan.
      const mine = g.payments!.rows.filter((r) => r.loan?.account_id === loan.account_id);
      expect(mine.map((r) => r.key)).toEqual(page.mortgage.payments.rows.map((r) => `${loan.account_id}:${r.key}`));
      expect(mine.map((r) => r.paid_pay)).toEqual(page.mortgage.payments.rows.map((r) => r.paid_pay));
    }
    // One list: newest first, every payment once, one Σ row, each loan's next cuota.
    const dates = g.payments!.rows.map((r) => r.date);
    expect(dates).toEqual([...dates].sort().reverse());
    expect(g.payments!.rows).toHaveLength(paymentRows);
    expect(g.payments!.totals.count).toBe(paymentRows);
    expect(g.payments!.totals.paid_pay).toBeCloseTo(paidPay, 6);
    expect(g.balance).toBeCloseTo(balance, 6);
    expect(g.strip.total).toBeCloseTo(total, 6);
    expect(g.rail.financing_cost.total).toBeCloseTo(costTotal, 6);
    expect(g.rail.financing_cost.years.reduce((a, y) => a + y.cost, 0)).toBeCloseTo(costTotal, 4);
    expect(g.rail.paid + g.rail.left).toBeCloseTo(g.rail.original, 4);
    expect(g.total?.balance).toBeCloseTo(balance, 6);

    // One value per loan per chart date, ending today; a loan carries nothing before its pie.
    expect(g.chart.dates.at(-1)).toBe(g.as_of);
    for (const s of g.chart.series) expect(s.values).toHaveLength(g.chart.dates.length);
    expect(g.chart.series[0]!.values[0]).toBeGreaterThan(0);
  });
});
