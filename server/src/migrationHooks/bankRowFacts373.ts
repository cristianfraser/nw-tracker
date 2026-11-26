import type { Database as DatabaseType } from "better-sqlite3";
import { writeLogTriggerSql } from "../markInputTriggers.js";
import { reinstallTableTriggersInOrder } from "./tableTriggerReinstall.js";
import { CARTOLA_KEY_COLUMNS_SQL, cartolaKeyParts, minorDigitsReader, type CartolaKeyRow } from "../flows/cartolaRowKey.js";

/** The columns the merge rows' mark trigger watches (its write log logs the others; migration 372). */
const MERGE_MARK_WATCHED = ["transfer_movement_id", "out_occurred_on", "in_occurred_on"] as const;

/**
 * Migration 373 hook, after its SQL added `flow_evidence.stated_branch` / `stated_position` and the
 * merge rows' `*_listed_branch` / `*_listed_position`:
 *
 * 1. the write logs of `flow_evidence` and `movement_mirror_merges` watch the new columns;
 * 2. a movement whose note is rewritten loses its branch and position with its other listing facts
 *    (`flow_movements_evidence_au`, migration 371);
 * 3. the rows on file state, read ONCE from their notes with the readers runtime used until now (copied
 *    here as they stood): a cartola row its branch (the note's third field) and the identity its
 *    purchase key was built from — its position (`idx:`) and the day the cartola listed it (`on:`, into
 *    `stated_on`), the amount (`amt:`) checked against the row's (`cartolaRowKey.ts`), so every key
 *    stored on a flow names the same row; a note with no such identity states no position (the row
 *    stays keyed by its id);
 *    a row written from a mail its description (`import:<issuer>-mail|<time or marker>|<description>`,
 *    the whole note when it has no description field); a ledger anchor its description (the field
 *    after its month, «saldo final»);
 * 4. each mirror conversion keeps the branch, position and listed day of a deleted cartola leg, from
 *    the leg note it kept (none of the identity when the note states none).
 *
 * A cartola note whose amount disagrees with its row's fails the migration, every such row listed at
 * once (`scripts/report-document-import.ts --preflight` lists them before a deploy). Pure (no `db`
 * import).
 */
