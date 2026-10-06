import { describe, expect, it } from "vitest";
import { parseSpAfpCsv, spAfpCsvUrl } from "./spAfpFundUnits.js";

const CSV = [
  "",
  "Valores Confirmados",
  "",
  "Fecha;CAPITAL;;MODELO",
  ";Valor Cuota;Valor Patrimonio;Valor Cuota;Valor Patrimonio",
  "2019-09-30;46.117,95;3583211647542;47.489,98;1036279623434",
  "",
  "Valores Confirmados",
  "",
  "Fecha;CAPITAL;;MODELO;;UNO",
  ";Valor Cuota;Valor Patrimonio;Valor Cuota;Valor Patrimonio;Valor Cuota;Valor Patrimonio",
  "2019-10-01;46.102,88;3563276951098;47.468,33;1033291072228;48.000,00;0",
  "",
  "Valores Provisorios - Sujetos a Confirmacion",
  "",
  "Fecha;CAPITAL;;MODELO;;UNO",
  ";Valor Cuota;Valor Patrimonio;Valor Cuota;Valor Patrimonio;Valor Cuota;Valor Patrimonio",
  "2019-09-30;46.117,95;3583211647542;47.489,98;1036279623434;;",
  "2019-10-01;46.102,88;3563276951098;47.468,33;1033291072228;48.000,00;0",
  "2019-10-02;;;47.500,10;1033291072228;48.010,55;1",
].join("\r\n");

describe("parseSpAfpCsv", () => {
  it("reads every block with its own AFP set, skips unpublished cells and flags provisional values", () => {
    const rows = parseSpAfpCsv(CSV, "A");
    expect(rows.map((r) => [r.afp, r.day, r.unit_value_clp, r.provisional])).toEqual([
      ["capital", "2019-09-30", 46117.95, false],
      ["modelo", "2019-09-30", 47489.98, false],
      ["capital", "2019-10-01", 46102.88, false],
      ["modelo", "2019-10-01", 47468.33, false],
      ["uno", "2019-10-01", 48000, false],
      ["modelo", "2019-10-02", 47500.1, true],
      ["uno", "2019-10-02", 48010.55, true],
    ]);
    expect(rows.every((r) => r.fund === "A")).toBe(true);
  });

  it("throws on an unknown line, a row of the wrong width and dates out of order", () => {
    expect(() => parseSpAfpCsv(CSV.replace("Valores Confirmados", "Valores Raros"), "A")).toThrow(/unexpected line/);
    expect(() => parseSpAfpCsv(CSV.replace("2019-09-30;46.117,95;3583211647542;", "2019-09-30;"), "A")).toThrow(/cells/);
    expect(() => parseSpAfpCsv(CSV.replace("2019-10-02", "2019-09-01"), "A")).toThrow(/ascending/);
    expect(() => parseSpAfpCsv(CSV.replace("2019-10-01;46.102,88;3563276951098;47.468,33;1033291072228;48.000,00;0\r\n2019-10-02", "2019-10-01;46.102,88;3563276951098;47.468,33;1033291072228;48.000,01;0\r\n2019-10-02"), "A")).toThrow(/printed twice/);
  });

  it("builds the file's URL", () => {
    expect(spAfpCsvUrl("A", 2016, 2026, "2026-09-30")).toBe(
      "https://www.spensiones.cl/apps/valoresCuotaFondo/vcfAFPxls.php?aaaaini=2016&aaaafin=2026&tf=A&fecconf=20260930"
    );
  });
});
