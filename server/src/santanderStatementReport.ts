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

/** Where `ingest/` stages fetched statement JSON. */
export function resolveSantanderStatementJsonDir(): string {
  return path.join(resolveCfraserCsvDir(), "santander-statement-json");
}

export type ParsedSantanderStatement = {
  file: string;
  currency: "clp" | "usd";
  /** The statement number (NumExtracto) the request asked for. Both currencies of one
   * facturación share it (021/021, 022/022, …), which is what pairs them. */
  extracto: string;
  header: SantanderStatementHeader;
  lines: SantanderStatementLine[];
};

/** `<Cuenta>-extracto-<NumExtracto>-estadoCuenta….json` — how `ingest/` names a staged statement. */
const STAGED_FILE_IDENTITY = /^(\d+)-extracto-(\d+)-/;

/**
 * The account and statement number a file's request asked for. A `--capture` record carries the
 * request itself (`requestBody.INPUT`); a staged file carries both in its name. The scraper names
 * a statement `extracto-0` when its request had no NumExtracto, so a staged 0 is no identity.
 */
function statementRequestIdentity(
  file: string,
  body: Record<string, unknown>
): { account: string | null; extracto: string } {
  const request = body.requestBody;
  const input =
    typeof request === "object" && request !== null
      ? ((request as Record<string, unknown>).INPUT as Record<string, unknown> | undefined)
      : undefined;
  const requested = String(input?.NumExtracto ?? "").trim();
  if (requested) {
    if (!/^\d+$/.test(requested)) {
      throw new Error(`${path.basename(file)}: unexpected NumExtracto "${requested}" in the request`);
    }
    return { account: String(input?.Cuenta ?? "").trim() || null, extracto: requested };
  }
  const staged = STAGED_FILE_IDENTITY.exec(path.basename(file));
  if (staged && staged[2] !== "0") return { account: staged[1]!, extracto: staged[2]! };
  throw new Error(
    `${path.basename(file)}: no statement number — neither requestBody.INPUT.NumExtracto (a --capture ` +
      `record) nor a staged "<Cuenta>-extracto-<NumExtracto>-" name. A facturación's two currencies ` +
      `pair on it; the international file carries no close of its own to pair on instead.`
  );
}

/**
 * Parse one fetched statement body, national or international. Null when the body is not a
 * statement response (no envelope or no OUTPUT — the bank's error answer, for one).
 *
 * The two endpoints use different envelopes and row containers (`Matriz` vs `MATRIZDATOS`); the
 * envelope name is what identifies which currency the file holds.
 */
export function parseSantanderStatementBody(
  file: string,
  body: Record<string, unknown>
): ParsedSantanderStatement | null {
  // Two shapes reach here: the statement files the fetcher stages (the response body itself) and
  // the full request/response records a `--capture` run writes.
  const response = (body.responseBody ?? body) as Record<string, unknown>;
  const data = (response.DATA ?? response) as Record<string, unknown>;
  const [envelopeName, envelope] = Object.entries(data)[0] ?? [];
  if (!envelopeName || typeof envelope !== "object" || envelope === null) return null;
  const output = (envelope as Record<string, unknown>).OUTPUT as Record<string, unknown> | undefined;
  if (!output) return null;

  const respuesta = (output.RESPUESTA ?? {}) as Record<string, unknown>;
  const international = /Internacional/i.test(envelopeName);
  const header = international
    ? { ...nationalHeader(respuesta), statement_date: null }
    : nationalHeader(respuesta);
  // Both RESPUESTA blocks carry the Cuenta (the international one little else); it keys the pair.
  if (!header.account) {
    throw new Error(
      `${path.basename(file)}: the statement header carries no Cuenta — it cannot be paired or resolved`
    );
  }
  const identity = statementRequestIdentity(file, body);
  if (identity.account != null && identity.account !== header.account) {
    throw new Error(
      `${path.basename(file)}: requested for account ${identity.account}, but the statement is account ${header.account}`
    );
  }

  if (international) {
    const rows = Array.isArray(output.MATRIZDATOS) ? output.MATRIZDATOS : [];
    return {
      file: path.basename(file),
      currency: "usd",
      extracto: identity.extracto,
      header,
      lines: rows.map((r) => internationalRowToLine(r as never)),
    };
  }
  const rows = Array.isArray(output.Matriz) ? output.Matriz : [];
  return {
    file: path.basename(file),
    currency: "clp",
    extracto: identity.extracto,
    header,
    lines: rows.map((r) => nationalRowToLine(r as never)),
  };
}

