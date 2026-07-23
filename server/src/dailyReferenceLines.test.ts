import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clearAggregationCache } from "./aggregationCache.js";
import { dailyReferenceLinesForChartHost } from "./dailyReferenceLines.js";
import { getBucketDailySeries } from "./dailySeries.js";
import { db } from "./db.js";

/**
 * Chart-host reference overlays on the daily grid: a weighted sum of other groups' daily
 * totals, matching what `appendChartHostReferenceOverlays` composes for the monthly chart.
 * Fully synthetic — a host with two source groups (weights 1 and 0.85) over fixed 2037 dates.
 */

const DATES = ["2037-03-30", "2037-03-31", "2037-04-01"];

let leafId: number | null = null;
let leafSlug: string | null = null;
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
    .prepare(`SELECT id, slug FROM asset_groups WHERE slug LIKE 'brokerage_acciones__%' LIMIT 1`)
    .get() as { id: number; slug: string } | undefined;
  if (!leaf) return;
  leafId = leaf.id;
  leafSlug = leaf.slug;

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
  const insVal = db.prepare(
    `INSERT INTO valuations (account_id, as_of_date, value, currency) VALUES (?, ?, ?, 'clp')`
  );
  // Marks forward-fill on-or-before, so every grid date resolves.
  insVal.run(srcAccountA, "2037-03-30", 1_000_000);
  insVal.run(srcAccountA, "2037-04-01", 1_200_000);
  insVal.run(srcAccountB, "2037-03-30", 400_000);

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
    const lines = dailyReferenceLinesForChartHost("vitest-host", "clp", 3, DATES);
    expect(lines).not.toBeNull();
    expect(lines!.length).toBe(1);
    const line = lines![0]!;
    expect(line.dataKey).toBe("ref:vitest-refline");
    // A + 0.85 × B, with B flat after its only mark and A stepping on 04-01.
    expect(line.values).toEqual([
      1_000_000 + 0.85 * 400_000,
      1_000_000 + 0.85 * 400_000,
      1_200_000 + 0.85 * 400_000,
    ]);
  });

  it("equals the source groups' own daily totals (same value legs as the daily series)", () => {
    if (srcAccountA == null || leafSlug == null) return;
    const now = new Date("2037-04-01T23:00:00Z");
    const seriesA = getBucketDailySeries(
      [{ account_id: srcAccountA, bucket_slug: leafSlug }],
      { unit: "clp", days: 2, now }
    );
    const seriesB = getBucketDailySeries(
      [{ account_id: srcAccountB!, bucket_slug: leafSlug }],
      { unit: "clp", days: 2, now }
    );
    const lines = dailyReferenceLinesForChartHost("vitest-host", "clp", 3, DATES);
    const values = lines![0]!.values;
    seriesA.points.forEach((p, i) => {
      const expected = (p.value ?? 0) + 0.85 * (seriesB.points[i]!.value ?? 0);
      // series points cover the last 2 dates of DATES (days: 2 → 2 points ending today).
      expect(values[i + 1]).toBeCloseTo(expected, 6);
    });
  });

  it("returns null for a host with no reference groups", () => {
    expect(dailyReferenceLinesForChartHost("vitest-no-such-host", "clp", 3, DATES)).toBeNull();
  });
});
