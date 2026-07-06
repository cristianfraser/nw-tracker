/**
 * XLSX export for account and group pages: one workbook per download, one sheet per selected
 * section, over an optional inclusive YYYY-MM range. Sheet titles are server-owned Spanish
 * labels (same convention as server-owned chart line names). Numbers are written as raw
 * numeric cells — the decimal-separator preference is a display concern.
 *
 * Sections reuse the existing aggregation surface:
 * - closings / pl → getAccountMonthlyPerformance (per account; groups iterate members)
 * - aportes      → getMergedDisplayDepositInflowEventsForAccount (cumulative over full
 *                  history, then range-filtered, so `acumulado` stays a true running total)
 * - movements    → listAccountMovementsForApi(Bulk)
 */
import XLSX from "xlsx";
import { getAccountMonthlyPerformance } from "./accountPerformance.js";
import { getMergedDisplayDepositInflowEventsForAccount } from "./accountDeposits.js";
import {
  listAccountMovementsForApi,
  listAccountMovementsForApiBulk,
  type AccountMovementApiRow,
} from "./accountMovementsApi.js";
import { compareFlowRowsForDisplay } from "./brokerageFlowMovement.js";
import { db } from "./db.js";
import { listAccountsForGroupTab, type TsUnit } from "./valuationTimeseries.js";

export const EXPORT_SECTIONS = ["closings", "aportes", "pl", "movements"] as const;
export type ExportSection = (typeof EXPORT_SECTIONS)[number];

export function isExportSection(v: string): v is ExportSection {
  return (EXPORT_SECTIONS as readonly string[]).includes(v);
}

export type ExportOptions = {
  /** Inclusive YYYY-MM bounds; omitted side = open. */
  from?: string;
  to?: string;
  sections: readonly ExportSection[];
  unit: TsUnit;
};

const SHEET_TITLES: Record<ExportSection, string> = {
  closings: "Cierres",
  aportes: "Aportes",
  pl: "P&L mensual",
  movements: "Movimientos",
};

function monthInRange(ymd: string, opts: ExportOptions): boolean {
  const mk = ymd.slice(0, 7);
  if (opts.from && mk < opts.from) return false;
  if (opts.to && mk > opts.to) return false;
  return true;
}

type SheetRow = Record<string, string | number | null>;

type MemberAccount = { account_id: number; name: string };

function closingsRows(accounts: readonly MemberAccount[], opts: ExportOptions, withAccount: boolean): SheetRow[] {
  const rows: SheetRow[] = [];
  for (const a of accounts) {
    const perf = getAccountMonthlyPerformance(a.account_id, opts.unit);
    if (!perf) continue;
    for (const m of [...perf.monthly].reverse()) {
      if (!monthInRange(m.as_of_date, opts)) continue;
      rows.push({
        ...(withAccount ? { cuenta: a.name } : {}),
        mes: m.as_of_date,
        cierre: m.closing_value,
      });
    }
  }
  return rows;
}

function plRows(accounts: readonly MemberAccount[], opts: ExportOptions, withAccount: boolean): SheetRow[] {
  const rows: SheetRow[] = [];
  for (const a of accounts) {
    const perf = getAccountMonthlyPerformance(a.account_id, opts.unit);
    if (!perf) continue;
    for (const m of [...perf.monthly].reverse()) {
      if (!monthInRange(m.as_of_date, opts)) continue;
      rows.push({
        ...(withAccount ? { cuenta: a.name } : {}),
        mes: m.as_of_date,
        cierre: m.closing_value,
        cierre_anterior: m.prior_closing,
        aporte_neto: m.net_capital_flow,
        pl_nominal: m.nominal_pl,
        pct_mes: m.pct_month,
        pl_ytd: m.ytd_nominal_pl ?? null,
        pl_acumulado: m.cumulative_nominal_pl ?? null,
      });
    }
  }
  return rows;
}

