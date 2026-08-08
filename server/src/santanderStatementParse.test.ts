import { describe, expect, it } from "vitest";
import {
  internationalRowToLine,
  nationalHeader,
  nationalRowToLine,
  originCardLast4FromPan,
  parseSantanderFixed,
  santanderIsoToCsvDate,
  type SantanderInternationalRow,
  type SantanderNationalRow,
} from "./santanderStatementParse.js";

function nationalRow(overrides: Partial<SantanderNationalRow> = {}): SantanderNationalRow {
  return {
    Pan: "250905#420050000",
    NombreComercio: "VITEST SHOP",
    FechaTxs: "2026-07-01",
    MontoTxs: "0000023270",
    NumeroCuotas: "00",
    TotalCuotas: "00",
    MontoCuota: "0000000000",
    TipoCuota: "00",
    TasaCompraCuotas: "0000000",
    CodTxs: "000",
    Ciudad: "SANTIAGO",
    Microfilm: "24073006182025490901358",
    GlosaRubroCom: "TIT",
    ...overrides,
  };
}

function internationalRow(overrides: Partial<SantanderInternationalRow> = {}): SantanderInternationalRow {
  return {
    Pan: "250905#420050000",
    NombreComercio: "VITEST CLOUD",
    FechaTxs: "2026-07-04",
    FechaProceso: "2026-07-06",
    MontoOrigen: "00000012331+",
    MontoTransaccion: "00000012331+",
    CodPais: "USA",
    CiudadComercio: null,
    NumeroReferencia: "24692166185401911234374",
    CodTxs: "2000",
    ...overrides,
  };
}

describe("parseSantanderFixed", () => {
  it("reads national amounts as integer pesos", () => {
    expect(parseSantanderFixed("0000023270", 0)).toBe(23270);
    expect(parseSantanderFixed("000012720000", 0)).toBe(12720000);
  });

  it("reads international amounts with two implied decimals", () => {
    expect(parseSantanderFixed("00000001414+", 2)).toBeCloseTo(14.14, 2);
    expect(parseSantanderFixed("00001299000+", 2)).toBeCloseTo(12990, 2);
  });

  it("honours a trailing minus as the direction", () => {
    expect(parseSantanderFixed("00000025813-", 2)).toBeCloseTo(-258.13, 2);
  });

  it("throws rather than guessing at an unexpected shape", () => {
    expect(() => parseSantanderFixed("1.234", 0)).toThrow(/Unexpected/);
  });
});

describe("dates and PAN", () => {
  it("converts ISO to the CSV d/m/yyyy", () => {
    expect(santanderIsoToCsvDate("2026-07-01")).toBe("1/7/2026");
  });

  it("treats 0001-01-01 as the null sentinel", () => {
    expect(santanderIsoToCsvDate("0001-01-01")).toBeNull();
  });

  it("takes the origin card last4 from the masked PAN", () => {
    expect(originCardLast4FromPan("250905#420050781")).toBe("0781");
  });
});

describe("national rows", () => {
  it("uses MontoTxs as the amount for a plain purchase", () => {
    const line = nationalRowToLine(nationalRow());
    expect(line.amount_clp).toBe(23270);
    expect(line.installment_flag).toBe(false);
    expect(line.valor_cuota_mensual_clp).toBeNull();
  });

  /**
   * The mapping most likely to be got wrong: `MontoCuota` is the TOTAL purchase and `MontoTxs` is
   * the monthly cuota. Values mirror the CK ECOMMERCE row verified against the imported PDF
   * (amount_clp 1xx.xxx, valor_cuota_mensual_clp 3x.xxx, cuota 1 of 3).
   */
  it("maps MontoCuota to the total and MontoTxs to the monthly cuota", () => {
    const line = nationalRowToLine(
      nationalRow({
        CodTxs: "205",
        NumeroCuotas: "01",
        TotalCuotas: "03",
        MontoCuota: "0000100474",
        MontoTxs: "0000033491",
      })
    );
    expect(line.installment_flag).toBe(true);
    expect(line.amount_clp).toBe(100474);
    expect(line.valor_cuota_mensual_clp).toBe(33491);
    expect(line.nro_cuota_current).toBe(1);
    expect(line.nro_cuota_total).toBe(3);
    expect(line.amount_clp! / line.nro_cuota_total!).toBeCloseTo(line.valor_cuota_mensual_clp!, 0);
  });

  it("keeps the payment row the PDF parser drops, tagged by its code", () => {
    const line = nationalRowToLine(
      nationalRow({ CodTxs: "067", NombreComercio: "MONTO CANCELADO", MontoTxs: "0002002346" })
    );
    expect(line.cod_txs).toBe("067");
    expect(line.amount_clp).toBe(2002346);
  });
});

describe("international rows", () => {
  it("marks a charge as natively USD when origin equals transaction", () => {
    const line = internationalRowToLine(internationalRow());
    expect(line.amount_usd).toBeCloseTo(123.31, 2);
    expect(line.amount_orig).toBeCloseTo(123.31, 2);
    expect(line.orig_currency).toBe("usd");
  });

  it("treats a differing origin as the foreign amount", () => {
    const line = internationalRowToLine(
      internationalRow({ MontoOrigen: "00001299000+", MontoTransaccion: "00000001414+" })
    );
    expect(line.amount_orig).toBeCloseTo(12990, 2);
    expect(line.amount_usd).toBeCloseTo(14.14, 2);
    expect(line.orig_currency).toBe("clp");
  });

  it("carries the abono's negative direction from MontoTransaccion", () => {
    const line = internationalRowToLine(
      internationalRow({
        NombreComercio: "ABONO DE DIVISAS",
        CodTxs: "2020",
        MontoOrigen: "00000025813+",
        MontoTransaccion: "00000025813-",
      })
    );
    expect(line.amount_usd).toBeCloseTo(-258.13, 2);
    expect(line.orig_currency).toBe("usd");
  });

  it("keeps the posting date and reference the national feed lacks", () => {
    const line = internationalRowToLine(internationalRow());
    expect(line.posting_date).toBe("6/7/2026");
    expect(line.authorization_code).toBe("24692166185401911234374");
    expect(line.country).toBe("USA");
  });
});

describe("nationalHeader", () => {
  it("reads header figures as integer pesos and nulls the sentinel date", () => {
    const header = nationalHeader({
      Cuenta: "800000000001",
      FechaFactActual: "2026-07-23",
      FechaFactAnt: "0001-01-01",
      FechaVenc: "2026-08-10",
      SaldoAnterior: "00000002368",
      TotalPagos: "00000002368",
      DeudaTotalFact: "00000923815",
      PagoMinimo: "000000000000",
      CupoPesos: "000012720000",
      CupoDisponible: "00012720000",
    });
    expect(header.statement_date).toBe("23/7/2026");
    expect(header.period_from).toBeNull();
    expect(header.pay_by).toBe("10/8/2026");
    expect(header.deuda_total).toBe(923815);
    expect(header.cupo_total).toBe(12720000);
  });
});
