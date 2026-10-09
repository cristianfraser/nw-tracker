import XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import { bankAccountMovementsKind } from "nw-tracker-contracts";
import { NotThisFormatError, PARSE_FORMATS } from "../parse/formats.js";
import { formatCheckingFileSummary, santanderCheckingMovementsPayload } from "./checkingMovements.js";

function workbook(rows: unknown[][]): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows));
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

const HEADER = ["Fecha", "Detalle", "Monto cargo ($)", "Monto abono ($)", "Saldo ($)"];
// Synthetic, formatted as the bank prints it; the payload carries its digits.
const ACCOUNT_LINE = ["Cuenta Corriente: 0-099-00-11223-3"];
const ACCOUNT_NUMBER = "009900112233";

describe("santanderCheckingMovementsPayload", () => {
  it("reads cargos as debits and abonos as credits, with the document number that leads a row", () => {
    const payload = santanderCheckingMovementsPayload(
      workbook([
        ["Holder Name"],
        ACCOUNT_LINE,
        HEADER,
        ["29-09-2026", "0012345678  Transf a   Fintual", "$ 150.000", ""],
        ["30-09-2026", "Remuneracion", "", "1.234.567"],
        // Posted on the next workday after the 14:00 cutoff: a date after today is the bank's own.
        ["01-10-2026", "Transferencia de Tercero", "", "50.000"],
      ])
    );
    expect(bankAccountMovementsKind.payload.safeParse(payload).success).toBe(true);
    expect(payload).toEqual({
      account: { issuer: "santander", product: "checking", number: ACCOUNT_NUMBER },
      movements: [
        { date: "2026-09-29", description: "0012345678 Transf a Fintual", currency: "clp", amount: -150000, document_no: "0012345678" },
        { date: "2026-09-30", description: "Remuneracion", currency: "clp", amount: 1234567, document_no: null },
        { date: "2026-10-01", description: "Transferencia de Tercero", currency: "clp", amount: 50000, document_no: null },
      ],
      rejected_rows: [],
    });
  });

  it("drops a row repeated in the same download and reports rows it cannot read", () => {
    const payload = santanderCheckingMovementsPayload(
      workbook([
        ACCOUNT_LINE,
        HEADER,
        ["29-09-2026", "Compra", "1.000", ""],
        ["29-09-2026", "Compra", "1.000", ""],
        ["2026-09-29", "Otra", "2.000", ""],
        ["30-09-2026", "Sin monto", "", ""],
      ])
    );
    expect(payload.movements).toHaveLength(1);
    expect(payload.rejected_rows).toEqual(["Fila 5: fecha inválida (2026-09-29)", "Fila 6: sin monto cargo ni abono (Sin monto)"]);
  });

  it("refuses a workbook without the Fecha / Detalle header", () => {
    expect(() => santanderCheckingMovementsPayload(workbook([["Fecha", "Monto"]]))).toThrow(/Not a Santander/);
  });

  it("refuses the dollar account's workbook (USD amount headers) instead of sending its rows as pesos", () => {
    expect(() =>
      santanderCheckingMovementsPayload(
        workbook([
          ["Holder Name"],
          ["Cuenta Corriente: 0-099-00-44556-6"],
          ["Fecha", "Detalle", "Monto cargo (USD)", "Monto abono (USD)", "Saldo (USD)"],
          ["29-09-2026", "Abono", "", "1.000,50"],
        ])
      )
    ).toThrow(/Not the peso cuenta corriente.*Monto cargo \(USD\)/);
  });

  it("refuses a workbook that names no account number above its header", () => {
    expect(() => santanderCheckingMovementsPayload(workbook([["Holder Name"], HEADER, ["29-09-2026", "Compra", "1.000", ""]]))).toThrow(
      /names no account number/
    );
    expect(() => santanderCheckingMovementsPayload(workbook([["Cuenta Corriente: "], HEADER, ["29-09-2026", "Compra", "1.000", ""]]))).toThrow(
      /names no account number/
    );
  });
});

describe("the upload format", () => {
  it("answers the payload of bank_account.movements, or not_this_format", () => {
    const parse = PARSE_FORMATS["santander.checking_xlsx"];
    const ok = parse(workbook([ACCOUNT_LINE, HEADER, ["29-09-2026", "Compra", "1.000", ""]]), "u.xlsx");
    expect(ok).toMatchObject({ kind: "bank_account.movements", schema_version: 1, payload: { account: { number: ACCOUNT_NUMBER } } });
    expect(() => parse(workbook([["CARTOLA"], ["Saldo"]]), "cartola.xlsx")).toThrow(NotThisFormatError);
    // The dollar account's listing has the header but is not this account: unreadable, not another format.
    const usdHeader = ["Fecha", "Detalle", "Monto cargo (USD)", "Monto abono (USD)", "Saldo (USD)"];
    expect(() => parse(workbook([ACCOUNT_LINE, usdHeader, ["29-09-2026", "Compra", "1,00", ""]]), "u.xlsx")).toThrow(/Not the peso/);
    expect(() => parse(workbook([ACCOUNT_LINE, usdHeader]), "u.xlsx")).not.toThrow(NotThisFormatError);
  });
});

describe("formatCheckingFileSummary", () => {
  const details = {
    account_id: 22,
    batch_id: 9,
    inserted: 1,
    skipped_duplicate: 6,
    skipped_superseded_by_cartola: 0,
    skipped_superseded_by_transfer: 1,
    skipped_superseded_by_mail: 0,
    inserted_flows: [],
    skipped_flows: [],
  };
  it("prints every non-zero skip reason", () => {
    expect(formatCheckingFileSummary("ultimos.xlsx", details, null)).toBe(
      "ultimos.xlsx: 8 row(s) parsed, 1 inserted, 6 duplicate(s), 1 superseded by transfer"
    );
    expect(formatCheckingFileSummary("ultimos.xlsx", { ...details, skipped_superseded_by_transfer: 0 }, "/tmp/a.xlsx")).toBe(
      "ultimos.xlsx: 7 row(s) parsed, 1 inserted, 6 duplicate(s); archived /tmp/a.xlsx"
    );
  });
});
