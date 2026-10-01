import { describe, expect, it } from "vitest";
import {
  assembleSantanderStatementBatch,
  internationalRowToLine,
  nationalHeader,
  nationalRowToLine,
  originCardLast4FromPan,
  parseSantanderFixed,
  parseSantanderStatementBody,
  santanderIsoDate,
  selectSantanderStatementGroupsToArchive,
  statementGroupPayload,
  type ParsedSantanderStatement,
  type SantanderInternationalRow,
  type SantanderNationalRow,
  type SantanderStatementGroupOutcomes,
} from "./statementJson.js";

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
  it("keeps ISO dates and treats 0001-01-01 as the null sentinel", () => {
    expect(santanderIsoDate("2026-07-01")).toBe("2026-07-01");
    expect(santanderIsoDate("0001-01-01")).toBeNull();
  });

  it("takes the origin card last4 from the masked PAN", () => {
    expect(originCardLast4FromPan("250905#420050781")).toBe("0781");
  });
});

describe("national rows", () => {
  it("uses MontoTxs as the amount for a plain purchase", () => {
    const line = nationalRowToLine(nationalRow());
    expect(line).toMatchObject({ kind: "purchase", amount: 23270, installment: null, card_last4: "0000", transaction_date: "2026-07-01" });
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
    expect(line.kind).toBe("installment");
    // The line bills its cuota; the purchase's total rides with the installment.
    expect(line.amount).toBe(33491);
    expect(line.installment).toEqual({ number: 1, count: 3, cuota_amount: 33491, total_amount: 100474 });
  });

  it("signs each code: the payment and a nota de crédito negative, the bank's charges positive", () => {
    const pay = nationalRowToLine(nationalRow({ CodTxs: "067", NombreComercio: "MONTO CANCELADO", MontoTxs: "0002002346" }));
    expect([pay.kind, pay.amount]).toEqual(["payment", -2002346]);
    const nota = nationalRowToLine(nationalRow({ CodTxs: "510", NombreComercio: "NOTA DE CREDITO", MontoTxs: "0000002140" }));
    expect([nota.kind, nota.amount]).toEqual(["credit_note", -2140]);
    for (const code of ["002", "203", "071", "701"]) {
      const charge = nationalRowToLine(nationalRow({ CodTxs: code, MontoTxs: "0000009882" }));
      expect([charge.kind, charge.amount]).toEqual(["charge", 9882]);
    }
  });

  it("refuses an unknown code: national amounts arrive unsigned", () => {
    expect(() => nationalRowToLine(nationalRow({ CodTxs: "999" }))).toThrow(/unknown national CodTxs "999"/);
  });
});

describe("international rows", () => {
  it("keeps the origin beside the billed USD when the two are equal", () => {
    const line = internationalRowToLine(internationalRow());
    expect(line.amount).toBeCloseTo(123.31, 2);
    expect(line.origin_amount).toBeCloseTo(123.31, 2);
  });

  it("keeps a differing origin as the amount the merchant charged", () => {
    const line = internationalRowToLine(
      internationalRow({ MontoOrigen: "00001299000+", MontoTransaccion: "00000001414+" })
    );
    expect(line.origin_amount).toBeCloseTo(12990, 2);
    expect(line.amount).toBeCloseTo(14.14, 2);
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
    expect(line.kind).toBe("credit");
    expect(line.amount).toBeCloseTo(-258.13, 2);
    expect(line.origin_amount).toBeCloseTo(258.13, 2);
  });

  it("keeps the posting date and reference the national feed lacks", () => {
    const line = internationalRowToLine(internationalRow());
    expect(line.posting_date).toBe("2026-07-06");
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
    expect(header.close).toBe("2026-07-23");
    expect(header.pay_by).toBe("2026-08-10");
    expect(header.deuda_total).toBe(923815);
    expect(header.total_pagos).toBe(2368);
  });
});

// Synthetic Santander account numbers and statement bodies, shaped like the fetched files.
const ACCOUNT = "800000000111";
const OTHER_ACCOUNT = "800000000222";

type Row = { merchant: string; date: string; amount: string };

function nationalBody(
  account: string,
  close: string,
  rows: Row[] = [{ merchant: "VITEST MERCADO", date: "2026-08-10", amount: "0000012345" }]
): Record<string, unknown> {
  return {
    METADATA: { STATUS: "0", DESCRIPCION: "OK" },
    DATA: {
      AS_TIB_WM02_CONEstCtaNacional_Response: {
        INFO: { CODERR: "00", DESERR: "", MSGUSUARIO: "" },
        OUTPUT: {
          RESPUESTA: { Cuenta: account, FechaFactActual: close, FechaFactAnt: "0001-01-01" },
          Matriz: rows.map((r) => ({
            Pan: "000000#000009999",
            NombreComercio: r.merchant,
            FechaTxs: r.date,
            MontoTxs: r.amount,
            NumeroCuotas: "00",
            TotalCuotas: "00",
            MontoCuota: "0000000000",
            TipoCuota: "",
            TasaCompraCuotas: "",
            CodTxs: "000",
            Ciudad: null,
            Microfilm: null,
            GlosaRubroCom: null,
          })),
        },
      },
    },
  };
}

