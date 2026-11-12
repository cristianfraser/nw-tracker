/**
 * Adoption on arrival for card lines (docs/untangle-flow-identity.md, F9 step 4). A card line that
 * replaces another — a statement re-import that gives the line a new row (and, after a parser
 * change, a new parser_row_id), a pasted/fed line settled by the statement that bills it, a cut or
 * pending re-listing dropped for its fuller twin, a planted payment replaced by the bank's line, a
 * pending listing under another name replaced by the posted one — takes over the old line's flow:
 * the new line's own flow folds into it ({@link adoptFlow}), so the category, «Único», note, big
 * group, pieces and links stay where the user put them and the flow id with them. Before step 4 a
 * mover carried each table onto the new line's key (`ccExpenseLineRekey`, deleted).
 *
 * The recogniser is unchanged (F9 «the same recognisers, a different outcome»): a vanished line is
 * paired with an appeared one first by the same parser_row_id, then by identity — account, statement
 * currency, date, amounts, cuota numbers and the merchant's letters and digits. Identical twins pair
 * in id order (print order); a group whose counts disagree is reported and left alone, never
 * guessed. A vanished line with no appeared counterpart whose identity matches exactly one line that
 * stayed is a removed duplicate copy of that purchase: its flow folds into the copy that stayed.
 * A cuota line is evidence of its plan's flow and is never adopted on its own.
 */
import { db } from "../db.js";
import { buildExpenseKey } from "../expenseKeys.js";
import { statementLineDateIso } from "../ccInstallmentPayBy.js";
import { adoptFlow, flowExists, rowFlowId } from "./flowAdoption.js";
import { ensureFlowForKey, flowIdForKey } from "./flowIdentity.js";
import { FLOW_HOLDING_TABLES } from "./flowRetirement290.js";
import { cardLineFirstSeenForAccount, keepEarlierFlowFirstSeen } from "./flowFirstSeen.js";
import { lineAmountClpSql, lineAmountUsdSql } from "../cards/lineAmountSql.js";

export type CcLineIdentitySource = {
  account_id: number;
  currency: string;
  transaction_date: string | null;
  posting_date: string | null;
  merchant: string | null;
  amount_clp: number | null;
  amount_usd: number | null;
  installment_flag: number;
  nro_cuota_current: number | null;
  nro_cuota_total: number | null;
};

export type CcLineRef = {
  lineId: number;
  accountId: number;
  /** Null for synthetic / missing parser ids (their key is not `line-pr:`). */
  parserRowId: string | null;
  installment: boolean;
  identity: string;
  /** The line's flow when it was read (it outlives a line a re-import deleted). */
  flowId?: number | null;
};

export type CcLineMove = {
  from: CcLineRef;
  to: CcLineRef;
  by: "parser_row_id" | "identity" | "survivor" | "fan_out" | "matched";
  /**
   * Copy the rows instead of adopting (one printed line re-parsed into several: the extra lines get
   * copies; a new identical line beside a kept one gets the classification).
   */
  copy?: boolean;
  /** Carry only the category and big group (a copy onto a line that may be its own purchase). */
  classificationOnly?: boolean;
};

export type CcLineMovePlan = {
  moves: CcLineMove[];
  /** Vanished lines whose identity group has a different number of appeared lines. */
  ambiguous: CcLineRef[];
  /** The same, grouped with the appeared lines of their identity (id order). */
  ambiguousGroups: { olds: CcLineRef[]; news: CcLineRef[] }[];
  /** Appeared lines nothing vanished for, beside lines of their identity that stayed. */
  besideSurvivors: { survivors: CcLineRef[]; news: CcLineRef[] }[];
  /** Vanished lines with no appeared line of the same identity (deleted for real). */
  gone: CcLineRef[];
};

