import type { Database as DatabaseType } from "better-sqlite3";
import { writeLogTriggerSql } from "../markInputTriggers.js";
import { FLOW_SOURCES } from "../flows/flowTriggerSpecs.js";
import { flowRetireDeleteTriggerSql } from "./flowRetirement290.js";
import { reinstallTableTriggersInOrder } from "./tableTriggerReinstall.js";

/**
 * Migration 371 hook, after its SQL added `flow_evidence.stated_document_no` / `stated_period`:
 *
 * 1. the evidence write log watches the two new columns;
 * 2. a movement whose note is rewritten loses its listing facts (`flow_movements_evidence_au` already
 *    re-states its kind, document key and wording from the new note): a writer that makes a row a
 *    bank document's row states them again, and a row left without them is refused by the readers;
 * 3. the flow delete triggers of every source table read evidence whose `source_table` is
 *    `restated:<table>` — a row's earlier evidence, kept when a document restated the row in place —
 *    as history: it does not hold the flow when the row goes (a bare flow is deleted with it, a held
 *    one retired, its history kept);
 * 4. every cartola and daily-listing movement's evidence states what its listing printed, read ONCE
 *    from its note (the note grammar of the two importers, copied here as it stood): the bank day
 *    (a daily row's note day; a cartola row's posting day on its account, else its day), the signed
 *    amount (a daily row's note amount; a cartola row keeps the amount it was written with), the
 *    description, the document number ('' when none) and the cartola month (NULL on a daily row).
 *
 * Rows are chosen by their evidence kind (`cartola`, `daily_listing`: the ledger anchors are
 * `cartola_anchor` and carry no listing), and read with the kind's own prefix test (ASCII case
 * ignored, as LIKE does). A daily-listing note whose day or amount does not read, or a cartola note
 * whose month is not `YYYY-MM`, fails the migration — every such row listed at once: every such
 * note was written by its importer, which always writes them. One whose description is empty (a
 * bank row listed with no text; the old reader returned nothing for it, so it never matched) gets
 * the description '' and is counted: '' matches no cartola description either, so it stays
 * unmatched, as before.
 *
 * Pure (no `db` import).
 */
