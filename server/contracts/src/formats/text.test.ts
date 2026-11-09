import { describe, expect, it } from "vitest";
import { readCaseFile } from "./caseFile.js";
import { collapseSpaces, decodeHtmlEntities, foldAccents, foldUpper } from "./text.js";
import { isWebPasteCutOf, normalizeMerchantText, stripBciTerminalSuffix } from "./merchant.js";
import { normalizeAccountNumber, normalizeCheckDigitId, normalizeRut, rutDigitsWithoutVerifier } from "./identifiers.js";

describe("accent folding (shared case table)", () => {
  const cases = readCaseFile<{ raw: string; fold: string; upper: string }[]>("textFoldCases.json");
  it.each(cases)("«$raw»", (c) => {
    expect(foldAccents(c.raw)).toBe(c.fold);
    expect(foldUpper(c.raw)).toBe(c.upper);
  });

  it("collapses spaces", () => {
    expect(collapseSpaces("  a \t b\n")).toBe("a b");
  });
});

describe("HTML entities", () => {
  it("decodes named and numeric references and leaves unknown names", () => {
    expect(decodeHtmlEntities("4x&nbsp;&amp;&#241;&#xF1;&bogus;")).toBe("4x &ññ&bogus;");
  });
});

describe("merchant text (shared case table)", () => {
  const cases = readCaseFile<{ raw: string; normalized: string; bci: string }[]>("merchantTextCases.json");
  it.each(cases)("«$raw»", (c) => {
    expect(normalizeMerchantText(c.raw)).toBe(c.normalized);
    expect(stripBciTerminalSuffix(c.raw)).toBe(c.bci);
  });

  it("recognises the web listing's cut", () => {
    expect(isWebPasteCutOf("MERPAGO*PLANOUT", "MERPAGO*PLANOUTCANALDEVEN")).toBe(true);
    expect(isWebPasteCutOf("MERPAGO*PLANOU", "MERPAGO*PLANOUTCANALDEVEN")).toBe(false);
    expect(isWebPasteCutOf("MERPAGO*PLANOUT", "MERPAGO*PLANOUT")).toBe(false);
  });
});

describe("identifiers (shared case table)", () => {
  type C = { raw: string; expect: string | null };
  const cases = readCaseFile<Record<"rut" | "rutDigits" | "accountNumber" | "checkDigitId", C[]>>("identifierCases.json");
  it.each(cases.rut)("RUT «$raw» → $expect", (c) => expect(normalizeRut(c.raw)).toBe(c.expect));
  it.each(cases.rutDigits)("RUT digits «$raw» → $expect", (c) => {
    if (c.expect === null) expect(() => rutDigitsWithoutVerifier(c.raw)).toThrow(/Not a RUT/);
    else expect(rutDigitsWithoutVerifier(c.raw)).toBe(c.expect);
  });
  it.each(cases.accountNumber)("account «$raw» → $expect", (c) => expect(normalizeAccountNumber(c.raw)).toBe(c.expect));
  it.each(cases.checkDigitId)("check-digit id «$raw» → $expect", (c) => expect(normalizeCheckDigitId(c.raw)).toBe(c.expect));
});