function merchantLettersAndDigits(merchant: string | null): string {
  return String(merchant ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

export function ccLineIdentity(row: CcLineIdentitySource): string {
  const usdCents = row.amount_usd == null ? "" : String(Math.round(row.amount_usd * 100));
  return [
    row.account_id,
    row.currency,
    statementLineDateIso(row) ?? "",
    row.amount_clp ?? "",
    usdCents,
    row.installment_flag,
    row.nro_cuota_current ?? "",
    row.nro_cuota_total ?? "",
    merchantLettersAndDigits(row.merchant),
  ].join("|");
}

function usableParserRowId(raw: string | null): string | null {
  const t = String(raw ?? "").trim();
  return t && !t.startsWith("synthetic:") ? t : null;
}

export function ccLineRefFromRow(
  row: CcLineIdentitySource & { id: number; parser_row_id: string | null; flow_id?: number | null }
): CcLineRef {
  return {
    flowId: row.flow_id ?? null,
    lineId: row.id,
    accountId: row.account_id,
    parserRowId: usableParserRowId(row.parser_row_id),
    installment: row.installment_flag === 1,
    identity: ccLineIdentity(row),
  };
}

export const CC_LINE_REF_SELECT = `
  SELECT l.id, s.account_id, s.currency, l.transaction_date, l.posting_date, l.merchant,
         ${lineAmountClpSql("l")} AS amount_clp, ${lineAmountUsdSql("l")} AS amount_usd, l.installment_flag, l.nro_cuota_current, l.nro_cuota_total,
         l.parser_row_id, l.flow_id
  FROM cc_statement_lines l
  JOIN cc_statements s ON s.id = l.statement_id`;

type CcLineRefRow = CcLineIdentitySource & { id: number; parser_row_id: string | null; flow_id: number | null };

export function listCcLineRefsForAccount(accountId: number): CcLineRef[] {
  const rows = db.prepare(`${CC_LINE_REF_SELECT} WHERE s.account_id = ?`).all(accountId) as CcLineRefRow[];
  return rows.map(ccLineRefFromRow);
}

/**
 * The recogniser: pairs each vanished line with the appeared line that is the same purchase (pure). `survivors`
 * are the lines present before and after; a vanished line nothing appeared for falls back to the
 * one survivor of its identity.
 */
export function planCcLineMoves(
  vanished: CcLineRef[],
  appeared: CcLineRef[],
  survivors: CcLineRef[] = []
): CcLineMovePlan {
  const moves: CcLineMove[] = [];
  const ambiguous: CcLineRef[] = [];
  const ambiguousGroups: { olds: CcLineRef[]; news: CcLineRef[] }[] = [];
  const besideSurvivors: { survivors: CcLineRef[]; news: CcLineRef[] }[] = [];
  const gone: CcLineRef[] = [];
  const claimed = new Set<number>();

  const appearedByPrid = new Map<string, CcLineRef>();
  for (const a of appeared) {
    if (a.parserRowId) appearedByPrid.set(`${a.accountId}|${a.parserRowId}`, a);
  }
  const rest: CcLineRef[] = [];
  for (const v of vanished) {
    const hit = v.parserRowId ? appearedByPrid.get(`${v.accountId}|${v.parserRowId}`) : undefined;
    if (hit && !claimed.has(hit.lineId)) {
      claimed.add(hit.lineId);
      moves.push({ from: v, to: hit, by: "parser_row_id" });
    } else {
      rest.push(v);
    }
  }

  const group = (refs: CcLineRef[]) => {
    const m = new Map<string, CcLineRef[]>();
    for (const r of refs) {
      const list = m.get(r.identity) ?? [];
      list.push(r);
      m.set(r.identity, list);
    }
    for (const list of m.values()) list.sort((a, b) => a.lineId - b.lineId);
    return m;
  };
  const appearedByIdentity = group(appeared.filter((a) => !claimed.has(a.lineId)));
  // A line re-inserted under the same parser_row_id (a replaced statement) stayed, too.
  const survivorsByIdentity = group([
    ...survivors,
    ...moves.filter((m) => m.by === "parser_row_id").map((m) => m.to),
  ]);
  const restByIdentity = group(rest);
  for (const [identity, news] of appearedByIdentity) {
    const kept = survivorsByIdentity.get(identity);
    if (kept && !restByIdentity.has(identity)) besideSurvivors.push({ survivors: kept, news });
  }
  for (const [identity, olds] of restByIdentity) {
    const news = appearedByIdentity.get(identity) ?? [];
    const kept = survivorsByIdentity.get(identity) ?? [];
    if (news.length === 0 && kept.length === 1) {
      for (const from of olds) moves.push({ from, to: kept[0]!, by: "survivor" });
    } else if (news.length === 0) {
      gone.push(...olds);
    } else if (news.length !== olds.length) {
      ambiguous.push(...olds);
      ambiguousGroups.push({ olds, news });
    } else {
      olds.forEach((from, i) => moves.push({ from, to: news[i]!, by: "identity" }));
    }
  }
  return { moves, ambiguous, ambiguousGroups, besideSurvivors, gone };
}


function linePrKey(ref: CcLineRef): string | null {
  return !ref.installment && ref.parserRowId ? buildExpenseKey({ kind: "line_pr", parserRowId: ref.parserRowId }) : null;
}

/**
 * A line's flow: the one read with it (it outlives a line a re-import deleted), else its current
 * one. A captured ref carries `flowId: null` when its flow went with the row ({@link captureCardLines}).
 */
function refFlowId(ref: CcLineRef): number | null {
  return ref.flowId !== undefined ? ref.flowId : rowFlowId("cc_statement_lines", ref.lineId);
}

/**
 * Where a line's key-named rows (category, note, big group) are: the flow its key answers to — the
 * line's own, unless an older flow still answers to that key — else the line's flow.
 */
function keyedRowsFlowId(ref: CcLineRef): number | null {
  const key = linePrKey(ref);
  return (key ? flowIdForKey(key) : null) ?? refFlowId(ref);
}

/** Holding tables whose rows sit on a portion and piece of the flow (the others: one set per flow). */
const KEYED_HOLDING_TABLES = new Set<string>(["flow_categories", "flow_notes", "flow_big_groups"]);

/** The tables where both flows hold a row (the arriving flow's row wins; reported). */
function holdingConflicts(a: number, b: number): string[] {
  return FLOW_HOLDING_TABLES.filter(
    (t) =>
      db
        .prepare(
          `SELECT 1 FROM ${t} x JOIN ${t} y ON y.flow_id = ? ${KEYED_HOLDING_TABLES.has(t) ? "AND y.portion = x.portion AND y.piece_seq = x.piece_seq" : ""}
           WHERE x.flow_id = ? LIMIT 1`
        )
        .get(b, a) != null
  );
}

/** Whether a flow holds anything a user put on it. */
function flowHoldsAssignments(flowId: number): boolean {
  return (
    FLOW_HOLDING_TABLES.some((t) => db.prepare(`SELECT 1 FROM ${t} WHERE flow_id = ?`).get(flowId) != null) ||
    db.prepare(`SELECT 1 FROM flow_links WHERE flow_id = ?`).get(flowId) != null
  );
}

export type CardLineAdoptionResult = {
  /** Lines that took over the flow of the line they replace. */
  adopted: number;
  /** Lines that got copies of another line's classification (a split re-parse, a new twin). */
  copied: number;
  /** Pairings that were not by the same parser row: by identity, a surviving copy, a split re-parse. */
  pairings: { by: CcLineMove["by"]; from_line_id: number; to_line_id: number }[];
  /** Both flows held a row in these tables; the arriving line's row was kept. */
  conflicts: { from_line_id: number; to_line_id: number; tables: string[] }[];
};

function emptyResult(): CardLineAdoptionResult {
  return { adopted: 0, copied: 0, pairings: [], conflicts: [] };
}

/** Copies the classification (and, unless `classificationOnly`, the note and pieces) onto a line. */
function copyAssignments(move: CcLineMove, out: CardLineAdoptionResult): void {
  const fromFlow = keyedRowsFlowId(move.from);
  const fromPartsFlow = refFlowId(move.from);
  const toKey = linePrKey(move.to);
  if (!flowExists(fromFlow) || !toKey) return;
  const tables = move.classificationOnly ? ["flow_categories", "flow_big_groups"] : ["flow_categories", "flow_big_groups", "flow_notes"];
  let copied = false;
  for (const t of tables) {
    const rows = db.prepare(`SELECT * FROM ${t} WHERE flow_id = ?`).all(fromFlow) as Record<string, unknown>[];
    if (rows.length === 0) continue;
    const toFlow = ensureFlowForKey(toKey);
    for (const r of rows) {
      const cols = Object.keys(r);
      const vals = cols.map((c) => (c === "flow_id" ? toFlow : r[c]));
      copied =
        db.prepare(`INSERT OR IGNORE INTO ${t} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...(vals as never[]))
          .changes > 0 || copied;
    }
  }
  if (!move.classificationOnly) {
    const toFlow = rowFlowId("cc_statement_lines", move.to.lineId);
    if (toFlow != null && db.prepare(`SELECT 1 FROM flow_parts WHERE flow_id = ?`).get(toFlow) == null) {
      copied =
        db
          .prepare(
            `INSERT INTO flow_parts (flow_id, seq, kind, category_id, amount, note, spent_on)
             SELECT ?, seq, kind, category_id, amount, note, spent_on FROM flow_parts WHERE flow_id = ?`
          )
          .run(toFlow, fromPartsFlow).changes > 0 || copied;
    }
  }
  if (copied) out.copied += 1;
}

/** Performs a plan's moves: adoption for a pair, copies for a fan-out's extra lines. */
export function adoptCardLineMoves(moves: readonly CcLineMove[]): CardLineAdoptionResult {
  const out = emptyResult();
  for (const move of moves) {
    if (move.by !== "parser_row_id") out.pairings.push({ by: move.by, from_line_id: move.from.lineId, to_line_id: move.to.lineId });
    if (move.copy) {
      copyAssignments(move, out);
      continue;
    }
    if (move.from.installment || move.to.installment) continue;
    // The replaced line's flow; when it went with its row (it held nothing), the flow its key
    // still answers to (an older flow of the same purchase).
    const lineFlow = refFlowId(move.from);
    const oldFlow = flowExists(lineFlow) ? lineFlow : keyedRowsFlowId(move.from);
    const newFlow = rowFlowId("cc_statement_lines", move.to.lineId) ?? refFlowId(move.to);
    if (!flowExists(oldFlow) || newFlow == null || oldFlow === newFlow) continue;
    if (move.by === "survivor") {
      // A removed duplicate copy: its flow folds into the copy that stayed, whose rows win.
      const tables = holdingConflicts(oldFlow, newFlow);
      if (tables.length > 0) out.conflicts.push({ from_line_id: move.from.lineId, to_line_id: move.to.lineId, tables });
      adoptFlow({ survivor: newFlow, arriving: oldFlow }, { prefer: "survivor" });
    } else {
      const tables = holdingConflicts(oldFlow, newFlow);
      if (tables.length > 0) out.conflicts.push({ from_line_id: move.from.lineId, to_line_id: move.to.lineId, tables });
      adoptFlow({ survivor: oldFlow, arriving: newFlow }, { prefer: "arriving", key: linePrKey(move.to), previousKey: linePrKey(move.from) });
    }
    out.adopted += 1;
  }
  return out;
}

/**
 * A re-parse that splits one printed line into several (or merges several into one) leaves an
 * identity group whose counts differ. When every old line of it carries the same assignments, they
 * belong to each new line alike: the old lines pair in order and the extra new lines get copies
 * (extra old lines fold into the first new one). A group whose old lines disagree stays unpaired.
 */
export function fanOutUniformGroups(groups: readonly { olds: CcLineRef[]; news: CcLineRef[] }[]): {
  moves: CcLineMove[];
  fannedOut: Set<number>;
} {
  const moves: CcLineMove[] = [];
  const fannedOut = new Set<number>();
  for (const { olds, news } of groups) {
    const sigs = olds.map(assignmentSignature);
    if (sigs[0] == null || sigs.some((x) => x !== sigs[0])) continue;
    const n = Math.min(olds.length, news.length);
    // Copies first: the adoptions below fold the source flows away.
    for (let i = n; i < news.length; i++) moves.push({ from: olds[0]!, to: news[i]!, by: "fan_out", copy: true });
    for (let i = 0; i < n; i++) moves.push({ from: olds[i]!, to: news[i]!, by: "fan_out" });
    for (let i = n; i < olds.length; i++) moves.push({ from: olds[i]!, to: news[0]!, by: "fan_out" });
    for (const o of olds) fannedOut.add(o.lineId);
  }
  return { moves, fannedOut };
}

/**
 * A re-parse that now prints a line twice where it kept one (the kept line's flow stays on it): the
 * new siblings copy the category and big group every kept line of their identity carries, when they
 * agree. Never the note or pieces — an identical same-day charge can be its own purchase.
 */
export function copyOntoNewSiblings(groups: readonly { survivors: CcLineRef[]; news: CcLineRef[] }[]): CcLineMove[] {
  const moves: CcLineMove[] = [];
  for (const { survivors, news } of groups) {
    const sigs = survivors.map(assignmentSignature);
    if (sigs[0] == null || sigs.some((x) => x !== sigs[0])) continue;
    for (const n of news) {
      if (assignmentSignature(n) == null) {
        moves.push({ from: survivors[0]!, to: n, by: "fan_out", copy: true, classificationOnly: true });
      }
    }
  }
  return moves;
}

/** What a line's flow carries, comparable across lines (null when it carries nothing). */
function assignmentSignature(ref: CcLineRef): string | null {
  const flowId = keyedRowsFlowId(ref);
  const partsFlowId = refFlowId(ref);
  if (!flowExists(flowId)) return null;
  const parts = [
    ...["flow_categories", "flow_big_groups", "flow_notes"].map((t) =>
      db.prepare(`SELECT portion, piece_seq, ${t === "flow_categories" ? "category_id" : t === "flow_notes" ? "notes" : "group_slug"} AS v FROM ${t} WHERE flow_id = ? ORDER BY portion, piece_seq`).all(flowId)
    ),
    db.prepare(`SELECT seq, kind, category_id, amount, note FROM flow_parts WHERE flow_id = ? ORDER BY seq`).all(partsFlowId),
  ];
  return parts.every((p) => p.length === 0) ? null : JSON.stringify(parts);
}

/** Lines of an account before a re-import writes (see {@link adoptReimportedCardLines}). */
export type CardLineCapture = {
  accountId: number;
  lines: CcLineRef[];
  /**
   * The day each line's flow first reached the ledger, by line id: a bare flow goes with its row
   * on a re-import, so the day is read before the write and carried onto the line that replaces it.
   */
  firstSeenByLineId: Map<number, string>;
};

export function captureCardLines(accountId: number): CardLineCapture {
  // A flow that holds nothing and answers to no key goes with its row, and `flows` reuses ids: only
  // a flow that outlives its row (retired, migration 290) is remembered.
  const lines = listCcLineRefsForAccount(accountId).map((r) =>
    r.flowId != null && !flowOutlivesRows(r.flowId) ? { ...r, flowId: null } : r
  );
  return { accountId, lines, firstSeenByLineId: cardLineFirstSeenForAccount(accountId) };
}

function flowOutlivesRows(flowId: number): boolean {
  const keyed = db.prepare(`SELECT 1 FROM flows WHERE id = ? AND legacy_key IS NOT NULL`).get(flowId) != null;
  return keyed || flowHoldsAssignments(flowId);
}

export type ReimportedCardLinesResult = CardLineAdoptionResult & {
  /** Vanished lines holding assignments that no appeared line could be paired with (their flow stays retired). */
  unpaired: { lineId: number; parserRowId: string | null; reason: "ambiguous" | "gone" }[];
};

/**
 * After a re-import: pairs the lines that vanished with those that appeared, and each appeared line
 * takes over the flow of the line it replaces. A line gone for real (a deleted duplicate) leaves its
 * flow retired with its assignments — reported, not an error.
 */
export function adoptReimportedCardLines(capture: CardLineCapture): ReimportedCardLinesResult {
  const now = listCcLineRefsForAccount(capture.accountId);
  const sig = (r: CcLineRef) => `${r.lineId}|${r.parserRowId ?? ""}`;
  const before = new Set(capture.lines.map(sig));
  const after = new Set(now.map(sig));
  const vanished = capture.lines.filter((r) => !after.has(sig(r)));
  const appeared = now.filter((r) => !before.has(sig(r)));
  const survivors = now.filter((r) => before.has(sig(r)));
  if (vanished.length === 0 && appeared.length === 0) return { ...emptyResult(), unpaired: [] };
  const plan = planCcLineMoves(vanished, appeared, survivors);
  const fan = fanOutUniformGroups(plan.ambiguousGroups);
  const applied = adoptCardLineMoves([...plan.moves, ...fan.moves]);
  carryFirstSeenOntoReplacingLines([...plan.moves, ...fan.moves], capture.firstSeenByLineId);
  // After the adoptions: a kept line's flow carries what its twin's had by now.
  const siblings = adoptCardLineMoves(copyOntoNewSiblings(plan.besideSurvivors));
  applied.copied += siblings.copied;
  applied.pairings.push(...siblings.pairings);
  const held = (r: CcLineRef) => {
    const f = refFlowId(r);
    return flowExists(f) && flowHoldsAssignments(f);
  };
  const unpaired = [
    ...plan.ambiguous.filter((r) => !fan.fannedOut.has(r.lineId)).map((r) => ({ r, reason: "ambiguous" as const })),
    ...plan.gone.map((r) => ({ r, reason: "gone" as const })),
  ]
    .filter(({ r }) => held(r))
    .map(({ r, reason }) => ({ lineId: r.lineId, parserRowId: r.parserRowId, reason }));
  return { ...applied, unpaired };
}

/**
 * A replacing line's flow keeps the earlier first-seen day of the two: the re-imported line was
 * recorded today, the line it replaces may have arrived long before (its flow may already be gone).
 * Not onto a new sibling beside a kept line (it may be its own purchase), nor across cuota lines
 * (their flow is their plan's).
 */
function carryFirstSeenOntoReplacingLines(moves: readonly CcLineMove[], firstSeenByLineId: Map<number, string>): void {
  for (const move of moves) {
    if (move.from.installment || move.to.installment) continue;
    const day = firstSeenByLineId.get(move.from.lineId);
    if (!day) continue;
    const flow = rowFlowId("cc_statement_lines", move.to.lineId);
    if (flow != null) keepEarlierFlowFirstSeen(flow, day);
  }
}

/**
 * Each line's replacement takes over its flow, for callers that already know the pair (their
 * recognisers paired them across different merchants, so identity pairing cannot) — a pasted/fed
 * line settled by the statement that bills it, a cut or pending re-listing dropped for its fuller
 * twin, a planted payment replaced by the bank's line, a pending listing replaced by the posted one.
 * Call before deleting the `from` lines. What lives outside the flow (a per-line category, a
 * merchant rule) is the caller's to carry (`ccCrossImportDedupe.applyCardLinePlan`).
 */
export function adoptReplacingCardLines(pairs: readonly { fromLineId: number; toLineId: number }[]): CardLineAdoptionResult {
  const out = emptyResult();
  if (pairs.length === 0) return out;
  const ids = [...new Set(pairs.flatMap((p) => [p.fromLineId, p.toLineId]))];
  const rows = db
    .prepare(`${CC_LINE_REF_SELECT} WHERE l.id IN (${ids.map(() => "?").join(",")})`)
    .all(...ids) as CcLineRefRow[];
  const byId = new Map(rows.map((r) => [r.id, ccLineRefFromRow(r)]));
  const moves: CcLineMove[] = [];
  for (const p of pairs) {
    const from = byId.get(p.fromLineId);
    const to = byId.get(p.toLineId);
    if (!from || !to) throw new Error(`adoptReplacingCardLines: line ${!from ? p.fromLineId : p.toLineId} not found`);
    moves.push({ from, to, by: "matched" });
  }
  return adoptCardLineMoves(moves);
}

/**
 * A line's own category override (`cc_expense_line_categories`) names the line by id and cascades
 * with it, so a statement re-import that replaces a statement's lines snapshots them first and puts
 * each back on the line that comes back with the same parser row (else the same dedupe key). The
 * flow-keyed assignments need no snapshot: the re-imported line adopts its flow.
 */
export type LineCategorySnapshot = { byParserRowId: Map<string, number>; byDedupeKey: Map<string, number> };

export function snapshotLineCategories(accountId: number): LineCategorySnapshot {
  const byParserRowId = new Map<string, number>();
  const byDedupeKey = new Map<string, number>();
  const rows = db
    .prepare(
      `SELECT l.parser_row_id, l.dedupe_key, lc.category_id
       FROM cc_expense_line_categories lc
       JOIN cc_statement_lines l ON l.id = lc.statement_line_id
       JOIN cc_statements s ON s.id = l.statement_id
       WHERE s.account_id = ?`
    )
    .all(accountId) as { parser_row_id: string | null; dedupe_key: string | null; category_id: number }[];
  for (const r of rows) {
    const prid = String(r.parser_row_id ?? "").trim();
    if (prid) byParserRowId.set(prid, r.category_id);
    const dedupe = String(r.dedupe_key ?? "").trim();
    if (dedupe) byDedupeKey.set(dedupe, r.category_id);
  }
  return { byParserRowId, byDedupeKey };
}

/** Puts the snapshot's overrides back on the account's lines; returns how many lines got one. */
export function restoreLineCategories(accountId: number, snap: LineCategorySnapshot): number {
  const put = db.prepare(
    `INSERT INTO cc_expense_line_categories (statement_line_id, category_id) VALUES (?, ?)
     ON CONFLICT(statement_line_id) DO UPDATE SET category_id = excluded.category_id`
  );
  const lines = db
    .prepare(
      `SELECT l.id, l.parser_row_id, l.dedupe_key FROM cc_statement_lines l
       JOIN cc_statements s ON s.id = l.statement_id WHERE s.account_id = ?`
    )
    .all(accountId) as { id: number; parser_row_id: string | null; dedupe_key: string | null }[];
  let restored = 0;
  for (const l of lines) {
    let categoryId = snap.byParserRowId.get(String(l.parser_row_id ?? "").trim());
    if (categoryId == null) {
      const dedupe = String(l.dedupe_key ?? "").trim();
      if (dedupe) categoryId = snap.byDedupeKey.get(dedupe);
    }
    if (categoryId == null) continue;
    put.run(l.id, categoryId);
    restored += 1;
  }
  return restored;
}
