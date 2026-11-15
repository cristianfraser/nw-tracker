import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { storedPairRate } from "./rates.js";
import {
  cardLineAmountClpAtStoredRate,
  cardLineNativeAmount,
  debtCardLineAmountClp,
  debtFrameClp,
  debtFrameClpPerUnit,
  debtFrameRates,
} from "./ccExpenseAmountClp.js";

/** Rate days this file owns (far before any generated history), removed afterwards. */
const FX_DAY = "1998-03-10";
const NO_RATE_DAY = "1990-01-01";

beforeAll(() => {
  db.prepare(`INSERT INTO fx_daily (date, clp_per_usd) VALUES (?, 920)`).run(FX_DAY);
  db.prepare(`INSERT INTO eur_daily (date, clp_per_eur) VALUES (?, 1010)`).run(FX_DAY);
});

afterAll(() => {
  db.prepare(`DELETE FROM fx_daily WHERE date = ?`).run(FX_DAY);
  db.prepare(`DELETE FROM eur_daily WHERE date = ?`).run(FX_DAY);
});

describe("cardLineNativeAmount", () => {
  it("reads a cuota line's cuota and any other line's amount, in the line's currency", () => {
    expect(cardLineNativeAmount({ installment_flag: 1, amount: 881_134, currency: "clp", cuota_amount: 73_428 })).toEqual({
      amount: 73_428,
      currency: "clp",
    });
    expect(cardLineNativeAmount({ installment_flag: 0, amount: 4.53, currency: "usd", cuota_amount: null })).toEqual({
      amount: 4.53,
      currency: "usd",
    });
    expect(cardLineNativeAmount({ installment_flag: 0, amount: 12.5, currency: "eur", cuota_amount: null })).toEqual({
      amount: 12.5,
      currency: "eur",
    });
  });

  it("is null for a line that bills nothing", () => {
    expect(cardLineNativeAmount({ installment_flag: 0, amount: 0, currency: "usd", cuota_amount: null })).toBeNull();
    expect(cardLineNativeAmount({ installment_flag: 1, amount: 500, currency: "clp", cuota_amount: null })).toBeNull();
  });
});

describe("cardLineAmountClpAtStoredRate", () => {
  it("keeps a peso line's pesos", () => {
    expect(cardLineAmountClpAtStoredRate({ installment_flag: 0, amount: -394_140, currency: "clp", cuota_amount: null }, FX_DAY)).toBe(
      -394_140
    );
  });

  it("converts a dollar and a euro line at the stored close of the day", () => {
    expect(cardLineAmountClpAtStoredRate({ installment_flag: 0, amount: 68.29, currency: "usd", cuota_amount: null }, FX_DAY)).toBe(
      Math.round(68.29 * storedPairRate("usd", "clp", FX_DAY)!.mid)
    );
    expect(cardLineAmountClpAtStoredRate({ installment_flag: 1, amount: 50, currency: "eur", cuota_amount: 25 }, FX_DAY)).toBe(25_250);
  });

  it("is null when no rate is on file: a line that cannot be priced matches nothing", () => {
    expect(cardLineAmountClpAtStoredRate({ installment_flag: 0, amount: 10, currency: "usd", cuota_amount: null }, NO_RATE_DAY)).toBeNull();
  });
});

describe("the statement debt frame", () => {
  it("is one path for every currency: the stored close, or the stand-in rate of a split pass", () => {
    expect(debtFrameClpPerUnit("clp", null)).toBe(1);
    expect(debtFrameClpPerUnit("usd", FX_DAY)).toBe(920);
    expect(debtFrameClpPerUnit("eur", FX_DAY)).toBe(1010);
    const split = debtFrameRates([
      ["usd", 1000],
      ["eur", 1100],
    ]);
    expect(debtFrameClpPerUnit("usd", FX_DAY, split)).toBe(1000);
    expect(debtFrameClpPerUnit("eur", NO_RATE_DAY, split)).toBe(1100);
    expect(debtFrameClpPerUnit("usd", NO_RATE_DAY)).toBeNull();
  });

  it("values zero as zero and throws on an amount with no rate", () => {
    expect(debtFrameClp(0, "eur", NO_RATE_DAY, undefined, "test amount")).toBe(0);
    expect(debtFrameClp(10, "eur", FX_DAY, undefined, "test amount")).toBe(10_100);
    expect(() => debtFrameClp(10, "eur", NO_RATE_DAY, undefined, "test amount")).toThrow(/test amount: no EUR\/CLP rate/);
    expect(() => debtFrameClp(10, "usd", null, undefined, "test amount")).toThrow(/no USD\/CLP rate/);
  });

  it("a debt sum's line is null only when it bills nothing; a foreign line with no rate throws", () => {
    const line = (amount: number, currency: string) => ({ installment_flag: 0, amount, currency, cuota_amount: null });
    expect(debtCardLineAmountClp(line(0, "usd"), NO_RATE_DAY, undefined, "test line")).toBeNull();
    expect(debtCardLineAmountClp(line(1500, "clp"), NO_RATE_DAY, undefined, "test line")).toBe(1500);
    expect(debtCardLineAmountClp(line(-2, "usd"), FX_DAY, undefined, "test line")).toBe(-1840);
    expect(() => debtCardLineAmountClp(line(3, "eur"), NO_RATE_DAY, undefined, "test line")).toThrow(/test line/);
  });
});
