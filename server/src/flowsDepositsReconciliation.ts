import { db } from "./db.js";
import { accountKindSlugForAccountId } from "./accountBucket.js";
import { SAVINGS_EARNINGS_FLOW_KIND } from "./accountDeposits.js";
import { loadBestLinkSourceByMovementId } from "./expenseDepositLinks.js";
import { depositFlowCategoryFromGroupSlug, listDepositFlowAccounts, type DepositFlowCategory } from "./flowsDeposits.js";
import { monthKeyFromYmd } from "./calendarMonth.js";
import { clpToUsdAtDate } from "./flowMoneyAtDate.js";
import { isUsdCashAccount } from "./movementTransfer.js";
import { getCheckingCartolaMonths } from "./checkingCartolaMonthSummary.js";
import { listMovementBalanceCashAccountIds } from "./movementBalanceCashAccounts.js";
import { loadPureFamilyAhorroDepositMovementIds } from "./cuentaAhorroDepositSplits.js";
import { ahorroDepositNoteIsForensicFamily } from "./cuentaAhorroForensicDeposits.js";
import { loadBudaBufferAccountId, loadCryptoCoinAccountIdsFundedByBuda } from "./budaWallet.js";
import { movementIsStateContribution } from "./depositFlowKind.js";
import {
  loadNetWorthCapitalReturnLedgerOutflows,
  netWorthCapitalLedgerOutflowPairKey,
} from "./flowsCheckingGastos.js";
import { loadConsumedNetWorthCapitalReturnOutflowKeys } from "./flowsCheckingInflows.js";
import {
  clearFxConversionWarnings,
  takeFxConversionWarnings,
  type FxConversionWarning,
} from "./fxConversionWarnings.js";

export type DepositReconciliationStatus =
  | "linked"
  | "linked_synthetic"
  | "resolved_family_funded"
  | "resolved_internal_transfer"
  | "unlinked_no_checking_source"
  | "unlinked_checking_present";

export type DepositReconciliationRow = {
  movement_id: number;
  occurred_on: string;
  account_id: number;
  account_name: string;
  category: DepositFlowCategory;
  amount_clp: number;
  amount_usd: number | null;
  status: DepositReconciliationStatus;
};

export type DepositReconciliationStatusTotals = {
  count: number;
  total_clp: number;
  total_usd: number | null;
};

export type DepositReconciliationByMonth = {
  month: string;
  linked_clp: number;
  linked_synthetic_clp: number;
  resolved_family_funded_clp: number;
  resolved_internal_transfer_clp: number;
  unlinked_no_checking_source_clp: number;
  unlinked_checking_present_clp: number;
  total_clp: number;
};

// Negative deposits (redemptions): net-worth capital *leaving* a non-checking account and returning
// to checking. No synthetic-mirror concept here — a redemption is either matched to a checking inflow
// by the income filter (linked) or not (unlinked, split by whether the month has cuenta_corriente data).
export type DepositRedemptionStatus =
  | "linked"
  | "resolved_internal_transfer"
  | "unlinked_no_checking_source"
  | "unlinked_checking_present";

export type DepositRedemptionRow = {
  occurred_on: string;
  account_id: number;
  account_name: string;
  category: DepositFlowCategory;
  amount_clp: number;
  amount_usd: number | null;
  status: DepositRedemptionStatus;
};

export type DepositReconciliationPayload = {
  rows: DepositReconciliationRow[];
  by_status: Record<DepositReconciliationStatus, DepositReconciliationStatusTotals>;
  by_month: DepositReconciliationByMonth[];
  redemptions: DepositRedemptionRow[];
  redemptions_by_status: Record<DepositRedemptionStatus, DepositReconciliationStatusTotals>;
  fx_conversion_error: boolean;
  fx_conversion_warnings: FxConversionWarning[];
};

const NON_CAPITAL_FLOW_KINDS = new Set([
  "compra_usd",
  "compra_usd_venta_clp",
  "stock_buy",
  "stock_sell",
  "dividend_usd",
  // Cash dividend paid from a stock to USD cash — return of capital, not a checking-funded deposit.
  "dividend_payout",
  // Bank-paid yield on cuenta_ahorro_vivienda (Abonos / Intereses) — P/L, not a funded deposit.
  SAVINGS_EARNINGS_FLOW_KIND,
]);

// AFP and AFC inflows come from payroll (pre-tax payslip deductions), not from a checking/CC
// expense — they never have a matching outflow to link against, so accounts of these kinds are
// excluded from reconciliation entirely (filtered by account, see PAYROLL_ACCOUNT_KIND_SLUGS
// below) rather than showing up as perpetually "unlinked".
const PAYROLL_ACCOUNT_KIND_SLUGS = new Set(["afp", "afc"]);

