import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clearAggregationCache } from "./aggregationCache.js";
import { getBucketDailySeries } from "./dailySeries.js";
import { db } from "./db.js";
import type { ShortHorizonAccountRef } from "./periodReturnsShortHorizon.js";

/**
 * A credit card's daily P/L is the cost the bank charged it, loss-negative — buying and
 * paying are capital flow, and so is the correction a stored evidence anchor applies to the
 * walk. Synthetic card, fixture dates in 2037.
 */

// Chile 2037-04-20 → grid ends on that calendar day.
const NOW = new Date("2037-04-20T23:00:00Z");

let leafSlug: string | null = null;
let ccId: number | null = null;
let statementId: number | null = null;

function refs(): ShortHorizonAccountRef[] {
  return ccId != null && leafSlug != null
    ? [{ account_id: ccId, bucket_slug: leafSlug }]
    : [];
}

beforeAll(() => {
  const leaf = db
    .prepare(
      `SELECT id, slug FROM asset_groups WHERE slug LIKE '%__credit_card' OR slug LIKE 'credit_cards__%' LIMIT 1`
    )
    .get() as { id: number; slug: string } | undefined;
  if (!leaf) return;
  leafSlug = leaf.slug;

  ccId = Number(
    db
      .prepare(
        `INSERT INTO accounts (asset_group_id, name, notes, import_key, account_kind)
         VALUES (?, 'Vitest · daily liability card', 'vitest-daily-liab', 'vitest-daily-liab', 'master')`
      )
      .run(leaf.id).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO credit_card_account_config (account_id, card_last4, billing_cycle_start_day, billing_cycle_end_day)
     VALUES (?, '9999', 21, 20)`
  ).run(ccId);

  statementId = Number(
    db
      .prepare(
        `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, period_from, period_to, currency)
         VALUES (?, 'santander', 'vitest-daily-liab.pdf', '20/04/2037', '21/03/2037', '20/04/2037', 'clp')`
      )
      .run(ccId).lastInsertRowid
  );
  const insLine = db.prepare(
    `INSERT INTO cc_statement_lines (statement_id, transaction_date, merchant, amount_clp, installment_flag, dedupe_key)
     VALUES (?, ?, ?, ?, 0, ?)`
  );
  insLine.run(statementId, "16/04/2037", "TIENDA VITEST", 120000, "vitest-daily-liab-buy");
  insLine.run(statementId, "17/04/2037", "INTERESES", 9000, "vitest-daily-liab-int");
  insLine.run(statementId, "18/04/2037", "MONTO CANCELADO", -200000, "vitest-daily-liab-pago");

  // Owed anchors: the walk runs between them, and the last one deliberately disagrees with
  // the line events (the live-formula reframing every card carries).
  const insVal = db.prepare(
    `INSERT INTO valuations (account_id, as_of_date, value, currency) VALUES (?, ?, ?, 'clp')`
  );
  insVal.run(ccId, "2037-04-14", 500000);
  insVal.run(ccId, "2037-04-20", 800000);
  clearAggregationCache();
});

afterAll(() => {
  if (statementId != null) {
    db.prepare(`DELETE FROM cc_statement_lines WHERE statement_id = ?`).run(statementId);
    db.prepare(`DELETE FROM cc_statements WHERE id = ?`).run(statementId);
  }
  if (ccId != null) {
    db.prepare(`DELETE FROM credit_card_account_config WHERE account_id = ?`).run(ccId);
    db.prepare(`DELETE FROM valuations WHERE account_id = ?`).run(ccId);
    db.prepare(`DELETE FROM accounts WHERE id = ?`).run(ccId);
  }
  clearAggregationCache();
});

describe("getBucketDailySeries — credit card", () => {
  it("P/L is the day's financing charge (negative); buying, paying and anchor snaps are flow", () => {
    if (ccId == null) return;
    const s = getBucketDailySeries(refs(), { unit: "clp", days: 5, now: NOW });
    const byDate = new Map(s.points.map((p) => [p.as_of_date, p]));

    // Purchase day: debt up 120.000, all of it borrowing.
    expect(byDate.get("2037-04-16")?.pl).toBe(0);
    expect(byDate.get("2037-04-16")?.flow).toBe(-120000);
    // Charge day: the only cost, loss-negative, with no flow.
    expect(byDate.get("2037-04-17")?.pl).toBe(-9000);
    expect(byDate.get("2037-04-17")?.flow).toBe(0);
    // Payment day: capital in, no P/L.
    expect(byDate.get("2037-04-18")?.pl).toBe(0);
    expect(byDate.get("2037-04-18")?.flow).toBe(200000);
    // Anchor day: the balance snaps to the stored evidence and the gap is flow, not cost.
    expect(byDate.get("2037-04-20")?.pl).toBe(0);
    expect(byDate.get("2037-04-20")?.flow).not.toBe(0);

    // Whole window: cost is exactly the charges, whatever the balance did.
    const totalPl = s.points.reduce((sum, p) => sum + (p.pl ?? 0), 0);
    expect(totalPl).toBe(-9000);
  });

  it("keeps the liability identity on every day: pl = prior − owed − flow", () => {
    if (ccId == null) return;
    const s = getBucketDailySeries(refs(), { unit: "clp", days: 5, now: NOW });
    let prev = s.baseline.value;
    for (const p of s.points) {
      if (prev != null && p.value != null) {
        expect(p.pl).toBeCloseTo(prev - p.value - p.flow, 6);
      }
      prev = p.value;
    }
  });
});
