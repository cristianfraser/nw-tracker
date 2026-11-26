/**
 * How a daily-listing row and a cartola row are told to be one movement: the same day and pesos and
 * a description that matches once case, marks and truncation are set aside (`partialDescriptionsMatch`),
 * on the facts each row's listing stated (`movementListingFacts.ts`).
 */
import type { Database } from "better-sqlite3";
import { db } from "./db.js";
import { MOVEMENT_CLP_LEG_SQL } from "./movementAmounts.js";
import { BANK_POSTED_ON_SQL, BANK_POSTING_JOIN_SQL } from "./movementBankPostings.js";
import type { PartialBankMovement } from "./partialBankMovement.js";

/**
 * The two sources render the same movement differently: the "últimos movimientos" web view
 * UPPERCASES, the cartola may prefix an asterisk-slash marker ("Giro Nacional VD"), either side truncates the tail
 * ("…ADMINISTRADORA GENERAL DE FONDO" vs "…ADMINISTRADORA G", "…Perez" vs "…PEREZ SOTO"),
 * and mojibake for accents diverges ("SEBASTIÃ,N" vs "SebastiÃ¡n"). Reduce to the A-Z0-9 skeleton
 * so only the stable characters compare.
 */
export function normalizeForPartialMatch(description: string): string {
  return description.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Min normalized length for a truncation (prefix) match; exact equality has no floor. */
const PARTIAL_DESC_PREFIX_MIN_CHARS = 10;

export function partialDescriptionsMatch(a: string, b: string): boolean {
  const na = normalizeForPartialMatch(a);
  const nb = normalizeForPartialMatch(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const [shorter, longer] = na.length <= nb.length ? [na, nb] : [nb, na];
  return shorter.length >= PARTIAL_DESC_PREFIX_MIN_CHARS && longer.startsWith(shorter);
}

export function checkingMovementContentMatches(
  a: { occurred_on: string; amount_clp: number; description: string; document_no?: string },
  b: { occurred_on: string; amount_clp: number; description: string; document_no?: string }
): boolean {
  if (a.occurred_on !== b.occurred_on) return false;
  if (a.amount_clp !== b.amount_clp) return false;
  // No document check: the sources disagree on what "document" means (últimos = counterparty
  // account number, cartola = bank document number), so a doc veto rejects true duplicates.
  // Date + exact amount + description skeleton is the identity.
  return partialDescriptionsMatch(a.description, b.description);
}

/** True when a matching `import:cartola|…` movement already exists in the ledger. */
export function partialMovementSupersededByCartola(
  accountId: number,
  mv: PartialBankMovement,
  dbHandle: Database = db
): boolean {
  const rows = dbHandle
    .prepare(
      `SELECT e.stated_description AS description FROM movements m ${BANK_POSTING_JOIN_SQL}
       JOIN flow_evidence e ON e.source_table = 'movements' AND e.source_row_id = m.id AND e.source_kind = 'cartola'
       WHERE m.account_id = ? AND ${BANK_POSTED_ON_SQL} = ? AND ${MOVEMENT_CLP_LEG_SQL} = ?`
    )
    .all(accountId, accountId, mv.occurred_on, mv.amount_clp) as { description: string | null }[];
  // Tolerant compare on what the cartola printed (its listing facts) — the últimos web view and the
  // cartola render descriptions differently (case, truncation, markers), see partialDescriptionsMatch.
  return rows.some((row) => row.description != null && partialDescriptionsMatch(mv.description, row.description));
}
