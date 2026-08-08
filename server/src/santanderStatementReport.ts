import fs from "node:fs";
import path from "node:path";
import { padCcStatementDate } from "./ccStatementJsonSource.js";
import { db } from "./db.js";
import { resolveCfraserCsvDir } from "./cfraserPaths.js";
import { masterAccountIdForSantanderAccount } from "./santanderAccountMap.js";
import {
  internationalRowToLine,
  nationalHeader,
  nationalRowToLine,
  NATIONAL_COD_TXS,
  type SantanderStatementHeader,
  type SantanderStatementLine,
} from "./santanderStatementParse.js";

/** Where `scraper/` stages fetched statement JSON. */
export function resolveSantanderStatementJsonDir(): string {
  return path.join(resolveCfraserCsvDir(), "santander-statement-json");
}

export type ParsedSantanderStatement = {
  file: string;
  currency: "clp" | "usd";
  header: SantanderStatementHeader;
  lines: SantanderStatementLine[];
};

/**
 * Parse one fetched statement file, national or international.
 *
 * The two endpoints use different envelopes and row containers (`Matriz` vs `MATRIZDATOS`); the
 * envelope name is what identifies which currency the file holds.
 */
export function parseSantanderStatementFile(file: string): ParsedSantanderStatement | null {
  const body = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  // Two shapes reach here: the statement files the fetcher stages (the response body itself) and
  // the full request/response records a `--capture` run writes.
  const response = (body.responseBody ?? body) as Record<string, unknown>;
  const data = (response.DATA ?? response) as Record<string, unknown>;
  const [envelopeName, envelope] = Object.entries(data)[0] ?? [];
  if (!envelopeName || typeof envelope !== "object" || envelope === null) return null;
  const output = (envelope as Record<string, unknown>).OUTPUT as Record<string, unknown> | undefined;
  if (!output) return null;

  const respuesta = (output.RESPUESTA ?? {}) as Record<string, unknown>;
  if (/Internacional/i.test(envelopeName)) {
    const rows = Array.isArray(output.MATRIZDATOS) ? output.MATRIZDATOS : [];
    return {
      file: path.basename(file),
      currency: "usd",
      header: { ...nationalHeader(respuesta), statement_date: null },
      lines: rows.map((r) => internationalRowToLine(r as never)),
    };
  }
  const rows = Array.isArray(output.Matriz) ? output.Matriz : [];
  return {
    file: path.basename(file),
    currency: "clp",
    header: nationalHeader(respuesta),
    lines: rows.map((r) => nationalRowToLine(r as never)),
  };
}

type DbLine = { merchant: string; amount: number };

/** `23/7/2026` → `23/07/2026`: stored statement dates are zero-padded. */
export { padCcStatementDate as padCsvDate };

/** Lines already imported for a statement, whichever source wrote it. */
function loadImportedLines(accountId: number, statementDate: string, currency: "clp" | "usd"): DbLine[] | null {
  const statement = db
    .prepare(
      `SELECT id FROM cc_statements
       WHERE account_id = ? AND statement_date = ? AND currency = ?
       ORDER BY id DESC LIMIT 1`
    )
    .get(accountId, padCcStatementDate(statementDate), currency) as { id: number } | undefined;
  if (!statement) return null;
  const rows = db
    .prepare(
      `SELECT merchant, amount_clp, amount_usd FROM cc_statement_lines WHERE statement_id = ?`
    )
    .all(statement.id) as { merchant: string | null; amount_clp: number | null; amount_usd: number | null }[];
  return rows.map((r) => ({
    merchant: normalizeMerchant(r.merchant),
    amount: Number(currency === "usd" ? r.amount_usd ?? 0 : r.amount_clp ?? 0),
  }));
}

function normalizeMerchant(value: string | null): string {
  return String(value ?? "").toUpperCase().replace(/\s+/g, " ").trim();
}

export type StatementDiff = {
  file: string;
  currency: "clp" | "usd";
  statement_date: string | null;
  account_id: number | null;
  json_lines: number;
  db_lines: number | null;
  matched: number;
  only_in_json: { merchant: string; amount: number; cod_txs: string }[];
  only_in_db: { merchant: string; amount: number }[];
  /** JSON-only rows that are expected: the payment row the PDF parser drops by design. */
  expected_only_in_json: number;
};

/**
 * Compare a parsed statement against the same statement already in the ledger.
 *
 * Matching is by merchant + absolute amount rather than by dedupe key, because the two sources use
 * different key spaces — the whole reason this report exists before anything is allowed to write.
 * A clean diff is: `only_in_json` consisting solely of the payment row, and `only_in_db` empty.
 */
export function diffStatementAgainstLedger(
  parsed: ParsedSantanderStatement,
  statementDateOverride?: string | null
): StatementDiff {
  const account = parsed.header.account;
  const accountId = account ? masterAccountIdForSantanderAccount(account) : null;
  // The international endpoint's RESPUESTA carries no dates, so its statement date comes from the
  // national statement of the same facturación.
  const statementDate = parsed.header.statement_date ?? statementDateOverride ?? null;

  const imported = accountId && statementDate ? loadImportedLines(accountId, statementDate, parsed.currency) : null;
  const remaining = new Map<string, number>();
  for (const line of imported ?? []) {
    const key = `${line.merchant}|${Math.abs(line.amount)}`;
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }

  const onlyInJson: StatementDiff["only_in_json"] = [];
  for (const line of parsed.lines) {
    const amount = parsed.currency === "usd" ? line.amount_usd ?? 0 : line.amount_clp ?? 0;
    const key = `${normalizeMerchant(line.merchant)}|${Math.abs(amount)}`;
    const left = remaining.get(key) ?? 0;
    if (left > 0) remaining.set(key, left - 1);
    else onlyInJson.push({ merchant: line.merchant, amount, cod_txs: line.cod_txs });
  }

  const onlyInDb = [...remaining.entries()]
    .filter(([, count]) => count > 0)
    .flatMap(([key, count]) => {
      const [merchant, amount] = key.split("|");
      return Array.from({ length: count }, () => ({ merchant: merchant ?? "", amount: Number(amount) }));
    });

  return {
    file: parsed.file,
    currency: parsed.currency,
    statement_date: statementDate,
    account_id: accountId,
    json_lines: parsed.lines.length,
    db_lines: imported?.length ?? null,
    matched: parsed.lines.length - onlyInJson.length,
    only_in_json: onlyInJson,
    only_in_db: onlyInDb,
    expected_only_in_json: onlyInJson.filter((l) => l.cod_txs === NATIONAL_COD_TXS.PAYMENT).length,
  };
}

/** Every staged statement file, oldest first. */
export function listSantanderStatementFiles(dir = resolveSantanderStatementJsonDir()): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => /estadoCuenta(Nacional|Internacional)\.json$/i.test(name) || /^\d+-extracto-/.test(name))
    .sort()
    .map((name) => path.join(dir, name));
}
