import { effectiveCcExpenseLineAmountClp } from "./ccExpenseAmountClp.js";
import { oneShotStatementLineIdsSupersededByInstallmentPurchases } from "./ccCrossImportDedupe.js";
import {
  isInstallmentContractSummaryMerchant,
  redundantInstallmentSummaryLineIds,
  type CcStatementLineForInstallmentTotals,
} from "./ccInstallmentLineDedupe.js";
import { parseDdMmYyToIso } from "./ccInstallmentPayBy.js";
import { db } from "./db.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import {
  billingMonthForStatementDate,
  loadCreditCardBillingConfig,
} from "./ccBillingMonth.js";
import {
  installmentRemainingClpByCalendarMonth,
  ledgerFacturadoClpForBillingMonth,
  liveCreditCardOutstandingClp,
} from "./ccInstallmentLedgerDb.js";
import { listCcStatementsForAccount, type CcStatementRow } from "./ccStatementsDb.js";
import { fxMonthEndForBalanceUsd } from "./fxRates.js";

export type CcBillingMonthBalanceRow = {
  id: number;
  account_id: number;
  billing_month: string;
  as_of_date: string;
  as_of_kind: string;
  facturado_clp: number | null;
  facturado_usd: number | null;
  cupo_utilizado_clp: number;
  saldo_total_clp: number;
  saldo_total_usd: number | null;
};

const upsertBalance = db.prepare(`
  INSERT INTO cc_billing_month_balances (
    account_id, billing_month, as_of_date, as_of_kind,
    facturado_clp, facturado_usd, cupo_utilizado_clp, saldo_total_clp, saldo_total_usd
  ) VALUES (
    @account_id, @billing_month, @as_of_date, @as_of_kind,
    @facturado_clp, @facturado_usd, @cupo_utilizado_clp, @saldo_total_clp, @saldo_total_usd
  )
  ON CONFLICT(account_id, billing_month, as_of_date, as_of_kind) DO UPDATE SET
    facturado_clp = excluded.facturado_clp,
    facturado_usd = excluded.facturado_usd,
    cupo_utilizado_clp = excluded.cupo_utilizado_clp,
    saldo_total_clp = excluded.saldo_total_clp,
    saldo_total_usd = excluded.saldo_total_usd
`);

function sumNonInstallmentLinesForAccountStatementDateClp(
  accountId: number,
  statementDate: string
): number {
  const fxDateIso = parseDdMmYyToIso(statementDate);
  const rows = db
    .prepare(
      `SELECT l.id, l.merchant, l.amount_clp, l.amount_usd, s.currency AS statement_currency,
              l.installment_flag, l.valor_cuota_mensual_clp, l.valor_cuota_mensual_usd
       FROM cc_statement_lines l
       JOIN cc_statements s ON s.id = l.statement_id
       WHERE s.account_id = ? AND s.statement_date = ? AND l.installment_flag = 0`
    )
    .all(accountId, statementDate) as {
    id: number;
    merchant: string | null;
    amount_clp: number | null;
    amount_usd: number | null;
    statement_currency: string;
    installment_flag: number;
    valor_cuota_mensual_clp: number | null;
    valor_cuota_mensual_usd: number | null;
  }[];
  const superseded = oneShotStatementLineIdsSupersededByInstallmentPurchases(accountId);
  let sum = 0;
  for (const r of rows) {
    if (superseded.has(r.id)) continue;
    if (isInstallmentContractSummaryMerchant(r.merchant)) continue;
    const clp = effectiveCcExpenseLineAmountClp(
      { ...r, installment_flag: 0, valor_cuota_mensual_clp: null, valor_cuota_mensual_usd: null },
      fxDateIso
    );
    if (clp != null && Number.isFinite(clp)) sum += clp;
  }
  return sum;
}

function sumNonInstallmentLinesClp(statementId: number): number {
  const row = db
    .prepare(
      `SELECT account_id, statement_date FROM cc_statements WHERE id = ?`
    )
    .get(statementId) as { account_id: number; statement_date: string } | undefined;
  if (!row) return 0;
  return sumNonInstallmentLinesForAccountStatementDateClp(
    row.account_id,
    row.statement_date
  );
}

