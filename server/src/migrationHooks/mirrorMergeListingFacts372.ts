import type { Database as DatabaseType } from "better-sqlite3";
import { writeLogTriggerSql } from "../markInputTriggers.js";
import { reinstallTableTriggersInOrder } from "./tableTriggerReinstall.js";
import { cartolaNoteFacts371, dailyNoteFacts371 } from "./evidenceListingFacts371.js";

/** The columns the merge rows' mark trigger watches (its write log logs the others). */
const MARK_WATCHED = ["transfer_movement_id", "out_occurred_on", "in_occurred_on"] as const;

/**
 * Migration 372 hook, after its SQL added the `out_listed_*` / `in_listed_*` columns of
 * `movement_mirror_merges`: the write log watches them, and each merge row on file keeps the
 * listing facts its deleted legs stated, read ONCE from the leg notes it kept with migration 371's
 * reader (a leg whose note is a cartola or daily-listing row's, its kind's prefix test; an anchor
 * note is neither): the bank day (a daily note's day; a cartola leg's posting on its account kept
 * on the transfer, else its day), the description, the document ('' when none) and the cartola
 * month. A bank leg note that does not read fails the migration, every such merge row listed at
 * once. Pure (no `db` import).
 */
export function runMirrorMergeListingFacts372(dbi: DatabaseType): void {
  const cols = (dbi.prepare(`SELECT name FROM pragma_table_info('movement_mirror_merges')`).all() as { name: string }[]).map((c) => c.name);
  const before = writeLogTriggerSql("movement_mirror_merges", cols.filter((c) => !c.includes("_listed_")), [...MARK_WATCHED])[0]!;
  const installed = (dbi.prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'write_log_movement_mirror_merges_au'`).get() as
    | { sql: string }
    | undefined)?.sql;
  if (installed !== before) throw new Error("migration 372: write_log_movement_mirror_merges_au is not the expected trigger");
  reinstallTableTriggersInOrder(
    dbi,
    "movement_mirror_merges",
    { write_log_movement_mirror_merges_au: writeLogTriggerSql("movement_mirror_merges", cols, [...MARK_WATCHED])[0]! },
    "migration 372"
  );
  backfillMirrorMergeListingFacts372(dbi);
}

const ANCHOR = /^import:cartola\|(anchor|opening)\|/i;

function legFacts(note: string | null, postedOn: string | null, occurredOn: string): { facts: (string | null)[] } | "not_bank" | "unreadable" {
  const n = String(note ?? "");
  const daily = n.slice(0, "import:cartola-partial|".length).toLowerCase() === "import:cartola-partial|";
  const cartola = !daily && n.slice(0, "import:cartola|".length).toLowerCase() === "import:cartola|" && !ANCHOR.test(n);
  if (daily) {
    const f = dailyNoteFacts371(n);
    return f ? { facts: [f.bank_day, f.description, f.document_no, null] } : "unreadable";
  }
  if (cartola) {
    const f = cartolaNoteFacts371(n);
    return f ? { facts: [postedOn ?? occurredOn, f.description, f.document_no, f.period_month] } : "unreadable";
  }
  return "not_bank";
}

/** The listing facts of the merge rows on file (see {@link runMirrorMergeListingFacts372}). */
export function backfillMirrorMergeListingFacts372(dbi: DatabaseType): void {
  const rows = dbi
    .prepare(
      `SELECT mm.transfer_movement_id AS id, mm.out_note, mm.out_occurred_on, mm.in_note, mm.in_occurred_on, mm.in_movement_id,
         (SELECT bp.posted_on FROM movement_bank_postings bp JOIN movements t ON t.id = bp.movement_id
           WHERE bp.movement_id = mm.transfer_movement_id AND bp.account_id = t.from_account_id) AS out_posted_on,
         (SELECT bp.posted_on FROM movement_bank_postings bp JOIN movements t ON t.id = bp.movement_id
           WHERE bp.movement_id = mm.transfer_movement_id AND bp.account_id = t.to_account_id) AS in_posted_on
       FROM movement_mirror_merges mm ORDER BY mm.transfer_movement_id`
    )
    .all() as {
    id: number;
    out_note: string | null;
    out_occurred_on: string;
    in_note: string | null;
    in_occurred_on: string;
    in_movement_id: number | null;
    out_posted_on: string | null;
    in_posted_on: string | null;
  }[];
  const setOut = dbi.prepare(
    `UPDATE movement_mirror_merges SET out_listed_on = ?, out_listed_description = ?, out_listed_document_no = ?, out_listed_period = ? WHERE transfer_movement_id = ?`
  );
  const setIn = dbi.prepare(
    `UPDATE movement_mirror_merges SET in_listed_on = ?, in_listed_description = ?, in_listed_document_no = ?, in_listed_period = ? WHERE transfer_movement_id = ?`
  );
  const unreadable: string[] = [];
  let legs = 0;
  for (const r of rows) {
    const out = legFacts(r.out_note, r.out_posted_on, r.out_occurred_on);
    if (out === "unreadable") unreadable.push(`${r.id} (out leg)`);
    else if (out !== "not_bank") {
      setOut.run(...out.facts, r.id);
      legs += 1;
    }
    // A card-payment conversion's «in» side is statement evidence, never a deleted movement.
    if (r.in_movement_id == null) continue;
    const inn = legFacts(r.in_note, r.in_posted_on, r.in_occurred_on);
    if (inn === "unreadable") unreadable.push(`${r.id} (in leg)`);
    else if (inn !== "not_bank") {
      setIn.run(...inn.facts, r.id);
      legs += 1;
    }
  }
  if (unreadable.length > 0) {
    throw new Error(`migration 372: ${unreadable.length} mirror-merge leg(s) whose note states no listing: ${unreadable.join(", ")}`);
  }
  console.log(`migration 372: listing facts kept for ${legs} bank leg(s) of ${rows.length} mirror conversion(s)`);
}
