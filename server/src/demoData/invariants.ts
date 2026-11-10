/**
 * What must hold after a synthetic database is generated. A failure throws (the build fails; the live demo
 * keeps its previous version). The report is printed by the generate script.
 */
import type { EmploymentPayslipsApplyDetails } from "nw-tracker-contracts";
import { db } from "../db.js";
import { accountMarkClpAtYmd } from "../accountMarkClpAtYmd.js";
import { checkingMovementBalanceClpAt } from "../checkingCartolaBalances.js";
import { listDollarCheckingAccountIds, listDollarCheckingMovements } from "../checkingCartolaLoaders.js";
import { buildCheckingGastosLinesForAccounts } from "../flowsCheckingGastos.js";
import { signedUsdDeltaForAccountMovement, type MovementTransferRow } from "../movementTransfer.js";
import { buildPayslipChecks } from "../payslipChecks.js";
import { usdCashBalanceUsdAt } from "../usdCashAccounts.js";
import { buildFlowsOverviewPayload } from "../flowsOverview.js";
import { listCreditCardMasterAccountIds } from "../creditCardTree.js";
import { fxRowOnOrBefore } from "../fxRates.js";
import { accountIdsUnderCheckingAccounts } from "../movementBalanceCashAccounts.js";
import { convertValue } from "../valueConvert.js";
import { listRealEstatePlaces } from "../flowsRealEstateExpenses.js";
import { f1040Settlement, filedF1040 } from "../f1040Filed.js";
import { buildF22Draft } from "../f22Draft.js";
import { CHILE_US_TREATY_FIRST_INCOME_YEAR } from "../legalParameters.js";
import { accountIdsInPortfolioGroup } from "../portfolioGroupTree.js";
import { MONEY_MARKET_SERIES_KEY, mortgageBalanceUf } from "./simulate.js";
import type { MarketReader } from "./market.js";
import type { Ymd } from "./person.js";
import type { Acct, Ledger } from "./simulate.js";

export type DemoDbReport = {
  today: Ymd;
  movements: number;
  cartolas: number;
  statements: number;
  statementLines: number;
  installmentPlans: number;
  payslips: { contract: number; contractor: number; us: number; linked: number; unmatched: number };
  /** Each property: its loan's cuotas on file, the cuota card lines linked, the rents marked. */
  properties: { key: string; equityClp: number; loanClp: number; cuotas: number; linkedCardLines: number; rents: number; bills: number }[];
  /** The US card: statements, lines, payments. */
  usCard: { statements: number; lines: number; payments: number } | null;
  /** The largest month of the flows overview's «sin explicar» after the story's own conversion costs (CLP). */
  cashUnexplainedWorstClp: number;
  /** The US chapter: the US checking account's statement rows and its gastos lines, and the savings account's balance. */
  us: { statementRows: number; gastosLines: number; balanceUsd: number; savingsUsd: number | null } | null;
  /** The Chilean money-market fund today (null without one). */
  savingsFundClp: number | null;
  /**
   * The returns across the border: each filed 1040 (lines 24 / 35a / 37 and the movement that
   * settled it) and each filed F22 with a US salary (1030, 748, 1018, 304, 305).
   */
  returns: {
    f1040: { taxYear: number; line24: number; line35a: number; line37: number; settlementMovementId: number | null }[];
    f22: { taxYear: number; c1030: number; c748: number; c1018: number; c304: number; c305: number; creditApplied: number }[];
  };
  netWorthClp: number;
  netWorthUsd: number;
  byAccount: { name: string; clp: number }[];
  /** Months the cushion (the fund, else the whole cash) sat above one and a half times the savings band's top. */
  monthsOutsideBand: number;
};

/** How far net worth may land from the person's target before the build complains. */
export const NET_WORTH_TOLERANCE = 0.25;

