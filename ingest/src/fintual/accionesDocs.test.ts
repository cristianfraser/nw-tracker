import { describe, expect, it } from "vitest";
import { brokerDividendStatementKind } from "nw-tracker-contracts";
import { dividendStatementPayload } from "./acciones.js";
import {
  parseAlpacaMonthlyStatementText,
  parseFintualAccionesCertificadoText,
} from "./accionesDocs.js";

/** Shapes copied from real `pdftotext -layout` output (amounts synthetic). */
const ALPACA_STATEMENT = `12 E 49th Street
Floor 11                                                    Providencia 229, Providencia
New York, NY 10017                                                        Santiago, CHL


Vitest Holder                                       Monthly Statement                    Period: JULY - 2026
Account No: 000000000


Cash Summary                   This Period             Year to Date
Beginning Balance                            $0.02                      $ --

                                                                                             3
Holdings
Symbol   Description                              Quantity   Market Price   Market Value   Cost Price   Unrealized TD   Cost Basis
*Cash    USD                                      $ --       $ --           $1.67          $ --         $ --            $ --
VTAAA    VITEST A CORP COM                        28.438160398   $86.38     $2,456.49      $108.04      -$615.99        $3,072.48
VTBBB    VITEST B PLC SHS                         6.720322895    $478.38    $3,214.87      $532.33      -$362.58        $3,577.45
                                                                                             4
Income
Trade Date   Entry Type               Symbol   Description                                                         Net Amt
  07/31/2026 Dividends                VTAAA    Cash DIV @ 1.903516, Pos QTY: 1.027327209, Rec Date: 2026-06-18           $1.96
  07/31/2026 Div. Adj(NRA Withheld)   VTAAA    DIV tax withholding on $1.96 at 15% for tax country CHL; w8w9: w8        -$0.29
  07/15/2026 Dividends                VTBBB    Cash DIV @ 1.600000, Pos QTY: 6.720322895, Rec Date: 2026-07-01          $10.75
  06/30/2026 Cash Interest** - June 2026 Sweep                                                                            $0.02

                                                                                             5
Fees
Trade Date   Description   Net Amt
  No record found.
                                                                                             6
Transaction
`;

const CERTIFICADO = `                  CERTIFICADO DE TRANSACCIONES EN ACCIONES Y EXCHANGE TRADED
                                     FUNDS (ETFs)

Con fecha 28 de mayo de 2026, Fintual Administradora General de Fondos SA, RUT 76.810.627-4, certi ca que el
28 de mayo de 2026 Vitest Holder ha efectuado las siguientes transacciones

Dividendos recibidos

                                                Símbolo       Categoría        Monto        Monto         Monto
  Fecha             Nombre Activo
                                                 Activo        Activo          bruto      impuestos       neto
 2025-01-       Vitest Fund A
                                                       VTAAA           ETF    US $ 1,99      US $ 0,29 US $ 1,70
       31                        ETF Trust
 2026-04-       Vitest Fund A
                                                       VTAAA           ETF    US $ 1,84      US $ 0,27 US $ 1,57
       30                        ETF Trust

Este certificado se extiende para los fines que el interesado considere pertinentes.
`;

