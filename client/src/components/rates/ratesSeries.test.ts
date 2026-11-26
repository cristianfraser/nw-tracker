import { describe, expect, it } from "vitest";
import { formatMarketValue } from "../watchlist/heatGrid";
import { parseStoredSurfacePrefs } from "../../surfaceDisplayPrefs";
import { pendingGlanceRow, RATES_CURRENCY_SERIES, ratesRowLabel } from "./ratesSeries";

const t = (key: string) => `t:${key}`;

describe("rates series", () => {
  it("names a pair by its codes, the IPC by its title and an instrument by the server's label", () => {
    const rows = RATES_CURRENCY_SERIES.map(pendingGlanceRow);
    expect(rows.map((r) => ratesRowLabel(r, t))).toEqual(["USD/CLP", "UF/CLP", "EUR/CLP", "EUR/USD", "t:rates.fx.ipcTitle"]);
    expect(
      ratesRowLabel({ id: "fund_unit:vitest_fund", base: null, quote: null, label: "Vitest fund" }, t)
    ).toBe("Vitest fund");
    expect(() => ratesRowLabel({ id: "equity:VTST", base: null, quote: null, label: null }, t)).toThrow(/no name/);
  });

  it("draws a series with no figures yet as a valueless row", () => {
    const row = pendingGlanceRow(RATES_CURRENCY_SERIES[0]!);
    expect(row).toMatchObject({ id: "usd_clp", value: null, changes: null, as_of_date: null });
    expect(formatMarketValue(row)).toBe("—");
  });

  it("keeps the page's stored view beside a surface's other fields", () => {
    expect(parseStoredSurfacePrefs('{"tab":"instruments","range":"3y"}')).toEqual({ tab: "instruments", range: "3y" });
    expect(parseStoredSurfacePrefs('{"tab":""}')).toEqual({});
  });
});
