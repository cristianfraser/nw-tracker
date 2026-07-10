import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  adaptiveUsdAccountingNumberFlowParts,
  adaptiveUsdFractionDigits,
  formatClp,
  formatClpUfDay,
  formatCcExpenseLineAmount,
  formatGroupedDecimal,
  formatPct,
  formatUsd,
  formatUsdFine,
  minAdaptiveUsdFractionDigits,
  roundUsdAdaptive,
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

describe("formatPct", () => {
  it("follows the active separator convention", () => {
    setDecimalSeparatorForFormatting("comma");
    expect(formatPct(12.345)).toBe("12,35%");
    expect(formatPct(-3.2, 1)).toBe("-3,2%");
    setDecimalSeparatorForFormatting("period");
    expect(formatPct(12.345)).toBe("12.35%");
  });

  it("returns em dash for null and non-finite values", () => {
    expect(formatPct(null)).toBe("—");
    expect(formatPct(Number.NaN)).toBe("—");
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

describe("adaptive USD decimals (summary-card balances / deltas)", () => {
  it("keeps ≥4 significant digits capped at cents", () => {
    expect(adaptiveUsdFractionDigits(4.56)).toBe(2);
    expect(adaptiveUsdFractionDigits(54.3)).toBe(2);
    expect(adaptiveUsdFractionDigits(100)).toBe(1);
    expect(adaptiveUsdFractionDigits(772.4)).toBe(1);
    expect(adaptiveUsdFractionDigits(1000)).toBe(0);
    expect(adaptiveUsdFractionDigits(4478)).toBe(0);
  });

  it("rounds to the adaptive precision", () => {
    expect(roundUsdAdaptive(4.567)).toBe(4.57);
    expect(roundUsdAdaptive(-54.327)).toBe(-54.33);
    expect(roundUsdAdaptive(772.44)).toBe(772.4);
    expect(roundUsdAdaptive(4478.4)).toBe(4478);
  });

  it("group digits are the least adaptive decimals — largest amount wins", () => {
    expect(minAdaptiveUsdFractionDigits([42.41, 2.48])).toBe(2);
    expect(minAdaptiveUsdFractionDigits([425.03, -147.82])).toBe(1);
    expect(minAdaptiveUsdFractionDigits([16512.34, 122.29, 4.96])).toBe(0);
    expect(minAdaptiveUsdFractionDigits([159.78, null, 4.96])).toBe(1);
    expect(minAdaptiveUsdFractionDigits([null, undefined])).toBe(0);
  });

  it("number-flow parts carry the adaptive fraction digits, min 0 for trimming", () => {
    const small = adaptiveUsdAccountingNumberFlowParts(4.567, "$");
    expect(small.value).toBe(4.57);
    expect(small.format.maximumFractionDigits).toBe(2);
    expect(small.format.minimumFractionDigits).toBe(0);
    expect(small.prefix).toBe("$");

    const mid = adaptiveUsdAccountingNumberFlowParts(-54.327, "$");
    expect(mid.value).toBe(54.33);
    expect(mid.format.maximumFractionDigits).toBe(2);
    expect(mid.prefix).toBe("($");
    expect(mid.suffix).toBe(")");

    const trimmed = adaptiveUsdAccountingNumberFlowParts(55.004, "$");
    expect(trimmed.value).toBe(55);
    expect(trimmed.format.minimumFractionDigits).toBe(0);

    const big = adaptiveUsdAccountingNumberFlowParts(4478.4, "$");
    expect(big.value).toBe(4478);
    expect(big.format.maximumFractionDigits).toBe(0);
  });

  it("fixed fraction digits pin sub-balance decimals (no trimming)", () => {
    const padded = adaptiveUsdAccountingNumberFlowParts(55.004, "$", 2);
    expect(padded.value).toBe(55);
    expect(padded.format.minimumFractionDigits).toBe(2);
    expect(padded.format.maximumFractionDigits).toBe(2);

    // Fixed digits override the magnitude band (large sibling aligned to a small one).
    const large = adaptiveUsdAccountingNumberFlowParts(16512.345, "$", 2);
    expect(large.value).toBe(16512.35);
    expect(large.format.minimumFractionDigits).toBe(2);

    const whole = adaptiveUsdAccountingNumberFlowParts(-42.518, "$", 0);
    expect(whole.value).toBe(43);
    expect(whole.prefix).toBe("($");
    expect(whole.format.maximumFractionDigits).toBe(0);
  });

  it("negatives that round to zero lose the accounting parentheses", () => {
    const parts = adaptiveUsdAccountingNumberFlowParts(-0.004, "$");
    expect(parts.value).toBe(0);
    expect(parts.prefix).toBe("$");
    expect(parts.suffix).toBe("");
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
