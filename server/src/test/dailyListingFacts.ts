import { db } from "../db.js";
import { parsePartialMovementNote } from "../checkingCartolaPartialReconcile.js";
import { cartolaNoteContent } from "../checkingCartolaParse.js";
import { dailyListingFacts, recordBankListingFacts } from "../movementListingFacts.js";

/**
 * Bank rows a test wrote by hand (a raw `INSERT` of an `import:cartola-partial|…` or
 * `import:cartola|…` note) get the listing facts the importers state with every row they write
 * (`insertBankPesoMovement`): read from the fixture's own note, the only place it states them.
 */
export function stateListingFactsOfFixtures(): void {
  const rows = db
    .prepare(
      `SELECT m.id, m.note, m.occurred_on, e.source_kind AS kind FROM movements m
       JOIN flow_evidence e ON e.source_table = 'movements' AND e.source_row_id = m.id
       WHERE (e.source_kind = 'daily_listing' AND e.stated_document_no IS NULL) OR (e.source_kind = 'cartola' AND e.stated_period IS NULL)`
    )
    .all() as { id: number; note: string; occurred_on: string; kind: string }[];
  for (const r of rows) {
    if (r.kind === "daily_listing") {
      const parsed = parsePartialMovementNote(r.note);
      if (!parsed) throw new Error(`test fixture movement ${r.id}: unreadable daily note ${r.note}`);
      recordBankListingFacts(r.id, dailyListingFacts(parsed), db);
      continue;
    }
    const content = cartolaNoteContent(r.note);
    const month = r.note.split("|")[1]?.trim();
    if (!content || !month || !/^\d{4}-\d{2}$/.test(month)) continue;
    const day = r.note.match(/\|on:([^|]+)/)?.[1]?.trim() ?? r.occurred_on;
    recordBankListingFacts(r.id, { bank_day: day, description: content.description, document_no: content.document_no, period_month: month }, db);
  }
}
