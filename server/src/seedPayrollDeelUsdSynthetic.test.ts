import { describe, expect, it, beforeAll } from "vitest";
import { db } from "./db.js";
import {
  DEEL_GROSS_USD_FULL_MONTH,
  DEEL_WIRE_FEE_USD,
  buildDeel2021H1Rows,
  buildSyntheticDeelUsdRow,
  deelNetUsdForGrossScale,
} from "./seedPayrollDeelUsdSynthetic.js";

const FX_FIXTURE: [string, number][] = [
  ["2021-01-20", 721.6],
  ["2021-02-08", 735],
  ["2021-03-08", 736],
  ["2021-04-08", 738],
  ["2021-05-08", 740],
  ["2021-06-08", 742],
  ["2021-07-08", 744],
  ["2021-08-08", 746],
];

beforeAll(() => {
  const ins = db.prepare(
    `INSERT OR REPLACE INTO fx_daily (date, clp_per_usd) VALUES (?, ?)`
  );
  for (const [date, clp_per_usd] of FX_FIXTURE) {
    ins.run(date, clp_per_usd);
  }
});

describe("seedPayrollDeelUsdSynthetic", () => {
  it("full month net is gross minus wire fee", () => {
    expect(deelNetUsdForGrossScale(1)).toBe(DEEL_GROSS_USD_FULL_MONTH - DEEL_WIRE_FEE_USD);
  });

  it("partial January scales gross before wire fee", () => {
    const row = buildSyntheticDeelUsdRow({
      period_month: "2021-01",
      gross_scale: 18 / 31,
      wire_received_on: "2021-01-20",
    });
    expect(row.liquido_currency).toBe("usd");
    expect(row.liquido).toBeCloseTo(4500 * (18 / 31) - 50, 2);
    // CLP equivalent derives at read time as haberes − descuentos; the builder must
    // keep that difference positive.
    expect(row.total_haberes_clp - row.total_descuentos_clp).toBeGreaterThan(0);
  });

  it("builds eight rows for Jan–Aug 2021", () => {
    const rows = buildDeel2021H1Rows();
    expect(rows).toHaveLength(8);
    expect(rows.map((r) => r.period_month)).toEqual([
      "2021-01",
      "2021-02",
      "2021-03",
      "2021-04",
      "2021-05",
      "2021-06",
      "2021-07",
      "2021-08",
    ]);
    const feb = rows.find((r) => r.period_month === "2021-02")!;
    expect(feb.liquido).toBe(4450);
    expect(feb.liquido_currency).toBe("usd");
    const aug = rows.find((r) => r.period_month === "2021-08")!;
    expect(aug.liquido).toBe(4500 * 0.5 - 50);
  });
});
