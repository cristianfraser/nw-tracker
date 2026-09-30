import type { Database } from "better-sqlite3";
import { invalidateAggregationForAccountDate } from "./aggregationCache.js";
import { clearCheckingBalanceCache } from "./checkingCartolaBalances.js";
import { db } from "./db.js";
import {
  cartolaMovementMatchesImportedRow,
  cartolaNoteContent,
  type ParsedCheckingMovement,
} from "./checkingCartolaParse.js";
import { transferCheckingGastosCategoryFromMovementToNote } from "./checkingGastosCategoryPersist.js";
import { MOVEMENT_CLP_LEG_SQL } from "./movementAmounts.js";
import { BANK_POSTED_ON_SQL, BANK_POSTING_JOIN_SQL, recordBankPosting } from "./movementBankPostings.js";
import type { PartialBankMovement } from "./checkingPartialMovementsImport.js";

export const PARTIAL_NOTE_PREFIX = "import:cartola-partial|";

export function isCheckingPartialWithdrawalNote(note: string | null | undefined): boolean {
  return String(note ?? "").trim().startsWith(PARTIAL_NOTE_PREFIX);
}

export type ParsedPartialMovementNote = {
  occurred_on: string;
  amount_clp: number;
  description: string;
  document_no: string;
};

export function parsePartialMovementNote(note: string): ParsedPartialMovementNote | null {
  if (!note.startsWith(PARTIAL_NOTE_PREFIX)) return null;
  const rest = note.slice(PARTIAL_NOTE_PREFIX.length);
  const firstBar = rest.indexOf("|");
  if (firstBar < 0) return null;
  const occurred_on = rest.slice(0, firstBar).trim();
  const afterDate = rest.slice(firstBar + 1);
  const secondBar = afterDate.indexOf("|");
  if (secondBar < 0) return null;
  const amount_clp = Number(afterDate.slice(0, secondBar).trim());
  if (!Number.isFinite(amount_clp)) return null;

  let tail = afterDate.slice(secondBar + 1).trim();
  let document_no = "";
  const docMatch = tail.match(/\|doc:([^|]+)$/);
  if (docMatch) {
    document_no = docMatch[1]!.trim();
    tail = tail.slice(0, docMatch.index).trim();
  }
  const description = tail.replace(/\s+/g, " ").trim();
  if (!occurred_on || !description) return null;
  return { occurred_on, amount_clp, description, document_no };
}

/**
 * The two sources render the same movement differently: the "últimos movimientos" web view
 * UPPERCASES, the cartola may prefix an asterisk-slash marker ("Giro Nacional VD"), either side truncates the tail
 * ("…ADMINISTRADORA GENERAL DE FONDO" vs "…ADMINISTRADORA G", "…Fraser" vs "…FRASER VILLABLANCA"),
 * and mojibake for accents diverges ("SEBASTIÃ,N" vs "SebastiÃ¡n"). Reduce to the A-Z0-9 skeleton
 * so only the stable characters compare.
 */
function normalizeForPartialMatch(description: string): string {
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
      `SELECT m.note FROM movements m ${BANK_POSTING_JOIN_SQL}
       WHERE m.account_id = ? AND ${BANK_POSTED_ON_SQL} = ? AND ${MOVEMENT_CLP_LEG_SQL} = ?
         AND m.note LIKE 'import:cartola|%'`
    )
    .all(accountId, accountId, mv.occurred_on, mv.amount_clp) as { note: string }[];
  for (const row of rows) {
    // Tolerant compare — the últimos web view and the cartola render descriptions/documents
    // differently (case, truncation, markers), see partialDescriptionsMatch.
    const content = cartolaNoteContent(row.note);
    if (content && partialDescriptionsMatch(mv.description, content.description)) return true;
  }
  return false;
}

