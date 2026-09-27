import { db } from "./db.js";
import { resolveMasterAccountIdForImportCardLast4 } from "./ccConsolidatedCards.js";
import { masterAccountIdForSantanderAccount } from "./santanderAccountMap.js";
import type { SantanderFeedClose, SantanderMovementsFile } from "./santanderCardMovements.js";

/**
 * The bank's own credit line per card and currency — Santander's product summary
 * (`cruceProductosOnline`), which the fetcher keeps in the card-movements file (`cupos`). One row
 * per plastic and currency: `NUMEROCONTRATO` (the bank account the feed slides name), `NUMEROPAN`,
 * `CODIGOMONEDA`, and `CUPO` / `MONTOUTILIZADO` / `MONTODISPONIBLE` as 18-digit strings with two
 * implied decimals in BOTH currencies («000000000123456700» = $1.xxx.xxx, «000000000000123456»
 * = US$x.xxx,xx). Recorded in `cc_bank_cupo_*` and compared by `ccBankCupoCheck.ts`.
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

function bankCupoCents(raw: unknown, field: string, where: string): number {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!/^\d{18}$/.test(text)) {
    throw new Error(`Santander cupo ${where}: ${field} "${String(raw)}" is not an 18-digit amount`);
  }
  const cents = Number(text);
  if (!Number.isSafeInteger(cents)) throw new Error(`Santander cupo ${where}: ${field} "${text}" is out of range`);
  return cents;
}

/**
 * Parse the summary rows. Throws on any shape it does not understand, on a row that breaks the
 * bank's own identity (cupo = utilizado + disponible, to the cent), on a bank account and a
 * plastic that route to different card masters, and on two rows for one master and currency.
 */
export function parseSantanderBankCupoRows(rows: readonly unknown[]): SantanderBankCupo[] {
  const out: SantanderBankCupo[] = [];
  const seen = new Set<string>();
  for (const raw of rows) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const bankAccount = String(r.NUMEROCONTRATO ?? "").trim();
    const pan = String(r.NUMEROPAN ?? "").trim();
    const currency = String(r.CODIGOMONEDA ?? "").trim().toLowerCase();
    if (!/^\d+$/.test(bankAccount)) throw new Error(`Santander cupo row has no bank account ("${bankAccount}")`);
    if (!/^\d{4,}$/.test(pan)) throw new Error(`Santander cupo ${bankAccount}: NUMEROPAN "${pan}" is not a card number`);
    if (currency !== "clp" && currency !== "usd") {
      throw new Error(`Santander cupo ${bankAccount}: unexpected currency "${String(r.CODIGOMONEDA)}"`);
    }
    const where = `${bankAccount} ${currency}`;
    const total = bankCupoCents(r.CUPO, "CUPO", where);
    const used = bankCupoCents(r.MONTOUTILIZADO, "MONTOUTILIZADO", where);
    const available = bankCupoCents(r.MONTODISPONIBLE, "MONTODISPONIBLE", where);
    if (total !== used + available) {
      throw new Error(
        `Santander cupo ${where}: CUPO ${total / 100} is not utilizado ${used / 100} + disponible ${available / 100}`
      );
    }
    const last4 = pan.slice(-4);
    const accountId = masterAccountIdForSantanderAccount(bankAccount);
    const byPlastic = resolveMasterAccountIdForImportCardLast4(last4);
    if (byPlastic !== accountId) {
      throw new Error(
        `Santander cupo ${where}: the bank account routes to card master ${accountId} but plastic ` +
          `·${last4} to ${byPlastic ?? "no master"} — fix cfraser/organize-identifiers.json or cc-cards.json`
      );
    }
    const key = `${accountId}|${currency}`;
    if (seen.has(key)) throw new Error(`Santander cupo: two ${currency} rows for card master ${accountId}`);
    seen.add(key);
    out.push({
      account_id: accountId,
      currency,
      bank_account: bankAccount,
      plastic_last4: last4,
      cupo_total: total / 100,
      cupo_utilizado: used / 100,
      cupo_disponible: available / 100,
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

/** What a file's `cupos` block holds, validated before the import writes anything. */
export type ParsedBankCupoCapture =
  | { status: "absent" }
  | { status: "missing"; error: string }
  | { status: "present"; observed_at: string; rows: SantanderBankCupo[] };

export function parseBankCupoCapture(file: SantanderMovementsFile): ParsedBankCupoCapture {
  if (!("cupos" in file) || file.cupos === undefined) return { status: "absent" };
  if (file.cupos === null) {
    const error = String(file.cuposError ?? "").trim();
    if (!error) throw new Error("Santander movements file has cupos: null and no cuposError");
    return { status: "missing", error };
  }
  const observedAt = String(file.cupos.observedAt ?? "").trim();
  if (Number.isNaN(Date.parse(observedAt))) {
    throw new Error(`Santander cupo capture has an unparseable observedAt "${observedAt}"`);
  }
  return { status: "present", observed_at: observedAt, rows: parseSantanderBankCupoRows(file.cupos.rows ?? []) };
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
 * Record one feed file's summary. `feedCloses` is the SALDO INICIAL close the same file states per
 * bank account — the close the check must share with the app. Re-importing a file is a no-op when
 * it says the same thing and throws when it does not (one file is one observation).
 */
export function recordBankCupoCapture(
  sourceFile: string,
  parsed: ParsedBankCupoCapture,
  feedCloses: ReadonlyMap<string, SantanderFeedClose>
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