export function runEvidenceListingFacts371(dbi: DatabaseType): void {
  const cols = (dbi.prepare(`SELECT name FROM pragma_table_info('flow_evidence')`).all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes("stated_document_no") || !cols.includes("stated_period")) {
    throw new Error("migration 371: flow_evidence has no stated_document_no / stated_period");
  }
  reinstallTableTriggersInOrder(
    dbi,
    "flow_evidence",
    { write_log_flow_evidence_au: writeLogTriggerSql("flow_evidence", cols, null)[2]! },
    "migration 371"
  );
  // A movement's note rewritten: its listing facts go with the old note (the writer that turns a row
  // into a bank document's states them again, `recordBankListingFacts`).
  const noteTrigger = dbi
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'flow_movements_evidence_au'`)
    .get() as { sql: string } | undefined;
  if (!noteTrigger) throw new Error("migration 371: no flow_movements_evidence_au trigger");
  const clause = "stated_description = NEW.note";
  if (noteTrigger.sql.split(clause).length !== 2) throw new Error(`migration 371: flow_movements_evidence_au does not set «${clause}» once`);
  reinstallTableTriggersInOrder(
    dbi,
    "movements",
    { flow_movements_evidence_au: noteTrigger.sql.replace(clause, `${clause}, stated_document_no = NULL, stated_period = NULL`) },
    "migration 371"
  );
  for (const spec of FLOW_SOURCES) {
    reinstallTableTriggersInOrder(
      dbi,
      spec.table,
      { [`flow_${spec.table}_ad`]: flowRetireDeleteTriggerSql(spec, { refundLinks: true, restatedEvidence: true }) },
      "migration 371"
    );
  }

  backfillListingFacts371(dbi);
}

/** Step 4 of {@link runEvidenceListingFacts371}: the listing facts of the bank rows on file, from their notes. */
export function backfillListingFacts371(dbi: DatabaseType): void {
  const rows = dbi
    .prepare(
      `SELECT e.id AS evidence_id, e.source_kind AS kind, m.id, m.account_id, m.note, m.occurred_on,
              (SELECT bp.posted_on FROM movement_bank_postings bp WHERE bp.movement_id = m.id AND bp.account_id = m.account_id) AS posted_on
       FROM flow_evidence e JOIN movements m ON m.id = e.source_row_id
       WHERE e.source_table = 'movements' AND e.source_kind IN ('daily_listing', 'cartola')
       ORDER BY m.id`
    )
    .all() as { evidence_id: number; kind: string; id: number; account_id: number | null; note: string | null; occurred_on: string; posted_on: string | null }[];
  const daily = dbi.prepare(
    `UPDATE flow_evidence SET stated_on = ?, stated_amount = ?, stated_description = ?, stated_document_no = ?, stated_period = NULL WHERE id = ?`
  );
  const cartola = dbi.prepare(
    `UPDATE flow_evidence SET stated_on = ?, stated_description = ?, stated_document_no = ?, stated_period = ? WHERE id = ?`
  );
  let dailyRows = 0;
  let cartolaRows = 0;
  const noDescription: number[] = [];
  const unreadable: string[] = [];
  for (const r of rows) {
    const note = String(r.note ?? "");
    if (r.kind === "daily_listing") {
      const facts = dailyNoteFacts371(note);
      if (!facts) {
        unreadable.push(`${r.id} (daily listing: no day and amount)`);
        continue;
      }
      if (facts.description === "") noDescription.push(r.id);
      daily.run(facts.bank_day, facts.amount, facts.description, facts.document_no, r.evidence_id);
      dailyRows += 1;
    } else {
      const facts = cartolaNoteFacts371(note);
      if (!facts) {
        unreadable.push(`${r.id} (cartola: no YYYY-MM month)`);
        continue;
      }
      cartola.run(r.posted_on ?? r.occurred_on, facts.description, facts.document_no, facts.period_month, r.evidence_id);
      cartolaRows += 1;
    }
  }
  if (unreadable.length > 0) {
    throw new Error(`migration 371: ${unreadable.length} bank movement(s) whose note states no listing: ${unreadable.join(", ")}`);
  }
  console.log(
    `migration 371: listing facts stated for ${dailyRows} daily-listing and ${cartolaRows} cartola movement(s)` +
      (noDescription.length > 0 ? `; ${noDescription.length} daily row(s) listed with no description: ${noDescription.join(", ")}` : "")
  );
}

const DAILY_PREFIX = "import:cartola-partial|";

/**
 * The prefix test of the evidence kind (`movementEvidenceKindSql`: SQLite's LIKE, which ignores
 * ASCII case), so a row the kind names a bank listing's is one this reader reads.
 */
function hasPrefix371(note: string, prefix: string): boolean {
  return note.slice(0, prefix.length).toLowerCase() === prefix;
}

/** A daily-listing note's facts (`import:cartola-partial|<day>|<amount>|<description>[|doc:<n>]`), as the 2026-11 reader read them. */
export function dailyNoteFacts371(
  note: string
): { bank_day: string; amount: number; description: string; document_no: string } | null {
  if (!hasPrefix371(note, DAILY_PREFIX)) return null;
  const rest = note.slice(DAILY_PREFIX.length);
  const firstBar = rest.indexOf("|");
  if (firstBar < 0) return null;
  const day = rest.slice(0, firstBar).trim();
  const afterDate = rest.slice(firstBar + 1);
  const secondBar = afterDate.indexOf("|");
  if (secondBar < 0) return null;
  const amountText = afterDate.slice(0, secondBar).trim();
  const amount = Number(amountText);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || amountText === "" || !Number.isFinite(amount)) return null;
  let tail = afterDate.slice(secondBar + 1).trim();
  let document_no = "";
  const docMatch = tail.match(/\|doc:([^|]+)$/);
  if (docMatch) {
    document_no = docMatch[1]!.trim();
    tail = tail.slice(0, docMatch.index).trim();
  }
  return { bank_day: day, amount, description: tail.replace(/\s+/g, " ").trim(), document_no };
}

const CARTOLA_PREFIX = "import:cartola|";

/** A cartola note's facts (`import:cartola|<month>|<branch>|<description>[|doc:<n>]|on:…|amt:…|idx:…`). */
export function cartolaNoteFacts371(note: string): { period_month: string; description: string; document_no: string } | null {
  if (!hasPrefix371(note, CARTOLA_PREFIX)) return null;
  const period = note.split("|")[1]?.trim() ?? "";
  if (!/^\d{4}-\d{2}$/.test(period)) return null;
  const fragment = descriptionFragment(note);
  return { period_month: period, description: stripTrailingTags(fragment), document_no: documentFragment(note, fragment) ?? "" };
}

function descriptionFragment(note: string): string {
  const rest = note.slice(CARTOLA_PREFIX.length);
  const firstBar = rest.indexOf("|");
  if (firstBar < 0) return rest.trim();
  const afterPeriod = rest.slice(firstBar + 1);
  const secondBar = afterPeriod.indexOf("|");
  if (secondBar < 0) return afterPeriod.trim();
  return afterPeriod.slice(secondBar + 1).trim();
}

function documentFragment(note: string, fragment: string): string | null {
  const docInDesc = fragment.match(/\|doc:([^|]+)$/);
  if (docInDesc) return docInDesc[1]!.trim() || null;
  const idx = note.lastIndexOf("|doc:");
  if (idx < 0) return null;
  const tail = note.slice(idx + "|doc:".length);
  const end = tail.search(/\|(on:|amt:|idx:)/);
  const doc = (end >= 0 ? tail.slice(0, end) : tail).trim();
  return doc.length > 0 ? doc : null;
}

function stripTrailingTags(desc: string): string {
  let d = desc.trim();
  for (;;) {
    const m = /\|(doc:[^|]*|on:\d{4}-\d{2}-\d{2}|amt:-?\d+|idx:\d+)$/.exec(d);
    if (!m) break;
    d = d.slice(0, m.index).trim();
  }
  return d;
}
