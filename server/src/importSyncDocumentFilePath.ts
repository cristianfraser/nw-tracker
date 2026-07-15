import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDdMmYyToIso } from "./ccInstallmentPayBy.js";
import { monthKeyFromYmd } from "./calendarMonth.js";
import {
  cartolaPeriodRangeCoversMonth,
  isCcStatementPdfSource,
  matrixMonthForCartolaPeriodMonth,
  matrixMonthForCcStatement,
  matrixMonthsForCartolaPeriodRange,
} from "./importSyncDocumentMonth.js";
import {
  ccStatementPdfSearchDirs,
  resolveCfraserCheckingCartolaPdfsDir,
  resolveCfraserCheckingCartolasDir,
  resolveCfraserCuentaVistaCartolaPdfsDir,
  resolveCcStatementSlotDir,
} from "./cfraserPaths.js";
import { cartolaPdfPreferenceScore } from "./cartolaSinMovimientos.js";
import { normalizeCcImportCardLast4 } from "./ccConsolidatedCards.js";
import { db } from "./db.js";
import type { ImportSyncDocumentAccount } from "./importSyncDocumentCoverage.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

export type CartolaParsedPdfJsonEntry = {
  source_file: string;
  period_month: string;
  period_from?: string | null;
  period_to?: string | null;
  parse_status: string;
  movements?: { occurred_on?: string }[];
  cartola_sin_movimientos?: boolean;
};

function basenameOnly(name: string): string {
  const t = String(name ?? "").trim();
  if (!t) return "";
  return t.replace(/^pdf:/, "").split(/[/\\]/).pop() ?? t;
}

function resolveExistingFile(dirs: string[], fileName: string): string | null {
  const base = basenameOnly(fileName);
  if (!base) return null;
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const full = path.join(dir, base);
    if (fs.existsSync(full)) return path.resolve(full);
  }
  if (path.isAbsolute(fileName) && fs.existsSync(fileName)) {
    return path.resolve(fileName);
  }
  return null;
}

function cartolaDirsForKind(kind: ImportSyncDocumentAccount["document_kind"]): string[] {
  if (kind === "cuenta_vista_cartola") {
    return [resolveCfraserCuentaVistaCartolaPdfsDir()];
  }
  return [resolveCfraserCheckingCartolasDir(), resolveCfraserCheckingCartolaPdfsDir()];
}

export function resolveCartolaParsedPdfJsonPath(
  kind: ImportSyncDocumentAccount["document_kind"]
): string {
  const fileName =
    kind === "cuenta_vista_cartola"
      ? "cuenta-vista-cartolas-from-pdf.json"
      : "checking-cartolas-from-pdf.json";
  return path.join(REPO_ROOT, "cfraser", fileName);
}

export function loadCartolaParsedPdfJsonEntries(
  kind: ImportSyncDocumentAccount["document_kind"]
): CartolaParsedPdfJsonEntry[] {
  const jsonPath = resolveCartolaParsedPdfJsonPath(kind);
  if (!fs.existsSync(jsonPath)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  } catch (e) {
    // Corrupt parse output must not read as "no coverage" — fail so the matrix shows the problem.
    throw new Error(
      `corrupt parsed-cartola JSON at ${jsonPath} (re-run the cartola parse): ${
        e instanceof Error ? e.message : String(e)
      }`
    );
  }
  return (raw as { cartolas?: CartolaParsedPdfJsonEntry[] }).cartolas ?? [];
}

