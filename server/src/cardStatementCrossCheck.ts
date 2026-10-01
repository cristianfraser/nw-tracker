import type { CardStatementCurrency, CardStatementLine } from "nw-tracker-contracts";
import { padCcStatementDate } from "./ccStatementJsonSource.js";
import { db } from "./db.js";

/**
 * The cross-check of a `card.statement` against the statement already in the ledger: which lines
 * of each source pair up. The importer runs it on every close a PDF owns (the report that has
 * already caught real PDF data loss) and after every write it makes.
 */

type DbLine = { merchant: string; amount: number };

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

/**
 * A merchant as both renderings agree on it: the JSON keeps an Argentine acquirer's terminal code
 * that the PDF parse drops («KIOSCO 1234» / «KIOSCO») and renders some punctuation differently
 * («ABC] 12 CENTRO» / «ABC! 12 CENTRO»).
 */
function merchantRenderingKey(value: string): string {
  return normalizeMerchant(value)
    .replace(/ \d{4}$/, "")
    .replace(/[^A-Z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export type StatementDiff = {
  file: string;
  currency: "clp" | "usd";
  statement_date: string;
  account_id: number;
  json_lines: number;
  db_lines: number | null;
  /** Lines paired with a ledger line — exact merchant + amount, plus the prefix pairs below. */
  matched: number;
  /** Of `matched`, those paired only by amount + merchant prefix (see `pairStatementLines`). */
  matched_by_prefix: number;
  /** Of `matched`, those paired by amount + a merchant differing only in rendering. */
  matched_by_rendering: number;
  only_in_json: StatementJsonLine[];
  only_in_db: { merchant: string; amount: number }[];
  /** JSON-only rows that are expected: the payment row the PDF parser drops by design. */
  expected_only_in_json: number;
};

export type StatementJsonLine = { merchant: string; amount: number; kind: CardStatementLine["kind"] };

export type StatementLinePairing = {
  matched: number;
  matched_by_prefix: number;
  matched_by_rendering: number;
  only_in_json: StatementJsonLine[];
  only_in_db: DbLine[];
};

/**
 * Pair the JSON rows with the ledger lines. First pass: normalized merchant + absolute amount,
 * one-to-one. Second pass, for what is left: the PDF layout can glue the charge-type column onto
 * the merchant — «SEG AUTO SANTANDER COMPRAS P.A.T.» for the JSON's «SEG AUTO SANTANDER», the
 * same 2x.xxx the same day — so a leftover JSON row pairs with a leftover ledger line of the same
 * amount whose merchant begins with the JSON merchant followed by a space. Third pass: the same
 * amount and the same {@link merchantRenderingKey} (a terminal code only the JSON prints,
 * punctuation). Still one-to-one, and the second and third passes are reported apart
 * (`matched_by_prefix`, `matched_by_rendering`) so the diff stays honest about each pairing.
 */
export function pairStatementLines(
  jsonLines: readonly StatementJsonLine[],
  dbLines: readonly DbLine[]
): StatementLinePairing {
  const remaining = new Map<string, number>();
  for (const line of dbLines) {
    const key = `${line.merchant}|${Math.abs(line.amount)}`;
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }

  const leftover: StatementJsonLine[] = [];
  for (const line of jsonLines) {
    const key = `${normalizeMerchant(line.merchant)}|${Math.abs(line.amount)}`;
    const left = remaining.get(key) ?? 0;
    if (left > 0) remaining.set(key, left - 1);
    else leftover.push(line);
  }

  let matchedByPrefix = 0;
  const unprefixed: StatementJsonLine[] = [];
  for (const line of leftover) {
    const merchant = normalizeMerchant(line.merchant);
    const amount = Math.abs(line.amount);
    const candidate = [...remaining.entries()].find(([key, count]) => {
      if (count <= 0) return false;
      const sep = key.lastIndexOf("|");
      return Number(key.slice(sep + 1)) === amount && key.slice(0, sep).startsWith(`${merchant} `);
    });
    if (candidate) {
      remaining.set(candidate[0], candidate[1] - 1);
      matchedByPrefix += 1;
    } else {
      unprefixed.push(line);
    }
  }

  let matchedByRendering = 0;
  const onlyInJson: StatementJsonLine[] = [];
  for (const line of unprefixed) {
    const rendering = merchantRenderingKey(line.merchant);
    const amount = Math.abs(line.amount);
    const candidate = [...remaining.entries()].find(([key, count]) => {
      if (count <= 0 || rendering === "") return false;
      const sep = key.lastIndexOf("|");
      return Number(key.slice(sep + 1)) === amount && merchantRenderingKey(key.slice(0, sep)) === rendering;
    });
    if (candidate) {
      remaining.set(candidate[0], candidate[1] - 1);
      matchedByRendering += 1;
    } else {
      onlyInJson.push(line);
    }
  }

  const onlyInDb = [...remaining.entries()]
    .filter(([, count]) => count > 0)
    .flatMap(([key, count]) => {
      const sep = key.lastIndexOf("|");
      return Array.from({ length: count }, () => ({ merchant: key.slice(0, sep), amount: Number(key.slice(sep + 1)) }));
    });

  return {
    matched: jsonLines.length - onlyInJson.length,
    matched_by_prefix: matchedByPrefix,
    matched_by_rendering: matchedByRendering,
    only_in_json: onlyInJson,
    only_in_db: onlyInDb,
  };
}

/**
 * Compare one currency of a `card.statement` against the same statement already in the ledger.
 *
 * Matching is by merchant + absolute amount rather than by dedupe key, because the two sources use
 * different key spaces. A clean diff is: `only_in_json` consisting solely of the payment row (the
 * PDF parser drops it by design — its amount lives in the header), and `only_in_db` empty. A cuota
 * line is compared at its purchase's total, as the PDF stores it.
 */
export function diffStatementAgainstLedger(
  accountId: number,
  statementDate: string,
  statement: Pick<CardStatementCurrency, "currency" | "document" | "lines">
): StatementDiff {
  const imported = loadImportedLines(accountId, statementDate, statement.currency);
  const jsonLines: StatementJsonLine[] = statement.lines.map((line) => ({
    merchant: line.merchant,
    amount: line.installment ? line.installment.total_amount : line.amount,
    kind: line.kind,
  }));
  const pairing = pairStatementLines(jsonLines, imported ?? []);
  return {
    file: statement.document,
    currency: statement.currency,
    statement_date: statementDate,
    account_id: accountId,
    json_lines: statement.lines.length,
    db_lines: imported?.length ?? null,
    matched: pairing.matched,
    matched_by_prefix: pairing.matched_by_prefix,
    matched_by_rendering: pairing.matched_by_rendering,
    only_in_json: pairing.only_in_json,
    only_in_db: pairing.only_in_db,
    expected_only_in_json: pairing.only_in_json.filter((l) => statement.currency === "clp" && l.kind === "payment").length,
  };
}
