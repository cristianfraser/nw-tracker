import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChileWallClock } from "./chileDate.js";
import { db } from "./db.js";
import {
  AFC_CIC_SERIES_KEY,
  isAfcCicStale,
  parseSpCesantiaCsv,
  spCesantiaCsvUrl,
  upsertAfcCicRows,
} from "./afcCicSeries.js";
import { leafAssetGroupIdForKindSlug } from "./assetGroupTree.js";

function cl(ymd: string, hour: number, minute = 0): ChileWallClock {
  const [ys, ms, ds] = ymd.split("-");
  return {
    ymd,
    year: Number(ys),
    month: Number(ms),
    day: Number(ds),
    hour,
    minute,
    monthKey: ymd.slice(0, 7),
  };
}

const SAMPLE_CSV = [
  ";Fondo de la Cuenta Individual de Cesantia;;Fondo de Cesantia Solidario",
  "Fecha;Valor Cuota;Valor del Patrimonio;Valor Cuota;Valor del Patrimonio",
  "2026-01-01;4.054,63;10821076688035;4.949,18;3516894988462",
  "2026-01-02;4.051,04;10811508015009;4.940,42;3506064659931",
  "2026-01-03;4.051,04;10811508015009;4.940,42;3506064659931",
  "",
].join("\r\n");

describe("afc_cic — Superintendencia de Pensiones CSV", () => {
  it("parses the yearly CSV into dated CIC/FCS rows (weekend carries included)", () => {
    const rows = parseSpCesantiaCsv(SAMPLE_CSV);
    expect(rows.map((r) => r.day)).toEqual(["2026-01-01", "2026-01-02", "2026-01-03"]);
    expect(rows[1]).toEqual({
      day: "2026-01-02",
      cic_valor_cuota: 4051.04,
      cic_patrimonio: 10811508015009,
      fcs_valor_cuota: 4940.42,
      fcs_patrimonio: 3506064659931,
    });
    expect(rows[2]!.cic_valor_cuota).toBe(rows[1]!.cic_valor_cuota);
  });

  it("accepts the accented fund header the site may serve", () => {
    const accented = SAMPLE_CSV.replace("Cesantia;;Fondo de Cesantia", "Cesantía;;Fondo de Cesantía");
    expect(parseSpCesantiaCsv(accented)).toHaveLength(3);
  });

  it("leaves out trailing rows the SP added before filling their values", () => {
    const pending = SAMPLE_CSV.replace("\r\n\r\n", "\r\n") + "2026-01-04;;;;\r\n";
    expect(parseSpCesantiaCsv(pending).map((r) => r.day)).toEqual(["2026-01-01", "2026-01-02", "2026-01-03"]);
    const gap = SAMPLE_CSV.replace("2026-01-02;4.051,04;10811508015009;4.940,42;3506064659931", "2026-01-02;;;;");
    expect(() => parseSpCesantiaCsv(gap)).toThrow(/before a published one/);
    const partial = SAMPLE_CSV.replace("2026-01-03;4.051,04;10811508015009", "2026-01-03;;");
    expect(() => parseSpCesantiaCsv(partial)).toThrow(/Unparseable/);
  });

  it("fails fast on a changed header, a short row, or non-ascending dates", () => {
    expect(() => parseSpCesantiaCsv(SAMPLE_CSV.replace("Valor del Patrimonio;Valor Cuota", "Patrimonio;Valor Cuota"))).toThrow(
      /column header/
    );
    expect(() => parseSpCesantiaCsv(SAMPLE_CSV.replace("Fondo de Cesantia Solidario", "Otro fondo"))).toThrow(
      /fund header/
    );
    expect(() => parseSpCesantiaCsv(SAMPLE_CSV.replace(";4.949,18;3516894988462", ";4.949,18"))).toThrow(/cells/);
    expect(() =>
      parseSpCesantiaCsv(SAMPLE_CSV.replace("2026-01-03;4.051,04", "2026-01-02;4.051,04"))
    ).toThrow(/ascending/);
  });

  it("builds the yearly CSV url and rejects years outside the SP range", () => {
    expect(spCesantiaCsvUrl(2026)).toBe("https://www.spensiones.cl/apps/valoresCuotaFondo/vcfAFCxls.php?aaaa=2026");
    expect(() => spCesantiaCsvUrl(1999)).toThrow(/invalid year/);
  });

});