export function assertDemoInvariants(
  ledger: Ledger,
  ids: Map<Acct, number>,
  market: MarketReader,
  today: Ymd,
  extra: { payslips: EmploymentPayslipsApplyDetails | null }
): DemoDbReport {
  const problems: string[] = [];

  // The app's checking balances equal the ones the story kept.
  for (const acct of ["vista", "checking"] as const) {
    const expected = ledger.bank.filter((r) => r.account === acct).reduce((a, r) => a + r.amount, 0);
    const actual = checkingMovementBalanceClpAt(ids.get(acct)!, today);
    if (Math.round(actual) !== Math.round(expected)) problems.push(`${acct}: app balance ${actual}, story balance ${expected}`);
  }
  // Every chronological day of every cartola account stays at or above zero.
  for (const acct of ["vista", "checking"] as const) {
    const rows = ledger.bank.filter((r) => r.account === acct).sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount);
    let bal = 0;
    let worst: { day: string; bal: number } | null = null;
    const byDay = new Map<string, number>();
    for (const r of rows) byDay.set(r.date, (byDay.get(r.date) ?? 0) + r.amount);
    for (const [day, delta] of [...byDay].sort()) {
      bal += delta;
      if (bal < 0 && (worst == null || bal < worst.bal)) worst = { day, bal };
    }
    if (worst) problems.push(`${acct} goes negative: ${worst.bal} on ${worst.day}`);
  }
  // Payslips pair with the deposits that paid them.
  if (extra.payslips && extra.payslips.unmatched.length + extra.payslips.ambiguous.length > 0) {
    problems.push(
      `payslips not paired: ${extra.payslips.unmatched.map((u) => u.document).join(", ")} ${extra.payslips.ambiguous.map((a) => a.document).join(", ")}`
    );
  }
  // Card payment debits all became transfers.
  const unpaired = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM movements WHERE account_id = ? AND from_account_id IS NULL AND (note LIKE '%PAGO TARJETA CREDITO%' OR note LIKE '%COMPRA DE DIVISAS%')`
      )
      .get(ids.get("checking")!) as { n: number }
  ).n;
  if (unpaired > 0) problems.push(`${unpaired} card payment debit(s) were not paired with their card's evidence`);

  const usReport = checkUsChapter(ledger, ids, today, problems);
  const savingsFundClp = checkSavingsFund(ledger, ids, market, today, problems);
  const properties = checkProperties(ledger, ids, market, today, problems);
  const usCard = checkUsCard(ledger, ids, problems);
  const cashUnexplainedWorstClp = checkCashExplained(problems);
  const returns = checkReturnsAcrossTheBorder(ledger, today, problems);

  // Net worth near the target.
  const byAccount: DemoDbReport["byAccount"] = [];
  let nw = 0;
  for (const [key, id] of ids) {
    const mark = accountMarkClpAtYmd(id, today);
    const v = mark?.value_clp ?? 0;
    const name = (db.prepare(`SELECT name FROM accounts WHERE id = ?`).get(id) as { name: string }).name;
    const liability = key.startsWith("loan:") || key.startsWith("card:");
    // A property account is marked as equity (value − its loan): the loan is already netted.
    const signed = key.startsWith("loan:") ? 0 : liability ? -v : v;
    nw += signed;
    byAccount.push({ name, clp: Math.round(liability ? -v : v) });
  }
  const fx = market.fx(today);
  const nwUsd = nw / fx;
  const target = ledger.person.netWorthTargetUsd;
  if (target != null && Math.abs(nwUsd / target - 1) > NET_WORTH_TOLERANCE) {
    problems.push(`net worth US$${Math.round(nwUsd)} is more than ${NET_WORTH_TOLERANCE * 100} % from US$${target}`);
  }

  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  const report: DemoDbReport = {
    today,
    movements: count(`SELECT COUNT(*) AS n FROM movements`),
    cartolas: count(`SELECT COUNT(*) AS n FROM checking_cartola_imports`),
    statements: count(`SELECT COUNT(*) AS n FROM cc_statements`),
    statementLines: count(`SELECT COUNT(*) AS n FROM cc_statement_lines`),
    installmentPlans: count(`SELECT COUNT(*) AS n FROM cc_installment_purchases`),
    payslips: {
      contract: ledger.payslips.length,
      contractor: ledger.contractorPayslips.length,
      us: ledger.usPayslips.length,
      linked: extra.payslips?.linked ?? 0,
      unmatched: extra.payslips?.unmatched.length ?? 0,
    },
    netWorthClp: Math.round(nw),
    netWorthUsd: Math.round(nwUsd),
    byAccount,
    monthsOutsideBand: ledger.months.filter((m) => m.cushionClp > m.band[1] * 1.5).length,
    us: usReport,
    savingsFundClp,
    properties,
    usCard,
    cashUnexplainedWorstClp,
    returns,
  };
  if (problems.length > 0) {
    throw new Error(`demo invariants failed:\n  - ${problems.join("\n  - ")}\n${JSON.stringify(report, null, 1)}`);
  }
  return report;
}

