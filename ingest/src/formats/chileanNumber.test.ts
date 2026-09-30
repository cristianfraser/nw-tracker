import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseChileanNumber } from "./chileanNumber.js";

/** The server's copy reads the same table (`server/src/chileanDecimalCases.test.ts`): the two cannot drift. */
const cases = JSON.parse(
  fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../server/src/test/chileanDecimalCases.json"),
    "utf-8"
  )
) as { raw: string; expect: number | null }[];

describe("parseChileanNumber (the server's case table)", () => {
  it.each(cases)("«$raw» → $expect", (c) => {
    if (c.expect == null) expect(() => parseChileanNumber(c.raw)).toThrow(/Unparseable Chilean-format/);
    else expect(parseChileanNumber(c.raw)).toBe(c.expect);
  });
});
