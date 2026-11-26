/**
 * The card statement-line planner (pure; docs: none yet — the rule text comes with the switch).
 *
 * Contract. Given a statement import as it will be written — the statements' canonical lines, read
 * by the loader into the columns the import stores — and the card lines on file it can relate to,
 * the planner says, before anything is written, what today's import ends with, as row outcomes:
 *
 *  - `keep`: a row on file and the document line that will restate it (one-to-one), and why;
 *  - `fold`: a row on file that is the same charge as a kept row and folds into it;
 *  - `insert`: a document line no row on file is;
 *  - `remove`: a row on file the document supersedes with no counterpart, and why;
 *  - the card-only outcomes: a bucket line annulled (kept as an annulled purchase), moved to the open
 *    facturación, a plan-prepayment line kept, an annulment the statement settles;
 *  - `skip`: a document line that writes no row (a repeat of another, a plan's line);
 *  - `ambiguous`: what today's pipeline pairs in a way no one-to-one outcome expresses.
 *
 * It is the import's own matching moved before the write — the same steps in the same order, each
 * through the predicate the import uses (`takeBatchDedupeKeys`, `findPlanAmong`,
 * `oneShotFuzzyMatchAmong`, `oneShotLinesSupersededAmong` / `supersededLinesLessPlanSources`,
 * `planBucketSettlement`, `planAnnulmentSettlements`, `planCcLineMoves` / `fanOutUniformGroupsGiven`):
 *
 *  1. a JSON close a PDF takes over goes first; a statement the import replaces (replace keys) loses
 *     its lines when the import reaches it, just before its own are written (ids follow from that);
 *  2. each document line in order: a repeat inside its statement, a dedupe-key hit, a plan on file
 *     that is the one-shot line's purchase, a fuzzy duplicate (same day, pesos, merchant) — else
 *     written;
 *  3. the one-shot lines a plan (on file or the document's) supersedes go, the line's arrival onto
 *     the plan;
 *  4. each closed facturación settles its bucket (`planBucketSettlement`), the annulments settle;
 *  5. the re-import adoption pairs what vanished with what appeared (`planCcLineMoves`).
 *
 * Steps 4 and 5 move flows (the settled line's flow onto the statement line, a vanished line's onto
 * its replacement): the planner follows them as groups, the survivor flow first, which is today's
 * end state ({@link CardStatementLinePlan.today}). The plan departs from it in two declared ways
 * (`today: "differs"` on the entry): a bucket line a statement line carries under another shape
 * («carried under another shape», `statementRestatesBucketLine`) is kept by that line, where today
 * deletes it; and of several rows of one charge the earliest seen is the kept one — the oldest
 * arrival (`olderArrival`: a row with no stamp was on file before the stamps), ties by the lower row
 * id — where today the survivor is the one the adoption order leaves; and a replaced line that comes
 * back under its own id and parser row (the statement's lines held the highest ids, SQLite hands them
 * out again) is kept, where today's adoption — which tells lines apart by id and parser row — sees
 * no change, leaves the old flow retired and the line on a new one.
 *
 * Out of scope (the planner refuses or ignores, and the comparison report shows a disagreement if a
 * case depends on it): listing imports (paste, feed: the planted-charge absorber), the manual-plan
 * reconcile and a plan the statement updates under the same canonical row, the bucket passes after
 * the adoption (truncated twins, pending automatic payments), the classification-only copies onto a
 * new sibling (reported on the insert).
 */
import { findPlanAmong, oneShotLinesSupersededAmong, type CardPlanForMatching } from "./purchases.js";
import { oneShotFuzzyMatchAmong, supersededLinesLessPlanSources } from "../ccCrossImportDedupe.js";
import { merchantsMatchForCrossDedupe } from "./purchases.js";
import { merchantRenderingKey } from "./merchantRendering.js";
import { takeBatchDedupeKeys } from "./statementStorage.js";
import {
  linePurchaseIso,
  planBucketSettlement,
  sameBucketLineFigures,
  type BucketSettlementLine,
  type PlanPrepaymentLineRole,
  type StatementLineForMatching,
} from "../ccOpenWebPastePdfReconcile.js";
import { planAnnulmentSettlements, type AnnulmentForSettlement } from "../ccAnnulmentWriters.js";
import {
  ccLineIdentity,
  fanOutUniformGroupsGiven,
  planCcLineMoves,
  type CcLineMove,
  type CcLineRef,
} from "../flows/cardLineAdoption.js";
import { compareArrival, type FlowArrival } from "../flows/flowFirstSeen.js";
import type { PlantedPaymentRow } from "../ccPlantedPayments.js";

// ── input ────────────────────────────────────────────────────────────────────────────────────────

/** A card line's columns as the matchers read them (stored shape: padded `dd/mm/yyyy` days). */
export type PlanLineColumns = BucketSettlementLine & {
  installment_flag: boolean;
  nro_cuota_current: number | null;
  nro_cuota_total: number | null;
  parser_row_id: string | null;
  /** The peso figure the plan matchers read (`listOneShotLinesForAccount`): one-shot, positive, else null. */
  plan_match_amount_clp: number | null;
};

/** A card line on file. */
export type PlanFileLine = PlanLineColumns & {
  statement_id: number;
  dedupe_key: string | null;
  cuota_purchase_kind: string | null;
  /** Its statement's close and currency (`<ISO close>\t<currency>`), for a source takeover. */
  statement_close: string;
  /** When its flow first reached the ledger (`flowArrival`). */
  arrival: FlowArrival;
  /** What its flow carries (`cardLineAssignmentSignature`), for the re-import fan-out; null when nothing. */
  assignment_signature: string | null;
};

/** A statement as the account lists it once the import's headers are on file (`listCcStatementsForAccount` order). */
export type PlanStatement = {
  id: number;
  /** `cardStatementKey`: `card_group\tsource_pdf\tstatement_date`. */
  key: string;
  source_kind: string;
  currency: string;
  /** Its open-bucket month (`parseOpenWebPasteBillingMonth`), else null. */
  bucket_billing_month: string | null;
};

