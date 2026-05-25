import { describe, expect, it } from "vitest";
import {
  isCcStatementPdfSource,
  matrixMonthForCartolaPeriodMonth,
  matrixMonthForCcStatement,
  matrixMonthFromCcPeriodTo,
} from "./importSyncDocumentMonth.js";

describe("importSyncDocumentMonth", () => {
  it("uses period_to month for CC PDF statements", () => {
    expect(matrixMonthFromCcPeriodTo("20/04/2026")).toBe("2026-04");
    expect(matrixMonthFromCcPeriodTo("2026-04-20")).toBe("2026-04");
    expect(
      matrixMonthForCcStatement({
        period_to: "22/04/2026",
        source_pdf: "2026-03-22 estado de cuenta tarjeta 4242.pdf",
      })
    ).toBe("2026-04");
  });

  it("returns null when period_to is missing (no fallbacks)", () => {
    expect(
      matrixMonthForCcStatement({
        period_to: null,
        source_pdf: "2025-05-22 estado de cuenta tarjeta 4242.pdf",
      })
    ).toBeNull();
  });

  it("ignores web-paste manual buckets for document coverage", () => {
    expect(isCcStatementPdfSource("import:web-paste|open|2026-05")).toBe(false);
    expect(
      matrixMonthForCcStatement({
        period_to: "20/05/2026",
        source_pdf: "import:web-paste|open|2026-05",
      })
    ).toBeNull();
  });

  it("uses period_month for cartola", () => {
    expect(matrixMonthForCartolaPeriodMonth("2026-04")).toBe("2026-04");
  });
});