// The checking bucket (cuenta_corriente + cuenta_vista) is the *funding source* for this feature,
// never a reconciliation target. Its own inflows are income (salary) and internal corriente↔vista
// transfers — out of scope here (handled by the future liquidaciones / income tab). We reconcile
// money crossing the checking-bucket boundary into other net-worth buckets, not flows inside it.
// listMovementBalanceCashAccountIds() is exactly {cuenta_corriente, cuenta_vista}.

const NON_DEPOSIT_NOTE_SQL = `(m.note IS NULL OR m.note NOT LIKE '%cripto-coin-only-wdw%')`;

// Coverage is decided by cuenta_corriente specifically, not the union of every movement-balance
// cash account. cuenta_vista also holds checking-like data and can independently explain (link)
// a deposit, but it does not capture the same transactions as cuenta_corriente — a deposit with
// no match in either account cannot be ruled out as "funded via a missing cuenta_corriente
// cartola month" just because cuenta_vista happens to have data for that same calendar month.
function loadCuentaCorrienteMonthsWithData(): Set<string> {
  const months = new Set<string>();
  for (const accountId of listMovementBalanceCashAccountIds()) {
    if (accountKindSlugForAccountId(accountId) !== "cuenta_corriente") continue;
    const resp = getCheckingCartolaMonths(accountId);
    if (!resp) continue;
    for (const m of resp.imported_months) months.add(m);
  }
  return months;
}

type RawMovementRow = {
  id: number;
  account_id: number;
  occurred_on: string;
  amount_clp: number;
  flow_kind: string | null;
  note: string | null;
};

function loadPositiveInflowMovements(
  accountIds: number[],
  budaBufferId: number | null
): RawMovementRow[] {
  if (accountIds.length === 0) return [];
  const ph = accountIds.map(() => "?").join(",");
  // On the Buda buffer, only `abono` inflows cross the checking boundary; `sell` inflows come from
  // selling coins (internal to the crypto bucket) and must not count as deposits needing an outflow.
  const budaFilter =
    budaBufferId != null ? ` AND NOT (m.account_id = ${budaBufferId} AND m.note IS NOT 'import:buda|abono')` : "";
  return db
    .prepare(
      `SELECT m.id, m.account_id, m.occurred_on, m.amount_clp, m.flow_kind, m.note
       FROM movements m
       WHERE m.account_id IN (${ph})
         AND m.amount_clp > 0
         AND ${NON_DEPOSIT_NOTE_SQL}${budaFilter}
       ORDER BY m.occurred_on, m.id`
    )
    .all(...accountIds) as RawMovementRow[];
}

/** Max day gap between the two legs of an internal net-worth transfer (settlement/booking lag). */
const INTERNAL_TRANSFER_MAX_DAY_GAP = 7;

function daysBetweenYmd(a: string, b: string): number {
  return Math.abs((Date.parse(a) - Date.parse(b)) / 86_400_000);
}

/**
 * Reclassify direct net-worth ↔ net-worth transfers that bypass checking. A still-unlinked deposit in
 * one account and a still-unlinked redemption of the same amount in a *different* account, within a few
 * days, are two legs of one internal move (no checking counterpart by construction — both lists already
 * exclude checking). Pairs are consumed 1:1, closest-gap first, so same-amount peers don't strand each
 * other; both legs become `resolved_internal_transfer`. Only unlinked rows are touched, so a leg that
 * already matched a real checking flow is never stolen. Mutates the passed arrays in place.
 */
export function resolveInternalNetWorthTransfers(
  rows: DepositReconciliationRow[],
  redemptions: DepositRedemptionRow[]
): void {
  const isUnlinked = (s: DepositReconciliationStatus | DepositRedemptionStatus): boolean =>
    s === "unlinked_checking_present" || s === "unlinked_no_checking_source";

  const depIdx = rows.map((_, i) => i).filter((i) => isUnlinked(rows[i]!.status));
  const redIdx = redemptions.map((_, i) => i).filter((i) => isUnlinked(redemptions[i]!.status));

  const pairs: { di: number; ri: number; gap: number }[] = [];
  for (const di of depIdx) {
    const dep = rows[di]!;
    for (const ri of redIdx) {
      const red = redemptions[ri]!;
      if (red.account_id === dep.account_id) continue;
      if (Math.round(red.amount_clp) !== Math.round(dep.amount_clp)) continue;
      const gap = daysBetweenYmd(dep.occurred_on, red.occurred_on);
      if (gap > INTERNAL_TRANSFER_MAX_DAY_GAP) continue;
      pairs.push({ di, ri, gap });
    }
  }
  // Closest gap first, then larger amounts, so the most confident pairs claim their legs first.
  pairs.sort((a, b) => a.gap - b.gap || rows[b.di]!.amount_clp - rows[a.di]!.amount_clp);

  const usedDep = new Set<number>();
  const usedRed = new Set<number>();
  for (const p of pairs) {
    if (usedDep.has(p.di) || usedRed.has(p.ri)) continue;
    usedDep.add(p.di);
    usedRed.add(p.ri);
    rows[p.di]!.status = "resolved_internal_transfer";
    redemptions[p.ri]!.status = "resolved_internal_transfer";
  }
}

