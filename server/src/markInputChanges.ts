import { accountBucketKindSlug } from "./accountBucket.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { db } from "./db.js";
import {
  clearMarkSeries,
  markSeriesStoreSize,
  trimAccountMarkSeries,
  trimAllMarkSeries,
} from "./markSeriesStore.js";

/**
 * The waterfall behind the per-account mark cache: triggers on every table a historical mark
 * reads (migration 211, `markInputChangeTriggers211.ts`) write a row to `mark_input_changes`
 * naming the table, the account (none: an input every account can read — prices, fx, UF, fund
 * units, the nav tree) and the raw date — in whichever connection wrote it, so a CLI script's
 * writes count too and no caller has to remember an invalidation. Before serving cached marks,
 * the pending rows are applied: each affected series keeps the days before the change and
 * drops the rest. `SOURCE_RULES` says how far back each table reaches.
 *
 * Accounts that share inputs are trimmed together: the depto property and mortgage read one
 * ledger (`DEPENDENT_KINDS`). Transfers name both of their accounts in the row itself.
 *
 * The consumer remembers the last row it applied. Rows are pruned after a few days
 * (`pruneMarkInputChanges`); a consumer that finds its next row already pruned has missed
 * changes and drops every series.
 */

let lastAppliedId: number | null = null;

export type MarkInputsChange = {
  /** Every account was trimmed (from some date). */
  all: boolean;
  /** Accounts trimmed individually. */
  accountIds: number[];
};
let onChanged: ((change: MarkInputsChange) => void) | null = null;

/** Called once by the aggregation cache: drop what was built on the trimmed marks. */
export function setMarkInputsChangedListener(listener: ((change: MarkInputsChange) => void) | null): void {
  onChanged = listener;
}

const FULL_HISTORY = "0000-01-01";

/**
 * The series store quantities (`markSeriesStore.ts`): a rate row (`rateTable`: fx, bid/ask, UF)
 * moves no quantity of an account that holds shares, coins, cuotas or a non-peso ledger — only
 * the memoized rate, which lives in the history tier and goes with any change. It still trims
 * the accounts whose stored quantity is a peso figure built with rates (the card's dollar
 * lines, the depto ledger's UF marks, a book mark carried by flows): this resolver names the
 * rate-independent ones, registered by the series cache (`accountMarkDailyCache.ts`). Without
 * one, a rate row trims every series.
 */
let rateIndependentAccounts: (() => ReadonlySet<number>) | null = null;

export function setRateIndependentAccountsResolver(resolver: (() => ReadonlySet<number>) | null): void {
  rateIndependentAccounts = resolver;
}

/**
 * How far before a changed row's own date it can move a mark (days), per table:
 * - a card's dollar line is valued at the fx of its facturación's pay-by − 1, up to ~2 months
 *   after the line, so an fx row reaches back that far for card accounts;
 * - a statement header (pay-by, payment date) affects its whole billing period;
 * - the Risky Norris proxy reads the Banco Central observado published up to 7 days later;
 * - a fund cuota (and the sync state it comes with) can re-value a held holiday block before it;
 * - the proxy basket (meta / holdings) is a snapshot: it re-values every proxy-held day, which
 *   are recent — 30 days before the change.
 */
const SOURCE_RULES: Record<
  string,
  { backDays?: number; cardBackDays?: number; recentDays?: number; rateTable?: boolean }
> = {
  cc_statements: { backDays: 45 },
  cc_traspaso_deuda_links: { backDays: 75 },
  fx_daily: { cardBackDays: 75, rateTable: true },
  fx_daily_bid_ask: { cardBackDays: 75, rateTable: true },
  uf_daily: { rateTable: true },
  fx_daily_bcentral: { backDays: 7 },
  fund_unit_daily: { backDays: 10 },
  watchlist_composite_meta: { recentDays: 30 },
  watchlist_composite_holdings: { recentDays: 30 },
};

