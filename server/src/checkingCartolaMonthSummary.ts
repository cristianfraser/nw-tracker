import { checkingMovementBalanceAtMonthEnd } from "./checkingCartolaBalances.js";
import { db } from "./db.js";
import {
  expandYearMonthsInclusive,
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
  movement_count: number;
  imported_at: string | null;
};

export type CheckingCartolaMonthsResponse = {
  account_id: number;
  imported_months: string[];
  rows: CheckingCartolaMonthRow[];
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
      .prepare(`SELECT period_month FROM checking_cartola_imports WHERE account_id = ?`)
      .all(accountId) as { period_month: string }[];
    for (const r of imports) keys.add(r.period_month);
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
      `SELECT c.slug AS category_slug FROM accounts a
       JOIN categories c ON c.id = a.category_id WHERE a.id = ?`
    )
    .get(accountId) as { category_slug: string } | undefined;
  if (!cat || cat.category_slug !== "cuenta_corriente") return null;

  const importByMonth = new Map<
    string,
    {
      source_file: string;
      movement_count: number;
      saldo_final_clp: number | null;
      imported_at: string;
    }
  >();
  try {
    const imports = db
      .prepare(
        `SELECT period_month, source_file, movement_count, saldo_final_clp, imported_at
         FROM checking_cartola_imports WHERE account_id = ?`
      )
      .all(accountId) as {
      period_month: string;
      source_file: string;
      movement_count: number;
      saldo_final_clp: number | null;
      imported_at: string;
    }[];
    for (const imp of imports) {
      importByMonth.set(imp.period_month, imp);
    }
  } catch {
    /* no registry yet */
  }

  const monthKeys = collectTimelineMonthKeys(accountId);
  if (monthKeys.length === 0) {
    return { account_id: accountId, imported_months: [], rows: [] };
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
    rows.push({
      period_month: periodMonth,
      as_of_date: asOf,
      source_file: imp?.source_file ?? "",
      has_cartola: imp != null,
      deposits_clp: totals.deposits_clp,
      withdrawals_clp: totals.withdrawals_clp,
      balance_end_clp: balanceEnd,
      cartola_saldo_final_clp: cartolaSaldo,
      movement_count: totals.movement_count || imp?.movement_count || 0,
      imported_at: imp?.imported_at ?? null,
    });
  }

  rows.sort((a, b) => ymCompare(b.period_month, a.period_month));

  return {
    account_id: accountId,
    imported_months: importedMonths,
    rows,
  };
}
