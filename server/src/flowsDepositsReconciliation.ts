import { foreignCashToClpAt, isForeignCashAccount } from "./foreignCashAccounts.js";
import { dayWithinWindow, daysBetweenIso } from "nw-tracker-contracts";
import { pairOneToOne } from "./matching/pairing.js";
import { MATCH_WINDOWS } from "./matching/windows.js";
import { PAYROLL_FUNDED_KINDS, TERM_DEPOSIT_KIND } from "./accountProfile.js";
import { db } from "./db.js";
import { accountKindSlugForAccountId } from "./accountBucket.js";
import { CASH_FEE_FLOW_KIND, SAVINGS_EARNINGS_FLOW_KIND } from "./accountDeposits.js";
import {
  computeManualDepositAssertions,
  loadBestLinkSourceByMovementId,
} from "./expenseDepositLinks.js";
import { loadFinalizedCheckingGastosLinesReadOnly } from "./flowsExpenses.js";
import { depositFlowCategoryFromGroupSlug, listDepositFlowAccounts, type DepositFlowCategory } from "./flowsDeposits.js";
import { monthKeyFromYmd } from "./calendarMonth.js";
import { clpToUsdAtDate } from "./flowMoneyAtDate.js";
import {
  MOVEMENT_CLP_LEG_SQL,
  movementClpLegOrZero,
  type MovementAmountFields,
} from "./movementAmounts.js";

import { getCheckingCartolaMonths } from "./checkingCartolaMonthSummary.js";
import { listMovementBalanceCashAccountIds } from "./movementBalanceCashAccounts.js";
import { flowLegsInUnit } from "./flowLegs.js";
import { loadF22RefundMovements } from "./f22Settlements.js";
import { loadBudaBufferAccountId, loadCryptoCoinAccountIdsFundedByBuda } from "./budaWallet.js";
import { movementIsStateContribution } from "./depositFlowKind.js";
import {
  netWorthCapitalLedgerOutflowPairKey,
  outflowFlowClaimKey,
} from "./flowsCheckingGastos.js";
import {
  listDollarCheckingAccountIds,
  listDollarCheckingMovements,
  loadNetWorthCapitalReturnLedgerOutflows,
} from "./checkingCartolaLoaders.js";
import { loadConsumedNetWorthCapitalReturnOutflowKeys } from "./flowsCheckingInflows.js";
import { OPTION_UNITS_FLOW_KINDS } from "./optionFlowKinds.js";
import {
  clearFxConversionWarnings,
  takeFxConversionWarnings,
  type FxConversionWarning,
} from "./fxConversionWarnings.js";

export type DepositReconciliationStatus =
  | "linked"
  | "resolved_tax_refund"
  | "resolved_internal_transfer"
  | "unlinked_no_checking_source"
  | "unlinked_checking_present";

export type DepositReconciliationRow = {
  movement_id: number;
  occurred_on: string;
  account_id: number;
  account_name: string;
  category: DepositFlowCategory;
  /** Legs the unit payload picks from (`flowLegsInUnit`): the pesos (the matching reads them) and the dollars. */
  amount_clp: number;
  amount_usd: number | null;
  /** A dollar deposit: its dollars are the event's own leg (another unit converts them, not their pesos). */
  native?: "usd";
  status: DepositReconciliationStatus;
};

const DEPOSIT_RECONCILIATION_STATUSES: readonly DepositReconciliationStatus[] = [
  "linked",
  "resolved_tax_refund",
  "resolved_internal_transfer",
  "unlinked_no_checking_source",
  "unlinked_checking_present",
];

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

// Checking outflows the user manually categorized as `deposits` — an assertion that a matching
// deposit exists even though the auto-matcher couldn't pair it. `linked` = the relaxed assertion
// pass found exactly one candidate (link written at gastos sync); `asserted_unmatched` = zero or
// several candidates — surfaced instead of guessed.
export type DepositManualAssertionStatus = "linked" | "asserted_unmatched";

