import { describe, expect, it } from "vitest";
import { unemploymentFundDocumentsKind } from "nw-tracker-contracts";
import { parseAfcCartola, parseAfcCotizacionesCertificate, unemploymentFundDocumentsPayload } from "./documents.js";

// Synthetic layout text (pdftotext -layout shapes: inline «Mes YYYY», the month/year split around
// a data line, an employer name wrapped onto its own lines). Amounts are made up.
const CERT_TEXT = [
  "                                                                    N° de folio TEST-0000",
  "Certificado de cotizaciones previsionales acreditadas de Cuenta Individual por Cesantía",
  "AFC CHILE S.A. certifica que la Cuenta Individual de Cesantía, perteneciente al afiliado(a) VITEST PERSON,",
  "RUT 11.111.111-1, registra en el periodo comprendido entre OCTUBRE/2002 - SEPTIEMBRE/2099, las siguientes cotizaciones pagadas",
  "a:",
  "                    RUT                                          Renta           Monto          Fecha de",
  "   Período                             Razón Social",
  "                  Empleador                                    Imponible        Cotizado          pago",
  "   Enero 2099     11.111.111-1   EMPRESA UNO SPA                  $1.000.000          $6.000   10/02/2099",
  "   Enero 2099     11.111.111-1   EMPRESA UNO SPA                  $1.000.000         $16.000   10/02/2099",
  "  Septiembre",
  "                  22.222.222-2   EMPRESA DOS LIMITADA             $2.000.000         $12.000   10/10/2099",
  "     2099",
  "  Septiembre",
  "                  22.222.222-2   EMPRESA DOS LIMITADA             $2.000.000         $32.000   10/10/2099",
  "     2099",
  "  Noviembre     44.444.444-4   EMPRESA CUATRO SA                  $300.000           $1.000   09/12/2099",
  "     2099",
  "                                   EMPRESA TRES",
  "  Octubre 2099    33.333.333-3                                    $500.000           $3.000   12/11/2099",
  "                                         LIMITADA",
  "                                                                         TOTAL                $70.000",
  "Se extiende el presente certificado a petición del interesado(a), para los fines que estime conveniente.",
  "",
].join("\n");

const CARTOLA_TEXT = [
  "  Estado cuatrimestral",
  "  de su Cuenta Individual por Cesantía.",
  "  período del 1 de Septiembre al 31 de Diciembre de 2099",
  "SR(A): VITEST PERSON",
  "    1. Saldo inicial",
  " Al 31-08-2099                                                                 (1) $100.000",
  "    2. Ingresos",
  "  Total de cotizaciones                 Otros ingresos        Ganancia          Total ingresos (2)",
  " $48.000                               $0                    $0                $48.000",
  "    3. Egresos",
  "  Total comisiones                      Otros egresos         Uso de la Cuenta Individual   Total egresos (3)",
  " $500                                  $0                    $60.000                       $60.500",
  "    Saldo final",
  " Al 31-12-2099                                                                 (1+2-3) $87.500",
  "    Detalle de cotizaciones",
  " Razón social empleador                            Mes de pago                    Cotización mensual",
  " EMPRESA DOS LIMITADA                              Octubre-2099                          $44.000",
  " EMPRESA TRES LIMITADA                             Noviembre-2099                         $3.000",
  " EMPRESA CUATRO SA                                 Diciembre-2099                         $1.000",
  "                                                                       Total                  $48.000",
  "                                                                     Beneficios del Fondo de Cesantía",
  "",
].join("\n");

