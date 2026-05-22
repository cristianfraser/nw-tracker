import { db } from "./db.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import {
  billingMonthForStatementDate,
  loadCreditCardBillingConfig,
} from "./ccBillingMonth.js";
import {
  installmentRemainingClpByCalendarMonth,
  liveCreditCardOutstandingClp,
} from "./ccInstallmentLedgerDb.js";
import { listCcStatementsForAccount } from "./ccStatementsDb.js";
import { parseDdMmYyToIso } from "./ccInstallmentPayBy.js";
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

function sumNonInstallmentLinesClp(statementId: number): number {
  const rows = db
    .prepare(
      `SELECT amount_clp FROM cc_statement_lines
       WHERE statement_id = ? AND installment_flag = 0 AND amount_clp IS NOT NULL`
    )
    .all(statementId) as { amount_clp: number }[];
  let sum = 0;
  for (const r of rows) {
    if (Number.isFinite(r.amount_clp)) sum += r.amount_clp;
  }
  return sum;
}

function installmentCuotaDueOnStatementClp(statementId: number): number {
  const rows = db
    .prepare(
      `SELECT valor_cuota_mensual_clp FROM cc_statement_lines
       WHERE statement_id = ? AND installment_flag = 1
         AND valor_cuota_mensual_clp IS NOT NULL AND valor_cuota_mensual_clp > 0`
    )
    .all(statementId) as { valor_cuota_mensual_clp: number }[];
  let sum = 0;
  for (const r of rows) {
    sum += r.valor_cuota_mensual_clp;
  }
  return sum;
}

function facturadoFromStatement(
  stmt: { id: number; currency: string; monto_facturado: number | null },
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
  const revolving = sumNonInstallmentLinesClp(stmt.id);
  const cuota = installmentCuotaDueOnStatementClp(stmt.id);
  const clp = revolving + cuota;
  return { facturado_clp: clp > 0 ? clp : null, facturado_usd: null };
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
  const cupoLive = liveCreditCardOutstandingClp(accountId) ?? 0;
  const remainingByMonth = installmentRemainingClpByCalendarMonth(accountId);
  const currentBillingMonth = billingMonthForStatementDate(chileCalendarTodayYmd());
  const statements = listCcStatementsForAccount(accountId);
  let n = 0;

  db.prepare(`DELETE FROM cc_billing_month_balances WHERE account_id = ?`).run(accountId);

  const byClose = new Map<string, StatementBalanceAgg>();

  for (const stmt of statements) {
    const billingMonth = stmt.billing_month;
    const asOfIso = stmt.statement_date_iso;
    if (!billingMonth || !asOfIso) continue;

    const { facturado_clp, facturado_usd } = facturadoFromStatement(
      {
        id: stmt.id,
        currency: stmt.currency,
        monto_facturado: stmt.monto_facturado,
      },
      asOfIso
    );

    const cupoAtMonth = cupoEnCuotasForBillingMonth(
      billingMonth,
      remainingByMonth,
      cupoLive,
      currentBillingMonth
    );
    const revolving = sumNonInstallmentLinesClp(stmt.id);
    const saldo_total_clp = cupoAtMonth + revolving;
    const saldo_total_usd =
      stmt.currency === "usd" && stmt.deuda_total != null ? stmt.deuda_total : 0;

    const key = `${billingMonth}|${asOfIso}`;
    const agg = byClose.get(key) ?? {
      billing_month: billingMonth,
      as_of_date: asOfIso,
      facturado_clp: 0,
      facturado_usd: 0,
      cupo_utilizado_clp: cupoAtMonth,
      saldo_total_clp: 0,
      saldo_total_usd: 0,
    };
    agg.facturado_clp += facturado_clp ?? 0;
    agg.facturado_usd += facturado_usd ?? 0;
    agg.saldo_total_clp += saldo_total_clp;
    agg.saldo_total_usd += saldo_total_usd;
    byClose.set(key, agg);
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
