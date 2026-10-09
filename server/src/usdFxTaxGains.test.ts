import { describe, expect, it } from "vitest";
import type { OfficialIpcLookup } from "./siiOfficialIpc.js";
import {
  USD_FX_IDPC_RATE,
  usdFxF22Codes,
  usdFxTaxGainsForYear,
  type UsdFxDisposalLoader,
  type UsdFxTaxGainsOptions,
} from "./usdFxTaxGains.js";

const ACCOUNT = 9101;

// Official IPC at 0,4% a month from December 2023 through June 2025 (the latest published month).
const ipcLookup: OfficialIpcLookup = (month) => {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const n = (y - 2023) * 12 + m - 12; // 0 at 2023-12
  if (n < 0 || month > "2025-06-01") return null;
  return { variationPct: 0.4, indexPoints: 100 * 1.004 ** n };
};
const ipc = { latestMonth: "2025-06-01", lookup: ipcLookup };
const pct = (from: string, to: string) => {
  const at = (month: string) => ipcLookup(month)!.indexPoints;
  return Math.round((at(to) / at(from) - 1) * 1000) / 10;
};

type Loaded = ReturnType<UsdFxDisposalLoader>;
const slice = (acquiredOn: string, acquireMovementId: number, units: number, cost: number) => ({ acquiredOn, acquireMovementId, units, cost });
const disposal = (
  x: Omit<Loaded["disposals"][number], "accountId" | "gain" | "cost" | "slices"> & { slices: ReturnType<typeof slice>[] }
): Loaded["disposals"][number] => {
  const cost = x.slices.reduce((s, l) => s + l.cost, 0);
  return { accountId: ACCOUNT, ...x, cost, gain: x.proceeds - cost };
};

// 2024: 1.000 dollars bought at 900 on 2024-02-10 and 500 at 950 on 2024-05-20; 1.200 spent on a stock
// on 2024-08-15 at 960 (realized under 2573); a 10-dollar broker fee on 2024-09-01 (bought at 950);
// a card payment of 100 on 2024-10-05 at 940, bought at 950 (a loss); a stock buy of 50 the loader
// deferred (another posture); a 2025 disposal that must stay out of 2024.
const DISPOSALS_2024: Loaded["disposals"] = [
  disposal({ date: "2024-08-15", movementId: 30, units: 1200, proceeds: 1200 * 960, tag: "realized", slices: [slice("2024-02-10", 10, 1000, 900_000), slice("2024-05-20", 11, 200, 190_000)] }),
  disposal({ date: "2024-09-01", movementId: 31, units: 10, proceeds: 0, tag: "fee", slices: [slice("2024-05-20", 11, 10, 9_500)] }),
  disposal({ date: "2024-10-05", movementId: 32, units: 100, proceeds: 100 * 940, tag: "realized", slices: [slice("2024-05-20", 11, 100, 95_000)] }),
  disposal({ date: "2024-11-20", movementId: 33, units: 50, proceeds: 50 * 970, tag: "deferred", slices: [slice("2024-05-20", 11, 50, 47_500)] }),
  disposal({ date: "2025-03-03", movementId: 40, units: 100, proceeds: 100 * 1000, tag: "realized", slices: [slice("2024-05-20", 11, 100, 95_000)] }),
];
const loaderOf =
  (disposals: Loaded["disposals"]): UsdFxDisposalLoader =>
  () => ({ disposals, openLots: [] });
const base: UsdFxTaxGainsOptions = { posture: "oficio_2573", purchaseCost: "observado", route: "idpc_1901", ipc };