/** Build month → PDF path map from parsed cartola JSON entries (testable without disk JSON). */
export function buildCartolaPathsFromParsedPdfEntries(
  entries: CartolaParsedPdfJsonEntry[],
  kind: ImportSyncDocumentAccount["document_kind"]
): Map<string, { path: string; movementCount: number }> {
  const out = new Map<string, { path: string; movementCount: number; score: number }>();
  for (const entry of entries) {
    if (entry.parse_status !== "ok") continue;
    const abs = resolveCartolaFilePath(kind, entry.source_file);
    if (!abs) continue;
    const months = matrixMonthsForCartolaPeriodRange(
      entry.period_from,
      entry.period_to,
      entry.period_month,
      entry.movements
    );
    const byMonth = new Map<string, number>();
    for (const mv of entry.movements ?? []) {
      const ym = monthKeyFromYmd(String(mv.occurred_on ?? ""));
      if (!ym) continue;
      byMonth.set(ym, (byMonth.get(ym) ?? 0) + 1);
    }
    const totalMovements = entry.movements?.length ?? 0;
    for (const ym of months) {
      const movementCount = byMonth.get(ym) ?? 0;
      const candidateScore = cartolaParsedEntryPreferenceScore(
        abs,
        movementCount,
        totalMovements,
        entry.cartola_sin_movimientos === true
      );
      const prev = out.get(ym);
      if (
        !prev ||
        candidateScore > prev.score ||
        (candidateScore === prev.score && movementCount > prev.movementCount)
      ) {
        out.set(ym, { path: abs, movementCount, score: candidateScore });
      }
    }
  }
  return new Map([...out.entries()].map(([ym, row]) => [ym, { path: row.path, movementCount: row.movementCount }]));
}

function cartolaParsedEntryPreferenceScore(
  abs: string,
  movementCount: number,
  totalMovementsInCartola: number,
  parserSinMov: boolean
): number {
  if (totalMovementsInCartola > 0) return 1_000_000 + totalMovementsInCartola;
  if (parserSinMov) return 0;
  return cartolaPdfPreferenceScore(abs, movementCount);
}

function cartolaPathMapPathsOnly(
  map: Map<string, { path: string; movementCount: number }>
): Map<string, string> {
  return new Map([...map.entries()].map(([ym, row]) => [ym, row.path]));
}

/** Parsed cartola PDFs (`parse_status=ok`) on disk — includes zero-movement months. */
export function buildCartolaPathsFromParsedPdfJson(
  kind: ImportSyncDocumentAccount["document_kind"]
): Map<string, string> {
  return cartolaPathMapPathsOnly(
    buildCartolaPathsFromParsedPdfEntries(loadCartolaParsedPdfJsonEntries(kind), kind)
  );
}

function mergeCartolaPathMaps(
  ...maps: Map<string, { path: string; movementCount: number }>[]
): Map<string, string> {
  const out = new Map<string, { path: string; score: number }>();
  for (const map of maps) {
    for (const [ym, row] of map) {
      const score = cartolaPdfPreferenceScore(row.path, row.movementCount);
      const prev = out.get(ym);
      if (!prev || score > prev.score) {
        out.set(ym, { path: row.path, score });
      }
    }
  }
  return new Map([...out.entries()].map(([ym, row]) => [ym, row.path]));
}

export function resolveCartolaFilePath(
  kind: ImportSyncDocumentAccount["document_kind"],
  sourceFile: string
): string | null {
  const raw = String(sourceFile ?? "").trim();
  if (!raw || raw.startsWith("screenshot:")) return null;
  return resolveExistingFile(cartolaDirsForKind(kind), raw);
}

/** Last four digits from `… tarjeta 1234.pdf` or `… tarjeta usd 1234.pdf`. */
export function ccCardLast4FromSourcePdf(sourcePdf: string): string | null {
  const m = String(sourcePdf ?? "").match(/tarjeta(?:\s+usd)?\s+(\d{4})\.pdf$/i);
  return m?.[1] ?? null;
}

function periodToIso(periodTo: string | null | undefined): string | null {
  const t = String(periodTo ?? "").trim();
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  return parseDdMmYyToIso(t);
}

export function isCcUsdStatementRow(row: {
  currency?: string | null;
  layout?: string | null;
}): boolean {
  if (String(row.currency ?? "").toLowerCase() === "usd") return true;
  return String(row.layout ?? "").trim() === "international_usd";
}

