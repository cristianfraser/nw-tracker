import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addCalendarMonths } from "nw-tracker-contracts";
import type { DeptoMortgageSheetRow, DeptoValuePointDto } from "nw-tracker-contracts/dto";
import { db } from "./db.js";
import { loanAccountImportKey, propertyAccountImportKey } from "./accountIdentityKeys.js";
import { placeAccount, removeAccountPlacement } from "./accountPlacement.js";
import { propertyLoanPairs } from "./accountRoles.js";
import { buildAccountDetailBundle } from "./accountDetailBundle.js";
import { clearAggregationCache } from "./cacheRegistry.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import {
  deptoPaymentHumanNote,
  insertLoanPaymentRow,
  loanPaymentColumnsFromPaymentRow,
  mortgageFlowKindFromCuota,
  upsertPropertyAppraisalUf,
  type DeptoDividendosPaymentRow,
} from "./deptoDividendosLedger.js";
import {
  buildDeptoGlanceForAccount,
  deptoCostBand,
  deptoMonthSplit,
  deptoPrepayBlockForBenchmark,
  niceCeil,
  projectPayoff,
} from "./deptoGlance.js";
import { createRealEstatePlace } from "./flowsRealEstateExpenses.js";
import { syncLoanPaymentFlowParts } from "./flows/loanPaymentParts.js";
import { storedPairRate } from "./rates.js";

describe("niceCeil", () => {
  it("rounds up to the next nice number", () => {
    expect(niceCeil(79.77)).toBe(80);
    expect(niceCeil(80.07)).toBe(100);
    expect(niceCeil(950_000)).toBe(1_000_000);
    expect(niceCeil(1)).toBe(1);
    expect(() => niceCeil(0)).toThrow();
  });
});

describe("projectPayoff", () => {
  it("amortizes the usual pace each cuota, interest on the balance before it", () => {
    const p = projectPayoff({ balance: 120, monthlyRate: 0.01, firstDate: "2030-01-11", asOf: "2029-12-20", mode: { pace: 10 } });
    expect(p.cuotas).toBe(12);
    expect(p.years).toBe(1);
    expect(p.end_date).toBe("2030-12-11");
    // 1 % of 120, 110, …, 10.
    expect(p.interest_loan).toBeCloseTo(7.8, 9);
    expect(p.path[0]).toEqual({ date: "2029-12-20", balance_loan: 120 });
    expect(p.path[1]).toEqual({ date: "2030-01-11", balance_loan: 110 });
    expect(p.path[p.path.length - 1]!.balance_loan).toBe(0);
    expect(p.amortization_loan).toBe(10);
  });

  it("pays the annuity that ends at the term: a level payment, exactly that many cuotas", () => {
    const r = 0.004;
    const k = 24;
    const p = projectPayoff({ balance: 1000, monthlyRate: r, firstDate: "2030-01-11", asOf: "2030-01-01", mode: { annuityCuotas: k } });
    expect(p.cuotas).toBe(k);
    expect(p.end_date).toBe("2031-12-11");
    const pmt = (1000 * r) / (1 - (1 + r) ** -k);
    expect(p.interest_loan).toBeCloseTo(k * pmt - 1000, 6);
    expect(p.amortization_loan).toBeNull();
  });

  it("refuses a pace that pays nothing down", () => {
    expect(() =>
      projectPayoff({ balance: 10, monthlyRate: 0.01, firstDate: "2030-01-11", asOf: "2030-01-01", mode: { pace: 0 } })
    ).toThrow(/pays nothing/);
  });
});