/** Parse one fetched statement file (see `parseSantanderStatementBody`). */
export function parseSantanderStatementFile(file: string): ParsedSantanderStatement | null {
  const body = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  return parseSantanderStatementBody(file, body);
}

/** One facturación as fetched: the national and international statements of an (account, extracto). */
export type SantanderStatementGroup = {
  /** `${account}|${extracto}` */
  key: string;
  account: string;
  extracto: string;
  national: ParsedSantanderStatement | null;
  /** Null when the facturación had no USD side fetched; with no `national`, it is undatable. */
  international: ParsedSantanderStatement | null;
  /** The national close (`d/m/yyyy`), which dates the international twin too. */
  statement_date: string | null;
  /** Every file behind the group, identical copies included — what archiving moves. */
  files: string[];
};

export type SantanderStatementBatch = {
  /** One group per (account, extracto), by account, then extracto (oldest first). */
  groups: SantanderStatementGroup[];
  /** Identical copies of a statement already in the batch (a retried fetch in a capture dir). */
  duplicates: { file: string; copy_of: string }[];
};

function collapseStatementCopies(
  copies: readonly ParsedSantanderStatement[],
  duplicates: SantanderStatementBatch["duplicates"]
): ParsedSantanderStatement | null {
  const [first, ...rest] = copies;
  if (!first) return null;
  const content = (s: ParsedSantanderStatement) => JSON.stringify({ header: s.header, lines: s.lines });
  for (const copy of rest) {
    if (copy.header.statement_date !== first.header.statement_date) {
      throw new Error(
        `Two national closes for account ${first.header.account} extracto ${first.extracto} ` +
          `(${first.header.statement_date} in ${first.file} vs ${copy.header.statement_date} in ${copy.file}) — ` +
          `the international twin cannot be dated`
      );
    }
    if (content(copy) !== content(first)) {
      throw new Error(
        `Two different ${first.currency} statements for account ${first.header.account} extracto ` +
          `${first.extracto} (${first.file}, ${copy.file}) — refusing to pick one`
      );
    }
    duplicates.push({ file: copy.file, copy_of: first.file });
  }
  return first;
}

/**
 * Pair a batch of parsed statements into facturaciones by (account, extracto).
 *
 * The international response has no dates (its RESPUESTA is all nulls but the Cuenta), so it is
 * dated from the national statement of the SAME extracto — never from whatever national the
 * account happens to have in the batch: the staging dir keeps every facturación until it is
 * archived, and a dormant card's international endpoint serves an older extracto than its
 * national one (USD 100 beside CLP 105 on the retired card). An international without its twin
 * comes back as a group with no `national`, for the caller to report. Throws only when a pairing
 * is ambiguous: two different copies of one statement, or two extractos claiming one close.
 */
export function assembleSantanderStatementBatch(
  statements: readonly ParsedSantanderStatement[]
): SantanderStatementBatch {
  type Entry = { account: string; extracto: string; clp: ParsedSantanderStatement[]; usd: ParsedSantanderStatement[] };
  const byKey = new Map<string, Entry>();
  for (const statement of statements) {
    const key = `${statement.header.account}|${statement.extracto}`;
    const entry = byKey.get(key) ?? { account: statement.header.account, extracto: statement.extracto, clp: [], usd: [] };
    entry[statement.currency].push(statement);
    byKey.set(key, entry);
  }

  const duplicates: SantanderStatementBatch["duplicates"] = [];
  const groups: SantanderStatementGroup[] = [];
  for (const [key, entry] of byKey) {
    const national = collapseStatementCopies(entry.clp, duplicates);
    groups.push({
      key,
      account: entry.account,
      extracto: entry.extracto,
      national,
      international: collapseStatementCopies(entry.usd, duplicates),
      statement_date: national?.header.statement_date ?? null,
      files: [...entry.clp, ...entry.usd].map((s) => s.file).sort(),
    });
  }
  groups.sort((a, b) =>
    a.account !== b.account ? (a.account < b.account ? -1 : 1) : Number(a.extracto) - Number(b.extracto)
  );

  // Writes and ownership are per (account, close): two statement numbers for one close would
  // write the same facturación twice, each copy overwriting the other.
  const extractoByClose = new Map<string, string>();
  for (const group of groups) {
    if (!group.statement_date) continue;
    const closeKey = `${group.account}|${padCcStatementDate(group.statement_date)}`;
    const other = extractoByClose.get(closeKey);
    if (other != null) {
      throw new Error(
        `Account ${group.account}: extractos ${other} and ${group.extracto} both close ${group.statement_date} — ` +
          `which one is the facturación is ambiguous`
      );
    }
    extractoByClose.set(closeKey, group.extracto);
  }
  return { groups, duplicates };
}

