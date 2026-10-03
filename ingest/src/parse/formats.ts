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
import { isUltimosMovimientosWorkbook, parseUltimosMovimientosRows, workbookRows } from "../santander/checkingMovements.js";

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
    const payload = bankAccountMovementsKind.payload.parse({
      account: { issuer: "santander", product: "checking" },
      ...parseUltimosMovimientosRows(rows),
    });
    return { kind: bankAccountMovementsKind.kind, schema_version: bankAccountMovementsKind.schema_version, payload };
  },
};
