/**
 * Carries a card line's expense assignments across a re-import that gives the line a new row.
 *
 * A one-shot line's category («Único» row), big group and note are keyed `line-pr:<parser_row_id>`,
 * and its category splits by `cc_statement_lines.id`. A re-import replaces a statement's lines: the
 * ids always change, and the parser_row_id changes whenever the parser's rendering of the row does
 * (a parser fix, a PDF taking over a JSON close). Without this, every such re-import silently left
 * the assignments on a key no line carries and the purchase read «sin categoría» again — 686 keys
 * and every card split had been lost that way by 2026-09-28.
 *
 * A line that vanished is paired with one that appeared: first by the same parser_row_id (only the
 * id moved), then by identity — account, statement currency, date, amounts, cuota numbers and the
 * merchant's letters and digits. Identical twins pair in id order (print order), as twin plans do;
 * a group whose counts disagree is left alone and reported, never guessed. A line with no appeared
 * counterpart whose identity matches exactly one line that stayed is a removed duplicate copy of
 * that purchase (the same statement filed twice): its assignments go to the copy that stayed.
 */
import { db } from "./db.js";
import { statementLineDateIso } from "./ccInstallmentPayBy.js";
import {
  isGenericTransferMerchantKey,
  merchantRuleKeysMatchingLineMerchant,
  normalizeCcExpenseMerchantKey,
} from "./ccExpenseCategories.js";

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
};