function aportesRows(accounts: readonly MemberAccount[], opts: ExportOptions, withAccount: boolean): SheetRow[] {
  const rows: SheetRow[] = [];
  for (const a of accounts) {
    let cumulative = 0;
    for (const e of getMergedDisplayDepositInflowEventsForAccount(a.account_id)) {
      cumulative += e.amt;
      if (!monthInRange(e.occurred_on, opts)) continue;
      rows.push({
        ...(withAccount ? { cuenta: a.name } : {}),
        fecha: e.occurred_on,
        monto_clp: e.amt,
        monto_usd: e.amt_usd ?? null,
        acumulado_clp: Math.round(cumulative),
      });
    }
  }
  rows.sort((x, y) => String(x.fecha).localeCompare(String(y.fecha)));
  return rows;
}

function movementRow(m: AccountMovementApiRow, accountName: string | null): SheetRow {
  return {
    ...(accountName != null ? { cuenta: accountName } : {}),
    fecha: m.occurred_on,
    tipo: m.flow_type_label,
    monto_clp: m.amount_clp,
    monto_usd: m.amount_usd,
    unidades: m.units_delta,
    ticker: m.ticker,
    contraparte: m.counterpart_account_name,
    nota: m.note,
  };
}

function movementsRowsForAccount(accountId: number, opts: ExportOptions): SheetRow[] {
  return listAccountMovementsForApi(accountId)
    .filter((m) => monthInRange(m.occurred_on, opts))
    .map((m) => movementRow(m, null));
}

function movementsRowsForGroup(accounts: readonly MemberAccount[], opts: ExportOptions): SheetRow[] {
  const byAccount = listAccountMovementsForApiBulk(accounts.map((a) => a.account_id));
  const merged: { m: AccountMovementApiRow; name: string }[] = [];
  for (const a of accounts) {
    for (const m of byAccount.get(a.account_id) ?? []) {
      if (!monthInRange(m.occurred_on, opts)) continue;
      merged.push({ m, name: a.name });
    }
  }
  merged.sort((x, y) => compareFlowRowsForDisplay(x.m, y.m));
  return merged.map((r) => movementRow(r.m, r.name));
}

function buildWorkbook(
  accounts: readonly MemberAccount[],
  opts: ExportOptions,
  withAccountColumn: boolean
): Buffer {
  const wb = XLSX.utils.book_new();
  for (const section of opts.sections) {
    let rows: SheetRow[];
    switch (section) {
      case "closings":
        rows = closingsRows(accounts, opts, withAccountColumn);
        break;
      case "pl":
        rows = plRows(accounts, opts, withAccountColumn);
        break;
      case "aportes":
        rows = aportesRows(accounts, opts, withAccountColumn);
        break;
      case "movements":
        rows = withAccountColumn
          ? movementsRowsForGroup(accounts, opts)
          : movementsRowsForAccount(accounts[0]!.account_id, opts);
        break;
    }
    const sheet = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, sheet, SHEET_TITLES[section]);
  }
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

function filenameFor(name: string, opts: ExportOptions): string {
  const slug =
    name
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "export";
  const range = `${opts.from ?? "inicio"}_${opts.to ?? "hoy"}`;
  return `${slug}-${range}.xlsx`;
}

export type ExportWorkbookResult = { filename: string; buffer: Buffer };

export function buildAccountExportWorkbook(
  accountId: number,
  opts: ExportOptions
): ExportWorkbookResult | null {
  const row = db.prepare(`SELECT id, name FROM accounts WHERE id = ?`).get(accountId) as
    | { id: number; name: string }
    | undefined;
  if (!row) return null;
  const buffer = buildWorkbook([{ account_id: row.id, name: row.name }], opts, false);
  return { filename: filenameFor(row.name, opts), buffer };
}

export function buildGroupExportWorkbook(
  groupSlug: string,
  opts: ExportOptions
): ExportWorkbookResult | null {
  const accounts = listAccountsForGroupTab(groupSlug, undefined)
    .filter((r) => r.account_id > 0)
    .map((r) => ({ account_id: r.account_id, name: r.name }));
  if (accounts.length === 0) return null;
  const buffer = buildWorkbook(accounts, opts, true);
  return { filename: filenameFor(groupSlug, opts), buffer };
}