function installmentCuotaDueForAccountStatementDateClp(
  accountId: number,
  statementDate: string
): number {
  const fxDateIso = parseDdMmYyToIso(statementDate);
  const rows = db
    .prepare(
      `SELECT l.id, l.merchant, l.installment_flag, l.amount_clp, l.amount_usd,
              s.currency AS statement_currency,
              l.valor_cuota_mensual_clp, l.valor_cuota_mensual_usd
       FROM cc_statement_lines l
       JOIN cc_statements s ON s.id = l.statement_id
       WHERE s.account_id = ? AND s.statement_date = ?`
    )
    .all(accountId, statementDate) as {
    id: number;
    merchant: string | null;
    installment_flag: number;
    amount_clp: number | null;
    amount_usd: number | null;
    statement_currency: string;
    valor_cuota_mensual_clp: number | null;
    valor_cuota_mensual_usd: number | null;
  }[];

  const forDedupe: CcStatementLineForInstallmentTotals[] = rows.map((r) => ({
    statement_line_id: r.id,
    account_id: accountId,
    statement_date: statementDate,
    merchant: r.merchant,
    installment_flag: r.installment_flag,
    amount_clp: r.amount_clp,
    amount_usd: r.amount_usd,
    valor_cuota_mensual_clp: r.valor_cuota_mensual_clp,
    valor_cuota_mensual_usd: r.valor_cuota_mensual_usd,
    fx_date_iso: fxDateIso,
  }));
  const redundant = redundantInstallmentSummaryLineIds(forDedupe);

  let sum = 0;
  for (const r of rows) {
    if (redundant.has(r.id)) continue;
    if (r.installment_flag !== 1) continue;
    const cuota = effectiveCcExpenseLineAmountClp(
      { ...r, installment_flag: 1 },
      fxDateIso
    );
    if (cuota != null && cuota > 0) sum += cuota;
  }
  return sum;
}

/** Header monto_facturado when present; otherwise Σ revolving lines + installment cuotas on that close. */
export function facturadoFromStatement(
  accountId: number,
  statementDate: string,
  stmt: { currency: string; monto_facturado: number | null },
  fxDate: string
): { facturado_clp: number | null; facturado_usd: number | null } {
  const headerMonto =
    stmt.monto_facturado != null &&
    Number.isFinite(stmt.monto_facturado) &&
    stmt.monto_facturado > 0
      ? stmt.monto_facturado
      : null;
  if (headerMonto != null) {
    if (stmt.currency === "usd") {
      const fx = fxMonthEndForBalanceUsd(fxDate)?.clp_per_usd;
      const clp =
        fx != null && fx > 0 ? Math.round(headerMonto * fx) : null;
      return { facturado_clp: clp, facturado_usd: headerMonto };
    }
    return {
      facturado_clp: Math.round(headerMonto),
      facturado_usd: null,
    };
  }
  const revolving = sumNonInstallmentLinesForAccountStatementDateClp(
    accountId,
    statementDate
  );
  const cuota = installmentCuotaDueForAccountStatementDateClp(accountId, statementDate);
  let clp = revolving + cuota;
  if (clp <= 0) {
    const billingMonth = billingMonthForStatementDate(fxDate);
    if (billingMonth) {
      clp = ledgerFacturadoClpForBillingMonth(accountId, billingMonth);
    }
  }
  return { facturado_clp: clp > 0 ? clp : null, facturado_usd: null };
}

/** One facturado per close (CLP + USD PDFs share the same statement_date). */
function facturadoForCloseStatements(
  accountId: number,
  stmtsAtClose: CcStatementRow[]
): { facturado_clp: number; facturado_usd: number } {
  const clpStmt = stmtsAtClose.find((s) => s.currency !== "usd") ?? null;
  const usdStmt = stmtsAtClose.find((s) => s.currency === "usd") ?? null;
  const clpDerived = clpStmt
    ? facturadoFromStatement(
        accountId,
        clpStmt.statement_date,
        clpStmt,
        clpStmt.statement_date_iso
      )
    : { facturado_clp: null as number | null, facturado_usd: null as number | null };
  const usdDerived = usdStmt
    ? facturadoFromStatement(
        accountId,
        usdStmt.statement_date,
        usdStmt,
        usdStmt.statement_date_iso
      )
    : { facturado_clp: null as number | null, facturado_usd: null as number | null };

  const facturado_clp =
    clpStmt?.monto_facturado != null && clpStmt.monto_facturado > 0
      ? Math.round(clpStmt.monto_facturado)
      : (clpDerived.facturado_clp ?? 0);
  const facturado_usd =
    usdStmt?.monto_facturado != null && usdStmt.monto_facturado > 0
      ? usdStmt.monto_facturado
      : (usdDerived.facturado_usd ?? 0);
  return { facturado_clp, facturado_usd };
}

type StatementBalanceAgg = {
  billing_month: string;
  as_of_date: string;
  facturado_clp: number;
  facturado_usd: number;
  cupo_utilizado_clp: number;
  saldo_total_clp: number;
  saldo_total_usd: number;
};

function cupoEnCuotasForBillingMonth(
  billingMonth: string,
  remainingByMonth: Map<string, number>,
  cupoLive: number,
  currentBillingMonth: string | null
): number {
  if (currentBillingMonth && billingMonth === currentBillingMonth) return cupoLive;
  return remainingByMonth.get(billingMonth) ?? 0;
}