describe("deptoCostBand", () => {
  const parts = [
    // Twelve months of carrying 100 and amortization 50; one month with a large extra amortization.
    ...Array.from({ length: 16 }, (_, i) => addCalendarMonths("2025-01", i)).flatMap((month) => [
      { month, kind: "mortgage_carrying", amount: 100 },
      { month, kind: "mortgage_amortization", amount: 50 },
    ]),
    { month: "2025-06", kind: "gastos_comunes", amount: 70 },
    { month: "2025-06", kind: "gastos_comunes", amount: 5 },
    { month: "2025-09", kind: "mortgage_extra_amortization", amount: 900 },
  ];

  it("lays out every month, a cap from the largest cost and the last complete 12 months", () => {
    const band = deptoCostBand({ placeSlug: "p", parts, currentMonth: "2026-05" })!;
    expect(band.kinds).toEqual([
      { kind: "mortgage_carrying", direction: "cost" },
      { kind: "mortgage_amortization", direction: "equity" },
      { kind: "gastos_comunes", direction: "cost" },
      { kind: "mortgage_extra_amortization", direction: "equity" },
    ]);
    expect(band.months.map((m) => m.month)).toEqual(Array.from({ length: 16 }, (_, i) => addCalendarMonths("2025-01", i)));
    const june = band.months.find((m) => m.month === "2025-06")!;
    expect(june.values).toEqual({ mortgage_carrying: 100, mortgage_amortization: 50, gastos_comunes: 75, mortgage_extra_amortization: 0 });
    expect([june.cost_total, june.equity_total]).toEqual([175, 50]);
    // The largest cost month is 175 → 200; the extra-amortization month goes past it.
    expect(band.axis).toEqual({ cap: 200, ticks: [100, 200] });
    expect(band.months.filter((m) => m.equity_over_cap).map((m) => m.month)).toEqual(["2025-09"]);
    // Two months before May 2026 is March: April 2025 … March 2026.
    expect(band.window).toMatchObject({ from: "2025-04", to: "2026-03", cost: 1275, equity: 1500, total: 2775 });
    expect(band.months.filter((m) => m.in_window)).toHaveLength(12);
    expect(band.window!.rows.map((r) => [r.kind, r.total])).toEqual([
      ["mortgage_carrying", 1200],
      ["gastos_comunes", 75],
      ["mortgage_amortization", 600],
      ["mortgage_extra_amortization", 900],
    ]);
    expect(band.window!.rows.find((r) => r.kind === "mortgage_carrying")!.share).toBe(1);
    expect(band.window!.cost_share + band.window!.equity_share).toBeCloseTo(1, 12);
  });

  it("clips the window to the months on file, and has none before a month is complete", () => {
    expect(deptoCostBand({ placeSlug: "p", parts, currentMonth: "2025-08" })!.window).toMatchObject({ from: "2025-01", to: "2025-06" });
    expect(deptoCostBand({ placeSlug: "p", parts, currentMonth: "2025-02" })!.window).toBeNull();
  });

  it("throws on a kind the expenses chart does not know", () => {
    expect(() => deptoCostBand({ placeSlug: "p", parts: [{ month: "2025-01", kind: "boat", amount: 1 }], currentMonth: "2025-05" })).toThrow(
      /boat/
    );
  });
});

describe("deptoMonthSplit", () => {
  const row = (over: Partial<DeptoMortgageSheetRow>): DeptoMortgageSheetRow =>
    ({ cuota: "7", occurred_on: "2026-03-11", loan_currency: "uf", payment_currency: "clp", pago_pay: 1000, amortizacion_total_pay: 600, ...over }) as DeptoMortgageSheetRow;
  const points: DeptoValuePointDto[] = [
    { date: "2026-02-28", value: 10_000, mortgage: 5_000, deposited: 0, equity: 5_000 },
    { date: "2026-03-20", value: 10_100, mortgage: 4_420, deposited: 0, equity: 5_680 },
  ];

  it("splits the month's P/L into the cuota's cost and the currency move", () => {
    // Δ equity 680 − paid 1000 = −320. Cuota part 600 − 1000 = −400; currency 100 − (−580 + 600) = 80.
    const s = deptoMonthSplit({ points, ledger: [row({})], unit: "clp", pl: -320 })!;
    expect(s).toMatchObject({ month: "2026-03", cuotas: ["7"], cuota_part: -400, currency_part: 80, cuota_share: 1, currency_share: 0.2 });
  });

  it("throws when the parts do not add up to the month's P/L", () => {
    expect(() => deptoMonthSplit({ points, ledger: [row({})], unit: "clp", pl: -300 })).toThrow(
      /does not add up/
    );
  });

  it("reports a currency move for a loan in the payment currency too (a peso loan in another display unit)", () => {
    const s = deptoMonthSplit({ points, ledger: [row({ loan_currency: "clp" })], unit: "clp", pl: -320 })!;
    expect(s).toMatchObject({ cuota_part: -400, currency_part: 80 });
  });

  it("has no currency part when the currency did not move", () => {
    // The value holds and the balance falls by exactly the 600 amortized: the P/L is the cuota's cost.
    const still: DeptoValuePointDto[] = [points[0]!, { ...points[1]!, value: 10_000, mortgage: 4_400, equity: 5_600 }];
    const s = deptoMonthSplit({ points: still, ledger: [row({})], unit: "clp", pl: -400 })!;
    expect(s).toMatchObject({ cuota_part: -400, currency_part: null, currency_share: 0, cuota_share: 1 });
  });

  it("has no split without a previous month-end", () => {
    expect(deptoMonthSplit({ points: points.slice(1), ledger: [], unit: "clp", pl: 0 })).toBeNull();
  });
});

