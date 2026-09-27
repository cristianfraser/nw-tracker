import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { db } from "./db.js";
import {
  filterLedgerPurchasesForSchedule,
  installmentRemainingClpByCalendarMonth,
  liveCreditCardOutstandingClp,
} from "./ccInstallmentLedgerDb.js";
import { ccCupoFrame } from "./ccBillingViews.js";
import {
  latestCreditCardBillingBalanceTotalClp,
  upsertCreditCardValuationsFromLedger,
} from "./ccCreditCardValuations.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import {
  ensureVitestCreditCardFixtures,
  getVitestSantanderCcMasterAccountId, wipeVitestCcFixtureData } from "./test/vitestDbSeed.js";

/** The current month on the Chile clock — the one the ledger uses. */
function chileCurrentYm(): string {
  return chileCalendarTodayYmd().slice(0, 7);
}

describe("filterLedgerPurchasesForSchedule", () => {
  it("excludes N/CUOTAS PRECIO when a matching indexed purchase exists", () => {
    const filtered = filterLedgerPurchasesForSchedule([
      {
        id: 1,
        canonical_row_id: "a",
        card_group: "A",
        purchase_date: "2024-12-03",
        total_amount_clp: 109_990,
        cuotas_totales: 12,
        merchant: "APPLE.COM CL APPLE N/CUOTAS PRECIO",
        description_merged: null,
        matched_baseline_purchase_id: null,
        source: "pdf",
        first_due_month: null,
        twin_index: 0,
      },
      {
        id: 2,
        canonical_row_id: "b",
        card_group: "A",
        purchase_date: "2024-12-03",
        total_amount_clp: 109_990,
        cuotas_totales: 12,
        merchant: "APPLE.COM CL APPLE",
        description_merged: null,
        matched_baseline_purchase_id: null,
        source: "pdf",
        first_due_month: null,
        twin_index: 0,
      },
    ]);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.id).toBe(2);
  });

  it("keeps contract-summary purchase when no indexed twin exists", () => {
    const filtered = filterLedgerPurchasesForSchedule([
      {
        id: 9,
        canonical_row_id: "latam",
        card_group: "A",
        purchase_date: "2025-01-20",
        total_amount_clp: 1_856_030,
        cuotas_totales: 3,
        merchant: "LATAM.COM XP INTER TRES CUOTAS PREC",
        description_merged: null,
        matched_baseline_purchase_id: null,
        source: "pdf",
        first_due_month: null,
        twin_index: 0,
      },
    ]);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.id).toBe(9);
  });
});

describe("installment ledger cupo (synthetic)", () => {
  // Isolated vitest CC master, seeded with a synthetic installment purchase — no real-DB coupling.
  let accountId: number;

  function seedPurchase(): void {
    const nowYm = chileCurrentYm();
    db.prepare(
      `INSERT INTO cc_installment_purchases (
         account_id, card_group, canonical_row_id, dedupe_key, parser_row_id_sample, source_pdf_sample,
         purchase_date, total_amount_clp, cuotas_totales, merchant, description_merged, matched_baseline_purchase_id, source
       ) VALUES (?, 'A', 'cupo-synth', NULL, NULL, NULL, ?, ?, ?, 'VITEST CUPO', 'VITEST CUPO', NULL, 'pdf')`
    ).run(accountId, `${nowYm}-05`, 1_200_000, 3);
  }

  function cleanup(): void {
    if (!accountId) return;
    db.prepare(
      `DELETE FROM cc_installment_payments WHERE purchase_id IN
         (SELECT id FROM cc_installment_purchases WHERE account_id = ? AND canonical_row_id = 'cupo-synth')`
    ).run(accountId);
    db.prepare(
      `DELETE FROM cc_installment_purchases WHERE account_id = ? AND canonical_row_id = 'cupo-synth'`
    ).run(accountId);
    db.prepare(`DELETE FROM valuations WHERE account_id = ?`).run(accountId);
  }

  afterEach(cleanup);

  it("open month cupo equals live outstanding; every other month uses the plan remainder", () => {
    ensureVitestCreditCardFixtures();
    const id = getVitestSantanderCcMasterAccountId();
    if (id == null) return;
    accountId = id;
    cleanup();
    seedPurchase();

    const live = liveCreditCardOutstandingClp(accountId);
    expect(live).not.toBeNull();
    expect(live!).toBeGreaterThan(0);

    // Open facturación → live outstanding; every other scheduled month → plan remainder.
    const frame = ccCupoFrame(accountId, []);
    expect(frame.provisionalMonths.size).toBe(0);
    const open = frame.openBillingMonth;
    expect(open).not.toBeNull();
    expect(frame.cupoEnCuotasClp(open!)).toBe(live);
    const remaining = installmentRemainingClpByCalendarMonth(accountId);
    expect(remaining.size).toBeGreaterThan(1);
    for (const [ym, planSaldo] of remaining) {
      expect(frame.cupoEnCuotasClp(ym)).toBe(ym === open ? live : planSaldo);
    }
  });

  it("runs the schedule timeline to the current month on the Chile clock, not UTC", () => {
    ensureVitestCreditCardFixtures();
    const id = getVitestSantanderCcMasterAccountId();
    if (id == null) return;
    accountId = id;
    cleanup();
    // 22:00 Chile on September 30 — already October 1 in UTC.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-01T01:00:00Z"));
    try {
      // A plan that finished billing in May: the timeline runs on to the current month only.
      db.prepare(
        `INSERT INTO cc_installment_purchases (
           account_id, card_group, canonical_row_id, purchase_date, total_amount_clp, cuotas_totales,
           merchant, description_merged, source
         ) VALUES (?, 'A', 'cupo-synth', '2026-03-05', 300000, 3, 'VITEST CUPO', 'VITEST CUPO', 'pdf')`
      ).run(accountId);
      const months = [...installmentRemainingClpByCalendarMonth(accountId).keys()];
      expect(months.at(-1)).toBe("2026-09");
    } finally {
      vi.useRealTimers();
    }
  });

  it("persists a today valuation equal to the live balance", () => {
    ensureVitestCreditCardFixtures();
    const id = getVitestSantanderCcMasterAccountId();
    if (id == null) return;
    accountId = id;
    cleanup();
    seedPurchase();

    const live = liveCreditCardOutstandingClp(accountId);
    // upsert persists the billing-detail balance when available, else the live outstanding.
    const expected = latestCreditCardBillingBalanceTotalClp(accountId) ?? live;
    expect(expected).not.toBeNull();

    const written = upsertCreditCardValuationsFromLedger(accountId);
    expect(written).toBeGreaterThan(0);

    const today = chileCalendarTodayYmd();
    const row = db
      .prepare(`SELECT value AS value_clp FROM valuations WHERE account_id = ? AND as_of_date = ?`)
      .get(accountId, today) as { value_clp: number } | undefined;
    expect(row?.value_clp).toBe(expected);
  });
});

afterAll(() => {
  wipeVitestCcFixtureData();
});
