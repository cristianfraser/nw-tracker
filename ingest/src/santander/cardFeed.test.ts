import { describe, expect, it } from "vitest";
import { cardUnbilledMovementsKind } from "nw-tracker-contracts";
import {
  santanderCardFeedPayload,
  santanderIssuerBalances,
  santanderMovementDateToIso,
  santanderMovementRowToLine,
  type SantanderMovementRow,
  type SantanderMovementsFile,
} from "./cardFeed.js";
import { cuotaCountFromStampTax, cuotaPurchaseTypeFromFeedDescription } from "./cuotaPurchases.js";

function row(overrides: Partial<SantanderMovementRow> = {}): SantanderMovementRow {
  return {
    Fecha: "04/08/2026",
    Descripcion: "COMPRA NORMAL",
    Comercio: "VITEST MERCHANT",
    Importe: "29.408",
    DescripcionRubro: null,
    Ciudad: "SANTIAGO",
    TipoBen: "Titular",
    IndicadorDebeHaber: "D",
    ...overrides,
  };
}

function saldoInicial(fecha: string, importe: string, indicador = "D"): SantanderMovementRow {
  return row({ Fecha: fecha, Descripcion: "SALDO INICIAL", Comercio: null, Importe: importe, IndicadorDebeHaber: indicador });
}

function file(slides: SantanderMovementsFile["slides"], extra: Partial<SantanderMovementsFile> = {}): SantanderMovementsFile {
  return { fetchedAt: "2026-09-25T15:56:23.387Z", slides, ...extra };
}

describe("santanderMovementDateToIso", () => {
  it("converts dd/mm/yyyy", () => {
    expect(santanderMovementDateToIso("04/08/2026")).toBe("2026-08-04");
  });

  it("throws on another shape, and on a day the calendar lacks", () => {
    expect(() => santanderMovementDateToIso("2026-08-04")).toThrow(/want dd\/mm\/yyyy/);
    expect(() => santanderMovementDateToIso("32/08/2026")).toThrow(/want dd\/mm\/yyyy/);
    expect(() => santanderMovementDateToIso("04/13/2026")).toThrow(/want dd\/mm\/yyyy/);
    expect(() => santanderMovementDateToIso("31/02/2026")).toThrow(/want dd\/mm\/yyyy/);
  });
});

describe("amounts", () => {
  it("reads CLP dot-grouped integers and USD decimal commas, debt-positive", () => {
    expect(santanderMovementRowToLine(row(), "clp").amount).toBe(29408);
    expect(santanderMovementRowToLine(row({ Importe: "18,52" }), "usd").amount).toBe(18.52);
    expect(santanderMovementRowToLine(row({ Importe: "1.234,56" }), "usd").amount).toBe(1234.56);
  });

  it("reads D as a charge and H as a credit", () => {
    expect(
      santanderMovementRowToLine(row({ IndicadorDebeHaber: "H", Descripcion: "NOTA DE CREDITO", Importe: "2,74" }), "usd")
        .amount
    ).toBe(-2.74);
  });

  it("throws on an indicator that is neither D nor H, and on a zero amount", () => {
    expect(() => santanderMovementRowToLine(row({ IndicadorDebeHaber: "X" }), "clp")).toThrow(/want D or H/);
    expect(() => santanderMovementRowToLine(row({ Importe: "0" }), "clp")).toThrow(/zero amount/);
  });
});

describe("row mapping", () => {
  it("uses Comercio as the merchant and keeps the whole row as raw text", () => {
    const line = santanderMovementRowToLine(row({ Descripcion: "COMPRA NACIONAL POR INTERNET", Comercio: "MP*VITEST" }), "clp");
    expect(line.merchant).toBe("MP*VITEST");
    expect(line.raw_text).toBe("04/08/2026 COMPRA NACIONAL POR INTERNET MP*VITEST 29.408");
  });

  it("falls back to Descripcion only when Comercio is absent", () => {
    expect(santanderMovementRowToLine(row({ Comercio: null, Descripcion: "PAGO VITEST" }), "clp").merchant).toBe("PAGO VITEST");
  });

  it("decodes a payment the way the server's receipt path writes it", () => {
    // Pinned by the same literal in server/src/santanderCcPaymentReceipts.test.ts.
    expect(
      santanderMovementRowToLine(
        row({ Fecha: "07/08/2026", Descripcion: "PAGO", Comercio: null, Importe: "111.222", Ciudad: null, IndicadorDebeHaber: "H" }),
        "clp"
      )
    ).toEqual({
      date: "2026-08-07",
      merchant: "PAGO",
      currency: "clp",
      amount: -111222,
      raw_text: "07/08/2026 PAGO PAGO 111.222",
    });
  });
});

