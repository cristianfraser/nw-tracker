/**
 * Fintual «Acciones» PDFs staged by `fetch:fintual-docs` under `cfraser/fintual-acciones/`
 * (`cartolas/`, `certificados/`) → one `broker.dividend_statement` per document.
 */
import fs from "node:fs";
import path from "node:path";
import type { BrokerDividendStatementPayload } from "nw-tracker-contracts";
import { resolveCfraserDir } from "../paths.js";
import { parseAlpacaMonthlyStatementText, parseFintualAccionesCertificadoText, pdfLayoutText } from "./accionesDocs.js";

export function resolveFintualAccionesDir(): string {
  return path.join(resolveCfraserDir(), "fintual-acciones");
}

export function listFintualAccionesFiles(root = resolveFintualAccionesDir()): { cartolas: string[]; certificados: string[] } {
  const list = (sub: string): string[] => {
    const dir = path.join(root, sub);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((n) => n.toLowerCase().endsWith(".pdf"))
      .sort()
      .map((n) => path.join(dir, n));
  };
  return { cartolas: list("cartolas"), certificados: list("certificados") };
}

/** The payload for one document's layout text (`kind`: which of the two documents it is). */
export function dividendStatementPayload(
  text: string,
  name: string,
  kind: "cartola" | "certificado",
  apply: boolean
): BrokerDividendStatementPayload {
  if (kind === "cartola") {
    const s = parseAlpacaMonthlyStatementText(text);
    return {
      apply,
      broker: "fintual",
      document: { kind: "monthly_statement", name, label: s.period_ym },
      dividends: s.dividends.map((d) => ({
        date: d.trade_date,
        symbol: d.symbol,
        gross: d.gross,
        withholding: d.withholding,
        net: d.net,
        per_share: d.per_share,
        position_qty: d.position_qty,
        record_date: d.record_date,
        withholding_rate_pct: d.withholding_rate_pct,
        // Alpaca's «NRA Withheld» is IRS nonresident-alien withholding.
        withholding_jurisdiction: d.withholding > 0 ? "US" : null,
        tax_country: d.tax_country,
      })),
      interest: s.interest.map((i) => ({ date: i.trade_date, amount: i.amount, description: i.description })),
    };
  }
  const c = parseFintualAccionesCertificadoText(text);
  return {
    apply,
    broker: "fintual",
    document: { kind: "certificate", name, label: c.issued_on },
    // The certificado only says «impuestos»: who withheld is not printed.
    dividends: c.dividends.map((d) => ({
      date: d.date,
      symbol: d.symbol,
      gross: d.gross,
      withholding: d.tax,
      net: d.net,
      per_share: null,
      position_qty: null,
      record_date: null,
      withholding_rate_pct: null,
      withholding_jurisdiction: null,
      tax_country: null,
    })),
    interest: [],
  };
}

export function dividendStatementPayloadForFile(file: string, kind: "cartola" | "certificado", apply: boolean): BrokerDividendStatementPayload {
  return dividendStatementPayload(pdfLayoutText(file), path.basename(file), kind, apply);
}