/**
 * The US chapter: the US checking account's app balance is the story's and never dips below zero;
 * every pay stub is paired with the credit that paid it and checks clean against the federal law
 * (FICA, the percentage method); every debit the US statement lists is a gastos line; the W-2s
 * add up from the stored stubs; and the Retirement tree reads Chile / US.
 */
function checkUsChapter(ledger: Ledger, ids: Map<Acct, number>, today: Ymd, problems: string[]): DemoDbReport["us"] {
  const usId = ids.get("usChecking");
  if (usId == null) {
    if (ledger.usPayslips.length > 0 || ledger.usBank.length > 0) problems.push("US pay stubs or statement rows without a US checking account");
    return null;
  }
  const cents = (v: number) => Math.round(v * 100) / 100;
  const expected = cents(ledger.usCheckingBalanceUsd);
  const actual = cents(usdCashBalanceUsdAt(usId, today));
  if (Math.abs(actual - expected) > 0.005) problems.push(`US checking: app balance US$ ${actual}, story balance US$ ${expected}`);
  // Day by day, every movement the app reads on the account (statement rows and transfers).
  const rows = db
    .prepare(
      `SELECT id, account_id, from_account_id, to_account_id, amount, currency, counter_amount, counter_currency, occurred_on, note, units_delta, flow_kind
       FROM movements WHERE account_id = ? OR from_account_id = ? OR to_account_id = ?`
    )
    .all(usId, usId, usId) as MovementTransferRow[];
  const byDay = new Map<string, number>();
  for (const r of rows) byDay.set(r.occurred_on, (byDay.get(r.occurred_on) ?? 0) + signedUsdDeltaForAccountMovement(r, usId));
  let bal = 0;
  for (const [day, delta] of [...byDay].sort()) {
    bal += delta;
    if (bal < -0.005) {
      problems.push(`US checking goes negative: US$ ${cents(bal)} on ${day}`);
      break;
    }
  }

  const stored = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN movement_id IS NULL THEN 0 ELSE 1 END), 0) AS linked
         FROM payroll_work_earnings WHERE jurisdiction = 'us'`
    )
    .get() as { n: number; linked: number };
  if (stored.n !== ledger.usPayslips.length) problems.push(`${ledger.usPayslips.length} US pay stubs generated, ${stored.n} stored`);
  if (stored.linked !== stored.n) problems.push(`${stored.n - stored.linked} US pay stub(s) not paired with their credit`);
  const unclean = buildPayslipChecks().filter((c) => c.jurisdiction === "us" && (c.pending || c.differences.length > 0));
  if (unclean.length > 0) {
    problems.push(`${unclean.length} US pay stub(s) do not check clean: ${JSON.stringify(unclean.slice(0, 2).map((c) => c.differences))}`);
  }

  const debits = listDollarCheckingMovements(usId, "out");
  const lines = buildCheckingGastosLinesForAccounts([usId], {});
  if (debits.length === 0) problems.push("the US checking account lists no debits");
  if (lines.length !== debits.length) problems.push(`US checking: ${debits.length} debits, ${lines.length} gastos lines`);
  // A transfer to or from savings is a transfer leg, never a listed row (the statement prints it).
  const transferRows = ledger.usBank.filter((r) => r.transfer).length;
  const listed = listDollarCheckingMovements(usId, "in").length + debits.length;
  if (listed !== ledger.usBank.length - transferRows) problems.push(`US checking: ${ledger.usBank.length - transferRows} statement rows to write, ${listed} listed`);

  // The savings account: the app's balance is the story's, and it never dips below zero.
  const savingsId = ids.get("usSavings");
  let savingsUsd: number | null = null;
  if (savingsId != null) {
    if (ledger.usSavingsBalanceUsd == null) problems.push("a US savings account with no balance in the story");
    const expectedSavings = cents(ledger.usSavingsBalanceUsd ?? 0);
    savingsUsd = cents(usdCashBalanceUsdAt(savingsId, today));
    if (Math.abs(savingsUsd - expectedSavings) > 0.005) problems.push(`US savings: app balance US$ ${savingsUsd}, story balance US$ ${expectedSavings}`);
    const savingsRows = db
      .prepare(
        `SELECT id, account_id, from_account_id, to_account_id, amount, currency, counter_amount, counter_currency, occurred_on, note, units_delta, flow_kind
         FROM movements WHERE account_id = ? OR from_account_id = ? OR to_account_id = ?`
      )
      .all(savingsId, savingsId, savingsId) as MovementTransferRow[];
    const byDaySavings = new Map<string, number>();
    for (const r of savingsRows) byDaySavings.set(r.occurred_on, (byDaySavings.get(r.occurred_on) ?? 0) + signedUsdDeltaForAccountMovement(r, savingsId));
    let sBal = 0;
    for (const [d, delta] of [...byDaySavings].sort()) {
      sBal += delta;
      if (sBal < -0.005) {
        problems.push(`US savings goes negative: US$ ${cents(sBal)} on ${d}`);
        break;
      }
    }
    if (ledger.usBank.length > 0 && transferRows === 0) problems.push("a US savings account, but the statement prints no transfer to or from it");
  } else if (ledger.usSavingsBalanceUsd != null) problems.push("a US savings balance in the story without a savings account");

  const totals = new Map(
    (
      db
        .prepare(
          `SELECT SUBSTR(w.pay_date, 1, 4) AS year, l.kind AS kind, SUM(l.amount) AS total
             FROM payslip_lines l JOIN payroll_work_earnings w ON w.id = l.payslip_id
            WHERE w.jurisdiction = 'us' GROUP BY year, l.kind`
        )
        .all() as { year: string; kind: string; total: number }[]
    ).map((r) => [`${r.year}|${r.kind}`, cents(r.total)])
  );
  for (const w of ledger.usW2s) {
    const boxes: [string, number][] = [
      ["federal_income_tax", w.federalWithheld],
      ["social_security_tax", w.socialSecurityTax],
      ["medicare_tax", w.medicareTax],
      ["retirement_401k_pretax", w.box12D],
      ["hsa", w.box12W],
    ];
    for (const [kind, v] of boxes) {
      const got = totals.get(`${w.year}|${kind}`) ?? 0;
      if (Math.abs(got - v) > 0.005) problems.push(`W-2 ${w.year}: ${kind} US$ ${v}, the stored stubs US$ ${got}`);
    }
  }

  if (ids.has("k401")) {
    const groups = db.prepare(`SELECT slug FROM portfolio_groups WHERE slug IN ('retirement_cl', 'retirement_us')`).all() as { slug: string }[];
    if (groups.length !== 2) problems.push(`the Retirement tree does not split into Chile and US (${groups.map((g) => g.slug).join(", ")})`);
    else {
      // Each retirement account sits on its own side of the split, and no account on both.
      const side = (slug: string) => new Set(accountIdsInPortfolioGroup(slug));
      const us = side("retirement_us");
      const cl = side("retirement_cl");
      for (const key of ["k401", "hsa", "rothIra"] as const) {
        const id = ids.get(key);
        if (id != null && !us.has(id)) problems.push(`${key} is not under Retirement › US`);
        if (id != null && cl.has(id)) problems.push(`${key} is under Retirement › Chile`);
      }
      for (const key of ["afpModelo", "afpUno", "afc", "apvA", "apvB"] as const) {
        const id = ids.get(key);
        if (id != null && !cl.has(id)) problems.push(`${key} is not under Retirement › Chile`);
        if (id != null && us.has(id)) problems.push(`${key} is under Retirement › US`);
      }
    }
  }
  return { statementRows: ledger.usBank.length, gastosLines: lines.length, balanceUsd: actual, savingsUsd };
}

/**
 * The Chilean money-market fund: the app values it at the cuotas held × the series' value today,
 * the cuotas being what the story holds (deposits less redemptions), and its cuotas never go below zero.
 */
function checkSavingsFund(ledger: Ledger, ids: Map<Acct, number>, market: MarketReader, today: Ymd, problems: string[]): number | null {
  const id = ids.get("savingsClp");
  if (id == null) {
    if (ledger.savingsClpUnits != null) problems.push("money-market cuotas in the story without a fund account");
    return null;
  }
  if (ledger.savingsClpUnits == null) {
    problems.push("a money-market fund account with no cuotas in the story");
    return null;
  }
  let units = 0;
  for (const m of [...ledger.direct].filter((d) => d.type === "transfer" && (d.from === "savingsClp" || d.to === "savingsClp")).sort((a, b) => a.date.localeCompare(b.date))) {
    if (m.type !== "transfer" || m.units == null) throw new Error("demo: a money-market transfer without cuotas");
    units = Math.round((units + (m.to === "savingsClp" ? m.units : -m.units)) * 1e4) / 1e4;
    if (units < -0.00005) problems.push(`money-market fund: cuotas below zero on ${m.date} (${units})`);
  }
  if (Math.abs(units - ledger.savingsClpUnits) > 0.00005) problems.push(`money-market fund: ${units} cuotas from the transfers, ${ledger.savingsClpUnits} in the story`);
  const expected = Math.round(units * market.fundUnit(MONEY_MARKET_SERIES_KEY, today));
  const actual = accountMarkClpAtYmd(id, today)?.value_clp ?? NaN;
  if (Math.abs(actual - expected) > 2) problems.push(`money-market fund: the app's value ${Math.round(actual)}, the story's ${expected}`);
  return Math.round(actual);
}

/**
 * Every US tax year whose April has passed has its 1040 filed and its refund or payment linked to the
 * US checking movement (to the dollar); every filed F22 of a year with a US salary declares it in
 * 1030 with its credit in 748 and 1018 — and the credit is the draft's (the filed 1040's tax).
 */
function checkReturnsAcrossTheBorder(ledger: Ledger, today: Ymd, problems: string[]): DemoDbReport["returns"] {
  const f1040: DemoDbReport["returns"]["f1040"] = [];
  // Every US payroll year whose April has passed was filed in the story (the loop below then checks the stored return).
  for (const year of new Set(ledger.usPayslips.map((p) => Number(p.payDate.slice(0, 4))))) {
    const filedOn = ledger.usAprilSettlements.get(year)?.filedOn;
    if (today >= `${year + 1}-04-30` && filedOn == null) problems.push(`1040 ${year}: US pay stubs in the year, no return filed in the story`);
  }
  for (const [year, s] of [...ledger.usAprilSettlements].sort((a, b) => a[0] - b[0])) {
    if (s.filedOn > today) continue;
    const filed = filedF1040(year);
    if (!filed) {
      problems.push(`1040 ${year}: filed on ${s.filedOn} in the story, not stored`);
      continue;
    }
    const settlement = f1040Settlement(year)!;
    const owed = (filed.lines["37"] ?? 0) - (filed.lines["35a"] ?? 0);
    if (owed !== s.usd) problems.push(`1040 ${year}: the filed return settles US$${owed}, the story booked US$${s.usd}`);
    if (settlement.expected && s.settledOn <= today) {
      if (settlement.links.length !== 1 || settlement.difference !== 0) {
        problems.push(`1040 ${year}: settlement links ${settlement.links.length}, difference ${settlement.difference}`);
      }
    }
    f1040.push({
      taxYear: year,
      line24: filed.lines["24"] ?? 0,
      line35a: filed.lines["35a"] ?? 0,
      line37: filed.lines["37"] ?? 0,
      settlementMovementId: settlement.links[0]?.movement_id ?? null,
    });
  }
  const f22: DemoDbReport["returns"]["f22"] = [];
  const usYears = new Set(ledger.usPayslips.map((p) => Number(p.payDate.slice(0, 4))));
  for (const year of [...usYears].sort()) {
    const taxYear = year + 1;
    const filedRows = db.prepare(`SELECT code, amount FROM sii_f22_filed WHERE tax_year = ?`).all(taxYear) as { code: number; amount: number }[];
    if (filedRows.length === 0) continue;
    const filed = new Map(filedRows.map((r) => [r.code, r.amount]));
    if (year < CHILE_US_TREATY_FIRST_INCOME_YEAR) problems.push(`F22 AT${taxYear}: a US salary before the treaty`);
    const d = buildF22Draft(taxYear, today);
    const applied = d.foreignSalaryCredit?.appliedClp ?? 0;
    if (!((filed.get(1030) ?? 0) > 0)) problems.push(`F22 AT${taxYear}: a US salary in ${year} but no code 1030`);
    if (!(applied > 0)) problems.push(`F22 AT${taxYear}: no credit for the US tax on the salary`);
    if ((filed.get(1018) ?? 0) < applied) problems.push(`F22 AT${taxYear}: 1018 ${filed.get(1018)} below the salary credit ${applied}`);
    if (d.foreignSalary.usTaxSource !== "filed") problems.push(`F22 AT${taxYear}: the credit reads the ${d.foreignSalary.usTaxSource} 1040, not the filed one`);
    if ((filed.get(1030) ?? 0) !== (d.draft[1030] ?? 0)) problems.push(`F22 AT${taxYear}: filed 1030 ${filed.get(1030)} vs draft ${d.draft[1030]}`);
    f22.push({
      taxYear,
      c1030: filed.get(1030) ?? 0,
      c748: filed.get(748) ?? 0,
      c1018: filed.get(1018) ?? 0,
      c304: filed.get(304) ?? 0,
      c305: filed.get(305) ?? 0,
      creditApplied: applied,
    });
  }
  return { f1040, f22 };
}

/**
 * Every house: the app's loan balance and property equity are the story's, every cuota and prepago is
 * a `loan_payments` row of its own loan, every regular cuota's card line is linked to the deposit it
 * funded, every rent credit is the rent of its place, every bill a bill row of its place, and a DFL-2
 * place's contribuciones are halved exactly the years the app says the halving lasts.
 */
function checkProperties(ledger: Ledger, ids: Map<Acct, number>, market: MarketReader, today: Ymd, problems: string[]): DemoDbReport["properties"] {
  const out: DemoDbReport["properties"] = [];
  const places = new Map(listRealEstatePlaces().map((p) => [p.slug, p]));
  for (const m of ledger.mortgages) {
    const h = m.house;
    const propertyId = ids.get(`property:${h.key}`)!;
    const loanId = ids.get(`loan:${h.key}`)!;
    const uf = market.uf(today);
    const balanceUf = mortgageBalanceUf(m, today);
    const loanClp = accountMarkClpAtYmd(loanId, today)?.value_clp ?? NaN;
    if (Math.abs(loanClp - balanceUf * uf) > 2) problems.push(`${h.key}: the app's loan ${Math.round(loanClp)}, the story's ${Math.round(balanceUf * uf)}`);
    const last = [...m.cuotas].filter((c) => c.date <= today).sort((a, b) => a.date.localeCompare(b.date)).at(-1);
    const appraisalDay = last?.date ?? m.pieDate;
    const valueUf = Math.round(h.valueUf * Math.pow(1 + h.monthlyAppreciation, Math.max(0, (Date.parse(appraisalDay) - Date.parse(m.pieDate)) / (30.44 * 86_400_000))) * 1e4) / 1e4;
    const equityClp = accountMarkClpAtYmd(propertyId, today)?.value_clp ?? NaN;
    const storyEquity = (valueUf - balanceUf) * uf;
    if (Math.abs(equityClp - storyEquity) > 5) problems.push(`${h.key}: the app's equity ${Math.round(equityClp)}, the story's ${Math.round(storyEquity)}`);

    const count = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n;
    const payments = count(`SELECT COUNT(*) AS n FROM loan_payments WHERE loan_account_id = ? AND leg = 'loan'`, loanId);
    const cuotas = m.cuotas.filter((c) => c.date <= today).length;
    if (payments !== cuotas) problems.push(`${h.key}: ${cuotas} cuotas and prepagos, ${payments} loan_payments rows`);
    const linked = count(
      `SELECT COUNT(*) AS n FROM flow_links l JOIN movements d ON d.flow_id = l.counterpart_flow_id
        WHERE l.kind = 'funded_deposit' AND l.depto_cuota IS NOT NULL AND d.account_id = ?`,
      propertyId
    );
    const regular = m.cuotas.filter((c) => c.n != null && c.date <= today).length;
    if (linked !== regular) problems.push(`${h.key}: ${regular} regular cuotas, ${linked} cuota card lines linked to their deposit`);

    const place = places.get(h.key);
    if (!place) {
      problems.push(`${h.key}: no real-estate place`);
      continue;
    }
    const rents = ledger.rents.filter((r) => r.house === h.key);
    const marked = count(
      `SELECT COUNT(*) AS n FROM flow_income_overrides o JOIN expense_accounts a ON a.id = o.rent_place_id WHERE o.income_kind = 'rent' AND a.slug = ?`,
      h.key
    );
    if (marked !== rents.length) problems.push(`${h.key}: ${rents.length} rent credits, ${marked} marked as its rent`);
    const bills = ledger.placeBills.filter((b) => b.house === h.key);
    const rows = count(`SELECT COUNT(*) AS n FROM expense_entries WHERE expense_account_id = ?`, place.id);
    if (rows !== bills.length) problems.push(`${h.key}: ${bills.length} bills paid, ${rows} bill rows`);
    if ((h.dfl2 != null) !== place.dfl2) problems.push(`${h.key}: DFL-2 in the story ${h.dfl2 != null}, in the app ${place.dfl2}`);
    for (const b of bills) {
      if (b.kind !== "contribuciones") continue;
      const through = place.dfl2_contribuciones_halved_through;
      const appHalves = through != null && Number(b.date.slice(0, 4)) <= through;
      if (Boolean(b.halved) !== appHalves) problems.push(`${h.key}: contribuciones of ${b.date} halved ${Boolean(b.halved)}, the app's window says ${appHalves}`);
    }
    out.push({ key: h.key, equityClp: Math.round(equityClp), loanClp: Math.round(loanClp), cuotas: payments, linkedCardLines: linked, rents: marked, bills: rows });
  }
  return out;
}

