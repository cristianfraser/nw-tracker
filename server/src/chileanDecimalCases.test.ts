import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseChileanNumber } from "./chileanNumber.js";

type DecimalCase = { raw: string; expect: number | null; note?: string };

const casesPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "test",
  "chileanDecimalCases.json"
);
const cases = JSON.parse(fs.readFileSync(casesPath, "utf-8")) as DecimalCase[];

/**
 * The card parser reads the printed origin amount through `parse_chilean_decimal`
 * (`server/scripts/statement_values.py`) and the import reads the same CSV text with this function;
 * `server/scripts/statement_values_test.py` asserts the same table. (The Python reader is stricter
 * about grouping — «12.34» is no amount there — so the table holds only text both read alike.)
 */
describe("parseChileanNumber (shared case table)", () => {
  it.each(cases)("«$raw» → $expect", (c) => {
    if (c.expect == null) expect(() => parseChileanNumber(c.raw)).toThrow(/Unparseable Chilean-format/);
    else expect(parseChileanNumber(c.raw)).toBe(c.expect);
  });
});