describe("cuota purchases", () => {
  it("maps the feed's purchase types and refuses an unknown cuota type", () => {
    expect(cuotaPurchaseTypeFromFeedDescription("CUOTA COMERCIO")).toEqual({ first_cuota_bills: "next_cycle", cuota_count: null });
    expect(cuotaPurchaseTypeFromFeedDescription("N/CUOTAS PRECIO CONTADO")).toEqual({
      first_cuota_bills: "purchase_cycle",
      cuota_count: null,
    });
    expect(cuotaPurchaseTypeFromFeedDescription("TRES CUOTAS CONTADO")).toEqual({ first_cuota_bills: "purchase_cycle", cuota_count: 3 });
    expect(cuotaPurchaseTypeFromFeedDescription("COMPRA NORMAL")).toBeNull();
    expect(() => cuotaPurchaseTypeFromFeedDescription("SEIS CUOTAS SIN INTERES")).toThrow(/Unknown Santander cuota-purchase type/);
  });

  it("reads the cuota count from the stamp tax: term = cuotas + 1 months at 0,066%, capped at 0,8%", () => {
    // Real 2026-08 purchases: Municipalidad de Maipú and the Plaza Lyon recaudación, both 3 cuotas.
    expect(cuotaCountFromStampTax(29_990, 79)).toEqual({ status: "exact", cuota_count: 3 });
    expect(cuotaCountFromStampTax(1_598_924, 4_221)).toEqual({ status: "exact", cuota_count: 3 });
    expect(cuotaCountFromStampTax(100_000, 462)).toEqual({ status: "exact", cuota_count: 6 });
    // 12 cuotas (0,858%) is past the cap: only «12 or more».
    expect(cuotaCountFromStampTax(223_930, 1_791)).toEqual({ status: "capped" });
    // A tiny principal whose peso rounding hides the term is not a count.
    expect(cuotaCountFromStampTax(1_000, 3).status).toBe("inconsistent");
  });

  it("pairs a cuota comercio purchase with its same-day stamp tax, and only an unambiguous pair", () => {
    const tax = (fecha: string, comercio: string) =>
      row({ Fecha: fecha, Descripcion: "IMPTO. DECRETO LEY 3475", Comercio: comercio, Importe: "79" });
    const payload = santanderCardFeedPayload(
      file([
        {
          account: "800099990022",
          currency: "CLP",
          rows: [
            row({ Fecha: "27/08/2026", Descripcion: "CUOTA COMERCIO", Comercio: "MUNICIPALIDAD DE MAIPU", Importe: "29.990" }),
            tax("27/08/2026", "MUNICIPALIDAD DE MAIPU"),
            row({ Fecha: "05/09/2026", Descripcion: "N/CUOTAS PRECIO CONTADO", Comercio: "FULLNEUMATICO QUILIN", Importe: "189.990" }),
            // Two cuota purchases, one tax, same day and merchant: no count.
            row({ Fecha: "06/09/2026", Descripcion: "CUOTA COMERCIO", Comercio: "TIENDA DOBLE", Importe: "30.000" }),
            row({ Fecha: "06/09/2026", Descripcion: "CUOTA COMERCIO", Comercio: "TIENDA DOBLE", Importe: "30.000" }),
            tax("06/09/2026", "TIENDA DOBLE"),
            // A close-day billing reference shares a cuota description but is not a purchase.
            row({ Fecha: "25/08/2026", Descripcion: "CUOTAS COMERCIO", Comercio: "CUOT: 000000013OPER: 000024", Importe: "18.333" }),
          ],
        },
      ])
    );
    const unknown = { cuota_count: null, count_source: null, stamp_tax_clp: null };
    expect(payload.cards[0]!.lines.filter((l) => l.cuota_purchase).map((l) => [l.merchant, l.cuota_purchase])).toEqual([
      ["MUNICIPALIDAD DE MAIPU", { first_cuota_bills: "next_cycle", cuota_count: 3, count_source: "stamp_tax", stamp_tax_clp: 79 }],
      ["FULLNEUMATICO QUILIN", { first_cuota_bills: "purchase_cycle", ...unknown }],
      ["TIENDA DOBLE", { first_cuota_bills: "next_cycle", ...unknown }],
      ["TIENDA DOBLE", { first_cuota_bills: "next_cycle", ...unknown }],
    ]);
    expect(cardUnbilledMovementsKind.payload.safeParse(payload).success).toBe(true);
  });
});