describe("AFC certificado de cotizaciones — parser", () => {
  it("parses every leg with its período and pay date, checks the printed TOTAL", () => {
    const cert = parseAfcCotizacionesCertificate(CERT_TEXT);
    expect(cert.total_clp).toBe(70000);
    expect(cert.legs.map((l) => [l.period_ym, l.pay_ymd, l.amount_clp, l.employer])).toEqual([
      ["2099-01", "2099-02-10", 6000, "EMPRESA UNO SPA"],
      ["2099-01", "2099-02-10", 16000, "EMPRESA UNO SPA"],
      ["2099-09", "2099-10-10", 12000, "EMPRESA DOS LIMITADA"],
      ["2099-09", "2099-10-10", 32000, "EMPRESA DOS LIMITADA"],
      ["2099-11", "2099-12-09", 1000, "EMPRESA CUATRO SA"],
      ["2099-10", "2099-11-12", 3000, ""],
    ]);
    expect(cert.legs[0]!.renta_imponible_clp).toBe(1000000);
    expect(cert.legs[0]!.employer_rut).toBe("11.111.111-1");
  });

  it("fails fast on a TOTAL that does not match, or a cotización without a período", () => {
    expect(() => parseAfcCotizacionesCertificate(CERT_TEXT.replace("$70.000", "$70.001"))).toThrow(/TOTAL/);
    const orphan = CERT_TEXT.replace("  Septiembre\n                  22.222.222-2   EMPRESA DOS LIMITADA             $2.000.000         $12.000", "                  22.222.222-2   EMPRESA DOS LIMITADA             $2.000.000         $12.000");
    expect(() => parseAfcCotizacionesCertificate(orphan)).toThrow(/without a período/);
  });
});

describe("AFC estado cuatrimestral — parser", () => {
  it("reads the period, both saldos, the totals and the detalle, and checks the printed identities", () => {
    const c = parseAfcCartola(CARTOLA_TEXT);
    expect(c.period_from_ymd).toBe("2099-09-01");
    expect(c.period_to_ymd).toBe("2099-12-31");
    expect(c.saldo_inicial_ymd).toBe("2099-08-31");
    expect(c.saldo_inicial_clp).toBe(100000);
    expect(c.saldo_final_ymd).toBe("2099-12-31");
    expect(c.saldo_final_clp).toBe(87500);
    expect(c.cotizaciones_clp).toBe(48000);
    expect(c.comisiones_clp).toBe(500);
    expect(c.uso_cuenta_clp).toBe(60000);
    expect(c.detalle).toEqual([
      { employer: "EMPRESA DOS LIMITADA", pay_month_ym: "2099-10", amount_clp: 44000 },
      { employer: "EMPRESA TRES LIMITADA", pay_month_ym: "2099-11", amount_clp: 3000 },
      { employer: "EMPRESA CUATRO SA", pay_month_ym: "2099-12", amount_clp: 1000 },
    ]);
  });

  it("throws when the saldo identity or the detalle sum is broken", () => {
    expect(() => parseAfcCartola(CARTOLA_TEXT.replace("(1+2-3) $87.500", "(1+2-3) $87.400"))).toThrow(/saldo final/);
    expect(() => parseAfcCartola(CARTOLA_TEXT.replace("$3.000\n", "$3.001\n"))).toThrow(/detalle/);
  });
});


describe("unemployment_fund.documents payload", () => {
  it("carries both documents as printed and the rebuild options", () => {
    const payload = unemploymentFundDocumentsKind.payload.parse(
      unemploymentFundDocumentsPayload(parseAfcCotizacionesCertificate(CERT_TEXT), [parseAfcCartola(CARTOLA_TEXT)], {
        apply: false,
        accountId: null,
        replaceExcelRows: true,
        dropMovementIds: [7],
      })
    );
    expect(payload.certificate.total).toBe(70000);
    expect(payload.certificate.legs[0]).toEqual({
      period_month: "2099-01",
      employer_rut: "11.111.111-1",
      employer: "EMPRESA UNO SPA",
      taxable_income: 1000000,
      amount: 6000,
      paid_on: "2099-02-10",
    });
    expect(payload.statements[0]).toMatchObject({ opening: { date: "2099-08-31", balance: 100000 }, closing: { date: "2099-12-31", balance: 87500 }, account_use: 60000 });
    expect(payload.options).toEqual({ replace_excel_rows: true, drop_movement_ids: [7] });
  });
});