export function ccCreditCardAccountHasUsdStatements(accountId: number): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS o FROM cc_statements
       WHERE account_id = ?
         AND (currency = 'usd' OR layout = 'international_usd')
         AND trim(source_pdf) != ''
         AND source_pdf NOT LIKE 'import:web-paste%'
       LIMIT 1`
    )
    .get(accountId);
  return row != null;
}

/** Canonical on-disk basename for a CC statement PDF. */
export function canonicalCcStatementPdfName(
  periodTo: string | null | undefined,
  cardLast4: string,
  opts?: { usd?: boolean }
): string | null {
  const iso = periodToIso(periodTo);
  const last4 = String(cardLast4 ?? "").trim();
  if (!iso || !/^\d{4}$/.test(last4)) return null;
  const mid = opts?.usd ? "estado de cuenta tarjeta usd" : "estado de cuenta tarjeta";
  return `${iso} ${mid} ${last4}.pdf`;
}

/**
 * Target filename under `cfraser/credit-card-statements/<card>/clp|usd/` after import (aligned with
 * `server/scripts/organize-cfraser-statement-pdfs.py` stems).
 */
export function archivedCreditCardStatementPdfFileName(
  row: Record<string, string | undefined>
): string | null {
  const iso = periodToIso(String(row.period_to ?? "").trim());
  const last4 = String(row.card_last4 ?? "").trim();
  if (!iso || !/^\d{4}$/.test(last4)) return null;
  const cur = String(row.currency ?? "").toLowerCase();
  const layout = String(row.parser_layout ?? "").trim();
  const usd = cur === "usd" || layout === "international_usd";
  const mid = usd ? "estado de cuenta tarjeta usd" : "estado de cuenta tarjeta";
  return `${iso} ${mid} ${last4}.pdf`;
}

export class CcStatementPdfPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CcStatementPdfPathError";
  }
}

/** Validate `source_pdf` matches canonical naming for the statement currency and last4. */
export function assertCcStatementSourcePdfBasename(
  sourcePdf: string,
  row: { card_last4?: string | null; currency?: string | null; layout?: string | null }
): void {
  const base = basenameOnly(sourcePdf);
  const last4 = String(row.card_last4 ?? "").trim();
  if (!/^\d{4}$/.test(last4)) {
    throw new CcStatementPdfPathError(
      `cc_statements.source_pdf=${base}: missing card_last4 on statement row`
    );
  }
  const fromName = ccCardLast4FromSourcePdf(base);
  if (!fromName) {
    throw new CcStatementPdfPathError(
      `cc_statements.source_pdf=${base}: basename must end with "tarjeta [usd] ${last4}.pdf"`
    );
  }
  if (fromName !== last4) {
    throw new CcStatementPdfPathError(
      `cc_statements.source_pdf=${base}: last4 in filename (${fromName}) != card_last4 (${last4})`
    );
  }
  const usd = isCcUsdStatementRow(row);
  const hasUsdToken = /\btarjeta\s+usd\s+\d{4}\.pdf$/i.test(base);
  if (usd && !hasUsdToken) {
    throw new CcStatementPdfPathError(
      `cc_statements.source_pdf=${base}: USD statement must use "estado de cuenta tarjeta usd ${last4}.pdf"`
    );
  }
  if (!usd && hasUsdToken) {
    throw new CcStatementPdfPathError(
      `cc_statements.source_pdf=${base}: CLP statement must not include "usd" in the basename`
    );
  }
  if (/\(\d+\)\.pdf$/i.test(base)) {
    throw new CcStatementPdfPathError(
      `cc_statements.source_pdf=${base}: remove numbered copy suffix " (n)" from source_pdf`
    );
  }
}

/** Absolute path when `source_pdf` exists under `<last4>/clp|usd/`; null if missing. */
export function resolveCcStatementPdfPath(
  sourcePdf: string,
  opts: { usd: boolean }
): string | null {
  const t = String(sourcePdf ?? "").trim();
  if (!t || t.startsWith("import:web-paste")) return null;
  const last4 = ccCardLast4FromSourcePdf(t);
  if (!last4) return null;
  return resolveExistingFile(ccStatementPdfSearchDirs(last4, opts.usd), t);
}

/** Like `resolveCcStatementPdfPath` but throws when the file is not on disk. */
export function requireCcStatementPdfPath(
  sourcePdf: string,
  row: {
    card_last4?: string | null;
    currency?: string | null;
    layout?: string | null;
  }
): string {
  assertCcStatementSourcePdfBasename(sourcePdf, row);
  const abs = resolveCcStatementPdfPath(sourcePdf, { usd: isCcUsdStatementRow(row) });
  if (!abs) {
    const last4 = ccCardLast4FromSourcePdf(sourcePdf) ?? String(row.card_last4 ?? "").trim();
    const slotDir = resolveCcStatementSlotDir(
      normalizeCcImportCardLast4(last4),
      isCcUsdStatementRow(row)
    );
    throw new CcStatementPdfPathError(
      `missing PDF for source_pdf=${basenameOnly(sourcePdf)} (expected under ${slotDir})`
    );
  }
  return abs;
}

/** Fail when any imported PDF statement row has invalid `source_pdf` or no on-disk file. */
export function assertAllCcStatementPdfsResolvable(): void {
  const rows = db
    .prepare(
      `SELECT s.id, s.account_id, a.name AS account_name, s.source_pdf, s.currency, s.layout,
              s.card_last4
       FROM cc_statements s
       JOIN accounts a ON a.id = s.account_id
       WHERE trim(s.source_pdf) != ''
         AND s.source_pdf NOT LIKE 'import:web-paste%'
       ORDER BY s.account_id, s.source_pdf`
    )
    .all() as {
    id: number;
    account_id: number;
    account_name: string;
    source_pdf: string;
    currency: string;
    layout: string | null;
    card_last4: string | null;
  }[];

  const errors: string[] = [];
  for (const row of rows) {
    try {
      requireCcStatementPdfPath(row.source_pdf, row);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${row.account_name} (id=${row.id}): ${msg}`);
    }
  }
  if (errors.length === 0) return;
  const sample = errors.slice(0, 8).join("; ");
  const more = errors.length > 8 ? ` (+${errors.length - 8} more)` : "";
  throw new CcStatementPdfPathError(
    `CC statement PDFs not resolvable (${errors.length} rows). ` +
      `Fix source_pdf / card_last4 / on-disk files under credit-card-statements/<last4>/clp|usd/, ` +
      `then run npm run repair:cc-source-pdf -w nw-tracker-server. ${sample}${more}`
  );
}

