import { describe, expect, it } from "vitest";
import { foreignShareDisposalClp, monthBeforeYmd, pickForeignShareDefaultMode } from "./foreignShareTaxGains.js";
import { rentasEsporadicasByMonth } from "./rentasEsporadicas.js";

describe("foreignShareDisposalClp", () => {
  // 10 shares bought for USD 1.000 on 2026-01-15 (observado 900), sold for USD 1.100 on 2026-06-10
  // (observado 950); 31-Dec observado 1.000; official IPC +2% from Dec to May.
  const disposal = {
    date: "2026-06-10",
    movementId: 2,
    units: 10,
    proceeds: 1100,
    cost: 1000,
    gain: 100,
    slices: [{ acquiredOn: "2026-01-15", acquireMovementId: 1, units: 10, cost: 1000 }],
  };
  const observado: Record<string, number> = { "2026-01-15": 900, "2026-06-10": 950, "2026-12-31": 1000 };
  const ipc = (from: string, to: string) => {
    expect([from, to]).toEqual(["2025-12-01", "2026-05-01"]);
    return 2;
  };

  it("computes both SII frames", () => {
    const r = foreignShareDisposalClp(disposal, (d) => observado[d]!, ipc, observado["2026-12-31"]!);
    expect(r.usd_31dic).toBeCloseTo(100_000, 6); // USD 100 × 1.000
    expect(r.clp_ipc).toBeCloseTo(1_045_000 - 918_000, 6); // 1.100 × 950 − 1.000 × 900 × 1,02
  });

  it("defaults to the lower result", () => {
    expect(pickForeignShareDefaultMode({ usd_31dic: 100_000, clp_ipc: 127_000 })).toBe("usd_31dic");
    expect(pickForeignShareDefaultMode({ usd_31dic: -300_000, clp_ipc: -350_000 })).toBe("clp_ipc");
  });

  it("finds the month before, across a year", () => {
    expect(monthBeforeYmd("2026-01-15")).toBe("2025-12-01");
  });
});

describe("rentasEsporadicasByMonth", () => {
  const items = [
    { date: "2026-06-16", source: "foreign_share_sale" as const, resultClp: 50_000, movementId: 1 },
    { date: "2026-06-20", source: "fx_2573" as const, resultClp: -10_000, movementId: 2 },
    { date: "2026-07-01", source: "foreign_share_sale" as const, resultClp: -5_000, movementId: 3 },
  ];

  it("is empty unless the regime applies", () => {
    expect(rentasEsporadicasByMonth(items, { applies: false, rate: 0.25 })).toEqual([]);
  });

  it("nets a month, floors the base at zero and dates the deadline", () => {
    const months = rentasEsporadicasByMonth(items, { applies: true, rate: 0.25 });
    expect(months.map((m) => [m.month, m.baseClp, m.taxClp, m.dueBy])).toEqual([
      ["2026-06-01", 40_000, 10_000, "2026-07-31"],
      ["2026-07-01", 0, 0, "2026-08-31"],
    ]);
  });
});
