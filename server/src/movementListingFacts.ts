/**
 * What a bank listing printed for a row it wrote, in columns (migrations 370, 372): a cartola or a
 * daily-listing movement's evidence (`flow_evidence`, `source_table = 'movements'`) states the bank
 * day it was listed on (`stated_on`), its signed amount (`stated_amount`), its description
 * (`stated_description`), its document number (`stated_document_no`, '' when it printed none), the
 * cartola month it came from (`stated_period`, NULL for a daily-listing row) and, for a cartola row,
 * its branch and its position in the cartola (`stated_branch`, `stated_position`). The importers
 * write them with the row (`insertBankPesoMovement`); runtime reads them (`bankRowFacts.ts`), never
 * the note (the note stays human provenance).
 *
 * The description and document are the ones the importers matched on before these columns existed:
 * a daily row's description as its note kept it (bars turned into slashes, cut at 120 characters,
 * runs of spaces collapsed); a cartola row's cut at 180 characters.
 */
import type { Database } from "better-sqlite3";
import type { ParsedCheckingMovement } from "./checkingCartolaParse.js";
import type { PartialBankMovement } from "./partialBankMovement.js";

/** What a bank listing says about a row it wrote (the cartola's or the daily listing's), as the cartola planner reads it. */
export type CheckingListedFacts = {
  bank_day: string;
  amount_clp: number;
  description: string;
  document_no: string;
  /** The cartola month a cartola row was written from (null for a daily-listing row). */
  period_month: string | null;
};

/** The listing facts a bank row is written with (its amount is the row's own). */
export type BankListingFacts = {
  bank_day: string;
  description: string;
  document_no: string;
  /** The cartola month (null for a daily-listing row). */
  period_month: string | null;
  /** A cartola row's branch and position in its cartola (null for a daily-listing row). */
  branch: string | null;
  position: number | null;
};

/** A daily-listing row's facts. */
export function dailyListingFacts(mv: PartialBankMovement): BankListingFacts {
  return {
    bank_day: mv.occurred_on,
    description: mv.description.replace(/\|/g, "/").slice(0, 120).replace(/\s+/g, " ").trim(),
    document_no: String(mv.document_no ?? "").trim(),
    period_month: null,
    branch: null,
    position: null,
  };
}

/** A cartola row's facts (`position`: the movement's place in its cartola). */
export function cartolaListingFacts(periodMonth: string, mv: ParsedCheckingMovement, position: number): BankListingFacts {
  return {
    bank_day: mv.occurred_on,
    description: mv.description.slice(0, 180).trim(),
    document_no: String(mv.document_no ?? "").trim(),
    period_month: periodMonth,
    branch: mv.branch || "—",
    position,
  };
}

/** The bank-document kinds whose evidence states listing facts. */
export const LISTED_SOURCE_KINDS = ["cartola", "daily_listing"] as const;

/**
 * Writes a bank row's listing facts onto its evidence. Throws when the row has no cartola or
 * daily-listing evidence (its note does not name a bank document) or the day is not ISO.
 */
export function recordBankListingFacts(movementId: number, facts: BankListingFacts, dbHandle: Database): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(facts.bank_day)) throw new Error(`movement ${movementId}: listed day «${facts.bank_day}» is not ISO`);
  if (facts.period_month != null && !/^\d{4}-\d{2}$/.test(facts.period_month)) {
    throw new Error(`movement ${movementId}: cartola month «${facts.period_month}» is not YYYY-MM`);
  }
  if ((facts.period_month != null) !== (facts.position != null && facts.branch != null)) {
    throw new Error(`movement ${movementId}: a cartola row states its month, branch and position; a daily-listing row none of them`);
  }
  const changes = dbHandle
    .prepare(
      `UPDATE flow_evidence SET stated_on = ?, stated_description = ?, stated_document_no = ?, stated_period = ?, stated_branch = ?, stated_position = ?
       WHERE source_table = 'movements' AND source_row_id = ? AND source_kind IN ('cartola', 'daily_listing')`
    )
    .run(facts.bank_day, facts.description, facts.document_no, facts.period_month, facts.branch, facts.position, movementId).changes;
  if (changes !== 1) throw new Error(`movement ${movementId}: no cartola or daily-listing evidence to state its listing on`);
}

/** The evidence columns {@link listedFactsOfEvidence} reads (alias `e`). */
export const LISTED_FACTS_COLUMNS_SQL = `e.stated_on, e.stated_amount, e.stated_description, e.stated_document_no, e.stated_period, e.stated_branch, e.stated_position`;

export type ListedFactsEvidence = {
  stated_on: string | null;
  stated_amount: number | null;
  stated_description: string | null;
  stated_document_no: string | null;
  stated_period: string | null;
  stated_branch: string | null;
  stated_position: number | null;
};

/**
 * A bank row's listing facts from its evidence: null for a row no bank listing wrote. A cartola or
 * daily-listing row without them throws — every writer states them (`insertBankPesoMovement`), and
 * migration 370 stated them for the rows on file.
 */