type CcStmtRow = {
  source_pdf: string;
  currency: string;
  layout?: string | null;
  period_to: string | null;
  card_last4?: string | null;
};

function ccStatementRowHasPdfOnDisk(row: CcStmtRow): boolean {
  try {
    assertCcStatementSourcePdfBasename(row.source_pdf, row);
  } catch {
    return false;
  }
  return resolveCcStatementPdfPath(row.source_pdf, { usd: isCcUsdStatementRow(row) }) != null;
}

function ccRowsForCurrencySlot(
  rows: CcStmtRow[],
  slot: "clp" | "usd" | undefined
): CcStmtRow[] {
  const pdfs = rows.filter((r) => isCcStatementPdfSource(r.source_pdf));
  if (slot == null) return pdfs;
  return pdfs.filter((r) =>
    slot === "usd" ? isCcUsdStatementRow(r) : !isCcUsdStatementRow(r)
  );
}

function pickPrimaryCcStatement(
  rows: CcStmtRow[],
  slot?: "clp" | "usd"
): CcStmtRow | null {
  const pdfs = ccRowsForCurrencySlot(rows, slot);
  if (pdfs.length === 0) return null;
  const candidates =
    slot == null
      ? (() => {
          const clp = pdfs.filter((r) => !isCcUsdStatementRow(r));
          return clp.length > 0 ? clp : pdfs;
        })()
      : pdfs;
  let best: CcStmtRow | null = null;
  let bestHasFile = false;
  for (const row of candidates) {
    const hasFile = ccStatementRowHasPdfOnDisk(row);
    if (!best || (hasFile && !bestHasFile)) {
      best = row;
      bestHasFile = hasFile;
    }
  }
  return best ?? candidates[0] ?? null;
}

/**
 * `row_month` → absolute file path.
 * Cartola: `checking_cartola_imports.period_month` + `source_file`.
 * Tarjeta: month of `credit_card_statements.period_to` + `source_pdf`.
 */
export function buildImportSyncDocumentPathsByMonth(
  account: ImportSyncDocumentAccount
): Map<string, string> {
  if (account.document_kind === "cc_statement") {
    return buildCcDocumentPathsByMonth(
      account.account_id,
      account.cc_statement_currency
    );
  }
  return buildCartolaDocumentPathsByMonth(account.account_id, account.document_kind);
}

