import { describe, expect, it } from "vitest";
import {
  activePurchaseFirstDueYm,
  compareActivePurchases,
  sortActivePurchases,
  type CcActivePurchaseOrderKey,
} from "./ccActivePurchaseOrder.js";

function plan(label: string, remaining_installments: number, first_due_month: string): CcActivePurchaseOrderKey {
  return { label, remaining_installments, first_due_month };
}

describe("activePurchaseFirstDueYm", () => {
  it("is the plan's first-due month when parseable, else null", () => {
    expect(activePurchaseFirstDueYm(plan("A", 3, "2026-10"))).toBe("2026-10");
    expect(activePurchaseFirstDueYm(plan("A", 3, ""))).toBeNull();
    expect(activePurchaseFirstDueYm(plan("A", 3, "2026-13"))).toBeNull();
  });
});

describe("compareActivePurchases", () => {
  it("orders by the cuotas left, fewest first", () => {
    const long = plan("LONG", 20, "2025-06");
    const short = plan("SHORT", 3, "2026-11");
    const mid = plan("MID", 5, "2026-01");
    expect(sortActivePurchases([long, short, mid]).map((p) => p.label)).toEqual(["SHORT", "MID", "LONG"]);
  });

  it("breaks a tie on the remaining count by the first-cuota month, not by name", () => {
    // Three plans with three cuotas left: the one whose first cuota bills in November reads
    // after the two that started in October, whatever its name.
    const express = plan("EXPRESS PLAZA L", 3, "2026-11");
    const maipu = plan("MUNICIPALIDAD DE MAIPU", 3, "2026-10");
    const lyon = plan("RECAUDACION EX PLAZA LYON", 3, "2026-10");
    expect(sortActivePurchases([express, maipu, lyon]).map((p) => p.label)).toEqual([
      "MUNICIPALIDAD DE MAIPU",
      "RECAUDACION EX PLAZA LYON",
      "EXPRESS PLAZA L",
    ]);
  });

  it("the remaining count still wins over an earlier first-cuota month", () => {
    const older = plan("OLDER", 4, "2026-01");
    const newer = plan("NEWER", 3, "2026-11");
    expect(compareActivePurchases(newer, older)).toBeLessThan(0);
  });

  it("rows without a first-due month sort last among the same count, by label", () => {
    const b = plan("B SIN MES", 3, "");
    const a = plan("A SIN MES", 3, "");
    const dated = plan("ZZZ", 3, "2027-06");
    const fewer = plan("FEWER", 2, "");
    expect(sortActivePurchases([b, dated, a, fewer]).map((p) => p.label)).toEqual([
      "FEWER",
      "ZZZ",
      "A SIN MES",
      "B SIN MES",
    ]);
  });

  it("falls back to a stable Spanish label order", () => {
    const n = plan("ÑANDÚ", 3, "2026-10");
    const o = plan("OSO", 3, "2026-10");
    const m = plan("mono", 3, "2026-10");
    expect(sortActivePurchases([o, n, m]).map((p) => p.label)).toEqual(["mono", "ÑANDÚ", "OSO"]);
    expect(compareActivePurchases(o, o)).toBe(0);
  });

  it("does not mutate its input", () => {
    const input = [plan("B", 3, "2026-11"), plan("A", 3, "2026-10")];
    const out = sortActivePurchases(input);
    expect(input.map((p) => p.label)).toEqual(["B", "A"]);
    expect(out.map((p) => p.label)).toEqual(["A", "B"]);
  });
});
