import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { employmentPayslipsKind, type UsPayslip } from "nw-tracker-contracts";
import { db } from "../db.js";
import { checkingAccountId } from "../checkingCartolaImport.js";
import { buildF22Draft, computeF22Tax } from "./draft.js";
import { f22Code305, f22IdentityViolations } from "./identities.js";
import { deleteCheckingIncomeMovementOverride, upsertCheckingIncomeMovementOverride } from "../flowsCheckingIncomeOverrides.js";
import { createRealEstatePlace } from "../flowsRealEstateExpenses.js";
import { IMPUESTO_ADICIONAL_RATE } from "../legalParameters.js";
import { applyEmploymentPayslips } from "../payslipsApply.js";
import type { UsdFxDisposalLoader } from "./usdFx.js";

// Synthetic far years no other suite reaches (the IPC reajuste is zero past the latest month, and a
// 1040 is drafted under the latest listed US law while the year is open).
const SPLIT_YEAR = 2093; // the departure year
const NR_YEAR = 2094; // a whole non-resident year
const DEPARTURE = `${SPLIT_YEAR}-04-15`;
const UTA = 800_000;
const OBSERVADO = 900;
const PREFIX = "vitest-f22-residency/";
const noUsd: UsdFxDisposalLoader = () => ({ disposals: [], openLots: [] });

function stub(payDate: string): UsPayslip {
  const gross = 20_000;
  const lines = [
    { side: "haber" as const, label: "Regular Pay", amount: gross },
    { side: "descuento" as const, label: "Federal Income Tax", amount: 3_000 },
    { side: "descuento" as const, label: "Social Security", amount: 1_240 },
    { side: "descuento" as const, label: "Medicare", amount: 290 },
  ];
  const deductions = 3_000 + 1_240 + 290;
  return {
    jurisdiction: "us",
    pay_period: "biweekly",
    document: `${PREFIX}${payDate}.pdf`,
    period_month: payDate.slice(0, 7),
    pay_date: payDate,
    period_start: payDate,
    period_end: payDate,
    employer: { name: "VITEST RESIDENCY INC", ein: "89-0000003" },
    kind: "salary",
    w4: { filing_status: "single" },
    gross_pay: gross,
    total_deductions: deductions,
    net_pay: gross - deductions,
    lines: lines.map((l, i) => ({ position: i, ...l })),
  };
}

function insertCredit(occurredOn: string, amountClp: number, idx: number): number {
  const note = `import:cartola|${occurredOn.slice(0, 7)}|—|ARRIENDO RES ${idx}|on:${occurredOn}|amt:${amountClp}|idx:${idx}`;
  return Number(
    db
      .prepare(`INSERT INTO movements (account_id, amount, currency, occurred_on, note, units_delta) VALUES (?, ?, 'clp', ?, ?, NULL)`)
      .run(checkingAccountId(), amountClp, occurredOn, note).lastInsertRowid
  );
}

describe("the Impuesto Adicional chain (línea 72)", () => {
  it("takes the positive 158 as 32 and 35 % of it less 76 as 34, with no IGC lines", () => {
    const out = computeF22Tax({ 1849: 6_000_000, 955: 6_000_000 }, UTA, 2030, {}, "nonresident");
    expect(out[158]).toBe(6_000_000);
    expect(out[32]).toBe(6_000_000);
    expect(out[34]).toBe(Math.round(IMPUESTO_ADICIONAL_RATE * 6_000_000));
    expect(out[157]).toBeUndefined();
    expect(out[170]).toBeUndefined();
    expect(out[304]).toBeUndefined();
    // Code 76's credits come off; they never make the tax negative.
    expect(computeF22Tax({ 955: 1_000_000, 76: 500_000 }, UTA, 2030, {}, "nonresident")[34]).toBe(0);
    // The rebajas of líneas 20–23 do not reach code 32 (Instrucciones 72.2 a): 32 is the sub total).
    expect(computeF22Tax({ 955: 6_000_000, 750: 1_000_000, 765: 500_000 }, UTA, 2030, {}, "nonresident")[32]).toBe(6_000_000);
  });

  it("holds the identities on a non-resident form and on a departure year's form", () => {
    const nr = new Map<number, number>([[1849, 6_000_000], [955, 6_000_000], [158, 6_000_000], [32, 6_000_000], [34, 2_100_000], [304, 0], [305, 2_100_000]]);
    expect(f22IdentityViolations(nr, "nr")).toEqual([]);
    expect(f22IdentityViolations(new Map([...nr, [34, 2_000_000]]), "nr")).toEqual([
      "305 = 304 + 34 + 952 + 1830 − 198 − 833 + 900 (2100000 vs 2000000)",
      "34 = max(0, 35% × 32 − 76) (2000000 vs 2100000)",
    ]);
    // The departure year: 157 beside 32, so 32 ≠ 158 is allowed and 170 is checked.
    const split = new Map<number, number>([[1098, 10_000_000], [158, 10_000_000], [170, 10_000_000], [157, 0], [304, 0], [32, 3_000_000], [34, 1_050_000], [305, 1_050_000]]);
    expect(f22IdentityViolations(split, "split")).toEqual([]);
  });
});

