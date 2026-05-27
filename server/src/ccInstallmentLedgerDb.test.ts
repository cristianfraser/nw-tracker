import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  cupoEnCuotasClpForCalendarMonth,
  filterLedgerPurchasesForSchedule,
  installmentRemainingClpByCalendarMonth,
  liveCreditCardOutstandingClp,
} from "./ccInstallmentLedgerDb.js";
import {
  ccLedgerStatementClosingPointsClp,
  latestCreditCardBillingBalanceTotalClp,
  upsertCreditCardValuationsFromLedger,
} from "./ccCreditCardValuations.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { monthKeyFromYmd } from "./calendarMonth.js";

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
      },
    ]);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.id).toBe(9);
  });
});

describe("card 4242 ledger valuations", () => {
  it("uses live cupo for current calendar month (matches historial)", () => {
    const master = db
      .prepare(`SELECT id FROM accounts WHERE notes = 'credit_card_master|santander|4242' LIMIT 1`)
      .get() as { id: number } | undefined;
    if (!master) return;

    const todayYm = monthKeyFromYmd(chileCalendarTodayYmd());
    if (!todayYm) return;

    const live = liveCreditCardOutstandingClp(master.id);
    const plan = installmentRemainingClpByCalendarMonth(master.id).get(todayYm);
    const cupo = cupoEnCuotasClpForCalendarMonth(master.id, todayYm);
    expect(live).not.toBeNull();
    expect(cupo).toBe(live);
    if (plan != null && live != null && live > plan) {
      expect(cupo).toBeGreaterThan(plan);
    }

    const valuationLive = latestCreditCardBillingBalanceTotalClp(master.id) ?? live;
    const pts = ccLedgerStatementClosingPointsClp(master.id);
    const curPt = pts?.find((p) => monthKeyFromYmd(p.as_of_date) === todayYm);
    expect(curPt?.value_clp).toBe(valuationLive);

    upsertCreditCardValuationsFromLedger(master.id);
    const today = chileCalendarTodayYmd();
    const row = db
      .prepare(
        `SELECT value_clp FROM valuations WHERE account_id = ? AND as_of_date = ?`
      )
      .get(master.id, today) as { value_clp: number } | undefined;
    expect(row?.value_clp).toBe(valuationLive);
  });
});