/**
 * The US card: every statement bills exactly its charges (the purchases plus the issuer's fees) and
 * carries the previous one's payment as a line, and every payment is a dollar transfer from US
 * checking to the card on the payment day, for the payment.
 */
function checkUsCard(ledger: Ledger, ids: Map<Acct, number>, problems: string[]): DemoDbReport["usCard"] {
  const card = ledger.person.cards.find((c) => c.issuer === "lonestar");
  if (!card) return null;
  const cardId = ids.get(`card:${card.key}`)!;
  const usId = ids.get("usChecking");
  if (usId == null) {
    problems.push("a US card without a US checking account");
    return null;
  }
  const statements = db
    .prepare(
      `SELECT s.id, s.statement_date, s.monto_facturado, s.compras_cargos,
              COALESCE((SELECT SUM(l.amount_usd) FROM cc_statement_lines l WHERE l.statement_id = s.id AND l.amount_usd > 0), 0) AS charges,
              (SELECT COUNT(*) FROM cc_statement_lines l WHERE l.statement_id = s.id) AS lines
         FROM cc_statements s WHERE s.account_id = ? AND s.currency = 'usd'`
    )
    .all(cardId) as { id: number; statement_date: string; monto_facturado: number; compras_cargos: number; charges: number; lines: number }[];
  const story = ledger.statements.filter((s) => s.card === card.key);
  if (statements.length !== story.length) problems.push(`US card: ${story.length} statements closed, ${statements.length} on file`);
  for (const s of statements) {
    if (Math.abs(s.monto_facturado - s.charges) > 0.005) problems.push(`US card ${s.statement_date}: billed US$ ${s.monto_facturado}, its charges US$ ${s.charges}`);
  }
  const paymentLines = db
    .prepare(
      `SELECT l.transaction_date AS day, l.amount_usd AS usd FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id
        WHERE s.account_id = ? AND l.amount_usd < 0`
    )
    .all(cardId) as { day: string; usd: number }[];
  const transfers = db
    .prepare(`SELECT occurred_on AS day, amount AS usd FROM movements WHERE from_account_id = ? AND to_account_id = ? AND flow_kind = 'pago_tarjeta' AND currency = 'usd'`)
    .all(usId, cardId) as { day: string; usd: number }[];
  // A statement line prints its day as dd/mm/yyyy, a movement as ISO.
  const iso = (day: string) => (/^\d{2}\/\d{2}\/\d{4}$/.test(day) ? `${day.slice(6, 10)}-${day.slice(3, 5)}-${day.slice(0, 2)}` : day);
  const key = (day: string, usd: number) => `${iso(day)}|${Math.round(Math.abs(usd) * 100)}`;
  const paid = new Set(transfers.map((t) => key(t.day, t.usd)));
  const unpaired = paymentLines.filter((l) => !paid.has(key(l.day, l.usd)));
  if (unpaired.length > 0) problems.push(`US card: ${unpaired.length} payment line(s) with no transfer from US checking (${unpaired.slice(0, 3).map((u) => `${u.day} ${u.usd}`).join(", ")})`);
  const settledInStory = story.filter((s) => s.paidPrevious > 0).length;
  if (paymentLines.length !== settledInStory) problems.push(`US card: ${settledInStory} payments in the story, ${paymentLines.length} payment lines`);
  return { statements: statements.length, lines: statements.reduce((a, s) => a + s.lines, 0), payments: transfers.length };
}

