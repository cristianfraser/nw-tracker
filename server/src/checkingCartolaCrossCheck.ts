/**
 * A month on file confirmed by a second document (fail fast). Santander gives a month of the
 * cuenta corriente as the xlsx downloaded from its site and as the PDF it mails; a cuenta vista
 * month can sit in two documents (an annual and a monthly cartola). When a document arrives for a
 * month whose record names another one, and both cover the whole month
 * (`cartolaCoversWholeMonth`), the document must state what is on file: the same count of
 * movements, and at each position the same bank day, signed pesos, document number, description
 * and branch (text compared through `normalizeCartolaText`), and the same printed opening and
 * closing balances. Equal → the month record notes the confirming document; any difference
 * refuses the document, every difference listed. A day's rows are compared as a set: the same rows
 * in another order are an `order` note, not a difference.
 *
 * What is on file for the month (`cartolaMonthListingOnFile`): the listing facts of the rows its
 * cartola wrote or restated (`stated_period`, `stated_position` on their evidence), and those a
 * mirror conversion kept on its merge row for a leg it deleted (`movement_mirror_merges`
 * `out_listed_*` / `in_listed_*`). A movement the import confirmed onto a transfer leg or a
 * mail-written row has no listing of its own: its position is checked by asking the cartola planner
 * whether the document's movement there is still confirmed by such a row.
 */
import type { Database } from "better-sqlite3";
import { foldUpper } from "nw-tracker-contracts";
import { db } from "./db.js";
import type { ParsedCheckingCartola } from "./checkingCartolaParse.js";
import { cartolaListingFacts } from "./movementListingFacts.js";
import { planCheckingCartola } from "./checkingCartolaPlan.js";
import { loadCheckingCartolaPlanInput } from "./checkingCartolaPlanLoad.js";
import { isHomeCurrency } from "./displayUnits.js";

/**
 * The one comparison of printed text between two renderings of a cartola: accents folded, case
 * folded, runs of whitespace collapsed. Tighten it here once both readers print the same text.
 */
export function normalizeCartolaText(text: string): string {
  return foldUpper(text);
}

export type CartolaListedRow = {
  bank_day: string;
  amount_clp: number;
  description: string;
  document_no: string;
  branch: string;
  /** Where the facts are kept: the row's evidence, or the merge row of a converted leg. */
  kept_on: "cartola_row" | "converted_leg";
  row_id: number;
};

/** One difference between the month on file and a second document. `position` null: the month as a whole. */
export type CartolaMonthDifference = {
  position: number | null;
  field: "movement_count" | "opening_balance" | "closing_balance" | "movement" | "bank_day" | "amount" | "document_no" | "description" | "branch";
  on_file: string;
  document: string;
};

/** The month's listed movements on file, by their position in its cartola. */
export function cartolaMonthListingOnFile(accountId: number, periodMonth: string, dbHandle: Database = db): Map<number, CartolaListedRow> {
  const out = new Map<number, CartolaListedRow>();
  const put = (position: number | null, row: CartolaListedRow) => {
    if (position == null) throw new Error(`account ${accountId} ${periodMonth}: listed row ${row.row_id} (${row.kept_on}) states no position in its cartola`);
    const other = out.get(position);
    if (other) throw new Error(`account ${accountId} ${periodMonth}: rows ${other.row_id} and ${row.row_id} both state position ${position} of the cartola`);
    out.set(position, row);
  };
  for (const r of dbHandle
    .prepare(
      `SELECT m.id, e.stated_position AS position, e.stated_on AS bank_day, e.stated_amount AS amount, e.stated_description AS description,
              e.stated_document_no AS document_no, e.stated_branch AS branch
       FROM movements m JOIN flow_evidence e ON e.source_table = 'movements' AND e.source_row_id = m.id
       WHERE m.account_id = ? AND e.source_kind = 'cartola' AND e.stated_period = ?`
    )
    .all(accountId, periodMonth) as { id: number; position: number | null; bank_day: string; amount: number; description: string; document_no: string; branch: string | null }[]) {
    put(r.position, { bank_day: r.bank_day, amount_clp: r.amount, description: r.description, document_no: r.document_no, branch: r.branch ?? "", kept_on: "cartola_row", row_id: r.id });
  }
  for (const side of ["out", "in"] as const) {
    const accountColumn = side === "out" ? "from_account_id" : "to_account_id";
    for (const r of dbHandle
      .prepare(
        `SELECT mm.transfer_movement_id AS id, mm.${side}_listed_position AS position, mm.${side}_listed_on AS bank_day, mm.${side}_amount AS amount,
                mm.${side}_currency AS currency, mm.${side}_listed_description AS description, mm.${side}_listed_document_no AS document_no,
                mm.${side}_listed_branch AS branch
         FROM movement_mirror_merges mm JOIN movements t ON t.id = mm.transfer_movement_id
         WHERE t.${accountColumn} = ? AND mm.${side}_listed_period = ?`
      )
      .all(accountId, periodMonth) as {
      id: number;
      position: number | null;
      bank_day: string;
      amount: number;
      currency: string;
      description: string;
      document_no: string;
      branch: string | null;
    }[]) {
      if (!isHomeCurrency(r.currency)) throw new Error(`account ${accountId} ${periodMonth}: converted leg of transfer ${r.id} is in ${r.currency}, not pesos`);
      put(r.position, { bank_day: r.bank_day, amount_clp: r.amount, description: r.description, document_no: r.document_no, branch: r.branch ?? "", kept_on: "converted_leg", row_id: r.id });
    }
  }
  return out;
}

