import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addCalendarMonths } from "nw-tracker-contracts";
import type { DeptoCostBandDto, DeptoGlanceDto } from "nw-tracker-contracts/dto";
import { db } from "./db.js";
import { loanAccountImportKey, propertyAccountImportKey } from "./accountIdentityKeys.js";
import { propertyLoanPairs } from "./accountRoles.js";
import { cachedAccountDetailBundle } from "./accountDetailBundle.js";
import { clearAggregationCache } from "./cacheRegistry.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import {
  deptoPaymentHumanNote,
  insertLoanPaymentRow,
  loanPaymentColumnsFromPaymentRow,
  upsertPropertyAppraisalUf,
  type DeptoDividendosPaymentRow,
} from "./deptoDividendosLedger.js";
import {
  buildRealEstateGroupGlance,
  REAL_ESTATE_GROUP_SLUG,
  sumRealEstateGlances,
  type RealEstateGroupMember,
} from "./realEstateGroupGlance.js";

type PropertyGlance = Extract<DeptoGlanceDto, { kind: "property" }>;

// ---------------------------------------------------------------------------------------------
// The sum, on hand-built page blocks: loans in different currencies, a property with no place.

const AS_OF = "2026-03-15";

function costBand(months: Record<string, Record<string, number>>): DeptoCostBandDto {
  const kinds = [...new Set(Object.values(months).flatMap((m) => Object.keys(m)))];
  const direction = (k: string) => (k.startsWith("mortgage_amortization") ? ("equity" as const) : ("cost" as const));
  return {
    place_slug: "vitest-place",
    kinds: kinds.map((kind) => ({ kind, direction: direction(kind) })),
    months: Object.entries(months).map(([month, values]) => ({
      month,
      values: Object.fromEntries(kinds.map((k) => [k, values[k] ?? 0])),
      cost_total: 0,
      equity_total: 0,
      equity_over_cap: false,
      in_window: false,
    })),
    axis: { cap: 1, ticks: [] },
    window: null,
  };
}

/** A property page block with only what the sum reads; `points` = [date, value, mortgage, deposited]. */
function member(args: {
  id: number;
  loanCurrency: string;
  equityLoan: number;
  points: [string, number, number, number][];
  strip: { day: number | null; month: number; year: number; total: number };
  months: [string, number][];
  split: { cuota: number; currency: number | null; cuotas: string[] } | null;
  cost: DeptoCostBandDto | null;
}): RealEstateGroupMember {
  const points = args.points.map(([date, value, mortgage, deposited]) => ({ date, value, mortgage, deposited, equity: value - mortgage }));
  const last = points.at(-1)!;
  let cumulative = 0;
  const months = args.months.map(([month, pl], i) => {
    cumulative += pl;
    return { month, pl, pl_cumulative: cumulative, closing: 1000 + i, value_change: i === 0 ? null : 1 };
  });
  const years = [...new Set(months.map((m) => m.month.slice(0, 4)))].map((year) => {
    const list = months.filter((m) => m.month.startsWith(year));
    return {
      year,
      first_month: list[0]!.month,
      last_month: list.at(-1)!.month,
      pl: list.reduce((a, m) => a + m.pl, 0),
      value_change: list.reduce((a, m) => a + (m.value_change ?? 0), 0),
    };
  });
  const glance: PropertyGlance = {
    kind: "property",
    unit: "clp",
    loan_currency: args.loanCurrency,
    payment_currency: "clp",
    as_of: AS_OF,
    header: { hero_loan: args.equityLoan, hero: last.equity, strip: { ...args.strip, year_pct: 0.01, total_pct: args.strip.total / last.deposited } },
    property: {
      value: {
        points,
        prepagos: [],
        ownership: { owned_loan: args.equityLoan, owed_loan: args.equityLoan, owned_share: 0.5, owed_share: 0.5 },
        appraisal: { value_loan: args.equityLoan * 2, value: last.value },
        purchase: { date: points[0]!.date, value: points[0]!.value, revaluation: last.value - points[0]!.value, revaluation_pct: 0 },
        pie: { pie_loan: 1, pie: points[0]!.deposited },
      },
      pl: {
        months,
        years,
        total: { pl: args.strip.total, pct: null },
        this_month: args.split
          ? {
              month: AS_OF.slice(0, 7),
              pl: args.split.cuota + (args.split.currency ?? 0),
              cuotas: args.split.cuotas,
              cuota_part: args.split.cuota,
              currency_part: args.split.currency,
              cuota_share: 1,
              currency_share: 1,
            }
          : null,
      },
      cost: args.cost,
      movement_count: 0,
    },
  };
  return { accountId: args.id, name: `P${args.id}`, colorRgb: "1,2,3", glance };
}

