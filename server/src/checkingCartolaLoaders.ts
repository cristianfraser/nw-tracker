/**
 * DB row loaders + candidate-pool types for the checking gastos / deposit-matching engine
 * (`flowsCheckingGastos.ts`). This layer only SELECTs and shapes rows — classification
 * lives in `checkingDescriptionPredicates.ts`, pairing policy in the engine.
 */
import { accountBucketKindSlug } from "./accountBucket.js";
import {
  loadMergedDepositInflowEventsBankDatedWithTransferCounter,
  type DepositInflowEventWithCounter,
} from "./accountDeposits.js";
import { dashboardBucketForAssetGroupSlug } from "./assetGroupTree.js";
import { NOTE_STOCKS_LEGACY } from "./brokerageAcciones.js";
import { loadCryptoCoinAccountIdsFundedByBuda } from "./budaWallet.js";
import {
  isCheckingPartialWithdrawalNote,
  parsePartialMovementNote,
  partialMovementSupersededByCartola,
} from "./checkingCartolaPartialReconcile.js";
import { CHECKING_GASTOS_CASH_GROUP } from "./checkingDescriptionPredicates.js";
import { db } from "./db.js";
import { MOVEMENT_CLP_LEG_SQL } from "./movementAmounts.js";
import {
  cartolaCashAccountIdOptional,
  isMovementBalanceCashCategory,
  listMovementBalanceCashAccountIds,
} from "./movementBalanceCashAccounts.js";

/**
 * A checking account's movement as the bank listed it. Which document listed it — the monthly
 * cartola, or the daily «últimos movimientos» feed until that month's cartola replaces the row —
 * is decided by `listCheckingMovements` alone: consumers ask for the account's inflows or
 * outflows, never for a source.
 */
export type CheckingMovementRow = {
  id: number;
  occurred_on: string;
  amount_clp: number;
  note: string | null;
};

export type CheckingCredit = {
  occurred_on: string;
  amount_clp: number;
  note: string | null;
};

export type CheckingWithdrawal = CheckingCredit;

export type CheckingWithdrawalWithAccount = CheckingWithdrawal & { account_id: number };

export type DepositMatchCandidate = {
  occurred_on: string;
  amount_clp: number;
  account_id: number;
  category_slug: string;
  group_slug: string;
  /**
   * The deposit's own identity — one outflow claims it, never two, and two twin deposits (same
   * account, day and pesos) are two claims. `<account>|<event key>` from the merged deposit timeline.
   */
  claim_key: string;
  /** The movement row the deposit is, when it is a movement on the account (not a transfer leg). */
  movement_id: number | null;
};

/** Claim identity + movement row of a merged deposit event (see {@link DepositMatchCandidate}). */
export function depositEventClaimIdentity(
  accountId: number,
  e: Pick<DepositInflowEventWithCounter, "event_key">
): { claim_key: string; movement_id: number | null } {
  if (e.event_key == null) {
    throw new Error(`deposit event on account ${accountId} carries no event key`);
  }
  const m = /^m:(\d+)$/.exec(e.event_key);
  return { claim_key: `${accountId}|${e.event_key}`, movement_id: m ? Number(m[1]) : null };
}

/**
 * One candidate per claim key. The cuenta vista's own credits are loaded twice (as a deposit-flow
 * account and as an internal-transfer target) with identical fields; any other repeat, or a repeat
 * that disagrees, is a loader bug.
 */
function uniqueDepositCandidatesByClaimKey(candidates: readonly DepositMatchCandidate[]): DepositMatchCandidate[] {
  const byKey = new Map<string, DepositMatchCandidate>();
  const out: DepositMatchCandidate[] = [];
  for (const c of candidates) {
    const prev = byKey.get(c.claim_key);
    if (prev == null) {
      byKey.set(c.claim_key, c);
      out.push(c);
      continue;
    }
    if (
      prev.occurred_on !== c.occurred_on ||
      prev.amount_clp !== c.amount_clp ||
      prev.category_slug !== c.category_slug ||
      prev.group_slug !== c.group_slug
    ) {
      throw new Error(`deposit claim key ${c.claim_key} loaded twice with different fields`);
    }
  }
  return out;
}

