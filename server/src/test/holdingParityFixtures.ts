/**
 * Shared pieces of the "holding from units" parity tests: each keeps a copy of a rule that
 * answered a quantity question through a price and requires the units rule to give the same
 * answer for every account of the database the suite runs on, plus prefixed synthetic fixtures
 * for what the lean test data lacks. Also records which live tickers a call read
 * (`cacheDependencies.ts`).
 */
import { afterEach } from "vitest";
import { db } from "../db.js";
import { newCacheDepNode, runInCacheDepNode, type CacheDepNode } from "../cacheDependencies.js";

const PREFIX = "Vitest · holding from units";

/** Fixture rows created by one test file, deleted after each test. */
export function holdingFixtures() {
  const created: { accounts: number[]; movements: number[]; groups: number[] } = {
    accounts: [],
    movements: [],
    groups: [],
  };
  afterEach(() => {
    for (const id of created.movements.splice(0)) db.prepare(`DELETE FROM movements WHERE id = ?`).run(id);
    for (const id of created.accounts.splice(0)) db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
    for (const id of created.groups.splice(0)) db.prepare(`DELETE FROM asset_groups WHERE id = ?`).run(id);
  });

  const leafId = (slugLike: string): number => {
    const row = db.prepare(`SELECT id FROM asset_groups WHERE slug LIKE ? LIMIT 1`).get(slugLike) as
      | { id: number }
      | undefined;
    if (!row) throw new Error(`no asset group like ${slugLike} in the test DB`);
    return row.id;
  };

  return {
    /** A peso cash leaf (bucket kind `clp`), which the lean test data has none of. */
    pesoCashLeafSlug(): string {
      const slug = "vitest_holding_from_units__clp";
      created.groups.push(
        Number(
          db
            .prepare(`INSERT INTO asset_groups (slug, label, sort_order) VALUES (?, 'vitest peso caja', 9999)`)
            .run(slug).lastInsertRowid
        )
      );
      return slug;
    },
    account(name: string, groupSlugLike: string, ticker: string | null = null): number {
      const id = Number(
        db
          .prepare(`INSERT INTO accounts (asset_group_id, name, equity_ticker) VALUES (?, ?, ?)`)
          .run(leafId(groupSlugLike), `${PREFIX} ${name}`, ticker).lastInsertRowid
      );
      created.accounts.push(id);
      return id;
    },
    singleLeg(
      accountId: number,
      on: string,
      amount: number,
      units: number | null,
      flowKind: string | null,
      currency: "clp" | "usd" = "clp"
    ): void {
      created.movements.push(
        Number(
          db
            .prepare(
              `INSERT INTO movements (account_id, amount, currency, occurred_on, flow_kind, units_delta)
               VALUES (?, ?, ?, ?, ?, ?)`
            )
            .run(accountId, amount, currency, on, flowKind, units).lastInsertRowid
        )
      );
    },
  };
}

export const allAccountIds = (): number[] =>
  (db.prepare(`SELECT id FROM accounts ORDER BY id`).all() as { id: number }[]).map((r) => r.id);

/** A ticker with stored closes in the test DB (none in the lean preset: a made-up one). */
export function storedStockTicker(fallback: string): string {
  const row = db
    .prepare(`SELECT ticker FROM equity_daily WHERE ticker NOT IN ('BTC-USD', 'ETH-USD') LIMIT 1`)
    .get() as { ticker: string } | undefined;
  return row?.ticker ?? fallback;
}

/** A trading Wednesday before the open, mid-session, after the close, a Sunday, and now. */
export const PARITY_INSTANTS = [
  new Date("2026-05-20T08:00:00-04:00"),
  new Date("2026-05-20T12:00:00-04:00"),
  new Date("2026-05-20T16:30:00-04:00"),
  new Date("2026-05-24T12:00:00-04:00"),
  new Date(),
];

function tickersUnder(n: CacheDepNode, seen = new Set<CacheDepNode>(), out = new Set<string>()): Set<string> {
  if (seen.has(n)) return out;
  seen.add(n);
  n.tickers.forEach((t) => out.add(t));
  n.children.forEach((c) => tickersUnder(c, seen, out));
  return out;
}

/** Outcome of `fn` (a value, or the error it threw) and every live ticker it read. */
export function observeLiveReads<T>(fn: () => T): { out: T | string; tickers: string[] } {
  const node = newCacheDepNode();
  let out: T | string;
  try {
    out = runInCacheDepNode(node, fn);
  } catch (e) {
    out = `throws: ${(e as Error).message}`;
  }
  return { out, tickers: [...tickersUnder(node)].sort() };
}