function isoMinusDays(ymd: string, days: number): string {
  if (ymd === FULL_HISTORY || days === 0) return ymd;
  return new Date(Date.parse(`${ymd}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * A logged date as ISO: `YYYY-MM-DD…` or the statements' `d/m/yyyy`. Anything else (null, a
 * malformed value) is read as the whole history — never a guess that could leave a stale mark.
 */
export function markChangeIso(raw: string | null): string {
  if (raw == null) return FULL_HISTORY;
  const t = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  if (m) return `${m[3]}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
  return FULL_HISTORY;
}

const maxIdStmt = db.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM mark_input_changes`);
const minIdStmt = db.prepare(`SELECT MIN(id) AS id FROM mark_input_changes`);
const pendingStmt = db.prepare(
  `SELECT id, source, account_id, raw_date FROM mark_input_changes WHERE id > ? ORDER BY id`
);
const accountBucketsStmt = db.prepare(
  `SELECT a.id, g.slug FROM accounts a JOIN asset_groups g ON g.id = a.asset_group_id`
);

/** Bucket kinds whose accounts read each other's rows (the depto property ↔ mortgage ledger). */
const DEPENDENT_KINDS: ReadonlySet<string> = new Set(["property", "mortgage"]);

function accountsOfKinds(kinds: ReadonlySet<string>): number[] {
  return (accountBucketsStmt.all() as { id: number; slug: string }[])
    .filter((r) => kinds.has(accountBucketKindSlug(r.slug)))
    .map((r) => r.id);
}

/**
 * Apply every change logged since the last call. Returns true when anything was trimmed.
 * Cheap when nothing changed: one indexed MAX(id).
 */
let applying = false;

export function applyPendingMarkInputChanges(today: string = chileCalendarTodayYmd()): boolean {
  // The rate-independence resolver reads memoized account facts, whose freshness check calls
  // back here: the outer call is already applying the rows.
  if (applying) return false;
  applying = true;
  try {
    return applyPendingMarkInputChangesInner(today);
  } finally {
    applying = false;
  }
}

function applyPendingMarkInputChangesInner(today: string): boolean {
  const maxId = (maxIdStmt.get() as { id: number }).id;
  if (lastAppliedId == null) {
    // First use in this process: the store is empty, nothing to trim.
    lastAppliedId = maxId;
    return false;
  }
  if (maxId <= lastAppliedId) return false;

  const minId = (minIdStmt.get() as { id: number | null }).id;
  if (minId != null && minId > lastAppliedId + 1 && markSeriesStoreSize() > 0) {
    // Rows this process never saw were pruned: it cannot tell what they changed.
    clearMarkSeries();
    lastAppliedId = maxId;
    onChanged?.({ all: true, accountIds: [] });
    return true;
  }

  const rows = pendingStmt.all(lastAppliedId) as {
    id: number;
    source: string;
    account_id: number | null;
    raw_date: string | null;
  }[];
  let allFrom: string | null = null;
  const byAccount = new Map<number, string>();
  const lower = (id: number, from: string) => {
    const prev = byAccount.get(id);
    if (prev == null || from < prev) byAccount.set(id, from);
  };
  let cardFrom: string | null = null;
  let rateFrom: string | null = null;
  for (const r of rows) {
    const rule = SOURCE_RULES[r.source] ?? {};
    let from = isoMinusDays(markChangeIso(r.raw_date), rule.backDays ?? 0);
    if (rule.recentDays != null) from = isoMinusDays(today, rule.recentDays);
    if (r.account_id == null) {
      if (rule.rateTable && rateIndependentAccounts) {
        if (rateFrom == null || from < rateFrom) rateFrom = from;
      } else if (allFrom == null || from < allFrom) {
        allFrom = from;
      }
      if (rule.cardBackDays != null) {
        const cf = isoMinusDays(from, rule.cardBackDays);
        if (cardFrom == null || cf < cardFrom) cardFrom = cf;
      }
    } else {
      lower(r.account_id, from);
    }
  }
  if (cardFrom != null) for (const id of accountsOfKinds(new Set(["credit_card"]))) lower(id, cardFrom);
  if (rateFrom != null && rateIndependentAccounts) {
    const independent = rateIndependentAccounts();
    for (const r of accountBucketsStmt.all() as { id: number; slug: string }[]) {
      if (!independent.has(r.id)) lower(r.id, rateFrom);
    }
  }
  const dependents = accountsOfKinds(DEPENDENT_KINDS);
  let dependentFrom: string | null = null;
  for (const id of dependents) {
    const f = byAccount.get(id);
    if (f != null && (dependentFrom == null || f < dependentFrom)) dependentFrom = f;
  }
  if (dependentFrom != null) for (const id of dependents) lower(id, dependentFrom);

  if (allFrom != null) trimAllMarkSeries(allFrom);
  for (const [id, from] of byAccount) trimAccountMarkSeries(id, from);
  lastAppliedId = rows.length ? rows[rows.length - 1]!.id : maxId;
  // A rate row reaches every account's VALUES even when it trims no quantity: the history tier
  // (its memoized rates) and what was built on it go, as for any change.
  onChanged?.({ all: allFrom != null || rateFrom != null, accountIds: [...byAccount.keys()] });
  return true;
}

/** Drop change rows older than `keepDays` (the main server, at boot). */
export function pruneMarkInputChanges(keepDays = 7): number {
  return db
    .prepare(`DELETE FROM mark_input_changes WHERE created_at < datetime('now', ?)`)
    .run(`-${keepDays} days`).changes;
}

/** @internal Test hook: forget what this process applied (the next call re-baselines). */
export function resetMarkInputChangesForTest(): void {
  lastAppliedId = null;
}
