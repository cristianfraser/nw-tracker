import fs from "node:fs";
import path from "node:path";
import { parseDdMmYyToIso } from "./ccInstallmentPayBy.js";
import {
  isCcStatementPdfSource,
  matrixMonthForCartolaPeriodMonth,
  matrixMonthForCcStatement,
} from "./importSyncDocumentMonth.js";
import {
  ccStatementPdfSearchDirs,
  resolveCfraserCheckingCartolaPdfsDir,
  resolveCfraserCheckingCartolasDir,
  resolveCfraserCuentaVistaCartolaPdfsDir,
  resolveCcStatementSlotDir,
} from "./cfraserPaths.js";
import { db } from "./db.js";
import type { ImportSyncDocumentAccount } from "./importSyncDocumentCoverage.js";

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
    const last4 = String(row.card_last4 ?? "").trim();
    const slotDir = resolveCcStatementSlotDir(last4, isCcUsdStatementRow(row));
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
      `SELECT period_month, source_file FROM checking_cartola_imports WHERE account_id = ?`
    )
    .all(accountId) as { period_month: string; source_file: string }[];

  const out = new Map<string, string>();
  for (const row of rows) {
    const ym = matrixMonthForCartolaPeriodMonth(row.period_month);
    if (!ym) continue;
    const abs = resolveCartolaFilePath(kind, row.source_file);
    if (abs) out.set(ym, abs);
  }
  return out;
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
    .prepare(`SELECT period_month FROM checking_cartola_imports WHERE account_id = ?`)
    .all(account.account_id) as { period_month: string }[];
  const months = new Set<string>();
  for (const row of rows) {
    const ym = matrixMonthForCartolaPeriodMonth(row.period_month);
    if (ym) months.add(ym);
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
  const row = db
    .prepare(
      `SELECT 1 AS o FROM checking_cartola_imports
       WHERE account_id = ? AND period_month = ? LIMIT 1`
    )
    .get(account.account_id, rowMonth);
  return row != null;
}
