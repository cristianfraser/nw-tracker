import { describe, expect, it } from "vitest";
import { loadMortgageSheetConfig, mortgageSheetPayload, type MortgageSheetRead } from "./sheet.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const READ: MortgageSheetRead = {
  document: { path: "/x/cfraser.numbers", name: "cfraser.numbers", sha256: "a".repeat(64), size: 10, modified_at: "2099-10-11T15:00:00Z" },
  sheet: "depto",
  table: "dividendos",
  rows: [
    {
      kind: "pie",
      label: "pie",
      paid_on: "2099-04-04",
      uf_day: 40000,
      pago_clp: 58000000,
      pago_uf: 1450,
      interes_clp: null,
      interes_uf: null,
      min_uf: null,
      max_uf: null,
      incendio_clp: null,
      incendio_uf: null,
      desgravamen_clp: null,
      desgravamen_uf: null,
      amortizacion_clp: null,
      amortizacion_uf: null,
      amortizacion_ext_clp: null,
      amortizacion_ext_uf: null,
      credito_restante_uf: 3950,
      valor_vivienda_uf: 5400,
    },
    {
      kind: "cuota",
      label: "32",
      paid_on: "2099-10-11",
      uf_day: 40000,
      pago_clp: 800000,
      pago_uf: 20,
      interes_clp: 300000,
      interes_uf: 7.5,
      min_uf: 11,
      max_uf: 80,
      incendio_clp: 40000,
      incendio_uf: 1,
      desgravamen_clp: 4000,
      desgravamen_uf: 0.1,
      amortizacion_clp: 96000,
      amortizacion_uf: 2.4,
      amortizacion_ext_clp: 360000,
      amortizacion_ext_uf: 9,
      credito_restante_uf: 2988.6,
      valor_vivienda_uf: 5400,
    },
  ],
  projected: ["33"],
};

describe("mortgageSheetPayload", () => {
  it("passes the reader's rows through the contract, without the local path", () => {
    const p = mortgageSheetPayload(READ, true);
    expect(p.apply).toBe(true);
    expect(p.document).toEqual({ name: "cfraser.numbers", sha256: "a".repeat(64), size: 10, modified_at: "2099-10-11T15:00:00Z" });
    expect(p.rows.map((r) => r.label)).toEqual(["pie", "32"]);
    expect(p.projected).toEqual(["33"]);
  });

  it("refuses a pago that is not pago UF × uf día, or one below the mínima", () => {
    const bad = structuredClone(READ);
    bad.rows[1]!.pago_clp = 900_000;
    expect(() => mortgageSheetPayload(bad, true)).toThrow(/is not pago UF × uf día/);
    const low = structuredClone(READ);
    low.rows[1]!.pago_uf = 10;
    low.rows[1]!.pago_clp = Math.round(10 * 40000);
    expect(() => mortgageSheetPayload(low, true)).toThrow(/below the cuota mínima/);
  });
});

describe("loadMortgageSheetConfig", () => {
  it("expands ~ and requires the three fields; null without a file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nw-mortgage-cfg-"));
    const file = path.join(dir, "mortgage-sheet.json");
    expect(loadMortgageSheetConfig(file)).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ file: "~/Documents/x.numbers", sheet: "depto", table: "dividendos" }));
    expect(loadMortgageSheetConfig(file)).toEqual({
      file: path.join(os.homedir(), "Documents/x.numbers"),
      sheet: "depto",
      table: "dividendos",
      accepted_differences: [],
    });
    fs.writeFileSync(file, JSON.stringify({ file: "x.numbers", sheet: "depto", table: "dividendos", accepted_differences: [{ label: "prepago 1", field: "credito_restante_uf" }] }));
    expect(() => loadMortgageSheetConfig(file)).toThrow(/needs "reason"/);
    fs.writeFileSync(file, JSON.stringify({ file: "x.numbers", sheet: "depto" }));
    expect(() => loadMortgageSheetConfig(file)).toThrow(/"table" is required/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
