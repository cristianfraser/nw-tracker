import { describe, expect, it } from "vitest";
import { parseBcentralNumber } from "./bcentralApi.js";

describe("parseBcentralNumber", () => {
  it("parses Chilean thousands and comma decimal", () => {
    expect(parseBcentralNumber("1.234,56")).toBe(1234.56);
    expect(parseBcentralNumber("899,68")).toBe(899.68);
  });

  it("parses dot decimal (BCentral USD observado)", () => {
    expect(parseBcentralNumber("899.68")).toBe(899.68);
    expect(parseBcentralNumber("907.51")).toBe(907.51);
  });

  it("parses Chilean thousands without decimal comma", () => {
    expect(parseBcentralNumber("39.123")).toBe(39123);
  });

  it("parses plain integers", () => {
    expect(parseBcentralNumber("891")).toBe(891);
  });
});
