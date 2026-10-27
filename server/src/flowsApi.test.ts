import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  applyFlowFilters,
  buildAccountFlows,
  buildGroupFlows,
  type FlowsApiRow,
} from "./flowsApi.js";
import { checkingAccountId } from "./checkingCartolaImport.js";
import { addCalendarMonths } from "./ccYearMonth.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { checkingMovementKey, checkingSpendingMovementKeys } from "./checkingSpendingMovements.js";

function flowRow(over: Partial<FlowsApiRow>): FlowsApiRow {
  return {
    id: 1,
    key: "1:movement:1",
    account_id: 1,
    account_name: "vitest-flows-a",
    bucket_slug: "brokerage_acciones",
    amount: 1000,
    currency: "clp",
    counter_amount: null,
    counter_currency: null,
    occurred_on: "2026-01-15",
    note: null,
    units_delta: null,
    counter_units_delta: null,
    flow_kind: null,
    flow_type: "deposit_clp",
    flow_type_label: "Depósito CLP",
    counterpart_account_id: null,
    counterpart_account_name: null,
    transfer_direction: null,
    forward_posted: false,
    ...over,
  };
}

describe("flows bucket filter", () => {
  it("applyFlowFilters matches rows by portfolio bucket; null-bucket rows never match", () => {
    const rows = [
      flowRow({ id: 1, key: "1:movement:1", bucket_slug: "brokerage_acciones" }),
      flowRow({ id: 2, key: "2:movement:2", account_id: 2, bucket_slug: "cash_savings" }),
      flowRow({ id: 3, key: "3:movement:3", account_id: 3, bucket_slug: null }),
    ];
    expect(applyFlowFilters(rows, { bucket: "cash_savings" }).map((r) => r.id)).toEqual([2]);
    expect(applyFlowFilters(rows, {})).toHaveLength(3);
  });

  it("group flows expose portfolio-bucket options that round-trip as filters", () => {
    const res = buildGroupFlows("net_worth", {}, 1, 50);
    expect(res.total).toBeGreaterThan(0);
    expect(res.filter_options.buckets.length).toBeGreaterThan(0);

    for (const b of res.filter_options.buckets) {
      // Every option is a real portfolio_groups node (no legacy asset_groups slugs).
      const pg = db
        .prepare(`SELECT slug, label FROM portfolio_groups WHERE slug = ?`)
        .get(b.slug) as { slug: string; label: string } | undefined;
      expect(pg, `bucket option ${b.slug} must be a portfolio_groups slug`).toBeTruthy();
      expect(b.label).toBe(pg!.label);

      // Options come from rows, so filtering by one must return only (and some) matching rows.
      const filtered = buildGroupFlows("net_worth", { bucket: b.slug }, 1, 50);
      expect(filtered.total).toBeGreaterThan(0);
      for (const r of filtered.rows) expect(r.bucket_slug).toBe(b.slug);
    }

    for (const r of res.rows) {
      if (r.bucket_slug != null) {
        expect(res.filter_options.buckets.some((b) => b.slug === r.bucket_slug)).toBe(true);
      }
    }
  });

  it("single-account flows carry the account's bucket but no bucket options", () => {
    const linked = db
      .prepare(
        `SELECT i.account_id, pg.slug
         FROM portfolio_group_items i
         JOIN portfolio_groups pg ON pg.id = i.group_id
         WHERE i.item_kind = 'account'
           AND EXISTS (SELECT 1 FROM movements m WHERE m.account_id = i.account_id)
         ORDER BY LENGTH(pg.slug) DESC
         LIMIT 1`
      )
      .get() as { account_id: number; slug: string } | undefined;
    expect(linked, "synthetic preset should link an account with movements").toBeTruthy();

    const res = buildAccountFlows(linked!.account_id, {}, 1, 20);
    expect(res).toBeTruthy();
    expect(res!.filter_options.buckets).toEqual([]);
    expect(res!.rows.length).toBeGreaterThan(0);
    for (const r of res!.rows) expect(r.bucket_slug).toBe(linked!.slug);
  });
});

describe("net-worth flows without spending (exclude_spending)", () => {
  it("leaves out the checking debits the Expenses page counts, keeps the rest", () => {
    const accountId = checkingAccountId();
    // Inside the synthetic preset's market window (the USD gastos amount reads the day's fx).
    const day = addCalendarMonths(chileCalendarTodayYmd().slice(0, 7), -1) + "-12";
    const month = day.slice(0, 7);
    const insert = (amount: number, description: string, idx: number): number =>
      Number(
        db
          .prepare(
            `INSERT INTO movements (account_id, amount, currency, occurred_on, note, units_delta)
             VALUES (?, ?, 'clp', ?, ?, NULL)`
          )
          .run(
            accountId,
            amount,
            day,
            `import:cartola|${month}|Agustinas|${description}|on:${day}|amt:${amount}|idx:${idx}`
          ).lastInsertRowid
      );
    const debitId = insert(-48_317, "PAGO VITEST SPENDING SHOP", 1);
    const creditId = insert(91_423, "ABONO VITEST SPENDING INCOME", 2);
    try {
      expect(checkingSpendingMovementKeys().has(checkingMovementKey(debitId, accountId))).toBe(true);
      expect(checkingSpendingMovementKeys().has(checkingMovementKey(creditId, accountId))).toBe(false);

      const filters = { date_from: day, date_to: day, q: "VITEST SPENDING" };
      const all = buildGroupFlows("net_worth", filters, 1, 50);
      expect(all.rows.map((r) => r.id).sort()).toEqual([debitId, creditId].sort());

      const wealth = buildGroupFlows("net_worth", filters, 1, 50, { excludeSpending: true });
      expect(wealth.rows.map((r) => r.id)).toEqual([creditId]);
      expect(wealth.total).toBe(1);
    } finally {
      db.prepare(`DELETE FROM movements WHERE id IN (?, ?)`).run(debitId, creditId);
    }
  });
});
