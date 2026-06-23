import { describe, expect, it } from "vitest";
import {
  buildSyntheticDealsyRow,
  DEALSYTE_2019_H2_CONSTANTS,
  DEALSYTE_2020_FULL_LIQUIDO_REFERENCE_CLP,
  resolveDescAfpFromCert,
} from "./seedPayrollDealsySynthetic.js";

describe("seedPayrollDealsySynthetic", () => {
  it("recomputes Jun 2019 tax matching May parsed líquido", () => {
    const row = buildSyntheticDealsyRow({
      period_month: "2019-06",
      movement_id: 8334,
      liquido_clp: 2_123_338,
      desc_afp_clp: 217_751,
      uf_mes: 27_892.17,
      utm_mes: 48_595,
      afp_health_pool_mode: "fixed_2019",
    });
    expect(row.desc_tax_clp).toBe(57_948);
    expect(row.desc_health_clp).toBe(170_016);
    expect(row.total_descuentos_clp).toBe(458_808);
  });

  it("sums deduction parts to total_descuentos", () => {
    const row = buildSyntheticDealsyRow({
      period_month: "2019-12",
      movement_id: 8389,
      liquido_clp: 2_125_127,
      desc_afp_clp: 218_215,
      uf_mes: 28_309.94,
      utm_mes: 49_623,
      afp_health_pool_mode: "fixed_2019",
    });
    const parts =
      row.desc_cesantia_clp +
      row.desc_afp_clp +
      row.desc_health_clp +
      row.desc_tax_clp;
    expect(parts).toBe(row.total_descuentos_clp);
    expect(DEALSYTE_2019_H2_CONSTANTS.total_haberes_clp - row.total_descuentos_clp).toBe(
      row.liquido_clp
    );
  });

  it("uses 10% imponible AFP fallback when cert is below threshold", () => {
    expect(resolveDescAfpFromCert(3_713)).toBe(218_215);
    expect(resolveDescAfpFromCert(217_751)).toBe(217_751);
  });

  it("builds proportional partial March 2020 row", () => {
    const scale = 167_139 / DEALSYTE_2020_FULL_LIQUIDO_REFERENCE_CLP;
    const row = buildSyntheticDealsyRow({
      period_month: "2020-03",
      movement_id: 8977,
      liquido_clp: 167_139,
      desc_afp_clp: 17_088,
      uf_mes: 28_648.94,
      utm_mes: 49_623,
      afp_health_pool_mode: "baseline_adjusted",
      partial_scale: scale,
      afp_health_pool_reference_afp: 221_060,
    });
    expect(row.total_haberes_clp).toBe(Math.round(2_582_146 * scale));
    expect(row.total_haberes_clp - row.liquido_clp).toBe(row.total_descuentos_clp);
    expect(row.desc_afp_clp).toBe(17_088);
    expect(row.base_salary_clp).toBe(Math.round(2_063_000 * scale));
    const parts =
      row.desc_cesantia_clp +
      row.desc_afp_clp +
      row.desc_health_clp +
      row.desc_tax_clp;
    expect(parts).toBe(row.total_descuentos_clp);
  });

  it("trusts low AFP cert for partial months when requested", () => {
    expect(resolveDescAfpFromCert(17_088, undefined, { trustLowCert: true })).toBe(
      17_088
    );
  });
});
