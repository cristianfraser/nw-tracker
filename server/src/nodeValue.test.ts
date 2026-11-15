import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clearAggregationCache } from "./cacheRegistry.js";
import { chileCalendarAddDays, chileCalendarTodayYmd } from "./chileDate.js";
import { linkedCardsOwedInUnit } from "./cashEqsBucketNet.js";
import { db } from "./db.js";
import { linkedCreditCardClpForCashCardAsOf } from "./linkedCreditCards.js";
import {
  nodeNetsLinkedCards,
  nodeValue,
  nodeValueFromSum,
  nodeValueMembers,
  nodeValueSeriesFromSums,
  nodeValueSeriesOnGrid,
  nodeValuesAtDates,
  type NodePointValuePolicy,
  type NodeValueMember,
  type NodeValueRules,
} from "./nodeValue.js";
import { clpToUnitAt } from "./valueConvert.js";

const rules = (over: Partial<NodeValueRules> = {}): NodeValueRules => ({
  empty: "null",
  rounding: "none",
  ...over,
});

describe("nodeValueFromSum — the rule kernel", () => {
  it("a node that does not net reads its sum", () => {
    expect(nodeValueFromSum(1_000.4, undefined, "clp", rules())).toBe(1_000.4);
  });

  it("nets the linked cards signed: owed subtracts, a card in credit adds", () => {
    expect(nodeValueFromSum(1_000_000, 250_000, "clp", rules())).toBe(750_000);
    expect(nodeValueFromSum(1_000_000, -50_000, "clp", rules())).toBe(1_050_000);
  });

  it("empty `null`: absent, netting or not", () => {
    expect(nodeValueFromSum(null, undefined, "clp", rules({ empty: "null" }))).toBeNull();
    expect(nodeValueFromSum(null, 250_000, "clp", rules({ empty: "null" }))).toBeNull();
  });

  it("empty `null_unless_netted`: absent, except a netting node reads 0 less the cards", () => {
    const r = rules({ empty: "null_unless_netted" });
    expect(nodeValueFromSum(null, undefined, "clp", r)).toBeNull();
    expect(nodeValueFromSum(null, 250_000, "clp", r)).toBe(-250_000);
    expect(nodeValueFromSum(null, -50_000, "clp", r)).toBe(50_000);
  });

  it("empty `zero`: 0, then netted", () => {
    const r = rules({ empty: "zero" });
    expect(nodeValueFromSum(null, undefined, "clp", r)).toBe(0);
    expect(nodeValueFromSum(null, 250_000, "clp", r)).toBe(-250_000);
  });

  it("rounds once, after netting, to the unit's coin", () => {
    // 1000.4 + 2000.4 − 0.3 = 3000.5 → 3001; rounding each part first would give 3000.
    expect(nodeValueFromSum(1_000.4 + 2_000.4, 0.3, "clp", rules({ rounding: "unit_coin" }))).toBe(3_001);
    expect(nodeValueFromSum(1_000.4 + 2_000.4, 0.3, "clp", rules({ rounding: "none" }))).toBeCloseTo(3_000.5, 9);
    expect(nodeValueFromSum(10.004 + 10.004, undefined, "usd", rules({ rounding: "unit_coin" }))).toBe(20.01);
  });
});

describe("nodeValueMembers", () => {
  const members: NodeValueMember[] = [
    { account_id: 5, bucket_slug: "x" },
    { account_id: -7, bucket_slug: "x" },
    { account_id: 6, bucket_slug: "x", exclude_from_group_totals: 1 },
    { account_id: -8, bucket_slug: "x", exclude_from_group_totals: 1 },
  ];
  it("`counted` drops the excluded; `real_counted` also drops synthetic ids", () => {
    expect(nodeValueMembers(members, "counted").map((m) => m.account_id)).toEqual([5, -7]);
    expect(nodeValueMembers(members, "real_counted").map((m) => m.account_id)).toEqual([5]);
  });
});

describe("nodeValueSeriesFromSums", () => {
  it("refuses sums that do not line up with the dates", () => {
    expect(() =>
      nodeValueSeriesFromSums([1], ["2026-08-15", "2026-08-16"], "clp", { ...rules(), netsLinkedCards: false })
    ).toThrow(/1 sums for 2 dates/);
  });
});