/** A document line (one line of an incoming statement, in the order the import hands it). */
export type PlanDocLine = PlanLineColumns & {
  /** The keys the import computes for it before the batch suffix (`canonicalLineDedupeKeys`). */
  raw_dedupe_keys: string[];
  /** Its peso slot (`storedCardLineAmounts`): the dedupe and fuzzy figure. */
  amount_clp: number;
  /** Its ISO day as the import reads it (`transaction_date ?? posting_date` of the canonical line). */
  date_iso: string | null;
};

/** An incoming statement: the row its header resolves to, and its lines. */
export type PlanDocStatement = {
  key: string;
  statement_id: number;
  /** A listing (`listing_open` / `listing_other`): out of scope, refused. */
  listing: boolean;
  currency: string;
  /** Its close and currency (`<ISO close>\t<currency>`). */
  close: string;
  lines: PlanDocLine[];
};

/** A closed facturación the import settles, with its facts as the headers leave them. */
export type PlanClosedMonth = {
  billing_month: string;
  fully_closed: boolean;
  statement_currencies: string[];
  closed_period: { from: string; to: string } | null;
  next_start: string;
  /** The month's statements (statement source kind), in the account's order. */
  statement_ids: number[];
};

export type CardStatementLinePlanInput = {
  account_id: number;
  /** Every incoming header is on file as the import would write it (the loader read without a savepoint). */
  headers_on_file: boolean;
  /** Plans the document's loan chains add to the ledger (none on file has their fingerprint). */
  document_plans_new: number;
  /** The account's statements once the headers are written (order matters: the reconcile's). */
  statements: PlanStatement[];
  /** JSON closes a PDF takes over: deleted, lines and all, before any line is written. */
  json_superseded_statement_ids: number[];
  /**
   * Incoming statements whose lines on file the import replaces (replace keys): each statement's
   * lines go when the import reaches it, just before its own lines are written.
   */
  replaced_statement_ids: number[];
  /** Every card line of the account, by id. */
  file_lines: PlanFileLine[];
  /**
   * The highest line id in the whole table outside the account's replaced and superseded statements
   * (0 when none). A written line takes the highest id left at that moment plus one (SQLite's rowid
   * rule), so a replaced statement's lines can come back under their old ids — which the re-import
   * adoption reads as no change.
   */
  max_line_id_outside_replaced: number;
  /** Bucket lines the bucket repair moves: line id → the bucket statement it lands in (an id of `statements`, or a new bucket's negative id). */
  bucket_repair_moves: { line_id: number; to_statement_id: number; to_billing_month: string }[];
  incoming: PlanDocStatement[];
  /** The plans before the write (`listPlansForLineMatching`) and after the ledger merge (with the document's). */
  plans_before: CardPlanForMatching[];
  plans_after: CardPlanForMatching[];
  /** Plan id → the line it was converted from. */
  plan_source_lines: [number, number][];
  closed_months: PlanClosedMonth[];
  /** The open facturación once the headers are written (bucket moves). */
  open_billing_month: string | null;
  annulments: (AnnulmentForSettlement & { arrival: FlowArrival })[];
  planted_payments: PlantedPaymentRow[];
  prepayment_roles: [number, PlanPrepaymentLineRole][];
};

// ── output ───────────────────────────────────────────────────────────────────────────────────────

/** A document line: its statement and position in the lines the import hands for it. */
export type DocLineRef = { statement_key: string; index: number };

/** A row on file a document line can restate: a card line, or an annulled purchase (its flow). */
export type FileRowRef = { kind: "line"; id: number } | { kind: "annulled_purchase"; id: number };

export type KeepReason =
  | "dedupe_key"
  | "fuzzy_duplicate"
  | "same_purchase"
  | "planted_payment"
  | "plan_prepayment"
  | "another_shape"
  | "reimport_parser_row"
  | "reimport_identity"
  | "reimport_fan_out"
  /** The same close from another source (a JSON close its PDF takes over), paired by the settle figures. */
  | "source_takeover"
  | "annulment_billed";

export type CardPlanKeep = {
  row: FileRowRef;
  doc: DocLineRef;
  why: KeepReason;
  /** Whether today's import ends with this row's flow on this line ("differs": see the module doc). */
  today: "same" | "differs";
};

export type CardPlanFold = {
  row: FileRowRef;
  into: FileRowRef;
  /** The document line that restates `into`; null for a removed copy folding into a line that stays. */
  doc: DocLineRef | null;
  why: KeepReason | "survivor_copy";
  today: "same" | "differs";
};

export type CardPlanInsert = {
  doc: DocLineRef;
  /** A statement's cuota line gets no arrival stamp; any other line arrives now. */
  arrival: "stamp" | "none";
  /** A new line beside kept lines of its identity: today copies their category and big group onto it. */
  copies_classification_from: number | null;
};

export type RemoveReason =
  | "replaced_statement_line_gone"
  | "superseded_by_plan"
  | "settled_by_statement"
  | "not_annullable"
  | "covered_by_plan"
  | "another_shape";

export type CardPlanRemove = { row: FileRowRef & { kind: "line" }; why: RemoveReason; plan_id?: number };

export type CardPlanSkip = {
  doc: DocLineRef;
  why: "repeat_in_statement" | "dedupe_key" | "fuzzy_duplicate" | "plan_on_file" | "superseded_by_plan";
  /** The document line it repeats (a dedupe or fuzzy hit on a line this import writes). */
  same_as?: DocLineRef;
  /** The row on file it repeats when that row goes in this import (a plan supersedes it). */
  same_as_row?: number;
  plan_id?: number;
};