export function listedFactsOfEvidence(movementId: number, kind: string | null, e: ListedFactsEvidence): CheckingListedFacts | null {
  if (kind !== "cartola" && kind !== "daily_listing") return null;
  if (e.stated_document_no == null || e.stated_on == null || e.stated_amount == null || e.stated_description == null) {
    throw new Error(`movement ${movementId}: a ${kind} row with no listing facts on its evidence`);
  }
  if (kind === "cartola" && e.stated_period == null) throw new Error(`movement ${movementId}: a cartola row with no cartola month`);
  return {
    bank_day: e.stated_on,
    amount_clp: e.stated_amount,
    description: e.stated_description,
    document_no: e.stated_document_no,
    period_month: kind === "cartola" ? e.stated_period : null,
  };
}

/**
 * A movement's listing facts as written (`recordBankListingFacts`): null for a row no bank listing
 * wrote; a cartola or daily-listing row without them throws.
 */
export function listedFactsOfMovement(movementId: number, dbHandle: Database): BankListingFacts | null {
  const e = dbHandle
    .prepare(`SELECT e.source_kind AS kind, ${LISTED_FACTS_COLUMNS_SQL} FROM flow_evidence e WHERE e.source_table = 'movements' AND e.source_row_id = ?`)
    .get(movementId) as (ListedFactsEvidence & { kind: string }) | undefined;
  if (!e) throw new Error(`movement ${movementId}: no evidence`);
  const f = listedFactsOfEvidence(movementId, e.kind, e);
  return f == null
    ? null
    : {
        bank_day: f.bank_day,
        description: f.description,
        document_no: f.document_no,
        period_month: f.period_month,
        branch: e.kind === "cartola" ? e.stated_branch : null,
        position: e.kind === "cartola" ? e.stated_position : null,
      };
}

/**
 * A mirror conversion's kept leg (`movement_mirror_merges`, migration 371): the listing facts the
 * deleted leg's evidence stated, kept with the merge row so an undo restores them. `side` names the
 * column set (`out_listed_*` / `in_listed_*`).
 */
export type MirrorLegListing = {
  listed_on: string | null;
  listed_description: string | null;
  listed_document_no: string | null;
  listed_period: string | null;
  listed_branch: string | null;
  listed_position: number | null;
};

/** The merge-row columns of one side, in {@link mirrorLegListingOf}'s order. */
export function mirrorLegListingColumns(side: "out" | "in"): string {
  return ["on", "description", "document_no", "period", "branch", "position"].map((c) => `${side}_listed_${c}`).join(", ");
}

export function mirrorLegListingOf(facts: BankListingFacts | null): MirrorLegListing {
  return facts == null
    ? { listed_on: null, listed_description: null, listed_document_no: null, listed_period: null, listed_branch: null, listed_position: null }
    : {
        listed_on: facts.bank_day,
        listed_description: facts.description,
        listed_document_no: facts.document_no,
        listed_period: facts.period_month,
        listed_branch: facts.branch,
        listed_position: facts.position,
      };
}

/**
 * A restored leg states again the listing its merge row kept: a cartola or daily-listing row
 * (its restored note says so) takes the kept facts, and throws when the merge row kept none; any
 * other row takes none, and throws when the merge row kept some.
 */
export function restoreMirrorLegListing(movementId: number, kept: MirrorLegListing, dbHandle: Database): void {
  const kind = (dbHandle.prepare(`SELECT source_kind FROM flow_evidence WHERE source_table = 'movements' AND source_row_id = ?`).get(movementId) as
    | { source_kind: string }
    | undefined)?.source_kind;
  const isBank = kind === "cartola" || kind === "daily_listing";
  if (!isBank) {
    if (kept.listed_document_no != null) throw new Error(`movement ${movementId}: a ${kind ?? "kind-less"} leg with listing facts kept`);
    return;
  }
  if (kept.listed_on == null || kept.listed_description == null || kept.listed_document_no == null) {
    throw new Error(`movement ${movementId}: a restored ${kind} leg whose conversion kept no listing facts`);
  }
  recordBankListingFacts(
    movementId,
    {
      bank_day: kept.listed_on,
      description: kept.listed_description,
      document_no: kept.listed_document_no,
      period_month: kept.listed_period,
      branch: kept.listed_branch,
      position: kept.listed_position,
    },
    dbHandle
  );
}

/** The evidence kinds whose description a writer states (a mail-written row's, a ledger anchor's). */
const DESCRIBED_KINDS = ["mail_notice", "mail_rebuilt", "cartola_anchor"] as const;

/**
 * States the description of a row written from a mail or of a ledger anchor on its evidence (its
 * note is provenance). Throws when the row is of no such kind.
 */
export function stateMovementDescription(movementId: number, description: string, dbHandle: Database): void {
  const changes = dbHandle
    .prepare(
      `UPDATE flow_evidence SET stated_description = ?
       WHERE source_table = 'movements' AND source_row_id = ? AND source_kind IN (${DESCRIBED_KINDS.map((k) => `'${k}'`).join(", ")})`
    )
    .run(description, movementId).changes;
  if (changes !== 1) throw new Error(`movement ${movementId}: not a mail-written row or a ledger anchor`);
}