export type DepositManualAssertionRow = {
  purchase_key: string;
  account_id: number;
  account_name: string;
  occurred_on: string;
  merchant: string | null;
  amount_clp: number;
  amount_usd: number | null;
  deposit_movement_id: number | null;
  deposit_account_id: number | null;
  deposit_account_name: string | null;
  candidate_count: number;
  status: DepositManualAssertionStatus;
};

const DEPOSIT_REDEMPTION_STATUSES: readonly DepositRedemptionStatus[] = [
  "linked",
  "resolved_internal_transfer",
  "unlinked_no_checking_source",
  "unlinked_checking_present",
];

/** The classified rows, each with its legs; {@link buildDepositsReconciliationPayload} puts them in a unit. */
export type DepositReconciliationLedger = {
  rows: DepositReconciliationRow[];
  redemptions: DepositRedemptionRow[];
  manual_assertions: DepositManualAssertionRow[];
  fx_conversion_error: boolean;
  fx_conversion_warnings: FxConversionWarning[];
};

const NON_CAPITAL_FLOW_KINDS = new Set([
  "fx_purchase",
  "fx_exchange",
  "stock_buy",
  "stock_sell",
  // Cash dividend paid from a stock to USD cash — return of capital, not a checking-funded deposit.
  "dividend_payout",
  // Bank-paid yield on cuenta_ahorro_vivienda (Abonos / Intereses) — P/L, not a funded deposit.
  SAVINGS_EARNINGS_FLOW_KIND,
  // Commission charged to a cash balance — P/L cost, never a checking-funded deposit.
  CASH_FEE_FLOW_KIND,
  // An option's premium moves between a contract account and USD cash; an expiry or an assignment
  // moves contracts — none is a checking-funded deposit.
  ...OPTION_UNITS_FLOW_KINDS,
]);

// AFP and AFC inflows come from payroll (pre-tax payslip deductions), not from a checking/CC
// expense — they never have a matching outflow to link against, so accounts of these kinds are
// excluded from reconciliation entirely (filtered by account, `PAYROLL_FUNDED_KINDS`) rather than
// showing up as perpetually "unlinked".

// The DAP ledger account (import:dap) holds term-deposit principal between checking round-trips.
// Its checking counterparts (Cargo Mercado Capitales out, DAP ... ABONADO back) are already netted
// as internal on the checking side, so DAP inflows/outflows are excluded from reconciliation on
// both sides — including them would demand links for flows the matcher intentionally ignores.

// The checking bucket (cuenta_corriente + cuenta_vista, and the dollar checking accounts) is the
// *funding source* for this feature, never a reconciliation target. Its own inflows are income
// (salary) and internal corriente↔vista transfers — out of scope here (handled by the future
// liquidaciones / income tab). We reconcile money crossing the checking-bucket boundary into other
// net-worth buckets, not flows inside it. listMovementBalanceCashAccountIds() is exactly
// {cuenta_corriente, cuenta_vista}; listDollarCheckingAccountIds() the dollar ones.
//
// A dollar deposit — a single-leg dollar row buying units of a non-cash account, the deposit event
// `accountDeposits.ts` counts — reconciles like a peso one, at its dollars priced at the day's rate,
// and its "checking present" reads the dollar checking accounts' listed months: a dollar deposit is
// funded from a dollar account. Dollar transfers (US checking → a Roth IRA's shares) are transfer
// rows and need no link, like peso transfers; a foreign cash account is never a target (`foreignCashIds`).

/** The months a dollar checking account lists a movement in (either direction). */
function loadDollarCheckingMonthsWithData(): Set<string> {
  const months = new Set<string>();
  for (const accountId of listDollarCheckingAccountIds()) {
    for (const direction of ["in", "out"] as const) {
      for (const m of listDollarCheckingMovements(accountId, direction)) {
        const month = monthKeyFromYmd(m.occurred_on);
        if (month != null) months.add(month);
      }
    }
  }
  return months;
}

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

