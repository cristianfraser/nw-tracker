import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../db.js";
import { usRetirementAccountImportKey } from "../accountIdentityKeys.js";
import { createRealEstatePlace, listRealEstatePlaces } from "../flowsRealEstateExpenses.js";
import { deleteCheckingIncomeMovementOverride, upsertCheckingIncomeMovementOverride } from "../flowsCheckingIncomeOverrides.js";
import { checkingAccountId } from "../checkingCartolaImport.js";
import { dividendFacts } from "./dividends.js";
import { interestFacts } from "./interest.js";
import { equityAccountDisposalFacts, fundDisposalFacts, fundTaxLotEvents } from "./disposals.js";
import { loanPaymentFacts } from "./loans.js";
import { DEMO_US_BANK_ISSUER, brokerCountry, loadAccountPayers } from "./payers.js";
import { rentalFacts } from "./rentals.js";
import { feeReceiptFacts, usPayStubFacts } from "./salaries.js";
import { fundHoldingFacts } from "./fundHoldings.js";

const PREFIX = "vitest-tax-facts";
/** A year no fixture person reaches. */
const YEAR = 2096;
const WINDOW = { fromYmd: `${YEAR}-01-01`, throughYmd: `${YEAR}-12-31` };
const accounts: number[] = [];
const movements: number[] = [];

function account(leafSlug: string, key: string, ticker: string | null = null, seriesKey: string | null = null): number {
  const leaf = db.prepare(`SELECT id FROM asset_groups WHERE slug = ?`).get(leafSlug) as { id: number } | undefined;
  if (!leaf) throw new Error(`asset group ${leafSlug} missing`);
  const id = Number(
    db
      .prepare(`INSERT INTO accounts (asset_group_id, name, import_key, equity_ticker, fund_series_key) VALUES (?, ?, ?, ?, ?)`)
      .run(leaf.id, `${PREFIX} ${key}`, key, ticker, seriesKey).lastInsertRowid
  );
  accounts.push(id);
  return id;
}