/**
 * A property bought four months ago with a 3.000-unit loan in the loan currency: four cuotas of
 * 10 amortized (5 + 5 extra) and a prepago of 200, synthetic and cleaned up; its place carries
 * the cuotas into the cost band.
 */
describe("the property and mortgage pages on one ledger", () => {
  const KEY = "vitest_glance";
  const PLACE = "vitest_glance_place";
  let prop = 0;
  let loan = 0;
  let skip = false;
  const today = chileCalendarTodayYmd();
  const month = (k: number) => addCalendarMonths(today.slice(0, 7), k);
  const uf = (d: string) => {
    const r = storedPairRate("uf", "clp", d);
    if (!r) throw new Error(`test DB has no UF on ${d}`);
    return r.mid;
  };
  const pieDate = `${month(-4)}-04`;
  const cuotaDates = [`${month(-3)}-11`, `${month(-2)}-11`, `${month(-1)}-11`, `${month(0)}-01`];
  const prepagoDate = `${month(-2)}-20`;
  let rows: DeptoDividendosPaymentRow[] = [];
  let SPY_DIVIDEND_DAY = "";
  let insertedDividend = false;

  beforeAll(() => {
    skip = propertyLoanPairs().length > 0;
    if (skip) return;
    const group = (slug: string) => (db.prepare(`SELECT id FROM asset_groups WHERE slug = ?`).get(slug) as { id: number }).id;
    const ins = db.prepare(`INSERT INTO accounts (asset_group_id, name, notes, import_key) VALUES (?, ?, 'vitest', ?)`);
    prop = Number(ins.run(group("real_estate__property"), "Glance home", propertyAccountImportKey(KEY)).lastInsertRowid);
    loan = Number(ins.run(group("liabilities__mortgage"), "Glance loan", loanAccountImportKey(KEY)).lastInsertRowid);
    // The property in its net-worth bucket (its dashboard row reads the bucket); a loan has none.
    placeAccount(prop);
    upsertPropertyAppraisalUf(prop, pieDate, 5000);
    // The default benchmark reinvests SPY dividends: the lean test DB stores none.
    if (!db.prepare(`SELECT 1 FROM equity_dividends WHERE ticker = 'SPY'`).get()) {
      SPY_DIVIDEND_DAY = (
        db.prepare(`SELECT MIN(trade_date) AS d FROM equity_daily WHERE ticker = 'SPY' AND trade_date >= ?`).get(`${month(-8)}-01`) as { d: string }
      ).d;
      db.prepare(`INSERT INTO equity_dividends (ticker, ex_date, amount, currency) VALUES ('SPY', ?, 1.5, 'usd')`).run(SPY_DIVIDEND_DAY);
      insertedDividend = true;
    }

    const pesos = (u: number, d: string) => Math.round(u * uf(d));
    const cuota = (n: number, d: string, balance: number): DeptoDividendosPaymentRow => {
      const parts = { amortizacion_clp: pesos(5, d), amortizacion_ext_clp: pesos(5, d), interes_clp: pesos(12, d), incendio_clp: pesos(1, d), desgravamen_clp: pesos(0.1, d) };
      return {
        cuota: String(n),
        occurred_on: d,
        amount_clp: Object.values(parts).reduce((a, b) => a + b, 0),
        credito_restante_uf: balance,
        min_uf: 15,
        max_uf: 80,
        ...parts,
      };
    };
    const prepagoParts = { amortizacion_clp: 0, amortizacion_ext_clp: pesos(200, prepagoDate), interes_clp: pesos(1, prepagoDate), incendio_clp: 0, desgravamen_clp: 0 };
    rows = [
      {
        cuota: "pie", occurred_on: pieDate, amount_clp: pesos(2000, pieDate), credito_restante_uf: 3000, min_uf: null, max_uf: null,
        amortizacion_clp: null, amortizacion_ext_clp: null, interes_clp: null, incendio_clp: null, desgravamen_clp: null,
      },
      cuota(1, cuotaDates[0]!, 2990),
      cuota(2, cuotaDates[1]!, 2980),
      { cuota: "prepago 1", occurred_on: prepagoDate, amount_clp: prepagoParts.amortizacion_ext_clp + prepagoParts.interes_clp, credito_restante_uf: 2780, min_uf: null, max_uf: null, ...prepagoParts },
      cuota(3, cuotaDates[2]!, 2770),
      cuota(4, cuotaDates[3]!, 2760),
    ];
    const insMov = db.prepare(`INSERT INTO movements (account_id, amount, currency, occurred_on, note, flow_kind) VALUES (?, ?, 'clp', ?, ?, ?)`);
    for (const r of rows) {
      const p = insMov.run(prop, r.amount_clp, r.occurred_on, deptoPaymentHumanNote("property", r.cuota, false), null);
      insertLoanPaymentRow({ movement_id: Number(p.lastInsertRowid), loan_account_id: loan, leg: "property", origin: "import", ...loanPaymentColumnsFromPaymentRow(r) });
      if (r.cuota === "pie") continue;
      const m = insMov.run(loan, r.amount_clp, r.occurred_on, deptoPaymentHumanNote("loan", r.cuota, false), mortgageFlowKindFromCuota(r.cuota));
      insertLoanPaymentRow({ movement_id: Number(m.lastInsertRowid), loan_account_id: loan, leg: "loan", origin: "import", ...loanPaymentColumnsFromPaymentRow(r) });
    }
    syncLoanPaymentFlowParts([]);
    createRealEstatePlace({ slug: PLACE, label: "Glance place", propertyAccountId: prop });
    clearAggregationCache();
  });

  afterAll(() => {
    if (skip) return;
    db.prepare(`DELETE FROM expense_accounts WHERE slug = ?`).run(PLACE);
    if (insertedDividend) db.prepare(`DELETE FROM equity_dividends WHERE ticker = 'SPY' AND ex_date = ?`).run(SPY_DIVIDEND_DAY);
    removeAccountPlacement(prop);
    for (const id of [prop, loan]) {
      db.prepare(`DELETE FROM movements WHERE account_id = ?`).run(id);
      db.prepare(`DELETE FROM valuations WHERE account_id = ?`).run(id);
      db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
    }
    clearAggregationCache();
  });

  it("builds the property page: equity, ownership, the month's split, the cost band", async () => {
    if (skip) return;
    const bundle = (await buildAccountDetailBundle(prop, "clp", "monthly"))!;
    const g = bundle.depto_glance!;
    expect(g.kind).toBe("property");
    if (g.kind !== "property") return;
    expect([g.loan_currency, g.payment_currency, g.unit]).toEqual(["uf", "clp", "clp"]);
    expect(g.header.hero_loan).toBe(2240);
    expect(g.header.hero).toBe(bundle.dashboard_account_row!.current_value);
    expect(g.header.strip.total).toBe(bundle.dashboard_account_row!.delta_total);

    const v = g.property.value;
    expect(v.ownership).toEqual({ owned_loan: 2240, owed_loan: 2760, owned_share: 2240 / 5000, owed_share: 2760 / 5000 });
    expect(v.prepagos).toEqual([{ date: prepagoDate, amount_loan: expect.closeTo(200, 3) }]);
    expect(v.pie.pie).toBe(rows[0]!.amount_clp);
    expect(v.purchase).toMatchObject({ date: pieDate, value: 5000 * uf(pieDate) });
    for (const p of v.points) expect(p.value - p.mortgage).toBeCloseTo(p.equity, 6);

    // This month paid cuota 4: what did not become equity is its interest and insurance.
    const c4 = rows[5]!;
    const split = g.property.pl.this_month!;
    expect(split.cuotas).toEqual(["4"]);
    expect(split.cuota_part).toBe(-(c4.interes_clp! + c4.incendio_clp! + c4.desgravamen_clp!));
    expect(split.cuota_part + split.currency_part!).toBeCloseTo(split.pl, 0);
    expect(split.pl).toBe(bundle.dashboard_account_row!.delta_month);
    const months = g.property.pl.months;
    expect(months[months.length - 1]!.pl_cumulative).toBeCloseTo(g.property.pl.total.pl, 0);

    const cost = g.property.cost!;
    expect(cost.place_slug).toBe(PLACE);
    expect(cost.kinds.map((k) => k.kind)).toEqual(["mortgage_carrying", "mortgage_amortization", "mortgage_extra_amortization"]);
    expect(cost.months.map((m) => m.month)).toEqual([month(-3), month(-2), month(-1), month(0)]);
    const first = cost.months[0]!;
    const c1 = rows[1]!;
    expect(first.values).toEqual({
      mortgage_carrying: c1.interes_clp! + c1.incendio_clp! + c1.desgravamen_clp!,
      mortgage_amortization: c1.amortizacion_clp,
      mortgage_extra_amortization: c1.amortizacion_ext_clp,
    });
    expect(cost.window).toMatchObject({ from: month(-3), to: month(-2) });
    expect(g.property.movement_count).toBe(rows.length);
  });

  it("builds the mortgage page: the payments list, the balance band and the payoff projection", async () => {
    if (skip) return;
    const bundle = (await buildAccountDetailBundle(loan, "clp", "monthly"))!;
    const g = bundle.depto_glance!;
    expect(g.kind).toBe("mortgage");
    if (g.kind !== "mortgage") return;
    expect(g.header.hero_loan).toBe(2760);

    const p = g.mortgage.payments;
    expect(p.rows.map((r) => r.key)).toEqual(["4", "3", "prepago 1", "2", "1"]);
    expect(p.rows.map((r) => r.number)).toEqual([4, 3, 1, 2, 1]);
    const loanRows = rows.slice(1);
    expect(p.totals.paid_pay).toBe(loanRows.reduce((s, r) => s + r.amount_clp, 0));
    expect(p.totals.count).toBe(5);
    expect(p.totals.bar.segments.reduce((s, x) => s + x.share, 0)).toBeCloseTo(1, 12);
    expect(p.rows.find((r) => r.kind === "prepago")!.bar).toEqual({ segments: [{ part: "prepago", share: 1 }], clipped: true });
    expect(p.next).toMatchObject({ cuota: "5" });
    // Every payment amortized something above the minimum: each row has a cell in the endpoint's block.
    const prepay = deptoPrepayBlockForBenchmark(loan, p.default_benchmark, "clp")!;
    expect(Object.keys(prepay.rows).sort()).toEqual(p.rows.map((r) => r.key).sort());
    expect(prepay.totals.covered_payments).toBe(p.rows.length);

    const b = g.mortgage.balance;
    expect(b.points.map((x) => x.kind)).toEqual(["start", "cuota", "cuota", "prepago", "cuota", "cuota"]);
    expect(b.points[3]!.step_loan).toBeCloseTo(-200, 9);
    expect(b).toMatchObject({ original_loan: 3000, left_loan: 2760, paid_loan: 240 });
    expect(b.prepaid_loan).toBeCloseTo(200, 9);
    expect(b.cuotas_paid_loan).toBeCloseTo(40, 9);
    expect(b.financing_cost.total).toBe(bundle.dashboard_account_row!.delta_total);

    const proj = g.mortgage.projection!;
    expect(proj.usual.amortization_loan).toBeCloseTo(10, 3);
    expect(proj.usual.cuotas).toBe(276);
    expect(proj.minimum.cuotas).toBe(360 - 4);
    expect(proj.saving.interest_loan).toBeCloseTo(proj.minimum.interest_loan - proj.usual.interest_loan, 9);
    expect(proj.terms.map((t) => t.term)).toEqual([30, 25, "usual", 20, 15, 12, 10, 5, "max"]);
    expect(proj.terms.find((t) => t.highlighted)!.years).toBe(23);
  });

  it("is null on any other account", async () => {
    const other = db.prepare(`SELECT a.id FROM accounts a JOIN asset_groups g ON g.id = a.asset_group_id WHERE g.slug LIKE 'cash_eqs%' LIMIT 1`).get() as
      | { id: number }
      | undefined;
    if (!other) throw new Error("test DB has no cash account");
    expect(buildDeptoGlanceForAccount(other.id, { unit: "clp", mortgageLedger: { account_id: other.id, has_sheet_rows: false, meta: null, rows: [], card_matches: [], card_lines_without_payment: [] }, row: null, perf: null })).toBeNull();
  });
});
