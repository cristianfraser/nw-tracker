import { afterEach, describe, expect, it } from "vitest";
import { parseUnoValorCuotaHistorico } from "./afpUnoApi.js";
import {
  afpUnoExpectedOfficialDay,
  afpUnoOfficialSource,
  afpUnoOfficialSyncRunner,
  isAfpUnoOfficialStale,
  syncAfpUnoFromSp,
  syncAfpUnoFromUnoApi,
} from "./afpUnoOfficialSync.js";
import type { ChileWallClock } from "./chileDate.js";

function row(fecha: string, fondoA: unknown) {
  return { FECHA: fecha, FONDO_A: fondoA, FONDO_B: "1,00", FONDO_E: "2,00" };
}

describe("UNO valor cuota API answer", () => {
  it("reads fund A with the decimal comma and returns the rows ascending", () => {
    const rows = parseUnoValorCuotaHistorico({
      codigo: "0",
      data: [
        row("2026-10-28T00:00:00-03:00", "50123,45"),
        row("2026-10-27T00:00:00-03:00", "1.050.100,5"),
        row("2026-10-26T00:00:00-03:00", "50000"),
      ],
    });
    expect(rows).toEqual([
      { afp: "uno", fund: "A", day: "2026-10-26", unit_value_clp: 50000, provisional: false },
      { afp: "uno", fund: "A", day: "2026-10-27", unit_value_clp: 1050100.5, provisional: false },
      { afp: "uno", fund: "A", day: "2026-10-28", unit_value_clp: 50123.45, provisional: false },
    ]);
  });

  it("throws on an error codigo, whatever the data", () => {
    expect(() => parseUnoValorCuotaHistorico({ codigo: "150", data: [] })).toThrow(/codigo "150"/);
    expect(() => parseUnoValorCuotaHistorico({ data: [row("2026-10-28T00:00:00-03:00", "1,0")] })).toThrow(/codigo/);
    expect(() => parseUnoValorCuotaHistorico(null)).toThrow(/not an object/);
  });

  it("throws on rows it cannot read", () => {
    expect(() => parseUnoValorCuotaHistorico({ codigo: "0", data: [row("28/10/2026", "1,0")] })).toThrow(/FECHA/);
    expect(() => parseUnoValorCuotaHistorico({ codigo: "0", data: [row("2026-10-28T00:00:00-03:00", 1.5)] })).toThrow(
      /FONDO_A/
    );
    expect(() => parseUnoValorCuotaHistorico({ codigo: "0", data: [row("2026-10-28T00:00:00-03:00", "1,234.5")] })).toThrow();
    expect(() => parseUnoValorCuotaHistorico({ codigo: "0", data: [row("2026-10-28T00:00:00-03:00", "0")] })).toThrow(
      /non-positive/
    );
    expect(() => parseUnoValorCuotaHistorico({ codigo: "0", data: "x" })).toThrow(/data array/);
  });

  it("throws when the rows are not newest first", () => {
    const data = [row("2026-10-27T00:00:00-03:00", "1,0"), row("2026-10-28T00:00:00-03:00", "1,0")];
    expect(() => parseUnoValorCuotaHistorico({ codigo: "0", data })).toThrow(/newest first/);
    const twice = [row("2026-10-28T00:00:00-03:00", "1,0"), row("2026-10-28T00:00:00-03:00", "1,0")];
    expect(() => parseUnoValorCuotaHistorico({ codigo: "0", data: twice })).toThrow(/newest first/);
  });
});

function at(ymd: string, hour: number): ChileWallClock {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  return { ymd, year: y, month: m, day: d, hour, minute: 0 } as ChileWallClock;
}

describe("afp_uno source on the hosted demo", () => {
  const before = process.env.DEMO_MODE;
  afterEach(() => {
    if (before === undefined) delete process.env.DEMO_MODE;
    else process.env.DEMO_MODE = before;
  });

  it("runs the SP sync outside demo mode and UNO's API in demo mode", () => {
    delete process.env.DEMO_MODE;
    expect(afpUnoOfficialSource()).toBe("sp");
    expect(afpUnoOfficialSyncRunner()).toBe(syncAfpUnoFromSp);
    process.env.DEMO_MODE = "1";
    expect(afpUnoOfficialSource()).toBe("uno_api");
    expect(afpUnoOfficialSyncRunner()).toBe(syncAfpUnoFromUnoApi);
  });

  // 2026-10-02 is a Friday; 10-05 → 10-09 Monday → Friday.
  it("expects UNO's API one business day behind the SP, so the demo is not stale every evening", () => {
    process.env.DEMO_MODE = "1";
    expect(afpUnoExpectedOfficialDay(at("2026-10-06", 18))).toBe("2026-10-02");
    expect(afpUnoExpectedOfficialDay(at("2026-10-06", 18), "sp")).toBe("2026-10-05");
    expect(isAfpUnoOfficialStale(at("2026-10-06", 18), "2026-10-02")).toBe(false);
    expect(isAfpUnoOfficialStale(at("2026-10-07", 18), "2026-10-02")).toBe(true);
    delete process.env.DEMO_MODE;
    expect(isAfpUnoOfficialStale(at("2026-10-06", 18), "2026-10-02")).toBe(true);
  });
});