export function recomputeCcBillingMonthBalances(accountId: number): number {
  const remainingByMonth = installmentRemainingClpByCalendarMonth(accountId);
  const cupoLive =
    remainingByMonth.get(billingMonthForStatementDate(chileCalendarTodayYmd()) ?? "") ??
    liveCreditCardOutstandingClp(accountId) ??
    0;
  const currentBillingMonth = billingMonthForStatementDate(chileCalendarTodayYmd());
  const statements = listCcStatementsForAccount(accountId);
  let n = 0;

  db.prepare(`DELETE FROM cc_billing_month_balances WHERE account_id = ?`).run(accountId);

  const byClose = new Map<string, StatementBalanceAgg>();
  const stmtsByClose = new Map<string, CcStatementRow[]>();

  for (const stmt of statements) {
    const billingMonth = stmt.billing_month;
    const asOfIso = stmt.statement_date_iso;
    if (!billingMonth || !asOfIso) continue;
    const key = `${billingMonth}|${asOfIso}`;
    const list = stmtsByClose.get(key) ?? [];
    list.push(stmt);
    stmtsByClose.set(key, list);
  }

  for (const [key, stmtsAtClose] of stmtsByClose) {
    const primary = stmtsAtClose.find((s) => s.currency !== "usd") ?? stmtsAtClose[0]!;
    const billingMonth = primary.billing_month!;
    const asOfIso = primary.statement_date_iso;
    const { facturado_clp, facturado_usd } = facturadoForCloseStatements(
      accountId,
      stmtsAtClose
    );
    const cupoAtMonth = cupoEnCuotasForBillingMonth(
      billingMonth,
      remainingByMonth,
      cupoLive,
      currentBillingMonth
    );
    const revolving = sumNonInstallmentLinesClp(primary.id);
    const usdStmt = stmtsAtClose.find((s) => s.currency === "usd");
    byClose.set(key, {
      billing_month: billingMonth,
      as_of_date: asOfIso,
      facturado_clp,
      facturado_usd,
      cupo_utilizado_clp: cupoAtMonth,
      saldo_total_clp: cupoAtMonth + revolving,
      saldo_total_usd:
        usdStmt?.deuda_total != null && usdStmt.deuda_total > 0 ? usdStmt.deuda_total : 0,
    });
  }

  for (const agg of byClose.values()) {
    upsertBalance.run({
      account_id: accountId,
      billing_month: agg.billing_month,
      as_of_date: agg.as_of_date,
      as_of_kind: "statement",
      facturado_clp: agg.facturado_clp > 0 ? agg.facturado_clp : null,
      facturado_usd: agg.facturado_usd > 0 ? agg.facturado_usd : null,
      cupo_utilizado_clp: agg.cupo_utilizado_clp,
      saldo_total_clp: agg.saldo_total_clp,
      saldo_total_usd: agg.saldo_total_usd > 0 ? agg.saldo_total_usd : null,
    });
    n += 1;
  }

  const today = chileCalendarTodayYmd();
  const todayMonth = billingMonthForStatementDate(today);
  if (todayMonth) {
    const hasStatement = statements.some((s) => s.billing_month === todayMonth);
    if (!hasStatement) {
      upsertBalance.run({
        account_id: accountId,
        billing_month: todayMonth,
        as_of_date: today,
        as_of_kind: "manual",
        facturado_clp: null,
        facturado_usd: null,
        cupo_utilizado_clp: cupoLive,
        saldo_total_clp: cupoLive,
        saldo_total_usd: null,
      });
      n += 1;
    }
  }

  return n;
}

export function listCcBillingMonthBalances(accountId: number): CcBillingMonthBalanceRow[] {
  return db
    .prepare(
      `SELECT id, account_id, billing_month, as_of_date, as_of_kind,
              facturado_clp, facturado_usd, cupo_utilizado_clp, saldo_total_clp, saldo_total_usd
       FROM cc_billing_month_balances WHERE account_id = ?
       ORDER BY billing_month DESC, as_of_date DESC`
    )
    .all(accountId) as CcBillingMonthBalanceRow[];
}

export function patchCreditCardBillingConfig(
  accountId: number,
  patch: { billing_cycle_start_day?: number; billing_cycle_end_day?: number | null }
): void {
  const cur = loadCreditCardBillingConfig(accountId);
  const start = patch.billing_cycle_start_day ?? cur.billing_cycle_start_day;
  const end =
    patch.billing_cycle_end_day !== undefined
      ? patch.billing_cycle_end_day
      : cur.billing_cycle_end_day;
  db.prepare(
    `INSERT INTO credit_card_account_config (account_id, billing_cycle_start_day, billing_cycle_end_day)
     VALUES (?, ?, ?)
     ON CONFLICT(account_id) DO UPDATE SET
       billing_cycle_start_day = excluded.billing_cycle_start_day,
       billing_cycle_end_day = excluded.billing_cycle_end_day`
  ).run(accountId, start, end ?? null);
}