function buildCartolaDocumentPathsByMonth(
  accountId: number,
  kind: ImportSyncDocumentAccount["document_kind"]
): Map<string, string> {
  const rows = db
    .prepare(
      `SELECT period_month, source_file, period_from, period_to, movement_count
       FROM checking_cartola_imports WHERE account_id = ?`
    )
    .all(accountId) as {
    period_month: string;
    source_file: string;
    period_from: string | null;
    period_to: string | null;
    movement_count: number;
  }[];

  const fromDb = new Map<string, { path: string; movementCount: number }>();
  for (const row of rows) {
    const abs = resolveCartolaFilePath(kind, row.source_file);
    if (!abs) continue;
    const ym = matrixMonthForCartolaPeriodMonth(row.period_month);
    if (!ym) continue;
    const movementCount = Number(row.movement_count) || 0;
    const prev = fromDb.get(ym);
    if (!prev || movementCount > prev.movementCount) {
      fromDb.set(ym, { path: abs, movementCount });
    }
  }
  const fromJson = buildCartolaPathsFromParsedPdfEntries(
    loadCartolaParsedPdfJsonEntries(kind),
    kind
  );
  return mergeCartolaPathMaps(fromDb, fromJson);
}

function buildCcDocumentMonthsSet(
  accountId: number,
  slot?: "clp" | "usd"
): Set<string> {
  const rows = db
    .prepare(
      `SELECT period_to, source_pdf, currency, layout FROM cc_statements WHERE account_id = ?`
    )
    .all(accountId) as {
    period_to: string | null;
    source_pdf: string;
    currency: string;
    layout?: string | null;
  }[];

  const months = new Set<string>();
  for (const row of rows) {
    if (slot === "usd" && !isCcUsdStatementRow(row)) continue;
    if (slot === "clp" && isCcUsdStatementRow(row)) continue;
    const ym = matrixMonthForCcStatement(row);
    if (ym) months.add(ym);
  }
  return months;
}

function buildCcDocumentPathsByMonth(
  accountId: number,
  slot?: "clp" | "usd"
): Map<string, string> {
  const rows = db
    .prepare(
      `SELECT source_pdf, currency, layout, period_to, card_last4 FROM cc_statements WHERE account_id = ?`
    )
    .all(accountId) as CcStmtRow[];

  const byMonth = new Map<string, CcStmtRow[]>();
  for (const row of rows) {
    if (!isCcStatementPdfSource(row.source_pdf)) continue;
    const ym = matrixMonthForCcStatement(row);
    if (!ym) continue;
    const list = byMonth.get(ym) ?? [];
    list.push(row);
    byMonth.set(ym, list);
  }

  const out = new Map<string, string>();
  for (const [ym, picks] of byMonth) {
    const pick = pickPrimaryCcStatement(picks, slot);
    if (!pick) continue;
    const abs = requireCcStatementPdfPath(pick.source_pdf, pick);
    out.set(ym, abs);
  }
  return out;
}

/** Months with a document row (`period_month` / PDF statement `period_to` month). */
export function buildImportSyncDocumentMonths(
  account: ImportSyncDocumentAccount
): Set<string> {
  if (account.document_kind === "cc_statement") {
    return buildCcDocumentMonthsSet(account.account_id, account.cc_statement_currency);
  }
  const rows = db
    .prepare(
      `SELECT period_month, period_from, period_to FROM checking_cartola_imports WHERE account_id = ?`
    )
    .all(account.account_id) as {
    period_month: string;
    period_from: string | null;
    period_to: string | null;
  }[];
  const months = new Set<string>();
  for (const row of rows) {
    const ym = matrixMonthForCartolaPeriodMonth(row.period_month);
    if (ym) months.add(ym);
  }
  for (const ym of buildCartolaPathsFromParsedPdfJson(account.document_kind).keys()) {
    months.add(ym);
  }
  return months;
}

export function hasImportSyncDocumentForMonth(
  account: ImportSyncDocumentAccount,
  rowMonth: string
): boolean {
  if (account.document_kind === "cc_statement") {
    return buildCcDocumentMonthsSet(account.account_id, account.cc_statement_currency).has(
      rowMonth
    );
  }
  const rows = db
    .prepare(
      `SELECT period_month, period_from, period_to FROM checking_cartola_imports WHERE account_id = ?`
    )
    .all(account.account_id) as {
    period_month: string;
    period_from: string | null;
    period_to: string | null;
  }[];
  for (const row of rows) {
    if (cartolaPeriodRangeCoversMonth(row, rowMonth)) return true;
  }
  return buildCartolaPathsFromParsedPdfJson(account.document_kind).has(rowMonth);
}
