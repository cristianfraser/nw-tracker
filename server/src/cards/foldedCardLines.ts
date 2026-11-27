/**
 * What a statement import's folds do to what the user filed (`.claude/rules/cards.md` «A statement
 * keeps the rows on file»). A fold merges the folded rows' flows into the kept row's, and where two
 * of them hold a row in one table on one portion and piece only the earliest arrival's stays
 * (`foldCardLineFlowInto`). Before the folds run, the notes the flows hold apart are joined onto
 * the row that stays, and a category or big group only one of them can keep is named; the import
 * returns both and writes one notification, so an unattended import cannot drop them unnoticed.
 * A fold where only one row holds anything, or all hold the same, is reported by `folded` alone.
 */
import { db } from "../db.js";
import { insertAppMessage } from "../appMessages.js";
import { statementLineDateIso } from "../ccInstallmentPayBy.js";
import { rowFlowId } from "../flows/flowAdoption.js";
import { compareArrival, flowArrival } from "../flows/flowFirstSeen.js";

/** Several stored copies of one line the document prints once, folded into the row it ends on. */
export type CardLineCopiesFolded = {
  line_id: number;
  merchant: string | null;
  date: string | null;
  amount: number;
  currency: string;
  /** How many copies folded into it. */
  copies: number;
};

/** A fold whose rows held different assignments: what was joined and what only one could keep. */
export type CardLineFoldConflict = {
  /** The row that stays. */
  line_id: number;
  /** The rows folded into it. */
  folded: number[];
  merchant: string | null;
  date: string | null;
  amount: number;
  currency: string;
  /** Differing notes, joined on the row that stays (earliest arrival first). */
  notes_joined: string | null;
  /** A category («Único» or per-line) or big group a folded row held that the row that stays does not keep. */
  dropped: { what: "category" | "line_category" | "big_group"; value: string; kept: string }[];
};

const selLine = db.prepare(
  `SELECT l.id, l.merchant, l.transaction_date, l.posting_date, l.amount, l.currency FROM cc_statement_lines l WHERE l.id = ?`
);
const selNotes = db.prepare(`SELECT portion, piece_seq, notes AS v FROM flow_notes WHERE flow_id = ?`);
const selCategories = db.prepare(
  `SELECT f.portion, f.piece_seq, COALESCE(c.slug, CAST(f.category_id AS TEXT)) AS v
   FROM flow_categories f LEFT JOIN cc_expense_categories c ON c.id = f.category_id WHERE f.flow_id = ?`
);
const selBigGroups = db.prepare(`SELECT portion, piece_seq, group_slug AS v FROM flow_big_groups WHERE flow_id = ?`);
const selLineCategory = db.prepare(
  `SELECT COALESCE(c.slug, CAST(lc.category_id AS TEXT)) AS v FROM cc_expense_line_categories lc
   LEFT JOIN cc_expense_categories c ON c.id = lc.category_id WHERE lc.statement_line_id = ?`
);
const updNote = db.prepare(`UPDATE flow_notes SET notes = ? WHERE flow_id = ? AND portion = ? AND piece_seq = ?`);

type Slot = { portion: string; piece_seq: number; v: string | null };

/**
 * Joins the differing notes of each fold's rows onto the row whose note stays, and describes what
 * else only one of them keeps. Call before the folds (`lineFolds`: in the order they are applied).
 */
