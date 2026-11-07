import { chileCalendarTodayYmd } from "./chileDate.js";
import { db, dbInTransaction } from "./db.js";
import { markInputRuleForSource } from "./markInputTriggers.js";
import {
  accountGroupsTrimmedTogether,
  clearMarkSeries,
  markSeriesStoreSize,
  trimAccountMarkSeries,
  trimAllMarkSeries,
  trimRateDependentMarkSeries,
} from "./markSeriesStore.js";

/**
 * The change log behind every cache (`mark_input_changes`, filled by triggers in whichever
 * connection wrote — `markInputTriggers.ts` — so a CLI script's writes count too and no caller has
 * to remember an invalidation). Two kinds of rows:
 * - mark rows: a table a historical mark reads changed, naming the account (none: an input every
 *   account can read — prices, fx, UF, fund units, the nav tree) and the raw date. Applied here as
 *   a waterfall on the per-account mark series: each affected series keeps the days before the
 *   change and drops the rest. The spec of each table says how far back it reaches
 *   (`markInputRuleForSource`). Accounts declared trimmed together (`declareAccountsTrimmedTogether`)
 *   are trimmed from the same date; transfers name both of their accounts in the row itself.
 * - write rows: any other change of a table the caches read, naming the table alone.
 *
 * {@link applyChangeLog} returns what changed to the cache registry (`cacheRegistry.ts`), the only
 * caller, which drops the cache families that read it. The consumer remembers the last row it
 * applied. Rows are pruned after a few days ({@link pruneChangeLog}, after an apply at most once an
 * hour); a consumer that finds its next row already pruned has missed changes and drops everything.
 */

let lastAppliedId: number | null = null;

/**
 * Inside a transaction the rows it logged are applied (a read after a write must not see a stale
 * entry) but not committed to `lastAppliedId`: a rollback takes them back and SQLite hands their
 * ids out again. They are tracked apart — the last one applied, and the trims they caused — and
 * {@link endTransactionChanges} replays the trims once the transaction is over, so a series built
 * inside it from rows a rollback took back is rebuilt; a commit's rows are then applied again.
 */
let txAppliedThrough: number | null = null;
let txTrims: { all: string | null; rate: string | null; byAccount: Map<number, string> } | null = null;

export type ChangeLogSummary = {
  /** A mark row every account reads (or a missed stretch of the log). */
  marksAll: boolean;
  /** Accounts a mark row named (with the accounts trimmed together with them). */
  markAccountIds: number[];
  /** Tables a write row named. */
  writtenTables: Set<string>;
};

const FULL_HISTORY = "0000-01-01";

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
  `SELECT id, source, account_id, raw_date, kind FROM mark_input_changes WHERE id > ? ORDER BY id`
);

/**
 * Apply every change logged since the last call: trim the mark series and say what changed (null
 * when nothing did). Cheap when nothing changed: one indexed MAX(id).
 */
let applying = false;

export function applyChangeLog(today: string = chileCalendarTodayYmd()): ChangeLogSummary | null {
  // Resolving a group trimmed together reads memoized account facts, whose freshness check calls
  // back here: the outer call is already applying the rows.
  if (applying) return null;
  applying = true;
  try {
    return applyChangeLogInner(today, dbInTransaction());
  } finally {
    applying = false;
  }
}