/**
 * Synthetic fixture (repo policy): two stored-valuation accounts with fractional marks, a third
 * flagged out of totals, and one synthetic card linked under Pasivos → tarjeta de crédito whose
 * stored balance is the whole linked total (the test DB's own linked cards are set aside and
 * restored). `OLD_DAY` predates every stored exchange rate: the card owes there, with no rate.
 */
describe("nodeValue on accounts", () => {
  const D1 = "2026-08-15";
  const GRID = [D1, "2026-08-16", "2026-08-17"];
  const BEFORE = "2026-07-01";
  const OLD_FROM = "1990-03-01";
  const OLD_DAY = "1990-03-05";
  const CARD_FROM = "2026-08-01";
  const A = 1_000.4;
  const B = 2_000.4;
  const B_LATER = 2_500.25;
  const OWED = 654_321;
  const OLD_OWED = 1_000;

  let leafSlug = "";
  const ids: number[] = [];
  let cardId: number | null = null;
  const setAsideFlags = new Map<number, number>();
  let members: NodeValueMember[] = [];

  const point = (over: Partial<NodePointValuePolicy> = {}): NodePointValuePolicy => ({
    members: "counted",
    netsLinkedCards: false,
    empty: "null",
      rounding: "none",
    ...over,
  });

  function setCard(balance: number): void {
    db.prepare(`UPDATE valuations SET value = ? WHERE account_id = ? AND as_of_date = ?`).run(balance, cardId, CARD_FROM);
    clearAggregationCache();
  }

  beforeAll(() => {
    const leaf = db
      .prepare(`SELECT id, slug FROM asset_groups WHERE slug LIKE 'brokerage_acciones__%' LIMIT 1`)
      .get() as { id: number; slug: string } | undefined;
    const ccGroup = db.prepare(`SELECT id FROM liability_groups WHERE slug = 'liabilities_credit_card'`).get() as
      | { id: number }
      | undefined;
    const ccLeaf = db.prepare(`SELECT id FROM asset_groups WHERE slug = 'credit_cards__credit_card'`).get() as
      | { id: number }
      | undefined;
    if (!leaf || !ccGroup || !ccLeaf) throw new Error("test DB lacks the brokerage leaf or the credit-card group");
    leafSlug = leaf.slug;

    const account = (key: string, excluded: 0 | 1): number => {
      const id = Number(
        db
          .prepare(
            `INSERT INTO accounts (asset_group_id, name, notes, import_key, exclude_from_group_totals)
             VALUES (?, ?, ?, ?, ?)`
          )
          .run(leaf.id, `Vitest · ${key}`, key, key, excluded).lastInsertRowid
      );
      ids.push(id);
      return id;
    };
    const insVal = db.prepare(`INSERT INTO valuations (account_id, as_of_date, value, currency) VALUES (?, ?, ?, 'clp')`);
    const a = account("vitest-node-value-a", 0);
    const b = account("vitest-node-value-b", 0);
    const x = account("vitest-node-value-excluded", 1);
    insVal.run(a, D1, A);
    insVal.run(b, D1, B);
    insVal.run(b, GRID[2], B_LATER);
    insVal.run(x, D1, 9_999_999);
    members = [
      { account_id: a, bucket_slug: leafSlug },
      { account_id: b, bucket_slug: leafSlug },
      { account_id: x, bucket_slug: leafSlug, exclude_from_group_totals: 1 },
    ];

    const linkedMasters = db
      .prepare(
        `SELECT m.id, m.exclude_from_group_totals AS excl
         FROM accounts m
         JOIN liability_group_items lgi ON lgi.account_id = m.id AND lgi.item_kind = 'account'
         JOIN liability_groups lg ON lg.id = lgi.group_id AND lg.slug = 'liabilities_credit_card'`
      )
      .all() as { id: number; excl: number }[];
    for (const m of linkedMasters) {
      setAsideFlags.set(m.id, m.excl);
      db.prepare(`UPDATE accounts SET exclude_from_group_totals = 1 WHERE id = ?`).run(m.id);
    }
    const key = "vitest-node-value-linked-card";
    cardId = Number(
      db
        .prepare(`INSERT INTO accounts (asset_group_id, name, notes, import_key) VALUES (?, 'Vitest · node value card', ?, ?)`)
        .run(ccLeaf.id, key, key).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO liability_group_items (group_id, item_kind, account_id, sort_order) VALUES (?, 'account', ?, 999)`
    ).run(ccGroup.id, cardId);
    insVal.run(cardId, OLD_FROM, OLD_OWED);
    insVal.run(cardId, CARD_FROM, 0);
    setCard(OWED);
  });

  afterAll(() => {
    if (cardId != null) {
      db.prepare(`DELETE FROM valuations WHERE account_id = ?`).run(cardId);
      db.prepare(`DELETE FROM liability_group_items WHERE account_id = ?`).run(cardId);
      db.prepare(`DELETE FROM accounts WHERE id = ?`).run(cardId);
    }
    for (const id of ids) {
      db.prepare(`DELETE FROM valuations WHERE account_id = ?`).run(id);
      db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
    }
    for (const [id, excl] of setAsideFlags) {
      db.prepare(`UPDATE accounts SET exclude_from_group_totals = ? WHERE id = ?`).run(excl, id);
    }
    clearAggregationCache();
  });

  it("the fixture controls the linked total, and the old day has no dollar rate", () => {
    expect(linkedCreditCardClpForCashCardAsOf(D1)).toBe(OWED);
    expect(linkedCreditCardClpForCashCardAsOf(OLD_DAY)).toBe(OLD_OWED);
    expect(clpToUnitAt(OLD_OWED, OLD_DAY, "usd", { side: "debt" })).toBeNull();
    expect(clpToUnitAt(OWED, D1, "usd", { side: "debt" })).not.toBeNull();
  });

  it("the netting flag of a group comes from the tree's declared netting", () => {
    expect(nodeNetsLinkedCards("cash_eqs")).toBe(true);
    expect(nodeNetsLinkedCards("brokerage")).toBe(false);
  });

  it("sums the counted members and rounds once at the end", () => {
    expect(nodeValue(members, D1, "clp", point())).toBeCloseTo(A + B, 9);
    // 3000.8 → 3001; rounding each member first would read 3000.
    expect(nodeValue(members, D1, "clp", point({ rounding: "unit_coin" }))).toBe(3_001);
  });

  it("another unit is each member's own value in it", () => {
    const usd = nodeValue(members, D1, "usd", point())!;
    expect(usd).toBeCloseTo(clpToUnitAt(A, D1, "usd")! + clpToUnitAt(B, D1, "usd")!, 9);
  });

  it("nets the linked cards signed, at the debt side in another unit", () => {
    const raw = nodeValue(members, D1, "clp", point())!;
    expect(nodeValue(members, D1, "clp", point({ netsLinkedCards: true }))).toBeCloseTo(raw - OWED, 9);
    const rawUsd = nodeValue(members, D1, "usd", point())!;
    expect(nodeValue(members, D1, "usd", point({ netsLinkedCards: true }))).toBeCloseTo(
      rawUsd - clpToUnitAt(OWED, D1, "usd", { side: "debt" })!,
      9
    );
    setCard(-OWED);
    try {
      // A card in credit adds to the node.
      expect(nodeValue(members, D1, "clp", point({ netsLinkedCards: true }))).toBeCloseTo(raw + OWED, 9);
    } finally {
      setCard(OWED);
    }
  });

  it("a node none of whose members has a value follows the empty rule", () => {
    expect(nodeValue(members, BEFORE, "clp", point({ empty: "null" }))).toBeNull();
    expect(nodeValue(members, BEFORE, "clp", point({ empty: "null_unless_netted" }))).toBeNull();
    expect(nodeValue(members, BEFORE, "clp", point({ empty: "zero" }))).toBe(0);
    expect(nodeValue(members, BEFORE, "clp", point({ empty: "null", netsLinkedCards: true }))).toBeNull();
    // The card owes nothing before CARD_FROM except the old balance carried forward.
    expect(nodeValue(members, BEFORE, "clp", point({ empty: "null_unless_netted", netsLinkedCards: true }))).toBe(
      -OLD_OWED
    );
    expect(nodeValue([], D1, "clp", point({ empty: "zero", netsLinkedCards: true }))).toBe(-OWED);
  });

  it("linked cards that owe with no rate into the unit throw, in every form and under every empty rule", () => {
    const message = new RegExp(`linked credit cards: no usd rate on ${OLD_DAY}`);
    for (const empty of ["zero", "null", "null_unless_netted"] as const) {
      const policy = point({ netsLinkedCards: true, empty });
      expect(() => nodeValue(members, OLD_DAY, "usd", policy)).toThrow(message);
      expect(() => nodeValuesAtDates(members, [OLD_DAY], "usd", policy)).toThrow(message);
      expect(() => nodeValueSeriesFromSums([null], [OLD_DAY], "usd", policy)).toThrow(message);
      expect(() => nodeValueSeriesOnGrid(members, [OLD_DAY], "usd", policy)).toThrow(message);
    }
    expect(() => linkedCardsOwedInUnit(OLD_DAY, "usd")).toThrow(message);
    // Pesos need no rate, and a node that does not net asks for none.
    expect(nodeValue(members, OLD_DAY, "clp", point({ netsLinkedCards: true, empty: "zero" }))).toBe(-OLD_OWED);
    expect(nodeValue(members, OLD_DAY, "usd", point({ empty: "zero" }))).toBe(0);
  });

  it("cards owing nothing need no rate", () => {
    db.prepare(`UPDATE valuations SET value = 0 WHERE account_id = ? AND as_of_date = ?`).run(cardId, OLD_FROM);
    clearAggregationCache();
    try {
      expect(linkedCreditCardClpForCashCardAsOf(OLD_DAY)).toBe(0);
      expect(linkedCardsOwedInUnit(OLD_DAY, "usd")).toBe(0);
      expect(nodeValue(members, OLD_DAY, "usd", point({ netsLinkedCards: true, empty: "zero" }))).toBe(0);
    } finally {
      db.prepare(`UPDATE valuations SET value = ? WHERE account_id = ? AND as_of_date = ?`).run(OLD_OWED, cardId, OLD_FROM);
      clearAggregationCache();
    }
  });

  it("the dates form is the point value on each date", () => {
    const dates = [BEFORE, D1, GRID[2]!];
    const policy = point({ netsLinkedCards: true, empty: "null_unless_netted", rounding: "unit_coin" });
    for (const unit of ["clp", "usd"]) {
      expect(nodeValuesAtDates(members, dates, unit, policy)).toEqual(
        dates.map((d) => nodeValue(members, d, unit, policy))
      );
    }
  });

  it("the grid form equals the point value on every grid day, past days and today", () => {
    const today = chileCalendarTodayYmd();
    const grids = [GRID, [chileCalendarAddDays(today, -2), chileCalendarAddDays(today, -1), today]];
    const variants: Partial<NodePointValuePolicy>[] = [
      {},
      { netsLinkedCards: true },
      { netsLinkedCards: true, empty: "zero", rounding: "unit_coin" },
      { members: "real_counted", empty: "null_unless_netted" },
    ];
    for (const grid of grids) {
      for (const unit of ["clp", "usd"]) {
        for (const v of variants) {
          const policy = point(v);
          const series = nodeValueSeriesOnGrid(members, grid, unit, policy);
          const points = grid.map((d) => nodeValue(members, d, unit, policy));
          expect(series).toHaveLength(grid.length);
          series.forEach((s, i) => {
            if (points[i] == null) expect(s).toBeNull();
            else expect(s).toBeCloseTo(points[i]!, 6);
          });
        }
      }
    }
    // The later mark of B shows on its day.
    const clp = nodeValueSeriesOnGrid(members, GRID, "clp", point());
    expect(clp[0]).toBeCloseTo(A + B, 9);
    expect(clp[2]).toBeCloseTo(A + B_LATER, 9);
  });

  it("the sums form applies the same netting as the grid form", () => {
    const policy = point({ netsLinkedCards: true, empty: "zero", rounding: "unit_coin" });
    const raw = nodeValueSeriesOnGrid(members, GRID, "usd", point());
    expect(nodeValueSeriesFromSums(raw, GRID, "usd", policy)).toEqual(nodeValueSeriesOnGrid(members, GRID, "usd", policy));
  });
});
