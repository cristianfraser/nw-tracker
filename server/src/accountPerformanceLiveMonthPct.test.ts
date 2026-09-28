import { describe, expect, it, vi } from "vitest";
import type { AccountMonthlyPerformanceRow } from "./accountPerformance.js";

const chileToday = vi.hoisted(() => ({ ymd: "2037-05-20" }));
const monthToDateFlow = vi.hoisted(() => ({ clp: 0 }));

vi.mock("./chileDate.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./chileDate.js")>();
  return {
    ...actual,
    chileCalendarTodayYmd: () => chileToday.ymd,
  };
});

vi.mock("./flowsDeposits.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./flowsDeposits.js")>();
  return {
    ...actual,
    netDepositFlowCurrentMonthThroughToday: () => monthToDateFlow.clp,
  };
});

import {
  patchOrInsertLiveCurrentMonthPerfRows,
  reanchorMonthlyPerfToCalendarMonthEnds,
} from "./accountPerformance.js";

/** No such account: its marks resolve to nothing, so every close comes from the rows below. */
const ACCOUNT_ID = -4242;
const SLUG = "apv";

function perfRow(
  partial: Partial<AccountMonthlyPerformanceRow> & Pick<AccountMonthlyPerformanceRow, "as_of_date">
): AccountMonthlyPerformanceRow {
  return {
    closing_value: 0,
    prior_closing: null,
    net_capital_flow: 0,
    stock_units_inflow: 0,
    nominal_pl: null,
    pct_month: null,
    ytd_nominal_pl: null,
    cumulative_nominal_pl: null,
    unit: "clp",
    ...partial,
  };
}

const april = perfRow({ as_of_date: "2037-04-30", closing_value: 1_000_000, net_capital_flow: 1_000_000 });

/** May 2037 as a closed month (reanchored the way every stored month is). */
function closedMay(closing: number, flow: number): AccountMonthlyPerformanceRow {
  chileToday.ymd = "2037-07-15";
  const rows = reanchorMonthlyPerfToCalendarMonthEnds(
    [april, perfRow({ as_of_date: "2037-05-31", closing_value: closing, net_capital_flow: flow })],
    { accountId: ACCOUNT_ID, bucketSlug: SLUG, unit: "clp" }
  );
  return rows.find((r) => r.as_of_date === "2037-05-31")!;
}

/** The same month while it is still running (today 2037-05-20), from the live patch. */
function runningMay(live: number, flow: number): AccountMonthlyPerformanceRow {
  chileToday.ymd = "2037-05-20";
  monthToDateFlow.clp = flow;
  const rows = patchOrInsertLiveCurrentMonthPerfRows(ACCOUNT_ID, SLUG, [april], "clp", () => live);
  return rows.find((r) => r.as_of_date === "2037-05-20")!;
}

describe("live current-month % return", () => {
  it("a liquidation month charges its flows at month end, running or closed", () => {
    // Prior close 1.000.000; the month withdrew 1.xxx.xxx (its gains too) and closes at 0.
    const closed = closedMay(0, -1_020_000);
    const running = runningMay(0, -1_020_000);

    expect(closed.nominal_pl).toBe(20_000);
    expect(closed.pct_month).toBeCloseTo(0.02, 12);
    expect(running.prior_closing).toBe(1_000_000);
    expect(running.net_capital_flow).toBe(-1_020_000);
    expect(running.nominal_pl).toBe(20_000);
    // +2% on the capital at work — not 2x.xxx ÷ (1.000.000 − 1.xxx.xxx) = −100%.
    expect(running.pct_month).toBeCloseTo(closed.pct_month!, 12);
  });

  it("a liquidation month at a loss reads the loss on the prior close, running or closed", () => {
    // Prior close 1.000.000; sold off for 996.000 and closes at 0 → −4.000: −0,4%, not the
    // −100% that −4.000 ÷ (1.000.000 − 996.000) always gives.
    const closed = closedMay(0, -996_000);
    const running = runningMay(0, -996_000);

    expect(closed.nominal_pl).toBe(-4_000);
    expect(closed.pct_month).toBeCloseTo(-0.004, 12);
    expect(running.nominal_pl).toBe(-4_000);
    expect(running.pct_month).toBeCloseTo(closed.pct_month!, 12);
  });

  it("withdrawing exactly the prior close reads 0%, not null", () => {
    const closed = closedMay(0, -1_000_000);
    const running = runningMay(0, -1_000_000);

    // toBe, not toBeCloseTo: the matcher reads null as 0.
    expect(closed.pct_month).toBe(0);
    expect(running.pct_month).toBe(0);
  });

  it("an ordinary month keeps the start-of-month frame", () => {
    // Deposit 5xx.xxx, close 1.xxx.xxx → 3x.xxx on the 1.500.000 at work.
    const closed = closedMay(1_530_000, 500_000);
    const running = runningMay(1_530_000, 500_000);

    expect(closed.pct_month).toBeCloseTo(0.02, 12);
    expect(running.pct_month).toBeCloseTo(closed.pct_month!, 12);
  });
});