/** Official cartola movement note in DB matching parsed cartola row content. */
export function findMatchingCartolaMovementNoteInDb(
  accountId: number,
  mv: ParsedCheckingMovement,
  dbHandle: Database = db
): string | null {
  const rows = dbHandle
    .prepare(
      `SELECT m.note FROM movements m ${BANK_POSTING_JOIN_SQL}
       WHERE m.account_id = ? AND ${BANK_POSTED_ON_SQL} = ? AND ${MOVEMENT_CLP_LEG_SQL} = ?
         AND m.note LIKE 'import:cartola|%' AND m.note NOT LIKE 'import:cartola|anchor|%'`
    )
    .all(accountId, accountId, mv.occurred_on, mv.amount_clp) as { note: string }[];
  for (const row of rows) {
    if (cartolaMovementMatchesImportedRow(mv, row.note)) return row.note;
  }
  return null;
}

/** Delete `import:cartola-partial` rows superseded by movements from a parsed cartola. */
export function prunePartialMovementsSupersededByCartola(
  accountId: number,
  movements: readonly ParsedCheckingMovement[],
  dbHandle: Database = db
): { removed: number; removed_ids: number[] } {
  if (movements.length === 0) return { removed: 0, removed_ids: [] };

  const partialRows = dbHandle
    .prepare(
      `SELECT id, note, occurred_on FROM movements
       WHERE account_id = ? AND note LIKE ?`
    )
    .all(accountId, `${PARTIAL_NOTE_PREFIX}%`) as { id: number; note: string; occurred_on: string }[];

  const del = dbHandle.prepare(`DELETE FROM movements WHERE id = ?`);
  const removed_ids: number[] = [];

  for (const partial of partialRows) {
    const parsed = parsePartialMovementNote(partial.note);
    if (!parsed) continue;
    const matchingMv = movements.find((mv) => checkingMovementContentMatches(mv, parsed));
    if (!matchingMv) continue;
    const cartolaNote = findMatchingCartolaMovementNoteInDb(accountId, matchingMv, dbHandle);
    if (cartolaNote) {
      transferCheckingGastosCategoryFromMovementToNote(
        accountId,
        partial.id,
        cartolaNote,
        dbHandle
      );
      // A partial row whose occurred_on differs from its note's bank date was deliberately
      // re-dated (payment-receipt evidence: the real payment day, not the bank's next-workday
      // posting). The cartola prints the bank date, so the official row it just inserted must
      // inherit the corrected date — with the bank date as its posting day — or the receipt
      // evidence is silently lost every month.
      if (partial.occurred_on !== parsed.occurred_on) {
        const official = dbHandle
          .prepare(
            `SELECT id FROM movements
             WHERE account_id = ? AND note = ? AND occurred_on = ? LIMIT 1`
          )
          .get(accountId, cartolaNote, matchingMv.occurred_on) as { id: number } | undefined;
        if (official) {
          dbHandle
            .prepare(`UPDATE movements SET occurred_on = ? WHERE id = ?`)
            .run(partial.occurred_on, official.id);
          recordBankPosting(official.id, accountId, matchingMv.occurred_on, dbHandle);
        }
      }
    }
    del.run(partial.id);
    removed_ids.push(partial.id);
  }

  return { removed: removed_ids.length, removed_ids };
}

/** Prune superseded partial rows and refresh balance/aggregation caches when needed. */
export function reconcileCartolaPartialImports(
  accountId: number,
  movements: readonly ParsedCheckingMovement[],
  dbHandle: Database = db
): { removed: number } {
  const { removed } = prunePartialMovementsSupersededByCartola(accountId, movements, dbHandle);
  if (removed === 0) return { removed: 0 };
  clearCheckingBalanceCache(accountId);
  let minOn = movements[0]!.occurred_on;
  for (const mv of movements) {
    if (mv.occurred_on < minOn) minOn = mv.occurred_on;
  }
  invalidateAggregationForAccountDate(accountId, minOn);
  return { removed };
}
