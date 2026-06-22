import { describe, expect, it } from "vitest";
import {
  formatSyncClp,
  formatSyncFxRate,
  formatSyncIndex,
  formatSyncLogBody,
  formatSyncUsdClose,
  formatSyncUfRate,
  equityEodSyncFieldChange,
  type SyncFieldChange,
} from "./syncRunLog.js";

describe("syncRunLog formatters", () => {
  it("formatSyncClp uses es-CL thousands", () => {
    expect(formatSyncClp(28_824_791)).toBe("28.824.791");
    expect(formatSyncClp(28824791)).toBe("28.824.791");
  });

  it("formatSyncFxRate uses es-CL decimals", () => {
    expect(formatSyncFxRate(981.59)).toBe("981,59");
  });

  it("formatSyncUfRate uses es-CL decimals", () => {
    expect(formatSyncUfRate(39123.456)).toBe("39.123,46");
  });

  it("formatSyncUsdClose uses es-CL decimals", () => {
    expect(formatSyncUsdClose(733.73)).toBe("733,73");
    expect(formatSyncUsdClose(105420.5)).toBe("105.420,50");
  });

  it("formatSyncIndex trims trailing zeros", () => {
    expect(formatSyncIndex(142.35)).toBe("142,35");
  });
});

describe("formatSyncLogBody", () => {
  it("renders AFP change lines with formatted CLP", () => {
    const changes: SyncFieldChange[] = [
      {
        group: "afp",
        label: "AFP UNO",
        oldValue: formatSyncClp(28_824_791),
        newValue: formatSyncClp(28_735_067),
        oldDate: "2026-06-04",
        newDate: "2026-06-05",
      },
    ];
    const body = formatSyncLogBody(["afp_uno"], changes);
    expect(body).toContain("Stale: afp_uno");
    expect(body).toContain("2026-06-04 28.824.791 > 2026-06-05 28.735.067 (-89.724)");
  });

  it("appends signed delta for FX and USD closes", () => {
    const changes: SyncFieldChange[] = [
      {
        group: "sbif_usd",
        label: "BCentral USD",
        oldValue: formatSyncFxRate(981.59),
        newValue: formatSyncFxRate(982.14),
        oldDate: "2026-05-18",
        newDate: "2026-05-19",
      },
      {
        group: "stocks_nyse",
        label: "SPY",
        oldValue: formatSyncUsdClose(733.73),
        newValue: formatSyncUsdClose(735.12),
        oldDate: "2026-05-16",
        newDate: "2026-05-19",
      },
    ];
    const body = formatSyncLogBody([], changes);
    expect(body).toContain("(+0,55)");
    expect(body).toContain("(+1,39)");
  });

  it("omits delta when old value is missing", () => {
    const changes: SyncFieldChange[] = [
      {
        group: "sbif_utm",
        label: "BCentral UTM",
        oldValue: "—",
        newValue: formatSyncClp(65_432),
        oldDate: null,
        newDate: "2026-05-01",
      },
    ];
    const body = formatSyncLogBody([], changes);
    expect(body).not.toMatch(/\([+-]/);
  });
});

describe("equityEodSyncFieldChange", () => {
  it("logs when trade date advances even if close is unchanged", () => {
    const close = 600;
    const change = equityEodSyncFieldChange(
      "stocks_nyse",
      "SPY",
      { trade_date: "2026-06-16", close_usd: close },
      { trade_date: "2026-06-17", close_usd: close }
    );
    expect(change).not.toBeNull();
    expect(change?.oldDate).toBe("2026-06-16");
    expect(change?.newDate).toBe("2026-06-17");
  });

  it("returns null when date and close are unchanged", () => {
    const row = { trade_date: "2026-06-17", close_usd: 605.25 };
    expect(equityEodSyncFieldChange("stocks_nyse", "SPY", row, row)).toBeNull();
  });
});