/**
 * Every movement the bank listed on a checking account, inflows («in») or outflows («out»),
 * oldest first: the cartola's rows, the daily feed's rows its cartola has not replaced yet, and
 * the rows rebuilt from the bank's own mails for months whose cartola is lost
 * (`import:santander-mail|…`, `import:mach-mail|…`; `isMailRebuiltCheckingNote`), and incoming
 * transfers' credits written from their mails before the feed lists them (`transfer_notice_movements`).
 * The cartola import deletes the daily rows it supersedes (carrying what hangs off them, see
 * `prunePartialMovementsSupersededByCartola`); a daily row whose cartola row exists but was not
 * pruned (a re-import that skipped the month) is left out here, so a movement never counts twice.
 * The opening-balance anchor and hand-made rows are not bank movements.
 */
export function listCheckingMovements(accountId: number, direction: "in" | "out"): CheckingMovementRow[] {
  const rows = db
    .prepare(
      `SELECT id, occurred_on, ${MOVEMENT_CLP_LEG_SQL} AS amount_clp, note
       FROM movements
       WHERE account_id = ?
         AND ${MOVEMENT_CLP_LEG_SQL} ${direction === "in" ? ">" : "<"} 0
         AND (note LIKE 'import:cartola|%' OR note LIKE 'import:cartola-partial|%'
              OR note LIKE 'import:santander-mail|%' OR note LIKE 'import:mach-mail|%'
              OR note LIKE 'import:bancochile-mail|%')
         AND note NOT LIKE 'import:cartola|anchor|%'
       ORDER BY occurred_on, id`
    )
    .all(accountId) as CheckingMovementRow[];
  return rows.filter((row) => {
    if (!isCheckingPartialWithdrawalNote(row.note)) return true;
    const parsed = parsePartialMovementNote(String(row.note ?? ""));
    if (!parsed) throw new Error(`checking movement ${row.id}: unreadable daily-feed note ${row.note}`);
    return !partialMovementSupersededByCartola(accountId, parsed);
  });
}

/** Whether a movement is a credit the bank listed on a checking account (see `listCheckingMovements`). */
export function isCheckingCredit(movementId: number): boolean {
  const row = db.prepare(`SELECT account_id FROM movements WHERE id = ?`).get(movementId) as
    | { account_id: number | null }
    | undefined;
  if (row?.account_id == null) return false;
  return listCheckingMovements(row.account_id, "in").some((m) => m.id === movementId);
}

export function loadCheckingCredits(accountId: number): CheckingCredit[] {
  return listCheckingMovements(accountId, "in").map(({ occurred_on, amount_clp, note }) => ({ occurred_on, amount_clp, note }));
}

export function loadMovementBalanceCashCredits(accountIds = listMovementBalanceCashAccountIds()): CheckingCredit[] {
  const out: CheckingCredit[] = [];
  for (const accountId of accountIds) {
    out.push(...loadCheckingCredits(accountId));
  }
  out.sort((a, b) => {
    const d = a.occurred_on.localeCompare(b.occurred_on);
    if (d !== 0) return d;
    return a.amount_clp - b.amount_clp;
  });
  return out;
}

export function loadCheckingWithdrawals(accountId: number): CheckingWithdrawal[] {
  return listCheckingMovements(accountId, "out").map(({ occurred_on, amount_clp, note }) => ({ occurred_on, amount_clp, note }));
}

export function loadAllCheckingWithdrawals(): CheckingWithdrawalWithAccount[] {
  const out: CheckingWithdrawalWithAccount[] = [];
  for (const accountId of listMovementBalanceCashAccountIds()) {
    for (const row of loadCheckingWithdrawals(accountId)) {
      out.push({ ...row, account_id: accountId });
    }
  }
  return out;
}

