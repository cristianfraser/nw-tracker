import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  ccLedgerStatementClosingPointsClp,
  filterLedgerPurchasesForSchedule,
  installmentRemainingClpByCalendarMonth,
} from "./ccInstallmentLedgerDb.js";

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
  it("has no multi-million May 2026 spike from stale double-count", () => {
    const master = db
      .prepare(`SELECT id FROM accounts WHERE notes = 'credit_card_master|santander|4242' LIMIT 1`)
      .get() as { id: number } | undefined;
    if (!master) return;

    const pts = ccLedgerStatementClosingPointsClp(master.id);
    expect(pts?.length).toBeGreaterThan(0);
    const may26 = pts?.filter((p) => p.as_of_date.startsWith("2026-05"));
    for (const p of may26 ?? []) {
      expect(p.value_clp).toBeLessThan(500_000);
      expect(p.value_clp).not.toBe(6_037_018);
    }

    const mayYm = "2026-05";
    const planMay = installmentRemainingClpByCalendarMonth(master.id).get(mayYm);
    if (planMay != null) expect(planMay).toBeLessThan(500_000);
  });
});
