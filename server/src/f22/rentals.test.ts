import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../db.js";
import { checkingAccountId } from "../checkingCartolaImport.js";
import { computeF22Tax } from "./chain.js";
import { buildF22Draft } from "./draft.js";
import { f22PropertyTaxCreditCap } from "./identities.js";
import { rentalsForYear } from "./rentals.js";
import {
  deleteCheckingIncomeMovementOverride,
  loadRentPlaceSlugByMovementId,
  upsertCheckingIncomeMovementOverride,
} from "../flowsCheckingIncomeOverrides.js";
import { createRealEstatePlace, listRealEstatePlaces, setRealEstatePlaceDfl2 } from "../flowsRealEstateExpenses.js";
import { dfl2ContribucionesHalvedThroughYear, dfl2ContribucionesHalvingYears } from "../legalParameters.js";
import type { ForeignFxDisposalLoader } from "./foreignFx.js";

const UTA = 800_000;
// A synthetic year the Vitest person does not reach; the IPC reajuste is zero past the latest month.
const INCOME_YEAR = 2098;
const TODAY = `${INCOME_YEAR}-12-15`;
const DJ_YEAR = 2097;
const NOTE = "vitest:f22-rentals";
const noUsd: ForeignFxDisposalLoader = () => ({ disposals: [], openLots: [] });

describe("DFL-2 legal parameters", () => {
  it("halves contribuciones 20 / 15 / 10 years by built area, none above 140 m²", () => {
    expect(dfl2ContribucionesHalvingYears(55)).toBe(20);
    expect(dfl2ContribucionesHalvingYears(70)).toBe(20);
    expect(dfl2ContribucionesHalvingYears(71)).toBe(15);
    expect(dfl2ContribucionesHalvingYears(140)).toBe(10);
    expect(() => dfl2ContribucionesHalvingYears(141)).toThrow(/140/);
    expect(dfl2ContribucionesHalvedThroughYear(55, 2019)).toBe(2038);
  });
});

describe("the F22 chain with rent", () => {
  it("adds 955 to 158 and credits contribuciones (1637) up to the IGC on the rent", () => {
    const base = { 1098: 40_000_000, 162: 1_500_000 };
    const plain = computeF22Tax(base, UTA, 2030);
    const withRent = computeF22Tax({ ...base, 1849: 6_000_000, 955: 6_000_000 }, UTA, 2030, { propertyTaxPaidClp: 300_000 });
    expect(withRent[158]! - plain[158]!).toBe(6_000_000);
    expect(withRent[1637]).toBe(300_000);
    expect(withRent[304]).toBe(withRent[157]! - 300_000 - 1_500_000);
    // Capped at rent × round(157 / 170, 3).
    const capped = computeF22Tax({ ...base, 1849: 6_000_000, 955: 6_000_000 }, UTA, 2030, { propertyTaxPaidClp: 50_000_000 });
    const factor = Math.round((capped[157]! / capped[170]!) * 1000) / 1000;
    expect(capped[1637]).toBe(Math.round(6_000_000 * factor));
    expect(capped[1637]).toBe(f22PropertyTaxCreditCap(capped));
  });

  it("refuses a negative 152 (a negative real interest is a line-17 loss)", () => {
    expect(() => computeF22Tax({ 1098: 10_000_000, 152: -1 }, UTA, 2030)).toThrow(/152/);
  });
});

function insertCredit(occurredOn: string, amountClp: number, idx: number): number {
  const note = `import:cartola|${occurredOn.slice(0, 7)}|—|ARRIENDO ${idx}|on:${occurredOn}|amt:${amountClp}|idx:${idx}`;
  return Number(
    db
      .prepare(`INSERT INTO movements (account_id, amount, currency, occurred_on, note, units_delta) VALUES (?, ?, 'clp', ?, ?, NULL)`)
      .run(checkingAccountId(), amountClp, occurredOn, note).lastInsertRowid
  );
}