/**
 * What the importer made of one statement of a group:
 *  - `clean`: PDF-owned, and the cross-check reconciles
 *  - `written`: written from the JSON, and the post-write check reconciles
 *  - `pending`: a write candidate a report run leaves unwritten
 *  - `empty`: no rows, nothing to check or import
 *  - `skipped`: not imported on purpose (a stale USD echo)
 *  - `dirty`: any problem the report flagged
 */
export type SantanderStatementOutcome = "clean" | "written" | "pending" | "empty" | "skipped" | "dirty";

export type SantanderStatementGroupOutcomes = Partial<Record<"clp" | "usd", SantanderStatementOutcome>>;

/**
 * Which superseded facturaciones can leave the staging dir.
 *
 * A group is superseded when a newer extracto of its account is in the batch — the newest one is
 * what the scraper re-fetches (and overwrites) every night, so it always stays. A superseded
 * group is archived only when every statement it holds is verified (`clean` or `written`) or
 * `empty`, and at least one is verified; anything else — a dirty diff, an unwritten candidate,
 * an outcome never recorded — keeps it in place (`keep`). An international-only group is never
 * archived: it cannot be dated, so it is never verified (the caller reports it as unpaired).
 */
export function selectSantanderStatementGroupsToArchive(
  groups: readonly SantanderStatementGroup[],
  outcomes: ReadonlyMap<string, SantanderStatementGroupOutcomes>
): { archive: SantanderStatementGroup[]; keep: SantanderStatementGroup[] } {
  const newestByAccount = new Map<string, number>();
  for (const group of groups) {
    newestByAccount.set(group.account, Math.max(newestByAccount.get(group.account) ?? -1, Number(group.extracto)));
  }
  const archive: SantanderStatementGroup[] = [];
  const keep: SantanderStatementGroup[] = [];
  for (const group of groups) {
    if (Number(group.extracto) === newestByAccount.get(group.account) || !group.national) continue;
    const recorded = outcomes.get(group.key) ?? {};
    const statuses = group.international ? [recorded.clp, recorded.usd] : [recorded.clp];
    const verified = (s: SantanderStatementOutcome | undefined) => s === "clean" || s === "written";
    const archivable = statuses.every((s) => verified(s) || s === "empty") && statuses.some(verified);
    (archivable ? archive : keep).push(group);
  }
  return { archive, keep };
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
  statement_date: string | null;
  account_id: number | null;
  json_lines: number;
  db_lines: number | null;
  /** Lines paired with a ledger line — exact merchant + amount, plus the prefix pairs below. */
  matched: number;
  /** Of `matched`, those paired only by amount + merchant prefix (see `pairStatementLines`). */
  matched_by_prefix: number;
  /** Of `matched`, those paired by amount + a merchant differing only in rendering. */
  matched_by_rendering: number;
  only_in_json: { merchant: string; amount: number; cod_txs: string }[];
  only_in_db: { merchant: string; amount: number }[];
  /** JSON-only rows that are expected: the payment row the PDF parser drops by design. */
  expected_only_in_json: number;
};

export type StatementJsonLine = { merchant: string; amount: number; cod_txs: string };

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
  const jsonLines: StatementJsonLine[] = parsed.lines.map((line) => ({
    merchant: line.merchant,
    amount: parsed.currency === "usd" ? line.amount_usd ?? 0 : line.amount_clp ?? 0,
    cod_txs: line.cod_txs,
  }));
  const pairing = pairStatementLines(jsonLines, imported ?? []);

  return {
    file: parsed.file,
    currency: parsed.currency,
    statement_date: statementDate,
    account_id: accountId,
    json_lines: parsed.lines.length,
    db_lines: imported?.length ?? null,
    matched: pairing.matched,
    matched_by_prefix: pairing.matched_by_prefix,
    matched_by_rendering: pairing.matched_by_rendering,
    only_in_json: pairing.only_in_json,
    only_in_db: pairing.only_in_db,
    expected_only_in_json: pairing.only_in_json.filter((l) => l.cod_txs === NATIONAL_COD_TXS.PAYMENT).length,
  };
}

/** Every staged statement file, oldest first. Top level only: `archive/` is never re-read. */
export function listSantanderStatementFiles(dir = resolveSantanderStatementJsonDir()): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => /estadoCuenta(Nacional|Internacional)\.json$/i.test(name) || /^\d+-extracto-/.test(name))
    .sort()
    .map((name) => path.join(dir, name));
}