describe("santanderCardFeedPayload", () => {
  it("merges a card's CLP and USD slides into one card, in slide order", () => {
    const payload = santanderCardFeedPayload(
      file([
        { currency: "CLP", account: "800000000001", rows: [row()] },
        { currency: "USD", account: "800000000001", rows: [row({ Importe: "18,52" })] },
        { currency: "CLP", account: "800000000002", rows: [row()] },
      ])
    );
    expect(payload.cards.map((c) => [c.account.number, c.lines.map((l) => l.currency)])).toEqual([
      ["800000000001", ["clp", "usd"]],
      ["800000000002", ["clp"]],
    ]);
    expect(payload.cards[0]!.account.issuer).toBe("santander");
    expect(cardUnbilledMovementsKind.payload.safeParse(payload).success).toBe(true);
  });

  it("throws on a slide currency it does not recognise", () => {
    expect(() => santanderCardFeedPayload(file([{ currency: "EUR", account: "800000000001", rows: [] }]))).toThrow(
      /want CLP or USD/
    );
  });

  it("reads each card's SALDO INICIAL as its close, zero and credit balances included", () => {
    const payload = santanderCardFeedPayload(
      file([
        { account: "800099990011", currency: "CLP", rows: [], saldoInicial: [saldoInicial("24/09/2026", "1.892.666")] },
        { account: "800099990011", currency: "USD", rows: [], saldoInicial: [saldoInicial("24/09/2026", "0,00")] },
        { account: "800000000077", currency: "CLP", rows: [], saldoInicial: [saldoInicial("24/09/2026", "5.000", "H")] },
      ])
    );
    expect(payload.cards.map((c) => [c.account.number, c.close])).toEqual([
      ["800099990011", { date: "2026-09-24", billed: { clp: 1_892_666, usd: 0 } }],
      ["800000000077", { date: "2026-09-24", billed: { clp: -5_000, usd: null } }],
    ]);
    expect(() =>
      santanderCardFeedPayload(
        file([
          { account: "800099990011", currency: "CLP", rows: [], saldoInicial: [saldoInicial("24/09/2026", "1")] },
          { account: "800099990011", currency: "USD", rows: [], saldoInicial: [saldoInicial("25/08/2026", "1,00")] },
        ])
      )
    ).toThrow(/two closes/);
  });
});

describe("santanderIssuerBalances", () => {
  /** 18 digits, two implied decimals — the bank's own encoding. */
  const cents = (amount: number) => String(Math.round(amount * 100)).padStart(18, "0");
  const cupoRow = (currency: string, total: number, used: number, available = total - used) => ({
    NUMEROCONTRATO: "800099990033",
    NUMEROPAN: "0000000000009933",
    CODIGOMONEDA: currency,
    CUPO: cents(total),
    MONTOUTILIZADO: cents(used),
    MONTODISPONIBLE: cents(available),
    GLOSAESTADO: "VIGENTE",
  });
  const withCupos = (rows: unknown[]) => file([], { cupos: { observedAt: "2026-10-02T00:59:40.000Z", rows } });

  it("reads the bank's 18-digit two-decimal amounts in both currencies", () => {
    expect(santanderIssuerBalances(withCupos([cupoRow("CLP", 5_000_000, 1_234_567), cupoRow("USD", 5_000, 912.34)]))).toEqual({
      status: "observed",
      observed_at: "2026-10-02T00:59:40.000Z",
      rows: [
        { account: { issuer: "santander", number: "800099990033" }, card_last4: "9933", currency: "clp", limit: 5_000_000, used: 1_234_567, available: 3_765_433 },
        { account: { issuer: "santander", number: "800099990033" }, card_last4: "9933", currency: "usd", limit: 5_000, used: 912.34, available: 4_087.66 },
      ],
    });
  });

  it("throws on a row that breaks the bank's identity or a bad amount", () => {
    expect(() => santanderIssuerBalances(withCupos([cupoRow("CLP", 5_000_000, 1_234_567, 3_000_000)]))).toThrow(
      /is not utilizado 1234567 \+ disponible 3000000/
    );
    expect(() => santanderIssuerBalances(withCupos([{ ...cupoRow("CLP", 1, 0), CUPO: "5.000.000" }]))).toThrow(
      /not an 18-digit amount/
    );
  });

  it("reports a session without a summary, and nothing for a file from before the summary", () => {
    expect(santanderIssuerBalances(file([], { cupos: null, cuposError: "no call" }))).toEqual({
      status: "unavailable",
      reason: "no call",
    });
    expect(() => santanderIssuerBalances(file([], { cupos: null }))).toThrow(/no cuposError/);
    expect(santanderIssuerBalances(file([]))).toBeUndefined();
  });
});
