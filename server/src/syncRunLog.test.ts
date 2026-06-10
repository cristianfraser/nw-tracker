import { describe, expect, it } from "vitest";
import {
  formatSyncClp,
  formatSyncFxRate,
  formatSyncIndex,
  formatSyncLogBody,
  formatSyncUsdClose,
  formatSyncUfRate,
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
    expect(body).toContain("2026-06-04 28.824.791 > 2026-06-05 28.735.067");
  });
});
