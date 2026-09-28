import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CC_ORIGIN_CLP_RATE_TOLERANCE,
  ccLineOriginCurrency,
  ccOriginAmountCsvCell,
  parseCcOriginAmount,
} from "./ccOriginCurrency.js";
import { overrideFxDaily } from "./test/fxDailyFixture.js";

/** A day far past the synthetic fx history, so its on-or-before row is the fixture's own. */
const DAY = "2031-03-14";
const RATE = 950;

describe("ccLineOriginCurrency", () => {
  let restoreFx: () => void = () => {};
  beforeAll(() => {
    restoreFx = overrideFxDaily([[DAY, RATE]]);
  });
  afterAll(() => restoreFx());

  const label = (amountOrig: number | null, amountUsd: number | null, dateIso: string | null = DAY) =>
    ccLineOriginCurrency({ amountOrig, amountUsd, dateIso });

  it("labels an origin equal to the US$ to the cent as dollars, payments included", () => {
    expect(label(4.25, 4.25)).toBe("usd");
    // A payment prints its origin unsigned beside a negative US$.
    expect(label(30, -30)).toBe("usd");
    // No fx is read for it.
    expect(label(42.1, 42.1, null)).toBe("usd");
  });

  it("labels pesos when origin ÷ US$ is the day's rate within the tolerance", () => {
    expect(label(11_875, 12.5)).toBe("clp");
    const usd = 100;
    expect(label(RATE * (1 + CC_ORIGIN_CLP_RATE_TOLERANCE - 0.001) * usd, usd)).toBe("clp");
    expect(label(RATE * (1 - CC_ORIGIN_CLP_RATE_TOLERANCE + 0.001) * usd, usd)).toBe("clp");
    expect(label(RATE * (1 + CC_ORIGIN_CLP_RATE_TOLERANCE + 0.01) * usd, usd)).toBeNull();
  });

  it("widens the peso test by the US$'s rounding to the cent", () => {
    // 100 pesos billed as US$ 0,10: the implied rate is 1000 (5,3% off 950), and a true dollar
    // amount anywhere in 0,095-0,105 prints as 0,10.
    expect(label(100, 0.1)).toBe("clp");
    // The same implied rate on US$ 100 is no rounding: not pesos.
    expect(label(100_000, 100)).toBeNull();
  });

  it("leaves every other origin unlabeled — never a guess", () => {
    expect(label(150_000, 105)).toBeNull(); // 1428 per dollar (Argentine pesos)
    expect(label(600, 2.05)).toBeNull(); // 293 per dollar (forints)
    expect(label(17, 19.5)).toBeNull(); // euros
    expect(label(0, -30)).toBeNull(); // a 0,00 origin
    expect(label(null, 12.5)).toBeNull(); // no origin printed
    expect(label(11_875, null)).toBeNull(); // no US$ to compare (a peso statement line)
    expect(label(11_875, 0)).toBeNull();
  });

  it("refuses to decide the peso test without a date or an fx row", () => {
    expect(() => label(11_875, 12.5, null)).toThrow(/no date/);
    expect(() => label(11_875, 12.5, "1980-01-02")).toThrow(/No fx_daily row/);
  });
});

describe("origin amount CSV cell", () => {
  it("reads the printed Chilean text, empty as null", () => {
    expect(parseCcOriginAmount("18.250,00")).toBe(18_250);
    expect(parseCcOriginAmount("4,25")).toBe(4.25);
    expect(parseCcOriginAmount("-12,00")).toBe(-12);
    expect(parseCcOriginAmount(" ")).toBeNull();
    expect(() => parseCcOriginAmount("12,00 US$")).toThrow(/Unparseable Chilean-format/);
  });

  it("writes a numeric origin (statement JSON) in the same style", () => {
    expect(ccOriginAmountCsvCell(11_875)).toBe("11875,00");
    expect(ccOriginAmountCsvCell(-123.45)).toBe("-123,45");
    expect(parseCcOriginAmount(ccOriginAmountCsvCell(12.5))).toBe(12.5);
  });
});
