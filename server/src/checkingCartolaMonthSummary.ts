import {
  checkingMovementBalanceAtMonthEnd,
  getCartolaDerivedAnchor,
  getCheckingLedgerAnchor,
  type CartolaDerivedAnchorDto,
  type CheckingLedgerAnchorDto,
} from "./checkingCartolaBalances.js";
import { isMovementBalanceCashCategory } from "./movementBalanceCashAccounts.js";
import { accountBucketKindSlug } from "./accountBucket.js";
import { db } from "./db.js";
import {
  expandYearMonthsInclusive,
  isCartolaDesdeBoundaryPhantomMonth,
  monthEndUtcYmd,
  monthKeyFromYmd,
  ymCompare,
} from "./calendarMonth.js";

export type CheckingCartolaMonthRow = {
  period_month: string;
  as_of_date: string;
  source_file: string;
  has_cartola: boolean;
  deposits_clp: number;
  withdrawals_clp: number;
  /** Ledger cumsum at month-end (authoritative). */
  balance_end_clp: number | null;
  /** Parsed cartola saldo final — reference only, not used in calculations. */
  cartola_saldo_final_clp: number | null;
  /** Parsed cartola saldo inicial from the statement header. */
  cartola_saldo_inicial_clp: number | null;
  movement_count: number;
  imported_at: string | null;
};

export type CheckingCartolaMonthsResponse = {
  account_id: number;
  imported_months: string[];
  rows: CheckingCartolaMonthRow[];
  ledger_anchor: CheckingLedgerAnchorDto | null;
  cartola_derived_anchor: CartolaDerivedAnchorDto | null;
};

function movementTotalsForCartolaMonth(
  accountId: number,
  periodMonth: string
): { deposits_clp: number; withdrawals_clp: number; movement_count: number } {
  const prefix = `import:cartola|${periodMonth}|%`;
  const rows = db
    .prepare(
      `SELECT amount_clp FROM movements
       WHERE account_id = ? AND note LIKE ?`
    )
    .all(accountId, prefix) as { amount_clp: number }[];

  let deposits_clp = 0;
  let withdrawals_clp = 0;
  for (const r of rows) {
    const a = Number(r.amount_clp);
    if (!Number.isFinite(a) || a === 0) continue;
    if (a > 0) deposits_clp += a;
    else withdrawals_clp += Math.abs(a);
  }
  return { deposits_clp, withdrawals_clp, movement_count: rows.length };
}

function collectTimelineMonthKeys(accountId: number): string[] {
  const keys = new Set<string>();

  try {
    const imports = db
      .prepare(
        `SELECT period_month, period_from, period_to, movement_count
         FROM checking_cartola_imports WHERE account_id = ?`
      )
      .all(accountId) as {
      period_month: string;
      period_from: string | null;
      period_to: string | null;
      movement_count: number;
    }[];
    for (const r of imports) {
      if (
        isCartolaDesdeBoundaryPhantomMonth({
          period_month: r.period_month,
          period_from: r.period_from,
          period_to: r.period_to,
          movement_count: Number(r.movement_count) || 0,
        })
      ) {
        continue;
      }
      keys.add(r.period_month);
    }
  } catch {
    /* migration not applied */
  }

  for (const r of db
    .prepare(`SELECT occurred_on FROM movements WHERE account_id = ?`)
    .all(accountId) as { occurred_on: string }[]) {
    const mk = monthKeyFromYmd(r.occurred_on);
    if (mk) keys.add(mk);
  }

  const hasMov = db
    .prepare(`SELECT 1 FROM movements WHERE account_id = ? LIMIT 1`)
    .get(accountId);
  if (hasMov) {
    for (const r of db
      .prepare(`SELECT occurred_on FROM movements WHERE account_id = ?`)
      .all(accountId) as { occurred_on: string }[]) {
      const mk = monthKeyFromYmd(r.occurred_on);
      if (mk) keys.add(mk);
    }
  }

  return [...keys].sort(ymCompare);
}