export function runBankRowFacts373(dbi: DatabaseType): void {
  const evidenceCols = (dbi.prepare(`SELECT name FROM pragma_table_info('flow_evidence')`).all() as { name: string }[]).map((c) => c.name);
  if (!evidenceCols.includes("stated_branch") || !evidenceCols.includes("stated_position")) {
    throw new Error("migration 373: flow_evidence has no stated_branch / stated_position");
  }
  reinstallTableTriggersInOrder(
    dbi,
    "flow_evidence",
    { write_log_flow_evidence_au: writeLogTriggerSql("flow_evidence", evidenceCols, null)[2]! },
    "migration 373"
  );
  const mergeCols = (dbi.prepare(`SELECT name FROM pragma_table_info('movement_mirror_merges')`).all() as { name: string }[]).map((c) => c.name);
  reinstallTableTriggersInOrder(
    dbi,
    "movement_mirror_merges",
    { write_log_movement_mirror_merges_au: writeLogTriggerSql("movement_mirror_merges", mergeCols, [...MERGE_MARK_WATCHED])[0]! },
    "migration 373"
  );
  const noteTrigger = dbi
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'flow_movements_evidence_au'`)
    .get() as { sql: string } | undefined;
  if (!noteTrigger) throw new Error("migration 373: no flow_movements_evidence_au trigger");
  const clause = "stated_document_no = NULL, stated_period = NULL";
  if (noteTrigger.sql.split(clause).length !== 2) throw new Error(`migration 373: flow_movements_evidence_au does not set «${clause}» once`);
  reinstallTableTriggersInOrder(
    dbi,
    "movements",
    { flow_movements_evidence_au: noteTrigger.sql.replace(clause, `${clause}, stated_branch = NULL, stated_position = NULL`) },
    "migration 373"
  );
  backfillBankRowFacts373(dbi);
}

/** Steps 3 and 4 of {@link runBankRowFacts373}. */
export function backfillBankRowFacts373(dbi: DatabaseType): void {
  const digits = minorDigitsReader(dbi);
  const rows = dbi
    .prepare(
      `SELECT e.id AS evidence_id, e.source_kind AS kind, m.id, m.note, ${CARTOLA_KEY_COLUMNS_SQL}
       FROM flow_evidence e JOIN movements m ON m.id = e.source_row_id
       WHERE e.source_table = 'movements' AND e.source_kind IN ('cartola', 'mail_notice', 'mail_rebuilt', 'cartola_anchor')
       ORDER BY m.id`
    )
    .all() as (CartolaKeyRow & { evidence_id: number; kind: string; id: number; note: string | null })[];
  const setCartola = dbi.prepare(`UPDATE flow_evidence SET stated_branch = ?, stated_position = ?, stated_on = COALESCE(?, stated_on) WHERE id = ?`);
  const setDescription = dbi.prepare(`UPDATE flow_evidence SET stated_description = ? WHERE id = ?`);
  const disagreeing: number[] = [];
  const counts = { cartola: 0, keyless: 0, mail: 0, anchor: 0 };
  for (const r of rows) {
    const note = String(r.note ?? "").trim();
    if (r.kind === "cartola") {
      const facts = cartolaPlaceFacts373(note);
      if (facts.identity == null) {
        // No cartola identity in the note (no `on:`/`amt:`/`idx:`): the row was keyed by its id, and stays so.
        setCartola.run(facts.branch, null, null, r.evidence_id);
        counts.keyless += 1;
        continue;
      }
      // Only the amount is compared here (the month is the 371 backfill's).
      const amount = cartolaKeyParts({ ...r, stated_period: "-", stated_on: facts.identity.on, stated_position: facts.identity.position }, digits)?.amountMinor;
      if (amount == null || String(amount) !== facts.identity.amt) {
        disagreeing.push(r.id);
        continue;
      }
      setCartola.run(facts.branch, facts.identity.position, facts.identity.on, r.evidence_id);
      counts.cartola += 1;
    } else if (r.kind === "cartola_anchor") {
      setDescription.run(anchorDescription373(note), r.evidence_id);
      counts.anchor += 1;
    } else {
      setDescription.run(mailDescription373(note), r.evidence_id);
      counts.mail += 1;
    }
  }
  if (disagreeing.length > 0) {
    throw new Error(
      `migration 373: ${disagreeing.length} cartola movement(s) whose note's amount disagrees with the row's (their purchase key would change): ${disagreeing.join(", ")}`
    );
  }

  const merges = dbi.prepare(`SELECT transfer_movement_id AS id, out_note, in_note, in_movement_id FROM movement_mirror_merges`).all() as {
    id: number;
    out_note: string | null;
    in_note: string | null;
    in_movement_id: number | null;
  }[];
  const setOut = dbi.prepare(
    `UPDATE movement_mirror_merges SET out_listed_branch = ?, out_listed_position = ?, out_listed_on = COALESCE(?, out_listed_on) WHERE transfer_movement_id = ?`
  );
  const setIn = dbi.prepare(
    `UPDATE movement_mirror_merges SET in_listed_branch = ?, in_listed_position = ?, in_listed_on = COALESCE(?, in_listed_on) WHERE transfer_movement_id = ?`
  );
  let legs = 0;
  for (const m of merges) {
    if (isCartolaRowNote(m.out_note)) {
      const f = cartolaPlaceFacts373(String(m.out_note).trim());
      setOut.run(f.branch, f.identity?.position ?? null, f.identity?.on ?? null, m.id);
      legs += 1;
    }
    // A card-payment conversion's «in» side is statement evidence, never a deleted movement.
    if (m.in_movement_id != null && isCartolaRowNote(m.in_note)) {
      const f = cartolaPlaceFacts373(String(m.in_note).trim());
      setIn.run(f.branch, f.identity?.position ?? null, f.identity?.on ?? null, m.id);
      legs += 1;
    }
  }
  console.log(
    `migration 373: branch and identity stated for ${counts.cartola} cartola movement(s) (${counts.keyless} with no identity in their note, ` +
      `keyed by id), the description for ${counts.mail} mail and ${counts.anchor} anchor movement(s); ${legs} mirror-merge leg(s)`
  );
}

const ANCHOR = /^import:cartola\|(anchor|opening)\|/i;

/** A cartola row's note (the evidence kind's test: `import:cartola|`, ASCII case ignored, not an anchor). */
function isCartolaRowNote(note: string | null): boolean {
  const n = String(note ?? "").trim();
  return n.slice(0, "import:cartola|".length).toLowerCase() === "import:cartola|" && !ANCHOR.test(n);
}

/**
 * A cartola note's branch (its third field) and its identity — the day (`on:`), amount (`amt:`) and
 * position (`idx:`) its purchase key was built from — as the 2026-11 readers read them; no identity
 * when any of the three is missing (the key reader then keyed the row by its id).
 */
export function cartolaPlaceFacts373(note: string): { branch: string; identity: { on: string; amt: string; position: number } | null } {
  const on = note.match(/\|on:([^|]+)/)?.[1]?.trim();
  const amt = note.match(/\|amt:([^|]+)/)?.[1]?.trim();
  const idx = note.match(/\|idx:(\d+)/)?.[1];
  return { branch: note.split("|")[2] ?? "", identity: on && amt != null && idx != null ? { on, amt, position: Number(idx) } : null };
}

/** A mail-written row's description, as `cartolaDescriptionFromNote` read it. */
export function mailDescription373(note: string): string {
  const mail = /^import:(?:santander|mach|bancochile)-mail\|[^|]*\|(.*)$/.exec(note);
  return mail ? mail[1]!.trim() : note;
}

/** A ledger anchor's description, as `cartolaDescriptionFromNote` read it (the field after its month). */
export function anchorDescription373(note: string): string {
  const rest = note.slice("import:cartola|".length);
  const firstBar = rest.indexOf("|");
  if (firstBar < 0) return rest;
  const afterPeriod = rest.slice(firstBar + 1);
  const secondBar = afterPeriod.indexOf("|");
  if (secondBar < 0) return afterPeriod.trim();
  let desc = afterPeriod.slice(secondBar + 1).trim();
  if (desc.startsWith("doc:")) desc = "";
  for (;;) {
    const m = /\|(doc:[^|]*|on:\d{4}-\d{2}-\d{2}|amt:-?\d+|idx:\d+)$/.exec(desc);
    if (!m) break;
    desc = desc.slice(0, m.index).trim();
  }
  return desc;
}
