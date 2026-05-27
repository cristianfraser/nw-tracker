import fs from "node:fs";
import path from "node:path";
import { parseDdMmYyToIso } from "./ccInstallmentPayBy.js";
import { monthKeyFromYmd } from "./calendarMonth.js";
import {
  isCcStatementPdfSource,
  matrixMonthForCartolaPeriodMonth,
  matrixMonthForCcStatement,
} from "./importSyncDocumentMonth.js";
import {
  resolveCfraserCheckingCartolaPdfsDir,
  resolveCfraserCheckingCartolasDir,
  resolveCfraserCuentaVistaCartolaPdfsDir,
  resolveCfraserPdfsDir,
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

export type ResolveCcStatementPdfOpts = {
  /** Billing `period_to` (ISO or DD/MM/YYYY). Used to find renamed on-disk PDFs. */
  periodTo?: string | null;
};

/** Last four digits from `… tarjeta 1234.pdf`. */
export function ccCardLast4FromSourcePdf(sourcePdf: string): string | null {
  const m = String(sourcePdf ?? "").match(/tarjeta\s+(\d{4})\.pdf$/i);
  return m?.[1] ?? null;
}

function periodToIso(periodTo: string | null | undefined): string | null {
  const t = String(periodTo ?? "").trim();
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  return parseDdMmYyToIso(t);
}

/** On-disk name after BCI parse rename (`period_to` date prefix). */
export function canonicalCcStatementPdfName(
  periodTo: string | null | undefined,
  cardLast4: string
): string | null {
  const iso = periodToIso(periodTo);
  const last4 = String(cardLast4 ?? "").trim();
  if (!iso || !/^\d{4}$/.test(last4)) return null;
  return `${iso} estado de cuenta tarjeta ${last4}.pdf`;
}

/**
 * Target filename under `cfraser/credit-card-statements/` after import (aligned with
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

function resolveCcPdfInMonthPrefix(
  dir: string,
  rowMonth: string,
  cardLast4: string
): string | null {
  if (!/^\d{4}-\d{2}$/.test(rowMonth) || !/^\d{4}$/.test(cardLast4)) return null;
  const prefix = `${rowMonth}-`;
  const suffix = ` estado de cuenta tarjeta ${cardLast4}.pdf`;
  let bestName: string | null = null;
  for (const name of fs.readdirSync(dir)) {
    if (!name.toLowerCase().endsWith(".pdf")) continue;
    if (!name.startsWith(prefix) || !name.endsWith(suffix)) continue;
    if (!bestName || name > bestName) bestName = name;
  }
  return bestName ? path.resolve(dir, bestName) : null;
}

export function resolveCcStatementPdfPath(
  sourcePdf: string,
  opts?: ResolveCcStatementPdfOpts
): string | null {
  const t = String(sourcePdf ?? "").trim();
  if (!t || t.startsWith("import:web-paste")) return null;
  const dir = resolveCfraserPdfsDir();
  const last4 = ccCardLast4FromSourcePdf(t);
  const periodIso = opts?.periodTo ? periodToIso(opts.periodTo) : null;
  const rowMonth = periodIso ? monthKeyFromYmd(periodIso) : null;

  if (last4 && opts?.periodTo) {
    const canonical = canonicalCcStatementPdfName(opts.periodTo, last4);
    if (canonical) {
      const fromPeriodTo = resolveExistingFile([dir], canonical);
      if (fromPeriodTo) return fromPeriodTo;
    }
    if (rowMonth) {
      const fromMonth = resolveCcPdfInMonthPrefix(dir, rowMonth, last4);
      if (fromMonth) return fromMonth;
    }
  }

  const direct = resolveExistingFile([dir], t);
  if (direct) return direct;
  if (/\.pdf$/i.test(t) && !/-CORRUPT\.pdf$/i.test(t)) {
    return resolveExistingFile([dir], t.replace(/\.pdf$/i, "-CORRUPT.pdf"));
  }
  return null;
}

type CcStmtRow = {
  source_pdf: string;
  currency: string;
  period_to: string | null;
};

function ccStatementRowHasPdfOnDisk(row: CcStmtRow): boolean {
  return (
    resolveCcStatementPdfPath(row.source_pdf, { periodTo: row.period_to }) != null
  );
}

function pickPrimaryCcStatement(rows: CcStmtRow[]): CcStmtRow | null {
  const pdfs = rows.filter((r) => isCcStatementPdfSource(r.source_pdf));
  if (pdfs.length === 0) return null;
  const clp = pdfs.filter((r) => String(r.currency ?? "").toLowerCase() === "clp");
  const candidates = clp.length > 0 ? clp : pdfs;
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
    return buildCcDocumentPathsByMonth(account.account_id);
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

function buildCcDocumentMonthsSet(accountId: number): Set<string> {
  const rows = db
    .prepare(
      `SELECT period_to, source_pdf FROM cc_statements WHERE account_id = ?`
    )
    .all(accountId) as { period_to: string | null; source_pdf: string }[];

  const months = new Set<string>();
  for (const row of rows) {
    const ym = matrixMonthForCcStatement(row);
    if (ym) months.add(ym);
  }
  return months;
}

function buildCcDocumentPathsByMonth(accountId: number): Map<string, string> {
  const rows = db
    .prepare(
      `SELECT source_pdf, currency, period_to FROM cc_statements WHERE account_id = ?`
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
    const pick = pickPrimaryCcStatement(picks);
    if (!pick) continue;
    const abs = resolveCcStatementPdfPath(pick.source_pdf, {
      periodTo: pick.period_to,
    });
    if (abs) out.set(ym, abs);
  }
  return out;
}

/** Months with a document row (`period_month` / PDF statement `period_to` month). */
export function buildImportSyncDocumentMonths(
  account: ImportSyncDocumentAccount
): Set<string> {
  if (account.document_kind === "cc_statement") {
    return buildCcDocumentMonthsSet(account.account_id);
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
    return buildCcDocumentMonthsSet(account.account_id).has(rowMonth);
  }
  const row = db
    .prepare(
      `SELECT 1 AS o FROM checking_cartola_imports
       WHERE account_id = ? AND period_month = ? LIMIT 1`
    )
    .get(account.account_id, rowMonth);
  return row != null;
}