/** How far a month of the flows overview's «sin explicar» may sit from the story's own conversion costs (CLP). */
export const CASH_UNEXPLAINED_TOLERANCE_CLP = 1_000;

/**
 * The flows overview's «sin explicar» every month: what checking moved that no leg of the overview
 * accounts for. The overview carries the fx result of the dollars held in the checking accounts
 * (`cash_fx`), so what is left is two frame costs the story states and no leg counts, both
 * computed here from the movements and the app's own rates:
 * - the bank's spread on each conversion between two checking accounts (a dollar sale at
 *   `fx × 0,992`, a purchase at `÷ fx × 0,995`, `simulate.ts`): the value that entered less the
 *   value that left, dollars at the sell rate the app holds them at;
 * - the half spread on every dollar flow the legs count at the day's mid (`fx_daily`: the US
 *   salary and the other single-leg rows of a dollar checking account, its card autopays — the
 *   income lines, the gastos lines and `loadCardPaymentsFromChecking` price them so) while the
 *   dollars are held at the sell rate: signed dollars × (sell − mid).
 * What those two leave is rounding (3 pesos on 2026-11-10); anything beyond is a bug (a cuota
 * counted as a gasto and as a deposit, a payment no leg sees).
 */
function checkCashExplained(problems: string[]): number {
  const checking = new Set(accountIdsUnderCheckingAccounts());
  const dollar = listDollarCheckingAccountIds();
  const cards = new Set(listCreditCardMasterAccountIds());
  const sell = (day: string) => {
    const r = convertValue(1, "usd", "clp", day, "asset");
    if (r == null) throw new Error(`demo invariants: no USD sell rate on or before ${day}`);
    return r;
  };
  const mid = (day: string) => {
    const r = fxRowOnOrBefore(day);
    if (!r) throw new Error(`demo invariants: no fx_daily row on or before ${day}`);
    return r.clp_per_usd;
  };
  const inClp = (amount: number, currency: string, day: string) => {
    if (currency === "clp") return amount;
    if (currency === "usd") return amount * sell(day);
    throw new Error(`demo invariants: unexpected currency ${currency} on ${day}`);
  };
  const knownByMonth = new Map<string, number>();
  const add = (month: string, clp: number) => knownByMonth.set(month, (knownByMonth.get(month) ?? 0) + clp);
  // The conversions between two checking accounts: what the receiving leg is worth less what left.
  const conversions = db
    .prepare(`SELECT from_account_id, to_account_id, amount, currency, counter_amount, counter_currency, occurred_on FROM movements WHERE from_account_id IS NOT NULL AND counter_currency IS NOT NULL`)
    .all() as { from_account_id: number; to_account_id: number; amount: number; currency: string; counter_amount: number; counter_currency: string; occurred_on: string }[];
  for (const t of conversions) {
    if (!checking.has(t.from_account_id) || !checking.has(t.to_account_id)) continue;
    add(t.occurred_on.slice(0, 7), inClp(t.counter_amount, t.counter_currency, t.occurred_on) - inClp(t.amount, t.currency, t.occurred_on));
  }
  // The dollar flows the legs count at the mid, held at the sell rate.
  for (const id of dollar) {
    const rows = db
      .prepare(
        `SELECT id, account_id, from_account_id, to_account_id, amount, currency, counter_amount, counter_currency, occurred_on, note, units_delta, flow_kind
           FROM movements WHERE account_id = ? OR from_account_id = ?`
      )
      .all(id, id) as MovementTransferRow[];
    for (const r of rows) {
      // Its own rows, and its payments into a card master (a transfer elsewhere is a deposit leg).
      if (r.from_account_id != null && (r.to_account_id == null || !cards.has(r.to_account_id))) continue;
      add(r.occurred_on.slice(0, 7), signedUsdDeltaForAccountMovement(r, id) * (sell(r.occurred_on) - mid(r.occurred_on)));
    }
  }
  let worst = 0;
  const off: string[] = [];
  for (const r of buildFlowsOverviewPayload("clp", "total", null).months) {
    const residual = r.cash_unexplained - (knownByMonth.get(r.period_month) ?? 0);
    worst = Math.max(worst, Math.abs(residual));
    if (Math.abs(residual) > CASH_UNEXPLAINED_TOLERANCE_CLP) {
      off.push(`${r.period_month} ${Math.round(r.cash_unexplained)} (fx ${Math.round(r.cash_fx)}, known costs ${Math.round(knownByMonth.get(r.period_month) ?? 0)})`);
    }
  }
  if (off.length > 0) problems.push(`flows overview «sin explicar» beyond ${CASH_UNEXPLAINED_TOLERANCE_CLP} after the story's conversion costs: ${off.slice(0, 8).join("; ")}${off.length > 8 ? ` … ${off.length} months` : ""}`);
  return Math.round(worst);
}
