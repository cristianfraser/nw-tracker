import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fundAccountTransactionsKind } from "nw-tracker-contracts";
import { fundAccountTransactionsPayload, parseFintualCertMoneyCell } from "./certificado.js";

const HEADER =
  "Fecha,Hora,Id Inversión,Nombre Inversión,Nombre Fondo,Serie Fondo,Aporte Cuotas,Rescate Cuotas,Valor Cuota,Saldo Cuotas Final Dia,Aporte Pesos Chilenos,Rescate Pesos Chilenos,Medio,Saldo Pesos Chilenos Final Dia";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function csv(lines: string[]): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "vitest-fintual-cert-"));
  dirs.push(d);
  const file = path.join(d, "fintual-certificado-de-transacciones.csv");
  fs.writeFileSync(file, [HEADER, ...lines].join("\n"));
  return file;
}

describe("fintual certificado → fund_account.transactions", () => {
  it("sends the rows that move pesos or cuotas, as printed, and leaves the daily balance rows out", () => {
    const file = csv([
      '07/06/2026,12:00:00,1164983, Reserva,Very Conservative Streep,A,0,0,"1.434,9679","12.833,5741",0,0,"",$18.415.767',
      '14/05/2026,12:00:00,1164983, Reserva,Very Conservative Streep,A,"1.955,9173",0,"1.431,5534","19.107,7578",$2.800.000,0,Transferencia electronica,$27.353.776',
      '15/05/2026,12:00:00,2000001,APV A,Risky Norris,APV,0,"10,5",,"1,0",0,$40.000,,$1',
    ]);
    const payload = fundAccountTransactionsKind.payload.parse(fundAccountTransactionsPayload(file, { apply: false, maxMonth: null }));
    expect(payload).toMatchObject({ provider: "fintual", document: "fintual-certificado-de-transacciones.csv", max_month: null });
    expect(payload.transactions).toEqual([
      {
        date: "2026-05-14",
        investment: { id: "1164983", name: "Reserva" },
        medio: "Transferencia electronica",
        clp_in: 2_800_000,
        clp_out: 0,
        units_in: 1955.9173,
        units_out: 0,
        unit_value: 1431.5534,
      },
      {
        date: "2026-05-15",
        investment: { id: "2000001", name: "APV A" },
        medio: null,
        clp_in: 0,
        clp_out: 40_000,
        units_in: 0,
        units_out: 10.5,
        unit_value: null,
      },
    ]);
  });

  it("reads Chilean money cells, a parenthesised one as negative", () => {
    expect(parseFintualCertMoneyCell("$27.353.776")).toBe(27_353_776);
    expect(parseFintualCertMoneyCell("1.431,5534")).toBe(1431.5534);
    expect(parseFintualCertMoneyCell("($1.000)")).toBe(-1000);
    expect(parseFintualCertMoneyCell("")).toBeNull();
  });
});