function internationalBody(
  account: string,
  rows: Row[] = [{ merchant: "VITEST STREAMING", date: "2026-08-12", amount: "00000001414+" }]
): Record<string, unknown> {
  return {
    METADATA: { STATUS: "0", DESCRIPCION: "OK" },
    DATA: {
      AS_TIB_WM03_CONEstCtaInternacional_Response: {
        Informacion: { Codigo: "00", Resultado: "", Mensaje: "" },
        OUTPUT: {
          // As on the real endpoint: every header field null but the Cuenta.
          RESPUESTA: { Cuenta: account, Pan: null, FechaFacAct: null, FechaVencimiento: null, DeudaTotal: null },
          MATRIZDATOS: rows.map((r) => ({
            Pan: "000000#000009999",
            NombreComercio: r.merchant,
            FechaTxs: r.date,
            FechaProceso: r.date,
            MontoOrigen: r.amount,
            MontoTransaccion: r.amount,
            CodPais: "US",
            CiudadComercio: null,
            NumeroReferencia: null,
            CodTxs: "000",
          })),
        },
      },
    },
  };
}

type Endpoint = "estadoCuentaNacional" | "estadoCuentaInternacional";

/** A staged file: the response body, named `<Cuenta>-extracto-<NumExtracto>-<endpoint>.json`. */
function staged(account: string, extracto: string, endpoint: Endpoint, body: Record<string, unknown>) {
  const parsed = parseSantanderStatementBody(`/staging/${account}-extracto-${extracto}-${endpoint}.json`, body);
  if (!parsed) throw new Error("fixture is not a statement");
  return parsed;
}

/** A `--capture` record: the request (which carries NumExtracto) beside the response. */
function captureRecord(endpoint: Endpoint, account: string, extracto: string, response: Record<string, unknown>) {
  return {
    endpoint,
    url: `https://api.invalid/${endpoint}`,
    status: 200,
    requestBody: { INPUT: { Cuenta: account, NumExtracto: extracto, NumMov: "0000" } },
    responseBody: response,
  };
}

function captured(file: string, record: Record<string, unknown>): ParsedSantanderStatement {
  const parsed = parseSantanderStatementBody(`/capture/${file}`, record);
  if (!parsed) throw new Error("fixture is not a statement");
  return parsed;
}

