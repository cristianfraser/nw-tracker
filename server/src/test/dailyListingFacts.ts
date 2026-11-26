import { db } from "../db.js";
import { cartolaNoteFacts370, dailyNoteFacts370 } from "../migrationHooks/evidenceListingFacts370.js";
import { anchorDescription372, cartolaPlaceFacts372, mailDescription372 } from "../migrationHooks/bankRowFacts372.js";
import type { BankRowText } from "../bankRowFacts.js";
import { dailyListingFacts, recordBankListingFacts } from "../movementListingFacts.js";

/**
 * Bank rows a test wrote by hand (a raw `INSERT` of an `import:cartola-partial|…`, `import:cartola|…`
 * or mail note) get the facts their writers state with every row (`insertBankPesoMovement`, the
 * transfer-notice and anchor writers): read from the fixture's own note with the migrations' readers,
 * the only place a hand-written fixture states them (a fixture note with no position is position 0).
 */
export function stateListingFactsOfFixtures(): void {
  // A mail-written row or a ledger anchor a test wrote by hand: its description, as its writer states it.
  for (const r of db
    .prepare(
      `SELECT e.id, e.source_kind AS kind, m.note FROM flow_evidence e JOIN movements m ON m.id = e.source_row_id
       WHERE e.source_table = 'movements' AND e.source_kind IN ('mail_notice', 'mail_rebuilt', 'cartola_anchor')
         AND e.stated_description IS m.note`
    )
    .all() as { id: number; kind: string; note: string }[]) {
    const note = r.note.trim();
    db.prepare(`UPDATE flow_evidence SET stated_description = ? WHERE id = ?`).run(
      r.kind === "cartola_anchor" ? anchorDescription372(note) : mailDescription372(note),
      r.id
    );
  }
  const rows = db
    .prepare(
      `SELECT m.id, m.note, m.occurred_on, e.source_kind AS kind FROM movements m
       JOIN flow_evidence e ON e.source_table = 'movements' AND e.source_row_id = m.id
       WHERE (e.source_kind = 'daily_listing' AND e.stated_document_no IS NULL) OR (e.source_kind = 'cartola' AND e.stated_period IS NULL)`
    )
    .all() as { id: number; note: string; occurred_on: string; kind: string }[];
  for (const r of rows) {
    if (r.kind === "daily_listing") {
      const parsed = dailyNoteFacts370(r.note);
      if (!parsed) throw new Error(`test fixture movement ${r.id}: unreadable daily note ${r.note}`);
      recordBankListingFacts(r.id, dailyListingFacts({ occurred_on: parsed.bank_day, amount_clp: parsed.amount, description: parsed.description, document_no: parsed.document_no }), db);
      continue;
    }
    const content = cartolaNoteFacts370(r.note);
    if (!content) continue;
    const day = r.note.match(/\|on:([^|]+)/)?.[1]?.trim() ?? r.occurred_on;
    const place = cartolaPlaceFacts372(r.note);
    recordBankListingFacts(
      r.id,
      { bank_day: day, description: content.description, document_no: content.document_no, period_month: content.period_month, branch: place.branch, position: place.identity?.position ?? 0 },
      db
    );
  }
}

/**
 * A matcher fixture's text, from the bank note a test writes for readability (`import:cartola|…`,
 * `import:cartola-partial|…`, a mail-written row's note, or plain text): what the row's evidence
 * states once its importer writes it (`bankRowFacts.ts`).
 */
export function rowTextOfFixtureNote(note: string): BankRowText {
  const daily = dailyNoteFacts370(note);
  if (daily) return { description: daily.description, document_no: daily.document_no || null, branch: null };
  const cartola = cartolaNoteFacts370(note);
  if (cartola) return { description: cartola.description, document_no: cartola.document_no || null, branch: note.split("|")[2] ?? "" };
  if (/^import:(?:santander|mach|bancochile)-mail\|/.test(note)) return { description: mailDescription372(note), document_no: null, branch: null };
  return { description: note.trim(), document_no: null, branch: null };
}

/** A fixture row's id (from `lastInsertRowid`), once its facts are stated ({@link stateListingFactsOfFixtures}). */
export function withFixtureFacts(rowid: number | bigint): number {
  stateListingFactsOfFixtures();
  return Number(rowid);
}
