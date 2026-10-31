import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEMO_AFP_MODELO_CSV_PATH, parseDemoAfpModeloCsv } from "./demoRealMarket.js";

const HEADER = "afp;fund;day;unit_value_clp";

describe("demo Modelo fund A snapshot", () => {
  it("reads rows with dot decimals", () => {
    const rows = parseDemoAfpModeloCsv(`${HEADER}\nmodelo;A;2019-12-31;100.5\r\nmodelo;A;2020-01-01;101\n`);
    expect(rows).toEqual([
      { afp: "modelo", fund: "A", day: "2019-12-31", unit_value_clp: 100.5, provisional: false },
      { afp: "modelo", fund: "A", day: "2020-01-01", unit_value_clp: 101, provisional: false },
    ]);
  });

  it("throws on another header, AFP or fund, a skipped or repeated day, or a bad value", () => {
    expect(() => parseDemoAfpModeloCsv("day;value\n2020-01-01;1")).toThrow(/header/);
    expect(() => parseDemoAfpModeloCsv(`${HEADER}\nuno;A;2020-01-01;1`)).toThrow(/Modelo fund A/);
    expect(() => parseDemoAfpModeloCsv(`${HEADER}\nmodelo;B;2020-01-01;1`)).toThrow(/Modelo fund A/);
    expect(() => parseDemoAfpModeloCsv(`${HEADER}\nmodelo;A;2020-01-01;1\nmodelo;A;2020-01-03;1`)).toThrow(/follow/);
    expect(() => parseDemoAfpModeloCsv(`${HEADER}\nmodelo;A;2020-01-01;1\nmodelo;A;2020-01-01;1`)).toThrow(/follow/);
    expect(() => parseDemoAfpModeloCsv(`${HEADER}\nmodelo;A;2020-01-01;1,5`)).toThrow(/unreadable/);
    expect(() => parseDemoAfpModeloCsv(`${HEADER}\nmodelo;A;2020-01-01;0`)).toThrow(/non-positive/);
    expect(() => parseDemoAfpModeloCsv(`${HEADER}\nmodelo;A;01/01/2020;1`)).toThrow(/invalid day/);
    expect(() => parseDemoAfpModeloCsv(`${HEADER}\n`)).toThrow(/no rows/);
  });

  it("the committed snapshot covers the window the demo holds Modelo", () => {
    const rows = parseDemoAfpModeloCsv(readFileSync(DEMO_AFP_MODELO_CSV_PATH, "utf8"));
    expect(rows[0]!.day).toBe("2018-01-01");
    expect(rows.at(-1)!.day).toBe("2020-03-31");
    expect(rows).toHaveLength(821);
  });
});