describe("usdFxTaxGainsForYear", () => {
  it("lists the year's realized disposals with nominal cost, purchase dates and the December reajuste", () => {
    const r = usdFxTaxGainsForYear(2024, base, loaderOf(DISPOSALS_2024));
    expect(r.reajusteIsEstimate).toBe(false);
    expect(r.reajusteToMonth).toBe("2024-11-01");
    expect(r.disposals.map((d) => d.movementId)).toEqual([30, 32]);
    const stock = r.disposals[0]!;
    expect(stock).toMatchObject({ accountId: ACCOUNT, usd: 1200, proceedsClp: 1_152_000, costClp: 1_090_000, gainClp: 62_000 });
    expect(stock.purchaseDates).toEqual(["2024-02-10", "2024-05-20"]);
    // July → November 2024, one decimal.
    expect(stock.decemberPct).toBe(pct("2024-07-01", "2024-11-01"));
    expect(stock.gainDecemberClp).toBeCloseTo(62_000 * (1 + stock.decemberPct / 100), 6);
    const card = r.disposals[1]!;
    expect(card).toMatchObject({ usd: 100, proceedsClp: 94_000, costClp: 95_000, gainClp: -1_000 });
    expect(card.decemberPct).toBe(pct("2024-09-01", "2024-11-01"));
    expect(card.gainDecemberClp).toBeCloseTo(-1_000 * (1 + card.decemberPct / 100), 6);
    expect(r.resultClp).toBe(61_000);
    expect(r.resultDecemberClp).toBeCloseTo(stock.gainDecemberClp + card.gainDecemberClp, 6);
  });

  it("keeps a fee out of the result and lists its lost cost; a deferred disposal is information only", () => {
    const r = usdFxTaxGainsForYear(2024, base, loaderOf(DISPOSALS_2024));
    expect(r.fees).toEqual([{ accountId: ACCOUNT, date: "2024-09-01", movementId: 31, usd: 10, costLostClp: 9_500 }]);
    expect(r.feesLostClp).toBe(9_500);
    expect(r.deferred).toEqual([{ accountId: ACCOUNT, date: "2024-11-20", movementId: 33, usd: 50, gainClp: 50 * 970 - 47_500 }]);
    expect(r.deferredClp).toBe(1_000);
    expect(r.disposals.some((d) => d.movementId === 31 || d.movementId === 33)).toBe(false);
    expect(r.resultClp).toBe(61_000);
  });

  it("under idpc_1901 a gain is code 1901 with its IDPC; under igc_1032 it is code 1032", () => {
    const gain = usdFxTaxGainsForYear(2024, base, loaderOf(DISPOSALS_2024));
    const result = Math.round(gain.resultDecemberClp);
    expect(gain.codes).toEqual({ 1901: result, idpcClp: Math.round(result * USD_FX_IDPC_RATE) });
    const igc = usdFxTaxGainsForYear(2024, { ...base, route: "igc_1032" }, loaderOf(DISPOSALS_2024));
    expect(igc.codes).toEqual({ 1032: result });
    expect(igc.resultDecemberClp).toBe(gain.resultDecemberClp);
  });

  it("a loss year: reajusted the same way, lost under idpc_1901, a 169 candidate under igc_1032", () => {
    const loss: Loaded["disposals"] = [
      disposal({ date: "2024-03-12", movementId: 50, units: 300, proceeds: 300 * 900, tag: "realized", slices: [slice("2024-01-08", 49, 300, 300 * 950)] }),
    ];
    const r = usdFxTaxGainsForYear(2024, base, loaderOf(loss));
    expect(r.resultClp).toBe(-15_000);
    const p = pct("2024-02-01", "2024-11-01");
    expect(p).toBeGreaterThan(0);
    expect(r.resultDecemberClp).toBeCloseTo(-15_000 * (1 + p / 100), 6);
    expect(r.codes).toEqual({});
    const igc = usdFxTaxGainsForYear(2024, { ...base, route: "igc_1032" }, loaderOf(loss));
    expect(igc.codes).toEqual({ loss169: -Math.round(r.resultDecemberClp) });
  });

  it("an open year reajusts only to the latest published month and is flagged an estimate", () => {
    const r = usdFxTaxGainsForYear(2025, base, loaderOf(DISPOSALS_2024));
    expect(r.reajusteIsEstimate).toBe(true);
    expect(r.reajusteToMonth).toBe("2025-06-01");
    expect(r.disposals.map((d) => d.movementId)).toEqual([40]);
    expect(r.disposals[0]!.decemberPct).toBe(pct("2025-02-01", "2025-06-01"));
    expect(r.fees).toEqual([]);
    expect(r.deferred).toEqual([]);
  });

  it("a disposal after the reajuste month carries no reajuste; a deflation never lowers the result", () => {
    const late: Loaded["disposals"] = [
      disposal({ date: "2025-08-02", movementId: 60, units: 100, proceeds: 100 * 1000, tag: "realized", slices: [slice("2025-01-15", 59, 100, 95_000)] }),
    ];
    const r = usdFxTaxGainsForYear(2025, base, loaderOf(late));
    expect(r.disposals[0]!.decemberPct).toBe(0);
    expect(r.resultDecemberClp).toBe(5_000);
    const deflating = { latestMonth: "2025-11-01", lookup: ((m) => ({ variationPct: -0.5, indexPoints: m <= "2025-01-01" ? 100 : 99 })) as OfficialIpcLookup };
    const r2 = usdFxTaxGainsForYear(2025, { ...base, ipc: deflating }, loaderOf(late));
    expect(r2.disposals[0]!.decemberPct).toBe(0);
  });

  it("passes posture and cost option through to the loader and refuses an unknown tag", () => {
    const seen: unknown[] = [];
    const loader: UsdFxDisposalLoader = (o) => {
      seen.push(o);
      return { disposals: [], openLots: [] };
    };
    usdFxTaxGainsForYear(2024, { ...base, posture: "oficio_2390", purchaseCost: "pesos_paid" }, loader);
    expect(seen).toEqual([{ posture: "oficio_2390", purchaseCost: "pesos_paid" }]);
    const odd = [{ ...DISPOSALS_2024[0]!, tag: "other" as never }];
    expect(() => usdFxTaxGainsForYear(2024, base, loaderOf(odd))).toThrow(/tag other/);
    const feeWithProceeds = [{ ...DISPOSALS_2024[1]!, proceeds: 5 }];
    expect(() => usdFxTaxGainsForYear(2024, base, loaderOf(feeWithProceeds))).toThrow(/fee disposal 31/);
  });

  it("rounds the codes to the peso", () => {
    expect(usdFxF22Codes("idpc_1901", 1000.4)).toEqual({ 1901: 1000, idpcClp: 250 });
    expect(usdFxF22Codes("idpc_1901", -3)).toEqual({});
    expect(usdFxF22Codes("igc_1032", 0.2)).toEqual({});
    expect(usdFxF22Codes("igc_1032", -1000.6)).toEqual({ loss169: 1001 });
  });

  it("applies the same IDPC rate as the F22 draft", async () => {
    const { IDPC_RATE } = await import("./f22Draft.js");
    expect(USD_FX_IDPC_RATE).toBe(IDPC_RATE);
  });
});
