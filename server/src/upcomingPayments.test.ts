import { describe, expect, it } from "vitest";
import {
  buildUpcomingPayments,
  contribucionesUpcomingItems,
  dayInMonth,
  groupUpcomingByMonth,
  hoaUpcomingItems,
  mortgageUpcomingItems,
  projectedUfClp,
  recurringUpcomingItems,
  type UpcomingPaymentItem,
} from "./upcomingPayments.js";

const TODAY = "2026-11-02";
const HORIZON_END = "2027-04";
const flatUf = () => 40_000;

describe("projectedUfClp", () => {
  const rows = new Map([
    ["2025-11-09", 38_000],
    ["2026-11-09", 40_000],
  ]);
  const lookup = (ymd: string) => {
    const date = [...rows.keys()].filter((d) => d <= ymd).sort().pop();
    return date ? { date, clp_per_uf: rows.get(date)! } : null;
  };
  const latest = { date: "2026-11-09", clp_per_uf: 40_000 };

  it("reads the published UF up to the last day, and grows it at the last year's rate after", () => {
    expect(projectedUfClp("2026-01-15", latest, lookup)).toBe(38_000);
    expect(projectedUfClp("2026-11-09", latest, lookup)).toBe(40_000);
    expect(projectedUfClp("2027-11-09", latest, lookup)).toBeCloseTo(40_000 * (40_000 / 38_000), 6);
  });

  it("throws without a year of history to take the rate from", () => {
    expect(() => projectedUfClp("2027-01-01", latest, () => null)).toThrow(/a year before/);
  });
});

describe("dayInMonth", () => {
  it("clamps to the month's length", () => {
    expect(dayInMonth("2027-02", 31)).toBe("2027-02-28");
    expect(dayInMonth("2026-11", 20)).toBe("2026-11-20");
  });
});

describe("mortgageUpcomingItems", () => {
  const base = { name: "Depto", route_path: "/account/9", nextCuota: 33, nextScheduleYmd: "2026-11-11", minUf: 20, maxUf: 30, bestPay: null };

  it("lists every cuota from the next one to the horizon, on the 11th, min and max at the UF", () => {
    const items = mortgageUpcomingItems(base, TODAY, "2027-01", flatUf);
    expect(items.map((i) => [i.cuota, i.due_iso, i.due_kind, i.amount_clp, i.amount_max_clp])).toEqual([
      [33, "2026-11-11", "on", 800_000, 1_200_000],
      [34, "2026-12-11", "on", 800_000, 1_200_000],
      [35, "2027-01-11", "on", 800_000, 1_200_000],
    ]);
  });

  it("takes the UF module's best day for its month, and is overdue only past the 10th of the next month", () => {
    const items = mortgageUpcomingItems(
      { ...base, nextScheduleYmd: "2026-10-11", bestPay: { month: "2026-10", date: "2026-10-27" } },
      TODAY,
      "2026-11",
      flatUf
    );
    expect(items[0]).toMatchObject({ cuota: 33, due_iso: "2026-10-27", overdue: false });
    expect(mortgageUpcomingItems({ ...base, nextScheduleYmd: "2026-10-11" }, "2026-11-11", "2026-11", flatUf)[0]!.overdue).toBe(true);
  });
});

describe("hoaUpcomingItems", () => {
  const place = { id: 3, label: "Suecia", route_path: "/flows/expenses/real_estate/suecia" };
  const statements = [
    { bill_month: "2026-09", due_on: "2026-10-20", amount: 90_000, settled: true },
    { bill_month: "2026-10", due_on: "2026-11-20", amount: 95_000, settled: false },
  ];

  it("shows the statement on file, then every later month at its amount by the same day", () => {
    const items = hoaUpcomingItems(place, statements, new Set(), TODAY, "2027-01");
    expect(items.map((i) => [i.bill_month, i.due_iso, i.amount_clp, i.estimated])).toEqual([
      ["2026-10", "2026-11-20", 95_000, false],
      ["2026-11", "2026-12-20", 95_000, true],
      ["2026-12", "2027-01-20", 95_000, true],
    ]);
  });

  it("drops a month a bill row covers or whose statement is settled", () => {
    const items = hoaUpcomingItems(place, statements, new Set(["2026-10", "2026-11"]), TODAY, "2027-01");
    expect(items.map((i) => i.bill_month)).toEqual(["2026-12"]);
  });

  it("marks an unpaid statement past its due day overdue", () => {
    const items = hoaUpcomingItems(place, statements, new Set(), "2026-11-25", "2026-11");
    expect(items[0]).toMatchObject({ bill_month: "2026-10", overdue: true });
  });
});