export type CcLineMove = {
  from: CcLineRef;
  to: CcLineRef;
  by: "parser_row_id" | "identity" | "survivor" | "fan_out" | "matched";
  /** Copy the rows (the source also feeds other targets); the last move of a source moves them. */
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

export function ccLineRefFromRow(row: CcLineIdentitySource & { id: number; parser_row_id: string | null }): CcLineRef {
  return {
    lineId: row.id,
    accountId: row.account_id,
    parserRowId: usableParserRowId(row.parser_row_id),
    installment: row.installment_flag === 1,
    identity: ccLineIdentity(row),
  };
}

export const CC_LINE_REF_SELECT = `
  SELECT l.id, s.account_id, s.currency, l.transaction_date, l.posting_date, l.merchant,
         l.amount_clp, l.amount_usd, l.installment_flag, l.nro_cuota_current, l.nro_cuota_total,
         l.parser_row_id
  FROM cc_statement_lines l
  JOIN cc_statements s ON s.id = l.statement_id`;

type CcLineRefRow = CcLineIdentitySource & { id: number; parser_row_id: string | null };

export function listCcLineRefsForAccount(accountId: number): CcLineRef[] {
  const rows = db.prepare(`${CC_LINE_REF_SELECT} WHERE s.account_id = ?`).all(accountId) as CcLineRefRow[];
  return rows.map(ccLineRefFromRow);
}

/**
 * Pairs each vanished line with the appeared line that is the same purchase (pure). `survivors`
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

type KeyedTable = "cc_expense_unique_purchases" | "cc_expense_purchase_big_groups" | "cc_expense_purchase_notes";

/** `accountScoped`: the row is keyed by (account, purchase key); big groups by the key alone. */
const KEYED_TABLES: { table: KeyedTable; column: string; accountScoped: boolean }[] = [
  { table: "cc_expense_unique_purchases", column: "category_id", accountScoped: true },
  { table: "cc_expense_purchase_big_groups", column: "group_slug", accountScoped: false },
  { table: "cc_expense_purchase_notes", column: "notes", accountScoped: true },
];

/** WHERE clause + params naming one keyed row of `spec`. */
function keyedRow(
  spec: { accountScoped: boolean },
  accountId: number,
  key: string
): { where: string; params: (number | string)[] } {
  return spec.accountScoped
    ? { where: "account_id = ? AND purchase_key = ?", params: [accountId, key] }
    : { where: "purchase_key = ?", params: [key] };
}

export type CcLineMoveConflict = {
  table: KeyedTable | "cc_expense_line_splits";
  from: string;
  to: string;
  stored: unknown;
  current: unknown;
};

export type CcLineMoveApplyResult = {
  moved: Record<KeyedTable | "cc_expense_line_splits", number>;
  /** Orphan rows dropped because the target already holds the same value. */
  duplicates_removed: number;
  /** Target rows overwritten with the stored value (`preferStoredKeys`). */
  overridden: number;
  /** «Único» rows without a category left where they were (`skipCategorylessUnique`). */
  categoryless_unique_skipped: number;
  /** Category rows left behind by `keepCurrentCategoryKeys`. */
  kept_current: number;
  conflicts: CcLineMoveConflict[];
};

function linePrKey(ref: CcLineRef): string | null {
  return !ref.installment && ref.parserRowId ? `line-pr:${ref.parserRowId}` : null;
}

/** True when the line holds anything these moves carry (a `line-pr:` row or a card split). */
export function ccLineHasExpenseAssignments(ref: CcLineRef): boolean {
  const key = linePrKey(ref);
  if (key) {
    for (const spec of KEYED_TABLES) {
      const row = keyedRow(spec, ref.accountId, key);
      if (db.prepare(`SELECT 1 FROM ${spec.table} WHERE ${row.where}`).get(...row.params)) {
        return true;
      }
    }
  }
  return db.prepare(`SELECT 1 FROM cc_expense_line_splits WHERE source = 'cc' AND line_id = ?`).get(ref.lineId) != null;
}

/**
 * Moves each vanished line's rows onto its pair. A target that already holds a row keeps it
 * (reported as a conflict) unless the stored key is in `preferStoredKeys`; an identical orphan is
 * dropped. Call inside the caller's transaction.
 */
export function applyCcLineMoves(
  moves: CcLineMove[],
  opts?: {
    preferStoredKeys?: ReadonlySet<string>;
    /**
     * Leave «Único» rows with no category behind: such a row shows its line as unclassified over
     * any merchant rule, so a repair that carries one only takes a category away.
     */
    skipCategorylessUnique?: boolean;
    /** Stored keys whose category row stays where it is (the line keeps what it shows today). */
    keepCurrentCategoryKeys?: ReadonlySet<string>;
  }
): CcLineMoveApplyResult {
  const out: CcLineMoveApplyResult = {
    moved: {
      cc_expense_unique_purchases: 0,
      cc_expense_purchase_big_groups: 0,
      cc_expense_purchase_notes: 0,
      cc_expense_line_splits: 0,
    },
    duplicates_removed: 0,
    overridden: 0,
    categoryless_unique_skipped: 0,
    kept_current: 0,
    conflicts: [],
  };
  for (const move of moves) {
    const { from, to } = move;
    const fromKey = linePrKey(from);
    const toKey = linePrKey(to);
    if (fromKey && toKey && fromKey !== toKey && from.accountId === to.accountId) {
      for (const spec of KEYED_TABLES) {
        const { table, column } = spec;
        if (move.classificationOnly && table === "cc_expense_purchase_notes") continue;
        const fromRow = keyedRow(spec, from.accountId, fromKey);
        const toRow = keyedRow(spec, to.accountId, toKey);
        const get = (r: { where: string; params: (number | string)[] }) =>
          db.prepare(`SELECT ${column} AS v FROM ${table} WHERE ${r.where}`).get(...r.params) as
            | { v: unknown }
            | undefined;
        const stored = get(fromRow);
        if (!stored) continue;
        if (opts?.skipCategorylessUnique && table === "cc_expense_unique_purchases" && stored.v == null) {
          out.categoryless_unique_skipped += 1;
          continue;
        }
        if (table === "cc_expense_unique_purchases" && opts?.keepCurrentCategoryKeys?.has(fromKey)) {
          out.kept_current += 1;
          continue;
        }
        const current = get(toRow);
        const del = () => db.prepare(`DELETE FROM ${table} WHERE ${fromRow.where}`).run(...fromRow.params);
        const targetEmpty =
          !current || (table === "cc_expense_purchase_notes" && String(current.v ?? "").trim() === "");
        if (targetEmpty) {
          if (current) db.prepare(`DELETE FROM ${table} WHERE ${toRow.where}`).run(...toRow.params);
          if (move.copy) {
            if (spec.accountScoped) {
              db.prepare(`INSERT INTO ${table} (account_id, purchase_key, ${column}) VALUES (?, ?, ?)`).run(
                to.accountId,
                toKey,
                stored.v as string | number | null
              );
            } else {
              db.prepare(`INSERT INTO ${table} (purchase_key, ${column}) VALUES (?, ?)`).run(
                toKey,
                stored.v as string | number | null
              );
            }
          } else {
            db.prepare(`UPDATE ${table} SET purchase_key = ? WHERE ${fromRow.where}`).run(toKey, ...fromRow.params);
          }
          out.moved[table] += 1;
        } else if (current.v === stored.v) {
          if (!move.copy) del();
          out.duplicates_removed += 1;
        } else if (opts?.preferStoredKeys?.has(fromKey)) {
          db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${toRow.where}`).run(
            stored.v as string | number | null,
            ...toRow.params
          );
          if (!move.copy) del();
          out.overridden += 1;
        } else {
          out.conflicts.push({ table, from: fromKey, to: toKey, stored: stored.v, current: current.v });
        }
      }
    }
    if (from.lineId !== to.lineId && !move.classificationOnly) {
      const splits = db
        .prepare(`SELECT COUNT(*) AS n FROM cc_expense_line_splits WHERE source = 'cc' AND line_id = ?`)
        .get(from.lineId) as { n: number };
      if (splits.n === 0) continue;
      const targetSplits = db
        .prepare(`SELECT COUNT(*) AS n FROM cc_expense_line_splits WHERE source = 'cc' AND line_id = ?`)
        .get(to.lineId) as { n: number };
      if (targetSplits.n > 0) {
        out.conflicts.push({
          table: "cc_expense_line_splits",
          from: `line:${from.lineId}`,
          to: `line:${to.lineId}`,
          stored: splits.n,
          current: targetSplits.n,
        });
        continue;
      }
      if (move.copy) {
        db.prepare(
          `INSERT INTO cc_expense_line_splits (source, line_id, seq, category_id, amount_clp, note, spent_on)
           SELECT source, ?, seq, category_id, amount_clp, note, spent_on FROM cc_expense_line_splits
           WHERE source = 'cc' AND line_id = ?`
        ).run(to.lineId, from.lineId);
      } else {
        db.prepare(`UPDATE cc_expense_line_splits SET line_id = ? WHERE source = 'cc' AND line_id = ?`).run(
          to.lineId,
          from.lineId
        );
      }
      out.moved.cc_expense_line_splits += splits.n;
    }
  }
  return out;
}

/** What a line carries, comparable across lines (null when it carries nothing). */
function assignmentSignature(ref: CcLineRef): string | null {
  const key = linePrKey(ref);
  const parts: unknown[] = [];
  if (key) {
    for (const spec of KEYED_TABLES) {
      const row = keyedRow(spec, ref.accountId, key);
      const r = db
        .prepare(`SELECT ${spec.column} AS v FROM ${spec.table} WHERE ${row.where}`)
        .get(...row.params) as { v: unknown } | undefined;
      parts.push(r ? ["row", r.v] : null);
    }
  }
  const splits = db
    .prepare(`SELECT seq, category_id, amount_clp, note FROM cc_expense_line_splits WHERE source = 'cc' AND line_id = ? ORDER BY seq`)
    .all(ref.lineId);
  parts.push(splits);
  const sig = JSON.stringify(parts);
  return parts.every((p) => p == null || (Array.isArray(p) && p.length === 0)) ? null : sig;
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
    // Copies first: the pairing moves below move the source rows away.
    for (let i = n; i < news.length; i++) moves.push({ from: olds[0]!, to: news[i]!, by: "fan_out", copy: true });
    for (let i = 0; i < n; i++) moves.push({ from: olds[i]!, to: news[i]!, by: "fan_out" });
    for (let i = n; i < olds.length; i++) moves.push({ from: olds[i]!, to: news[0]!, by: "fan_out" });
    for (const o of olds) fannedOut.add(o.lineId);
  }
  return { moves, fannedOut };
}

/**
 * A re-parse that now prints a line twice where it kept one (the kept line's rows stay on it):
 * the new siblings copy the category and big group every kept line of their identity carries,
 * when they agree. Never the note or splits — an identical same-day charge can be its own purchase.
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

/** Lines of an account before a re-import writes (see {@link rekeyCcExpenseLinesAfterImport}). */
export type CcExpenseLineCapture = { accountId: number; lines: CcLineRef[] };

export function captureCcExpenseLines(accountId: number): CcExpenseLineCapture {
  return { accountId, lines: listCcLineRefsForAccount(accountId) };
}

export type CcExpenseLineRekeyResult = CcLineMoveApplyResult & {
  /** Vanished lines holding assignments that no appeared line could be paired with. */
  unpaired: { lineId: number; parserRowId: string | null; reason: "ambiguous" | "gone" }[];
};

/**
 * After a re-import: pairs the lines that vanished with those that appeared and moves the
 * assignments of every vanished line that held any. A line that is gone for real (a deleted
 * duplicate) keeps its rows orphaned, as before — reported, not an error.
 */
export function rekeyCcExpenseLinesAfterImport(capture: CcExpenseLineCapture): CcExpenseLineRekeyResult {
  const now = listCcLineRefsForAccount(capture.accountId);
  const sig = (r: CcLineRef) => `${r.lineId}|${r.parserRowId ?? ""}`;
  const before = new Set(capture.lines.map(sig));
  const after = new Set(now.map(sig));
  const vanished = capture.lines.filter((r) => !after.has(sig(r)));
  const appeared = now.filter((r) => !before.has(sig(r)));
  const survivors = now.filter((r) => before.has(sig(r)));
  const empty: CcExpenseLineRekeyResult = {
    moved: {
      cc_expense_unique_purchases: 0,
      cc_expense_purchase_big_groups: 0,
      cc_expense_purchase_notes: 0,
      cc_expense_line_splits: 0,
    },
    duplicates_removed: 0,
    overridden: 0,
    categoryless_unique_skipped: 0,
    kept_current: 0,
    conflicts: [],
    unpaired: [],
  };
  if (vanished.length === 0 && appeared.length === 0) return empty;
  const plan = planCcLineMoves(vanished, appeared, survivors);
  const keyedMoves = plan.moves.filter((m) => ccLineHasExpenseAssignments(m.from));
  const fan = fanOutUniformGroups(plan.ambiguousGroups);
  const applied = applyCcLineMoves([...keyedMoves, ...fan.moves]);
  // After the moves: a kept line's splits have followed it to its new id by now.
  const siblings = applyCcLineMoves(copyOntoNewSiblings(plan.besideSurvivors));
  for (const t of Object.keys(applied.moved) as (keyof CcLineMoveApplyResult["moved"])[]) {
    applied.moved[t] += siblings.moved[t];
  }
  applied.duplicates_removed += siblings.duplicates_removed;
  applied.conflicts.push(...siblings.conflicts);
  const unpaired = [
    ...plan.ambiguous.filter((r) => !fan.fannedOut.has(r.lineId)).map((r) => ({ r, reason: "ambiguous" as const })),
    ...plan.gone.map((r) => ({ r, reason: "gone" as const })),
  ]
    .filter(({ r }) => ccLineHasExpenseAssignments(r))
    .map(({ r, reason }) => ({ lineId: r.lineId, parserRowId: r.parserRowId, reason }));
  return { ...applied, unpaired };
}

export type CcExpenseCarryResult = {
  /** The line-keyed rows and splits moved onto the replacing lines (null when none held any). */
  moves: CcLineMoveApplyResult | null;
  /** Per-line category overrides copied onto the replacing line. */
  line_categories_copied: number;
  /** Merchant rules added under the replacing line's merchant name. */
  merchant_rules_copied: { account_id: number; from: string; to: string }[];
};

/**
 * Carries each line's assignments onto the line that replaces it, for callers that already know
 * the pair — a pasted/fed line settled by the statement that bills it, a cut or pending re-listing
 * dropped for its fuller twin. Their merchants differ, so identity pairing cannot find them.
 * Call before deleting the `from` lines.
 *
 * Besides the line-keyed rows, the replacing line gets the category its predecessor showed through
 * the two other channels: a per-line override (keyed by line id, so it would cascade away with the
 * deleted line) and a merchant rule. The statement prints the merchant under another name than the
 * paste («FARMACIA CENTRAL (T)» for «FARMACIA CENTRAL» on BCI), so a rule on the pasted
 * name stops applying the day the statement arrives; when no rule reaches the statement's name,
 * the same rule is added under it — which also covers that merchant's later statement lines.
 */
export function carryCcExpenseAssignments(
  pairs: readonly { fromLineId: number; toLineId: number }[]
): CcExpenseCarryResult | null {
  if (pairs.length === 0) return null;
  const ids = [...new Set(pairs.flatMap((p) => [p.fromLineId, p.toLineId]))];
  const rows = db
    .prepare(`${CC_LINE_REF_SELECT} WHERE l.id IN (${ids.map(() => "?").join(",")})`)
    .all(...ids) as CcLineRefRow[];
  const rowById = new Map(rows.map((r) => [r.id, r]));
  const byId = new Map(rows.map((r) => [r.id, ccLineRefFromRow(r)]));
  const moves: CcLineMove[] = [];
  for (const p of pairs) {
    const from = byId.get(p.fromLineId);
    const to = byId.get(p.toLineId);
    if (!from || !to) throw new Error(`carryCcExpenseAssignments: line ${!from ? p.fromLineId : p.toLineId} not found`);
    if (ccLineHasExpenseAssignments(from)) moves.push({ from, to, by: "matched" });
  }
  const out: CcExpenseCarryResult = {
    moves: moves.length > 0 ? applyCcLineMoves(moves) : null,
    line_categories_copied: 0,
    merchant_rules_copied: [],
  };

  const lineCategory = db.prepare(
    `SELECT category_id FROM cc_expense_line_categories WHERE statement_line_id = ?`
  );
  const insertLineCategory = db.prepare(
    `INSERT INTO cc_expense_line_categories (statement_line_id, category_id) VALUES (?, ?)`
  );
  const ruleCategory = db.prepare(
    `SELECT category_id FROM cc_expense_merchant_categories WHERE account_id = ? AND merchant_key = ?`
  );
  const insertRule = db.prepare(
    `INSERT INTO cc_expense_merchant_categories (account_id, merchant_key, category_id) VALUES (?, ?, ?)`
  );
  for (const p of pairs) {
    const from = rowById.get(p.fromLineId)!;
    const to = rowById.get(p.toLineId)!;
    const fromLine = lineCategory.get(from.id) as { category_id: number } | undefined;
    if (fromLine && lineCategory.get(to.id) == null) {
      insertLineCategory.run(to.id, fromLine.category_id);
      out.line_categories_copied += 1;
    }

    if (from.account_id !== to.account_id) continue;
    const fromKey = normalizeCcExpenseMerchantKey(from.merchant);
    const toKey = normalizeCcExpenseMerchantKey(to.merchant);
    if (!fromKey || !toKey || fromKey === toKey || isGenericTransferMerchantKey(toKey)) continue;
    const [fromRuleKey] = merchantRuleKeysMatchingLineMerchant(from.account_id, fromKey);
    if (fromRuleKey == null) continue;
    if (merchantRuleKeysMatchingLineMerchant(to.account_id, toKey).length > 0) continue;
    const rule = ruleCategory.get(from.account_id, fromRuleKey) as { category_id: number };
    insertRule.run(to.account_id, toKey, rule.category_id);
    out.merchant_rules_copied.push({ account_id: to.account_id, from: fromRuleKey, to: toKey });
  }
  return out;
}
