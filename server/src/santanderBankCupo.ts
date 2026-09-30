import type { CardUnbilledMovementsPayload } from "nw-tracker-contracts";
import { db } from "./db.js";
import { resolveMasterAccountIdForImportCardLast4 } from "./ccConsolidatedCards.js";
import { masterAccountIdForIssuerCardAccount } from "./santanderAccountMap.js";

/**
 * The issuer's own credit line per card and currency, as a `card.unbilled_movements` listing
 * reports it (`issuer_balances`; for Santander the session's product summary). Recorded in
 * `cc_bank_cupo_*` and compared by `ccBankCupoCheck.ts`.
 */
export type SantanderBankCupo = {
  account_id: number;
  currency: "clp" | "usd";
  bank_account: string;
  plastic_last4: string;
  cupo_total: number;
  cupo_utilizado: number;
  cupo_disponible: number;
};

type IssuerBalances = NonNullable<CardUnbilledMovementsPayload["issuer_balances"]>;

/**
 * Route each reported balance to its card master. Throws on a bank account and a plastic that
 * route to different masters, and on two rows for one master and currency. (The row shape and
 * cupo = utilizado + disponible are the contract's to check.)
 */
export function bankCupoRowsFromListing(
  rows: Extract<IssuerBalances, { status: "observed" }>["rows"]
): SantanderBankCupo[] {
  const out: SantanderBankCupo[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const where = `${r.account.number} ${r.currency}`;
    const accountId = masterAccountIdForIssuerCardAccount(r.account);
    const byPlastic = resolveMasterAccountIdForImportCardLast4(r.card_last4);
    if (byPlastic !== accountId) {
      throw new Error(
        `Santander cupo ${where}: the bank account routes to card master ${accountId} but plastic ` +
          `·${r.card_last4} to ${byPlastic ?? "no master"} — fix cfraser/organize-identifiers.json or cc-cards.json`
      );
    }
    const key = `${accountId}|${r.currency}`;
    if (seen.has(key)) throw new Error(`Santander cupo: two ${r.currency} rows for card master ${accountId}`);
    seen.add(key);
    out.push({
      account_id: accountId,
      currency: r.currency,
      bank_account: r.account.number,
      plastic_last4: r.card_last4,
      cupo_total: r.limit,
      cupo_utilizado: r.used,
      cupo_disponible: r.available,
    });
  }
  return out;
}

export type BankCupoCaptureResult =
  /** A file fetched before the fetcher kept the summary. */
  | { status: "absent" }
  /** The fetcher got no usable summary this session and said why. */
  | { status: "missing"; error: string }
  | { status: "recorded" | "seen"; capture_id: number; observed_at: string; snapshots: number };

/** What a listing's `issuer_balances` holds, validated before the import writes anything. */
export type ParsedBankCupoCapture =
  | { status: "absent" }
  | { status: "missing"; error: string }
  | { status: "present"; observed_at: string; rows: SantanderBankCupo[] };

export function bankCupoCaptureFromListing(balances: IssuerBalances | undefined): ParsedBankCupoCapture {
  if (balances === undefined) return { status: "absent" };
  if (balances.status === "unavailable") return { status: "missing", error: balances.reason };
  return { status: "present", observed_at: balances.observed_at, rows: bankCupoRowsFromListing(balances.rows) };
}

type CaptureRow = { id: number; observed_at: string | null; error: string | null };
type SnapshotRow = {
  account_id: number;
  currency: string;
  bank_account: string;
  plastic_last4: string;
  cupo_total: number;
  cupo_utilizado: number;
  cupo_disponible: number;
  feed_close_iso: string | null;
};

const selCapture = db.prepare(`SELECT id, observed_at, error FROM cc_bank_cupo_captures WHERE source_file = ?`);
const insCapture = db.prepare(
  `INSERT INTO cc_bank_cupo_captures (source_file, observed_at, error) VALUES (?, ?, ?)`
);
const selSnapshots = db.prepare(
  `SELECT account_id, currency, bank_account, plastic_last4, cupo_total, cupo_utilizado, cupo_disponible,
          feed_close_iso
   FROM cc_bank_cupo_snapshots WHERE capture_id = ? ORDER BY account_id, currency`
);
const insSnapshot = db.prepare(
  `INSERT INTO cc_bank_cupo_snapshots (
     capture_id, account_id, currency, bank_account, plastic_last4, cupo_total, cupo_utilizado,
     cupo_disponible, feed_close_iso
   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
);

function snapshotSignature(rows: readonly SnapshotRow[]): string {
  return JSON.stringify(
    [...rows]
      .sort((a, b) => a.account_id - b.account_id || a.currency.localeCompare(b.currency))
      .map((r) => [
        r.account_id,
        r.currency,
        r.bank_account,
        r.plastic_last4,
        r.cupo_total,
        r.cupo_utilizado,
        r.cupo_disponible,
        r.feed_close_iso,
      ])
  );
}

/**
 * Record one listing's balances. `feedCloses` is the close the same listing states per
 * bank account — the close the check must share with the app. Re-importing a file is a no-op when
 * it says the same thing and throws when it does not (one file is one observation).
 */
export function recordBankCupoCapture(
  sourceFile: string,
  parsed: ParsedBankCupoCapture,
  feedCloses: ReadonlyMap<string, { close_iso: string }>
): BankCupoCaptureResult {
  if (parsed.status === "absent") return { status: "absent" };
  return db.transaction((): BankCupoCaptureResult => {
    const existing = selCapture.get(sourceFile) as CaptureRow | undefined;
    if (parsed.status === "missing") {
      if (existing) {
        if (existing.error !== parsed.error) {
          throw new Error(`Bank cupo capture ${sourceFile} was already recorded differently`);
        }
      } else {
        insCapture.run(sourceFile, null, parsed.error);
      }
      return { status: "missing", error: parsed.error };
    }
    const rows: SnapshotRow[] = parsed.rows.map((r) => ({
      account_id: r.account_id,
      currency: r.currency,
      bank_account: r.bank_account,
      plastic_last4: r.plastic_last4,
      cupo_total: r.cupo_total,
      cupo_utilizado: r.cupo_utilizado,
      cupo_disponible: r.cupo_disponible,
      feed_close_iso: feedCloses.get(r.bank_account)?.close_iso ?? null,
    }));
    if (existing) {
      const stored = selSnapshots.all(existing.id) as SnapshotRow[];
      if (existing.observed_at !== parsed.observed_at || snapshotSignature(stored) !== snapshotSignature(rows)) {
        throw new Error(`Bank cupo capture ${sourceFile} was already recorded differently`);
      }
      return { status: "seen", capture_id: existing.id, observed_at: parsed.observed_at, snapshots: stored.length };
    }
    const captureId = Number(insCapture.run(sourceFile, parsed.observed_at, null).lastInsertRowid);
    for (const r of rows) {
      insSnapshot.run(
        captureId,
        r.account_id,
        r.currency,
        r.bank_account,
        r.plastic_last4,
        r.cupo_total,
        r.cupo_utilizado,
        r.cupo_disponible,
        r.feed_close_iso
      );
    }
    return { status: "recorded", capture_id: captureId, observed_at: parsed.observed_at, snapshots: rows.length };
  })();
}