/**
 * Account kinds whose flows never enter the matcher candidate pools. DAP round-trips are already
 * netted internal on the checking side (Cargo Mercado Capitales out / "DAP … ABONADO" back), so a
 * DAP abono must not be claimable by an unrelated same-amount checking wire, and a DAP retiro must
 * not be consumable as a capital return.
 */
const MATCHER_EXCLUDED_ACCOUNT_KIND_SLUGS = new Set(["dap"]);
// Coin accounts funded by the Buda buffer (`loadCryptoCoinAccountIdsFundedByBuda`) are left out of
// both pools as well: a coin buy is paid from the buffer and a coin sell pays into it, so neither
// crosses the checking boundary. The buffer's abono (money from checking) and retiro (money back)
// are the checking-side legs; a coin buy on the same day for the same pesos would otherwise claim
// the checking debit that funded the abono.

function listDepositFlowAccounts(): { account_id: number; category_slug: string; group_slug: string }[] {
  const rows = db
    .prepare(
      `SELECT a.id AS account_id, g.slug AS bucket_slug
       FROM accounts a
       JOIN asset_groups g ON g.id = a.asset_group_id
       WHERE (a.import_key IS NULL OR a.import_key != ?)
         AND COALESCE(a.exclude_from_group_totals, 0) = 0
         AND g.slug != 'individual_stocks'`
    )
    .all(NOTE_STOCKS_LEGACY) as { account_id: number; bucket_slug: string }[];
  return rows
    .map((r) => {
      const dash = dashboardBucketForAssetGroupSlug(r.bucket_slug);
      if (!dash || !["real_estate", "cash_eqs", "brokerage", "retirement"].includes(dash)) {
        return null;
      }
      return {
        account_id: r.account_id,
        category_slug: accountBucketKindSlug(r.bucket_slug),
        group_slug: dash,
      };
    })
    .filter((r): r is { account_id: number; category_slug: string; group_slug: string } => r != null);
}

/** Brokerage/retirement ledger retiros that may pair with Fintual incoming wires (excludes AFP). */
export function loadNetWorthCapitalReturnLedgerOutflows(): DepositMatchCandidate[] {
  return loadNetWorthCapitalOutflowCandidates().filter((o) => o.category_slug !== "afp");
}

export function loadNetWorthCapitalOutflowCandidates(): DepositMatchCandidate[] {
  const budaFunded = loadCryptoCoinAccountIdsFundedByBuda();
  const accounts = listDepositFlowAccounts().filter(
    (a) =>
      !isMovementBalanceCashCategory(a.category_slug) &&
      !MATCHER_EXCLUDED_ACCOUNT_KIND_SLUGS.has(a.category_slug) &&
      !budaFunded.has(a.account_id)
  );
  const ids = accounts.map((a) => a.account_id);
  const metaById = new Map(
    accounts.map((a) => [a.account_id, { category_slug: a.category_slug, group_slug: a.group_slug }])
  );
  const byAccount = loadMergedDepositInflowEventsBankDatedWithTransferCounter(ids);
  const out: DepositMatchCandidate[] = [];
  for (const [accountId, events] of byAccount) {
    const meta = metaById.get(accountId);
    if (!meta) continue;
    for (const e of events) {
      if (e.amt >= 0 || !Number.isFinite(e.amt)) continue;
      out.push({
        occurred_on: e.occurred_on,
        amount_clp: Math.round(Math.abs(e.amt)),
        account_id: accountId,
        category_slug: meta.category_slug,
        group_slug: meta.group_slug,
        ...depositEventClaimIdentity(accountId, e),
      });
    }
  }
  return out;
}

export function loadAfpRetiroOutflowCandidates(): DepositMatchCandidate[] {
  return loadNetWorthCapitalOutflowCandidates().filter((c) => c.category_slug === "afp");
}

