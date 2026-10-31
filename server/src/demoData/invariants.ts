/**
 * What must hold after a synthetic database is generated. A failure throws (the build fails; the live demo
 * keeps its previous version). The report is printed by the generate script.
 */
import type { EmploymentPayslipsApplyDetails } from "nw-tracker-contracts";
import { db } from "../db.js";
import { accountMarkClpAtYmd } from "../accountMarkClpAtYmd.js";
import { checkingMovementBalanceClpAt } from "../checkingCartolaBalances.js";
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
  payslips: { contract: number; contractor: number; linked: number; unmatched: number };
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
      linked: extra.payslips?.linked ?? 0,
      unmatched: extra.payslips?.unmatched.length ?? 0,
    },
    netWorthClp: Math.round(nw),
    netWorthUsd: Math.round(nwUsd),
    byAccount,
    monthsOutsideBand: ledger.months.filter((m) => m.cashClp > m.band[1] * 1.5).length,
  };
  if (problems.length > 0) {
    throw new Error(`demo invariants failed:\n  - ${problems.join("\n  - ")}\n${JSON.stringify(report, null, 1)}`);
  }
  return report;
}
