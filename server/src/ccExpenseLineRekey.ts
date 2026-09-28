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

export type CcLineMove = { from: CcLineRef; to: CcLineRef; by: "parser_row_id" | "identity" | "survivor" };

export type CcLineMovePlan = {
  moves: CcLineMove[];
  /** Vanished lines whose identity group has a different number of appeared lines. */
  ambiguous: CcLineRef[];
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
  const survivorsByIdentity = group(survivors);
  for (const [identity, olds] of group(rest)) {
    const news = appearedByIdentity.get(identity) ?? [];
    const kept = survivorsByIdentity.get(identity) ?? [];
    if (news.length === 0 && kept.length === 1) {
      for (const from of olds) moves.push({ from, to: kept[0]!, by: "survivor" });
    } else if (news.length === 0) {
      gone.push(...olds);
    } else if (news.length !== olds.length) {
      ambiguous.push(...olds);
    } else {
      olds.forEach((from, i) => moves.push({ from, to: news[i]!, by: "identity" }));
    }
  }
  return { moves, ambiguous, gone };
}

type KeyedTable = "cc_expense_unique_purchases" | "cc_expense_purchase_big_groups" | "cc_expense_purchase_notes";

const KEYED_TABLES: { table: KeyedTable; column: string }[] = [
  { table: "cc_expense_unique_purchases", column: "category_id" },
  { table: "cc_expense_purchase_big_groups", column: "group_slug" },
  { table: "cc_expense_purchase_notes", column: "notes" },
];

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
    for (const { table } of KEYED_TABLES) {
      if (db.prepare(`SELECT 1 FROM ${table} WHERE account_id = ? AND purchase_key = ?`).get(ref.accountId, key)) {
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
  for (const { from, to } of moves) {
    const fromKey = linePrKey(from);
    const toKey = linePrKey(to);
    if (fromKey && toKey && fromKey !== toKey && from.accountId === to.accountId) {
      for (const { table, column } of KEYED_TABLES) {
        const get = db.prepare(`SELECT ${column} AS v FROM ${table} WHERE account_id = ? AND purchase_key = ?`);
        const stored = get.get(from.accountId, fromKey) as { v: unknown } | undefined;
        if (!stored) continue;
        if (opts?.skipCategorylessUnique && table === "cc_expense_unique_purchases" && stored.v == null) {
          out.categoryless_unique_skipped += 1;
          continue;
        }
        if (table === "cc_expense_unique_purchases" && opts?.keepCurrentCategoryKeys?.has(fromKey)) {
          out.kept_current += 1;
          continue;
        }
        const current = get.get(to.accountId, toKey) as { v: unknown } | undefined;
        const del = () =>
          db.prepare(`DELETE FROM ${table} WHERE account_id = ? AND purchase_key = ?`).run(from.accountId, fromKey);
        const targetEmpty =
          !current || (table === "cc_expense_purchase_notes" && String(current.v ?? "").trim() === "");
        if (targetEmpty) {
          if (current) db.prepare(`DELETE FROM ${table} WHERE account_id = ? AND purchase_key = ?`).run(to.accountId, toKey);
          db.prepare(`UPDATE ${table} SET purchase_key = ? WHERE account_id = ? AND purchase_key = ?`).run(
            toKey,
            from.accountId,
            fromKey
          );
          out.moved[table] += 1;
        } else if (current.v === stored.v) {
          del();
          out.duplicates_removed += 1;
        } else if (opts?.preferStoredKeys?.has(fromKey)) {
          db.prepare(`UPDATE ${table} SET ${column} = ? WHERE account_id = ? AND purchase_key = ?`).run(
            stored.v,
            to.accountId,
            toKey
          );
          del();
          out.overridden += 1;
        } else {
          out.conflicts.push({ table, from: fromKey, to: toKey, stored: stored.v, current: current.v });
        }
      }
    }
    if (from.lineId !== to.lineId) {
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
      db.prepare(`UPDATE cc_expense_line_splits SET line_id = ? WHERE source = 'cc' AND line_id = ?`).run(
        to.lineId,
        from.lineId
      );
      out.moved.cc_expense_line_splits += splits.n;
    }
  }
  return out;
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
  if (vanished.length === 0) return empty;
  const plan = planCcLineMoves(vanished, appeared, survivors);
  const keyedMoves = plan.moves.filter((m) => ccLineHasExpenseAssignments(m.from));
  const applied = applyCcLineMoves(keyedMoves);
  const unpaired = [
    ...plan.ambiguous.map((r) => ({ r, reason: "ambiguous" as const })),
    ...plan.gone.map((r) => ({ r, reason: "gone" as const })),
  ]
    .filter(({ r }) => ccLineHasExpenseAssignments(r))
    .map(({ r, reason }) => ({ lineId: r.lineId, parserRowId: r.parserRowId, reason }));
  return { ...applied, unpaired };
}
