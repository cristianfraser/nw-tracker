import { describe, expect, it } from "vitest";
import {
  ART107_INR_FROM,
  ART107_TAX_FROM,
  art107DisposalClp,
  art107LossCarry,
  art107RegimeForSale,
  pickArt107DefaultOption,
} from "./art107TaxGains.js";
import type { TaxLotDisposal } from "./taxLots.js";

/** An IPC that answers only the (from, to) pairs a case expects, so a wrong month fails the test. */
function ipcOf(table: Record<string, number>) {
  return (from: string, to: string) => {
    const v = table[`${from}|${to}`];
    if (v == null) throw new Error(`unexpected IPC ${from} → ${to}`);
    return v;
  };
}

const disposal = (date: string, proceeds: number, slices: TaxLotDisposal["slices"]): TaxLotDisposal => {
  const cost = slices.reduce((s, x) => s + x.cost, 0);
  return { date, movementId: 9, units: slices.reduce((s, x) => s + x.units, 0), proceeds, cost, gain: proceeds - cost, slices };
};

describe("art107RegimeForSale", () => {
  it("taxes sales from Ley 21.420's publication until the reform, ingreso no renta either side", () => {
    expect(ART107_TAX_FROM).toBe("2022-09-02");
    expect(ART107_INR_FROM).toBe("2027-01-01");
    expect(art107RegimeForSale("2022-09-01")).toBe("inr");
    expect(art107RegimeForSale("2022-09-02")).toBe("tax_10pct");
    expect(art107RegimeForSale("2026-12-31")).toBe("tax_10pct");
    expect(art107RegimeForSale("2027-01-01")).toBe("inr");
  });
});

describe("art107DisposalClp", () => {
  // 1.000 cuotas bought 2025-05-20 for $1.000.000, sold 2026-06-10 for $1.300.000.
  const sale = disposal("2026-06-10", 1_300_000, [
    { acquiredOn: "2025-05-20", acquireMovementId: 1, units: 1000, cost: 1_000_000 },
  ]);

  it("computes both resident options: cost paid reajustado, and the purchase year's 31-Dec close reajustado from November", () => {
    const ipc = ipcOf({ "2025-04-01|2026-05-01": 4, "2025-11-01|2026-05-01": 1.5 });
    const r = art107DisposalClp(sale, ipc, (t, y) => (t === "FUND.SN" && y === 2025 ? 1100 : null), "FUND.SN", false);
    expect(r.costPaidReajustadoClp).toBeCloseTo(1_040_000, 6);
    expect(r.cost_paid).toBeCloseTo(260_000, 6);
    expect(r.costCloseDec31Clp).toBeCloseTo(1000 * 1100 * 1.015, 6);
    expect(r.close_dec31).toBeCloseTo(1_300_000 - 1_116_500, 6);
  });

  it("has no Dec-31 option without a stored close", () => {
    const r = art107DisposalClp(sale, ipcOf({ "2025-04-01|2026-05-01": 4 }), () => null, "FUND.SN", true);
    expect(r.costCloseDec31Clp).toBeNull();
    expect(r.close_dec31).toBeNull();
    expect(r.cost_paid).toBeCloseTo(260_000, 6);
  });

  // 400 cuotas bought 2025-03-03 for $480.000 and sold 2025-08-01 for $500.000.
  const sameYear = disposal("2025-08-01", 500_000, [
    { acquiredOn: "2025-03-03", acquireMovementId: 1, units: 400, cost: 480_000 },
  ]);

  it("values a lot bought and sold in the same closed year at that year's close, unreajustado, and reajusta its loss to November", () => {
    const ipc = ipcOf({ "2025-02-01|2025-07-01": 2, "2025-07-01|2025-11-01": 1 });
    const r = art107DisposalClp(sameYear, ipc, () => 1300, "FUND.SN", true);
    expect(r.cost_paid).toBeCloseTo(500_000 - 489_600, 6);
    expect(r.costCloseDec31Clp).toBe(520_000);
    // −20.000 deducted in the sale's year: reajustado from the month before the sale to November.
    expect(r.close_dec31).toBeCloseTo(-20_200, 6);
  });

  it("has no Dec-31 option for a lot bought in a year that has not closed", () => {
    const r = art107DisposalClp(sameYear, ipcOf({ "2025-02-01|2025-07-01": 2 }), () => 1300, "FUND.SN", false);
    expect(r.costCloseDec31Clp).toBeNull();
    expect(r.close_dec31).toBeNull();
  });

  it("leaves a loss unreajustado when its mayor valor is ingreso no renta (no code, nothing carried)", () => {
    const inr = disposal("2027-02-10", 900_000, [
      { acquiredOn: "2026-02-03", acquireMovementId: 1, units: 1000, cost: 1_000_000 },
    ]);
    const r = art107DisposalClp(inr, ipcOf({ "2026-01-01|2027-01-01": 3 }), () => null, "FUND.SN", true);
    expect(r.cost_paid).toBeCloseTo(900_000 - 1_030_000, 6);
  });
});

describe("pickArt107DefaultOption", () => {
  it("takes the lower total result; an option some sale lacks never wins", () => {
    expect(pickArt107DefaultOption({ cost_paid: 100_000, close_dec31: 80_000 })).toBe("close_dec31");
    expect(pickArt107DefaultOption({ cost_paid: 100_000, close_dec31: 120_000 })).toBe("cost_paid");
    expect(pickArt107DefaultOption({ cost_paid: -10_000, close_dec31: -50_000 })).toBe("close_dec31");
    expect(pickArt107DefaultOption({ cost_paid: 100_000, close_dec31: null })).toBe("cost_paid");
    expect(pickArt107DefaultOption({ cost_paid: 0, close_dec31: 0 })).toBe("cost_paid");
  });
});

describe("art107LossCarry", () => {
  const ipc = ipcOf({ "2025-11-01|2026-11-01": 3.2 });
  const noApp = () => {
    throw new Error("the app's own result must not be read when a form was filed");
  };

  it("carries the filed form's negative 1816, reajustado November to November", () => {
    expect(art107LossCarry(2027, 2026, { 1816: -100_000 }, ipc, noApp)).toEqual({ clp: -103_200, source: "filed" });
  });

  it("carries nothing when the filed form has no negative 1816", () => {
    expect(art107LossCarry(2027, 2026, { 304: 5_000 }, ipc, noApp)).toEqual({ clp: 0, source: null });
    expect(art107LossCarry(2027, 2026, { 1816: 40_000 }, ipc, noApp)).toEqual({ clp: 0, source: null });
  });

  it("takes the app's own previous result when no form was filed", () => {
    expect(art107LossCarry(2027, 2026, null, ipc, () => -50_000)).toEqual({ clp: -51_600, source: "app" });
    expect(art107LossCarry(2027, 2026, null, ipc, () => 20_000)).toEqual({ clp: 0, source: null });
  });

  it("carries nothing into a year that is all ingreso no renta", () => {
    expect(art107LossCarry(2028, 2027, { 1816: -100_000 }, ipc, noApp)).toEqual({ clp: 0, source: null });
  });

  it("throws on an income year that is not the año tributario's", () => {
    expect(() => art107LossCarry(2027, 2025, null, ipc, () => 0)).toThrow(/declares income year 2026/);
  });
});
