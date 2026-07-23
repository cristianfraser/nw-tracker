import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clearAggregationCache } from "./aggregationCache.js";
import { db } from "./db.js";
import { getGroupValuationTimeseries } from "./valuationTimeseries.js";

/**
 * Monthly chart-host overlays read each source group on-or-before, so a source whose value
 * lands MID-month (Fintual snapshots fall on flow/sync days, not month-ends) still counts at
 * the host's month-end. Filtering source points to the host's own dates instead used to drop
 * that point and carry the previous month's value — the daily line then disagreed with the
 * monthly one by a whole month of movement (APV, 2026-06: 1,8M on «Disponible total»).
 *
 * Synthetic: a reference node hosted on `liabilities`, fed by one synthetic source account.
 * Fixture dates are derived from the host's OWN chart dates so the assertions can never go
 * vacuous on a different test DB.
 */

const REF_SLUG = "vitest-refoverlay";
const SRC_SLUG = "vitest-refoverlay-src";
const DATA_KEY = `ref:${REF_SLUG}`;
const PRIOR_VALUE = 1_000_000;
const MID_VALUE = 3_000_000;

let srcAccountId: number | null = null;
/** Host chart date carrying the prior value, the mid-month source date, the host date after it. */
let priorHostDate: string | null = null;
let midDate: string | null = null;
let targetHostDate: string | null = null;

function addDaysIso(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

beforeAll(() => {
  const leaf = db
    .prepare(`SELECT id FROM asset_groups WHERE slug LIKE 'brokerage_acciones__%' LIMIT 1`)
    .get() as { id: number } | undefined;
  if (!leaf) return;

  // Two consecutive host dates with room for a mid-month source point between them.
  const hostDates = (getGroupValuationTimeseries("liabilities", "clp").accounts_in_group?.points ?? [])
    .map((p) => String(p.as_of_date))
    .sort();
  for (let i = hostDates.length - 2; i >= 1; i--) {
    const mid = addDaysIso(hostDates[i - 1]!, 8);
    if (mid > hostDates[i - 1]! && mid < hostDates[i]!) {
      priorHostDate = hostDates[i - 1]!;
      midDate = mid;
      targetHostDate = hostDates[i]!;
      break;
    }
  }
  if (!priorHostDate || !midDate || !targetHostDate) return;
  // The mid-month date must NOT be a host chart date, or the bug it guards can't occur.
  expect(hostDates).not.toContain(midDate);

  srcAccountId = Number(
    db
      .prepare(
        `INSERT INTO accounts (asset_group_id, name, notes, import_key)
         VALUES (?, 'Vitest · ref overlay source', 'vitest-refoverlay', 'vitest-refoverlay')`
      )
      .run(leaf.id).lastInsertRowid
  );
  const insVal = db.prepare(
    `INSERT INTO valuations (account_id, as_of_date, value, currency) VALUES (?, ?, ?, 'clp')`
  );
  insVal.run(srcAccountId, priorHostDate, PRIOR_VALUE);
  insVal.run(srcAccountId, midDate, MID_VALUE);

  const insGroup = db.prepare(
    `INSERT INTO portfolio_groups (slug, label, group_kind, chart_host_slug) VALUES (?, ?, ?, ?)`
  );
  const srcGroup = Number(
    insGroup.run(SRC_SLUG, "Vitest ref source", "normal", null).lastInsertRowid
  );
  const refGroup = Number(
    insGroup.run(REF_SLUG, "Vitest ref overlay", "reference", "liabilities").lastInsertRowid
  );
  const insItem = db.prepare(
    `INSERT INTO portfolio_group_items (group_id, item_kind, account_id, child_group_id, link_weight, sort_order)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  insItem.run(srcGroup, "account", srcAccountId, null, null, 0);
  insItem.run(refGroup, "linked_group", null, srcGroup, 1, 0);
  clearAggregationCache();
});

afterAll(() => {
  if (srcAccountId != null) {
    db.prepare(`DELETE FROM valuations WHERE account_id = ?`).run(srcAccountId);
    db.prepare(`DELETE FROM accounts WHERE id = ?`).run(srcAccountId);
  }
  for (const slug of [REF_SLUG, SRC_SLUG]) {
    const row = db.prepare(`SELECT id FROM portfolio_groups WHERE slug = ?`).get(slug) as
      | { id: number }
      | undefined;
    if (!row) continue;
    db.prepare(`DELETE FROM portfolio_group_items WHERE group_id = ?`).run(row.id);
    db.prepare(`DELETE FROM portfolio_groups WHERE id = ?`).run(row.id);
  }
  clearAggregationCache();
});

describe("chart-host reference overlays — source dates that are not host dates", () => {
  it("carries a mid-month source value onto the next host date, not the prior one's", () => {
    if (srcAccountId == null) return;
    const points = getGroupValuationTimeseries("liabilities", "clp").accounts_in_group?.points ?? [];
    const byDate = new Map(points.map((p) => [String(p.as_of_date), p] as const));
    expect(byDate.get(priorHostDate!)?.[DATA_KEY]).toBe(PRIOR_VALUE);
    expect(byDate.get(targetHostDate!)?.[DATA_KEY]).toBe(MID_VALUE);
  });

  it("declares the overlay line so the client can chart it", () => {
    if (srcAccountId == null) return;
    const built = getGroupValuationTimeseries("liabilities", "clp");
    const line = (built.accounts_in_group?.lines ?? []).find((l) => l.dataKey === DATA_KEY);
    expect(line?.valueSeriesType).toBe("reference");
  });
});