describe("fintualAccionesDocs — Alpaca monthly statement", () => {
  it("reads the period, pairs each dividend with its NRA withholding line and keeps the sweep interest apart", () => {
    const s = parseAlpacaMonthlyStatementText(ALPACA_STATEMENT);
    expect(s.period_ym).toBe("2026-07");
    expect(s.dividends).toEqual([
      {
        trade_date: "2026-07-31",
        symbol: "VTAAA",
        gross: 1.96,
        per_share: 1.903516,
        position_qty: 1.027327209,
        record_date: "2026-06-18",
        withholding: 0.29,
        withholding_rate_pct: 15,
        tax_country: "CHL",
        w8w9: "w8",
        net: 1.67,
      },
      // No NRA line: credited in full (an Irish plc), withholding 0 and no rate invented.
      {
        trade_date: "2026-07-15",
        symbol: "VTBBB",
        gross: 10.75,
        per_share: 1.6,
        position_qty: 6.720322895,
        record_date: "2026-07-01",
        withholding: 0,
        withholding_rate_pct: null,
        tax_country: null,
        w8w9: null,
        net: 10.75,
      },
    ]);
    expect(s.interest).toEqual([{ trade_date: "2026-06-30", amount: 0.02, description: "June 2026 Sweep" }]);
    expect(s.holdings.map((h) => [h.symbol, h.quantity])).toEqual([
      ["VTAAA", 28.438160398],
      ["VTBBB", 6.720322895],
    ]);
  });

  it("throws on an Income line it does not know, on an orphan NRA line and on a missing period", () => {
    expect(() =>
      parseAlpacaMonthlyStatementText(
        ALPACA_STATEMENT.replace("06/30/2026 Cash Interest** - June 2026 Sweep", "06/30/2026 Mystery Credit VTAAA something")
      )
    ).toThrow(/unrecognised Income line/);
    expect(() =>
      parseAlpacaMonthlyStatementText(ALPACA_STATEMENT.replace("on $1.96 at 15%", "on $1.90 at 15%"))
    ).toThrow(/matches 0 dividend line/);
    expect(() => parseAlpacaMonthlyStatementText(ALPACA_STATEMENT.replace("Period: JULY - 2026", ""))).toThrow(/Period/);
    expect(() => parseAlpacaMonthlyStatementText(ALPACA_STATEMENT.replace("\nFees\n", "\nFeez\n"))).toThrow(/not closed/);
  });
});

describe("fintualAccionesDocs — certificado de eventos de capital", () => {
  it("reassembles the layout-split dates and reads bruto / impuestos / neto", () => {
    const c = parseFintualAccionesCertificadoText(CERTIFICADO);
    expect(c.issued_on).toBe("2026-05-28");
    expect(c.dividends).toEqual([
      { date: "2025-01-31", symbol: "VTAAA", category: "ETF", gross: 1.99, tax: 0.29, net: 1.7 },
      { date: "2026-04-30", symbol: "VTAAA", category: "ETF", gross: 1.84, tax: 0.27, net: 1.57 },
    ]);
  });

  it("throws when a row does not add up or is left open", () => {
    expect(() => parseFintualAccionesCertificadoText(CERTIFICADO.replace("US $ 1,99", "US $ 2,99"))).toThrow(/does not add up/);
    expect(() =>
      parseFintualAccionesCertificadoText(CERTIFICADO.replace("       30                        ETF Trust\n", ""))
    ).toThrow(/never closed/);
  });

  it("yields no dividends for a certificate without the section", () => {
    expect(parseFintualAccionesCertificadoText(CERTIFICADO.split("Dividendos recibidos")[0]!).dividends).toEqual([]);
  });
});

describe("broker.dividend_statement payloads", () => {
  it("a cartola names the US as the withholding jurisdiction only where the NRA line shows tax", () => {
    const payload = brokerDividendStatementKind.payload.parse(dividendStatementPayload(ALPACA_STATEMENT, "julio.pdf", "cartola", true));
    expect(payload.document).toEqual({ kind: "monthly_statement", name: "julio.pdf", label: "2026-07" });
    expect(payload.dividends.map((d) => [d.symbol, d.net, d.withholding_jurisdiction])).toEqual([
      ["VTAAA", 1.67, "US"],
      ["VTBBB", 10.75, null],
    ]);
    expect(payload.interest).toEqual([{ date: "2026-06-30", amount: 0.02, description: "June 2026 Sweep" }]);
  });

  it("a certificado carries bruto / impuestos / neto and nothing it does not print", () => {
    const payload = brokerDividendStatementKind.payload.parse(dividendStatementPayload(CERTIFICADO, "cert.pdf", "certificado", false));
    expect(payload.document.kind).toBe("certificate");
    expect(payload.dividends.length).toBeGreaterThan(0);
    for (const d of payload.dividends) expect(d).toMatchObject({ withholding_jurisdiction: null, per_share: null, tax_country: null });
  });
});
