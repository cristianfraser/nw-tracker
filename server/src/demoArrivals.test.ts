import { afterAll, describe, expect, it } from "vitest";
import { clearAggregationCache } from "./cacheRegistry.js";
import { deleteLines } from "./cards/lineWrites.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { db } from "./db.js";
import { roundToCurrency } from "./displayUnits.js";
import { stream } from "./demoData/rng.js";
import {
  DEMO_ARRIVAL_BATCHES_PER_DAY,
  DEMO_ARRIVALS_PER_BATCH_MAX,
  demoArrivalBatchDecision,
  demoArrivalBatchDelaysMs,
  demoArrivalCandidates,
  drawDemoArrival,
  loadDemoArrivalCandidates,
  resetDemoArrivalsForTest,
  runDemoArrival,
  type DemoArrivalHistoryLine,
} from "./demoArrivals.js";
import { demoWrittenSinceReset, resetDemoWritableStateForTest } from "./demoWritable.js";
import { liveQuoteMovesSince, resetLiveQuotesStampForTest } from "./liveQuotesStamp.js";
import { snapshotTables } from "./test/snapshotTables.js";

describe("demo arrival schedule", () => {
  it("one batch at a time, at most the daily cap per Chile day", () => {
    const idle = { day: null, batchesToday: 0, pending: false };
    expect(demoArrivalBatchDecision(idle, "2026-11-26")).toEqual({ start: true, batchNo: 1 });
    expect(demoArrivalBatchDecision({ ...idle, day: "2026-11-26", batchesToday: 2, pending: true }, "2026-11-26")).toEqual({
      start: false,
      reason: "pending",
    });
    const capped = { day: "2026-11-26", batchesToday: DEMO_ARRIVAL_BATCHES_PER_DAY, pending: false };
    expect(demoArrivalBatchDecision(capped, "2026-11-26")).toEqual({ start: false, reason: "daily_cap" });
    // A new Chile day starts the count again.
    expect(demoArrivalBatchDecision(capped, "2026-11-27")).toEqual({ start: true, batchNo: 1 });
  });

  it("1–3 arrivals: the first 20–40 s after the wake, then 30–60 s apart", () => {
    const counts = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const delays = demoArrivalBatchDelaysMs(stream(7, `schedule|${i}`));
      counts.add(delays.length);
      expect(delays[0]).toBeGreaterThanOrEqual(20_000);
      expect(delays[0]).toBeLessThanOrEqual(40_000);
      for (const gap of delays.slice(1)) {
        expect(gap).toBeGreaterThanOrEqual(30_000);
        expect(gap).toBeLessThanOrEqual(60_000);
      }
    }
    expect([...counts].sort()).toEqual(Array.from({ length: DEMO_ARRIVALS_PER_BATCH_MAX }, (_, i) => i + 1));
  });
});

describe("demo arrival candidates", () => {
  const line = (merchant: string, amount: number, date: string, currency = "clp"): DemoArrivalHistoryLine => ({
    merchant,
    currency,
    amount,
    date,
  });

  it("leaves out subscriptions, declared recurring payments and merchants already on the card today", () => {
    const lines = [
      line("CAFE ALTO", 4_500, "2026-09-03"),
      line("CAFE ALTO", 5_200, "2026-10-11"),
      line("STREAMFLIX", 9_990, "2026-09-05"),
      line("STREAMFLIX", 9_990, "2026-10-05"),
      line("SEGURO AUTO VITEST", 41_000, "2026-10-07"),
      line("PANADERIA SUR", 3_100, "2026-11-26"),
      line("PANADERIA SUR", 2_800, "2026-11-02"),
      line("BOOKSHOP", 21.5, "2026-10-20", "usd"),
      line("BOOKSHOP", 18_000, "2026-11-01"),
    ];
    const candidates = demoArrivalCandidates(lines, {
      recurringPatterns: [["seguro auto"]],
      merchantsToday: new Set(["panaderia sur "]),
    });
    expect(candidates).toEqual([
      { merchant: "BOOKSHOP", currency: "clp", amounts: [18_000] },
      { merchant: "BOOKSHOP", currency: "usd", amounts: [21.5] },
      { merchant: "CAFE ALTO", currency: "clp", amounts: [4_500, 5_200] },
    ]);
  });

  it("leaves out a bill charged once a month, whatever its amount", () => {
    const candidates = demoArrivalCandidates(
      [
        line("DIVIDENDO VITEST", 268_510, "2026-09-10"),
        line("DIVIDENDO VITEST", 269_152, "2026-10-10"),
        line("DIVIDENDO VITEST", 269_776, "2026-11-10"),
        line("TACOS", 9_000, "2026-09-04"),
        line("TACOS", 11_000, "2026-10-09"),
        line("TACOS", 8_500, "2026-10-21"),
        line("TACOS", 9_700, "2026-11-13"),
      ],
      { recurringPatterns: [], merchantsToday: new Set() }
    );
    expect(candidates).toEqual([{ merchant: "TACOS", currency: "clp", amounts: [8_500, 9_000, 9_700, 11_000] }]);
  });

  it("one amount repeated within one month is not a subscription", () => {
    const candidates = demoArrivalCandidates([line("KIOSKO", 1_000, "2026-11-02"), line("KIOSKO", 1_000, "2026-11-20")], {
      recurringPatterns: [],
      merchantsToday: new Set(),
    });
    expect(candidates).toEqual([{ merchant: "KIOSKO", currency: "clp", amounts: [1_000, 1_000] }]);
  });
});

