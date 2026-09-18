import { afterEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  FINTUAL_PUBLIC_SERIE_PRICE_URL,
  FINTUAL_PUBLIC_SERIE_TOLERANCE_REL,
  fetchFintualPublicSeriePrices,
  fintualOfficialSerieCorrectionErrors,
  fintualOfficialSerieSyncChanges,
  parseFintualPublicSeriePrices,
  reconcileFundUnitSeriesWithOfficialPrices,
} from "./fintualPublicSeriePrice.js";

const SERIES = "vitest_fintual_public_serie";
const SERIE_ID = 999;

function seedBar(day: string, px: number, note: string): void {
  db.prepare(
    `INSERT INTO fund_unit_daily (series_key, day, unit_value_clp, note) VALUES (?, ?, ?, ?)
     ON CONFLICT(series_key, day) DO UPDATE SET unit_value_clp = excluded.unit_value_clp, note = excluded.note`
  ).run(SERIES, day, px, note);
}

function readBar(day: string): { unit_value_clp: number; note: string } | undefined {
  return db
    .prepare(`SELECT unit_value_clp, note FROM fund_unit_daily WHERE series_key = ? AND day = ?`)
    .get(SERIES, day) as { unit_value_clp: number; note: string } | undefined;
}

afterEach(() => {
  db.prepare(`DELETE FROM fund_unit_daily WHERE series_key = ?`).run(SERIES);
});

describe("parseFintualPublicSeriePrices", () => {
  it("parses the endpoint's rows sorted by day", () => {
    const rows = parseFintualPublicSeriePrices(
      [
        { id: 2, managed_fund_serie: 1, date: "2026-09-16", value: 1450.3456 },
        { id: 1, managed_fund_serie: 1, date: "2026-09-15", value: 1450.2139 },
      ],
      1
    );
    expect(rows).toEqual([
      { day: "2026-09-15", valueClp: 1450.2139 },
      { day: "2026-09-16", valueClp: 1450.3456 },
    ]);
  });

  it("throws on another serie's rows, a bad date, a bad value, a duplicate day or a non-array", () => {
    expect(() => parseFintualPublicSeriePrices([{ managed_fund_serie: 7, date: "2026-09-16", value: 1 }], 1)).toThrow(
      /belongs to serie 7/
    );
    expect(() => parseFintualPublicSeriePrices([{ managed_fund_serie: 1, date: "16/09/2026", value: 1 }], 1)).toThrow(
      /bad date/
    );
    expect(() => parseFintualPublicSeriePrices([{ managed_fund_serie: 1, date: "2026-09-16", value: 0 }], 1)).toThrow(
      /bad value/
    );
    expect(() =>
      parseFintualPublicSeriePrices(
        [
          { managed_fund_serie: 1, date: "2026-09-16", value: 1 },
          { managed_fund_serie: 1, date: "2026-09-16", value: 2 },
        ],
        1
      )
    ).toThrow(/duplicate day/);
    expect(() => parseFintualPublicSeriePrices({ detail: "x" }, 1)).toThrow(/expected an array/);
  });
});

describe("fetchFintualPublicSeriePrices", () => {
  it("asks the public endpoint for the serie and window, no auth, and maps day → price", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push(String(url));
      expect(init?.headers).not.toHaveProperty("Cookie");
      return new Response(JSON.stringify([{ managed_fund_serie: 6, date: "2026-09-16", value: 4191.9596 }]), {
        status: 200,
      });
    }) as typeof fetch;
    const map = await fetchFintualPublicSeriePrices(6, "2026-09-10", "2026-09-20", { fetchImpl });
    expect(seen).toEqual([`${FINTUAL_PUBLIC_SERIE_PRICE_URL}?fund_serie=6&start_date=2026-09-10&end_date=2026-09-20`]);
    expect([...map]).toEqual([["2026-09-16", 4191.9596]]);
  });

  it("throws on a non-2xx answer instead of returning an empty series", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ detail: [{ msg: "ManagedFundSeries not found" }] }), { status: 422 })) as typeof fetch;
    await expect(fetchFintualPublicSeriePrices(99, "2026-09-10", "2026-09-20", { fetchImpl })).rejects.toThrow(
      /HTTP 422/
    );
  });
});

