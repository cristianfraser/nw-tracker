import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Which live inputs a cached aggregate read, so a live-quote tick drops only the aggregates that
 * read a price it moved (`invalidateMarketDataAggregations` in `aggregationCache.ts`).
 *
 * A live tick writes `live_market_quotes` only. Every reader of that table, and every gate that
 * decides whether to read it, reports here: an equity / crypto ticker
 * (`shouldUseLiveEquityQuote`, `equityHeldSessionQuote`, `getLatestLiveEquityQuoteRow`) or the
 * live dollar (`shouldUseLiveFxQuote`, `getLatestLiveFxQuoteRow`, the observado window average).
 * A gate reports even when it decides against the live row: an aggregate built before the open
 * read the stored close, and must go when the first tick of the session moves the price.
 *
 * Each cache entry (and each live-tier memo) builds inside its own node; a lookup links the
 * entry's node into the node of whatever is being built around it, hit or miss, so an aggregate
 * depends on everything its cached parts read. Nodes are linked, not copied: a part still being
 * built (a promise in flight) adds its reads later and the parent sees them.
 *
 * A leaf module: the quote readers import it without pulling the cache in.
 */
export type CacheDepNode = {
  tickers: Set<string>;
  fx: boolean;
  children: Set<CacheDepNode>;
};

/** What a live-quote poll moved: tickers as stored (upper case) and whether the dollar moved. */
export type LiveQuoteMoves = { tickers: ReadonlySet<string>; fx: boolean };

const storage = new AsyncLocalStorage<CacheDepNode>();

export function newCacheDepNode(): CacheDepNode {
  return { tickers: new Set(), fx: false, children: new Set() };
}

/** Run `fn` with `node` collecting the live inputs it reads (async continuations included). */
export function runInCacheDepNode<T>(node: CacheDepNode, fn: () => T): T {
  return storage.run(node, fn);
}

/** The entry being built around this call reads `child`'s inputs too. */
export function linkCacheDepNode(child: CacheDepNode): void {
  const parent = storage.getStore();
  if (parent && parent !== child) parent.children.add(child);
}

export function noteLiveTickerRead(ticker: string): void {
  storage.getStore()?.tickers.add(ticker.toUpperCase());
}

export function noteLiveFxRead(): void {
  const node = storage.getStore();
  if (node) node.fx = true;
}

/** Whether `node` (or anything linked under it) read an input `moves` changed. */
export function cacheDepNodeAffected(
  node: CacheDepNode,
  moves: LiveQuoteMoves,
  memo: Map<CacheDepNode, boolean>
): boolean {
  const known = memo.get(node);
  if (known !== undefined) return known;
  // Iterative walk; a node is marked unaffected while on the stack, so a cycle cannot loop.
  const stack: { node: CacheDepNode; children: Iterator<CacheDepNode> }[] = [];
  const enter = (n: CacheDepNode): boolean => {
    if (directlyAffected(n, moves)) {
      memo.set(n, true);
      return true;
    }
    memo.set(n, false);
    stack.push({ node: n, children: n.children.values() });
    return false;
  };
  if (enter(node)) return true;
  while (stack.length > 0) {
    const top = stack[stack.length - 1]!;
    const next = top.children.next();
    if (next.done) {
      stack.pop();
      continue;
    }
    const child = next.value;
    const childKnown = memo.get(child);
    const affected = childKnown !== undefined ? childKnown : enter(child);
    if (affected) {
      // Everything on the stack contains this child.
      for (const frame of stack) memo.set(frame.node, true);
      return true;
    }
  }
  return false;
}

function directlyAffected(node: CacheDepNode, moves: LiveQuoteMoves): boolean {
  if (moves.fx && node.fx) return true;
  for (const t of node.tickers) if (moves.tickers.has(t)) return true;
  return false;
}

const EVERY_LIVE_INPUT: LiveQuoteMoves = { tickers: { has: () => true } as unknown as ReadonlySet<string>, fx: true };

/** Whether `node` (or anything linked under it) read any live input at all. */
export function cacheDepNodeReadsLiveInput(node: CacheDepNode): boolean {
  return cacheDepNodeAffected(node, EVERY_LIVE_INPUT, new Map());
}