describe("assembleSantanderStatementBatch", () => {
  it("dates each international from the national of its own extracto, two closes of one account in one batch", () => {
    const { groups, duplicates } = assembleSantanderStatementBatch([
      staged(ACCOUNT, "022", "estadoCuentaInternacional", internationalBody(ACCOUNT)),
      staged(ACCOUNT, "022", "estadoCuentaNacional", nationalBody(ACCOUNT, "2026-08-25")),
      staged(
        ACCOUNT,
        "023",
        "estadoCuentaInternacional",
        internationalBody(ACCOUNT, [{ merchant: "VITEST HOTEL", date: "2026-09-03", amount: "00000012000+" }])
      ),
      staged(ACCOUNT, "023", "estadoCuentaNacional", nationalBody(ACCOUNT, "2026-09-24")),
    ]);
    expect(duplicates).toEqual([]);
    expect(groups.map((g) => [g.key, g.close])).toEqual([
      [`${ACCOUNT}|022`, "2026-08-25"],
      [`${ACCOUNT}|023`, "2026-09-24"],
    ]);
    const [august, september] = groups;
    expect(august!.international!.file).toBe(`${ACCOUNT}-extracto-022-estadoCuentaInternacional.json`);
    expect(september!.international!.lines[0]!.merchant).toBe("VITEST HOTEL");
    expect(september!.files).toEqual([
      `${ACCOUNT}-extracto-023-estadoCuentaInternacional.json`,
      `${ACCOUNT}-extracto-023-estadoCuentaNacional.json`,
    ]);
  });

  it("leaves an international with no national of the same extracto unpaired and undated", () => {
    // A dormant card: its international endpoint serves an older extracto than its national one.
    const { groups } = assembleSantanderStatementBatch([
      staged(ACCOUNT, "100", "estadoCuentaInternacional", internationalBody(ACCOUNT)),
      staged(ACCOUNT, "105", "estadoCuentaNacional", nationalBody(ACCOUNT, "2025-11-24")),
    ]);
    const [usdOnly, clpOnly] = groups;
    expect(usdOnly!.national).toBeNull();
    expect(usdOnly!.close).toBeNull();
    expect(usdOnly!.international!.extracto).toBe("100");
    expect(clpOnly!.international).toBeNull();
    expect(clpOnly!.close).toBe("2025-11-24");
  });

  it("collapses an identical copy from a retried fetch, keeping both files with the group", () => {
    const { groups, duplicates } = assembleSantanderStatementBatch([
      captured(
        "019-estadoCuentaNacional.json",
        captureRecord("estadoCuentaNacional", ACCOUNT, "105", nationalBody(ACCOUNT, "2025-11-24"))
      ),
      captured(
        "026-estadoCuentaNacional.json",
        captureRecord("estadoCuentaNacional", ACCOUNT, "105", nationalBody(ACCOUNT, "2025-11-24"))
      ),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.national!.file).toBe("019-estadoCuentaNacional.json");
    expect(groups[0]!.files).toEqual(["019-estadoCuentaNacional.json", "026-estadoCuentaNacional.json"]);
    expect(duplicates).toEqual([{ file: "026-estadoCuentaNacional.json", copy_of: "019-estadoCuentaNacional.json" }]);
  });

  it("throws when a pairing is ambiguous", () => {
    const nationalCopy = (file: string, close: string, rows?: Row[]) =>
      captured(file, captureRecord("estadoCuentaNacional", ACCOUNT, "022", nationalBody(ACCOUNT, close, rows)));
    // One extracto, two national closes: which one dates the international twin?
    expect(() =>
      assembleSantanderStatementBatch([
        nationalCopy("019-estadoCuentaNacional.json", "2026-08-25"),
        nationalCopy("031-estadoCuentaNacional.json", "2026-09-24"),
      ])
    ).toThrow(/Two national closes for account 800000000111 extracto 022/);
    // Same close, different rows: two versions of one statement.
    expect(() =>
      assembleSantanderStatementBatch([
        nationalCopy("019-estadoCuentaNacional.json", "2026-08-25"),
        nationalCopy("031-estadoCuentaNacional.json", "2026-08-25", [
          { merchant: "VITEST OTRO", date: "2026-08-11", amount: "0000000990" },
        ]),
      ])
    ).toThrow(/Two different clp statements/);
    // Two statement numbers claiming one close.
    expect(() =>
      assembleSantanderStatementBatch([
        staged(ACCOUNT, "022", "estadoCuentaNacional", nationalBody(ACCOUNT, "2026-08-25")),
        staged(ACCOUNT, "024", "estadoCuentaNacional", nationalBody(ACCOUNT, "2026-08-25")),
      ])
    ).toThrow(/extractos 022 and 024 both close 2026-08-25/);
  });
});

describe("parseSantanderStatementBody", () => {
  it("reads a capture record's extracto from its request", () => {
    const parsed = captured(
      "042-estadoCuentaInternacional.json",
      captureRecord("estadoCuentaInternacional", ACCOUNT, "023", internationalBody(ACCOUNT))
    );
    expect(parsed.extracto).toBe("023");
    expect(parsed.currency).toBe("usd");
    expect(parsed.header.account).toBe(ACCOUNT);
    expect(parsed.header.close).toBeNull();
  });

  it("refuses a statement with no statement number, or one requested for another account", () => {
    // A bare response body under a name that is not a staged one carries no NumExtracto anywhere.
    expect(() =>
      parseSantanderStatementBody("/somewhere/estadoCuentaNacional.json", nationalBody(ACCOUNT, "2026-09-24"))
    ).toThrow(/no statement number/);
    // The scraper stages a request without NumExtracto as extracto-0: no identity either.
    expect(() =>
      parseSantanderStatementBody(
        `/staging/${ACCOUNT}-extracto-0-estadoCuentaNacional.json`,
        nationalBody(ACCOUNT, "2026-09-24")
      )
    ).toThrow(/no statement number/);
    expect(() =>
      captured(
        "042-estadoCuentaInternacional.json",
        captureRecord("estadoCuentaInternacional", OTHER_ACCOUNT, "023", internationalBody(ACCOUNT))
      )
    ).toThrow(/requested for account 800000000222, but the statement is account 800000000111/);
  });

  it("returns null for a response with no statement in it (the bank's error answer)", () => {
    const errorAnswer = {
      METADATA: { STATUS: "0", DESCRIPCION: "OK" },
      DATA: { AS_TIB_WM02_CONEstCtaNacional_Response: { INFO: { CODERR: "16", DESERR: "timeout", MSGUSUARIO: "" } } },
    };
    expect(parseSantanderStatementBody(`/staging/${ACCOUNT}-extracto-023-estadoCuentaNacional.json`, errorAnswer)).toBeNull();
  });
});

describe("selectSantanderStatementGroupsToArchive", () => {
  function pair(account: string, extracto: string, close: string) {
    return [
      staged(account, extracto, "estadoCuentaNacional", nationalBody(account, close)),
      staged(account, extracto, "estadoCuentaInternacional", internationalBody(account)),
    ];
  }

  it("archives a verified superseded facturación, never a dirty one or an account's newest", () => {
    const { groups } = assembleSantanderStatementBatch([
      staged(ACCOUNT, "020", "estadoCuentaInternacional", internationalBody(ACCOUNT)), // unpaired
      ...pair(ACCOUNT, "021", "2026-07-23"),
      ...pair(ACCOUNT, "022", "2026-08-25"),
      ...pair(ACCOUNT, "023", "2026-09-24"),
      ...pair(OTHER_ACCOUNT, "005", "2026-09-20"),
    ]);
    const outcomes = new Map<string, SantanderStatementGroupOutcomes>([
      [`${ACCOUNT}|021`, { clp: "clean", usd: "written" }],
      [`${ACCOUNT}|022`, { clp: "clean", usd: "dirty" }],
      [`${ACCOUNT}|023`, { clp: "clean", usd: "clean" }],
      [`${OTHER_ACCOUNT}|005`, { clp: "clean", usd: "clean" }],
    ]);
    const { archive, keep } = selectSantanderStatementGroupsToArchive(groups, outcomes);
    expect(archive.map((g) => g.key)).toEqual([`${ACCOUNT}|021`]);
    expect(archive[0]!.files).toEqual([
      `${ACCOUNT}-extracto-021-estadoCuentaInternacional.json`,
      `${ACCOUNT}-extracto-021-estadoCuentaNacional.json`,
    ]);
    // 023 and the other account's 005 are their accounts' newest; the unpaired 020 is neither.
    expect(keep.map((g) => g.key)).toEqual([`${ACCOUNT}|022`]);
  });

  it("keeps an unwritten candidate or an unrecorded statement; an empty side does not block", () => {
    const { groups } = assembleSantanderStatementBatch([
      ...pair(ACCOUNT, "030", "2026-01-24"),
      ...pair(ACCOUNT, "031", "2026-02-24"),
      staged(ACCOUNT, "032", "estadoCuentaNacional", nationalBody(ACCOUNT, "2026-03-24")),
      ...pair(ACCOUNT, "033", "2026-04-24"),
      ...pair(ACCOUNT, "034", "2026-05-24"),
    ]);
    const outcomes = new Map<string, SantanderStatementGroupOutcomes>([
      [`${ACCOUNT}|030`, { clp: "clean", usd: "pending" }],
      [`${ACCOUNT}|031`, { clp: "written", usd: "empty" }],
      [`${ACCOUNT}|032`, { clp: "clean" }],
      [`${ACCOUNT}|033`, { clp: "clean" }], // its international was never reviewed
    ]);
    const { archive, keep } = selectSantanderStatementGroupsToArchive(groups, outcomes);
    expect(archive.map((g) => g.extracto)).toEqual(["031", "032"]);
    expect(keep.map((g) => g.extracto)).toEqual(["030", "033"]);
  });
});

describe("statementGroupPayload", () => {
  it("sends both currencies of a facturación, dated and carried by the national side", () => {
    const { groups } = assembleSantanderStatementBatch([
      staged(ACCOUNT, "022", "estadoCuentaNacional", nationalBody(ACCOUNT, "2026-08-25")),
      staged(ACCOUNT, "022", "estadoCuentaInternacional", internationalBody(ACCOUNT)),
    ]);
    const payload = statementGroupPayload(groups[0]!, true)!;
    expect(payload).toMatchObject({ account: { issuer: "santander", number: ACCOUNT }, statement_number: "022", close: "2026-08-25", apply: true });
    expect(payload.statements.map((s) => [s.currency, s.document, s.lines.length])).toEqual([
      ["clp", `${ACCOUNT}-extracto-022-estadoCuentaNacional.json`, 1],
      ["usd", `${ACCOUNT}-extracto-022-estadoCuentaInternacional.json`, 1],
    ]);
    expect(payload.statements[1]!.billed_total).toBeNull();
  });

  it("sends nothing for an international with no national twin", () => {
    const { groups } = assembleSantanderStatementBatch([staged(ACCOUNT, "100", "estadoCuentaInternacional", internationalBody(ACCOUNT))]);
    expect(statementGroupPayload(groups[0]!, false)).toBeNull();
  });
});
