/**
 * A month on file confirmed by a second document (fail fast). Santander gives a month of the
 * cuenta corriente as the xlsx downloaded from its site and as the PDF it mails; a cuenta vista
 * month can sit in two documents (an annual and a monthly cartola). When a document arrives for a
 * month whose record names another one, and both cover the whole month
 * (`cartolaCoversWholeMonth`), the document must state what is on file: the same count of
 * movements, and at each position the same bank day, signed pesos, document number, description
 * and branch (text compared through `normalizeCartolaText`), and the same printed opening and
 * closing balances. Equal → the month record notes the confirming document; any difference
 * refuses the document, every difference listed.
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

/** Every difference between `cartola` and its month on file (empty: the document states the month as it is). */
export function compareCartolaWithMonthOnFile(accountId: number, cartola: ParsedCheckingCartola, dbHandle: Database = db): CartolaMonthDifference[] {
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
  // Positions no listing keeps: movements the month's import confirmed onto a transfer leg or a
  // mail-written row. The planner says whether the document's movement there still is one.
  let confirmed: Set<number> | null = null;
  const confirmedNow = (): Set<number> => {
    if (confirmed == null) {
      const plan = planCheckingCartola({ ...loadCheckingCartolaPlanInput(accountId, cartola, dbHandle), replace_month: true });
      confirmed = new Set(plan.confirm.map((c) => c.movement));
    }
    return confirmed;
  };
  const n = Math.max(record.movement_count, cartola.movements.length);
  for (let position = 0; position < n; position++) {
    const mv = cartola.movements[position];
    const onFile = listed.get(position);
    const docText = mv == null ? "—" : `${mv.occurred_on} ${mv.amount_clp} «${mv.description}»`;
    if (onFile == null) {
      if (position >= record.movement_count) {
        diffs.push({ position, field: "movement", on_file: "—", document: docText });
      } else if (mv == null || !confirmedNow().has(position)) {
        diffs.push({ position, field: "movement", on_file: "a transfer leg or mail row the month's cartola confirmed", document: docText });
      }
      continue;
    }
    if (mv == null) {
      diffs.push({ position, field: "movement", on_file: `${onFile.bank_day} ${onFile.amount_clp} «${onFile.description}»`, document: "—" });
      continue;
    }
    const doc = cartolaListingFacts(cartola.period_month, mv, position);
    if (onFile.bank_day !== doc.bank_day) diffs.push({ position, field: "bank_day", on_file: onFile.bank_day, document: doc.bank_day });
    if (Math.round(onFile.amount_clp) !== mv.amount_clp) diffs.push({ position, field: "amount", on_file: String(onFile.amount_clp), document: String(mv.amount_clp) });
    for (const [field, a, b] of [
      ["document_no", onFile.document_no, doc.document_no],
      ["description", onFile.description, doc.description],
      ["branch", onFile.branch, doc.branch ?? ""],
    ] as const) {
      if (normalizeCartolaText(a) !== normalizeCartolaText(b)) diffs.push({ position, field, on_file: a, document: b });
    }
  }
  return diffs;
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
