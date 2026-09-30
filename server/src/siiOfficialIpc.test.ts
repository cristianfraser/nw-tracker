import { describe, expect, it } from "vitest";
import {
  officialIpcVariationPctBetween,
  parseSiiUtmIpcPage,
  ufWindowForIpcMonth,
  verifyOfficialIpcAgainstUf,
} from "./siiOfficialIpc.js";

// The SII's table shape (utm<year>.htm), 2026 values: January–August published, the rest pending.
const MONTH_ROWS = [
  ["Enero", "69.751", "837.012", "110,42", "0,4", "0,4", "2,9"],
  ["Febrero", "70.100", "841.200", "110,86", "0,4", "0,8", "3,4"],
  ["Marzo", "70.500", "846.000", "111,30", "0,4", "1,2", "3,3"],
  ["Abril", "70.900", "850.800", "112,74", "1,3", "2,5", "4,5"],
  ["Mayo", "71.200", "854.400", "112,93", "0,2", "2,7", "4,4"],
  ["Junio", "71.300", "855.600", "112,95", "0,0", "2,7", "4,8"],
  ["Julio", "71.500", "858.000", "113,05", "0,1", "2,8", "4,1"],
  ["Agosto", "71.649", "859.788", "113,15", "0,6", "3,4", "4,1"],
  ["Septiembre", "71.721", "860.652", "", "", "", ""],
  ["Octubre", "72.151", "865.812", "", "", "", ""],
  ["Noviembre", "", "", "", "", "", ""],
  ["Diciembre", "", "", "", "", "", ""],
];
const page = (rows: string[][]) =>
  `<table><tr><th>2026</th><th>UTM (1)</th></tr>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
    .join("")}</table>`;

describe("parseSiiUtmIpcPage", () => {
  it("reads the published months and stops at the first pending one", () => {
    const months = parseSiiUtmIpcPage(2026, page(MONTH_ROWS));
    expect(months).toHaveLength(8);
    expect(months[3]).toEqual({ month: "2026-04-01", variationPct: 1.3, indexPoints: 112.74 });
    expect(months[5]!.variationPct).toBe(0);
  });

  it("throws on a gap, a missing month, or a half-filled row", () => {
    const gap = MONTH_ROWS.map((r) => (r[0] === "Octubre" ? ["Octubre", "1", "1", "114,00", "0,5", "", ""] : r));
    expect(() => parseSiiUtmIpcPage(2026, page(gap))).toThrow(/after an unpublished month/);
    expect(() => parseSiiUtmIpcPage(2026, page(MONTH_ROWS.slice(1)))).toThrow(/no row for Enero/);
    const half = MONTH_ROWS.map((r) => (r[0] === "Enero" ? ["Enero", "1", "1", "110,42", "", "", ""] : r));
    expect(() => parseSiiUtmIpcPage(2026, page(half))).toThrow(/variation «»/);
  });
});

describe("verifyOfficialIpcAgainstUf", () => {
  // UF 9 Sep → 9 Oct 2026 grows by August's 0,6%.
  const uf = new Map([
    ["2026-09-09", 40000],
    ["2026-10-09", 40240],
  ]);
  const ufOn = (d: string) => uf.get(d) ?? null;

  it("maps a month to its UF window", () => {
    expect(ufWindowForIpcMonth("2026-08-01")).toEqual({ from: "2026-09-09", to: "2026-10-09" });
    expect(ufWindowForIpcMonth("2026-12-01")).toEqual({ from: "2027-01-09", to: "2027-02-09" });
  });

  it("accepts a match and leaves the latest months without UF unchecked", () => {
    const months = [
      { month: "2026-07-01", variationPct: 0.1, indexPoints: 113.05 },
      { month: "2026-08-01", variationPct: 0.6, indexPoints: 113.15 },
    ];
    // July's window (Aug 9 → Sep 9) has no UF here: it is one of the two latest, so unchecked.
    expect(verifyOfficialIpcAgainstUf(months, ufOn)).toEqual(["2026-07-01"]);
  });

  it("throws when the UF moved by another figure, or an old month cannot be checked", () => {
    expect(() => verifyOfficialIpcAgainstUf([{ month: "2026-08-01", variationPct: 0.5, indexPoints: 1 }], ufOn)).toThrow(
      /UF grew 0.6%/
    );
    const old = ["2026-01-01", "2026-02-01", "2026-08-01"].map((month) => ({ month, variationPct: 0.6, indexPoints: 1 }));
    expect(() => verifyOfficialIpcAgainstUf(old, ufOn)).toThrow(/no UF to check 2026-01-01/);
  });
});

describe("officialIpcVariationPctBetween", () => {
  // Printed index points: base-2018 values up to 2023-12, then the base-2023 restart.
  const rows = new Map([
    ["2023-11-01", { variationPct: 0.7, indexPoints: 134.8 }],
    ["2023-12-01", { variationPct: -0.5, indexPoints: 134.1 }],
    ["2024-01-01", { variationPct: 0.7, indexPoints: 101.72 }],
    ["2024-02-01", { variationPct: 0.6, indexPoints: 102.33 }],
  ]);
  const lookup = (m: string) => rows.get(m) ?? null;

  it("uses the printed index ratio inside a base", () => {
    expect(officialIpcVariationPctBetween("2023-11-01", "2023-12-01", lookup)).toBeCloseTo((134.1 / 134.8 - 1) * 100, 10);
  });

  it("bridges a base change with the published variation", () => {
    const expected = ((134.1 / 134.8) * 1.007 * (102.33 / 101.72) - 1) * 100;
    expect(officialIpcVariationPctBetween("2023-11-01", "2024-02-01", lookup)).toBeCloseTo(expected, 10);
    expect(officialIpcVariationPctBetween("2024-01-01", "2024-01-01", lookup)).toBe(0);
  });

  it("throws on a missing month", () => {
    expect(() => officialIpcVariationPctBetween("2024-01-01", "2024-03-01", lookup)).toThrow(/2024-03-01/);
  });
});