describe("demo arrival draw", () => {
  it("a past amount × 0,8–1,2 in the line's own currency, rounded to its coin, dated today", () => {
    const candidates = [
      { merchant: "CAFE ALTO", currency: "clp", amounts: [5_000] },
      { merchant: "BOOKSHOP", currency: "usd", amounts: [20] },
    ];
    for (let i = 0; i < 100; i++) {
      const d = drawDemoArrival(candidates, stream(3, `draw|${i}`), "2026-11-26")!;
      expect(d.date).toBe("2026-11-26");
      const base = candidates.find((c) => c.merchant === d.merchant)!;
      expect(d.currency).toBe(base.currency);
      expect(d.amount).toBe(roundToCurrency(d.amount, d.currency));
      expect(d.amount).toBeGreaterThanOrEqual(base.amounts[0]! * 0.8 - 0.01);
      expect(d.amount).toBeLessThanOrEqual(base.amounts[0]! * 1.2 + 0.01);
    }
  });

  it("is seeded: the same stream draws the same arrival", () => {
    const candidates = [
      { merchant: "A", currency: "clp", amounts: [1_000, 2_000] },
      { merchant: "B", currency: "clp", amounts: [3_000] },
    ];
    expect(drawDemoArrival(candidates, stream(1, "x"), "2026-11-26")).toEqual(
      drawDemoArrival(candidates, stream(1, "x"), "2026-11-26")
    );
  });

  it("no candidate, no arrival", () => {
    expect(drawDemoArrival([], stream(1, "x"), "2026-11-26")).toBeNull();
  });
});

describe("runDemoArrival on the Vitest person", () => {
  // The write and the cleanup's delete recompute the card's marks, anchors and billing snapshot.
  const restoreDerived = snapshotTables(["valuations", "cc_owed_anchors", "cc_billing_month_metrics"]);
  let inserted: { cardId: number; lineId: number } | null = null;
  const batchesBefore = (db.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM import_batches`).get() as { id: number }).id;
  const statementsBefore = (db.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM cc_statements`).get() as { id: number }).id;

  afterAll(() => {
    if (inserted) deleteLines(inserted.cardId, [inserted.lineId], { what: "demo arrival test cleanup" });
    db.prepare(
      `DELETE FROM cc_statements WHERE id > ? AND NOT EXISTS (SELECT 1 FROM cc_statement_lines l WHERE l.statement_id = cc_statements.id)`
    ).run(statementsBefore);
    db.prepare(`DELETE FROM import_batches WHERE id > ?`).run(batchesBefore);
    restoreDerived();
    resetDemoWritableStateForTest();
    resetDemoArrivalsForTest();
    resetLiveQuotesStampForTest(new Date().toISOString());
    clearAggregationCache();
  });

  it("one line dated the Chile today lands in the card's open bucket, marks the DB written and moves everything", async () => {
    resetDemoWritableStateForTest();
    const since = new Date(Date.now() - 1_000).toISOString();
    resetLiveQuotesStampForTest(since);
    const today = chileCalendarTodayYmd();
    const loaded = loadDemoArrivalCandidates(today);
    expect(loaded).not.toBeNull();
    expect(loaded!.candidates.length).toBeGreaterThan(0);
    const linesOfCard = () =>
      db
        .prepare(
          `SELECT l.id, l.merchant, l.transaction_date, l.amount, l.currency, s.source_kind
             FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id
            WHERE s.account_id = ?`
        )
        .all(loaded!.cardId) as {
        id: number;
        merchant: string;
        transaction_date: string;
        amount: number;
        currency: string;
        source_kind: string;
      }[];
    const before = new Set(linesOfCard().map((l) => l.id));

    const r = await runDemoArrival(stream(11, "integration"));
    expect(r.status).toBe("inserted");
    if (r.status !== "inserted") return;
    expect(r.card_id).toBe(loaded!.cardId);

    const added = linesOfCard().filter((l) => !before.has(l.id));
    expect(added).toHaveLength(1);
    const line = added[0]!;
    inserted = { cardId: r.card_id, lineId: line.id };
    expect(line.transaction_date).toBe(`${today.slice(8, 10)}/${today.slice(5, 7)}/${today.slice(0, 4)}`);
    expect(line.source_kind).toBe("listing_open");
    expect(loaded!.candidates.map((c) => c.merchant)).toContain(line.merchant);
    expect(line.currency).toBe(r.arrival.currency);
    expect(line.amount).toBe(r.arrival.amount);

    expect(demoWrittenSinceReset()).toBe(true);
    expect(liveQuoteMovesSince(since)?.all).toBe(true);
  });
});
