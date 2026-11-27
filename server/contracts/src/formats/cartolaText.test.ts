import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readCaseFile } from "./caseFile.js";
import { cartolaText, isCartolaText } from "./cartolaText.js";

type CaseFile = {
  cases: { why: string; raw: string; text: string }[];
  property: { seed: number; count: number; length: number; alphabet: string; sha256: string };
};
const file = readCaseFile<CaseFile>("cartolaTextCases.json");

/** The case file's generated strings (its LCG, in exact integers). */
function generated(p: CaseFile["property"]): string[] {
  const alphabet = [...p.alphabet];
  let state = BigInt(p.seed);
  const out: string[] = [];
  for (let i = 0; i < p.count; i++) {
    let s = "";
    for (let k = 0; k < p.length; k++) {
      state = (state * 1103515245n + 12345n) % 2147483648n;
      s += alphabet[Number(state % BigInt(alphabet.length))];
    }
    out.push(s);
  }
  return out;
}

describe("cartola text (shared case table)", () => {
  it.each(file.cases)("$why", (c) => {
    expect(cartolaText(c.raw)).toBe(c.text);
    expect(isCartolaText(c.text)).toBe(true);
  });

  it("is idempotent over the generated strings, and reads them as the Python side does", () => {
    const readings = generated(file.property).map(cartolaText);
    for (const r of readings) expect(cartolaText(r)).toBe(r);
    expect(createHash("sha256").update(readings.join("\n"), "utf8").digest("hex")).toBe(file.property.sha256);
  });
});
