import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseDdMmYyToIso } from "./ccInstallmentPayBy.js";

type DateCase = { raw: string; expect: string | null; note?: string };

const casesPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "test",
  "ddMmYyToIsoCases.json"
);
const cases = JSON.parse(fs.readFileSync(casesPath, "utf-8")) as DateCase[];

/**
 * The Python parsers read dates through `parse_dd_mm_yy_to_iso` (`ingest/python/statement_values.py`),
 * which mirrors this function; `ingest/python/statement_values_test.py` asserts the same table.
 */
describe("parseDdMmYyToIso (shared case table)", () => {
  it.each(cases)("«$raw» → $expect", (c) => {
    expect(parseDdMmYyToIso(c.raw)).toBe(c.expect);
  });
});