describe("rents in the F22 draft", () => {
  const movements: number[] = [];
  const cleanup = () => {
    for (const id of movements) {
      deleteCheckingIncomeMovementOverride(id);
      db.prepare(`DELETE FROM movements WHERE id = ?`).run(id);
    }
    db.prepare(
      `DELETE FROM expense_entries WHERE expense_account_id IN (SELECT id FROM expense_accounts WHERE slug LIKE 'vitest_rent_%')`
    ).run();
    db.prepare(`DELETE FROM expense_accounts WHERE slug LIKE 'vitest_rent_%'`).run();
    db.prepare(`DELETE FROM sii_informed_dj WHERE source_file = ?`).run(NOTE);
    db.prepare(`DELETE FROM fx_daily_bcentral WHERE date IN (?, ?)`).run(TODAY, `${DJ_YEAR}-12-31`);
  };

  beforeAll(() => {
    cleanup();
    // The year-end dólar observado the draft reads (synthetic far years: none stored).
    for (const d of [TODAY, `${DJ_YEAR}-12-31`]) {
      db.prepare(`INSERT INTO fx_daily_bcentral (date, clp_per_usd) VALUES (?, 900)`).run(d);
    }
    createRealEstatePlace({ slug: "vitest_rent_centro", label: "Centro", dfl2: { dfl2: true, builtM2: 55, receptionYear: 2019 } });
    createRealEstatePlace({ slug: "vitest_rent_tower", label: "Tower" });
    for (const [i, [day, amount, place]] of (
      [
        [`${INCOME_YEAR}-03-05`, 400_000, "vitest_rent_centro"],
        [`${INCOME_YEAR}-04-05`, 400_000, "vitest_rent_centro"],
        [`${INCOME_YEAR}-03-06`, 1_000_000, "vitest_rent_tower"],
        [`${INCOME_YEAR}-04-06`, 1_000_000, "vitest_rent_tower"],
      ] as const
    ).entries()) {
      const id = insertCredit(day, amount, 995_100 + i);
      movements.push(id);
      upsertCheckingIncomeMovementOverride(id, { income_kind: "rent", rent_place_slug: place });
    }
    const tower = listRealEstatePlaces().find((p) => p.slug === "vitest_rent_tower")!;
    const centro = listRealEstatePlaces().find((p) => p.slug === "vitest_rent_centro")!;
    const bill = db.prepare(`INSERT INTO expense_entries (amount, spent_on, category, expense_account_id) VALUES (?, ?, 'contribuciones', ?)`);
    bill.run(120_000, `${INCOME_YEAR}-04-30`, tower.id);
    bill.run(30_000, `${INCOME_YEAR}-04-30`, centro.id);
    // An informed year whose real interest came out negative.
    const dj = db.prepare(`INSERT INTO sii_informed_dj (tax_year, dj_code, field, value, source_file) VALUES (?, ?, ?, ?, ?)`);
    dj.run(DJ_YEAR + 1, 1887, "A: Renta Total Neta Pagada (Art.42 N°1, Ley de la Renta)", "30.000.000", NOTE);
    dj.run(DJ_YEAR + 1, 1887, "B: Impuesto Unico Retenido", "1.000.000", NOTE);
    dj.run(DJ_YEAR + 1, 1890, "B: Positivo", "50.000", NOTE);
    dj.run(DJ_YEAR + 1, 1890, "C: Negativo", "250.000", NOTE);
  });

  afterAll(cleanup);

  it("records the place a rent names, and refuses a rent without one or a place on another kind", () => {
    const slugs = loadRentPlaceSlugByMovementId();
    expect(slugs[movements[0]!]).toBe("vitest_rent_centro");
    expect(slugs[movements[2]!]).toBe("vitest_rent_tower");
    const id = insertCredit(`${INCOME_YEAR}-05-05`, 10_000, 995_199);
    movements.push(id);
    expect(() => upsertCheckingIncomeMovementOverride(id, { income_kind: "rent" })).toThrow(/rent_place_slug/);
    expect(() => upsertCheckingIncomeMovementOverride(id, { income_kind: "other", rent_place_slug: "vitest_rent_tower" })).toThrow();
    expect(() => upsertCheckingIncomeMovementOverride(id, { income_kind: "rent", rent_place_slug: "vitest_rent_nope" })).toThrow(/unknown place/);
  });

  it("splits the year's rent by the DFL-2 flag and keeps the exempt place's contribuciones out of the credit", () => {
    const r = rentalsForYear(INCOME_YEAR);
    expect(r.taxableRentClp).toBe(2_000_000);
    expect(r.exemptRentClp).toBe(800_000);
    expect(r.propertyTaxPaidClp).toBe(120_000);
    expect(r.places.find((p) => p.slug === "vitest_rent_centro")).toMatchObject({ dfl2: true, credits: 2, propertyTaxPaidClp: 30_000 });
  });

  it("drafts 1849 / 955 for the taxable rent and the 1637 credit; the DFL-2 rent enters no code", () => {
    const d = buildF22Draft(INCOME_YEAR + 1, TODAY, { foreignFx: { load: noUsd } });
    expect(d.taxComputed).toBe(true);
    expect(d.draft[1849]).toBe(2_000_000);
    expect(d.draft[955]).toBe(2_000_000);
    expect(d.draft[158]).toBe(2_000_000);
    // 2 M is below the first IGC bracket: no IGC on the rent, so the credit is capped at 0.
    expect(d.draft[1637]).toBeUndefined();
    expect(d.propertyTaxCredit).toEqual({ paidClp: 120_000, capClp: 0, creditClp: 0 });
    expect(d.rentals.exemptRentClp).toBe(800_000);
  });

  it("files a negative real interest (DJ 1890) as a line-17 loss, never a negative 152", () => {
    const d = buildF22Draft(DJ_YEAR + 1, TODAY, { foreignFx: { load: noUsd } });
    expect(d.informed[152]).toBeUndefined();
    expect(d.informed[169]).toBe(200_000);
    expect(d.draft[152]).toBeUndefined();
    // The loss pool holds no gain, so 169 is capped at 0 and 136 stays at 0.
    expect(d.draft[169]).toBe(0);
    expect(d.draft[136]).toBe(0);
    expect(d.lossOffset.unusedLossClp).toBe(200_000);
  });

  it("checks a DFL-2 declaration: area and reception year with the flag only, at most 140 m²", () => {
    expect(() => setRealEstatePlaceDfl2("vitest_rent_tower", { dfl2: true, builtM2: 160, receptionYear: 2015 })).toThrow(/140/);
    expect(() => setRealEstatePlaceDfl2("vitest_rent_tower", { dfl2: true, builtM2: 90 })).toThrow(/reception year/);
    expect(() => setRealEstatePlaceDfl2("vitest_rent_tower", { dfl2: false, builtM2: 90 })).toThrow();
    const logged = () =>
      (db.prepare(`SELECT COUNT(*) AS n FROM mark_input_changes WHERE source = 'expense_accounts'`).get() as { n: number }).n;
    const before = logged();
    const p = setRealEstatePlaceDfl2("vitest_rent_tower", { dfl2: true, builtM2: 90, receptionYear: 2015 });
    // The new columns reach the caches through the write log (the update trigger watches them).
    expect(logged()).toBeGreaterThan(before);
    expect(p).toMatchObject({ dfl2: true, dfl2_built_m2: 90, dfl2_reception_year: 2015, dfl2_contribuciones_halved_through: 2029 });
    expect(setRealEstatePlaceDfl2("vitest_rent_tower", { dfl2: false })).toMatchObject({ dfl2: false, dfl2_built_m2: null });
  });
});