/**
 * From-leg keys (netWorthCapitalLedgerOutflowPairKey format) of manual transfer rows whose two
 * endpoints are both net-worth accounts outside the checking bucket. The form's "in/out" moves
 * store one row (`account_id IS NULL`, from → to); its derived from-leg needs no heuristic match —
 * the row itself is the link. Transfers touching checking are NOT internal (they cross the boundary).
 */
function loadInternalNetWorthTransferOutflowKeys(
  netWorthAccountIds: ReadonlySet<number>,
  checkingBucketIds: ReadonlySet<number>
): Set<string> {
  const rows = db
    .prepare(
      `SELECT from_account_id, to_account_id, occurred_on, amount_clp
       FROM movements
       WHERE account_id IS NULL
         AND from_account_id IS NOT NULL
         AND to_account_id IS NOT NULL
         AND amount_clp != 0`
    )
    .all() as { from_account_id: number; to_account_id: number; occurred_on: string; amount_clp: number }[];
  const out = new Set<string>();
  for (const r of rows) {
    if (!netWorthAccountIds.has(r.from_account_id) || !netWorthAccountIds.has(r.to_account_id)) continue;
    if (checkingBucketIds.has(r.from_account_id) || checkingBucketIds.has(r.to_account_id)) continue;
    out.add(`${r.from_account_id}|${r.occurred_on}|${Math.round(Math.abs(r.amount_clp))}`);
  }
  return out;
}

