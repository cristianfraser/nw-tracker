/**
 * The cartola planner (pure): a parsed cartola month against the checking account's rows on file,
 * before anything is written, as row outcomes (the rule: `.claude/rules/expenses.md` «Checking /
 * cuenta vista ledger anchor»):
 *
 *  - `keep`: a row on file and the cartola movement that restates it — the month's cartola row
 *    already imported (its document key, the same printed figures, the same cells as an older reader
 *    read them, or the tolerant content match: another rendering of the month; in a replaced month, last, the one row the new cartola would
 *    remove and the one movement it would write of a bank day and signed pesos, or N such twins
 *    that read alike), or the
 *    daily-listing row the cartola movement lists, with the receipt-corrected day it carries
 *    (`redate`);
 *  - `confirm`: a transfer leg or a mail-written movement the cartola movement confirms (the row
 *    stays as it is; only its bank posting / confirmation is recorded);
 *  - `insert`: a cartola movement no row on file is (taking back a retired flow of its document
 *    when exactly one is on file);
 *  - `fold`: a row that is the same movement as a kept row (the earliest seen is kept); in a
 *    replaced month (a forced re-import, a fuller cartola, the rebuild), also a cartola row no
 *    movement keeps, into the kept row of its bank day and signed pesos — the one whose text reads
 *    as its own when several could take it (what the user filed on it moves, the earlier arrival's
 *    assignments winning);
 *  - `unfoldable`: such a row with filed work and no kept row to fold into, or several it could be:
 *    the import is refused naming it;
 *  - `remove`: a daily row a transfer leg or a mail row already represents, or (a replaced month) a
 *    cartola row the new cartola no longer lists;
 *  - `ambiguous`: several retired flows for one document (left alone);
 *  - `left_alone`: a replaced month's cartola row the new cartola no longer lists that a tax
 *    settlement or a payslip names (`named_by`): it stays, reported (a row folded or removed for a
 *    row that records its money hands its payslip and settlements to that row instead).
 *
 * The matchers: `pickTransferLegForBankRow`, `pickTransferNoticeMovementForBankRow`,
 * `checkingMovementContentMatches`. Daily rows pair one to one with movements (the Nth identical
 * daily row with the Nth identical movement). A row's listing facts (bank day, amount,
 * description, document, cartola month) come in structured (`CheckingListedFacts`); nothing here
 * reads a note.
 */
import { cartolaText } from "nw-tracker-contracts";
import type { ParsedCheckingMovement } from "./checkingCartolaParse.js";
import { checkingMovementContentMatches, normalizeForPartialMatch } from "./checkingCartolaPartialReconcile.js";
import { pickTransferLegForBankRow, type TransferLegCandidate } from "./checkingTransferLegReconcile.js";
import { pickTransferNoticeMovementForBankRow, type TransferNoticeCandidate } from "./transferNoticeMovements.js";
import type { FlowArrival } from "./flows/flowFirstSeen.js";
import { compareArrival } from "./flows/flowFirstSeen.js";

import type { CheckingListedFacts } from "./movementListingFacts.js";

export type { CheckingListedFacts };

/** A row on file of the account, as the planner reads it. */
export type CheckingFileRow = {
  id: number;
  /** `flow_evidence.source_kind`. */
  kind: string;
  /** `flow_evidence.document_key` (a bank document row's identity). */
  document_key: string | null;
  /** The bank's posting day on the account (`movement_bank_postings`, else `occurred_on`). */
  bank_posted_on: string;
  occurred_on: string;
  amount_clp: number;
  /** Its listing's facts (cartola and daily-listing rows; `checkingCartolaPlanLoad.ts`'s adapter). */
  listed: CheckingListedFacts | null;
  arrival: FlowArrival;
  /**
   * Records that name the row by id and do not let it be deleted (a tax settlement; a payslip,
   * which only a fold moves to the kept row): such a row is never removed or folded away.
   */
  named_by?: readonly string[];
  /** Its flow holds what the user filed (a category, note, big group, pieces, a link: `flowHoldsAssignments`). */
  filed?: boolean;
};

/** The tables whose rows stop a movement's delete (`ON DELETE RESTRICT`, a payslip's plain reference). */
export const MOVEMENT_DELETE_BLOCKERS = ["f22_settlements", "us_f1040_settlements", "payroll_work_earnings"] as const;

/** One cartola movement with the identity the import writes it under. */
export type CheckingCartolaMovement = ParsedCheckingMovement & {
  index: number;
  /** The row's document key (`movementNote`). */
  document_key: string;
  /** Its facts as the row will list them once written. */
  listed: CheckingListedFacts;
};

