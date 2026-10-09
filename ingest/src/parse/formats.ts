import {
  bankAccountMovementsKind,
  bankAccountStatementsKind,
  type FeederParseFormat,
  type FeederParseResult,
} from "nw-tracker-contracts";
import { parseCardStatementPdf } from "../cards/statementPdfParse.js";
import { parseCardWebPaste } from "../cards/webPaste.js";
import { statementFromParsedCartola } from "../santander/cartolas.js";
import { parseCheckingCartolaBuffer } from "../santander/checkingCartolaXlsx.js";
import { isUltimosMovimientosWorkbook, ultimosMovimientosPayload, workbookRows } from "../santander/checkingMovements.js";

/** The file is not what the format reads — the server may try a path of its own. */
export class NotThisFormatError extends Error {
  override name = "NotThisFormatError";
}

/** Every upload format the service reads (`POST /parse/<format>`), to the payload of an ingest kind. */
export const PARSE_FORMATS: Readonly<
  Record<FeederParseFormat, (content: Buffer, filename: string) => FeederParseResult | Promise<FeederParseResult>>
> = {
  "card_statement.pdf": parseCardStatementPdf,
  // Text pasted from a card issuer's web table (a parse-only result: the server knows the card).
  "card.web_paste": parseCardWebPaste,
  // One monthly cuenta corriente cartola, as the account's own import would read it.
  "santander.checking_cartola_xlsx": (content, filename) => {
    const payload = bankAccountStatementsKind.payload.parse({
      account: { issuer: "santander", product: "checking" },
      apply: true,
      force_reimport: false,
      statements: [statementFromParsedCartola(parseCheckingCartolaBuffer(content, filename))],
      unreadable: [],
    });
    return { kind: bankAccountStatementsKind.kind, schema_version: bankAccountStatementsKind.schema_version, payload };
  },
  "santander.checking_xlsx": (content) => {
    const rows = workbookRows(content);
    if (!isUltimosMovimientosWorkbook(rows)) {
      throw new NotThisFormatError("not a Santander «ultimos movimientos» workbook (no Fecha / Detalle header)");
    }
    // A listing with the Fecha / Detalle header that is not the peso account's (the dollar
    // account's «(USD)» headers, no account line) throws a plain error: `unreadable`, not a
    // format the server may try elsewhere.
    const payload = bankAccountMovementsKind.payload.parse(ultimosMovimientosPayload(rows));
    return { kind: bankAccountMovementsKind.kind, schema_version: bankAccountMovementsKind.schema_version, payload };
  },
};
