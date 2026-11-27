import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SYNTHETIC_ACCOUNT, syntheticCartolaXlsx } from "./testdata/cartolaXlsxFixture.js";
import {
  cartolaXlsxHeaderMonth,
  cartolaMonthAnswer,
  cartolaMonthLabel,
  checkingCartolaAccount,
  validateDownloadedCartolaXlsx,
} from "./cartolaXlsxDownload.js";

const ACCOUNT = SYNTHETIC_ACCOUNT;
const cartolaBytes = syntheticCartolaXlsx;

const NAME = "Cartola de cuenta Corriente - Julio 2026.xlsx";
const EXPECTED = { month: "2026-07", account: "000000123456" };

describe("validateDownloadedCartolaXlsx", () => {
  it("accepts the cuenta corriente's cartola of the month asked for", () => {
    const cartola = validateDownloadedCartolaXlsx(cartolaBytes(), NAME, EXPECTED);
    expect(cartola.period_month).toBe("2026-07");
    expect(cartola.period_to).toBe("2026-07-31");
    expect(cartola.movements).toHaveLength(2);
  });

  it("refuses the bank's HTML error page saved under the xlsx name", () => {
    const html = Buffer.from("<!DOCTYPE html><html><body>Servicio no disponible</body></html>");
    expect(() => validateDownloadedCartolaXlsx(html, NAME, EXPECTED)).toThrow(/not an xlsx workbook/);
  });

  it("refuses another account's cartola", () => {
    expect(() => validateDownloadedCartolaXlsx(cartolaBytes({ account: "0-000-00-99999-9" }), NAME, EXPECTED)).toThrow(
      /account …9999, not the configured cuenta corriente/
    );
  });

  it("refuses a cartola that is not the peso cuenta corriente", () => {
    expect(() => validateDownloadedCartolaXlsx(cartolaBytes({ type: "CUENTA CORRIENTE ME" }), NAME, EXPECTED)).toThrow(
      /not the peso cuenta corriente/
    );
  });

  it("refuses a cartola of another month than the one asked for", () => {
    expect(() =>
      validateDownloadedCartolaXlsx(cartolaBytes({ desde: "31/07/2026", hasta: "31/08/2026" }), NAME, EXPECTED)
    ).toThrow(/HASTA 2026-08-31 is not in 2026-07/);
  });

  it("refuses a file whose name names another month (the organizer files it by its name)", () => {
    expect(() =>
      validateDownloadedCartolaXlsx(cartolaBytes(), "Cartola de cuenta Corriente - Junio 2026.xlsx", EXPECTED)
    ).toThrow(/names 2026-06, expected 2026-07/);
  });
});

function historyCall(month: string, account: string, response: unknown) {
  return {
    endpoint: "ultCartolaHistorica",
    status: 200,
    requestBody: { INPUT: { ENTIDAD: "0035", PRODUCTO: "00", CONTRATO: account, MESCONSULTA: month.slice(5), ANOCONSULTA: month.slice(0, 4) } },
    responseBody: { METADATA: { STATUS: "0" }, DATA: { AS_TIB_ConsultaUltCartolaHistorica: response } },
  };
}

const ISSUED = (account: string) => ({
  INFO: { CODERR: "00", DESERR: "Operación Exitosa" },
  OUTPUT: { MATRIZ: [{ NUMEROCARTOLA: " 7", NUMEROCUENTA: account, FECHADESDE: "2026-07-31" }] },
});
const NONE = { INFO: { CODERR: "16", DESERR: "No existe el registro buscado." } };

describe("cartolaXlsxHeaderMonth", () => {
  it("reads the month only from the configured peso cuenta corriente's cartola", () => {
    expect(cartolaXlsxHeaderMonth(cartolaBytes(), ACCOUNT)).toBe("2026-07");
    expect(cartolaXlsxHeaderMonth(cartolaBytes({ account: "0-070-00-55555-5" }), ACCOUNT)).toBeNull();
    expect(cartolaXlsxHeaderMonth(cartolaBytes({ type: "CUENTA VISTA" }), ACCOUNT)).toBeNull();
    expect(cartolaXlsxHeaderMonth(Buffer.from("<html></html>"), ACCOUNT)).toBeNull();
  });
});

describe("cartolaMonthAnswer", () => {
  it("reads the view's answers for the month and account", () => {
    const calls = [historyCall("2026-08", "000000123456", NONE), historyCall("2026-07", "000000123456", ISSUED("000000123456"))];
    expect(cartolaMonthAnswer(calls, "2026-07", ACCOUNT)).toEqual({ kind: "issued", month: "2026-07", cartolaNumber: "7" });
    expect(cartolaMonthAnswer(calls, "2026-08", ACCOUNT)).toEqual({
      kind: "not_issued",
      month: "2026-08",
      message: "No existe el registro buscado.",
    });
    expect(cartolaMonthAnswer(calls, "2026-06", ACCOUNT)).toBeNull();
  });

  it("ignores another account's request and refuses a row naming another account", () => {
    expect(cartolaMonthAnswer([historyCall("2026-07", "000000999999", ISSUED("000000999999"))], "2026-07", ACCOUNT)).toBeNull();
    expect(() => cartolaMonthAnswer([historyCall("2026-07", "000000123456", ISSUED("000000999999"))], "2026-07", ACCOUNT)).toThrow(
      /names another account/
    );
  });

  it("throws on any other code", () => {
    const failed = { INFO: { CODERR: "99", DESERR: "Servicio no disponible" } };
    expect(() => cartolaMonthAnswer([historyCall("2026-07", "000000123456", failed)], "2026-07", ACCOUNT)).toThrow(/code 99/);
  });
});

describe("cartola month and account helpers", () => {
  it("prints a month as the view and the file name do", () => {
    expect(cartolaMonthLabel("2026-07")).toBe("Julio 2026");
    expect(cartolaMonthLabel("2026-09")).toBe("Septiembre 2026");
  });

  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it("reads the configured cuenta corriente from the organizer's identifiers file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "organize-ids-"));
    dirs.push(dir);
    const file = path.join(dir, "ids.json");
    fs.writeFileSync(file, JSON.stringify({ santander_checking_cartola_account: ACCOUNT }));
    expect(checkingCartolaAccount({ NW_TRACKER_ORGANIZE_IDENTIFIERS: file })).toBe(ACCOUNT);
    fs.writeFileSync(file, JSON.stringify({}));
    expect(() => checkingCartolaAccount({ NW_TRACKER_ORGANIZE_IDENTIFIERS: file })).toThrow(/santander_checking_cartola_account/);
  });
});