type MonthRecord = { movement_count: number; saldo_inicial_clp: number | null; saldo_final_clp: number | null };

/**
 * `differences`: what refuses the document (empty: it states the month as it is); `order`: rows of
 * one day the two renderings print in another order — the same rows, reported, never refused
 * (the month keeps the row keys of the document it was imported from, `flows/cartolaRowKey.ts`).
 */
export type CartolaMonthComparison = { differences: CartolaMonthDifference[]; order: string[] };

/** `cartola` against its month on file (see `CartolaMonthComparison`). */
export function compareCartolaWithMonthOnFile(accountId: number, cartola: ParsedCheckingCartola, dbHandle: Database = db): CartolaMonthComparison {
  const record = dbHandle
    .prepare(`SELECT movement_count, saldo_inicial_clp, saldo_final_clp FROM checking_cartola_imports WHERE account_id = ? AND period_month = ?`)
    .get(accountId, cartola.period_month) as MonthRecord | undefined;
  if (!record) throw new Error(`account ${accountId}: no cartola month ${cartola.period_month} on file to compare ${cartola.source_file} with`);
  const diffs: CartolaMonthDifference[] = [];
  const pesos = (n: number | null) => (n == null ? "—" : String(n));
  if (record.movement_count !== cartola.movements.length) {
    diffs.push({ position: null, field: "movement_count", on_file: String(record.movement_count), document: String(cartola.movements.length) });
  }
  for (const [field, onFile, doc] of [
    ["opening_balance", record.saldo_inicial_clp, cartola.saldo_inicial_clp],
    ["closing_balance", record.saldo_final_clp, cartola.saldo_final_clp],
  ] as const) {
    if (onFile != null && doc != null && onFile !== doc) diffs.push({ position: null, field, on_file: pesos(onFile), document: pesos(doc) });
  }

  const listed = cartolaMonthListingOnFile(accountId, cartola.period_month, dbHandle);
  // Movements no listing keeps: the ones the month's import confirmed onto a transfer leg or a
  // mail-written row. The planner says which of the document's movements still are one.
  const plan = planCheckingCartola({ ...loadCheckingCartolaPlanInput(accountId, cartola, dbHandle), replace_month: true });
  const confirmed = new Set(plan.confirm.map((c) => c.movement));
  const gaps = record.movement_count - listed.size;
  const docText = (i: number) => {
    const mv = cartola.movements[i]!;
    return `${mv.occurred_on} ${mv.amount_clp} «${mv.description}»`;
  };
  const fileText = (r: CartolaListedRow) => `${r.bank_day} ${r.amount_clp} «${r.description}»`;

  // Pair the document's listed movements with the rows on file: the same position with the same
  // day, pesos and text; then, inside a day, the same pesos and text, then the same pesos (two renderings may
  // print a day's rows in another order: reported apart, `order`); then what is left, by position.
  const docLeft = new Set(cartola.movements.map((_, i) => i));
  const fileLeft = new Map(listed);
  const pairs: { position: number; row: CartolaListedRow; filePosition: number }[] = [];
  const take = (i: number, p: number) => {
    pairs.push({ position: i, row: fileLeft.get(p)!, filePosition: p });
    docLeft.delete(i);
    fileLeft.delete(p);
  };
  const sameText = (i: number, r: CartolaListedRow) =>
    normalizeCartolaText(r.description) === normalizeCartolaText(cartolaListingFacts(cartola.period_month, cartola.movements[i]!, i).description);
  for (const i of [...docLeft]) {
    const r = fileLeft.get(i);
    const mv = cartola.movements[i]!;
    if (r && r.bank_day === mv.occurred_on && Math.round(r.amount_clp) === mv.amount_clp && sameText(i, r)) take(i, i);
  }
  for (const match of [(i: number, r: CartolaListedRow) => sameText(i, r), () => true]) {
    for (const i of [...docLeft]) {
      const mv = cartola.movements[i]!;
      const hit = [...fileLeft].find(([, r]) => r.bank_day === mv.occurred_on && Math.round(r.amount_clp) === mv.amount_clp && match(i, r));
      if (hit) take(i, hit[0]);
    }
  }
  // What no listed row took and the planner confirms onto a leg or a mail row stands for the
  // month's confirmed movements (a converted leg keeps its listing and was paired above).
  const viaLegOrMail = [...docLeft].filter((i) => confirmed.has(i));
  for (const i of viaLegOrMail) docLeft.delete(i);
  for (const i of [...docLeft]) if (fileLeft.has(i)) take(i, i);

  const order: string[] = [];
  for (const { position, row, filePosition } of pairs.sort((x, y) => x.position - y.position)) {
    if (filePosition !== position) order.push(`${cartola.period_month} movement ${position + 1} of the document is movement ${filePosition + 1} on file (same day)`);
    const mv = cartola.movements[position]!;
    const doc = cartolaListingFacts(cartola.period_month, mv, position);
    if (row.bank_day !== doc.bank_day) diffs.push({ position, field: "bank_day", on_file: row.bank_day, document: doc.bank_day });
    if (Math.round(row.amount_clp) !== mv.amount_clp) diffs.push({ position, field: "amount", on_file: String(row.amount_clp), document: String(mv.amount_clp) });
    for (const [field, a, b2] of [
      ["document_no", row.document_no, doc.document_no],
      ["description", row.description, doc.description],
      ["branch", row.branch, doc.branch ?? ""],
    ] as const) {
      if (normalizeCartolaText(a) !== normalizeCartolaText(b2)) diffs.push({ position, field, on_file: a, document: b2 });
    }
  }
  for (const i of [...docLeft].sort((x, y) => x - y)) diffs.push({ position: i, field: "movement", on_file: "—", document: docText(i) });
  for (const [p, r] of [...fileLeft].sort((x, y) => x[0] - y[0])) diffs.push({ position: p, field: "movement", on_file: fileText(r), document: "—" });
  if (viaLegOrMail.length !== gaps) {
    diffs.push({
      position: null,
      field: "movement",
      on_file: `${gaps} movement(s) on a transfer leg or mail row`,
      document: `${viaLegOrMail.length} such movement(s)`,
    });
  }
  return { differences: diffs.sort((x, y) => (x.position ?? -1) - (y.position ?? -1)), order };
}

/** One line per difference, for the refusal. */
export function describeCartolaMonthDifference(periodMonth: string, d: CartolaMonthDifference): string {
  const where = d.position == null ? periodMonth : `${periodMonth} movement ${d.position + 1}`;
  return `${where} ${d.field}: on file ${d.on_file}, document ${d.document}`;
}

/** The month record notes the document that confirmed it (a later copy of that document writes nothing). */
export function recordCartolaMonthConfirmed(accountId: number, cartola: ParsedCheckingCartola, dbHandle: Database = db): void {
  dbHandle
    .prepare(
      `UPDATE checking_cartola_imports SET confirmed_by_file = ?, confirmed_at = datetime('now')
       WHERE account_id = ? AND period_month = ? AND confirmed_by_file IS NOT ?`
    )
    .run(cartola.source_file, accountId, cartola.period_month, cartola.source_file);
}
