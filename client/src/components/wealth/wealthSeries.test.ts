import { describe, expect, it } from "vitest";
import { percentileLabelBelowThreshold } from "./wealthSeries";

/** Digits only, so the assertion holds for either decimal separator. */
const digits = (label: string) => label.replace(/[^0-9p]/g, "");

describe("percentileLabelBelowThreshold", () => {
  it("rounds to one decimal like the rest of the page", () => {
    expect(digits(percentileLabelBelowThreshold(96.69))).toBe("p967");
    expect(digits(percentileLabelBelowThreshold(62.04))).toBe("p620");
  });

  it("never lifts a percentile onto a threshold it is under", () => {
    expect(digits(percentileLabelBelowThreshold(89.96))).toBe("p899");
    expect(digits(percentileLabelBelowThreshold(49.99))).toBe("p499");
    expect(digits(percentileLabelBelowThreshold(98.96))).toBe("p989");
    // At or over the threshold it reads as the threshold.
    expect(digits(percentileLabelBelowThreshold(90))).toBe("p900");
  });

  it("shows two decimals, truncated, above p99", () => {
    expect(digits(percentileLabelBelowThreshold(99.967))).toBe("p9996");
    expect(digits(percentileLabelBelowThreshold(99))).toBe("p9900");
  });
});
