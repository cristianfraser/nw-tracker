/**
 * DB row loaders + candidate-pool types for the checking gastos / deposit-matching engine
 * (`flowsCheckingGastos.ts`). This layer only SELECTs and shapes rows — classification
 * lives in `checkingDescriptionPredicates.ts`, pairing policy in the engine.
 */
import { foreignCashCurrencyOf } from "./cashCurrency.js";
import { convertCurrency } from "./rates.js";
import { HOME_CURRENCY, currencySmallestCoin } from "./displayUnits.js";
import { CHECKING_LISTED_SOURCE_KINDS, movementSourceKindInSql } from "./flows/flowEvidence.js";
import { TERM_DEPOSIT_KIND } from "./accountProfile.js";
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
import {
  CHECKING_GASTOS_CASH_GROUP,
  cartolaDescriptionFromNote,
  isCheckingOwnTraspasoInflow,
} from "./checkingDescriptionPredicates.js";
import { db } from "./db.js";
import { MOVEMENT_CLP_LEG_SQL } from "./movementAmounts.js";
import { signedNativeDeltaForAccountMovement, type MovementTransferRow } from "./movementTransfer.js";
import {
  accountIdsUnderCheckingAccounts,
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
  /**
   * The flow the event is a leg of (the movement's, a transfer's for either leg); with the account
   * it is the claim an outflow pairing consumes (bug 8: never account|day|pesos, which made twin
   * outflows one claim).
   */
  flow_id?: number | null;
  /**
   * Set on a credit to a checking account only: the bank printed it as a traspaso from the client's
   * other checking account. Any other credit there (a third party's transfer, a salary) funded by
   * no debit of the client's, so no checking debit may claim it as its internal transfer.
   */
  checking_own_traspaso?: boolean;
};

/** {@link DepositMatchCandidate.checking_own_traspaso} for a credit on `accountId`. */
function checkingOwnTraspasoFlag(
  accountId: number,
  movementId: number | null,
  checkingIds: ReadonlySet<number>
): { checking_own_traspaso?: boolean } {
  if (!checkingIds.has(accountId)) return {};
  if (movementId == null) return { checking_own_traspaso: false };
  const row = db.prepare(`SELECT note FROM movements WHERE id = ?`).get(movementId) as { note: string | null } | undefined;
  return { checking_own_traspaso: isCheckingOwnTraspasoInflow(cartolaDescriptionFromNote(row?.note)) };
}

