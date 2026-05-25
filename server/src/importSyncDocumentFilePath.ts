import fs from "node:fs";
import path from "node:path";
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

export function resolveCcStatementPdfPath(sourcePdf: string): string | null {
  const t = String(sourcePdf ?? "").trim();
  if (!t || t.startsWith("import:web-paste")) return null;
  const dir = resolveCfraserPdfsDir();
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

function pickPrimaryCcStatement(rows: CcStmtRow[]): CcStmtRow | null {
  const pdfs = rows.filter((r) => isCcStatementPdfSource(r.source_pdf));
  if (pdfs.length === 0) return null;
  const clp = pdfs.find((r) => String(r.currency ?? "").toLowerCase() === "clp");
  return clp ?? pdfs[0] ?? null;
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
    const abs = resolveCcStatementPdfPath(pick.source_pdf);
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
