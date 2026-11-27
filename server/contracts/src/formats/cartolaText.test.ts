import { describe, expect, it } from "vitest";
import { readCaseFile } from "./caseFile.js";
import { cartolaText, isCartolaText } from "./cartolaText.js";

describe("cartola text (shared case table)", () => {
  const { cases } = readCaseFile<{ cases: { why: string; raw: string; text: string }[] }>("cartolaTextCases.json");
  it.each(cases)("$why", (c) => {
    expect(cartolaText(c.raw)).toBe(c.text);
    expect(isCartolaText(c.text)).toBe(true);
  });
});
