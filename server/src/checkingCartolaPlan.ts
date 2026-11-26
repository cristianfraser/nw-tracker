/**
 * The cartola planner (pure): a parsed cartola month against the checking account's rows on file,
 * before anything is written — what `importCheckingCartola` and its daily-row reconcile
 * (`prunePartialMovementsSupersededByCartola`) end with, as row outcomes:
 *
 *  - `keep`: a row on file and the cartola movement that restates it — the cartola row already
 *    imported (its document key, or the same bank day, amount, description and document in the
 *    month), or the daily-listing row the cartola movement lists (its flow passes to the cartola
 *    row today), with the receipt-corrected day it carries (`redate`);
 *  - `confirm`: a transfer leg or a mail-written movement the cartola movement confirms (the row
 *    stays as it is; only its bank posting / confirmation is recorded);
 *  - `insert`: a cartola movement no row on file is (taking back a retired flow of its document
 *    when exactly one is on file);
 *  - `fold`: a daily row that is the same movement as a kept row;
 *  - `remove`: a daily row today deletes with nothing taking its flow;
 *  - `ambiguous`: several retired flows for one document (left alone today).
 *
 * The matching is today's, in today's order, through its predicates (`cartolaMovementDedupeKey`,
 * `pickTransferLegForBankRow`, `pickTransferNoticeMovementForBankRow`,
 * `checkingMovementContentMatches`). A row's listing facts (bank day, amount, description, document)
 * come in structured (`CheckingListedFacts`); nothing here reads a note. The plan departs from today
 * in one declared way (`today: "differs"`): of several rows of one movement the earliest seen is the
 * kept one, where today the last daily row adopted keeps its flow.
 */
import { cartolaMovementDedupeKey, type ParsedCheckingMovement } from "./checkingCartolaParse.js";
import { checkingMovementContentMatches } from "./checkingCartolaPartialReconcile.js";
import { pickTransferLegForBankRow, type TransferLegCandidate } from "./checkingTransferLegReconcile.js";
import { pickTransferNoticeMovementForBankRow, type TransferNoticeCandidate } from "./transferNoticeMovements.js";
import type { FlowArrival } from "./flows/flowFirstSeen.js";
import { compareArrival } from "./cards/statementLinePlan.js";

/** What a bank listing says about a row it wrote (the cartola's or the daily listing's). */
export type CheckingListedFacts = {
  bank_day: string;
  amount_clp: number;
  description: string;
  document_no: string;
  /** The cartola month a cartola row was written from (null for a daily-listing row). */
  period_month: string | null;
};

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
};

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
};

export type CheckingKeepReason = "document_key" | "already_present" | "daily_listing";

export type CheckingCartolaPlan = {
  keep: { row_id: number; movement: number; why: CheckingKeepReason; redate: { occurred_on: string; bank_day: string } | null; today: "same" | "differs" }[];
  confirm: { row_id: number; movement: number; why: "transfer_leg" | "mail_notice" }[];
  insert: { movement: number; retired_flow_id: number | null }[];
  fold: { row_id: number; into_row_id: number | null; movement: number; why: "daily_listing"; today: "same" | "differs" }[];
  remove: { row_id: number; movement: number; why: "cartola_row_not_found" | "listed_by_transfer_leg" | "listed_by_mail" }[];
  ambiguous: { what: string; movement: number; flow_ids: number[] }[];
  /** Today's end state, for the comparison report. */
  today: CheckingTodayEndState;
};

export type CheckingTodayEndState = {
  /** Each movement: the row it ends on — a new row and whose flow it carries, or a row on file. */
  movements: {
    movement: number;
    outcome:
      | { row: "new"; flow_of: { row_id: number } | { retired_flow_id: number } | null; occurred_on: string }
      | { row_on_file: number; why: CheckingKeepReason | "transfer_leg" | "mail_notice" };
  }[];
  /** Daily rows the reconcile deletes: whose flow survives where. */
  daily_rows: { row_id: number; fate: "on_cartola_row" | "merged" | "gone" }[];
};

