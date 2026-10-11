/**
 * History of a composite proxy's basket, one row set per Fintual positions date
 * (`watchlist_composite_positions` + `_position_holdings`, migration 238).
 *
 * `watchlist_composite_meta` / `_holdings` carry only the latest basket, rewritten on every sync;
 * this module keeps every basket the sync ever saw, keyed by the day Fintual said the holdings
 * were as of. Rows are write-once: the same positions date stated again with the same weights is
 * `unchanged`, with other weights a `conflict` — reported by the caller, never written over.
 * Nothing on a request path reads these tables; they are the record.
 */
import { db } from "./db.js";

export type CompositePositionsSource = "sync" | "snapshot";

export type CompositePositionHolding = { ticker: string; weight: number };

export type CompositePositionsRow = {
  bucket_slug: string;
  positions_date: string;
  etf_weight_sum: number | null;
  source: CompositePositionsSource;
  recorded_at: string;
  holdings: CompositePositionHolding[];
};

export type RecordCompositePositionsResult =
  | { status: "inserted" }
  | { status: "unchanged" }
  | {
      status: "conflict";
      /** Tickers whose stored weight differs from the stated one (or present on one side only). */
      differences: { ticker: string; stored: number | null; stated: number | null }[];
    };

/** Weights are value fractions; two renderings of one basket agree far below this. */
const WEIGHT_TOLERANCE = 1e-9;

const stmtPositions = db.prepare(
  `SELECT bucket_slug, positions_date, etf_weight_sum, source, recorded_at
   FROM watchlist_composite_positions WHERE bucket_slug = ? AND positions_date = ?`
);
const stmtHoldings = db.prepare(
  `SELECT ticker, weight FROM watchlist_composite_position_holdings
   WHERE bucket_slug = ? AND positions_date = ? ORDER BY weight DESC, ticker`
);
const stmtInsertPositions = db.prepare(
  `INSERT INTO watchlist_composite_positions (bucket_slug, positions_date, etf_weight_sum, source)
   VALUES (?, ?, ?, ?)`
);
const stmtInsertHolding = db.prepare(
  `INSERT INTO watchlist_composite_position_holdings (bucket_slug, positions_date, ticker, weight)
   VALUES (?, ?, ?, ?)`
);
const stmtLatestBefore = db.prepare(
  `SELECT positions_date FROM watchlist_composite_positions
   WHERE bucket_slug = ? AND positions_date < ? ORDER BY positions_date DESC LIMIT 1`
);
const stmtListDates = db.prepare(
  `SELECT positions_date FROM watchlist_composite_positions WHERE bucket_slug = ? ORDER BY positions_date`
);

function normalizeHoldings(holdings: CompositePositionHolding[]): CompositePositionHolding[] {
  const byTicker = new Map<string, number>();
  for (const h of holdings) {
    const ticker = h.ticker.trim().toUpperCase();
    if (!ticker) throw new Error("composite positions: empty ticker");
    if (!Number.isFinite(h.weight) || h.weight < 0) {
      throw new Error(`composite positions: invalid weight for ${ticker}: ${h.weight}`);
    }
    if (byTicker.has(ticker)) throw new Error(`composite positions: ticker ${ticker} repeated`);
    byTicker.set(ticker, h.weight);
  }
  if (byTicker.size === 0) throw new Error("composite positions: no holdings");
  return [...byTicker].map(([ticker, weight]) => ({ ticker, weight }));
}

export function loadCompositePositions(
  bucketSlug: string,
  positionsDate: string
): CompositePositionsRow | null {
  const row = stmtPositions.get(bucketSlug, positionsDate) as
    | Omit<CompositePositionsRow, "holdings">
    | undefined;
  if (!row) return null;
  const holdings = stmtHoldings.all(bucketSlug, positionsDate) as CompositePositionHolding[];
  return { ...row, holdings };
}

export function listCompositePositionsDates(bucketSlug: string): string[] {
  return (stmtListDates.all(bucketSlug) as { positions_date: string }[]).map((r) => r.positions_date);
}

/** The latest recorded basket strictly before `positionsDate`, or null when it is the first. */
export function latestCompositePositionsBefore(
  bucketSlug: string,
  positionsDate: string
): CompositePositionsRow | null {
  const row = stmtLatestBefore.get(bucketSlug, positionsDate) as { positions_date: string } | undefined;
  return row ? loadCompositePositions(bucketSlug, row.positions_date) : null;
}

export function compareCompositeHoldings(
  stored: CompositePositionHolding[],
  stated: CompositePositionHolding[]
): { ticker: string; stored: number | null; stated: number | null }[] {
  const a = new Map(stored.map((h) => [h.ticker, h.weight]));
  const b = new Map(stated.map((h) => [h.ticker, h.weight]));
  const tickers = [...new Set([...a.keys(), ...b.keys()])].sort();
  const diffs: { ticker: string; stored: number | null; stated: number | null }[] = [];
  for (const t of tickers) {
    const x = a.get(t) ?? null;
    const y = b.get(t) ?? null;
    if (x == null || y == null || Math.abs(x - y) > WEIGHT_TOLERANCE) diffs.push({ ticker: t, stored: x, stated: y });
  }
  return diffs;
}

/**
 * Records the basket Fintual stated for `positionsDate`. Idempotent for a repeat statement; a
 * disagreeing one is returned as a conflict with nothing written. Runs in the caller's
 * transaction when there is one.
 */
export function recordCompositePositions(input: {
  bucket_slug: string;
  positions_date: string;
  etf_weight_sum: number | null;
  source: CompositePositionsSource;
  holdings: CompositePositionHolding[];
}): RecordCompositePositionsResult {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.positions_date)) {
    throw new Error(`composite positions: invalid positions date "${input.positions_date}"`);
  }
  const stated = normalizeHoldings(input.holdings);
  const existing = loadCompositePositions(input.bucket_slug, input.positions_date);
  if (existing) {
    const differences = compareCompositeHoldings(existing.holdings, stated);
    return differences.length ? { status: "conflict", differences } : { status: "unchanged" };
  }
  db.transaction(() => {
    stmtInsertPositions.run(input.bucket_slug, input.positions_date, input.etf_weight_sum, input.source);
    for (const h of stated) {
      stmtInsertHolding.run(input.bucket_slug, input.positions_date, h.ticker, h.weight);
    }
  })();
  return { status: "inserted" };
}

/** Tickers that entered and left between two baskets — what a composition change is made of. */
export function compositeTickerChanges(
  previous: CompositePositionHolding[] | null,
  current: CompositePositionHolding[]
): { entered: string[]; left: string[] } {
  if (!previous) return { entered: current.map((h) => h.ticker).sort(), left: [] };
  const prev = new Set(previous.map((h) => h.ticker));
  const curr = new Set(current.map((h) => h.ticker));
  return {
    entered: [...curr].filter((t) => !prev.has(t)).sort(),
    left: [...prev].filter((t) => !curr.has(t)).sort(),
  };
}