type RawMovementRow = MovementAmountFields & {
  id: number;
  account_id: number;
  occurred_on: string;
  units_delta: number | null;
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
  // A peso inflow, or a dollar single-leg row buying units (the dollar deposit event).
  return db
    .prepare(
      `SELECT m.id, m.account_id, m.occurred_on, m.amount, m.currency, m.counter_amount, m.counter_currency, m.units_delta, m.flow_kind, m.note
       FROM movements m
       WHERE m.account_id IN (${ph})
         AND (${MOVEMENT_CLP_LEG_SQL} > 0 OR (m.currency = 'usd' AND m.amount > 0 AND m.units_delta IS NOT NULL))
         ${budaFilter}
       ORDER BY m.occurred_on, m.id`
    )
    .all(...accountIds) as RawMovementRow[];
}

/** A dollar deposit row's dollars (positive), else null (see `loadPositiveInflowMovements`). */
function dollarDepositUsd(m: RawMovementRow): number | null {
  return m.currency === "usd" && m.units_delta != null && m.amount > 0 ? m.amount : null;
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

  const deposits = rows.filter((r) => isUnlinked(r.status));
  const redeemed = redemptions.filter((r) => isUnlinked(r.status));

  // Closest gap first, then larger amounts, so the most confident pairs claim their legs first.
  // Same-amount peers at the same gap pair in list order (`nearest_global`): today's rule, declared.
  const { pairs } = pairOneToOne(deposits, redeemed, {
    strategy: "nearest_global",
    accepts: (dep, red) =>
      red.account_id !== dep.account_id &&
      Math.round(red.amount_clp) === Math.round(dep.amount_clp) &&
      dayWithinWindow(dep.occurred_on, red.occurred_on, MATCH_WINDOWS.internal_transfer_legs),
    distance: (dep, red) => Math.abs(daysBetweenIso(dep.occurred_on, red.occurred_on)),
    tieBreak: (a, b) => b.left.amount_clp - a.left.amount_clp,
  });
  for (const p of pairs) {
    p.left.status = "resolved_internal_transfer";
    p.right.status = "resolved_internal_transfer";
  }
}

/**
 * From-leg keys (netWorthCapitalLedgerOutflowPairKey format) of manual transfer rows whose two
 * endpoints are both net-worth accounts outside the checking bucket. The form's "in/out" moves
 * store one row (`account_id IS NULL`, from → to); its derived from-leg needs no heuristic match —
 * the row itself is the link. Transfers touching checking are NOT internal (they cross the boundary)
 * — except `mirror-merge|` conversions: those consumed the matching cartola inflow at conversion
 * time (movementMirrorConvert.ts), so the "must reconcile against the cartola inflow" rule is
 * satisfied structurally and the from-leg is internal by construction.
 */
export function loadInternalNetWorthTransferOutflowKeys(
  netWorthAccountIds: ReadonlySet<number>,
  checkingBucketIds: ReadonlySet<number>
): Set<string> {
  const rows = db
    .prepare(
      `SELECT m.id, m.flow_id, m.from_account_id, m.to_account_id, m.occurred_on, m.amount, m.currency, m.counter_amount, m.counter_currency,
              EXISTS (SELECT 1 FROM movement_mirror_merges mm WHERE mm.transfer_movement_id = m.id) AS is_mirror_merge
       FROM movements m
       WHERE m.account_id IS NULL
         AND m.from_account_id IS NOT NULL
         AND m.to_account_id IS NOT NULL
         AND ${MOVEMENT_CLP_LEG_SQL} != 0`
    )
    .all() as (MovementAmountFields & {
    id: number;
    flow_id: number;
    from_account_id: number;
    to_account_id: number;
    occurred_on: string;
    is_mirror_merge: number;
  })[];
  const out = new Set<string>();
  for (const r of rows) {
    if (!netWorthAccountIds.has(r.from_account_id)) continue;
    const selfResolves = r.is_mirror_merge === 1;
    if (!selfResolves) {
      if (!netWorthAccountIds.has(r.to_account_id)) continue;
      if (checkingBucketIds.has(r.from_account_id) || checkingBucketIds.has(r.to_account_id)) continue;
    }
    out.add(outflowFlowClaimKey(r.from_account_id, r.flow_id));
  }
  return out;
}

