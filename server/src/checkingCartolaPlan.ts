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
 * The matching is today's, in today's order, through its predicates (
 * `pickTransferLegForBankRow`, `pickTransferNoticeMovementForBankRow`,
 * `checkingMovementContentMatches`). A row's listing facts (bank day, amount, description, document)
 * come in structured (`CheckingListedFacts`); nothing here reads a note. The plan departs from today
 * in two declared ways (`today: "differs"`): of several rows of one movement the earliest seen is the
 * kept one, where today the last daily row adopted keeps its flow; and daily rows pair one-to-one
 * with movements (the Nth identical daily row with the Nth identical movement), where today every
 * identical daily row takes the first such movement — both twins' flows end on its row and the
 * second movement's row starts a new flow.
 */
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
  /**
   * The month is imported again from a corrected or fuller cartola: its cartola rows on file that no
   * movement keeps are removed, and the kept ones are restated by their movement.
   */
  replace_month?: boolean;
};

export type CheckingKeepReason = "document_key" | "already_present" | "daily_listing";

export type CheckingCartolaPlan = {
  keep: { row_id: number; movement: number; why: CheckingKeepReason; redate: { occurred_on: string; bank_day: string } | null; today: "same" | "differs" }[];
  confirm: { row_id: number; movement: number; why: "transfer_leg" | "mail_notice" }[];
  insert: { movement: number; retired_flow_id: number | null; today: "same" | "differs" }[];
  fold: { row_id: number; into_row_id: number | null; movement: number; why: "daily_listing"; today: "same" | "differs" }[];
  /** `movement` -1: a cartola row of a replaced month no movement of the new cartola keeps. */
  remove: { row_id: number; movement: number; why: "cartola_row_not_found" | "listed_by_transfer_leg" | "listed_by_mail" | "replaced_cartola_row" }[];
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

  // The month's cartola rows on file pair one to one with the movements, each pass over every
  // movement before the next, looser one (a loose match must never take a row another movement
  // matches exactly): by document key, then by the same printed figures, then by the tolerant
  // content match the daily rows pair with (`checkingMovementContentMatches`: case, truncation,
  // marks) — another rendering of the month.
  const claimedRows = new Set<number>();
  const monthRow = (r: CartolaRow) => r.movement == null && !claimedRows.has(r.id) && r.listed?.period_month === input.period_month;
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
  const dailies = input.rows.filter((r) => r.kind === "daily_listing" && r.listed != null).sort((a, b) => a.id - b.id);
  const contentMatches = (m: CheckingCartolaMovement, listed: CheckingListedFacts): boolean =>
    checkingMovementContentMatches(m, {
      occurred_on: listed.bank_day,
      amount_clp: listed.amount_clp,
      description: listed.description,
      document_no: listed.document_no,
    });
  const removeWhyOf = (mvIndex: number): CheckingCartolaPlan["remove"][number]["why"] => {
    const via = viaLegOrMail.get(mvIndex);
    return via === "transfer_leg" ? "listed_by_transfer_leg" : via === "mail_notice" ? "listed_by_mail" : "cartola_row_not_found";
  };

  // Today (`prunePartialMovementsSupersededByCartola`): each daily row takes the FIRST movement whose
  // content matches — never claimed, so identical twins both take the first — and the first cartola
  // row of that movement's figures, on that movement's day.
  for (const daily of dailies) {
    const listed = daily.listed!;
    const mv = input.movements.find((m) => contentMatches(m, listed));
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
      removed.push({ row_id: daily.id, movement: mv.index, why: removeWhyOf(mv.index) });
      continue;
    }
    if (daily.occurred_on !== listed.bank_day) {
      redates.set(target.id, { occurred_on: daily.occurred_on, bank_day: mv.occurred_on });
      target.occurred_on = daily.occurred_on;
    }
    adoptedInto.set(target.id, [...(adoptedInto.get(target.id) ?? []), daily.id]);
  }

  // The plan: one-to-one — the Nth daily row of a movement's content takes the Nth such movement
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
    if (viaLegOrMail.has(mv.index)) {
      plannedRemoved.push({ row_id: daily.id, movement: mv.index, why: removeWhyOf(mv.index) });
      continue;
    }
    plannedInto.set(mv.index, [...(plannedInto.get(mv.index) ?? []), daily.id]);
  }

  // Assemble: per movement, the rows on file that end on its row.
  const earliest = (ids: number[]): number[] =>
    [...ids].sort((a, b) => compareArrival(rowById.get(a)!.arrival, rowById.get(b)!.arrival) || a - b);
  const sameMembers = (a: number[], b: number[]): boolean => a.length === b.length && a.every((x) => b.includes(x));
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
    if (o.kind === "row") {
      const todayDailies = adoptedInto.get(o.id) ?? [];
      plan.today.movements.push({ movement: mv.index, outcome: { row_on_file: o.id, why: o.why } });
      const members = earliest([o.id, ...planned]);
      const kept = members[0]!;
      // Today the row on file stays and the last daily row adopted keeps its flow there.
      const todaySurvivor = todayDailies.length > 0 ? todayDailies[todayDailies.length - 1]! : o.id;
      const same = sameMembers(members, [o.id, ...todayDailies]) && kept === todaySurvivor ? "same" : "differs";
      plan.keep.push({ row_id: kept, movement: mv.index, why: kept === o.id ? o.why : "daily_listing", redate: redateOf(kept), today: same });
      for (const d of members.slice(1)) plan.fold.push({ row_id: d, into_row_id: kept, movement: mv.index, why: "daily_listing", today: same });
      continue;
    }
    const todayDailies = adoptedInto.get(o.vid) ?? [];
    const retired = flowOfNew.get(o.vid) ?? null;
    const todayFlow = todayDailies.length > 0 ? { row_id: todayDailies[todayDailies.length - 1]! } : retired;
    plan.today.movements.push({
      movement: mv.index,
      outcome: { row: "new", flow_of: todayFlow, occurred_on: cartolaRowById.get(o.vid)!.occurred_on },
    });
    if (planned.length === 0) {
      plan.insert.push({
        movement: mv.index,
        retired_flow_id: retired && "retired_flow_id" in retired ? retired.retired_flow_id : null,
        today: todayDailies.length === 0 ? "same" : "differs",
      });
      continue;
    }
    const members = earliest(planned);
    const kept = members[0]!;
    const survivor = todayDailies[todayDailies.length - 1];
    const same = sameMembers(members, todayDailies) && kept === survivor ? "same" : "differs";
    plan.keep.push({ row_id: kept, movement: mv.index, why: "daily_listing", redate: redateOf(kept), today: same });
    for (const d of members.slice(1)) plan.fold.push({ row_id: d, into_row_id: kept, movement: mv.index, why: "daily_listing", today: same });
  }
  for (const dailiesOf of adoptedInto.values()) {
    dailiesOf.forEach((d, i) => plan.today.daily_rows.push({ row_id: d, fate: i === dailiesOf.length - 1 ? "on_cartola_row" : "merged" }));
  }
  for (const r of removed) plan.today.daily_rows.push({ row_id: r.row_id, fate: "gone" });
  plan.remove.push(...plannedRemoved);
  if (input.replace_month) {
    const held = new Set([...plan.keep.map((k) => k.row_id), ...plan.fold.map((f) => f.row_id)]);
    for (const r of input.rows) {
      if (r.kind !== "cartola" || r.listed?.period_month !== input.period_month || held.has(r.id)) continue;
      plan.remove.push({ row_id: r.id, movement: -1, why: "replaced_cartola_row" });
    }
  }
  return plan;
}