describe("afc_cic — upsert + stale rule (test DB)", () => {
  const DAYS = ["2099-06-01", "2099-06-02", "2099-06-03"]; // Mon, Tue, Wed
  const NOTE = "vitest:afc-cic";
  let accountId: number | null = null;

  function row(day: string, px: number) {
    return { day, cic_valor_cuota: px, cic_patrimonio: 1, fcs_valor_cuota: 1, fcs_patrimonio: 1 };
  }

  beforeAll(() => {
    db.prepare(`DELETE FROM fund_unit_daily WHERE series_key = ? AND day >= '2099-01-01'`).run(AFC_CIC_SERIES_KEY);
  });

  afterAll(() => {
    db.prepare(`DELETE FROM fund_unit_daily WHERE series_key = ? AND day >= '2099-01-01'`).run(AFC_CIC_SERIES_KEY);
    if (accountId != null) db.prepare(`DELETE FROM accounts WHERE id = ?`).run(accountId);
  });

  it("inserts, reports restatements on a differing re-read, and never writes in dry-run", () => {
    const dry = upsertAfcCicRows([row(DAYS[0]!, 4000), row(DAYS[1]!, 4001)], { dryRun: true, note: NOTE });
    expect(dry).toEqual({ inserted: 2, updated: 0, unchanged: 0, restated: [] });
    expect(
      (db.prepare(`SELECT COUNT(*) AS c FROM fund_unit_daily WHERE series_key = ? AND day >= '2099-01-01'`).get(AFC_CIC_SERIES_KEY) as { c: number }).c
    ).toBe(0);

    const first = upsertAfcCicRows([row(DAYS[0]!, 4000), row(DAYS[1]!, 4001)], { dryRun: false, note: NOTE });
    expect(first).toEqual({ inserted: 2, updated: 0, unchanged: 0, restated: [] });

    // Provisional → confirmed: the SP now prints a different value for the 2nd; a 3rd day appears.
    const second = upsertAfcCicRows([row(DAYS[0]!, 4000), row(DAYS[1]!, 4001.5), row(DAYS[2]!, 4002)], {
      dryRun: false,
      note: NOTE,
    });
    expect(second.inserted).toBe(1);
    expect(second.updated).toBe(1);
    expect(second.unchanged).toBe(1);
    expect(second.restated).toEqual([{ day: DAYS[1], previous: 4001, next: 4001.5 }]);
    const stored = db
      .prepare(`SELECT unit_value FROM fund_unit_daily WHERE series_key = ? AND day = ?`)
      .get(AFC_CIC_SERIES_KEY, DAYS[1]) as { unit_value: number };
    expect(stored.unit_value).toBe(4001.5);
  });

  it("is never stale without an account on the series, then follows the expected-row rule", () => {
    const others = (db.prepare(`SELECT id FROM accounts WHERE fund_series_key = ?`).all(AFC_CIC_SERIES_KEY) as { id: number }[]).length;
    if (others === 0) {
      expect(isAfcCicStale(cl("2099-06-04", 15), {}, { force: false })).toBe(false);
    }
    const r = db
      .prepare(
        `INSERT INTO accounts (asset_group_id, name, notes, fund_series_key, exclude_from_group_totals)
         VALUES (?, 'AFC vitest', 'vitest:afc-cic', ?, 0)`
      )
      .run(leafAssetGroupIdForKindSlug("afc"), AFC_CIC_SERIES_KEY);
    accountId = Number(r.lastInsertRowid);

    // Latest row is Wednesday 2099-06-03 (from the upsert test).
    expect(isAfcCicStale(cl("2099-06-04", 9), {}, { force: false })).toBe(false); // Thu morning: Wed's row present
    expect(isAfcCicStale(cl("2099-06-04", 19), {}, { force: false })).toBe(false); // Thu evening: Wed's row present
    expect(isAfcCicStale(cl("2099-06-05", 15), {}, { force: false })).toBe(false); // Fri 15:00: Thu's row not due yet
    expect(isAfcCicStale(cl("2099-06-05", 18), {}, { force: false })).toBe(true); // Fri 18:00: Thu's row missing
    expect(isAfcCicStale(cl("2099-06-07", 1), {}, { force: false })).toBe(true); // Sun: Thu's row still missing
    expect(isAfcCicStale(cl("2099-06-04", 9), {}, { force: true })).toBe(true);
  });
});