/** @heavy Classify all net-worth positive inflows against the deposit links (`funded_deposit` flow links). */
export function classifyDepositsReconciliation(): DepositReconciliationLedger {
  clearFxConversionWarnings();

  const accounts = listDepositFlowAccounts(false);
  const accountMap = new Map(accounts.map((a) => [a.account_id, a]));
  const foreignCashIds = new Set(accounts.map((a) => a.account_id).filter((id) => isForeignCashAccount(id)));
  const checkingBucketIds = new Set([...listMovementBalanceCashAccountIds(), ...listDollarCheckingAccountIds()]);
  // Crypto coins are funded internally by the Buda buffer, not directly by checking — exclude them;
  // the buffer's abono deposits are the reconcilable targets (see loadPositiveInflowMovements).
  const cryptoCoinIds = loadCryptoCoinAccountIdsFundedByBuda();
  const budaBufferId = loadBudaBufferAccountId();
  const nonUsdIds = accounts
    .map((a) => a.account_id)
    .filter((id) => !foreignCashIds.has(id))
    .filter((id) => !checkingBucketIds.has(id))
    .filter((id) => !cryptoCoinIds.has(id))
    .filter((id) => {
      const kindSlug = accountKindSlugForAccountId(id);
      return (
        kindSlug == null ||
        (!PAYROLL_FUNDED_KINDS.has(kindSlug) && kindSlug !== TERM_DEPOSIT_KIND)
      );
    });

  const linkSourceByMovementId = loadBestLinkSourceByMovementId();
  const taxRefundMovementIds = new Set(loadF22RefundMovements().map((r) => r.movement_id));
  const checkingMonths = loadCuentaCorrienteMonthsWithData();
  const dollarCheckingMonths = loadDollarCheckingMonthsWithData();

  const movements = loadPositiveInflowMovements(nonUsdIds, budaBufferId);

  const rows: DepositReconciliationRow[] = [];
  let fxError = false;

  for (const m of movements) {
    if (m.flow_kind != null && NON_CAPITAL_FLOW_KINDS.has(m.flow_kind)) continue;
    // APV-A "aporte estatal" — the yearly state match, not the user's own money — never has a
    // checking outflow behind it. Excluded so it isn't a false-positive unmatched inflow.
    if (movementIsStateContribution(m.flow_kind)) continue;

    const acc = accountMap.get(m.account_id);
    if (!acc) continue;
    const category = depositFlowCategoryFromGroupSlug(acc.group_slug);
    if (!category) continue;

    const usd = dollarDepositUsd(m);
    // A dollar deposit: its dollars, in pesos at the day's rate (as the deposit event prices it).
    const amount_clp = usd != null ? foreignCashToClpAt(usd, "usd", m.occurred_on, `depositReconciliation:${m.id}`) : Math.round(movementClpLegOrZero(m));
    const amount_usd_raw = usd ?? clpToUsdAtDate(amount_clp, m.occurred_on);
    if (amount_usd_raw == null || !Number.isFinite(amount_usd_raw)) {
      if (amount_clp !== 0) fxError = true;
    }
    const amount_usd = amount_usd_raw != null && Number.isFinite(amount_usd_raw) ? amount_usd_raw : null;
    const fundingMonths = usd != null ? dollarCheckingMonths : checkingMonths;

    const linkSource = linkSourceByMovementId.get(m.id);
    let status: DepositReconciliationStatus;
    if (linkSource === "auto" || linkSource === "manual") {
      status = "linked";
    } else if (taxRefundMovementIds.has(m.id)) {
      // A tax refund paid by the Tesorería straight into this account (f22_settlements): income
      // from outside, never a checking outflow.
      status = "resolved_tax_refund";
    } else {
      // A deposit no debit explains stays unlinked, whoever funded it (the fabricated mirrors and
      // the family / own funding splits were retired, migration 294: history is not recreated).
      const month = monthKeyFromYmd(m.occurred_on);
      status =
        month != null && fundingMonths.has(month)
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
      ...(usd != null ? { native: "usd" as const } : {}),
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
        `SELECT flow_id FROM movements
         WHERE account_id = ? AND note = 'import:buda|retiro' AND ${MOVEMENT_CLP_LEG_SQL} < 0`
      )
      .all(budaBufferId) as { flow_id: number }[];
    for (const r of retiros) budaRetiroKeys.add(outflowFlowClaimKey(budaBufferId, r.flow_id));
  }
  const redemptions: DepositRedemptionRow[] = [];
  for (const outflow of loadNetWorthCapitalReturnLedgerOutflows()) {
    // DAP outflows never appear here: kind `dap` is excluded from the matcher candidate pools at
    // the source (MATCHER_EXCLUDED_ACCOUNT_KIND_SLUGS in flowsCheckingGastos).
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

  // Manually-asserted `deposits` outflows: recompute the assertion pass (same deterministic logic
  // that wrote the auto links at gastos sync) so every asserted line is visible here — linked when
  // a unique candidate existed, asserted_unmatched otherwise (never guessed).
  const accountNameStmt = db.prepare(`SELECT name FROM accounts WHERE id = ?`);
  const accountNameFor = (accountId: number | null): string | null => {
    if (accountId == null) return null;
    const fromMap = accountMap.get(accountId)?.name;
    if (fromMap != null) return fromMap;
    const row = accountNameStmt.get(accountId) as { name: string } | undefined;
    return row?.name ?? null;
  };
  const manual_assertions: DepositManualAssertionRow[] = computeManualDepositAssertions(
    loadFinalizedCheckingGastosLinesReadOnly()
  ).map((a) => {
    const amount_usd_raw = clpToUsdAtDate(a.amount_clp, a.occurred_on);
    if ((amount_usd_raw == null || !Number.isFinite(amount_usd_raw)) && a.amount_clp !== 0) {
      fxError = true;
    }
    return {
      purchase_key: a.purchase_key,
      account_id: a.account_id,
      account_name: accountNameFor(a.account_id) ?? String(a.account_id),
      occurred_on: a.occurred_on,
      merchant: a.merchant,
      amount_clp: a.amount_clp,
      amount_usd: amount_usd_raw != null && Number.isFinite(amount_usd_raw) ? amount_usd_raw : null,
      deposit_movement_id: a.deposit_movement_id,
      deposit_account_id: a.deposit_account_id,
      deposit_account_name: accountNameFor(a.deposit_account_id),
      candidate_count: a.candidate_count,
      status: a.deposit_movement_id != null ? "linked" : "asserted_unmatched",
    };
  });
  manual_assertions.sort(
    (a, b) => b.occurred_on.localeCompare(a.occurred_on) || a.purchase_key.localeCompare(b.purchase_key)
  );

  rows.sort((a, b) => b.occurred_on.localeCompare(a.occurred_on) || a.account_name.localeCompare(b.account_name));
  redemptions.sort(
    (a, b) => b.occurred_on.localeCompare(a.occurred_on) || a.account_name.localeCompare(b.account_name)
  );

  return {
    rows,
    redemptions,
    manual_assertions,
    fx_conversion_error: fxError,
    fx_conversion_warnings: takeFxConversionWarnings(),
  };
}

// --- one display unit (`GET /api/flows/deposits/reconciliation?unit=`) ------------------------

type Unitless<R> = Omit<R, "amount_clp" | "amount_usd"> & { amount: number | null };

export type DepositReconciliationUnitTotals = { count: number; total: number | null };

export type DepositReconciliationUnitByMonth = {
  month: string;
  linked: number | null;
  resolved_tax_refund: number | null;
  resolved_internal_transfer: number | null;
  unlinked_no_checking_source: number | null;
  unlinked_checking_present: number | null;
  total: number | null;
};

/** The reconciliation in one display unit: each amount its legs in the unit (`flowLegsInUnit`), totals summed from them. */
export type DepositReconciliationUnitPayload = {
  unit: string;
  rows: Unitless<DepositReconciliationRow>[];
  by_status: Record<DepositReconciliationStatus, DepositReconciliationUnitTotals>;
  by_month: DepositReconciliationUnitByMonth[];
  redemptions: Unitless<DepositRedemptionRow>[];
  redemptions_by_status: Record<DepositRedemptionStatus, DepositReconciliationUnitTotals>;
  manual_assertions: Unitless<DepositManualAssertionRow>[];
  fx_conversion_error: boolean;
  fx_conversion_warnings: FxConversionWarning[];
};

function addOrNull(total: number | null, v: number | null): number | null {
  return total == null || v == null ? null : total + v;
}

function inUnit<R extends { amount_clp: number; amount_usd: number | null; occurred_on: string; native?: "usd" }>(
  r: R,
  unit: string
): Unitless<R> {
  const { amount_clp, amount_usd, native, ...rest } = r;
  return {
    ...rest,
    amount: flowLegsInUnit({ clp: amount_clp, usd: amount_usd, native: native ?? "clp" }, r.occurred_on, unit),
  } as Unitless<R>;
}

function statusTotals<S extends string>(
  statuses: readonly S[],
  rows: readonly { status: S; amount: number | null }[]
): Record<S, DepositReconciliationUnitTotals> {
  const out = {} as Record<S, DepositReconciliationUnitTotals>;
  for (const s of statuses) out[s] = { count: 0, total: 0 };
  for (const r of rows) {
    const b = out[r.status];
    b.count += 1;
    b.total = addOrNull(b.total, r.amount);
  }
  return out;
}

/** `GET /api/flows/deposits/reconciliation?unit=`: the classified rows, each amount in `unit`, and their totals. */
export function buildDepositsReconciliationPayload(unit: string): DepositReconciliationUnitPayload {
  return depositsReconciliationInUnit(classifyDepositsReconciliation(), unit);
}

export function depositsReconciliationInUnit(p: DepositReconciliationLedger, unit: string): DepositReconciliationUnitPayload {
  const rows = p.rows.map((r) => inUnit(r, unit));
  const redemptions = p.redemptions.map((r) => inUnit(r, unit));
  const byMonth = new Map<string, DepositReconciliationUnitByMonth>();
  for (const r of rows) {
    const month = monthKeyFromYmd(r.occurred_on) ?? r.occurred_on.slice(0, 7);
    let pt = byMonth.get(month);
    if (!pt) {
      pt = {
        month,
        linked: 0,
        resolved_tax_refund: 0,
        resolved_internal_transfer: 0,
        unlinked_no_checking_source: 0,
        unlinked_checking_present: 0,
        total: 0,
      };
      byMonth.set(month, pt);
    }
    pt.total = addOrNull(pt.total, r.amount);
    pt[r.status] = addOrNull(pt[r.status], r.amount);
  }
  return {
    unit,
    rows,
    by_status: statusTotals(DEPOSIT_RECONCILIATION_STATUSES, rows),
    by_month: [...byMonth.values()].sort((a, b) => b.month.localeCompare(a.month)),
    redemptions,
    redemptions_by_status: statusTotals(DEPOSIT_REDEMPTION_STATUSES, redemptions),
    manual_assertions: p.manual_assertions.map((r) => inUnit(r, unit)),
    fx_conversion_error: p.fx_conversion_error,
    fx_conversion_warnings: p.fx_conversion_warnings,
  };
}