export type CheckingCartolaPlanInput = {
  account_id: number;
  period_month: string;
  movements: CheckingCartolaMovement[];
  rows: CheckingFileRow[];
  transfer_legs: TransferLegCandidate[];
  mail_notices: TransferNoticeCandidate[];
  /** `priorChileBusinessDayYmd(day) ?? day`, for each movement day. */
  window_start: Record<string, string>;
  /** Retired flows of the account by the document key they were retired with. */
  retired_flows: Record<string, number[]>;
  /**
   * The month is imported again from a corrected or fuller cartola: its cartola rows on file that no
   * movement keeps are removed, and the kept ones are restated by their movement.
   */
  replace_month?: boolean;
};

export type CheckingKeepReason = "document_key" | "already_present" | "same_day_amount" | "daily_listing";

export type CheckingCartolaPlan = {
  keep: { row_id: number; movement: number; why: CheckingKeepReason; redate: { occurred_on: string; bank_day: string } | null }[];
  confirm: { row_id: number; movement: number; why: "transfer_leg" | "mail_notice" }[];
  insert: { movement: number; retired_flow_id: number | null }[];
  fold: { row_id: number; into_row_id: number; movement: number; why: "daily_listing" | "replaced_cartola_row" }[];
  /** `movement` -1: a cartola row of a replaced month no movement of the new cartola keeps. */
  remove: { row_id: number; movement: number; why: "listed_by_transfer_leg" | "listed_by_mail" | "replaced_cartola_row" }[];
  ambiguous: { what: string; movement: number; flow_ids: number[] }[];
  /**
   * A replaced month's cartola row no movement keeps that a record names (`named_by`): left as it
   * is and reported (the import refuses a month that leaves a tax settlement's row behind). Rows
   * folded or removed for a row that records their money are never held: their payslip and tax
   * settlements move to it (`repointMovementReferences`).
   */
  left_alone: { row_id: number; movement: number; why: "listed_by_transfer_leg" | "listed_by_mail" | "replaced_cartola_row" | "folded"; tables: string[] }[];
  /**
   * A replaced month's cartola rows with filed work and no kept row of their bank day and pesos to
   * fold into (`candidates` empty), or several that read alike to them (the candidates' row ids).
   */
  unfoldable: { row_id: number; bank_day: string; amount_clp: number; candidates: number[] }[];
};

