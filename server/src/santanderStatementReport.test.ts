import { describe, expect, it } from "vitest";
import {
  assembleSantanderStatementBatch,
  pairStatementLines,
  parseSantanderStatementBody,
  selectSantanderStatementGroupsToArchive,
  type ParsedSantanderStatement,
  type SantanderStatementGroupOutcomes,
} from "./santanderStatementReport.js";

describe("pairStatementLines", () => {
  it("pairs exact merchant+amount first, then a leftover by amount and merchant prefix", () => {
    const pairing = pairStatementLines(
      [
        { merchant: "MERPAGO*CABIFY", amount: 9851, cod_txs: "001" },
        // The bank's short name; the PDF layout stored it with the glued charge-type column.
        { merchant: "SEG AUTO SANTANDER", amount: 29408, cod_txs: "002" },
      ],
      [
        { merchant: "MERPAGO*CABIFY", amount: 9851 },
        { merchant: "SEG AUTO SANTANDER COMPRAS P.A.T.", amount: 29408 },
      ]
    );
    expect(pairing.matched).toBe(2);
    expect(pairing.matched_by_prefix).toBe(1);
    expect(pairing.only_in_json).toEqual([]);
    expect(pairing.only_in_db).toEqual([]);
  });

  it("never pairs by prefix across a different amount or a longer word", () => {
    const pairing = pairStatementLines(
      [{ merchant: "SEG", amount: 29408, cod_txs: "002" }],
      [
        { merchant: "SEGURO HOGAR", amount: 29408 }, // «SEG» is not a whole-word prefix of «SEGURO»
        { merchant: "SEG AUTO SANTANDER COMPRAS P.A.T.", amount: 29409 }, // amount differs
      ]
    );
    expect(pairing.matched).toBe(0);
    expect(pairing.only_in_json).toHaveLength(1);
    expect(pairing.only_in_db).toHaveLength(2);
  });

  it("pairs a merchant that differs only in rendering: terminal code, punctuation", () => {
    const pairing = pairStatementLines(
      [
        // The JSON keeps the acquirer's terminal code the PDF parse drops…
        { merchant: "VITEST KIOSCO 1234", amount: 12.5, cod_txs: "001" },
        // …and prints «]» where the PDF prints «!».
        { merchant: "VITEST ABC] 12 CENTRO", amount: 1500, cod_txs: "001" },
      ],
      [
        { merchant: "VITEST KIOSCO", amount: 12.5 },
        { merchant: "VITEST ABC! 12 CENTRO", amount: 1500 },
      ]
    );
    expect(pairing.matched).toBe(2);
    expect(pairing.matched_by_prefix).toBe(0);
    expect(pairing.matched_by_rendering).toBe(2);
    expect(pairing.only_in_json).toEqual([]);
    expect(pairing.only_in_db).toEqual([]);
  });

  it("never pairs by rendering across a different amount or different letters", () => {
    const pairing = pairStatementLines(
      [
        { merchant: "VITEST KIOSCO 1234", amount: 12.5, cod_txs: "001" },
        { merchant: "VITEST KIOSCOS", amount: 20, cod_txs: "001" },
      ],
      [
        { merchant: "VITEST KIOSCO", amount: 12.51 }, // amount differs
        { merchant: "VITEST KIOSCO", amount: 20 }, // «KIOSCOS» is another name
      ]
    );
    expect(pairing.matched).toBe(0);
    expect(pairing.only_in_json).toHaveLength(2);
    expect(pairing.only_in_db).toHaveLength(2);
  });

  it("stays one-to-one: two identical JSON rows consume two ledger lines, a third is reported", () => {
    const pairing = pairStatementLines(
      [
        { merchant: "APPLE.COM/BILL", amount: 1390, cod_txs: "001" },
        { merchant: "APPLE.COM/BILL", amount: 1390, cod_txs: "001" },
        { merchant: "APPLE.COM/BILL", amount: 1390, cod_txs: "001" },
      ],
      [
        { merchant: "APPLE.COM/BILL", amount: 1390 },
        { merchant: "APPLE.COM/BILL", amount: 1390 },
      ]
    );
    expect(pairing.matched).toBe(2);
    expect(pairing.only_in_json).toHaveLength(1);
    expect(pairing.only_in_db).toEqual([]);
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
    expect(groups.map((g) => [g.key, g.statement_date])).toEqual([
      [`${ACCOUNT}|022`, "25/8/2026"],
      [`${ACCOUNT}|023`, "24/9/2026"],
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
    expect(usdOnly!.statement_date).toBeNull();
    expect(usdOnly!.international!.extracto).toBe("100");
    expect(clpOnly!.international).toBeNull();
    expect(clpOnly!.statement_date).toBe("24/11/2025");
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
    ).toThrow(/extractos 022 and 024 both close 25\/8\/2026/);
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
    expect(parsed.header.statement_date).toBeNull();
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