export type CardStatementLinePlan = {
  keep: CardPlanKeep[];
  fold: CardPlanFold[];
  insert: CardPlanInsert[];
  remove: CardPlanRemove[];
  skip: CardPlanSkip[];
  annul: { line_id: number; billing_month: string; annulled_on: string }[];
  move_to_open: { line_id: number; billing_month: string }[];
  kept_plan_prepayment: number[];
  /** Annulments a statement credit refunds: one on file, or the one this import writes for a bucket line. */
  annulments_credited: {
    annulled_purchase_id: number | null;
    bucket_line_id: number | null;
    doc: DocLineRef | null;
    /** The credit line's day (the annulment's new `annulled_on`). */
    credit_iso: string;
  }[];
  ambiguous: { what: string; rows: FileRowRef[]; docs: DocLineRef[] }[];
  /** Today's end state, for the comparison report (`statementLinePlanCompare.ts`). */
  today: CardTodayEndState;
};

/** What today's import leaves, per document line and per row on file. */
export type CardTodayEndState = {
  /** Each document line's row: the row on file whose flow it ends with, else `new`; or no row. */
  docs: {
    doc: DocLineRef;
    /** The statement row the line is written on and its stored dedupe key (written lines only). */
    statement_id?: number;
    dedupe_key?: string | null;
    outcome: { row: "new" } | { row: FileRowRef } | { skipped: CardPlanSkip["why"]; same_as_row?: number };
  }[];
  /**
   * Each row on file the import touches: its flow on a document line (the survivor), merged into
   * another flow, kept on an annulled purchase, or gone with nothing; a moved or untouched line.
   */
  rows: { row: FileRowRef; fate: "on_doc_line" | "merged" | "annulled" | "retired" | "moved" | "untouched" }[];
};

// ── the planner ──────────────────────────────────────────────────────────────────────────────────

type Token = string;
const lineToken = (id: number): Token => `L${id}`;
const docToken = (id: number): Token => `D${id}`;
const annulToken = (id: number): Token => `A${id}`;

/** Flow groups: each token's group is the flow it ends on; a union keeps the survivor's flow. */
class FlowGroups {
  private parent = new Map<Token, Token>();
  find(t: Token): Token {
    let p = this.parent.get(t);
    if (p == null) return t;
    const root = this.find(p);
    this.parent.set(t, root);
    return root;
  }
  /** `arriving`'s flow folds into `survivor`'s. */
  fold(arriving: Token, survivor: Token): void {
    const a = this.find(arriving);
    const s = this.find(survivor);
    if (a !== s) this.parent.set(a, s);
  }
  clone(): FlowGroups {
    const c = new FlowGroups();
    c.parent = new Map(this.parent);
    return c;
  }
}

type LiveLine = PlanLineColumns & {
  /** File id, or a virtual id above every file id for a written document line. */
  id: number;
  statement_id: number;
  dedupe_key: string | null;
  listing: boolean;
  doc: DocLineRef | null;
  cuota_purchase_kind: string | null;
};

const refOf = (doc: DocLineRef): string => `${doc.statement_key}#${doc.index}`;

function lineOrder(a: { transaction_date: string | null; id: number }, b: { transaction_date: string | null; id: number }): number {
  // `ORDER BY transaction_date, id`: SQLite sorts NULL first, then text.
  const ta = a.transaction_date;
  const tb = b.transaction_date;
  if (ta !== tb) {
    if (ta == null) return -1;
    if (tb == null) return 1;
    return ta < tb ? -1 : 1;
  }
  return a.id - b.id;
}

