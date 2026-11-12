/**
 * XLSX export for account and group pages: one workbook per download, one sheet per selected
 * section, over an optional inclusive YYYY-MM range. Sheet titles are server-owned Spanish
 * labels (same convention as server-owned chart line names). Numbers are written as raw
 * numeric cells — the decimal-separator preference is a display concern.
 *
 * Every figure of the closings, P/L and aportes sheets is in the requested unit, and the column
 * header names it (`cierre_eur`, `monto_usd`). The movements sheet keeps each movement's own
 * legs as stored: a column per leg currency (`monto_clp`, `monto_usd` always, `monto_<code>` for
 * any other), never converted.
 *
 * Sections reuse the existing aggregation surface:
 * - closings / pl → monthlyPerfForAccountId / monthlyPerfForAccountDisplay (P/L: the page's
 *   compounded %; per account; groups iterate members)
 * - aportes      → getMergedDisplayDepositInflowEventsForAccount (cumulative over full
 *                  history, then range-filtered, so `acumulado` stays a true running total)
 * - movements    → listAccountMovementsForApi(Bulk)
 */
import { foldAccents } from "nw-tracker-contracts";
import XLSX from "xlsx";
import { monthlyPerfForAccountId } from "./groupMonthlyPerfConsolidation.js";
import { monthlyPerfForAccountDisplay } from "./detalleDailyChainedPct.js";
import { getMergedDisplayDepositInflowEventsForAccount } from "./accountDeposits.js";
import {
  listAccountMovementsForApi,
  listAccountMovementsForApiBulk,
  type AccountMovementApiRow,
} from "./accountMovementsApi.js";
import { compareFlowRowsForDisplay } from "./brokerageFlowMovement.js";
import { db } from "./db.js";
import { movementClpLegOrZero, movementUsdLeg, type MovementAmountFields } from "./movementAmounts.js";
import { transferToLegUnits } from "./movementTransfer.js";
import { flowEventInUnit } from "./rates.js";
import { roundToCurrency } from "./displayUnits.js";
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

/** A value column's header in the requested unit (`cierre` → `cierre_clp`). */
function inUnit(column: string, opts: ExportOptions): string {
  return `${column}_${opts.unit}`;
}

function closingsRows(accounts: readonly MemberAccount[], opts: ExportOptions, withAccount: boolean): SheetRow[] {
  const rows: SheetRow[] = [];
  for (const a of accounts) {
    const perf = monthlyPerfForAccountId(a.account_id, opts.unit);
    if (!perf) continue;
    for (const m of [...perf.monthly].reverse()) {
      if (!monthInRange(m.as_of_date, opts)) continue;
      rows.push({
        ...(withAccount ? { cuenta: a.name } : {}),
        mes: m.as_of_date,
        [inUnit("cierre", opts)]: m.closing_value,
      });
    }
  }
  return rows;
}

function plRows(accounts: readonly MemberAccount[], opts: ExportOptions, withAccount: boolean): SheetRow[] {
  const rows: SheetRow[] = [];
  for (const a of accounts) {
    const perf = monthlyPerfForAccountDisplay(a.account_id, opts.unit);
    if (!perf) continue;
    for (const m of [...perf.monthly].reverse()) {
      if (!monthInRange(m.as_of_date, opts)) continue;
      rows.push({
        ...(withAccount ? { cuenta: a.name } : {}),
        mes: m.as_of_date,
        [inUnit("cierre", opts)]: m.closing_value,
        [inUnit("cierre_anterior", opts)]: m.prior_closing,
        [inUnit("aporte_neto", opts)]: m.net_capital_flow,
        [inUnit("pl_nominal", opts)]: m.nominal_pl,
        pct_mes: m.pct_month,
        [inUnit("pl_ytd", opts)]: m.ytd_nominal_pl ?? null,
        [inUnit("pl_acumulado", opts)]: m.cumulative_nominal_pl ?? null,
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
      // Each event at its own date's rate (its dollars as moved when the unit is USD).
      const amount = flowEventInUnit(e, opts.unit);
      cumulative += amount;
      if (!monthInRange(e.occurred_on, opts)) continue;
      rows.push({
        ...(withAccount ? { cuenta: a.name } : {}),
        fecha: e.occurred_on,
        [inUnit("monto", opts)]: amount,
        [inUnit("acumulado", opts)]: roundToCurrency(cumulative, opts.unit),
      });
    }
  }
  rows.sort((x, y) => String(x.fecha).localeCompare(String(y.fecha)));
  return rows;
}

/**
 * The movement's legs as stored, one `monto_<code>` column per currency (SUM-friendly): pesos and
 * dollars on every row (0 / empty when the movement has none, the legacy columns), any other
 * currency only on the rows that carry it.
 */
function movementLegColumns(m: MovementAmountFields): SheetRow {
  const out: SheetRow = { monto_clp: movementClpLegOrZero(m), monto_usd: movementUsdLeg(m) };
  const legs: [string | null, number | null][] = [
    [m.currency, m.amount],
    [m.counter_currency, m.counter_amount],
  ];
  for (const [currency, amount] of legs) {
    if (currency != null && !(`monto_${currency}` in out)) out[`monto_${currency}`] = amount;
  }
  return out;
}

function movementRow(m: AccountMovementApiRow, accountName: string | null): SheetRow {
  return {
    ...(accountName != null ? { cuenta: accountName } : {}),
    fecha: m.occurred_on,
    tipo: m.flow_type_label,
    ...movementLegColumns(m),
    // The viewed account's own leg: a fund switch credits the to-leg its own count.
    unidades: m.transfer_direction === "in" ? transferToLegUnits(m) : m.units_delta,
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
    foldAccents(name.toLowerCase())
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
