/**
 * Re-dating the checking rows a recent-movements listing stored under the bank's NEXT workday
 * (Santander's bank day ends at 14:00) before the import learned the fetch-day rule
 * (`importCheckingPartialMovements`): each such row moves to the day the listing was read, its bank
 * date kept as its posting day on the account (`redateMovementKeepingBankDay`), as the import now
 * writes it. Used by `scripts/redate-forward-posted-checking-rows.ts`.
 *
 * The evidence is the listings themselves, each with the instant it was read: the archived
 * «últimos movimientos» workbooks (dumped by ingest's `dump:checking-listings`, mtime = download
 * time) and the cuenta vista pastes (`import_batches` kind `cuenta_vista_web_paste`: the inserted
 * rows and `uploaded_at`). A row's fetch day is the EARLIEST listing that shows it; an archive copy
 * overwritten by a later same-name download only makes that day later, never earlier than the
 * truth, so a row is moved at most to a day on or after the one it really happened.
 *
 * Two kinds of row are re-dated: a daily row still on file (matched by its note key), and the
 * official cartola row that replaced one (matched like the import's cartola supersede: bank date,
 * pesos, description skeleton — exactly one candidate, else reported as ambiguous). Either is left
 * alone when its stored date already differs from the bank date (a receipt or a mail re-dated it).
 * A daily row absorbed into a transfer (mirror conversion, a hand transfer) is not identifiable here.
 */
import { db } from "./db.js";
import {
  listingFetchDay,
  partialMovementNote,
  partialRowOccurredOn,
  type PartialBankMovement,
} from "./checkingPartialMovementsImport.js";
import { partialDescriptionsMatch } from "./checkingCartolaPartialReconcile.js";
import { cartolaNoteContent } from "./checkingCartolaParse.js";
import { movementSourceKindInSql } from "./flows/flowEvidence.js";
import { MOVEMENT_CLP_LEG_SQL } from "./movementAmounts.js";
import { BANK_POSTED_ON_SQL, BANK_POSTING_JOIN_SQL } from "./movementBankPostings.js";
import { movementWrite, redateMovementKeepingBankDay } from "./movementWrites.js";

/** One listing as read: which account, when, and its rows (bank dates). */
export type ReadListing = { source: string; account_id: number; fetched_at: Date; rows: PartialBankMovement[] };

export type ForwardPostedRedate = {
  movement_id: number;
  account_id: number;
  row_kind: "daily_listing" | "cartola";
  bank_date: string;
  occurred_on: string;
  new_occurred_on: string;
  amount_clp: number;
  description: string;
  evidence: string;
};

export type ForwardPostedSkip = {
  account_id: number;
  bank_date: string;
  fetch_day: string;
  amount_clp: number;
  description: string;
  evidence: string;
  reason: "already_redated" | "ambiguous_cartola" | "not_found";
  detail: string;
};

export type ForwardPostedPlan = { redates: ForwardPostedRedate[]; skipped: ForwardPostedSkip[] };

/** The cuenta vista pastes on file as listings (`import_batches.raw_text` keeps the inserted rows). */
export function cuentaVistaPasteListings(): ReadListing[] {
  const rows = db
    .prepare(`SELECT id, uploaded_at, raw_text FROM import_batches WHERE kind = 'cuenta_vista_web_paste' ORDER BY id`)
    .all() as { id: number; uploaded_at: string; raw_text: string | null }[];
  return rows.map((b) => {
    const summary = JSON.parse(b.raw_text ?? "{}") as {
      account_id?: number;
      inserted_flows?: { occurred_on: string; description: string; amount_clp: number }[];
    };
    if (typeof summary.account_id !== "number") throw new Error(`import batch ${b.id}: no account_id in its summary`);
    // `uploaded_at` is SQLite's datetime('now'): UTC, "YYYY-MM-DD HH:MM:SS".
    const fetched_at = new Date(`${b.uploaded_at.replace(" ", "T")}Z`);
    if (!Number.isFinite(fetched_at.getTime())) throw new Error(`import batch ${b.id}: unreadable uploaded_at ${b.uploaded_at}`);
    return {
      source: `cuenta vista paste batch ${b.id}`,
      account_id: summary.account_id,
      fetched_at,
      rows: (summary.inserted_flows ?? []).map((f) => ({ ...f, document_no: "" })),
    };
  });
}

type Candidate = { row: PartialBankMovement; account_id: number; fetch_day: string; evidence: string };

