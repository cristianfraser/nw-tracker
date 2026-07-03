import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  formatClp,
  formatClpUfDay,
  formatCcExpenseLineAmount,
  formatGroupedDecimal,
  formatUsd,
  formatUsdFine,
  setDecimalSeparatorForFormatting,
  titleBalanceDeltaNumberFlowParts,
} from "./format";

// Formatting follows the decimal-separator preference (seeded from the machine
// timezone at module load) — pin it so tests don't depend on where they run.
beforeEach(() => setDecimalSeparatorForFormatting("comma"));
afterEach(() => setDecimalSeparatorForFormatting("comma"));

describe("formatClp", () => {
  it("formats negatives with accounting parentheses", () => {
    expect(formatClp(-1234)).toBe("($1.234)");
  });

  it("returns em dash for non-finite values", () => {
    expect(formatClp(Number.NaN)).toBe("—");
  });
});

describe("formatClpUfDay", () => {
  it("shows CLP per UF with exactly two decimals", () => {
    expect(formatClpUfDay(40_763.45)).toBe("$40.763,45");
    expect(formatClpUfDay(40_273.69)).toBe("$40.273,69");
  });

  it("returns em dash for null", () => {
    expect(formatClpUfDay(null)).toBe("—");
  });
});

describe("decimal-separator preference applies to every currency", () => {
  it("comma preference formats USD with comma decimals too", () => {
    expect(formatUsd(123_456)).toBe("US$123.456");
    expect(formatUsdFine(1_234.56)).toBe("US$1.234,56");
  });

  it("period preference formats CLP and UF with period decimals too", () => {
    setDecimalSeparatorForFormatting("period");
    expect(formatClp(-1234)).toBe("($1,234)");
    expect(formatClp(95_817_344)).toBe("$95,817,344");
    expect(formatClpUfDay(40_763.45)).toBe("$40,763.45");
    expect(formatUsdFine(1_234.56)).toBe("US$1,234.56");
    expect(formatGroupedDecimal(1_234.5, 2)).toBe("1,234.50");
  });
});

describe("titleBalanceDeltaNumberFlowParts", () => {
  it("uses + prefix for gains and parentheses for losses", () => {
    expect(titleBalanceDeltaNumberFlowParts(4_822_484, "clp", "$").prefix).toBe("+$");
    expect(titleBalanceDeltaNumberFlowParts(-100, "clp", "$").prefix).toBe("($");
    expect(titleBalanceDeltaNumberFlowParts(-100, "clp", "$").suffix).toBe(")");
  });

  it("locales follow the separator preference", () => {
    expect(titleBalanceDeltaNumberFlowParts(100, "clp", "$").locales).toBe("es-CL");
    setDecimalSeparatorForFormatting("period");
    expect(titleBalanceDeltaNumberFlowParts(100, "clp", "$").locales).toBe("en-US");
  });
});

describe("formatCcExpenseLineAmount", () => {
  it("shows CLP with optional USD parenthetical", () => {
    expect(formatCcExpenseLineAmount(50_000, 60)).toContain("50");
    expect(formatCcExpenseLineAmount(50_000, 60)).toContain("60");
  });
});