/** Plans one cartola month's import (see the module doc). */
export function planCheckingCartola(input: CheckingCartolaPlanInput): CheckingCartolaPlan {
  const plan: CheckingCartolaPlan = { keep: [], confirm: [], insert: [], fold: [], remove: [], ambiguous: [], today: { movements: [], daily_rows: [] } };
  const consumedLegs = new Set<number>();
  const legs = input.transfer_legs.map((l) => ({ ...l }));
  const consumedMail = new Set<number>();
  /** Cartola rows once the movements are written: those on file and the new ones (virtual ids). */
  type CartolaRow = {
    id: number;
    document_key: string | null;
    bank_day: string;
    occurred_on: string;
    amount_clp: number;
    listed: CheckingListedFacts | null;
    movement: number | null;
  };
  const cartolaRows: CartolaRow[] = input.rows
    .filter((r) => r.kind === "cartola")
    .map((r) => ({
      id: r.id,
      document_key: r.document_key,
      bank_day: r.bank_posted_on,
      occurred_on: r.occurred_on,
      amount_clp: r.amount_clp,
      listed: r.listed,
      movement: null,
    }));
  const outcomeOf = new Map<number, { kind: "new"; vid: number } | { kind: "row"; id: number; why: CheckingKeepReason }>();
  const viaLegOrMail = new Map<number, "transfer_leg" | "mail_notice">();
  let nextId = Math.max(0, ...input.rows.map((r) => r.id)) + 1;
  const flowOfNew = new Map<number, { row_id: number } | { retired_flow_id: number } | null>();

  for (const mv of input.movements) {
    const byKey = input.rows.find((r) => r.document_key === mv.document_key);
    if (byKey) {
      outcomeOf.set(mv.index, { kind: "row", id: byKey.id, why: "document_key" });
      continue;
    }
    const sameKeyIndex = input.movements
      .slice(0, mv.index)
      .filter((prior) => cartolaMovementDedupeKey(prior) === cartolaMovementDedupeKey(mv)).length;
    const present = cartolaRows.filter(
      (r) =>
        r.listed?.period_month === input.period_month &&
        r.bank_day === mv.occurred_on &&
        r.amount_clp === mv.amount_clp &&
        r.listed.description === mv.description.trim() &&
        r.listed.document_no === String(mv.document_no ?? "").trim()
    );
    if (present.length >= sameKeyIndex + 1) {
      outcomeOf.set(mv.index, { kind: "row", id: present[sameKeyIndex]!.id, why: "already_present" });
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
      plan.today.movements.push({ movement: mv.index, outcome: { row_on_file: leg, why: "transfer_leg" } });
      continue;
    }
    const mail = pickTransferNoticeMovementForBankRow(input.mail_notices, mv.occurred_on, windowStart, mv.amount_clp, consumedMail);
    if (mail != null) {
      consumedMail.add(mail);
      plan.confirm.push({ row_id: mail, movement: mv.index, why: "mail_notice" });
      viaLegOrMail.set(mv.index, "mail_notice");
      plan.today.movements.push({ movement: mv.index, outcome: { row_on_file: mail, why: "mail_notice" } });
      continue;
    }
    const vid = nextId++;
    cartolaRows.push({
      id: vid,
      document_key: mv.document_key,
      bank_day: mv.occurred_on,
      occurred_on: mv.occurred_on,
      amount_clp: mv.amount_clp,
      listed: mv.listed,
      movement: mv.index,
    });
    outcomeOf.set(mv.index, { kind: "new", vid });
    const retired = input.retired_flows[mv.document_key] ?? [];
    if (retired.length > 1) plan.ambiguous.push({ what: "several retired flows of this document (left alone)", movement: mv.index, flow_ids: retired });
    flowOfNew.set(vid, retired.length === 1 ? { retired_flow_id: retired[0]! } : null);
  }

  // The daily rows the cartola lists: each takes the cartola row's place (its flow survives there).
  const rowById = new Map(input.rows.map((r) => [r.id, r]));
  const cartolaRowById = new Map(cartolaRows.map((r) => [r.id, r]));
  const adoptedInto = new Map<number, number[]>();
  const redates = new Map<number, { occurred_on: string; bank_day: string }>();
  const removed: { row_id: number; movement: number; why: CheckingCartolaPlan["remove"][number]["why"] }[] = [];
  for (const daily of input.rows.filter((r) => r.kind === "daily_listing").sort((a, b) => a.id - b.id)) {
    const listed = daily.listed;
    if (!listed) continue;
    const mv = input.movements.find((m) =>
      checkingMovementContentMatches(m, { occurred_on: listed.bank_day, amount_clp: listed.amount_clp, description: listed.description, document_no: listed.document_no })
    );
    if (!mv) continue;
    const official = cartolaRows.find(
      (r) =>
        r.bank_day === mv.occurred_on &&
        r.listed != null &&
        r.listed.period_month != null &&
        r.amount_clp === mv.amount_clp &&
        r.listed.description === mv.description.trim() &&
        r.listed.document_no === String(mv.document_no ?? "").trim()
    );
    const target = official
      ? cartolaRows.find((r) => r.document_key === official.document_key && r.occurred_on === mv.occurred_on)
      : undefined;
    if (!target) {
      const via = viaLegOrMail.get(mv.index);
      removed.push({ row_id: daily.id, movement: mv.index, why: via === "transfer_leg" ? "listed_by_transfer_leg" : via === "mail_notice" ? "listed_by_mail" : "cartola_row_not_found" });
      continue;
    }
    if (daily.occurred_on !== listed.bank_day) {
      redates.set(target.id, { occurred_on: daily.occurred_on, bank_day: mv.occurred_on });
      target.occurred_on = daily.occurred_on;
    }
    adoptedInto.set(target.id, [...(adoptedInto.get(target.id) ?? []), daily.id]);
  }

  // Assemble: per movement, the rows on file that end on its row.
  const earliest = (ids: number[]): number[] =>
    [...ids].sort((a, b) => compareArrival(rowById.get(a)!.arrival, rowById.get(b)!.arrival) || a - b);
  for (const mv of input.movements) {
    const o = outcomeOf.get(mv.index);
    if (!o) continue;
    if (o.kind === "row") {
      const dailies = adoptedInto.get(o.id) ?? [];
      plan.today.movements.push({ movement: mv.index, outcome: { row_on_file: o.id, why: o.why } });
      const members = earliest([o.id, ...dailies]);
      const kept = members[0]!;
      // Today the row on file stays and the last daily row adopted keeps its flow there.
      const todaySurvivor = dailies.length > 0 ? dailies[dailies.length - 1]! : o.id;
      plan.keep.push({ row_id: kept, movement: mv.index, why: kept === o.id ? o.why : "daily_listing", redate: redates.get(o.id) ?? null, today: kept === todaySurvivor ? "same" : "differs" });
      for (const d of members.slice(1)) plan.fold.push({ row_id: d, into_row_id: kept, movement: mv.index, why: "daily_listing", today: kept === todaySurvivor ? "same" : "differs" });
      continue;
    }
    const dailies = adoptedInto.get(o.vid) ?? [];
    const retired = flowOfNew.get(o.vid) ?? null;
    const todayFlow = dailies.length > 0 ? { row_id: dailies[dailies.length - 1]! } : retired;
    plan.today.movements.push({
      movement: mv.index,
      outcome: { row: "new", flow_of: todayFlow, occurred_on: cartolaRowById.get(o.vid)!.occurred_on },
    });
    if (dailies.length === 0) {
      plan.insert.push({ movement: mv.index, retired_flow_id: retired && "retired_flow_id" in retired ? retired.retired_flow_id : null });
      continue;
    }
    const members = earliest(dailies);
    const kept = members[0]!;
    const survivor = dailies[dailies.length - 1]!;
    plan.keep.push({ row_id: kept, movement: mv.index, why: "daily_listing", redate: redates.get(o.vid) ?? null, today: kept === survivor ? "same" : "differs" });
    for (const d of members.slice(1)) plan.fold.push({ row_id: d, into_row_id: kept, movement: mv.index, why: "daily_listing", today: kept === survivor ? "same" : "differs" });
  }
  for (const dailies of adoptedInto.values()) {
    dailies.forEach((d, i) => plan.today.daily_rows.push({ row_id: d, fate: i === dailies.length - 1 ? "on_cartola_row" : "merged" }));
  }
  for (const r of removed) {
    plan.remove.push(r);
    plan.today.daily_rows.push({ row_id: r.row_id, fate: "gone" });
  }
  return plan;
}