describe("real-estate group sum", () => {
  // A: a UF loan since December, with a place. B: a dollar loan since February, no place.
  const a = member({
    id: 1,
    loanCurrency: "uf",
    equityLoan: 100,
    points: [
      ["2025-12-31", 1000, 600, 400],
      ["2026-01-31", 1010, 590, 420],
      ["2026-02-28", 1020, 580, 440],
      [AS_OF, 1030, 570, 460],
    ],
    strip: { day: 3, month: 10, year: 30, total: -20 },
    months: [["2025-12", -50], ["2026-01", 10], ["2026-02", 10], ["2026-03", 10]],
    split: { cuota: -15, currency: 25, cuotas: ["4"] },
    cost: costBand({
      "2025-11": { mortgage_carrying: 100, mortgage_amortization: 40 },
      "2025-12": { mortgage_carrying: 110, mortgage_amortization: 40, gastos_comunes: 30 },
      "2026-01": { mortgage_carrying: 120, mortgage_amortization: 40 },
    }),
  });
  const b = member({
    id: 2,
    loanCurrency: "usd",
    equityLoan: 50,
    points: [
      ["2026-02-28", 2000, 1500, 500],
      [AS_OF, 2100, 1480, 540],
    ],
    strip: { day: -1, month: 60, year: 60, total: 80 },
    months: [["2026-02", 20], ["2026-03", 60]],
    split: { cuota: -30, currency: 90, cuotas: ["2"] },
    cost: null,
  });

  it("adds the pages' figures, a property from its first point, each row in its own currency", () => {
    const g = sumRealEstateGlances([a, b], "clp", AS_OF);
    expect(g.equity).toBe(460 + 620);
    expect(g.strip).toEqual({ day: 2, month: 70, year: 90, total: 60, year_pct: null, total_pct: 60 / (460 + 540) });
    expect(g.properties.map((p) => [p.account_id, p.loan_currency, p.equity_loan, p.equity])).toEqual([
      [1, "uf", 100, 460],
      [2, "usd", 50, 620],
    ]);
    expect(g.properties[0]!.strip).toBe(a.glance.header.strip);
    expect(g.loan_currencies).toEqual(["uf", "usd"]);

    expect(g.value.dates).toEqual(["2025-12-31", "2026-01-31", "2026-02-28", AS_OF]);
    expect(g.value.series).toEqual([
      { account_id: 1, equity: [400, 420, 440, 460] },
      { account_id: 2, equity: [null, null, 500, 620] },
    ]);
    expect(g.value.totals[1]).toEqual({ value: 1010, mortgage: 590, deposited: 420, equity: 420 });
    expect(g.value.totals[3]).toEqual({ value: 3130, mortgage: 2050, deposited: 1000, equity: 1080 });
    expect(g.value.ownership).toEqual({ owned: 1080, owed: 2050, owned_share: 1080 / 3130, owed_share: 2050 / 3130 });
    expect(g.value.appraisal).toBe(3130);
    expect(g.value.purchase).toEqual({ value: 3000, revaluation: 130, revaluation_pct: 130 / 3000 });
    expect(g.value.pie).toBe(900);

    expect(g.pl.months.map((m) => [m.month, m.pl, m.pl_cumulative])).toEqual([
      ["2025-12", -50, -50],
      ["2026-01", 10, -40],
      ["2026-02", 30, -10],
      ["2026-03", 70, 60],
    ]);
    // B's first month has no change of its own; A's does.
    expect(g.pl.months[2]!.value_change).toBe(1);
    expect(g.pl.months[0]!.value_change).toBeNull();
    expect(g.pl.years).toEqual([
      { year: "2025", first_month: "2025-12", last_month: "2025-12", pl: -50, value_change: 0 },
      { year: "2026", first_month: "2026-01", last_month: "2026-03", pl: 110, value_change: 4 },
    ]);
    expect(g.pl.total).toEqual({ pl: 60, pct: 60 / 1000 });
    expect(g.pl.this_month).toEqual({
      month: "2026-03",
      pl: 70,
      cuotas: ["4", "2"],
      cuota_part: -45,
      currency_part: 115,
      cuota_share: 45 / 115,
      currency_share: 1,
    });
  });

  it("takes the cost of living from the properties that have a place, by the page's window rule", () => {
    const g = sumRealEstateGlances([a, b], "clp", AS_OF);
    if (g.cost == null) throw new Error("no cost band");
    expect("place_slug" in g.cost).toBe(false);
    expect(g.cost.months.map((m) => [m.month, m.cost_total, m.equity_total, m.in_window])).toEqual([
      ["2025-11", 100, 40, true],
      ["2025-12", 140, 40, true],
      ["2026-01", 120, 40, true],
    ]);
    // March: the window ends two months back, in January.
    expect(g.cost.window).toMatchObject({ from: "2025-11", to: "2026-01", cost: 360, equity: 120, total: 480 });

    // Two places: their months add per kind.
    const c = member({
      id: 3,
      loanCurrency: "uf",
      equityLoan: 10,
      points: [[AS_OF, 500, 100, 300]],
      strip: { day: 0, month: 0, year: 0, total: 0 },
      months: [["2026-03", 0]],
      split: null,
      cost: costBand({ "2026-01": { mortgage_carrying: 5, contribuciones: 7 }, "2026-02": { contribuciones: 9 } }),
    });
    const both = sumRealEstateGlances([a, c], "clp", AS_OF).cost!;
    expect(both.months.find((m) => m.month === "2026-01")!.values).toMatchObject({ mortgage_carrying: 125, contribuciones: 7, mortgage_amortization: 40 });
    expect(both.months.at(-1)).toMatchObject({ month: "2026-02", cost_total: 9, in_window: false });
    expect(sumRealEstateGlances([b, { ...b, accountId: 9 }], "clp", AS_OF).cost).toBeNull();
  });

  it("leaves the day unknown when a property has none, and a still currency part out", () => {
    const noDay: RealEstateGroupMember = {
      ...b,
      glance: {
        ...b.glance,
        header: { ...b.glance.header, strip: { ...b.glance.header.strip, day: null } },
        property: { ...b.glance.property, pl: { ...b.glance.property.pl, this_month: { ...b.glance.property.pl.this_month!, currency_part: -25 } } },
      },
    };
    const g = sumRealEstateGlances([a, noDay], "clp", AS_OF);
    expect(g.strip.day).toBeNull();
    expect(g.strip.month).toBe(70);
    // +25 and −25 cancel: the property page's «did not move».
    expect(g.pl.this_month).toMatchObject({ currency_part: null, currency_share: 0, cuota_share: 1 });
  });

  it("leaves the month unsplit when a property has no split of its own", () => {
    const fresh = member({
      id: 5,
      loanCurrency: "uf",
      equityLoan: 1,
      points: [[AS_OF, 900, 800, 100]],
      strip: { day: 0, month: -40, year: -40, total: -40 },
      months: [["2026-03", -40]],
      split: null,
      cost: null,
    });
    const g = sumRealEstateGlances([a, fresh], "clp", AS_OF);
    expect(g.pl.this_month).toBeNull();
    expect(g.pl.months.at(-1)!.pl).toBe(-30);
    expect(g.strip.month).toBe(-30);
  });

  it("refuses blocks of another unit or day, a single property, and a property missing a shared date", () => {
    expect(() => sumRealEstateGlances([a], "clp", AS_OF)).toThrow(/two properties/);
    expect(() => sumRealEstateGlances([a, b], "usd", AS_OF)).toThrow(/is in clp, not usd/);
    expect(() => sumRealEstateGlances([a, b], "clp", "2026-03-16")).toThrow(/is of 2026-03-15/);
    const gappy = member({
      id: 4,
      loanCurrency: "uf",
      equityLoan: 1,
      points: [["2025-12-31", 10, 0, 10], [AS_OF, 10, 0, 10]],
      strip: { day: 0, month: 0, year: 0, total: 0 },
      months: [["2026-03", 0]],
      split: null,
      cost: null,
    });
    expect(() => sumRealEstateGlances([a, gappy], "clp", AS_OF)).toThrow(/property 4 has no chart point on 2026-01-31/);
  });
});

