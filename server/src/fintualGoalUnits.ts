import { db } from "./db.js";
import { transferLegUnitsThroughDate } from "./movementTransfer.js";
import { chileCalendarTodayYmd } from "./chileDate.js";

/** Σ `movements.units_delta` for Fintual certificate / flow rows. */
export function fintualGoalUnitsFromMovements(accountId: number): number | null {
  return fintualGoalUnitsFromMovementsThroughDate(accountId);
}

const stmtUnitsThrough = db.prepare(
  `SELECT COALESCE(SUM(units_delta), 0) AS u FROM movements
   WHERE account_id = ? AND units_delta IS NOT NULL AND date(occurred_on) <= date(?)`
);
const stmtUnitsAll = db.prepare(
  `SELECT COALESCE(SUM(units_delta), 0) AS u FROM movements
   WHERE account_id = ? AND units_delta IS NOT NULL`
);

/**
 * Σ Fintual cuotas through an optional as-of date (`YYYY-MM-DD`; omitted = every row, transfer
 * legs through today): certificate/flow rows on the account plus manual `checking → fund`
 * transfer legs (aportes/retiros entered by hand). Null when the account holds none — an
 * emptied (or never funded) goal. A negative sum is a ledger error (a retiro counted twice, a
 * deposit missing) and throws, as does a malformed date.
 */
export function fintualGoalUnitsFromMovementsThroughDate(
  accountId: number,
  asOfYmd?: string
): number | null {
  if (!Number.isFinite(accountId) || accountId <= 0) return null;
  if (asOfYmd !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(asOfYmd)) {
    throw new Error(`Fintual cuotas of account ${accountId}: as-of date «${asOfYmd}» is not YYYY-MM-DD`);
  }
  const row = (asOfYmd !== undefined ? stmtUnitsThrough.get(accountId, asOfYmd) : stmtUnitsAll.get(accountId)) as
    | { u: number }
    | undefined;
  const ledger = row?.u ?? 0;
  const raw = ledger + transferLegUnitsThroughDate(accountId, asOfYmd ?? chileCalendarTodayYmd());
  if (!Number.isFinite(raw)) throw new Error(`Fintual cuotas of account ${accountId}: the sum is ${raw}`);
  // Rounded before the sign test: cuotas are stored to 4 decimals, and withdrawing exactly the
  // rounded holding leaves a float residue (~1e-12) that must read as an emptied account.
  const u = Math.round(raw * 1e4) / 1e4;
  if (u < 0) {
    throw new Error(
      `Fintual cuotas of account ${accountId} sum to ${u}${asOfYmd ? ` through ${asOfYmd}` : ""}: the ledger holds more out than in`
    );
  }
  return u === 0 ? null : u;
}

/**
 * Newest `occurred_on` (`YYYY-MM-DD`) of a cuota-changing movement touching `accountId`
 * (certificate/flow rows on the account plus manual transfer legs), or null if none. Used to
 * detect a local cuota edit not yet reflected in Fintual's last-polled goals NAV.
 */
export function newestCuotaMovementYmdForAccount(accountId: number): string | null {
  if (!Number.isFinite(accountId) || accountId <= 0) return null;
  const row = db
    .prepare(
      `SELECT MAX(occurred_on) AS d FROM movements
       WHERE units_delta IS NOT NULL
         AND (account_id = ? OR from_account_id = ? OR to_account_id = ?)`
    )
    .get(accountId, accountId, accountId) as { d: string | null } | undefined;
  return row?.d ?? null;
}