export function planForwardPostedRedates(listings: readonly ReadListing[]): ForwardPostedPlan {
  // The earliest listing that shows each row (account + note key) dated after its own fetch day.
  const earliest = new Map<string, Candidate>();
  const ordered = [...listings].sort((a, b) => a.fetched_at.getTime() - b.fetched_at.getTime());
  const firstSeen = new Set<string>();
  for (const l of ordered) {
    const fetchDay = listingFetchDay({ fetchedAt: l.fetched_at });
    for (const row of l.rows) {
      const key = `${l.account_id}|${partialMovementNote(row)}`;
      // Only the first listing that shows the row decides: a later one cannot be when it was read.
      if (firstSeen.has(key)) continue;
      firstSeen.add(key);
      if (partialRowOccurredOn(row.occurred_on, fetchDay) === row.occurred_on) continue;
      earliest.set(key, { row, account_id: l.account_id, fetch_day: fetchDay, evidence: l.source });
    }
  }

  const partialByNote = db.prepare(`SELECT id, occurred_on FROM movements WHERE account_id = ? AND note = ?`);
  const cartolaRows = db.prepare(
    `SELECT m.id, m.occurred_on, m.note FROM movements m ${BANK_POSTING_JOIN_SQL}
     WHERE m.account_id = ? AND ${BANK_POSTED_ON_SQL} = ? AND ${MOVEMENT_CLP_LEG_SQL} = ?
       AND ${movementSourceKindInSql("m", ["cartola"])}`
  );

  const redates: ForwardPostedRedate[] = [];
  const skipped: ForwardPostedSkip[] = [];
  for (const c of earliest.values()) {
    const base = {
      account_id: c.account_id,
      bank_date: c.row.occurred_on,
      amount_clp: c.row.amount_clp,
      description: c.row.description,
      evidence: c.evidence,
    };
    const skip = (reason: ForwardPostedSkip["reason"], detail: string) =>
      skipped.push({ ...base, fetch_day: c.fetch_day, reason, detail });
    const daily = partialByNote.all(c.account_id, partialMovementNote(c.row)) as { id: number; occurred_on: string }[];
    if (daily.length > 1) throw new Error(`account ${c.account_id}: two daily rows carry the note ${partialMovementNote(c.row)}`);
    if (daily.length === 1) {
      const d = daily[0]!;
      if (d.occurred_on !== c.row.occurred_on) {
        skip("already_redated", `daily row ${d.id} is dated ${d.occurred_on}`);
        continue;
      }
      redates.push({ ...base, movement_id: d.id, row_kind: "daily_listing", occurred_on: d.occurred_on, new_occurred_on: c.fetch_day });
      continue;
    }
    const official = (
      cartolaRows.all(c.account_id, c.account_id, c.row.occurred_on, c.row.amount_clp) as {
        id: number;
        occurred_on: string;
        note: string;
      }[]
    ).filter((r) => {
      const content = cartolaNoteContent(r.note);
      return content != null && partialDescriptionsMatch(c.row.description, content.description);
    });
    if (official.length === 0) {
      skip("not_found", "no daily row with its note and no cartola row with its bank date, pesos and description");
      continue;
    }
    if (official.length > 1) {
      skip("ambiguous_cartola", `cartola rows ${official.map((r) => r.id).join(", ")} all match`);
      continue;
    }
    const o = official[0]!;
    if (o.occurred_on !== c.row.occurred_on) {
      skip("already_redated", `cartola row ${o.id} is dated ${o.occurred_on}`);
      continue;
    }
    redates.push({ ...base, movement_id: o.id, row_kind: "cartola", occurred_on: o.occurred_on, new_occurred_on: c.fetch_day });
  }
  redates.sort((a, b) => a.bank_date.localeCompare(b.bank_date) || a.movement_id - b.movement_id);
  return { redates, skipped };
}

/** Writes the plan in one IMMEDIATE transaction (the write lock before the first read). */
export function applyForwardPostedRedates(redates: readonly ForwardPostedRedate[]): void {
  movementWrite(() =>
    db
      .transaction(() => {
        for (const r of redates) {
          const now = db.prepare(`SELECT occurred_on FROM movements WHERE id = ?`).get(r.movement_id) as
            | { occurred_on: string }
            | undefined;
          if (!now || now.occurred_on !== r.occurred_on) {
            throw new Error(`movement ${r.movement_id} changed since the plan (now ${now?.occurred_on ?? "gone"}) — nothing written`);
          }
          redateMovementKeepingBankDay({
            movementId: r.movement_id,
            accountId: r.account_id,
            occurredOn: r.new_occurred_on,
            bankPostedOn: r.bank_date,
            basis: "fetch",
          });
        }
      })
      .immediate()
  );
}