export function getCheckingCartolaMonths(accountId: number): CheckingCartolaMonthsResponse | null {
  const cat = db
    .prepare(
      `SELECT g.slug AS bucket_slug FROM accounts a
       JOIN asset_groups g ON g.id = a.asset_group_id
       WHERE a.id = ?`
    )
    .get(accountId) as { bucket_slug: string } | undefined;
  if (!cat || !isMovementBalanceCashCategory(accountBucketKindSlug(cat.bucket_slug))) return null;

  const importByMonth = new Map<
    string,
    {
      source_file: string;
      movement_count: number;
      saldo_final_clp: number | null;
      saldo_inicial_clp: number | null;
      imported_at: string;
    }
  >();
  try {
    const imports = db
      .prepare(
        `SELECT period_month, source_file, movement_count, saldo_final_clp, saldo_inicial_clp, imported_at,
                period_from, period_to
         FROM checking_cartola_imports WHERE account_id = ?`
      )
      .all(accountId) as {
      period_month: string;
      source_file: string;
      movement_count: number;
      saldo_final_clp: number | null;
      saldo_inicial_clp: number | null;
      imported_at: string;
      period_from: string | null;
      period_to: string | null;
    }[];
    for (const imp of imports) {
      if (
        isCartolaDesdeBoundaryPhantomMonth({
          period_month: imp.period_month,
          period_from: imp.period_from,
          period_to: imp.period_to,
          movement_count: Number(imp.movement_count) || 0,
        })
      ) {
        continue;
      }
      importByMonth.set(imp.period_month, imp);
    }
  } catch {
    /* no registry yet */
  }

  const monthKeys = collectTimelineMonthKeys(accountId);
  if (monthKeys.length === 0) {
    return {
      account_id: accountId,
      imported_months: [],
      rows: [],
      ledger_anchor: getCheckingLedgerAnchor(accountId),
      cartola_derived_anchor: getCartolaDerivedAnchor(accountId),
    };
  }

  const minYm = monthKeys[0]!;
  const maxYm = monthKeys[monthKeys.length - 1]!;
  const importedMonths = [...importByMonth.keys()].sort(ymCompare);

  const rows: CheckingCartolaMonthRow[] = [];
  for (const periodMonth of expandYearMonthsInclusive(minYm, maxYm)) {
    const imp = importByMonth.get(periodMonth);
    const asOf = monthEndUtcYmd(periodMonth);
    const totals = imp ? movementTotalsForCartolaMonth(accountId, periodMonth) : {
      deposits_clp: 0,
      withdrawals_clp: 0,
      movement_count: 0,
    };
    const balanceEnd = checkingMovementBalanceAtMonthEnd(accountId, periodMonth);
    const cartolaSaldo =
      imp?.saldo_final_clp != null && Number.isFinite(imp.saldo_final_clp)
        ? imp.saldo_final_clp
        : null;
    const cartolaSaldoInicial =
      imp?.saldo_inicial_clp != null && Number.isFinite(imp.saldo_inicial_clp)
        ? imp.saldo_inicial_clp
        : null;
    rows.push({
      period_month: periodMonth,
      as_of_date: asOf,
      source_file: imp?.source_file ?? "",
      has_cartola: imp != null,
      deposits_clp: totals.deposits_clp,
      withdrawals_clp: totals.withdrawals_clp,
      balance_end_clp: balanceEnd,
      cartola_saldo_final_clp: cartolaSaldo,
      cartola_saldo_inicial_clp: cartolaSaldoInicial,
      movement_count: totals.movement_count || imp?.movement_count || 0,
      imported_at: imp?.imported_at ?? null,
    });
  }

  rows.sort((a, b) => ymCompare(b.period_month, a.period_month));

  return {
    account_id: accountId,
    imported_months: importedMonths,
    rows,
    ledger_anchor: getCheckingLedgerAnchor(accountId),
    cartola_derived_anchor: getCartolaDerivedAnchor(accountId),
  };
}