function applyChangeLogInner(today: string, inTransaction: boolean): ChangeLogSummary | null {
  const maxId = (maxIdStmt.get() as { id: number }).id;
  if (lastAppliedId == null) {
    // First use in this process: nothing is cached yet, nothing to drop. Never inside a
    // transaction, whose uncommitted rows a rollback can take back.
    if (!inTransaction) lastAppliedId = maxId;
    return null;
  }
  const appliedThrough = inTransaction ? Math.max(lastAppliedId, txAppliedThrough ?? lastAppliedId) : lastAppliedId;
  if (maxId <= appliedThrough) return null;

  const minId = (minIdStmt.get() as { id: number | null }).id;
  if (minId != null && minId > lastAppliedId + 1 && markSeriesStoreSize() > 0) {
    // Rows this process never saw were pruned: it cannot tell what they changed.
    clearMarkSeries();
    lastAppliedId = maxId;
    return { marksAll: true, markAccountIds: [], writtenTables: new Set() };
  }

  const rows = pendingStmt.all(appliedThrough) as {
    id: number;
    source: string;
    account_id: number | null;
    raw_date: string | null;
    kind: "mark" | "write";
  }[];
  let allFrom: string | null = null;
  let rateFrom: string | null = null;
  const byAccount = new Map<number, string>();
  const writtenTables = new Set<string>();
  const lower = (id: number, from: string) => {
    const prev = byAccount.get(id);
    if (prev == null || from < prev) byAccount.set(id, from);
  };
  for (const r of rows) {
    if (r.kind === "write") {
      writtenTables.add(r.source);
      continue;
    }
    const rule = markInputRuleForSource(r.source);
    let from = isoMinusDays(markChangeIso(r.raw_date), rule.backDays ?? 0);
    if (rule.recentDays != null) from = isoMinusDays(today, rule.recentDays);
    if (r.account_id == null) {
      if (rule.rateTable) {
        if (rateFrom == null || from < rateFrom) rateFrom = from;
      } else if (allFrom == null || from < allFrom) {
        allFrom = from;
      }
    } else {
      lower(r.account_id, from);
    }
  }
  if (byAccount.size > 0) {
    for (const group of accountGroupsTrimmedTogether()) {
      let groupFrom: string | null = null;
      for (const id of group) {
        const f = byAccount.get(id);
        if (f != null && (groupFrom == null || f < groupFrom)) groupFrom = f;
      }
      if (groupFrom != null) for (const id of group) lower(id, groupFrom);
    }
  }

  if (allFrom != null) trimAllMarkSeries(allFrom);
  if (rateFrom != null) trimRateDependentMarkSeries(rateFrom);
  for (const [id, from] of byAccount) trimAccountMarkSeries(id, from);
  const lastId = rows.length ? rows[rows.length - 1]!.id : maxId;
  if (inTransaction) {
    txAppliedThrough = lastId;
    txTrims ??= { all: null, rate: null, byAccount: new Map() };
    if (allFrom != null && (txTrims.all == null || allFrom < txTrims.all)) txTrims.all = allFrom;
    if (rateFrom != null && (txTrims.rate == null || rateFrom < txTrims.rate)) txTrims.rate = rateFrom;
    for (const [id, from] of byAccount) {
      const prev = txTrims.byAccount.get(id);
      if (prev == null || from < prev) txTrims.byAccount.set(id, from);
    }
  } else {
    lastAppliedId = lastId;
    pruneChangeLogHourly();
  }
  // A rate row reaches every account's VALUES even when it trims no quantity: the history tier
  // (its memoized rates) and what was built on it go, as for any change.
  return {
    marksAll: allFrom != null || rateFrom != null,
    markAccountIds: [...byAccount.keys()],
    writtenTables,
  };
}

/**
 * The transaction the rows were applied in is over: replay its trims, since a series rebuilt inside
 * it may hold rows a rollback took back. A commit's rows are then applied again (they are past
 * `lastAppliedId`), which drops what they reach as for any write.
 */
export function endTransactionChanges(): void {
  txAppliedThrough = null;
  const t = txTrims;
  txTrims = null;
  if (!t) return;
  if (t.all != null) trimAllMarkSeries(t.all);
  if (t.rate != null) trimRateDependentMarkSeries(t.rate);
  for (const [id, from] of t.byAccount) trimAccountMarkSeries(id, from);
}

const PRUNE_KEEP_DAYS = 7;
const PRUNE_EVERY_MS = 3_600_000;
let lastPrunedAtMs = 0;

/** Drop change rows older than `keepDays` (they only need to outlive the slowest reader's gap). */
export function pruneChangeLog(keepDays = PRUNE_KEEP_DAYS): number {
  lastPrunedAtMs = Date.now();
  return db
    .prepare(`DELETE FROM mark_input_changes WHERE created_at < datetime('now', ?)`)
    .run(`-${keepDays} days`).changes;
}

function pruneChangeLogHourly(): void {
  if (Date.now() - lastPrunedAtMs < PRUNE_EVERY_MS || dbInTransaction()) return;
  pruneChangeLog();
}

/** @internal Test hook: forget what this process applied (the next call re-baselines). */
export function resetMarkInputChangesForTest(): void {
  lastAppliedId = null;
}