/** Plans one cartola month's import (see the module doc). */
export function planCheckingCartola(input: CheckingCartolaPlanInput): CheckingCartolaPlan {
  const plan: CheckingCartolaPlan = { keep: [], confirm: [], insert: [], fold: [], remove: [], ambiguous: [], left_alone: [], unfoldable: [] };
  // A row whose money another row records after the import (a fold, a daily row a leg or a mail
  // row lists): its payslip and its tax settlements move to that row (`repointMovementReferences`),
  // so they do not hold it. A replaced month's cartola row has no such row: they hold it.
  const holders = (rowId: number, referencesMove: boolean): string[] =>
    [...(input.rows.find((r) => r.id === rowId)?.named_by ?? [])].filter((t) => !referencesMove);
  const consumedLegs = new Set<number>();
  const legs = input.transfer_legs.map((l) => ({ ...l }));
  const consumedMail = new Set<number>();
  /** The month's cartola rows on file. */
  const cartolaRows = input.rows
    .filter((r) => r.kind === "cartola")
    .map((r) => ({ id: r.id, document_key: r.document_key, bank_day: r.bank_posted_on, amount_clp: r.amount_clp, listed: r.listed }));
  const outcomeOf = new Map<number, { kind: "new"; retiredFlowId: number | null } | { kind: "row"; id: number; why: CheckingKeepReason }>();
  const viaLegOrMail = new Map<number, "transfer_leg" | "mail_notice">();

  // The month's cartola rows on file pair one to one with the movements, each pass over every
  // movement before the next, looser one (a loose match must never take a row another movement
  // matches exactly): by document key, then by the same printed figures, then by the tolerant
  // content match the daily rows pair with (`checkingMovementContentMatches`: case, truncation,
  // marks) — another rendering of the month.
  const claimedRows = new Set<number>();
  const monthRow = (r: (typeof cartolaRows)[number]) => !claimedRows.has(r.id) && r.listed?.period_month === input.period_month;
  const rowOf = new Map<number, { id: number; why: CheckingKeepReason }>();
  const pass = (why: CheckingKeepReason, pick: (mv: CheckingCartolaMovement) => { id: number } | undefined) => {
    for (const mv of input.movements) {
      if (rowOf.has(mv.index)) continue;
      const hit = pick(mv);
      if (!hit) continue;
      claimedRows.add(hit.id);
      rowOf.set(mv.index, { id: hit.id, why });
    }
  };
  pass("document_key", (mv) => input.rows.find((r) => r.document_key === mv.document_key && !claimedRows.has(r.id)));
  pass("already_present", (mv) =>
    cartolaRows.find(
      (r) =>
        monthRow(r) &&
        r.bank_day === mv.occurred_on &&
        r.amount_clp === mv.amount_clp &&
        r.listed!.description === mv.description.trim() &&
        r.listed!.document_no === String(mv.document_no ?? "").trim()
    )
  );
  // The same cells read by an older reader (a month stored before both readers shared one reading,
  // re-read now): the description in the shared reading (`cartolaText`: spaces, accent damage),
  // the SUCURSAL cell the old PDF reader left at its start set aside, and the document number
  // wherever it put it — the same characters, in any order (it glued a number to a word).
  // Words, not characters (a number's digits are one word): the description's words and the
  // document number, which an old reader may have glued to a word or taken off the description's start.
  const cellWords = (description: string, documentNo: string) => [...description.split(" ").filter(Boolean), ...(documentNo ? [documentNo] : [])].sort().join(" ");
  const olderReading = (mv: CheckingCartolaMovement, listed: CheckingListedFacts) => {
    const description = cartolaText(listed.description);
    const branchFirst = mv.branch ? `${cartolaText(mv.branch)} ` : null;
    let own = branchFirst != null && description.startsWith(branchFirst) ? description.slice(branchFirst.length) : description;
    const newDoc = String(mv.document_no ?? "").trim();
    let oldDoc = listed.document_no;
    // The document number glued to a word of the old description (it printed none apart).
    if (!oldDoc && newDoc && !own.split(" ").includes(newDoc) && own.includes(newDoc)) {
      own = own.replace(newDoc, " ").replace(/\s+/g, " ").trim();
      oldDoc = newDoc;
    }
    return cellWords(own, oldDoc) === cellWords(mv.description, newDoc);
  };

  // A movement a daily row also lists is left to the daily row (a copy written beside it is the
  // rebuild's to fold into it, with what was filed on the copy).
  const listedDaily = (mv: CheckingCartolaMovement) =>
    input.rows.some(
      (r) =>
        r.kind === "daily_listing" &&
        r.listed != null &&
        checkingMovementContentMatches(mv, { occurred_on: r.listed.bank_day, amount_clp: r.listed.amount_clp, description: r.listed.description, document_no: r.listed.document_no })
    );
  pass("already_present", (mv) =>
    listedDaily(mv) ? undefined : cartolaRows.find((r) => monthRow(r) && r.bank_day === mv.occurred_on && r.amount_clp === mv.amount_clp && olderReading(mv, r.listed!))
  );
  pass("already_present", (mv) =>
    cartolaRows.find(
      (r) =>
        monthRow(r) &&
        checkingMovementContentMatches(mv, {
          occurred_on: r.bank_day,
          amount_clp: r.amount_clp,
          description: r.listed!.description,
          document_no: r.listed!.document_no,
        })
    )
  );
  for (const mv of input.movements) {
    const onFile = rowOf.get(mv.index);
    if (onFile) {
      outcomeOf.set(mv.index, { kind: "row", id: onFile.id, why: onFile.why });
      continue;
    }
    const windowStart = input.window_start[mv.occurred_on] ?? mv.occurred_on;
    const leg = pickTransferLegForBankRow(legs, mv.occurred_on, windowStart, mv.amount_clp, consumedLegs);
    if (leg != null) {
      consumedLegs.add(leg);
      // The claim records the bank's day as the leg's posting (later rows match it only that day).
      const l = legs.find((x) => x.id === leg)!;
      l.posted_on = mv.occurred_on;
      plan.confirm.push({ row_id: leg, movement: mv.index, why: "transfer_leg" });
      viaLegOrMail.set(mv.index, "transfer_leg");
      continue;
    }
    const mail = pickTransferNoticeMovementForBankRow(input.mail_notices, mv.occurred_on, windowStart, mv.amount_clp, consumedMail);
    if (mail != null) {
      consumedMail.add(mail);
      plan.confirm.push({ row_id: mail, movement: mv.index, why: "mail_notice" });
      viaLegOrMail.set(mv.index, "mail_notice");
      continue;
    }
    const retired = input.retired_flows[mv.document_key] ?? [];
    if (retired.length > 1) plan.ambiguous.push({ what: "several retired flows of this document (left alone)", movement: mv.index, flow_ids: retired });
    outcomeOf.set(mv.index, { kind: "new", retiredFlowId: retired.length === 1 ? retired[0]! : null });
  }

  // The daily rows the cartola lists: each is restated as its movement's cartola row.
  const rowById = new Map(input.rows.map((r) => [r.id, r]));
  const dailies = input.rows.filter((r) => r.kind === "daily_listing" && r.listed != null).sort((a, b) => a.id - b.id);
  const contentMatches = (m: CheckingCartolaMovement, listed: CheckingListedFacts): boolean =>
    checkingMovementContentMatches(m, {
      occurred_on: listed.bank_day,
      amount_clp: listed.amount_clp,
      description: listed.description,
      document_no: listed.document_no,
    });

  // One to one: the Nth daily row of a movement's content takes the Nth such movement
  // (the occurrence rule of the card side's `#dupN`), whose own row it restates.
  const claimedMovements = new Set<number>();
  const plannedInto = new Map<number, number[]>();
  const plannedRemoved: CheckingCartolaPlan["remove"] = [];
  // Each pass over every daily row before the next, looser one: the same text (case and marks
  // aside), then the tolerant match; a row every movement it matches is taken by (a pending row
  // re-listed under longer text, a listing that printed it twice) goes to the first of them, so
  // several rows on file for one movement keep the earliest seen and fold the others into it.
  const sameText = (m: CheckingCartolaMovement, listed: CheckingListedFacts) =>
    contentMatches(m, listed) && normalizeForPartialMatch(m.description) === normalizeForPartialMatch(listed.description);
  const dailyMovement = new Map<number, CheckingCartolaMovement>();
  for (const loose of [false, true]) {
    for (const daily of dailies) {
      if (dailyMovement.has(daily.id)) continue;
      const mv = input.movements.find((m) => !claimedMovements.has(m.index) && (loose ? contentMatches(m, daily.listed!) : sameText(m, daily.listed!)));
      if (!mv) continue;
      claimedMovements.add(mv.index);
      dailyMovement.set(daily.id, mv);
    }
  }
  for (const daily of dailies) {
    const listed = daily.listed!;
    const mv = dailyMovement.get(daily.id) ?? input.movements.find((m) => contentMatches(m, listed));
    if (!mv) continue;
    const via = viaLegOrMail.get(mv.index);
    if (via) {
      const why = via === "transfer_leg" ? "listed_by_transfer_leg" : "listed_by_mail";
      const tables = holders(daily.id, true);
      if (tables.length > 0) plan.left_alone.push({ row_id: daily.id, movement: mv.index, why, tables });
      else plannedRemoved.push({ row_id: daily.id, movement: mv.index, why });
      continue;
    }
    plannedInto.set(mv.index, [...(plannedInto.get(mv.index) ?? []), daily.id]);
  }

  // Assemble: per movement, the rows on file that end on its row.
  // The kept row is the earliest seen, unless a row a record holds must stay (a fold deletes the
  // others; the earliest arrival's assignments still win, `foldMovementInto`).
  const held = (id: number) => (holders(id, true).length > 0 ? 0 : 1);
  const earliest = (ids: number[]): number[] =>
    [...ids].sort((a, b) => held(a) - held(b) || compareArrival(rowById.get(a)!.arrival, rowById.get(b)!.arrival) || a - b);
  const redateOf = (rowId: number): { occurred_on: string; bank_day: string } | null => {
    const r = rowById.get(rowId);
    return r?.kind === "daily_listing" && r.listed && r.occurred_on !== r.listed.bank_day
      ? { occurred_on: r.occurred_on, bank_day: r.listed.bank_day }
      : null;
  };
  for (const mv of input.movements) {
    const o = outcomeOf.get(mv.index);
    if (!o) continue;
    const planned = plannedInto.get(mv.index) ?? [];
    if (o.kind === "new" && planned.length === 0) {
      plan.insert.push({ movement: mv.index, retired_flow_id: o.retiredFlowId });
      continue;
    }
    const members = earliest(o.kind === "row" ? [o.id, ...planned] : planned);
    const kept = members[0]!;
    const why = o.kind === "row" && kept === o.id ? o.why : "daily_listing";
    plan.keep.push({ row_id: kept, movement: mv.index, why, redate: redateOf(kept) });
    for (const d of members.slice(1)) {
      const tables = holders(d, true);
      if (tables.length > 0) plan.left_alone.push({ row_id: d, movement: mv.index, why: "folded", tables });
      else plan.fold.push({ row_id: d, into_row_id: kept, movement: mv.index, why: "daily_listing" });
    }
  }
  plan.remove.push(...plannedRemoved);
  if (input.replace_month) {
    const held = new Set([...plan.keep.map((k) => k.row_id), ...plan.fold.map((f) => f.row_id)]);
    const leftOver = input.rows.filter((r) => r.kind === "cartola" && r.listed?.period_month === input.period_month && !held.has(r.id));
    // A row the new cartola prints so differently that no pass took it (a reworded or shortened
    // description): when it is the only row left over of its bank day and signed pesos and the
    // movement to be written of that day and pesos is the only one too, it is that movement,
    // restated in place. So are N twins: N rows left over of one bank day and pesos that read alike
    // and N movements to be written of it that read alike (identical rows are interchangeable), in
    // order. Anything else of the day stays as it was planned (removed, written).
    const dayAmount = (day: string, amount: number) => `${day}|${amount}`;
    const insertable = plan.insert.filter((i) => i.retired_flow_id == null);
    const movementOf = new Map(input.movements.map((m) => [m.index, m]));
    const groups = new Map<string, { rows: CheckingFileRow[]; inserts: CheckingCartolaPlan["insert"] }>();
    const group = (k: string) => groups.get(k) ?? groups.set(k, { rows: [], inserts: [] }).get(k)!;
    for (const r of leftOver) group(dayAmount(r.bank_posted_on, r.amount_clp)).rows.push(r);
    for (const i of insertable) {
      const m = movementOf.get(i.movement)!;
      group(dayAmount(m.occurred_on, m.amount_clp)).inserts.push(i);
    }
    const restated = new Set<number>();
    const alike = <T,>(xs: readonly T[], text: (x: T) => string) => xs.every((x) => text(x) === text(xs[0]!));
    for (const { rows, inserts } of groups.values()) {
      if (rows.length === 0 || rows.length !== inserts.length) continue;
      const twins =
        rows.length === 1 ||
        (alike(rows, (r) => `${r.listed!.description}|${r.listed!.document_no}`) &&
          alike(inserts, (i) => {
            const m = movementOf.get(i.movement)!;
            return `${m.description}|${m.document_no}`;
          }));
      if (!twins) continue;
      const byId = [...rows].sort((a, b) => a.id - b.id);
      const byIndex = [...inserts].sort((a, b) => a.movement - b.movement);
      byId.forEach((row, k) => {
        plan.keep.push({ row_id: row.id, movement: byIndex[k]!.movement, why: "same_day_amount", redate: null });
        plan.insert.splice(plan.insert.indexOf(byIndex[k]!), 1);
        restated.add(row.id);
      });
    }
    // A row left over is the copy of a movement a kept row already records when that row is of its
    // bank day and signed pesos: it folds into it, so what the user filed on it is not left on a
    // retired flow. One to one; among several such kept rows the one whose movement reads as the
    // copy (its cells in the shared reading, `olderReading`), else, for a copy with nothing filed,
    // the lowest row id (any is right); a copy with filed work and several candidates is refused.
    const foldTargets = new Map<string, { row_id: number; movement: CheckingCartolaMovement }[]>();
    for (const k of plan.keep) {
      if (restated.has(k.row_id)) continue;
      const m = movementOf.get(k.movement)!;
      const key = dayAmount(m.occurred_on, m.amount_clp);
      foldTargets.set(key, [...(foldTargets.get(key) ?? []), { row_id: k.row_id, movement: m }]);
    }
    for (const list of foldTargets.values()) list.sort((x, y) => x.row_id - y.row_id);
    for (const r of [...leftOver].sort((a, b) => a.id - b.id)) {
      if (restated.has(r.id)) continue;
      const candidates = foldTargets.get(dayAmount(r.bank_posted_on, r.amount_clp)) ?? [];
      const reading = candidates.filter((c) => olderReading(c.movement, r.listed!));
      const into = candidates.length === 1 ? candidates[0] : reading.length === 1 ? reading[0] : !r.filed ? candidates[0] : undefined;
      if (into) {
        candidates.splice(candidates.indexOf(into), 1);
        plan.fold.push({ row_id: r.id, into_row_id: into.row_id, movement: into.movement.index, why: "replaced_cartola_row" });
        continue;
      }
      if (r.filed) {
        plan.unfoldable.push({ row_id: r.id, bank_day: r.bank_posted_on, amount_clp: r.amount_clp, candidates: candidates.map((c) => c.row_id) });
        continue;
      }
      const tables = holders(r.id, false);
      if (tables.length > 0) plan.left_alone.push({ row_id: r.id, movement: -1, why: "replaced_cartola_row", tables });
      else plan.remove.push({ row_id: r.id, movement: -1, why: "replaced_cartola_row" });
    }
  }
  return plan;
}
