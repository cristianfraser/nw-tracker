import { describe, expect, it } from "vitest";
import { readCaseFile } from "./caseFile.js";
import {
  hasAtMostCents,
  isChileanNumber,
  parseChileanInteger,
  parseChileanNumber,
  parseOptionalChileanInteger,
  parseUsNumber,
  toCents,
} from "./numbers.js";

/**
 * Python's `parse_chilean_decimal` (`ingest/python/statement_values.py`) asserts the same table. (The
 * Python reader is stricter about grouping — «12.34» is no amount there — so the table holds only
 * text both read alike.)
 */
describe("parseChileanNumber (shared case table)", () => {
  const cases = readCaseFile<{ raw: string; expect: number | null }[]>("chileanDecimalCases.json");
  it.each(cases)("«$raw» → $expect", (c) => {
    if (c.expect == null) expect(() => parseChileanNumber(c.raw)).toThrow(/Unparseable Chilean-format/);
    else expect(parseChileanNumber(c.raw)).toBe(c.expect);
  });
});

describe("number styles", () => {
  it("reads «1.234» by the style the source declares", () => {
    expect(parseChileanNumber("1.234")).toBe(1234);
    expect(parseUsNumber("1.234")).toBe(1.234);
  });

  it("reads US thousands and decimals and throws on the other style", () => {
    expect(parseUsNumber("1,346.17")).toBe(1346.17);
    expect(parseUsNumber("54.41")).toBe(54.41);
    expect(() => parseUsNumber("1.346,17")).toThrow(/Unparseable US-format/);
  });

  it("tells a number cell from text", () => {
    expect(isChileanNumber("1.346,17")).toBe(true);
    expect(isChileanNumber("SALDO")).toBe(false);
    expect(isChileanNumber("")).toBe(false);
  });
});

describe("integer variants", () => {
  it("parseOptionalChileanInteger: null for an empty cell, truncates toward zero, throws on text", () => {
    expect(parseOptionalChileanInteger("  ")).toBeNull();
    expect(parseOptionalChileanInteger("1178")).toBe(1178);
    expect(parseOptionalChileanInteger("-392,00")).toBe(-392);
    expect(parseOptionalChileanInteger("10,71")).toBe(10);
    expect(() => parseOptionalChileanInteger("x")).toThrow(/Unparseable Chilean-format/);
  });

  it("parseChileanInteger refuses a decimal part", () => {
    expect(parseChileanInteger("1.234")).toBe(1234);
    expect(parseChileanInteger("-392,00")).toBe(-392);
    expect(() => parseChileanInteger("10,71")).toThrow(/whole/);
  });
});

describe("cents", () => {
  it("accepts amounts whose binary value is a hair off two decimals", () => {
    expect(hasAtMostCents(1.17)).toBe(true);
    expect(hasAtMostCents(0.29)).toBe(true);
    expect(hasAtMostCents(13.775)).toBe(false);
    expect(hasAtMostCents(Number.NaN)).toBe(false);
    expect(toCents(1.17)).toBe(117);
  });
});
