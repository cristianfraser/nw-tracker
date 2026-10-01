import { describe, expect, it } from "vitest";
import { parseContributionsCertificate, parseMovementsCertificate } from "./certificates.js";

// Synthetic certificates in the `pdftotext -layout` shape of AFP UNO's (2026-09): spacing,
// wrapped rows and page furniture as the real ones print them; names and RUTs invented.

const CONTRIBUTIONS = `                      CERTIFICADO COTIZACIONES
                                                                         Folio de Certificación Nº: 1A2B3C4D5E6F
                                                                                                 30 de septiembre de 2030

AFP UNO, certifica que a la fecha, el Sr. : PERSONA DE PRUEBA R.U.T.: 11.111.111-1
OBLIGATORIA    las   siguientes      cotizaciones   correspondientes       al     per íodo   comprendido    entre       09/2029      y
09/2030.
                                            Fecha                      Monto                 Valor           Rut              Tipo
    Período     Tipo de Movimiento
                                             Caja                                            Cuota         Pagador           Fondo
                                                          Pesos                Cuotas
   04-2030    COTIZACION NORMAL           12/05/2030           136.720              1,43     95.334,33   22.222.222-2          A


   03-2030    COTIZACION NORMAL           08/04/2030           362.242              3,96     91.552,21   22.222.222-2          A

                                                       Página 1 de 1
`;

const MOVEMENTS = `     CERTIFICADO DE MOVIMIENTOS CUENTA
                OBLIGATORIA
                                                                                       Folio de Certificación Nº: 9F8E7D6C5B
                                                                                           Santiago, 30 de Septiembre de 2030

Período Informado                                            : Desde                09/2029
                                                             : Hasta                09/2030

   Período      Cargo                                                          Monto              Valor        R.U.T.         Tipo
                                 Tipo de Movimiento
  Cotización    Abono                                                  Pesos           Cuotas     Cuota       Empleador      Fondo

 06-2030       Abono                                                   133.898
                        111138 Cot.Recibida Desde Afc Por Concepto De Slp                  1,38   97.219,01   33.333.333-3     A

 06-2030       Abono    110974 Ganancia Por Rentabilidad Valor Cuota         133           0,00   97.219,01   33.333.333-3     A

 04-2030       Cargo                                                     6.227
                        120506 Comision Porcentual Por Cotizacion Recaudada                0,07   95.334,33   22.222.222-2     A

                                                             Página 1 de 2
 Período      Cargo                                                          Monto              Valor        R.U.T.         Tipo
                               Tipo de Movimiento
Cotización    Abono                                                  Pesos           Cuotas     Cuota       Empleador      Fondo

03-2030      Abono    110351 Reliquidacion Traspaso Ingreso Rezago       302.749
                      Descoordinado                                                  4,66   64.975,55   22.222.222-2     A

03-2030      Abono                                                    6.656
                      111415 Cot. Normal Afil. Independiente Transf. Tesoreria General De La0,17
                      Rep. Rezagado                                                         41.261,81   11.111.111-1     A

02-2030      Cargo    122774 3º Retiro 10%                                    1.020.863          18,10   56.401,25                  A

                                                           Página 2 de 2
`;

describe("parseContributionsCertificate", () => {
  it("reads the header and every row with its fecha caja", () => {
    const c = parseContributionsCertificate(CONTRIBUTIONS);
    expect(c).toMatchObject({ folio: "1A2B3C4D5E6F", issued_on: "2030-09-30", from_period: "2029-09", to_period: "2030-09" });
    expect(c.rows).toEqual([
      { period: "2030-04", description: "COTIZACION NORMAL", paid_on: "2030-05-12", pesos: 136720, cuotas: 1.43, valor_cuota: 95334.33, payer_rut: "22.222.222-2", fund: "A" },
      { period: "2030-03", description: "COTIZACION NORMAL", paid_on: "2030-04-08", pesos: 362242, cuotas: 3.96, valor_cuota: 91552.21, payer_rut: "22.222.222-2", fund: "A" },
    ]);
  });

  it("fails on a row line it cannot read", () => {
    expect(() => parseContributionsCertificate(CONTRIBUTIONS.replace("136.720", "136.72x"))).toThrow(/unreadable row/);
  });
});

describe("parseMovementsCertificate", () => {
  it("reads wrapped rows, glued columns, digits in a description and a row with no employer", () => {
    const m = parseMovementsCertificate(MOVEMENTS);
    expect(m).toMatchObject({ folio: "9F8E7D6C5B", issued_on: "2030-09-30", from_period: "2029-09", to_period: "2030-09" });
    expect(m.rows.map((r) => [r.period, r.direction, r.code, r.description, r.pesos, r.cuotas, r.valor_cuota, r.employer_rut])).toEqual([
      ["2030-06", "credit", "111138", "Cot.Recibida Desde Afc Por Concepto De Slp", 133898, 1.38, 97219.01, "33.333.333-3"],
      ["2030-06", "credit", "110974", "Ganancia Por Rentabilidad Valor Cuota", 133, 0, 97219.01, "33.333.333-3"],
      ["2030-04", "debit", "120506", "Comision Porcentual Por Cotizacion Recaudada", 6227, 0.07, 95334.33, "22.222.222-2"],
      ["2030-03", "credit", "110351", "Reliquidacion Traspaso Ingreso Rezago Descoordinado", 302749, 4.66, 64975.55, "22.222.222-2"],
      ["2030-03", "credit", "111415", "Cot. Normal Afil. Independiente Transf. Tesoreria General De La Rep. Rezagado", 6656, 0.17, 41261.81, "11.111.111-1"],
      ["2030-02", "debit", "122774", "3º Retiro 10%", 1020863, 18.1, 56401.25, null],
    ]);
  });

  it("fails on a row with a second peso amount", () => {
    expect(() => parseMovementsCertificate(MOVEMENTS.replace("Valor Cuota         133 ", "Valor Cuota         133   99 "))).toThrow(/one peso amount/);
  });
});