/** @heavy Classify all net-worth positive inflows against the expense_deposit_links table. */
export function buildDepositsReconciliationPayload(): DepositReconciliationPayload {
  clearFxConversionWarnings();

  const accounts = listDepositFlowAccounts(false);
  const accountMap = new Map(accounts.map((a) => [a.account_id, a]));
  const usdCashIds = new Set(accounts.map((a) => a.account_id).filter((id) => isUsdCashAccount(id)));
  const checkingBucketIds = new Set(listMovementBalanceCashAccountIds());
  // Crypto coins are funded internally by the Buda buffer, not directly by checking — exclude them;
  // the buffer's abono deposits are the reconcilable targets (see loadPositiveInflowMovements).
  const cryptoCoinIds = loadCryptoCoinAccountIdsFundedByBuda();
  const budaBufferId = loadBudaBufferAccountId();
  const nonUsdIds = accounts
    .map((a) => a.account_id)
    .filter((id) => !usdCashIds.has(id))
    .filter((id) => !checkingBucketIds.has(id))
    .filter((id) => !cryptoCoinIds.has(id))
    .filter((id) => {
      const kindSlug = accountKindSlugForAccountId(id);
      return kindSlug == null || !PAYROLL_ACCOUNT_KIND_SLUGS.has(kindSlug);
    });

  const linkSourceByMovementId = loadBestLinkSourceByMovementId();
  const pureFamilyAhorroMovementIds = loadPureFamilyAhorroDepositMovementIds();
  const checkingMonths = loadCuentaCorrienteMonthsWithData();

  const movements = loadPositiveInflowMovements(nonUsdIds, budaBufferId);

  const rows: DepositReconciliationRow[] = [];
  let fxError = false;

  for (const m of movements) {
    if (m.flow_kind != null && NON_CAPITAL_FLOW_KINDS.has(m.flow_kind)) continue;
    // APV-A "aporte estatal" — the yearly state match, not the user's own money — never has a
    // checking outflow behind it. Excluded so it isn't a false-positive unmatched inflow.
    if (movementIsStateContribution(m.note)) continue;

    const acc = accountMap.get(m.account_id);
    if (!acc) continue;
    const category = depositFlowCategoryFromGroupSlug(acc.group_slug);
    if (!category) continue;

    const amount_clp = Math.round(m.amount_clp);
    const amount_usd_raw = clpToUsdAtDate(amount_clp, m.occurred_on);
    if (amount_usd_raw == null || !Number.isFinite(amount_usd_raw)) {
      if (amount_clp !== 0) fxError = true;
    }
    const amount_usd = amount_usd_raw != null && Number.isFinite(amount_usd_raw) ? amount_usd_raw : null;

    const linkSource = linkSourceByMovementId.get(m.id);
    let status: DepositReconciliationStatus;
    if (linkSource === "auto" || linkSource === "manual") {
      status = "linked";
    } else if (linkSource === "synthetic") {
      // Includes cuenta_ahorro splits with a self-funded portion (partial synthetic mirror).
      status = "linked_synthetic";
    } else if (pureFamilyAhorroMovementIds.has(m.id) || ahorroDepositNoteIsForensicFamily(m.note)) {
      // cuenta_ahorro deposit that is a family gift — either the split marks self = 0, or the forensic
      // per-deposit history tags it funding=family. No own outflow to mirror, but it is reconciled —
      // resolved, not "needs attention".
      status = "resolved_family_funded";
    } else {
      const month = monthKeyFromYmd(m.occurred_on);
      status =
        month != null && checkingMonths.has(month)
          ? "unlinked_checking_present"
          : "unlinked_no_checking_source";
    }

    rows.push({
      movement_id: m.id,
      occurred_on: m.occurred_on,
      account_id: m.account_id,
      account_name: acc.name,
      category,
      amount_clp,
      amount_usd,
      status,
    });
  }

  // Negative deposits (redemptions): net-worth capital leaving a non-checking account back into
  // checking. Reuse the income filter's own consumed-outflow set so this view can never disagree with
  // what income excludes as a capital return. Keys are identical (same loadNetWorthCapitalReturnLedgerOutflows).
  // Built before the deposit totals so the internal-transfer pass can reclassify both sides first.
  const consumedOutflowKeys = loadConsumedNetWorthCapitalReturnOutflowKeys();
  // From-leg keys of manual transfer rows (account_id IS NULL, from → to) whose destination is
  // another net-worth account outside the checking bucket. Such an outflow is internal by
  // construction — the row itself names where the money went, so no matching is needed. Transfers
  // *into* checking are excluded here: those really cross the boundary and must reconcile against
  // the cartola inflow like any other redemption.
  const internalTransferOutflowKeys = loadInternalNetWorthTransferOutflowKeys(
    new Set(accounts.map((a) => a.account_id)),
    checkingBucketIds
  );
  // Buda buffer outflows are mostly internal (buys fund coins); only `retiro` (Buda → checking) is a
  // real crypto→checking redemption. Keep those, skip the rest of the buffer's outflows and all coin
  // outflows (coin → Buda sells are internal too).
  const budaRetiroKeys = new Set<string>();
  if (budaBufferId != null) {
    const retiros = db
      .prepare(
        `SELECT occurred_on, amount_clp FROM movements
         WHERE account_id = ? AND note = 'import:buda|retiro' AND amount_clp < 0`
      )
      .all(budaBufferId) as { occurred_on: string; amount_clp: number }[];
    for (const r of retiros) {
      budaRetiroKeys.add(`${budaBufferId}|${r.occurred_on}|${Math.round(Math.abs(r.amount_clp))}`);
    }
  }
  const redemptions: DepositRedemptionRow[] = [];
  for (const outflow of loadNetWorthCapitalReturnLedgerOutflows()) {
    if (cryptoCoinIds.has(outflow.account_id)) continue;
    if (
      outflow.account_id === budaBufferId &&
      !budaRetiroKeys.has(netWorthCapitalLedgerOutflowPairKey(outflow))
    ) {
      continue;
    }
    const acc = accountMap.get(outflow.account_id);
    if (!acc) continue;
    const category = depositFlowCategoryFromGroupSlug(acc.group_slug);
    if (!category) continue;

    const amount_clp = Math.round(outflow.amount_clp);
    const amount_usd_raw = clpToUsdAtDate(amount_clp, outflow.occurred_on);
    if ((amount_usd_raw == null || !Number.isFinite(amount_usd_raw)) && amount_clp !== 0) fxError = true;
    const amount_usd = amount_usd_raw != null && Number.isFinite(amount_usd_raw) ? amount_usd_raw : null;

    let status: DepositRedemptionStatus;
    if (internalTransferOutflowKeys.has(netWorthCapitalLedgerOutflowPairKey(outflow))) {
      // The outflow is the from-leg of a manual transfer row whose destination is another
      // net-worth account (form "in/out" moves store one row with from/to) — internal by
      // construction, stronger evidence than any amount/date heuristic.
      status = "resolved_internal_transfer";
    } else if (consumedOutflowKeys.has(netWorthCapitalLedgerOutflowPairKey(outflow))) {
      status = "linked";
    } else {
      const month = monthKeyFromYmd(outflow.occurred_on);
      status =
        month != null && checkingMonths.has(month)
          ? "unlinked_checking_present"
          : "unlinked_no_checking_source";
    }

    redemptions.push({
      occurred_on: outflow.occurred_on,
      account_id: outflow.account_id,
      account_name: acc.name,
      category,
      amount_clp,
      amount_usd,
      status,
    });
  }

  // Internal net-worth ↔ net-worth transfers (e.g. caca daca → Reserva2 between Fintual goals) never
  // cross the checking boundary, so neither leg has a checking counterpart. Pair a still-unlinked
  // deposit with a still-unlinked redemption of the same amount in a different account within a few
  // days and mark both `resolved_internal_transfer` — they net out and are out of reconciliation scope.
  resolveInternalNetWorthTransfers(rows, redemptions);

  rows.sort((a, b) => b.occurred_on.localeCompare(a.occurred_on) || a.account_name.localeCompare(b.account_name));
  redemptions.sort(
    (a, b) => b.occurred_on.localeCompare(a.occurred_on) || a.account_name.localeCompare(b.account_name)
  );

  const emptyTotals = (): DepositReconciliationStatusTotals => ({ count: 0, total_clp: 0, total_usd: 0 });
  const by_status: Record<DepositReconciliationStatus, DepositReconciliationStatusTotals> = {
    linked: emptyTotals(),
    linked_synthetic: emptyTotals(),
    resolved_family_funded: emptyTotals(),
    resolved_internal_transfer: emptyTotals(),
    unlinked_no_checking_source: emptyTotals(),
    unlinked_checking_present: emptyTotals(),
  };
  for (const r of rows) {
    const bucket = by_status[r.status];
    bucket.count += 1;
    bucket.total_clp += r.amount_clp;
    if (bucket.total_usd != null) {
      if (r.amount_usd == null) bucket.total_usd = null;
      else bucket.total_usd += r.amount_usd;
    }
  }

  const byMonthMap = new Map<string, DepositReconciliationByMonth>();
  for (const r of rows) {
    const month = monthKeyFromYmd(r.occurred_on) ?? r.occurred_on.slice(0, 7);
    let pt = byMonthMap.get(month);
    if (!pt) {
      pt = {
        month,
        linked_clp: 0,
        linked_synthetic_clp: 0,
        resolved_family_funded_clp: 0,
        resolved_internal_transfer_clp: 0,
        unlinked_no_checking_source_clp: 0,
        unlinked_checking_present_clp: 0,
        total_clp: 0,
      };
      byMonthMap.set(month, pt);
    }
    pt.total_clp += r.amount_clp;
    if (r.status === "linked") pt.linked_clp += r.amount_clp;
    else if (r.status === "linked_synthetic") pt.linked_synthetic_clp += r.amount_clp;
    else if (r.status === "resolved_family_funded") pt.resolved_family_funded_clp += r.amount_clp;
    else if (r.status === "resolved_internal_transfer") pt.resolved_internal_transfer_clp += r.amount_clp;
    else if (r.status === "unlinked_no_checking_source") pt.unlinked_no_checking_source_clp += r.amount_clp;
    else pt.unlinked_checking_present_clp += r.amount_clp;
  }
  const by_month = [...byMonthMap.values()].sort((a, b) => b.month.localeCompare(a.month));

  const redemptions_by_status: Record<DepositRedemptionStatus, DepositReconciliationStatusTotals> = {
    linked: emptyTotals(),
    resolved_internal_transfer: emptyTotals(),
    unlinked_no_checking_source: emptyTotals(),
    unlinked_checking_present: emptyTotals(),
  };
  for (const r of redemptions) {
    const bucket = redemptions_by_status[r.status];
    bucket.count += 1;
    bucket.total_clp += r.amount_clp;
    if (bucket.total_usd != null) {
      if (r.amount_usd == null) bucket.total_usd = null;
      else bucket.total_usd += r.amount_usd;
    }
  }

  return {
    rows,
    by_status,
    by_month,
    redemptions,
    redemptions_by_status,
    fx_conversion_error: fxError,
    fx_conversion_warnings: takeFxConversionWarnings(),
  };
}