describe("contribucionesUpcomingItems", () => {
  const place = { id: 3, label: "Suecia", route_path: "/flows/expenses/real_estate/suecia" };
  const lastYear = [
    { spent_on: "2025-04-30", amount: 90_000 },
    { spent_on: "2025-06-30", amount: 90_000 },
    { spent_on: "2025-09-30", amount: 90_000 },
    { spent_on: "2025-11-30", amount: 90_000 },
  ];

  it("holds the year's first paid cuota for the rest, at the last day of April, June, September, November", () => {
    const paid = [...lastYear, { spent_on: "2026-04-30", amount: 92_918 }, { spent_on: "2026-06-30", amount: 92_918 }];
    const items = contribucionesUpcomingItems(place, paid, "2026-07-01", "2026-12", flatUf);
    expect(items.map((i) => [i.cuota, i.due_iso, i.amount_clp, i.estimated])).toEqual([
      [3, "2026-09-30", 92_918, false],
      [4, "2026-11-30", 92_918, false],
    ]);
  });

  it("estimates a year with nothing paid from last year's same cuota, readjusted by the UF", () => {
    const uf = (ymd: string) => (ymd < "2026-01-01" ? 38_000 : 40_000);
    const items = contribucionesUpcomingItems(place, lastYear, "2026-01-10", "2026-06", uf);
    expect(items.map((i) => [i.due_iso, i.amount_clp, i.estimated, i.overdue])).toEqual([
      ["2026-04-30", Math.round(90_000 * (40_000 / 38_000)), true, false],
      ["2026-06-30", Math.round(90_000 * (40_000 / 38_000)), true, false],
    ]);
  });

  it("keeps this year's unpaid cuotas past their date, overdue", () => {
    const items = contribucionesUpcomingItems(place, lastYear, "2026-07-01", "2026-07", flatUf);
    expect(items.map((i) => [i.cuota, i.overdue])).toEqual([
      [1, true],
      [2, true],
    ]);
  });

  it("shows nothing for a property with no contribuciones on record", () => {
    expect(contribucionesUpcomingItems(place, [], TODAY, HORIZON_END, flatUf)).toEqual([]);
  });
});

describe("recurringUpcomingItems", () => {
  const permiso = {
    id: 1,
    name: "Permiso de circulación",
    detail: "1ª cuota",
    due_month: 3,
    due_day: 31,
    amount_clp: 180_000,
    paid_merchant_pattern: "municipalidad",
    created_at: "2026-11-02 12:00:00",
  };

  it("is due each year until a matching charge lands near its date, never before it was declared", () => {
    expect(recurringUpcomingItems(permiso, [], TODAY, HORIZON_END)).toMatchObject([
      { due_iso: "2027-03-31", amount_clp: 180_000, estimated: true, wip: true },
    ]);
    const paid = [{ purchase_on: "2027-02-20", merchant: "MUNICIPALIDAD DE MAIPU", display_merchant: "Permiso de circulación (Maipú)" }];
    expect(recurringUpcomingItems(permiso, paid, TODAY, HORIZON_END)).toEqual([]);
    expect(recurringUpcomingItems({ ...permiso, paid_merchant_pattern: "permiso de circulacion" }, paid, TODAY, HORIZON_END)).toEqual([]);
    // Declared before March: this year's, unpaid, is overdue.
    expect(recurringUpcomingItems({ ...permiso, created_at: "2026-01-01 00:00:00" }, [], TODAY, HORIZON_END).map((i) => [i.due_iso, i.overdue])).toEqual([
      ["2026-03-31", true],
      ["2027-03-31", false],
    ]);
  });
});

describe("groupUpcomingByMonth", () => {
  const it_ = (key: string, due_iso: string, amount_clp: number, overdue = false): UpcomingPaymentItem => ({
    key,
    kind: "recurring",
    name: key,
    due_iso,
    due_kind: "by",
    amount_clp,
    amount_max_clp: null,
    estimated: false,
    overdue,
    cuota: null,
    cuota_count: null,
    bill_month: null,
    card: null,
    detail: null,
    wip: false,
    route_path: null,
  });

  it("groups by due month, overdue in the current month first, drops what is past the horizon", () => {
    const months = groupUpcomingByMonth(
      [it_("b", "2026-11-20", 2), it_("late", "2026-10-31", 5, true), it_("a", "2026-11-10", 1), it_("far", "2027-06-01", 9)],
      TODAY,
      6
    );
    expect(months.map((m) => [m.pay_month, m.total_clp, m.items.map((i) => i.key)])).toEqual([["2026-11", 8, ["late", "a", "b"]]]);
  });
});

describe("buildUpcomingPayments", () => {
  it("builds from the test database: months in order, each total the sum of its items", () => {
    const block = buildUpcomingPayments(TODAY);
    const months = block.months.map((m) => m.pay_month);
    expect(months).toEqual([...months].sort());
    for (const m of block.months) expect(m.total_clp).toBe(m.items.reduce((a, i) => a + i.amount_clp, 0));
  });
});