describe("the F22 under a declared residency", () => {
  const movements: number[] = [];
  const cleanup = () => {
    for (const id of movements) {
      deleteCheckingIncomeMovementOverride(id);
      db.prepare(`DELETE FROM movements WHERE id = ?`).run(id);
    }
    movements.length = 0;
    db.prepare(`DELETE FROM expense_accounts WHERE slug LIKE 'vitest_res_%'`).run();
    db.prepare(`DELETE FROM payroll_work_earnings WHERE source_pdf LIKE '${PREFIX}%'`).run();
    db.prepare(`DELETE FROM fx_daily_bcentral WHERE date LIKE ? OR date LIKE ? OR date LIKE ?`).run(`${SPLIT_YEAR - 1}-%`, `${SPLIT_YEAR}-%`, `${NR_YEAR}-%`);
    db.prepare(`DELETE FROM tax_residency_periods`).run();
  };

  beforeAll(() => {
    cleanup();
    for (const d of [`${SPLIT_YEAR - 1}-12-15`, `${SPLIT_YEAR}-09-04`, `${SPLIT_YEAR}-12-15`, `${NR_YEAR}-06-05`, `${NR_YEAR}-12-15`]) {
      db.prepare(`INSERT INTO fx_daily_bcentral (date, clp_per_usd) VALUES (?, ?)`).run(d, OBSERVADO);
    }
    createRealEstatePlace({ slug: "vitest_res_tower", label: "Tower" });
    createRealEstatePlace({ slug: "vitest_res_dfl2", label: "Centro", dfl2: { dfl2: true, builtM2: 55, receptionYear: 2019 } });
    const rents: [string, number, string][] = [
      [`${SPLIT_YEAR}-03-05`, 1_000_000, "vitest_res_tower"], // resident part
      [`${SPLIT_YEAR}-09-05`, 1_200_000, "vitest_res_tower"], // non-resident part
      [`${SPLIT_YEAR}-09-06`, 400_000, "vitest_res_dfl2"], // DFL-2, non-resident part: exempt
      [`${NR_YEAR}-03-05`, 1_500_000, "vitest_res_tower"],
      [`${NR_YEAR}-03-06`, 400_000, "vitest_res_dfl2"],
    ];
    rents.forEach(([day, amount, place], i) => {
      const id = insertCredit(day, amount, 994_200 + i);
      movements.push(id);
      upsertCheckingIncomeMovementOverride(id, { income_kind: "rent", rent_place_slug: place });
    });
    // A US stub after the departure in the split year, and one in the non-resident year.
    applyEmploymentPayslips(
      employmentPayslipsKind.payload.parse({ parser_version: "vitest", payslips: [stub(`${SPLIT_YEAR}-09-04`), stub(`${NR_YEAR}-06-05`)] })
    );
    db.prepare(`INSERT INTO tax_residency_periods (jurisdiction, from_date, to_date, note) VALUES ('us', ?, NULL, 'vitest')`).run(DEPARTURE);
  });

  afterAll(cleanup);

  it("drafts a non-resident year under the Impuesto Adicional: the rent in 32 / 34, the DFL-2 rent exempt, the US salary excluded", () => {
    const d = buildF22Draft(NR_YEAR + 1, `${NR_YEAR}-12-15`, { usdFx: { load: noUsd } });
    expect(d.regime).toBe("nonresident");
    expect(d.residency.year).toMatchObject({ cl: "none", us: "full", declared: true });
    expect(d.residency.assumption).toMatch(/Declared, not inferred/);
    expect(d.taxComputed).toBe(true);
    expect(d.draft[1849]).toBe(1_500_000);
    expect(d.draft[955]).toBe(1_500_000);
    expect(d.draft[158]).toBe(1_500_000);
    expect(d.draft[32]).toBe(1_500_000);
    expect(d.draft[34]).toBe(Math.round(IMPUESTO_ADICIONAL_RATE * 1_500_000));
    // No IGC, no foreign salary, no residents' deductions or credits.
    for (const c of [157, 170, 136, 1030, 748, 1018, 1637, 750, 751, 765]) expect(d.draft[c]).toBeUndefined();
    expect(d.draft[304]).toBe(0);
    expect(d.draft[305]).toBe(d.draft[34]);
    expect(d.draft[305]).toBe(f22Code305(d.draft));
    expect(d.rentals.exemptRentClp).toBe(400_000);
    expect(d.nonresident?.window).toEqual({ fromYmd: `${NR_YEAR}-01-01`, throughYmd: `${NR_YEAR}-12-31` });
    const salary = d.excluded.find((x) => x.kind === "us_salary");
    expect(salary).toMatchObject({ reason: "nonresident", count: 1, clp: 20_000 * OBSERVADO });
    expect(d.excluded.find((x) => x.kind === "property_tax_credit")).toBeUndefined();
    expect(f22IdentityViolations(new Map(Object.entries(d.draft).map(([k, v]) => [Number(k), v])), "draft")).toEqual([]);
  });

  it("splits the departure year: the resident part as today through the declared day, the Adicional on the rent after it, art. 103 noted", () => {
    const d = buildF22Draft(SPLIT_YEAR + 1, `${SPLIT_YEAR}-12-15`, { usdFx: { load: noUsd } });
    expect(d.regime).toBe("split");
    expect(d.residency.year).toMatchObject({ cl: { through: `${SPLIT_YEAR}-04-14` }, us: { from: DEPARTURE } });
    expect(d.residency.residentWindow).toEqual({ fromYmd: `${SPLIT_YEAR}-01-01`, throughYmd: `${SPLIT_YEAR}-04-14` });
    // The resident part: only March's rent, through the IGC chain (2 M is below the first bracket).
    expect(d.draft[1849]).toBe(1_000_000);
    expect(d.draft[955]).toBe(1_000_000);
    expect(d.draft[158]).toBe(1_000_000);
    expect(d.draft[157]).toBe(0);
    expect(d.draft[304]).toBe(0);
    expect(d.rentals.taxableRentClp).toBe(1_000_000);
    // The US stub of September is after the departure: not 1030, listed as excluded.
    expect(d.draft[1030]).toBeUndefined();
    expect(d.foreignSalary.stubs).toHaveLength(0);
    expect(d.excluded.find((x) => x.kind === "us_salary")).toMatchObject({ reason: "nonresident", clp: 20_000 * OBSERVADO });
    // The non-resident part: September's rent at 35 %, the DFL-2 rent exempt, its own codes kept apart.
    expect(d.nonresident?.window).toEqual({ fromYmd: DEPARTURE, throughYmd: `${SPLIT_YEAR}-12-31` });
    expect(d.nonresident?.codes[1849]).toBe(1_200_000);
    expect(d.nonresident?.codes[158]).toBe(1_200_000);
    expect(d.nonresident?.rentals.exemptRentClp).toBe(400_000);
    expect(d.draft[32]).toBe(1_200_000);
    expect(d.draft[34]).toBe(Math.round(IMPUESTO_ADICIONAL_RATE * 1_200_000));
    // The two parts add up in 305, and the form's identities hold with both bases on it.
    expect(d.draft[305]).toBe(d.draft[304]! + d.draft[34]!);
    expect(d.draft[305]).toBe(f22Code305(d.draft));
    expect(f22IdentityViolations(new Map(Object.entries(d.draft).map(([k, v]) => [Number(k), v])), "draft")).toEqual([]);
    expect(d.residency.assumption).not.toBeNull();
  });

  it("keeps a year before the declaration as it always was", () => {
    const d = buildF22Draft(SPLIT_YEAR, `${SPLIT_YEAR - 1}-12-15`, { usdFx: { load: noUsd } });
    expect(d.regime).toBe("resident");
    expect(d.residency.year.declared).toBe(false);
    expect(d.residency.assumption).toBeNull();
    expect(d.nonresident).toBeNull();
    expect(d.excluded).toEqual([]);
  });
});
