/**
 * What must hold after a synthetic database is generated. A failure throws (the build fails; the live demo
 * keeps its previous version). The report is printed by the generate script.
 */
import type { EmploymentPayslipsApplyDetails } from "nw-tracker-contracts";
import { db } from "../db.js";
import { accountMarkClpAtYmd } from "../accountMarkClpAtYmd.js";
import { checkingMovementBalanceClpAt } from "../checkingCartolaBalances.js";
import { listDollarCheckingMovements } from "../checkingCartolaLoaders.js";
import { buildCheckingGastosLinesForAccounts } from "../flowsCheckingGastos.js";
import { signedUsdDeltaForAccountMovement, type MovementTransferRow } from "../movementTransfer.js";
import { buildPayslipChecks } from "../payslipChecks.js";
import { usdCashBalanceUsdAt } from "../usdCashAccounts.js";
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
  /** The US chapter: the US checking account's statement rows and its gastos lines. */
  us: { statementRows: number; gastosLines: number; balanceUsd: number } | null;
  netWorthClp: number;
  netWorthUsd: number;
  byAccount: { name: string; clp: number }[];
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

  // Net worth near the target.
  const byAccount: DemoDbReport["byAccount"] = [];
  let nw = 0;
  for (const [key, id] of ids) {
    const mark = accountMarkClpAtYmd(id, today);
    const v = mark?.value_clp ?? 0;
    const name = (db.prepare(`SELECT name FROM accounts WHERE id = ?`).get(id) as { name: string }).name;
    const liability = key === ("mortgage" as Acct) || key.startsWith("card:");
    // The property account is marked as equity (value − mortgage): the mortgage is already netted.
    const signed = key === ("mortgage" as Acct) ? 0 : liability ? -v : v;
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
    monthsOutsideBand: ledger.months.filter((m) => m.cashClp > m.band[1] * 1.5).length,
    us: usReport,
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
  }
  return { statementRows: ledger.usBank.length, gastosLines: lines.length, balanceUsd: actual };
}
