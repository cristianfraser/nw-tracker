import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { cartolaMovementDateIso } from "./cartolaMovementDate.js";

type YearCase = {
  desde: string | null;
  hasta: string | null;
  day: number;
  month: number;
  /** null: the rule must throw. */
  expect: string | null;
  reason?: string;
};

/** Shared with the Python cartola parsers, which assert the same file. */
const cases = JSON.parse(
  fs.readFileSync(new URL("../../../server/src/test/cartolaMovementYearCases.json", import.meta.url), "utf8")
) as YearCase[];

describe("cartolaMovementDateIso", () => {
  it.each(cases)("$day/$month in $desde..$hasta → $expect", (c) => {
    const resolve = () => cartolaMovementDateIso(c.day, c.month, { desde: c.desde, hasta: c.hasta });
    if (c.expect === null) expect(resolve).toThrow();
    else expect(resolve()).toBe(c.expect);
  });

  it("says why it could not date a row, and which row", () => {
    expect(() =>
      cartolaMovementDateIso(31, 12, { desde: "2026-01-01", hasta: "2026-01-31" }, "cartola.xlsx row 12")
    ).toThrow("cartola.xlsx row 12: cartola movement 31/12 is not a date inside the period 2026-01-01..2026-01-31");
    expect(() => cartolaMovementDateIso(30, 10, { desde: "2016-10-28", hasta: "2017-10-31" })).toThrow(
      "is ambiguous: 2016-10-30 and 2017-10-30 are inside the period"
    );
    expect(() => cartolaMovementDateIso(15, 8, { desde: "2026-08-01", hasta: null })).toThrow(
      "the period end (HASTA) is missing"
    );
  });
});
