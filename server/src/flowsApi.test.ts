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
import { moneyDirectionForAccount } from "./accountMovementsApi.js";
import { internalTransferFlowType } from "./movementFlowType.js";
import { listAccountsForGroupTab } from "./valuationTimeseries.js";
import type { MovementTransferRow } from "./movementTransfer.js";

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
    from_account_id: null,
    from_account_name: null,
    to_account_id: null,
    to_account_name: null,
    money_direction: "in",
    forward_posted: false,
    internal: false,
    counterpart_bucket_slug: null,
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
      // An internal transfer belongs to its target's bucket too.
      for (const r of filtered.rows) {
        expect(r.bucket_slug === b.slug || (r.internal && r.counterpart_bucket_slug === b.slug)).toBe(true);
      }
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

describe("money direction of a movement", () => {
  const row = (over: Partial<MovementTransferRow>): MovementTransferRow => ({
    id: 1,
    account_id: 5,
    from_account_id: null,
    to_account_id: null,
    amount: 0,
    currency: "clp",
    counter_amount: null,
    counter_currency: null,
    occurred_on: "2026-01-15",
    note: null,
    units_delta: null,
    counter_units_delta: null,
    flow_kind: null,
    ...over,
  });

  it("reads a transfer by its leg", () => {
    const t = row({ account_id: null, from_account_id: 5, to_account_id: 6, amount: 1000 });
    expect(moneyDirectionForAccount(t, 5)).toBe("out");
    expect(moneyDirectionForAccount(t, 6)).toBe("in");
  });

  it("reads a peso movement by its sign", () => {
    expect(moneyDirectionForAccount(row({ amount: 15_000 }), 5)).toBe("in");
    expect(moneyDirectionForAccount(row({ amount: -15_000 }), 5)).toBe("out");
  });

  it("reads a dollar movement, stored unsigned, by its kind", () => {
    expect(moneyDirectionForAccount(row({ currency: "usd", amount: 0.4, flow_kind: "savings_earnings" }), 5)).toBe("in");
    expect(moneyDirectionForAccount(row({ currency: "usd", amount: 2, flow_kind: "cash_fee" }), 5)).toBe("out");
  });

  it("reads a unit-only row of zero pesos by its units", () => {
    expect(moneyDirectionForAccount(row({ units_delta: -0.001, flow_kind: "cash_fee" }), 5)).toBe("out");
  });

  it("gives a movement of nothing no direction (a zero opening balance)", () => {
    expect(moneyDirectionForAccount(row({ amount: 0 }), 5)).toBeNull();
  });

  it("throws when a movement moves money but nothing says which way", () => {
    expect(() => moneyDirectionForAccount(row({ currency: "usd", amount: 5, flow_kind: null }), 5)).toThrow(
      /neither its amount/
    );
  });
});

describe("group flows show a transfer between two of their accounts once", () => {
  const groupIds = (): number[] => listAccountsForGroupTab("net_worth").map((r) => r.account_id);

  function insertTransfer(from: number, to: number, amount: number, note: string): number {
    const day = addCalendarMonths(chileCalendarTodayYmd().slice(0, 7), -1) + "-13";
    return Number(
      db
        .prepare(
          `INSERT INTO movements (account_id, from_account_id, to_account_id, amount, currency, occurred_on, note)
           VALUES (NULL, ?, ?, ?, 'clp', ?, ?)`
        )
        .run(from, to, amount, day, note).lastInsertRowid
    );
  }

  it("keeps the origin's row, unsigned, as a «Traspaso», reachable from either account", () => {
    const origin = checkingAccountId();
    const target = groupIds().find((id) => id !== origin)!;
    const id = insertTransfer(origin, target, 77_123, "VITEST FLOWS INTERNAL");
    try {
      const res = buildGroupFlows("net_worth", { q: "VITEST FLOWS INTERNAL" }, 1, 50);
      expect(res.total).toBe(1);
      const r = res.rows[0]!;
      expect(r).toMatchObject({
        id,
        key: `movement:${id}`,
        internal: true,
        account_id: origin,
        from_account_id: origin,
        to_account_id: target,
        counterpart_account_id: target,
        amount: 77_123,
        flow_type: "internal_transfer_clp",
        flow_type_label: "Traspaso CLP",
      });

      const byTarget = buildGroupFlows("net_worth", { q: "VITEST FLOWS INTERNAL", account_id: target }, 1, 50);
      expect(byTarget.rows.map((x) => x.id)).toEqual([id]);
      expect(res.filter_options.accounts.map((a) => a.id)).toEqual(expect.arrayContaining([origin, target]));
      if (r.counterpart_bucket_slug != null) {
        const byBucket = buildGroupFlows(
          "net_worth",
          { q: "VITEST FLOWS INTERNAL", bucket: r.counterpart_bucket_slug },
          1,
          50
        );
        expect(byBucket.rows.map((x) => x.id)).toEqual([id]);
      }

      // Each account's own page still shows its leg, signed from its side.
      const targetRows = buildAccountFlows(target, { q: "VITEST FLOWS INTERNAL" }, 1, 50)!.rows;
      expect(targetRows).toHaveLength(1);
      expect(targetRows[0]).toMatchObject({ amount: 77_123, money_direction: "in", internal: false });
      const originRows = buildAccountFlows(origin, { q: "VITEST FLOWS INTERNAL" }, 1, 50)!.rows;
      expect(originRows[0]).toMatchObject({ amount: -77_123, money_direction: "out" });
    } finally {
      db.prepare(`DELETE FROM movements WHERE id = ?`).run(id);
    }
  });

  it("keeps the one leg on the page when the other account is outside the group", () => {
    const inGroup = new Set(groupIds());
    const outside = (db.prepare(`SELECT id FROM accounts ORDER BY id`).all() as { id: number }[])
      .map((r) => r.id)
      .find((id) => !inGroup.has(id));
    expect(outside, "the synthetic preset has an account outside net worth").toBeTruthy();
    const origin = checkingAccountId();
    const id = insertTransfer(origin, outside!, 31_457, "VITEST FLOWS ONE LEG");
    try {
      const res = buildGroupFlows("net_worth", { q: "VITEST FLOWS ONE LEG" }, 1, 50);
      expect(res.rows).toHaveLength(1);
      expect(res.rows[0]).toMatchObject({
        internal: false,
        amount: -31_457,
        money_direction: "out",
        from_account_id: origin,
        to_account_id: outside,
        flow_type: "withdrawal_clp",
      });
    } finally {
      db.prepare(`DELETE FROM movements WHERE id = ?`).run(id);
    }
  });
});

describe("the type of a transfer shown once", () => {
  it("names a kind-less transfer by its currency, a conversion «Cambio de divisas»", () => {
    expect(internalTransferFlowType("withdrawal_clp", "clp", null)).toEqual({
      flow_type: "internal_transfer_clp",
      flow_type_label: "Traspaso CLP",
    });
    expect(internalTransferFlowType("withdrawal_usd", "usd", null).flow_type_label).toBe("Traspaso USD");
    for (const [from, to] of [["usd", "clp"], ["clp", "usd"], ["usd", "eur"]] as const) {
      const leg = from === "clp" ? "withdrawal_clp" : "withdrawal_usd";
      expect(internalTransferFlowType(leg, from, to)).toEqual({
        flow_type: "internal_fx_exchange",
        flow_type_label: "Cambio de divisas",
      });
    }
  });

  it("keeps a kind that names no side", () => {
    expect(internalTransferFlowType("pago_tarjeta", "clp", null)).toEqual({
      flow_type: "pago_tarjeta",
      flow_type_label: "Pago tarjeta",
    });
  });
});