export function fondoReservaAccountId(): number | null {
  const row = db
    .prepare(
      `SELECT a.id FROM accounts a
       JOIN asset_groups g ON g.id = a.asset_group_id
       WHERE g.slug = 'fondo_reserva' OR g.slug LIKE '%__fondo_reserva'
       LIMIT 1`
    )
    .get() as { id: number } | undefined;
  return row?.id ?? null;
}

/**
 * A transfer leg whose other endpoint is a checking account is already paired with its checking
 * outflow: the transfer row IS that outflow (a mirror-merged or hand-entered transfer). No
 * single-leg checking debit may claim it — a same-amount debit in the window (a month for the
 * month-precision ahorro) would otherwise pair with it, and since a transfer leg has no movement
 * row to link, the deposit that debit really funded was left unlinked.
 */
function depositEventExplainedByCheckingTransfer(
  e: DepositInflowEventWithCounter,
  checkingIds: ReadonlySet<number>
): boolean {
  return e.transfer_counter_account_id != null && checkingIds.has(e.transfer_counter_account_id);
}

function loadCuentaVistaInternalTransferCredits(checkingIds: ReadonlySet<number>): DepositMatchCandidate[] {
  const vistaId = cartolaCashAccountIdOptional("cuenta_vista");
  if (vistaId == null) return [];
  const byAccount = loadMergedDepositInflowEventsBankDatedWithTransferCounter([vistaId]);
  const events = byAccount.get(vistaId) ?? [];
  return events
    .filter((e) => e.amt > 0 && Number.isFinite(e.amt))
    .filter((e) => !depositEventExplainedByCheckingTransfer(e, checkingIds))
    .map((e) => ({
      occurred_on: e.occurred_on,
      amount_clp: Math.round(e.amt),
      account_id: vistaId,
      category_slug: "cuenta_vista",
      group_slug: CHECKING_GASTOS_CASH_GROUP,
      ...depositEventClaimIdentity(vistaId, e),
    }));
}

export function checkingGastosAccountCategorySlug(accountId: number): string {
  const row = db
    .prepare(
      `SELECT g.slug AS bucket_slug FROM accounts a
       JOIN asset_groups g ON g.id = a.asset_group_id
       WHERE a.id = ?`
    )
    .get(accountId) as { bucket_slug: string } | undefined;
  return row ? accountBucketKindSlug(row.bucket_slug) : "";
}

export function loadDepositMatchCandidates(): DepositMatchCandidate[] {
  const budaFunded = loadCryptoCoinAccountIdsFundedByBuda();
  const accounts = listDepositFlowAccounts().filter(
    (a) => !MATCHER_EXCLUDED_ACCOUNT_KIND_SLUGS.has(a.category_slug) && !budaFunded.has(a.account_id)
  );
  const ids = accounts.map((a) => a.account_id);
  const metaById = new Map(
    accounts.map((a) => [a.account_id, { category_slug: a.category_slug, group_slug: a.group_slug }])
  );
  const checkingIds = new Set(listMovementBalanceCashAccountIds());
  const byAccount = loadMergedDepositInflowEventsBankDatedWithTransferCounter(ids);
  const out: DepositMatchCandidate[] = [];
  for (const [accountId, events] of byAccount) {
    const meta = metaById.get(accountId);
    const category_slug = meta?.category_slug ?? "";
    const group_slug = meta?.group_slug ?? "";
    for (const e of events) {
      if (e.amt <= 0 || !Number.isFinite(e.amt)) continue;
      if (depositEventExplainedByCheckingTransfer(e, checkingIds)) continue;
      out.push({
        occurred_on: e.occurred_on,
        amount_clp: Math.round(e.amt),
        account_id: accountId,
        category_slug,
        group_slug,
        ...depositEventClaimIdentity(accountId, e),
      });
    }
  }
  return uniqueDepositCandidatesByClaimKey([...out, ...loadCuentaVistaInternalTransferCredits(checkingIds)]);
}