function movement(row: {
  account?: number | null;
  from?: number | null;
  to?: number | null;
  amount: number;
  currency: string;
  day: string;
  kind: string | null;
  units?: number | null;
}): number {
  const id = Number(
    db
      .prepare(
        `INSERT INTO movements (account_id, from_account_id, to_account_id, amount, currency, occurred_on, note, flow_kind, units_delta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(row.account ?? null, row.from ?? null, row.to ?? null, row.amount, row.currency, row.day, `${PREFIX} movement`, row.kind, row.units ?? null)
      .lastInsertRowid
  );
  movements.push(id);
  return id;
}

describe("tax facts", () => {
  let ibkrCash = 0;
  let usBank = 0;
  let clBank = 0;
  let spy = 0;
  let roth = 0;
  let fund = 0;
  let mixedFund = 0;
  let property = 0;
  let loan = 0;
  let stub = 0;

  beforeAll(() => {
    ibkrCash = account("cash_eqs__cash_savings__usd", `${PREFIX}|ibkr-cash`);
    db.prepare(`INSERT INTO account_roles (account_id, role, param) VALUES (?, 'broker_cash', 'ibkr|usd')`).run(ibkrCash);
    usBank = account("cash_eqs__cash_savings__usd", `${PREFIX}|us-bank`);
    db.prepare(`INSERT INTO bank_account_numbers (account_id, issuer, number, currency) VALUES (?, ?, '9900000101', 'usd')`).run(usBank, DEMO_US_BANK_ISSUER);
    clBank = account("cash_eqs__cash_savings", `${PREFIX}|cl-bank`);
    db.prepare(`INSERT INTO bank_account_numbers (account_id, issuer, number, currency) VALUES (?, 'vitest_cl_bank', '9900000102', 'clp')`).run(clBank);
    spy = account("brokerage_acciones", `${PREFIX}|spy`, "SPY");
    roth = account("retirement_us_roth_ira__roth_ira", usRetirementAccountImportKey("roth_ira", "vitest_tax_facts"), "SPY");
    fund = account("brokerage_mutual_funds__fintual_risky_norris", `${PREFIX}|fund`, null, "vitest_tax_facts_fund");
    mixedFund = account("brokerage_mutual_funds__fintual_risky_norris", `${PREFIX}|mixed-fund`, null, "vitest_tax_facts_mixed");
    property = account("cash_eqs__cash_savings", `${PREFIX}|property`);
    loan = account("cash_eqs__cash_savings", `${PREFIX}|loan`);
    db.prepare(`INSERT INTO account_roles (account_id, role, param) VALUES (?, 'property', '')`).run(property);
    db.prepare(`INSERT INTO account_roles (account_id, role, param) VALUES (?, 'loan_of', ?)`).run(loan, String(property));
    db.prepare(`INSERT INTO valuations (account_id, as_of_date, value, currency) VALUES (?, ?, 1800, 'uf')`).run(property, `${YEAR - 4}-03-05`);

    // Dividends: one at the US broker with its statement detail, one inside the Roth.
    const atIbkr = movement({ from: spy, to: ibkrCash, amount: 8.5, currency: "usd", day: `${YEAR}-03-09`, kind: "dividend_payout" });
    db.prepare(
      `INSERT INTO movement_dividend_details (movement_id, gross_amount, withholding_amount, currency, withholding_rate_pct, withholding_jurisdiction, tax_residency_country, source)
       VALUES (?, 10, 1.5, 'usd', 15, 'US', 'CHL', 'manual')`
    ).run(atIbkr);
    movement({ from: roth, to: ibkrCash, amount: 3.25, currency: "usd", day: `${YEAR}-03-09`, kind: "dividend_payout" });
    // Interest at the foreign broker, the US bank and a Chilean bank.
    movement({ account: ibkrCash, amount: 4.1, currency: "usd", day: `${YEAR}-04-30`, kind: "savings_earnings" });
    movement({ account: usBank, amount: 12.2, currency: "usd", day: `${YEAR}-04-30`, kind: "savings_earnings" });
    movement({ account: clBank, amount: 1500, currency: "clp", day: `${YEAR}-04-30`, kind: "savings_earnings" });
    // Shares: two buys, one sale in the window (FIFO consumes the first lot and part of the second).
    movement({ from: ibkrCash, to: spy, amount: 1000, currency: "usd", day: `${YEAR - 1}-06-01`, kind: "stock_buy", units: 10 });
    movement({ from: ibkrCash, to: spy, amount: 1200, currency: "usd", day: `${YEAR - 1}-07-01`, kind: "stock_buy", units: 10 });
    movement({ from: spy, to: ibkrCash, amount: 1950, currency: "usd", day: `${YEAR}-05-02`, kind: "stock_sell", units: 15 });
    // A fund's cuotas: bought in pesos, part redeemed.
    movement({ account: fund, amount: 500_000, currency: "clp", day: `${YEAR - 1}-02-01`, kind: null, units: 100 });
    movement({ account: fund, amount: -300_000, currency: "clp", day: `${YEAR}-02-01`, kind: null, units: -50 });
    movement({ account: mixedFund, amount: 500_000, currency: "clp", day: `${YEAR - 1}-02-01`, kind: null, units: 100 });
    movement({ account: mixedFund, amount: 600, currency: "usd", day: `${YEAR - 1}-03-01`, kind: null, units: 1 });
    // A mortgage payment's loan leg.
    const pay = movement({ account: loan, amount: 0, currency: "clp", day: `${YEAR}-06-11`, kind: null });
    db.prepare(
      `INSERT INTO loan_payments (movement_id, loan_account_id, leg, origin, cuota, loan_currency, payment_currency, principal, extra_principal, interest, insurance_fire, insurance_life)
       VALUES (?, ?, 'loan', 'manual', '7', 'uf', 'clp', 200000, 0, 350000, 9000, 4000)`
    ).run(pay, loan);
    // A US pay stub, lines stored out of printed order.
    stub = Number(
      db
        .prepare(
          `INSERT INTO payroll_work_earnings (period_month, employer_name, earning_type, liquido, liquido_currency, source_pdf, jurisdiction, pay_date)
           VALUES (?, 'Vitest Labs', 'salary', 4000, 'usd', ?, 'us', ?)`
        )
        .run(`${YEAR}-01`, `${PREFIX}-stub.pdf`, `${YEAR}-01-15`).lastInsertRowid
    );
    const line = db.prepare(`INSERT INTO payslip_lines (payslip_id, position, side, label, amount, kind) VALUES (?, ?, ?, ?, ?, ?)`);
    line.run(stub, 1, "descuento", "Federal income tax", 600, "federal_income_tax");
    line.run(stub, 0, "haber", "Regular", 5000, "wages");
    db.prepare(
      `INSERT INTO sii_issued_fee_receipts (number, issued_on, payer_name, gross_clp, retention_clp, retained_by, source_file) VALUES (?, ?, 'Vitest SpA', 1000000, 137500, 'payer', ?)`
    ).run(99_096_001, `${YEAR}-03-03`, PREFIX);
    // A rented place on the property, with its rent and two bill rows.
    createRealEstatePlace({ slug: "vitest_tax_facts_place", label: "Vitest place", propertyAccountId: property, dfl2: { dfl2: true, builtM2: 55, receptionYear: 2019 } });
    const place = listRealEstatePlaces().find((p) => p.slug === "vitest_tax_facts_place")!;
    // A checking credit as the cartola import writes it (the income overrides read cartola rows only).
    const day = `${YEAR}-03-05`;
    const credit = Number(
      db
        .prepare(`INSERT INTO movements (account_id, amount, currency, occurred_on, note) VALUES (?, 400000, 'clp', ?, ?)`)
        .run(checkingAccountId(), day, `import:cartola|${day.slice(0, 7)}|—|ARRIENDO VITEST|on:${day}|amt:400000|idx:996001`)
        .lastInsertRowid
    );
    movements.push(credit);
    upsertCheckingIncomeMovementOverride(credit, { income_kind: "rent", rent_place_slug: "vitest_tax_facts_place" });
    const bill = db.prepare(`INSERT INTO expense_entries (amount_clp, spent_on, category, expense_account_id) VALUES (?, ?, ?, ?)`);
    bill.run(30_000, `${YEAR}-04-30`, "contribuciones", place.id);
    bill.run(80_000, `${YEAR}-03-31`, "gastos_comunes", place.id);
  });

  afterAll(() => {
    for (const id of movements) deleteCheckingIncomeMovementOverride(id);
    db.prepare(`DELETE FROM expense_entries WHERE expense_account_id IN (SELECT id FROM expense_accounts WHERE slug = 'vitest_tax_facts_place')`).run();
    db.prepare(`DELETE FROM expense_accounts WHERE slug = 'vitest_tax_facts_place'`).run();
    db.prepare(`DELETE FROM sii_issued_fee_receipts WHERE source_file = ?`).run(PREFIX);
    db.prepare(`DELETE FROM payroll_work_earnings WHERE id = ?`).run(stub);
    for (const id of movements) db.prepare(`DELETE FROM movements WHERE id = ?`).run(id);
    for (const id of accounts) db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
  });

  it("names each account's payers and their country from the role and the bank number", () => {
    const payers = loadAccountPayers();
    expect(payers.get(ibkrCash)).toEqual([{ kind: "broker", broker: "ibkr", currency: "usd", country: "US" }]);
    expect(payers.get(usBank)).toEqual([{ kind: "bank", issuer: DEMO_US_BANK_ISSUER, currency: "usd", country: "US" }]);
    expect(payers.get(clBank)).toEqual([{ kind: "bank", issuer: "vitest_cl_bank", currency: "clp", country: "CL" }]);
    expect(brokerCountry("fintual")).toBe("CL");
  });

  it("states each dividend's net, its document's split, the receiving cash's payer and a retirement account", () => {
    const mine = dividendFacts(WINDOW).filter((d) => d.fromAccountId === spy || d.fromAccountId === roth);
    expect(mine).toHaveLength(2);
    const [atIbkr, inRoth] = [mine.find((d) => d.fromAccountId === spy)!, mine.find((d) => d.fromAccountId === roth)!];
    expect(atIbkr).toMatchObject({ currency: "usd", net: 8.5, instrumentTicker: "SPY", usRetirementAccount: null });
    expect(atIbkr.detail).toEqual({
      currency: "usd",
      gross: 10,
      withholding: 1.5,
      withholdingRatePct: 15,
      withholdingJurisdiction: "US",
      taxResidencyCountry: "CHL",
      source: "manual",
    });
    expect(atIbkr.payers.map((p) => p.country)).toEqual(["US"]);
    expect(inRoth).toMatchObject({ net: 3.25, detail: null, usRetirementAccount: "roth_ira" });
  });

  it("states interest in the currency it was credited in, with the payer behind the account", () => {
    const mine = interestFacts(WINDOW).filter((f) => [ibkrCash, usBank, clBank].includes(f.accountId));
    expect(mine.map((f) => [f.accountId, f.currency, f.amount, f.payers[0]!.country])).toEqual([
      [ibkrCash, "usd", 4.1, "US"],
      [usBank, "usd", 12.2, "US"],
      [clBank, "clp", 1500, "CL"],
    ]);
    expect(interestFacts({ fromYmd: `${YEAR}-05-01`, throughYmd: `${YEAR}-12-31` }).some((f) => f.accountId === usBank)).toBe(false);
  });

  it("realizes the window's sales in the instrument's currency, with each purchase consumed", () => {
    const [spyLots] = equityAccountDisposalFacts(WINDOW, {
      method: "fifo",
      accounts: [{ accountId: spy, accountName: "SPY", ticker: "SPY" }],
    });
    expect(spyLots!.currency).toBe("usd");
    expect(spyLots!.disposals).toHaveLength(1);
    const d = spyLots!.disposals[0]!;
    expect(d).toMatchObject({ kind: "equity", currency: "usd", instrument: "SPY", units: 15, proceeds: 1950, cost: 1600, gain: 350 });
    expect(d.slices.map((s) => [s.acquiredOn, s.units, s.cost])).toEqual([
      [`${YEAR - 1}-06-01`, 10, 1000],
      [`${YEAR - 1}-07-01`, 5, 600],
    ]);
    // A currency filter leaves an account that trades in another one unwalked.
    expect(equityAccountDisposalFacts(WINDOW, { method: "fifo", accounts: [{ accountId: spy, accountName: "SPY", ticker: "SPY" }], currency: "clp" })[0]!.disposals).toEqual([]);
    // Outside the window: nothing.
    const later = equityAccountDisposalFacts({ fromYmd: `${YEAR}-06-01`, throughYmd: `${YEAR}-12-31` }, {
      method: "fifo",
      accounts: [{ accountId: spy, accountName: "SPY", ticker: "SPY" }],
    });
    expect(later[0]!.disposals).toEqual([]);
  });

  it("redeems a fund's cuotas in the movements' currency, and refuses a fund moved in two", () => {
    const [d] = fundDisposalFacts(WINDOW, { method: "fifo", accounts: [{ accountId: fund, accountName: "fund", seriesKey: "vitest_tax_facts_fund" }] });
    expect(d).toMatchObject({ kind: "fund", currency: "clp", units: 50, proceeds: 300_000, cost: 250_000 });
    expect(() => fundTaxLotEvents(mixedFund)).toThrow(/clp and usd/);
  });

  it("states a loan payment's parts in its currency", () => {
    expect(loanPaymentFacts(WINDOW, loan)).toEqual([
      {
        movementId: expect.any(Number),
        date: `${YEAR}-06-11`,
        loanAccountId: loan,
        currency: "clp",
        principal: 200_000,
        extraPrincipal: 0,
        interest: 350_000,
        insuranceFire: 9_000,
        insuranceLife: 4_000,
      },
    ]);
  });

  it("states a US pay stub's lines in printed order, and the boletas issued", () => {
    const [s] = usPayStubFacts(WINDOW).filter((x) => x.payslipId === stub);
    expect(s!.lines.map((l) => l.kind)).toEqual(["wages", "federal_income_tax"]);
    expect(feeReceiptFacts(WINDOW).filter((r) => r.number === 99_096_001)).toEqual([
      { number: 99_096_001, issuedOn: `${YEAR}-03-03`, payer: "Vitest SpA", grossClp: 1_000_000, retentionClp: 137_500, retainedBy: "payer" },
    ]);
  });

  it("lists a rented place with its rent, every bill row, its DFL-2 facts, property, loan and first appraisal", () => {
    const [p] = rentalFacts(WINDOW).filter((x) => x.slug === "vitest_tax_facts_place");
    expect(p).toMatchObject({
      dfl2: { builtM2: 55, receptionYear: 2019 },
      propertyAccountId: property,
      loanAccountId: loan,
      firstAppraisal: { date: `${YEAR - 4}-03-05`, value: 1800, currency: "uf" },
    });
    expect(p!.rentCredits.map((c) => c.amountClp)).toEqual([400_000]);
    expect(p!.bills.map((b) => [b.category, b.amountClp])).toEqual([
      ["contribuciones", 30_000],
      ["gastos_comunes", 80_000],
    ]);
  });
});

describe("fund holdings", () => {
  it("states each fund account's cuotas and value in the fund's currency when a window opens and ends", () => {
    const today = new Date().toISOString().slice(0, 10);
    const year = Number(today.slice(0, 4)) - 1;
    const facts = fundHoldingFacts({ fromYmd: `${year}-04-15`, throughYmd: `${year}-12-31` });
    expect(facts.length).toBeGreaterThan(0);
    for (const f of facts) {
      expect(f.positions.map((p) => p.date)).toEqual([`${year}-04-14`, `${year}-12-31`]);
      for (const p of f.positions) if (p.cuotas != null) expect(p.value).not.toBeNull();
    }
  });
});