/** Plans the import of `input.incoming` (see the module doc). Throws on a listing import. */
export function planCardStatementLines(input: CardStatementLinePlanInput): CardStatementLinePlan {
  for (const st of input.incoming) {
    if (st.listing) throw new Error(`statement-line planner: ${st.key} is a listing; only statement imports are planned`);
  }
  const statementById = new Map(input.statements.map((s) => [s.id, s]));
  const listingStatement = (id: number): boolean => {
    const st = statementById.get(id);
    return st != null && (st.source_kind === "listing_open" || st.source_kind === "listing_other");
  };
  const fileById = new Map(input.file_lines.map((l) => [l.id, l]));
  const jsonSuperseded = new Set(input.json_superseded_statement_ids);
  const replacedPending = new Set(input.replaced_statement_ids);

  const live = new Map<number, LiveLine>();
  const vanished = new Set<number>();
  const removeWhy = new Map<number, { why: RemoveReason; plan_id?: number }>();
  for (const l of input.file_lines) {
    if (jsonSuperseded.has(l.statement_id)) {
      vanished.add(l.id);
      removeWhy.set(l.id, { why: "replaced_statement_line_gone" });
      continue;
    }
    live.set(l.id, { ...l, listing: listingStatement(l.statement_id), doc: null });
  }
  /** The id the next written line gets: the highest id in the table now, plus one. */
  const nextId = (): number => Math.max(input.max_line_id_outside_replaced, ...live.keys()) + 1;
  const docOfVirtual = new Map<number, DocLineRef>();
  const virtualOfDoc = new Map<string, number>();
  const plan: CardStatementLinePlan = {
    keep: [],
    fold: [],
    insert: [],
    remove: [],
    skip: [],
    annul: [],
    move_to_open: [],
    kept_plan_prepayment: [],
    annulments_credited: [],
    ambiguous: [],
    today: { docs: [], rows: [] },
  };
  const skips = new Map<string, CardPlanSkip & { same_as_row?: number }>();
  /** Document lines a dedupe or fuzzy hit pairs with a row on file. */
  const skipKeeps: { row: number; doc: DocLineRef; why: "dedupe_key" | "fuzzy_duplicate" }[] = [];
  const inserted: DocLineRef[] = [];

  // 2. Each document line, in the import's order.
  for (const st of input.incoming) {
    // A statement it replaces loses its lines on file when the import reaches it.
    if (replacedPending.delete(st.statement_id)) {
      for (const l of [...live.values()]) {
        if (l.doc || l.statement_id !== st.statement_id) continue;
        live.delete(l.id);
        vanished.add(l.id);
        removeWhy.set(l.id, { why: "replaced_statement_line_gone" });
      }
    }
    const seen = new Set<string>();
    const writtenHere = new Set<number>();
    st.lines.forEach((line, index) => {
      const doc: DocLineRef = { statement_key: st.key, index };
      const keys = takeBatchDedupeKeys(seen, line.raw_dedupe_keys);
      if (keys === "repeat") {
        skips.set(refOf(doc), { doc, why: "repeat_in_statement" });
        return;
      }
      // In id order: the import's `LIMIT 1` reads the lowest id.
      const onFile = [...live.values()].filter((l) => !l.listing).sort((a, b) => a.id - b.id);
      if (keys.length > 0) {
        let hit: LiveLine | undefined;
        for (const k of keys) {
          hit = onFile.find((l) => l.dedupe_key === k);
          if (hit) break;
        }
        if (hit) {
          skipHit(doc, "dedupe_key", hit);
          return;
        }
      }
      const iso = line.date_iso;
      if (!line.installment_flag && line.amount_clp > 0) {
        const planOnFile = findPlanAmong(input.plans_before, line.merchant, iso, line.amount_clp);
        if (planOnFile) {
          skips.set(refOf(doc), { doc, why: "plan_on_file", plan_id: planOnFile.id });
          return;
        }
        const twin = keys.some((k) => k.includes("#dup"));
        if (!twin && iso) {
          const candidates = onFile
            .filter((l) => !l.installment_flag && l.currency === "clp" && l.amount === line.amount_clp) // convention-ok: the fuzzy scan reads the line's peso slot (`lineAmountClpSql`)
            .sort((a, b) => a.id - b.id);
          const fuzzy = oneShotFuzzyMatchAmong(candidates, line.merchant, iso, writtenHere);
          if (fuzzy) {
            skipHit(doc, "fuzzy_duplicate", fuzzy);
            return;
          }
        }
      }
      const id = nextId();
      live.set(id, {
        ...line,
        id,
        statement_id: st.statement_id,
        dedupe_key: keys[keys.length - 1] ?? null,
        listing: false,
        doc,
        cuota_purchase_kind: null,
      });
      writtenHere.add(id);
      docOfVirtual.set(id, doc);
      virtualOfDoc.set(refOf(doc), id);
      inserted.push(doc);
    });
  }

  function skipHit(doc: DocLineRef, why: "dedupe_key" | "fuzzy_duplicate", hit: LiveLine): void {
    if (hit.doc) {
      skips.set(refOf(doc), { doc, why, same_as: hit.doc });
    } else {
      skips.set(refOf(doc), { doc, why, same_as_row: hit.id });
      skipKeeps.push({ row: hit.id, doc, why });
    }
  }

  // 3. One-shot lines a plan supersedes.
  const oneShots = [...live.values()]
    .filter((l) => !l.installment_flag && l.plan_match_amount_clp != null && l.plan_match_amount_clp > 0)
    .sort((a, b) => a.id - b.id)
    .map((l) => ({
      statement_line_id: l.id,
      merchant: l.merchant,
      purchase_date_iso: linePurchaseIso(l),
      amount_clp: l.plan_match_amount_clp!,
    }));
  const superseded = supersededLinesLessPlanSources(
    oneShotLinesSupersededAmong(oneShots, input.plans_after),
    new Map(input.plan_source_lines)
  );
  for (const [lineId, p] of superseded) {
    const l = live.get(lineId)!;
    live.delete(lineId);
    if (l.doc) {
      skips.set(refOf(l.doc), { doc: l.doc, why: "superseded_by_plan", plan_id: p.id });
      inserted.splice(inserted.findIndex((d) => refOf(d) === refOf(l.doc!)), 1);
      docOfVirtual.delete(lineId);
      virtualOfDoc.delete(refOf(l.doc));
    } else {
      vanished.add(lineId);
      removeWhy.set(lineId, { why: "superseded_by_plan", plan_id: p.id });
    }
  }

  // The bucket repair: misplaced bucket lines move to the bucket of their cycle.
  const bucketStatements = new Map<number, { billingMonth: string; sourceKind: string }>();
  for (const st of input.statements) {
    if (st.bucket_billing_month) bucketStatements.set(st.id, { billingMonth: st.bucket_billing_month, sourceKind: st.source_kind });
  }
  const movedLines = new Map<number, string>();
  for (const m of input.bucket_repair_moves) {
    const l = live.get(m.line_id);
    if (!l) continue;
    l.statement_id = m.to_statement_id;
    movedLines.set(m.line_id, m.to_billing_month);
    if (!bucketStatements.has(m.to_statement_id)) {
      bucketStatements.set(m.to_statement_id, { billingMonth: m.to_billing_month, sourceKind: "listing_open" });
    }
  }

  // 4. Each closed facturación settles its bucket.
  const groups = new FlowGroups();
  /** A line as it stands now: a written document line (its id may be a replaced line's), else a line on file. */
  const tokenOf = (id: number): Token => (live.get(id)?.doc ? docToken(id) : lineToken(id));
  const restated: { from: number; to: number }[] = [];
  const settledFrom = new Map<number, { to: number; by: string }>();
  const annulledNew: { line: LiveLine; billing_month: string; annulled_on: string; vid: number }[] = [];
  const annulments: (AnnulmentForSettlement & { arrival: FlowArrival; token: Token })[] = input.annulments.map((a) => ({
    ...a,
    token: annulToken(a.id),
  }));
  let nextAnnulmentId = Math.max(0, ...input.annulments.map((a) => a.id)) + 1;
  const planted = new Map(input.planted_payments.map((p) => [p.line_id, p]));
  const prepaymentRoles = new Map(input.prepayment_roles);
  const keptPrepayment = new Set<number>();
  const credited: CardStatementLinePlan["annulments_credited"] = [];
  const billedAnnulments = new Map<number, number>();
  let openBucketId = -1_000_000;
  for (const month of input.closed_months) {
    const statementLines: StatementLineForMatching<LiveLine>[] = [];
    for (const sid of month.statement_ids) {
      const st = statementById.get(sid)!;
      const lines = [...live.values()].filter((l) => l.statement_id === sid && !l.installment_flag).sort(lineOrder);
      for (const line of lines) statementLines.push({ line, currency: st.currency });
    }
    const buckets = [...bucketStatements.entries()]
      .map(([id, b]) => ({ id, ...b, order: input.statements.findIndex((s) => s.id === id) }))
      .sort((a, b) => a.billingMonth.localeCompare(b.billingMonth) || a.order - b.order)
      .map((b) => ({
        billingMonth: b.billingMonth,
        sourceKind: b.sourceKind,
        lines: [...live.values()].filter((l) => l.statement_id === b.id).sort(lineOrder),
      }));
    const settlement = planBucketSettlement<LiveLine>({
      billingMonth: month.billing_month,
      fullyClosed: month.fully_closed,
      statementCurrencies: new Set(month.statement_currencies),
      closedPeriod: month.closed_period,
      nextStart: month.next_start,
      statementLines,
      buckets,
      planted,
      prepaymentRoles,
      cuotaPurchaseKind: (id) => live.get(id)?.cuota_purchase_kind ?? null,
      planCoversOneShot: (merchant, iso, amount) => findPlanAmong(input.plans_after, merchant, iso, amount) != null,
    });
    for (const s of settlement.settledBy) {
      settledFrom.set(s.fromLineId, { to: s.toLineId, by: s.by });
      // The statement line's flow folds into the bucket line's (`applyCardLinePlan` carry).
      groups.fold(tokenOf(s.toLineId), lineToken(s.fromLineId));
    }
    for (const r of settlement.restatedBy) restated.push({ from: r.fromLineId, to: r.toLineId });
    for (const a of settlement.toAnnul) {
      const line = live.get(a.id)!;
      const vid = nextAnnulmentId++;
      annulledNew.push({ line, billing_month: month.billing_month, annulled_on: a.annulledOn, vid });
      annulments.push({
        id: vid,
        currency: line.currency,
        amount: line.amount!,
        merchant: String(line.merchant ?? "").trim(),
        purchase_date: a.iso,
        bank_credit: 0,
        flow_id: line.id,
        purchase_key: "",
        arrival: fileById.get(line.id)!.arrival,
        // The annulled purchase keeps the line's flow.
        token: lineToken(line.id),
      });
    }
    for (const id of settlement.toDelete) {
      live.delete(id);
      vanished.add(id);
      movedLines.delete(id);
      if (!removeWhy.has(id)) removeWhy.set(id, { why: "settled_by_statement" });
    }
    for (const id of settlement.toMove) {
      const l = live.get(id)!;
      if (!input.open_billing_month) throw new Error(`statement-line planner: no open facturación to move line ${id} into`);
      const target = [...bucketStatements.entries()].find(([, b]) => b.billingMonth === input.open_billing_month)?.[0];
      const to = target ?? openBucketId;
      if (target == null) bucketStatements.set(openBucketId, { billingMonth: input.open_billing_month, sourceKind: "listing_open" });
      l.statement_id = to;
      movedLines.set(id, input.open_billing_month);
    }
    for (const id of settlement.keptPrepaymentLines) keptPrepayment.add(id);
    // The annulments, the ones this close writes included, in the card's order (purchase day, id).
    const ordered = [...annulments].sort((a, b) => a.purchase_date.localeCompare(b.purchase_date) || a.id - b.id);
    for (const d of planAnnulmentSettlements(ordered, settlement.matchable, new Set())) {
      const a = d.annulment as (typeof annulments)[number];
      if (d.outcome === "billed") {
        // The statement line's flow folds into the annulment's (`settleAnnulmentsAgainstStatement`).
        if (a.flow_id != null) groups.fold(tokenOf(d.statement_line_id), a.token);
        billedAnnulments.set(a.id, d.statement_line_id);
        annulments.splice(annulments.indexOf(a), 1);
      } else {
        a.bank_credit = 1;
        const fresh = annulledNew.find((n) => n.vid === a.id);
        credited.push({
          annulled_purchase_id: fresh ? null : a.id,
          bucket_line_id: fresh ? fresh.line.id : null,
          doc: docOfVirtual.get(d.statement_line_id) ?? null,
          credit_iso: d.credit_iso,
        });
      }
    }
    openBucketId -= 1;
  }

  // 5. The re-import adoption: what vanished against what appeared.
  const ref = (l: PlanLineColumns & { id: number; statement_id: number }): CcLineRef => {
    const st = statementById.get(l.statement_id);
    const legacy = l.currency === "clp" ? { amount_clp: l.amount, amount_usd: null } : l.currency === "usd" ? { amount_clp: 0, amount_usd: l.amount } : { amount_clp: null, amount_usd: null }; // convention-ok: the identity reads the legacy peso/dollar slots (`lineAmountClpSql`)
    const parserRowId = String(l.parser_row_id ?? "").trim();
    return {
      lineId: l.id,
      accountId: input.account_id,
      parserRowId: parserRowId && !parserRowId.startsWith("synthetic:") ? parserRowId : null,
      installment: l.installment_flag,
      identity: ccLineIdentity({
        account_id: input.account_id,
        currency: st?.currency ?? l.currency,
        transaction_date: l.transaction_date,
        posting_date: l.posting_date,
        merchant: l.merchant,
        ...legacy,
        installment_flag: l.installment_flag ? 1 : 0,
        nro_cuota_current: l.nro_cuota_current,
        nro_cuota_total: l.nro_cuota_total,
      }),
    };
  };
  // The adoption tells lines apart by id and parser row (`adoptReimportedCardLines`): a written line
  // under the id and parser row of the line it replaces is no change to it — the old line's flow
  // stays retired and the written line keeps its own new one («hidden» below).
  const sig = (id: number, prid: string | null) => `${id}|${prid ?? ""}`;
  const parserRow = (l: PlanLineColumns) => {
    const t = String(l.parser_row_id ?? "").trim();
    return t && !t.startsWith("synthetic:") ? t : null;
  };
  const beforeSigs = new Set(input.file_lines.map((l) => sig(l.id, parserRow(l))));
  const afterSigs = new Set([...live.values()].map((l) => sig(l.id, parserRow(l))));
  const hidden: { from: number; to: number }[] = [];
  for (const id of vanished) {
    const l = fileById.get(id)!;
    if (afterSigs.has(sig(id, parserRow(l)))) hidden.push({ from: id, to: id });
  }
  const hiddenIds = new Set(hidden.map((h) => h.from));
  const vanishedRefs = [...vanished]
    .filter((id) => !hiddenIds.has(id))
    .sort((a, b) => a - b)
    .map((id) => ref(fileById.get(id)!));
  const appearedRefs = [...live.values()].filter((l) => l.doc && !beforeSigs.has(sig(l.id, parserRow(l)))).map(ref);
  const survivorRefs = [...live.values()].filter((l) => !l.doc || beforeSigs.has(sig(l.id, parserRow(l)))).map((l) => ref(l));
  const moves = planCcLineMoves(vanishedRefs, appearedRefs, survivorRefs);
  const signature = (r: CcLineRef): string | null => fileById.get(r.lineId)?.assignment_signature ?? null;
  const fan = fanOutUniformGroupsGiven(moves.ambiguousGroups, signature);
  const adoptions: CcLineMove[] = [...moves.moves, ...fan.moves].filter((m) => !m.copy && !m.from.installment && !m.to.installment);
  // A statement's cuota line that comes back under its parser row is the same line (today's
  // adoption leaves cuota lines alone: their flow is their plan's): the plan keeps it.
  const cuotaKeeps = [...moves.moves, ...fan.moves].filter((m) => !m.copy && m.from.installment && m.to.installment && m.by === "parser_row_id");
  const adoptedBy = new Map<number, CcLineMove["by"]>();
  for (const m of adoptions) {
    if (m.by === "survivor") {
      // A removed duplicate copy: its flow folds into the copy that stayed.
      groups.fold(lineToken(m.from.lineId), lineToken(m.to.lineId));
    } else {
      groups.fold(docToken(m.to.lineId), lineToken(m.from.lineId));
    }
    adoptedBy.set(m.from.lineId, m.by);
  }
  for (const r of moves.ambiguous.filter((r) => !fan.fannedOut.has(r.lineId))) {
    plan.ambiguous.push({ what: "re-import identity group whose counts differ (left unpaired)", rows: [{ kind: "line", id: r.lineId }], docs: [] });
  }
  const copiesFrom = new Map<number, number>();
  for (const { survivors, news } of moves.besideSurvivors) {
    const sigs = survivors.map(signature);
    if (sigs[0] == null || sigs.some((x) => x !== sigs[0])) continue;
    for (const n of news) copiesFrom.set(n.lineId, survivors[0]!.lineId);
  }

  // Today's end state, then the plan (another-shape lines kept by their statement line).
  const today = groups;
  const planned = groups.clone();
  // The plan keeps a replaced line its own re-written line restates (today misses it, see `hidden`).
  for (const h of hidden) planned.fold(docToken(h.to), lineToken(h.from));
  for (const m of cuotaKeeps) {
    planned.fold(docToken(m.to.lineId), lineToken(m.from.lineId));
    adoptedBy.set(m.from.lineId, "parser_row_id");
  }
  for (const r of restated) planned.fold(tokenOf(r.to), lineToken(r.from));
  // A source takeover of the same close (a JSON close its PDF takes over, a statement re-sent):
  // what the exact pairing left on both sides pairs one to one, in line order, by the bucket's
  // settle figures (currency, amount to the coin, day within a day) and a merchant that matches or
  // differs only in rendering (a terminal code, punctuation: `merchantRenderingKey`).
  const movesAll = [...moves.moves, ...fan.moves];
  const pairedFrom = new Set(movesAll.map((m) => m.from.lineId));
  const pairedTo = new Set(movesAll.map((m) => m.to.lineId));
  // Only lines of the same close (close day and currency) pair, and each pass runs over every gone
  // line before the next, looser one: the same merchant, then a matching or re-rendered one.
  const takeoverFrom = new Set<number>();
  const closeOfDoc = new Map(input.incoming.map((st) => [st.key, st]));
  const candidates = [...live.values()]
    .filter((d) => d.doc && !d.installment_flag && !beforeSigs.has(sig(d.id, parserRow(d))))
    .sort((a, b) => a.id - b.id);
  const gone = [...vanished]
    .sort((a, b) => a - b)
    .filter((id) => !hiddenIds.has(id) && !pairedFrom.has(id) && removeWhy.get(id)?.why === "replaced_statement_line_gone" && !fileById.get(id)!.installment_flag);
  const sameMerchant = (a: string | null, b: string | null) => String(a ?? "").trim().toUpperCase() === String(b ?? "").trim().toUpperCase();
  const renderingMatch = (a: string | null, b: string | null) => {
    const ra = merchantRenderingKey(String(a ?? ""));
    return merchantsMatchForCrossDedupe(a, b) || (ra !== "" && ra === merchantRenderingKey(String(b ?? "")));
  };
  for (const merchantMatches of [sameMerchant, renderingMatch]) {
    for (const id of gone) {
      if (takeoverFrom.has(id)) continue;
      const l = fileById.get(id)!;
      const target = candidates.find((d) => {
        if (pairedTo.has(d.id)) return false;
        const st = closeOfDoc.get(d.doc!.statement_key)!;
        if (st.close !== l.statement_close) return false;
        return sameBucketLineFigures(l, { line: d, currency: st.currency }) && merchantMatches(l.merchant, d.merchant);
      });
      if (!target) continue;
      pairedTo.add(target.id);
      takeoverFrom.add(id);
      planned.fold(docToken(target.id), lineToken(id));
    }
  }
  if (takeoverFrom.size > 0) {
    plan.ambiguous = plan.ambiguous.filter((a) => !a.rows.every((r) => r.kind === "line" && takeoverFrom.has(r.id)));
  }

  const fileRowOfToken = (t: Token): FileRowRef | null => {
    if (t.startsWith("L")) {
      const id = Number(t.slice(1));
      return fileById.has(id) ? { kind: "line", id } : null;
    }
    const id = Number(t.slice(1));
    return input.annulments.some((a) => a.id === id) ? { kind: "annulled_purchase", id } : null;
  };
  const fileTokens: Token[] = [
    ...input.file_lines.map((l) => lineToken(l.id)),
    ...input.annulments.map((a) => annulToken(a.id)),
  ];
  const membersOf = (g: FlowGroups, docVid: number): Token[] => {
    const root = g.find(docToken(docVid));
    return fileTokens.filter((t) => g.find(t) === root);
  };
  const arrivalOf = (row: FileRowRef): FlowArrival =>
    row.kind === "line" ? fileById.get(row.id)!.arrival : input.annulments.find((a) => a.id === row.id)!.arrival;
  /** Earliest seen first: the older arrival (`arrivalRank`), ties by the lower id. */
  const earliestFirst = (a: FileRowRef, b: FileRowRef): number =>
    compareArrival(arrivalOf(a), arrivalOf(b)) || a.id - b.id || (a.kind === b.kind ? 0 : a.kind === "line" ? -1 : 1);
  const whyOf = (row: FileRowRef, docVid: number): KeepReason => {
    if (row.kind === "annulled_purchase") return "annulment_billed";
    const settled = settledFrom.get(row.id);
    if (settled && settled.to === docVid) return settled.by as KeepReason;
    if (restated.some((r) => r.from === row.id && r.to === docVid)) return "another_shape";
    if (hiddenIds.has(row.id)) return "reimport_parser_row";
    if (takeoverFrom.has(row.id)) return "source_takeover";
    const by = adoptedBy.get(row.id);
    if (by === "parser_row_id") return "reimport_parser_row";
    if (by === "fan_out") return "reimport_fan_out";
    return "reimport_identity";
  };
  const sameSet = (a: Token[], b: Token[]): boolean => a.length === b.length && a.every((t) => b.includes(t));
  const claimed = new Set<string>();
  const docsByRoot = new Map<Token, DocLineRef[]>();
  for (const doc of inserted) {
    const root = planned.find(docToken(virtualOfDoc.get(refOf(doc))!));
    docsByRoot.set(root, [...(docsByRoot.get(root) ?? []), doc]);
  }
  for (const doc of inserted) {
    const vid = virtualOfDoc.get(refOf(doc))!;
    const sharing = docsByRoot.get(planned.find(docToken(vid)))!;
    const todayMembers = membersOf(today, vid);
    const todaySurvivorToken = today.find(docToken(vid));
    const todayRow = fileRowOfToken(todaySurvivorToken);
    const written = live.get(vid)!;
    plan.today.docs.push({
      doc,
      statement_id: written.statement_id,
      dedupe_key: written.dedupe_key,
      outcome: todayRow ? { row: todayRow } : { row: "new" },
    });
    const members = membersOf(planned, vid)
      .map(fileRowOfToken)
      .filter((r): r is FileRowRef => r != null)
      .sort(earliestFirst);
    if (sharing.length > 1 && refOf(sharing[0]!) !== refOf(doc)) {
      // Today's adoption leaves this line on the flow another document line ends with.
      plan.ambiguous.push({
        what: `two document lines end on one flow (with ${refOf(sharing[0]!).replace(/\t/g, " | ")})`,
        rows: members,
        docs: [doc],
      });
      continue;
    }
    if (members.length === 0) {
      const line = live.get(vid)!;
      plan.insert.push({
        doc,
        arrival: line.installment_flag ? "none" : "stamp",
        copies_classification_from: copiesFrom.get(vid) ?? null,
      });
      continue;
    }
    const same = sameSet(members.map((r) => (r.kind === "line" ? lineToken(r.id) : annulToken(r.id))), todayMembers);
    const keptRow = members[0]!;
    const keptToday = same && todayRow != null && todayRow.kind === keptRow.kind && todayRow.id === keptRow.id;
    plan.keep.push({ row: keptRow, doc, why: whyOf(keptRow, vid), today: keptToday ? "same" : "differs" });
    for (const r of members) claimed.add(`${r.kind}:${r.id}`);
    for (const r of members.slice(1)) {
      plan.fold.push({ row: r, into: keptRow, doc, why: whyOf(r, vid), today: same ? "same" : "differs" });
    }
  }
  // A vanished line whose flow folds into a line that stayed (a removed duplicate copy).
  for (const m of adoptions.filter((m) => m.by === "survivor")) {
    if (claimed.has(`line:${m.from.lineId}`)) continue;
    claimed.add(`line:${m.from.lineId}`);
    plan.fold.push({
      row: { kind: "line", id: m.from.lineId },
      into: { kind: "line", id: m.to.lineId },
      doc: null,
      why: "survivor_copy",
      today: "same",
    });
  }
  // A settlement by a statement line already on file (its twin's statement arrived first, a late
  // listing of the purchase sits in the bucket): the bucket line, or the annulled purchase it billed,
  // folds into that line — the line's assignments win, the bucket line's fill the rest.
  const docVids = new Set(virtualOfDoc.values());
  const settledOnFile = (to: number) => !docVids.has(to) && fileById.has(to);
  const foldOnFile = (row: FileRowRef, into: number, why: KeepReason) => {
    const key = `${row.kind}:${row.id}`;
    if (claimed.has(key)) return;
    claimed.add(key);
    plan.fold.push({ row, into: { kind: "line", id: into }, doc: null, why, today: "same" });
  };
  for (const [from, s] of settledFrom) if (settledOnFile(s.to)) foldOnFile({ kind: "line", id: from }, s.to, s.by as KeepReason);
  for (const r of restated) if (settledOnFile(r.to)) foldOnFile({ kind: "line", id: r.from }, r.to, "another_shape");
  for (const [annulmentId, lineId] of billedAnnulments) {
    if (!settledOnFile(lineId)) continue;
    const fresh = annulledNew.find((n) => n.vid === annulmentId);
    foldOnFile(fresh ? { kind: "line", id: fresh.line.id } : { kind: "annulled_purchase", id: annulmentId }, lineId, "annulment_billed");
  }
  // A dedupe or fuzzy hit on a row on file keeps that row — unless the row goes in this import (a
  // plan supersedes it): then the document line writes nothing and the row is removed.
  const settledDocs = new Set<string>();
  for (const k of skipKeeps) {
    if (vanished.has(k.row)) continue;
    const key = `line:${k.row}`;
    // A row another document line already restates: this line repeats it and writes nothing (its skip).
    if (claimed.has(key)) continue;
    settledDocs.add(refOf(k.doc));
    claimed.add(key);
    plan.keep.push({ row: { kind: "line", id: k.row }, doc: k.doc, why: k.why, today: "same" });
  }
  for (const s of skips.values()) {
    plan.today.docs.push({ doc: s.doc, outcome: { skipped: s.why, ...(s.same_as_row != null ? { same_as_row: s.same_as_row } : {}) } });
    if (settledDocs.has(refOf(s.doc))) continue;
    plan.skip.push(s);
  }

  // Rows on file: annulled, moved, kept prepayment lines, removed.
  for (const a of annulledNew) {
    const billed = billedAnnulments.has(a.vid);
    if (!billed) plan.annul.push({ line_id: a.line.id, billing_month: a.billing_month, annulled_on: a.annulled_on });
  }
  for (const [id, bm] of movedLines) plan.move_to_open.push({ line_id: id, billing_month: bm });
  plan.kept_plan_prepayment.push(...keptPrepayment);
  plan.annulments_credited.push(...credited);
  const annulledIds = new Set(annulledNew.filter((a) => !billedAnnulments.has(a.vid)).map((a) => a.line.id));
  for (const id of [...vanished].sort((a, b) => a - b)) {
    if (claimed.has(`line:${id}`) || annulledIds.has(id)) continue;
    const r = removeWhy.get(id)!;
    const line = fileById.get(id)!;
    let why = r.why;
    if (why === "settled_by_statement" && !settledFrom.has(id)) {
      why = restated.some((x) => x.from === id)
        ? "another_shape"
        : findPlanAmong(input.plans_after, line.merchant, linePurchaseIso(line) ?? "", Math.abs(Math.trunc(line.amount ?? 0)))
          ? "covered_by_plan"
          : "not_annullable";
    }
    plan.remove.push({ row: { kind: "line", id }, why, ...(r.plan_id != null ? { plan_id: r.plan_id } : {}) });
  }

  // Today's fate of each row on file the import touched.
  const docRoots = new Set([...virtualOfDoc.values()].map((vid) => today.find(docToken(vid))));
  const annulRoots = new Set(annulments.map((a) => today.find(a.token)));
  for (const t of fileTokens) {
    const row = fileRowOfToken(t)!;
    const isLine = row.kind === "line";
    const touched =
      (isLine && (vanished.has(row.id) || movedLines.has(row.id))) || (!isLine && billedAnnulments.has(row.id));
    if (!touched) {
      if (isLine) plan.today.rows.push({ row, fate: "untouched" });
      continue;
    }
    if (isLine && movedLines.has(row.id)) {
      plan.today.rows.push({ row, fate: "moved" });
      continue;
    }
    const root = today.find(t);
    if (root !== t) plan.today.rows.push({ row, fate: "merged" });
    else if (docRoots.has(root)) plan.today.rows.push({ row, fate: "on_doc_line" });
    else if (annulRoots.has(root)) plan.today.rows.push({ row, fate: "annulled" });
    else plan.today.rows.push({ row, fate: "retired" });
  }
  assertExclusiveOutcomes(plan, input, { touched: new Set([...vanished, ...movedLines.keys(), ...keptPrepayment]) });
  return plan;
}