export function prepareCardLineFolds(folds: readonly { fromLineId: number; intoLineId: number }[]): CardLineFoldConflict[] {
  const byInto = new Map<number, number[]>();
  for (const f of folds) byInto.set(f.intoLineId, [...(byInto.get(f.intoLineId) ?? []), f.fromLineId]);
  const out: CardLineFoldConflict[] = [];
  for (const [into, froms] of byInto) {
    // The order the folds resolve a shared slot in: the earliest arrival, ties to the kept row.
    const members = [into, ...froms]
      .map((id, order) => {
        const flow = rowFlowId("cc_statement_lines", id);
        return { id, flow, arrival: flow == null ? null : flowArrival(flow), order };
      })
      .filter((m): m is typeof m & { flow: number } => m.flow != null);
    members.sort((a, b) => compareArrival(a.arrival!, b.arrival!) || a.order - b.order);
    const flows = [...new Set(members.map((m) => m.flow))];
    if (flows.length < 2) continue;
    let notesJoined: string | null = null;
    const dropped: CardLineFoldConflict["dropped"] = [];
    const slots = (sel: typeof selNotes) => {
      const bySlot = new Map<string, { flow: number; slot: Slot }[]>();
      for (const flow of flows) {
        for (const s of sel.all(flow) as Slot[]) {
          const k = `${s.portion}|${s.piece_seq}`;
          bySlot.set(k, [...(bySlot.get(k) ?? []), { flow, slot: s }]);
        }
      }
      return [...bySlot.values()];
    };
    for (const held of slots(selNotes)) {
      const texts = [...new Set(held.map((h) => String(h.slot.v ?? "").trim()).filter((t) => t !== ""))];
      if (texts.length < 2) continue;
      const winner = held[0]!;
      notesJoined = texts.join("\n");
      updNote.run(notesJoined, winner.flow, winner.slot.portion, winner.slot.piece_seq);
    }
    for (const [what, sel] of [
      ["category", selCategories],
      ["big_group", selBigGroups],
    ] as const) {
      for (const held of slots(sel)) {
        const kept = String(held[0]!.slot.v);
        for (const h of held.slice(1)) {
          const v = String(h.slot.v);
          if (v !== kept && !dropped.some((d) => d.what === what && d.value === v)) dropped.push({ what, value: v, kept });
        }
      }
    }
    // A per-line category override is the kept line's when it has one (`applyCardLinePlanDetailed`).
    const keptLineCategory = (selLineCategory.get(into) as { v: string } | undefined)?.v;
    if (keptLineCategory != null) {
      for (const id of froms) {
        const v = (selLineCategory.get(id) as { v: string } | undefined)?.v;
        if (v != null && v !== keptLineCategory) dropped.push({ what: "line_category", value: v, kept: keptLineCategory });
      }
    }
    if (notesJoined == null && dropped.length === 0) continue;
    const l = selLine.get(into) as { merchant: string | null; transaction_date: string | null; posting_date: string | null; amount: number; currency: string };
    out.push({ line_id: into, folded: froms, merchant: l.merchant, date: statementLineDateIso(l), amount: l.amount, currency: l.currency, notes_joined: notesJoined, dropped });
  }
  return out;
}

export function copiesFoldedReport(c: CardLineCopiesFolded): string {
  return `${c.copies} ${c.copies === 1 ? "copy" : "copies"} of one line folded into it: line ${c.line_id} «${c.merchant ?? "?"}» ${c.date ?? "?"} ${c.amount} ${c.currency} (the document prints it once)`;
}

export function foldConflictReport(c: CardLineFoldConflict): string {
  const parts = [
    ...(c.notes_joined != null ? [`notes joined («${c.notes_joined.replace(/\n/g, " / ")}»)`] : []),
    ...c.dropped.map((d) => `${d.what.replace(/_/g, " ")} ${d.value} dropped (kept ${d.kept})`),
  ];
  return `folded with different assignments: line(s) ${c.folded.join(", ")} into line ${c.line_id} «${c.merchant ?? "?"}» ${c.date ?? "?"} ${c.amount} ${c.currency}: ${parts.join("; ")}`;
}

export const FOLDED_APART_TITLE = "Card lines folded with different assignments";

/** One notification for an import's folds whose rows held different assignments; none otherwise. */
export function notifyCardLineFoldConflicts(accountId: number, conflicts: readonly CardLineFoldConflict[]): void {
  if (conflicts.length === 0) return;
  insertAppMessage(
    "notification",
    FOLDED_APART_TITLE,
    `A statement import on card account ${accountId} folded ${conflicts.length} group(s) of lines into one row each, ` +
      `and their assignments differed:\n${conflicts.map(foldConflictReport).join("\n")}`
  );
}
