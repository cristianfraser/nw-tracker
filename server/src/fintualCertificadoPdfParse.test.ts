import { describe, expect, it } from "vitest";
import {
  isFintualCertificadoTransaccionesText,
  parseFintualCertificadoPdfText,
} from "./fintualCertificadoPdfParse.js";

const SAMPLE_LINES = `
27/05/2026          Reserva        Very Conservative Streep             A               0 2.092,7878 1.433,4946 17.014,9700                          0 $3.000.000 Transferencia electronica $24.390.868
17/04/2025   caca daca                   Risky Norris     A           0    430,6760 2.554,1245   2.696,9454           0 $1.100.000               MLT interno $6.888.334
01/08/2023 mega cbcb APV-B               Risky Norris   APV    279,2521          0 2.148,5960   4.985,0307    $600.000           0 Transferencia electronica $10.710.817
`.trim();

describe("fintualCertificadoPdfParse", () => {
  it("detects certificado header text", () => {
    expect(
      isFintualCertificadoTransaccionesText("CERTIFICADO DE TRANSACCIONES\nFintual Administradora")
    ).toBe(true);
  });

  it("parses sample movement rows with goal ids", () => {
    const rows = parseFintualCertificadoPdfText(SAMPLE_LINES);
    expect(rows.length).toBe(3);
    const reserva = rows.find((r) => r.id_inversión === "1164983");
    expect(reserva?.nombre_inversión).toContain("Reserva");
    expect(reserva?.rescate_cuotas).toContain("2.092");
    const rn = rows.find((r) => r.id_inversión === "2859");
    expect(rn?.nombre_inversión).toContain("caca daca");
    const apvB = rows.find((r) => r.id_inversión === "78515");
    expect(apvB?.nombre_inversión).toContain("mega cbcb");
  });
});
