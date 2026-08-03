import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  adaptiveUsdAccountingNumberFlowParts,
  adaptiveUsdFractionDigits,
  formatClp,
  formatClpUfDay,
  formatCompactMoney,
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

describe("formatCompactMoney", () => {
  it("drops the currency qualifier — USD and CLP both read as a bare symbol", () => {
    expect(formatCompactMoney(10_000_000, "clp")).toBe("$10M");
    expect(formatCompactMoney(10_000_000, "usd")).toBe("$10M");
    expect(formatCompactMoney(350_000, "usd")).toBe("$350k");
    // The full `US$` form must never leak back in for a space-constrained surface.
    expect(formatCompactMoney(350_000, "usd")).not.toContain("US$");
  });

  it("switches k → M at a million and stays in M above a billion", () => {
    expect(formatCompactMoney(999, "clp")).toBe("$999");
    expect(formatCompactMoney(1_000, "clp")).toBe("$1k");
    expect(formatCompactMoney(999_999, "clp")).toBe("$1M");
    expect(formatCompactMoney(1_000_000, "clp")).toBe("$1M");
    // One suffix per magnitude: `MM` next to `M` reads as a typo at axis size.
    expect(formatCompactMoney(1_400_000_000, "clp")).toBe("$1.400M");
  });

  it("carries one decimal below 100 and none above, trailing zeros trimmed", () => {
    expect(formatCompactMoney(2_500_000, "clp")).toBe("$2,5M");
    expect(formatCompactMoney(2_000_000, "clp")).toBe("$2M");
    expect(formatCompactMoney(95_817_344, "clp")).toBe("$95,8M");
    expect(formatCompactMoney(248_000_000, "clp")).toBe("$248M");
    expect(formatCompactMoney(1_500, "clp")).toBe("$1,5k");
  });

  it("follows the separator preference", () => {
    setDecimalSeparatorForFormatting("period");
    expect(formatCompactMoney(2_500_000, "clp")).toBe("$2.5M");
    expect(formatCompactMoney(1_400_000_000, "clp")).toBe("$1,400M");
  });

  it("keeps accounting parentheses for negatives and an em dash for non-finite", () => {
    expect(formatCompactMoney(-5_000_000, "clp")).toBe("($5M)");
    expect(formatCompactMoney(-350_000, "usd")).toBe("($350k)");
    expect(formatCompactMoney(0, "clp")).toBe("$0");
    expect(formatCompactMoney(Number.NaN, "clp")).toBe("—");
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
    const small = adaptiveUsdAccountingNumberFlowParts(4.567, "bare");
    expect(small.value).toBe(4.57);
    expect(small.format.maximumFractionDigits).toBe(2);
    expect(small.format.minimumFractionDigits).toBe(0);
    expect(small.prefix).toBe("$");

    const mid = adaptiveUsdAccountingNumberFlowParts(-54.327, "bare");
    expect(mid.value).toBe(54.33);
    expect(mid.format.maximumFractionDigits).toBe(2);
    expect(mid.prefix).toBe("($");
    expect(mid.suffix).toBe(")");

    const trimmed = adaptiveUsdAccountingNumberFlowParts(55.004, "bare");
    expect(trimmed.value).toBe(55);
    expect(trimmed.format.minimumFractionDigits).toBe(0);

    const big = adaptiveUsdAccountingNumberFlowParts(4478.4, "bare");
    expect(big.value).toBe(4478);
    expect(big.format.maximumFractionDigits).toBe(0);
  });

  it("fixed fraction digits pin sub-balance decimals (no trimming)", () => {
    const padded = adaptiveUsdAccountingNumberFlowParts(55.004, "bare", 2);
    expect(padded.value).toBe(55);
    expect(padded.format.minimumFractionDigits).toBe(2);
    expect(padded.format.maximumFractionDigits).toBe(2);

    // Fixed digits override the magnitude band (large sibling aligned to a small one).
    const large = adaptiveUsdAccountingNumberFlowParts(16512.345, "bare", 2);
    expect(large.value).toBe(16512.35);
    expect(large.format.minimumFractionDigits).toBe(2);

    const whole = adaptiveUsdAccountingNumberFlowParts(-42.518, "bare", 0);
    expect(whole.value).toBe(43);
    expect(whole.prefix).toBe("($");
    expect(whole.format.maximumFractionDigits).toBe(0);
  });

  it("negatives that round to zero lose the accounting parentheses", () => {
    const parts = adaptiveUsdAccountingNumberFlowParts(-0.004, "bare");
    expect(parts.value).toBe(0);
    expect(parts.prefix).toBe("$");
    expect(parts.suffix).toBe("");
  });
});

describe("titleBalanceDeltaNumberFlowParts", () => {
  it("uses + prefix for gains and parentheses for losses", () => {
    expect(titleBalanceDeltaNumberFlowParts(4_822_484, "clp", "bare").prefix).toBe("+$");
    expect(titleBalanceDeltaNumberFlowParts(-100, "clp", "bare").prefix).toBe("($");
    expect(titleBalanceDeltaNumberFlowParts(-100, "clp", "bare").suffix).toBe(")");
  });

  it("locales follow the separator preference", () => {
    expect(titleBalanceDeltaNumberFlowParts(100, "clp", "bare").locales).toBe("es-CL");
    setDecimalSeparatorForFormatting("period");
    expect(titleBalanceDeltaNumberFlowParts(100, "clp", "bare").locales).toBe("en-US");
  });
});

describe("formatCcExpenseLineAmount", () => {
  it("shows CLP with optional USD parenthetical", () => {
    expect(formatCcExpenseLineAmount(50_000, 60)).toContain("50");
    expect(formatCcExpenseLineAmount(50_000, 60)).toContain("60");
  });
});
