import { describe, expect, it } from "vitest";
import {
  buildUpcomingPayments,
  contribucionesUpcomingItems,
  dayInMonth,
  groupUpcomingByMonth,
  hoaUpcomingItems,
  mortgageUpcomingItems,
  projectedUfClp,
  automaticRecurringMatchForLine,
  matchRecurringPayments,
  type RecurringEntry,
  type RecurringLine,
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
  const base = { loanAccountId: 9, name: "Depto", route_path: "/account/9", nextCuota: 33, nextScheduleYmd: "2026-11-11", minUf: 20, maxUf: 30, quote: null, bestPay: null };

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

  it("takes the lender's quote for the next cuota only, not estimated; later cuotas stay projected", () => {
    const items = mortgageUpcomingItems({ ...base, quote: { minUf: 10.5, maxUf: 75 } }, TODAY, "2026-12", flatUf);
    expect(items.map((i) => [i.cuota, i.amount_clp, i.amount_max_clp, i.estimated])).toEqual([
      [33, 420_000, 3_000_000, false],
      [34, 800_000, 1_200_000, true],
    ]);
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

describe("declared payments: matching", () => {
  // The UF is 40.000 until 2026-09-05 and 40.500 from the 6th; the 0,5 UF insurance costs 20.250 from then on.
  const ufOn = (ymd: string) => (ymd >= "2026-09-06" ? 40_500 : 40_000);
  const UF_KNOWN_THROUGH = "2026-10-31";
  const HORIZON_END = "2027-03-31";

  const insurance: RecurringEntry = {
    id: 1,
    name: "Seguro auto",
    detail: null,
    manual: false,
    frequency: "monthly",
    due_month: null,
    due_day: 6,
    amount: 0.5,
    currency: "uf",
    patterns: ["PENDING NAME", "SETTLED NAME"],
    match_days_before: 14,
    match_days_after: 7,
    amount_tolerance_pct: 1,
    created_at: "2026-01-01 00:00:00",
  };
  const line = (ref: string, purchase_on: string, merchant: string, amount_clp: number): RecurringLine => ({
    ref,
    purchase_on,
    merchant,
    display_merchant: null,
    amount_clp,
  });
  const model = (entries: RecurringEntry[], lines: RecurringLine[], todayYmd: string) =>
    matchRecurringPayments({ entries, lines, todayYmd, horizonEndYmd: HORIZON_END, ufOn, ufKnownThrough: UF_KNOWN_THROUGH });
  const occurrenceDue = (occs: ReturnType<typeof matchRecurringPayments>, due: string) => {
    const found = occs.find((o) => o.entry.id === 1 && o.due_iso === due);
    if (!found) throw new Error(`no occurrence due ${due}`);
    return found;
  };

  it("a UF entry is paid by its pending listing three days before the posting, priced at the posting day's UF", () => {
    const occs = model([insurance], [line("cc|pending", "2026-09-03", "PENDING NAME 1234", 20_250)], "2026-09-04");
    expect(occurrenceDue(occs, "2026-09-06")).toMatchObject({
      status: "paid",
      amount_clp: 20_250,
      estimated: false,
      matched: { ref: "cc|pending", purchase_on: "2026-09-03" },
    });
  });

  it("the settled posting, nearer the due day, is the line that pays when both are listed", () => {
    const occs = model(
      [insurance],
      [line("cc|pending", "2026-09-03", "PENDING NAME 1234", 20_250), line("cc|settled", "2026-09-06", "SETTLED NAME", 20_250)],
      "2026-09-20"
    );
    expect(occurrenceDue(occs, "2026-09-06").matched?.ref).toBe("cc|settled");
  });

  it("a line with the wrong amount does not pay the occurrence; the unpaid UF cuota is overdue at the UF of its day", () => {
    const occs = model([insurance], [line("cc|wrong", "2026-10-03", "PENDING NAME", 12_345)], "2026-10-20");
    expect(occurrenceDue(occs, "2026-10-06")).toMatchObject({ status: "overdue", matched: null, amount_clp: 20_250, estimated: false });
  });

  describe("yearly two-cuota entry (same name, same merchant)", () => {
    const cuota = (id: number, detail: string, due_month: number): RecurringEntry => ({
      id,
      name: "Permiso de circulación",
      detail,
      manual: true,
      frequency: "yearly",
      due_month,
      due_day: 31,
      amount: 180_000,
      currency: "clp",
      patterns: ["MUNICIPALIDAD DE MAIPU"],
      match_days_before: 14,
      match_days_after: 7,
      amount_tolerance_pct: 10,
      created_at: "2025-01-01 00:00:00",
    });
    const cuota1 = cuota(10, "1ª cuota", 3);
    const cuota2 = cuota(11, "2ª cuota", 8);
    const muni = (purchase_on: string, amount_clp: number) =>
      line(`cc|${purchase_on}`, purchase_on, "MUNICIPALIDAD DE MAIPU", amount_clp);
    const due = (occs: ReturnType<typeof matchRecurringPayments>, id: number, iso: string) => {
      const found = occs.find((o) => o.entry.id === id && o.due_iso === iso);
      if (!found) throw new Error(`no occurrence ${id} due ${iso}`);
      return found;
    };

    it("cuota 2 takes the amount cuota 1 was paid, the same year; before any payment the stated amount", () => {
      const unpaid = model([cuota1, cuota2], [], "2026-07-01");
      expect(due(unpaid, 10, "2026-03-31")).toMatchObject({ status: "overdue", amount_clp: 180_000, estimated: true });
      expect(due(unpaid, 11, "2026-08-31")).toMatchObject({ status: "upcoming", amount_clp: 180_000, estimated: true });

      const cuota1Paid = model([cuota1, cuota2], [muni("2026-03-25", 195_000)], "2026-07-01");
      expect(due(cuota1Paid, 10, "2026-03-31")).toMatchObject({ status: "paid", amount_clp: 195_000, estimated: false });
      expect(due(cuota1Paid, 11, "2026-08-31")).toMatchObject({ status: "upcoming", amount_clp: 195_000, estimated: true });
      // Next year's cuota 1 is priced from this year's cuota 1, its own last payment.
      expect(due(cuota1Paid, 10, "2027-03-31")).toMatchObject({ amount_clp: 195_000 });
    });

    it("a payment in cuota 2's window pays it when its amount is within the tolerance", () => {
      const occs = model([cuota1, cuota2], [muni("2026-03-25", 195_000), muni("2026-08-28", 197_000)], "2026-09-01");
      expect(due(occs, 11, "2026-08-31")).toMatchObject({ status: "paid", amount_clp: 197_000, matched: { ref: "cc|2026-08-28" } });
    });

    it("a whole-year permit paid in March pays cuota 1 and covers cuota 2; a first cuota does not", () => {
      const permit = (purchase_on: string, amount_clp: number, covers_through: string): RecurringLine => ({
        ...muni(purchase_on, amount_clp),
        covers_through,
      });
      const whole = model([cuota1, cuota2], [permit("2026-03-25", 390_000, "2027-03-31")], "2026-07-01");
      expect(due(whole, 10, "2026-03-31")).toMatchObject({ status: "paid", amount_clp: 390_000 });
      expect(due(whole, 11, "2026-08-31")).toMatchObject({ status: "covered", matched: null });
      // Next year's cuota 1 is due again: the permit expires on its due day.
      expect(due(whole, 10, "2027-03-31").status).toBe("upcoming");

      const first = model([cuota1, cuota2], [permit("2026-03-25", 195_000, "2026-08-31")], "2026-07-01");
      expect(due(first, 11, "2026-08-31")).toMatchObject({ status: "upcoming", amount_clp: 195_000 });
    });

    it("a sibling paid in another year does not set the amount; a charge outside the window does not match", () => {
      const otherYear = model([cuota1, cuota2], [muni("2025-03-25", 170_000)], "2026-07-01");
      expect(due(otherYear, 11, "2026-08-31")).toMatchObject({ amount_clp: 180_000, estimated: true, status: "upcoming" });

      // 21 days before the 31st of March: outside the 14-day window before.
      const early = model([cuota1, cuota2], [muni("2026-03-10", 180_000)], "2026-07-01");
      expect(due(early, 10, "2026-03-31")).toMatchObject({ status: "overdue", matched: null });
    });
  });

  it("automaticRecurringMatchForLine names the automatic entry a line fits, and nothing else", () => {
    const occs = model([insurance], [], "2026-10-20");
    expect(automaticRecurringMatchForLine(line("x", "2026-09-03", "PENDING NAME 1234", 20_250), occs, ufOn)?.entry.id).toBe(1);
    expect(automaticRecurringMatchForLine(line("x", "2026-09-03", "CONVENIO OTRO", 20_250), occs, ufOn)).toBeNull();
    expect(automaticRecurringMatchForLine(line("x", "2026-09-03", "PENDING NAME 1234", 40_000), occs, ufOn)).toBeNull();
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

  it("marks a payment due today or tomorrow, never an overdue one", () => {
    const months = groupUpcomingByMonth(
      [it_("today", TODAY, 1), it_("tomorrow", "2026-11-03", 1), it_("later", "2026-11-04", 1), it_("late", "2026-11-01", 1, true)],
      TODAY,
      6
    );
    expect(Object.fromEntries(months[0]!.items.map((i) => [i.key, i.due_soon]))).toEqual({
      late: null,
      today: "today",
      tomorrow: "tomorrow",
      later: null,
    });
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