// ---------------------------------------------------------------------------------------------
// The payload, on synthetic properties in the test person's market window.

const KEYS = ["vitest_re_group_a", "vitest_re_group_b"] as const;

function paymentRow(overrides: Partial<DeptoDividendosPaymentRow>): DeptoDividendosPaymentRow {
  return {
    cuota: "1",
    occurred_on: "",
    amount_clp: 0,
    credito_restante_uf: null,
    min_uf: null,
    max_uf: null,
    amortizacion_clp: null,
    amortizacion_ext_clp: null,
    interes_clp: null,
    incendio_clp: null,
    desgravamen_clp: null,
    ...overrides,
  };
}

describe("real-estate group glance", () => {
  const props: number[] = [];
  const loans: number[] = [];
  let bare = 0;
  let skip = false;

  const group = (slug: string) => {
    const g = db.prepare(`SELECT id FROM asset_groups WHERE slug = ?`).get(slug) as { id: number } | undefined;
    if (!g) throw new Error(`test DB lacks asset group ${slug}`);
    return g.id;
  };
  /** Files an account under the real-estate node, as the panel does (removed with the account). */
  const fileUnderGroup = (accountId: number, sortOrder: number) => {
    const node = db.prepare(`SELECT id FROM portfolio_groups WHERE slug = ?`).get(REAL_ESTATE_GROUP_SLUG) as { id: number } | undefined;
    if (!node) throw new Error("test DB lacks the real-estate portfolio group");
    db.prepare(`INSERT INTO portfolio_group_items (group_id, item_kind, account_id, sort_order) VALUES (?, 'account', ?, ?)`).run(node.id, accountId, sortOrder);
  };
  const monthDay = (back: number, day: number) => `${addCalendarMonths(chileCalendarTodayYmd().slice(0, 7), -back)}-${String(day).padStart(2, "0")}`;

  /**
   * Property `i` with its loan: a pie `pieBack` months ago and a cuota each month up to two months
   * ago, paid on `day` — the two properties pay on different days, and still chart the same dates.
   */
  function createProperty(i: number, pieBack: number, day: number) {
    const month = (back: number) => monthDay(back, day);
    const ins = db.prepare(`INSERT INTO accounts (asset_group_id, name, notes, import_key) VALUES (?, ?, 'vitest', ?)`);
    props[i] = Number(ins.run(group("real_estate__property"), `RE group ${i}`, propertyAccountImportKey(KEYS[i]!)).lastInsertRowid);
    loans[i] = Number(ins.run(group("liabilities__mortgage"), `RE group loan ${i}`, loanAccountImportKey(KEYS[i]!)).lastInsertRowid);
    fileUnderGroup(props[i]!, 90 + i);
    const insMov = db.prepare(`INSERT INTO movements (account_id, amount, currency, occurred_on, note, flow_kind) VALUES (?, ?, 'clp', ?, ?, ?)`);
    const scale = i + 1;
    const rows = [paymentRow({ cuota: "pie", occurred_on: month(pieBack), amount_clp: 58_000_000 * scale, credito_restante_uf: 3000 * scale })];
    for (let n = 1; pieBack - n >= 2; n++) {
      rows.push(
        paymentRow({
          cuota: String(n),
          occurred_on: month(pieBack - n),
          amount_clp: 1_200_000,
          credito_restante_uf: 3000 * scale - 14 * n,
          amortizacion_clp: 558_400,
          amortizacion_ext_clp: 0,
          interes_clp: 601_500,
          incendio_clp: 20_050,
          desgravamen_clp: 20_050,
          min_uf: 30,
          max_uf: 80,
        })
      );
    }
    upsertPropertyAppraisalUf(props[i]!, month(pieBack), 5400 * scale);
    for (const r of rows) {
      const prop = insMov.run(props[i], r.amount_clp, r.occurred_on, deptoPaymentHumanNote("property", r.cuota, false), null);
      insertLoanPaymentRow({ movement_id: Number(prop.lastInsertRowid), loan_account_id: loans[i]!, leg: "property", origin: "import", ...loanPaymentColumnsFromPaymentRow(r) });
      if (r.cuota !== "pie") {
        const mort = insMov.run(loans[i], r.amount_clp, r.occurred_on, deptoPaymentHumanNote("loan", r.cuota, false), "pago_cuota_hipotecario");
        insertLoanPaymentRow({ movement_id: Number(mort.lastInsertRowid), loan_account_id: loans[i]!, leg: "loan", origin: "import", ...loanPaymentColumnsFromPaymentRow(r) });
      }
    }
    clearAggregationCache();
  }

  const pageOf = async (accountId: number, unit: "clp" | "usd") => {
    const page = (await cachedAccountDetailBundle(accountId, unit, "monthly"))?.depto_glance;
    if (page?.kind !== "property") throw new Error(`account ${accountId} has no property glance`);
    return page;
  };

  beforeAll(() => {
    // A DB with a depto of its own (a dev copy) keeps it; the fixture runs on the lean test DB.
    skip = propertyLoanPairs().length > 0;
    if (skip) return;
    createProperty(0, 5, 11);
  });

  afterAll(() => {
    if (skip) return;
    for (const id of [...props, ...loans, bare].filter((x) => x > 0)) {
      db.prepare(`DELETE FROM movements WHERE account_id = ?`).run(id);
      db.prepare(`DELETE FROM valuations WHERE account_id = ?`).run(id);
      db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
    }
    clearAggregationCache();
  });

  it("is only the real-estate group's", async () => {
    expect(await buildRealEstateGroupGlance("liabilities_mortgage", "clp")).toBeNull();
  });

  it.each(["clp", "usd"] as const)("with one property is that property's page block, in %s", async (unit) => {
    if (skip) return;
    const g = await buildRealEstateGroupGlance(REAL_ESTATE_GROUP_SLUG, unit);
    if (g == null) throw new Error("no glance");
    expect(g.several).toBeNull();
    expect(g.single?.account_id).toBe(props[0]);
    expect(g.single?.glance).toEqual(await pageOf(props[0]!, unit));
    expect(g.properties_without_ledger).toEqual([]);
  });

  it("with several adds the pages up, and lists a property with no ledger apart", async () => {
    if (skip) return;
    createProperty(1, 3, 4);
    bare = Number(
      db
        .prepare(`INSERT INTO accounts (asset_group_id, name, notes, import_key) VALUES (?, 'RE group bare', 'vitest', ?)`)
        .run(group("real_estate__property"), propertyAccountImportKey("vitest_re_group_bare")).lastInsertRowid
    );
    fileUnderGroup(bare, 99);
    clearAggregationCache();
    for (const unit of ["clp", "usd"] as const) {
      const g = await buildRealEstateGroupGlance(REAL_ESTATE_GROUP_SLUG, unit);
      if (g == null) throw new Error("no glance");
      expect(g.single).toBeNull();
      expect(g.properties_without_ledger).toEqual([{ account_id: bare, name: "RE group bare" }]);
      const s = g.several;
      if (s == null) throw new Error("no sum");
      expect(s.properties.map((p) => p.account_id).sort((x, y) => x - y)).toEqual(props);
      // The rows and the chart layers come in the group's own account order.
      expect(s.value.series.map((x) => x.account_id)).toEqual(s.properties.map((p) => p.account_id));
      const layer = (i: number) => s.value.series.find((x) => x.account_id === props[i])!.equity;
      const pages = [await pageOf(props[0]!, unit), await pageOf(props[1]!, unit)];

      pages.forEach((page, i) => {
        const row = s.properties.find((p) => p.account_id === props[i])!;
        expect(row.equity_loan).toBe(page.header.hero_loan);
        expect(row.equity).toBe(page.header.hero ?? page.header.hero_loan);
        expect(row.appraisal_loan).toBe(page.property.value.appraisal.value_loan);
        expect(row.owned_share).toBe(page.property.value.ownership.owned_share);
        expect(row.strip).toEqual(page.header.strip);
        // The rule the sum's total % applies is each page's own.
        expect(page.header.strip.total_pct).toBeCloseTo(page.header.strip.total / page.property.value.points.at(-1)!.deposited, 9);
      });
      const add = (pick: (p: (typeof pages)[number]) => number) => pages.reduce((a, p) => a + pick(p), 0);
      expect(s.equity).toBeCloseTo(add((p) => p.header.hero ?? p.header.hero_loan), 6);
      expect(s.strip.month).toBeCloseTo(add((p) => p.header.strip.month), 6);
      expect(s.strip.total).toBeCloseTo(add((p) => p.header.strip.total), 6);
      expect(s.value.appraisal).toBeCloseTo(add((p) => p.property.value.appraisal.value), 6);
      expect(s.value.pie).toBeCloseTo(add((p) => p.property.value.pie.pie), 6);

      // The chart: ends today on the pages' last points; the newer property starts later.
      expect(s.value.dates.at(-1)).toBe(g.as_of);
      expect(s.value.totals.at(-1)!.equity).toBeCloseTo(add((p) => p.property.value.points.at(-1)!.equity), 6);
      expect(layer(0)[0]).not.toBeNull();
      expect(layer(1)[0]).toBeNull();
      expect(layer(1).filter((v) => v != null)).toHaveLength(pages[1]!.property.value.points.length);

      // P/L: the months add up to the total, the last month to the strip's.
      expect(s.pl.months.at(-1)!.pl).toBeCloseTo(s.strip.month, 6);
      expect(s.pl.months.at(-1)!.pl_cumulative).toBeCloseTo(s.pl.months.reduce((a, m) => a + m.pl, 0), 6);
      expect(s.pl.years.reduce((a, y) => a + y.pl, 0)).toBeCloseTo(add((p) => p.property.pl.years.reduce((a, y) => a + y.pl, 0)), 4);
      expect(s.pl.total.pl).toBeCloseTo(s.strip.total, 6);
      expect(s.loan_currencies).toEqual(["uf"]);
      expect(s.cost).toBeNull();
    }
  });
});