describe("reconcileFundUnitSeriesWithOfficialPrices", () => {
  it("fills, replaces carries, corrects beyond tolerance and leaves agreeing bars alone", () => {
    seedBar("2099-01-01", 1000, "fintual:gql:shares-publish|vitest"); // exact
    seedBar("2099-01-02", 1000.02, "fintual:real_assets:publish|vitest"); // 2e-5 off: noise
    seedBar("2099-01-03", 1000, "fintual:carry-forward"); // placeholder
    // 2099-01-04 absent
    seedBar("2099-01-05", 1016, "fintual:gql:shares-publish|vitest"); // 1,6% off: wrong
    const official = new Map([
      ["2099-01-01", 1000],
      ["2099-01-02", 1000],
      ["2099-01-03", 1000.5],
      ["2099-01-04", 1001],
      ["2099-01-05", 1000],
    ]);
    expect(0.02 / 1000).toBeLessThan(FINTUAL_PUBLIC_SERIE_TOLERANCE_REL);

    const dry = reconcileFundUnitSeriesWithOfficialPrices({ seriesKey: SERIES, serieId: SERIE_ID, official, dryRun: true });
    expect(dry.rows.map((r) => [r.day, r.action])).toEqual([
      ["2099-01-03", "carry_replaced"],
      ["2099-01-04", "filled"],
      ["2099-01-05", "corrected"],
    ]);
    expect(readBar("2099-01-04")).toBeUndefined(); // dry run wrote nothing
    expect(readBar("2099-01-05")!.unit_value_clp).toBe(1016);

    const res = reconcileFundUnitSeriesWithOfficialPrices({ seriesKey: SERIES, serieId: SERIE_ID, official, dryRun: false });
    expect(res.checked).toBe(5);
    expect(res.agreed).toBe(2);
    expect(readBar("2099-01-01")).toMatchObject({ unit_value_clp: 1000, note: "fintual:gql:shares-publish|vitest" });
    expect(readBar("2099-01-02")).toMatchObject({ unit_value_clp: 1000.02 }); // within tolerance: untouched
    expect(readBar("2099-01-03")).toMatchObject({ unit_value_clp: 1000.5, note: "fintual:public-serie:publish|serie=999" });
    expect(readBar("2099-01-04")).toMatchObject({ unit_value_clp: 1001, note: "fintual:public-serie:publish|serie=999" });
    expect(readBar("2099-01-05")).toMatchObject({ unit_value_clp: 1000, note: "fintual:public-serie:publish|serie=999" });

    const changes = fintualOfficialSerieSyncChanges([res]);
    expect(changes.map((c) => c.newDate)).toEqual(["2099-01-03", "2099-01-04", "2099-01-05"]);
    expect(changes[2]!.label).toContain("corregido");
    const errors = fintualOfficialSerieCorrectionErrors([res]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/2099-01-05: stored valor cuota 1.016(,00)? .* corrected to the official 1.000(,00)? \(\+1\.600%\)/);

    // Idempotent: a second pass finds every day agreeing.
    const again = reconcileFundUnitSeriesWithOfficialPrices({ seriesKey: SERIES, serieId: SERIE_ID, official, dryRun: false });
    expect(again.rows).toEqual([]);
    expect(again.agreed).toBe(5);
  });

  it("relabels an equal carry silently (no change line)", () => {
    seedBar("2099-02-01", 1000, "fintual:carry-forward");
    const res = reconcileFundUnitSeriesWithOfficialPrices({
      seriesKey: SERIES,
      serieId: SERIE_ID,
      official: new Map([["2099-02-01", 1000]]),
      dryRun: false,
    });
    expect(res.rows.map((r) => r.action)).toEqual(["carry_replaced"]);
    expect(readBar("2099-02-01")!.note).toBe("fintual:public-serie:publish|serie=999");
    expect(fintualOfficialSerieSyncChanges([res])).toEqual([]);
  });
});