/**
 * Every document line ends in exactly one outcome (keep, insert, skip, ambiguous) and every row on
 * file the import touches in exactly one (keep, fold, remove, annul, move, kept prepayment); a row
 * in none of them is untouched. Throws otherwise: the outcome sets are a partition by construction.
 */
function assertExclusiveOutcomes(plan: CardStatementLinePlan, input: CardStatementLinePlanInput, opts: { touched: ReadonlySet<number> }): void {
  const docs = new Map<string, number>();
  const countDoc = (d: DocLineRef) => docs.set(refOf(d), (docs.get(refOf(d)) ?? 0) + 1);
  for (const k of plan.keep) countDoc(k.doc);
  for (const i of plan.insert) countDoc(i.doc);
  for (const s of plan.skip) countDoc(s.doc);
  for (const a of plan.ambiguous) a.docs.forEach(countDoc);
  const problems: string[] = [];
  for (const st of input.incoming) {
    st.lines.forEach((_, index) => {
      const n = docs.get(refOf({ statement_key: st.key, index })) ?? 0;
      if (n !== 1) problems.push(`document line ${st.key.replace(/\t/g, " | ")} #${index} is in ${n} outcomes`);
    });
  }
  const rows = new Map<string, number>();
  const countRow = (key: string) => rows.set(key, (rows.get(key) ?? 0) + 1);
  for (const k of plan.keep) countRow(`${k.row.kind}:${k.row.id}`);
  for (const f of plan.fold) countRow(`${f.row.kind}:${f.row.id}`);
  for (const r of plan.remove) countRow(`line:${r.row.id}`);
  for (const a of plan.annul) countRow(`line:${a.line_id}`);
  for (const m of plan.move_to_open) countRow(`line:${m.line_id}`);
  for (const id of plan.kept_plan_prepayment) countRow(`line:${id}`);
  for (const [key, n] of rows) if (n !== 1) problems.push(`${key} is in ${n} outcomes`);
  for (const id of opts.touched) if (!rows.has(`line:${id}`)) problems.push(`line:${id} is touched but in no outcome`);
  if (problems.length > 0) throw new Error(`statement-line planner: outcomes overlap: ${problems.join("; ")}`);
}

export { compareArrival } from "../flows/flowFirstSeen.js";
