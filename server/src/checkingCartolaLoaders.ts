/**
 * DB row loaders + candidate-pool types for the checking gastos / deposit-matching engine
 * (`flowsCheckingGastos.ts`). This layer only SELECTs and shapes rows — classification
 * lives in `checkingDescriptionPredicates.ts`, pairing policy in the engine.
 */
import { accountBucketKindSlug } from "./accountBucket.js";
import { loadMergedDepositInflowEvents } from "./accountDeposits.js";
import { dashboardBucketForAssetGroupSlug } from "./assetGroupTree.js";
import { NOTE_STOCKS_LEGACY } from "./brokerageAcciones.js";
import {
  isCheckingPartialWithdrawalNote,
  parsePartialMovementNote,
  partialMovementSupersededByCartola,
} from "./checkingCartolaPartialReconcile.js";
import { CHECKING_GASTOS_CASH_GROUP } from "./checkingDescriptionPredicates.js";
import { db } from "./db.js";
import {
  cartolaCashAccountIdOptional,
  isMovementBalanceCashCategory,
  listMovementBalanceCashAccountIds,
} from "./movementBalanceCashAccounts.js";

export type CheckingCartolaCredit = {
  occurred_on: string;
  amount_clp: number;
  note: string | null;
};

export type CheckingCartolaWithdrawal = CheckingCartolaCredit;

export type CheckingCartolaWithdrawalWithAccount = CheckingCartolaWithdrawal & { account_id: number };

export type DepositMatchCandidate = {
  occurred_on: string;
  amount_clp: number;
  account_id: number;
  category_slug: string;
  group_slug: string;
};

export function loadCheckingCartolaCredits(accountId: number): CheckingCartolaCredit[] {
  return db
    .prepare(
      `SELECT occurred_on, amount_clp, note
       FROM movements
       WHERE account_id = ?
         AND amount_clp > 0
         AND note LIKE 'import:cartola|%'
         AND note NOT LIKE 'import:cartola|anchor|%'
       ORDER BY occurred_on, id`
    )
    .all(accountId) as CheckingCartolaCredit[];
}

export function loadMovementBalanceCashCartolaCredits(
  accountIds = listMovementBalanceCashAccountIds()
): CheckingCartolaCredit[] {
  const out: CheckingCartolaCredit[] = [];
  for (const accountId of accountIds) {
    out.push(...loadCheckingCartolaCredits(accountId));
  }
  out.sort((a, b) => {
    const d = a.occurred_on.localeCompare(b.occurred_on);
    if (d !== 0) return d;
    return a.amount_clp - b.amount_clp;
  });
  return out;
}

export function loadCheckingCartolaWithdrawals(accountId: number): CheckingCartolaWithdrawal[] {
  return db
    .prepare(
      `SELECT occurred_on, amount_clp, note
       FROM movements
       WHERE account_id = ?
         AND amount_clp < 0
         AND note LIKE 'import:cartola|%'
         AND note NOT LIKE 'import:cartola|anchor|%'
       ORDER BY occurred_on, id`
    )
    .all(accountId) as CheckingCartolaWithdrawal[];
}

export function loadAllCheckingCartolaWithdrawals(): CheckingCartolaWithdrawalWithAccount[] {
  const out: CheckingCartolaWithdrawalWithAccount[] = [];
  for (const accountId of listMovementBalanceCashAccountIds()) {
    for (const row of loadCheckingCartolaWithdrawals(accountId)) {
      out.push({ ...row, account_id: accountId });
    }
  }
  return out;
}

export type CheckingGastosWithdrawalRow = {
  id: number;
  occurred_on: string;
  amount_clp: number;
  note: string | null;
};

/** Cartola + non-superseded partial withdrawals for gastos (partial excluded when official cartola exists). */
export function loadCheckingGastosWithdrawalRows(accountId: number): CheckingGastosWithdrawalRow[] {
  const rows = db
    .prepare(
      `SELECT id, occurred_on, amount_clp, note
       FROM movements
       WHERE account_id = ?
         AND amount_clp < 0
         AND (note LIKE 'import:cartola|%' OR note LIKE 'import:cartola-partial|%')
         AND note NOT LIKE 'import:cartola|anchor|%'
       ORDER BY occurred_on DESC, id DESC`
    )
    .all(accountId) as CheckingGastosWithdrawalRow[];

  return rows.filter((row) => {
    if (!isCheckingPartialWithdrawalNote(row.note)) return true;
    const parsed = parsePartialMovementNote(String(row.note ?? ""));
    if (!parsed) return false;
    return !partialMovementSupersededByCartola(accountId, {
      occurred_on: parsed.occurred_on,
      amount_clp: parsed.amount_clp,
      description: parsed.description,
      document_no: parsed.document_no,
    });
  });
}

/**
 * Account kinds whose flows never enter the matcher candidate pools. DAP round-trips are already
 * netted internal on the checking side (Cargo Mercado Capitales out / "DAP … ABONADO" back), so a
 * DAP abono must not be claimable by an unrelated same-amount checking wire, and a DAP retiro must
 * not be consumable as a capital return.
 */
const MATCHER_EXCLUDED_ACCOUNT_KIND_SLUGS = new Set(["dap"]);

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
  const accounts = listDepositFlowAccounts().filter(
    (a) =>
      !isMovementBalanceCashCategory(a.category_slug) &&
      !MATCHER_EXCLUDED_ACCOUNT_KIND_SLUGS.has(a.category_slug)
  );
  const ids = accounts.map((a) => a.account_id);
  const metaById = new Map(
    accounts.map((a) => [a.account_id, { category_slug: a.category_slug, group_slug: a.group_slug }])
  );
  const byAccount = loadMergedDepositInflowEvents(ids);
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

function loadCuentaVistaInternalTransferCredits(): DepositMatchCandidate[] {
  const vistaId = cartolaCashAccountIdOptional("cuenta_vista");
  if (vistaId == null) return [];
  const byAccount = loadMergedDepositInflowEvents([vistaId]);
  const events = byAccount.get(vistaId) ?? [];
  return events
    .filter((e) => e.amt > 0 && Number.isFinite(e.amt))
    .map((e) => ({
      occurred_on: e.occurred_on,
      amount_clp: Math.round(e.amt),
      account_id: vistaId,
      category_slug: "cuenta_vista",
      group_slug: CHECKING_GASTOS_CASH_GROUP,
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
  const accounts = listDepositFlowAccounts().filter(
    (a) => !MATCHER_EXCLUDED_ACCOUNT_KIND_SLUGS.has(a.category_slug)
  );
  const ids = accounts.map((a) => a.account_id);
  const metaById = new Map(
    accounts.map((a) => [a.account_id, { category_slug: a.category_slug, group_slug: a.group_slug }])
  );
  const byAccount = loadMergedDepositInflowEvents(ids);
  const out: DepositMatchCandidate[] = [];
  for (const [accountId, events] of byAccount) {
    const meta = metaById.get(accountId);
    const category_slug = meta?.category_slug ?? "";
    const group_slug = meta?.group_slug ?? "";
    for (const e of events) {
      if (e.amt <= 0 || !Number.isFinite(e.amt)) continue;
      out.push({
        occurred_on: e.occurred_on,
        amount_clp: Math.round(e.amt),
        account_id: accountId,
        category_slug,
        group_slug,
      });
    }
  }
  return [...out, ...loadCuentaVistaInternalTransferCredits()];
}
