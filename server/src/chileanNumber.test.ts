import { describe, expect, it } from "vitest";
import {
  isChileanNumber,
  parseChileanNumber,
  parseOptionalChileanInteger,
  parseUsNumber,
} from "./chileanNumber.js";

describe("number styles", () => {
  it("reads «1.234» by the style the source declares", () => {
    expect(parseChileanNumber("1.234")).toBe(1234);
    expect(parseUsNumber("1.234")).toBe(1.234);
  });

  it("reads Chilean thousands and decimals, with or without grouping", () => {
    expect(parseChileanNumber("1.346,17")).toBe(1346.17);
    expect(parseChileanNumber("1346,17")).toBe(1346.17);
    expect(parseChileanNumber("3.000.000")).toBe(3_000_000);
    expect(parseChileanNumber("-392,00")).toBe(-392);
  });

  it("reads US thousands and decimals", () => {
    expect(parseUsNumber("1,346.17")).toBe(1346.17);
    expect(parseUsNumber("54.41")).toBe(54.41);
  });

  it("throws on text that is not a number in the style", () => {
    expect(() => parseChileanNumber("")).toThrow(/Unparseable Chilean-format/);
    expect(() => parseChileanNumber("1,346.17")).toThrow(/Unparseable Chilean-format/);
    expect(() => parseUsNumber("1.346,17")).toThrow(/Unparseable US-format/);
    expect(isChileanNumber("1.346,17")).toBe(true);
    expect(isChileanNumber("SALDO")).toBe(false);
    expect(isChileanNumber("")).toBe(false);
  });
});

describe("parseOptionalChileanInteger", () => {
  it("is null for an empty cell and truncates a number toward zero", () => {
    expect(parseOptionalChileanInteger("")).toBeNull();
    expect(parseOptionalChileanInteger("  ")).toBeNull();
    expect(parseOptionalChileanInteger("1178")).toBe(1178);
    expect(parseOptionalChileanInteger("-392,00")).toBe(-392);
    expect(parseOptionalChileanInteger("10,71")).toBe(10);
  });

  it("throws on text that is not a number", () => {
    expect(() => parseOptionalChileanInteger("x")).toThrow(/Unparseable Chilean-format/);
  });
});
