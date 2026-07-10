import { beforeEach, describe, expect, it, vi } from "vitest";
import { writeFxLatestCache } from "../../queries/fxLatestCache";
import { consolidatedRowsForDisplay } from "../../useGroupInfoConsolidatedTables";
import type { ConsolidatedMonthlyPerfRow } from "../../types";
import { resolveMonthlyDetailRows } from "./monthlyDetailRows";

function row(partial: Partial<ConsolidatedMonthlyPerfRow> = {}): ConsolidatedMonthlyPerfRow {
  return {
    as_of_date: "2025-01-31",
    closing_value: 950_000,
    prior_closing: 855_000,
    net_capital_flow: 0,
    stock_units_inflow: 0,
    nominal_pl: 9_500,
    pct_month: 0.01,
    ytd_nominal_pl: 9_500,
    cumulative_nominal_pl: 9_500,
    ...partial,
  };
}

const placeholderRows = [row({ nominal_pl: null, prior_closing: null })];

describe("resolveMonthlyDetailRows", () => {
  it("keeps real client rows even while the page bundle is loading (unit switch)", () => {
    const clientRows = [row()];
    const out = resolveMonthlyDetailRows({
      serverPaginated: false,
      serverRows: undefined,
      clientRows,
      pageLoading: true,
      tablesLoading: false,
      placeholderRows,
    });
    expect(out).toBe(clientRows);
  });

  it("falls back to placeholders only when loading with no rows on hand", () => {
    const out = resolveMonthlyDetailRows({
      serverPaginated: false,
      serverRows: undefined,
      clientRows: [],
      pageLoading: true,
      tablesLoading: false,
      placeholderRows,
    });
    expect(out).toBe(placeholderRows);
  });

  it("settled and genuinely empty → empty array (empty-state message)", () => {
    const out = resolveMonthlyDetailRows({
      serverPaginated: false,
      serverRows: undefined,
      clientRows: [],
      pageLoading: false,
      tablesLoading: false,
      placeholderRows,
    });
    expect(out).toEqual([]);
  });

  it("server-paginated: held rows win over placeholders regardless of pageLoading", () => {
    const serverRows = [row()];
    const out = resolveMonthlyDetailRows({
      serverPaginated: true,
      serverRows,
      clientRows: [],
      pageLoading: true,
      tablesLoading: false,
      placeholderRows,
    });
    expect(out).toBe(serverRows);
  });

  it("server-paginated with no data → placeholders", () => {
    const out = resolveMonthlyDetailRows({
      serverPaginated: true,
      serverRows: undefined,
      clientRows: [],
      pageLoading: true,
      tablesLoading: false,
      placeholderRows,
    });
    expect(out).toBe(placeholderRows);
  });
});

describe("consolidatedRowsForDisplay", () => {
  const storage: Record<string, string> = {};

  beforeEach(() => {
    for (const k of Object.keys(storage)) delete storage[k];
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage[key] ?? null,
      setItem: (key: string, value: string) => {
        storage[key] = value;
      },
      removeItem: (key: string) => {
        delete storage[key];
      },
    });
  });

  it("same-unit and uf payloads pass through by reference", () => {
    const rows = [row()];
    expect(consolidatedRowsForDisplay(rows, "clp", "clp")).toBe(rows);
    expect(consolidatedRowsForDisplay(rows, "usd", "usd")).toBe(rows);
    expect(consolidatedRowsForDisplay(rows, "uf", "usd")).toBe(rows);
  });

  it("converts held CLP rows to USD via the cached FX rate", () => {
    writeFxLatestCache({ date: "2025-01-31", clp_per_usd: 950 });
    const out = consolidatedRowsForDisplay([row()], "clp", "usd");
    expect(out).not.toBeNull();
    expect(out![0]!.closing_value).toBeCloseTo(1_000, 6);
    expect(out![0]!.nominal_pl).toBeCloseTo(10, 6);
    expect(out![0]!.pct_month).toBe(0.01);
  });

  it("returns null when no FX rate is available (caller falls back to placeholders)", () => {
    expect(consolidatedRowsForDisplay([row()], "clp", "usd")).toBeNull();
  });
});