/** Claim identity + movement row of a merged deposit event (see {@link DepositMatchCandidate}). */
export function depositEventClaimIdentity(
  accountId: number,
  e: Pick<DepositInflowEventWithCounter, "event_key">
): { claim_key: string; movement_id: number | null; flow_id: number | null } {
  if (e.event_key == null) {
    throw new Error(`deposit event on account ${accountId} carries no event key`);
  }
  const m = /^m:(\d+)$/.exec(e.event_key);
  const leg = /^[mt]:(\d+)(?::|$)/.exec(e.event_key);
  const flow = leg
    ? (db.prepare(`SELECT flow_id FROM movements WHERE id = ?`).get(Number(leg[1])) as { flow_id: number | null } | undefined)
    : undefined;
  return { claim_key: `${accountId}|${e.event_key}`, movement_id: m ? Number(m[1]) : null, flow_id: flow?.flow_id ?? null };
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
      prev.group_slug !== c.group_slug ||
      prev.checking_own_traspaso !== c.checking_own_traspaso
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
         AND ${movementSourceKindInSql("movements", CHECKING_LISTED_SOURCE_KINDS)}
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

/**
 * The foreign checking accounts: cash ledgers held in a currency other than pesos (a declared
 * `cash_currency`, or a legacy `usd` leaf) filed under Checking accounts — the Chilean bank's
 * dollar cuenta corriente, a US bank account, a euro account. Their bank-listed rows are read by
 * {@link listForeignCheckingMovements}; such an account whose rows no bank document lists (the
 * Chilean dollar one: every row there is a transfer or written from another document) reads empty.
 */
export function listForeignCheckingAccountIds(): number[] {
  return accountIdsUnderCheckingAccounts().filter((id) => foreignCashCurrencyOf(id) != null);
}

/** A foreign checking account's bank-listed movement: its own amount, its pesos and dollars at the day's rate. */
export type ForeignCheckingMovementRow = CheckingMovementRow & {
  /** The account's currency (`accounts.cash_currency`). */
  currency: string;
  /** In the account's currency, positive (the direction is the list asked for). */
  amount_native: number;
  /** Dollars, positive: a dollar account's own, else the amount at the day's mid. */
  amount_usd: number;
};

/** `amount` (in `currency`) at the stored mid of `day` in `to`, through rates.ts; no rate on file throws. */
export function foreignCheckingAmountIn(amount: number, currency: string, to: string, day: string, what: string): number {
  if (currency === to) return amount;
  const v = convertCurrency(amount, currency, to, day, { side: "mid", storedOnly: true });
  if (v == null || !Number.isFinite(v)) throw new Error(`${what}: no ${currency}→${to} rate on or before ${day}`);
  return v;
}

/**
 * {@link listCheckingMovements} for a foreign checking account: the single-leg rows its bank
 * documents list (the same evidence kinds), inflows or outflows by their direction in the
 * account's currency, oldest first. `amount_clp` is the amount at the day's stored mid on or
 * before the movement's day (signed like the peso lists: credits positive, debits negative) — how
 * the peso views price them. A listed row that moves none of the account's currency, or a day with
 * no rate, throws.
 */
export function listForeignCheckingMovements(accountId: number, direction: "in" | "out"): ForeignCheckingMovementRow[] {
  const currency = foreignCashCurrencyOf(accountId);
  if (currency == null) throw new Error(`account ${accountId} is not a foreign cash account`);
  const coin = currencySmallestCoin(currency);
  const rows = db
    .prepare(
      `SELECT id, account_id, from_account_id, to_account_id, amount, currency, counter_amount, counter_currency,
              occurred_on, note, units_delta, flow_kind
       FROM movements
       WHERE account_id = ?
         AND ${movementSourceKindInSql("movements", CHECKING_LISTED_SOURCE_KINDS)}
       ORDER BY occurred_on, id`
    )
    .all(accountId) as (MovementTransferRow & { id: number; occurred_on: string; note: string | null })[];
  const out: ForeignCheckingMovementRow[] = [];
  for (const r of rows) {
    const native = signedNativeDeltaForAccountMovement(r, accountId, currency);
    if (!(Math.abs(native) >= coin / 2)) {
      throw new Error(`${currency.toUpperCase()} checking movement ${r.id}: a listed row that moves no ${currency.toUpperCase()}`);
    }
    if (direction === "in" ? native < 0 : native > 0) continue;
    const what = `${currency.toUpperCase()} checking movement ${r.id}`;
    out.push({
      id: r.id,
      occurred_on: r.occurred_on,
      amount_clp: Math.round(foreignCheckingAmountIn(native, currency, HOME_CURRENCY, r.occurred_on, what)),
      currency,
      amount_native: Math.abs(native),
      amount_usd: Math.abs(foreignCheckingAmountIn(native, currency, "usd", r.occurred_on, what)),
      note: r.note,
    });
  }
  return out;
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
const MATCHER_EXCLUDED_ACCOUNT_KIND_SLUGS: ReadonlySet<string> = new Set([TERM_DEPOSIT_KIND]);
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
  // Checking is the funding source, never a capital return: the cartola kinds by kind, the dollar
  // checking accounts (a `usd` kind under Checking accounts) by id — a US checking debit is spending
  // or a transfer, not money leaving an investment.
  const dollarChecking = new Set(listForeignCheckingAccountIds());
  const accounts = listDepositFlowAccounts().filter(
    (a) =>
      !isMovementBalanceCashCategory(a.category_slug) &&
      !dollarChecking.has(a.account_id) &&
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
    .map((e) => {
      const identity = depositEventClaimIdentity(vistaId, e);
      return {
        occurred_on: e.occurred_on,
        amount_clp: Math.round(e.amt),
        account_id: vistaId,
        category_slug: "cuenta_vista",
        group_slug: CHECKING_GASTOS_CASH_GROUP,
        ...identity,
        ...checkingOwnTraspasoFlag(vistaId, identity.movement_id, checkingIds),
      };
    });
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
  // A dollar checking account's credits (a US salary) are never deposits a checking debit funded.
  const dollarChecking = new Set(listForeignCheckingAccountIds());
  const accounts = listDepositFlowAccounts().filter(
    (a) => !MATCHER_EXCLUDED_ACCOUNT_KIND_SLUGS.has(a.category_slug) && !budaFunded.has(a.account_id) && !dollarChecking.has(a.account_id)
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
      const identity = depositEventClaimIdentity(accountId, e);
      out.push({
        occurred_on: e.occurred_on,
        amount_clp: Math.round(e.amt),
        account_id: accountId,
        category_slug,
        group_slug,
        ...identity,
        ...checkingOwnTraspasoFlag(accountId, identity.movement_id, checkingIds),
      });
    }
  }
  return uniqueDepositCandidatesByClaimKey([...out, ...loadCuentaVistaInternalTransferCredits(checkingIds)]);
}
