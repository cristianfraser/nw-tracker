import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clearAggregationCache } from "./aggregationCache.js";
import { chileCalendarAddDays, chileCalendarTodayYmd } from "./chileDate.js";
import { dailyReferenceLinesForChartHost } from "./dailyReferenceLines.js";
import { getBucketDailySeriesCached } from "./dailySeries.js";
import { db } from "./db.js";
import { listAccountsForGroupTab } from "./valuationTimeseries.js";

/**
 * Chart-host reference overlays on the daily grid: a weighted sum of other groups' daily
 * totals, sourced from those groups' own (shared) daily series. Fully synthetic — a host with
 * two source groups at weights 1 and 0.85. Dates are anchored on today because the source
 * series builds its own grid from `days` on the real clock.
 */

const DAYS = 2;
const TODAY = chileCalendarTodayYmd();
const DATES = [chileCalendarAddDays(TODAY, -1), TODAY];

let leafId: number | null = null;
let srcAccountA: number | null = null;
let srcAccountB: number | null = null;
const groupSlugs = ["vitest-refsrc-a", "vitest-refsrc-b", "vitest-refline"];

function insertGroup(slug: string, extra: Record<string, string | number | null> = {}): number {
  const cols = ["slug", "label", ...Object.keys(extra)];
  const vals = [slug, `Vitest ${slug}`, ...Object.values(extra)];
  return Number(
    db
      .prepare(
        `INSERT INTO portfolio_groups (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`
      )
      .run(...vals).lastInsertRowid
  );
}

beforeAll(() => {
  const leaf = db
    .prepare(`SELECT id FROM asset_groups WHERE slug LIKE 'brokerage_acciones__%' LIMIT 1`)
    .get() as { id: number } | undefined;
  if (!leaf) return;
  leafId = leaf.id;

  const insAccount = db.prepare(
    `INSERT INTO accounts (asset_group_id, name, notes, import_key) VALUES (?, ?, ?, ?)`
  );
  srcAccountA = Number(
    insAccount.run(leafId, "Vitest · ref source A", "vitest-refsrc-a", "vitest-refsrc-a")
      .lastInsertRowid
  );
  srcAccountB = Number(
    insAccount.run(leafId, "Vitest · ref source B", "vitest-refsrc-b", "vitest-refsrc-b")
      .lastInsertRowid
  );
  // One mark before the window; marks forward-fill on-or-before, so both grid days resolve.
  const insVal = db.prepare(
    `INSERT INTO valuations (account_id, as_of_date, value, currency) VALUES (?, ?, ?, 'clp')`
  );
  insVal.run(srcAccountA, chileCalendarAddDays(TODAY, -10), 1_000_000);
  insVal.run(srcAccountB, chileCalendarAddDays(TODAY, -10), 400_000);

  const groupA = insertGroup("vitest-refsrc-a");
  const groupB = insertGroup("vitest-refsrc-b");
  const ref = insertGroup("vitest-refline", {
    group_kind: "reference",
    chart_host_slug: "vitest-host",
    color_rgb: "1,2,3",
  });
  const insItem = db.prepare(
    `INSERT INTO portfolio_group_items (group_id, item_kind, account_id, child_group_id, link_weight, sort_order)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  insItem.run(groupA, "account", srcAccountA, null, null, 0);
  insItem.run(groupB, "account", srcAccountB, null, null, 0);
  insItem.run(ref, "linked_group", null, groupA, 1, 0);
  insItem.run(ref, "linked_group", null, groupB, 0.85, 10);
  clearAggregationCache();
});

afterAll(() => {
  for (const id of [srcAccountA, srcAccountB]) {
    if (id == null) continue;
    db.prepare(`DELETE FROM valuations WHERE account_id = ?`).run(id);
    db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
  }
  for (const slug of groupSlugs) {
    const row = db.prepare(`SELECT id FROM portfolio_groups WHERE slug = ?`).get(slug) as
      | { id: number }
      | undefined;
    if (!row) continue;
    db.prepare(`DELETE FROM portfolio_group_items WHERE group_id = ?`).run(row.id);
    db.prepare(`DELETE FROM portfolio_groups WHERE id = ?`).run(row.id);
  }
  clearAggregationCache();
});

describe("dailyReferenceLinesForChartHost", () => {
  it("composes the weighted sum of its source groups per day", () => {
    if (srcAccountA == null) return;
    const lines = dailyReferenceLinesForChartHost("vitest-host", "clp", DAYS, DATES);
    expect(lines).not.toBeNull();
    expect(lines!.length).toBe(1);
    expect(lines![0]!.dataKey).toBe("ref:vitest-refline");
    const expected = 1_000_000 + 0.85 * 400_000;
    expect(lines![0]!.values).toEqual([expected, expected]);
  });

  it("reads each source from the very series its own daily page builds (shared cache entry)", () => {
    if (srcAccountA == null) return;
    // Same scope key, rows and options as the `/api/daily-series` group branch: if the
    // reference build used a private scope this would be a second, divergent build.
    const totals = ["vitest-refsrc-a", "vitest-refsrc-b"].map((slug) =>
      getBucketDailySeriesCached(
        `pg:${slug}`,
        listAccountsForGroupTab(slug).filter((r) => r.account_id > 0),
        { unit: "clp", days: DAYS, includeAccounts: true }
      )
    );
    const lines = dailyReferenceLinesForChartHost("vitest-host", "clp", DAYS, DATES);
    lines![0]!.values.forEach((v, i) => {
      const a = totals[0]!.points[i]!.value ?? 0;
      const b = totals[1]!.points[i]!.value ?? 0;
      expect(v).toBeCloseTo(a + 0.85 * b, 6);
    });
  });

  it("returns null for a host with no reference groups", () => {
    expect(dailyReferenceLinesForChartHost("vitest-no-such-host", "clp", DAYS, DATES)).toBeNull();
  });
});
