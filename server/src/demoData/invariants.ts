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
import { buildFlowsOverviewPayload } from "../flowsOverview.js";
import { listRealEstatePlaces } from "../flowsRealEstateExpenses.js";
import { mortgageBalanceUf } from "./simulate.js";
import type { MarketReader } from "./market.js";
import { addDays, type Ymd } from "./person.js";
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
  /** The largest month of the flows overview's «sin explicar», after the dollar accounts' fx (CLP). */
  cashUnexplainedWorstClp: number;
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
  const properties = checkProperties(ledger, ids, market, today, problems);
  const usCard = checkUsCard(ledger, ids, problems);
  const cashUnexplainedWorstClp = checkCashExplained(ids, market, today, problems);

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
    monthsOutsideBand: ledger.months.filter((m) => m.cashClp > m.band[1] * 1.5).length,
    us: usReport,
    properties,
    usCard,
    cashUnexplainedWorstClp,
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

/** How far a month of the flows overview's «sin explicar» may sit from the dollar accounts' fx (CLP). */
export const CASH_UNEXPLAINED_TOLERANCE_CLP = 150_000;

/**
 * The flows overview's «sin explicar» every month: what checking moved that no leg of the overview
 * accounts for. The overview has no fx leg, so a month reads the fx result of the dollars held in the
 * checking accounts (each day's balance revalued at the next day's rate) and the spread of each
 * dollar sale into pesos between them; anything beyond that, within noise, is a bug (a cuota counted
 * as a gasto and as a deposit, a payment no leg sees).
 */
function checkCashExplained(ids: Map<Acct, number>, market: MarketReader, today: Ymd, problems: string[]): number {
  const usdAccounts = (["checkingUsd", "usChecking"] as const).map((k) => ids.get(k)).filter((v): v is number => v != null);
  const fxByMonth = new Map<string, number>();
  const add = (month: string, clp: number) => fxByMonth.set(month, (fxByMonth.get(month) ?? 0) + clp);
  for (const id of usdAccounts) {
    const rows = db
      .prepare(
        `SELECT id, account_id, from_account_id, to_account_id, amount, currency, counter_amount, counter_currency, occurred_on, note, units_delta, flow_kind
           FROM movements WHERE account_id = ? OR from_account_id = ? OR to_account_id = ?`
      )
      .all(id, id, id) as MovementTransferRow[];
    if (rows.length === 0) continue;
    const byDay = new Map<string, number>();
    for (const r of rows) byDay.set(r.occurred_on, (byDay.get(r.occurred_on) ?? 0) + signedUsdDeltaForAccountMovement(r, id));
    let bal = 0;
    let prevRate: number | null = null;
    for (let d = [...byDay.keys()].sort()[0]!; d <= today; d = addDays(d, 1)) {
      const rate = market.fx(d);
      if (prevRate != null) add(d.slice(0, 7), bal * (rate - prevRate));
      bal += byDay.get(d) ?? 0;
      prevRate = rate;
    }
  }
  // A dollar sale between two checking accounts: the pesos received below the dollars' value.
  const checking = new Set([ids.get("checking"), ids.get("vista"), ...usdAccounts].filter((v): v is number => v != null));
  const sales = db
    .prepare(`SELECT from_account_id, to_account_id, amount, currency, counter_amount, counter_currency, occurred_on FROM movements WHERE from_account_id IS NOT NULL AND counter_currency IS NOT NULL`)
    .all() as { from_account_id: number; to_account_id: number; amount: number; currency: string; counter_amount: number; counter_currency: string; occurred_on: string }[];
  for (const t of sales) {
    if (!checking.has(t.from_account_id) || !checking.has(t.to_account_id)) continue;
    const usd = t.currency === "usd" ? t.amount : t.counter_amount;
    const clp = t.currency === "clp" ? t.amount : t.counter_amount;
    add(t.occurred_on.slice(0, 7), clp - usd * market.fx(t.occurred_on));
  }
  let worst = 0;
  const off: string[] = [];
  for (const r of buildFlowsOverviewPayload("clp", "total", null).months) {
    const residual = r.cash_unexplained - (fxByMonth.get(r.period_month) ?? 0);
    worst = Math.max(worst, Math.abs(residual));
    if (Math.abs(residual) > CASH_UNEXPLAINED_TOLERANCE_CLP) off.push(`${r.period_month} ${Math.round(r.cash_unexplained)} (fx ${Math.round(fxByMonth.get(r.period_month) ?? 0)})`);
  }
  if (off.length > 0) problems.push(`flows overview «sin explicar» beyond ${CASH_UNEXPLAINED_TOLERANCE_CLP} after the dollar accounts' fx: ${off.slice(0, 8).join("; ")}${off.length > 8 ? ` … ${off.length} months` : ""}`);
  return Math.round(worst);
}
