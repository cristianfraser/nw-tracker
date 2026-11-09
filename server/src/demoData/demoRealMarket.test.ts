import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEMO_AFP_MODELO_CSV_PATH,
  DEMO_SANTIAGO_SNAPSHOT_CSV_PATH,
  parseDemoAfpModeloCsv,
  parseDemoSantiagoSnapshotCsv,
  spliceSnapshotBeforeYahoo,
} from "./demoRealMarket.js";

const HEADER = "afp;fund;day;unit_value_clp";

describe("demo Modelo fund A snapshot", () => {
  it("reads rows with dot decimals", () => {
    const rows = parseDemoAfpModeloCsv(`${HEADER}\nmodelo;A;2019-12-31;100.5\r\nmodelo;A;2020-01-01;101\n`);
    expect(rows).toEqual([
      { afp: "modelo", fund: "A", day: "2019-12-31", unit_value: 100.5, provisional: false },
      { afp: "modelo", fund: "A", day: "2020-01-01", unit_value: 101, provisional: false },
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

describe("demo Santiago closes snapshot", () => {
  const H = "ticker;day;close_clp";

  it("reads closes by ticker and throws on a bad row", () => {
    const m = parseDemoSantiagoSnapshotCsv(`${H}\nABC.SN;2025-06-02;1000.5\nABC.SN;2025-06-03;1001\n`);
    expect(m.get("ABC.SN")).toEqual({ dates: ["2025-06-02", "2025-06-03"], closes: [1000.5, 1001] });
    expect(() => parseDemoSantiagoSnapshotCsv("day;close\n2025-06-02;1")).toThrow(/header/);
    expect(() => parseDemoSantiagoSnapshotCsv(`${H}\nSPY;2025-06-02;1`)).toThrow(/Santiago/);
    expect(() => parseDemoSantiagoSnapshotCsv(`${H}\nABC.SN;2025-06-03;1\nABC.SN;2025-06-02;1`)).toThrow(/follow/);
    expect(() => parseDemoSantiagoSnapshotCsv(`${H}\nABC.SN;2025-06-02;0`)).toThrow(/non-positive/);
    expect(() => parseDemoSantiagoSnapshotCsv(`${H}\n`)).toThrow(/no rows/);
  });

  it("keeps the snapshot before Yahoo's first day, and refuses a gap", () => {
    const snap = { dates: ["2025-06-02", "2025-06-03", "2025-06-04"], closes: [1, 2, 3] };
    expect(spliceSnapshotBeforeYahoo(snap, { dates: ["2025-06-04", "2025-06-05"], closes: [30, 40] })).toEqual({
      dates: ["2025-06-02", "2025-06-03", "2025-06-04", "2025-06-05"],
      closes: [1, 2, 30, 40],
    });
    expect(spliceSnapshotBeforeYahoo(snap, { dates: [], closes: [] })).toEqual(snap);
    expect(() => spliceSnapshotBeforeYahoo(snap, { dates: ["2025-07-01"], closes: [9] })).toThrow(/week/);
  });

  it("the committed snapshot reaches Yahoo's first IPSA ETF close", () => {
    const m = parseDemoSantiagoSnapshotCsv(readFileSync(DEMO_SANTIAGO_SNAPSHOT_CSV_PATH, "utf8"));
    const s = m.get("CFIETFIPSA.SN")!;
    expect(s.dates[0]).toBe("2025-05-12");
    expect(s.dates.at(-1)).toBe("2026-07-01");
  });
});
