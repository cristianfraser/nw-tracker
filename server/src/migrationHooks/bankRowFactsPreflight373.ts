import type { Database as DatabaseType } from "better-sqlite3";
import { cartolaKeyParts, minorDigitsReader } from "../flows/cartolaRowKey.js";
import { cartolaPlaceFacts373 } from "./bankRowFacts373.js";

/**
 * What migrations 371–373 would trip on, read only, on a database that may not have applied them
 * (`scripts/report-document-import.ts --preflight`): every list empty = safe to deploy.
 *
 * - `no_evidence`: movements with no `flow_evidence` row (the readers of `bankRowFacts.ts` throw for them);
 * - `cartola_without_identity`: cartola rows whose note lacks `on:` / `amt:` / `idx:` (they stay keyed by
 *   their id, as before, and state no position);
 * - `cartola_amount_disagrees`: cartola rows whose note's `amt:` is not the row's signed amount in minor
 *   units (migration 373 fails on them: their purchase key would change);
 * - `cartola_day_moves`: cartola rows whose evidence states a listed day other than the note's `on:`
 *   (373 states the note's day; informational, when 371 is applied);
 * - `merge_legs_without_identity`: mirror-merge legs whose kept cartola note has no identity (restored
 *   without a position on undo).
 */
export type BankRowFactsPreflight = {
  no_evidence: number[];
  cartola_without_identity: number[];
  cartola_amount_disagrees: number[];
  cartola_day_moves: number[];
  merge_legs_without_identity: number[];
};

const ANCHOR = /^import:cartola\|(anchor|opening)\|/i;
const isCartolaRowNote = (note: string | null) => {
  const n = String(note ?? "").trim();
  return n.slice(0, "import:cartola|".length).toLowerCase() === "import:cartola|" && !ANCHOR.test(n);
};

export function bankRowFactsPreflight373(dbi: DatabaseType): BankRowFactsPreflight {
  const evidenceCols = new Set((dbi.prepare(`SELECT name FROM pragma_table_info('flow_evidence')`).all() as { name: string }[]).map((c) => c.name));
  const hasStatedOn = evidenceCols.has("stated_on");
  const out: BankRowFactsPreflight = {
    no_evidence: (
      dbi
        .prepare(
          `SELECT m.id FROM movements m
           WHERE NOT EXISTS (SELECT 1 FROM flow_evidence e WHERE e.source_table = 'movements' AND e.source_row_id = m.id) ORDER BY m.id`
        )
        .all() as { id: number }[]
    ).map((r) => r.id),
    cartola_without_identity: [],
    cartola_amount_disagrees: [],
    cartola_day_moves: [],
    merge_legs_without_identity: [],
  };
  const digits = minorDigitsReader(dbi);
  const rows = dbi
    .prepare(
      `SELECT m.id, m.note, m.account_id, m.amount, m.currency, m.flow_kind, ${hasStatedOn ? "e.stated_on" : "NULL"} AS stated_on
       FROM movements m JOIN flow_evidence e ON e.source_table = 'movements' AND e.source_row_id = m.id
       WHERE e.source_kind = 'cartola' ORDER BY m.id`
    )
    .all() as { id: number; note: string | null; account_id: number | null; amount: number; currency: string; flow_kind: string | null; stated_on: string | null }[];
  for (const r of rows) {
    const identity = cartolaPlaceFacts373(String(r.note ?? "").trim()).identity;
    if (!identity) {
      out.cartola_without_identity.push(r.id);
      continue;
    }
    const parts = cartolaKeyParts({ ...r, stated_period: "-", stated_on: identity.on, stated_position: identity.position }, digits);
    if (parts == null || String(parts.amountMinor) !== identity.amt) out.cartola_amount_disagrees.push(r.id);
    if (r.stated_on != null && r.stated_on !== identity.on) out.cartola_day_moves.push(r.id);
  }
  const merges = dbi.prepare(`SELECT transfer_movement_id AS id, out_note, in_note, in_movement_id FROM movement_mirror_merges ORDER BY transfer_movement_id`).all() as {
    id: number;
    out_note: string | null;
    in_note: string | null;
    in_movement_id: number | null;
  }[];
  for (const m of merges) {
    const out_ = isCartolaRowNote(m.out_note) && cartolaPlaceFacts373(String(m.out_note).trim()).identity == null;
    const in_ = m.in_movement_id != null && isCartolaRowNote(m.in_note) && cartolaPlaceFacts373(String(m.in_note).trim()).identity == null;
    if (out_ || in_) out.merge_legs_without_identity.push(m.id);
  }
  return out;
}
