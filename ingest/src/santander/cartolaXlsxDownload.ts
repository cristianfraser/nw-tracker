/**
 * The checks a downloaded cartola xlsx passes before it may reach `cfraser/inbox/`, and the bank
 * answer that says whether a month's cartola exists. Pure: the browser part
 * (`checkingCartolaXlsxFetch.ts`) only clicks and hands the bytes over.
 *
 * A file that reached the inbox is filed and imported by its name alone, so everything the name
 * promises is checked against what the workbook prints first: a real xlsx (not the bank's HTML
 * error page), the configured peso cuenta corriente (row «N° Cuenta:», «Tipo de Cuenta: CUENTA
 * CORRIENTE ML»), the month asked for (HASTA, read by the cartola reader itself, which also checks
 * the saldo identity), and a bank file name naming that same month.
 */
import fs from "node:fs";
import path from "node:path";
import XLSX from "xlsx";
import { addCalendarMonths, normalizeAccountNumber, parseDdMmYyToIso, spanishMonthName } from "nw-tracker-contracts";
import type { ApiCall } from "../capture.js";
import { resolveCfraserDir } from "../paths.js";
import { parseCheckingCartolaBuffer, periodMonthFromCartolaFileName, type ParsedCheckingCartola } from "./checkingCartolaXlsx.js";

/** Tibco endpoint the cartolas view asks, once per month it shows (`INPUT.MESCONSULTA` / `ANOCONSULTA`). */
export const CARTOLA_HISTORY_ENDPOINT = "ultCartolaHistorica";

/** `CODERR` the endpoint answers for a month with no cartola («No existe el registro buscado.»). */
const NO_CARTOLA_CODE = "16";

/** What the bank said about one month of one account. */
export type CartolaMonthAnswer =
  | { kind: "issued"; month: string; cartolaNumber: string }
  | { kind: "not_issued"; month: string; message: string };

/** «Julio 2026», as the cartolas view and the bank's file name print a month. */
export function cartolaMonthLabel(month: string): string {
  const name = spanishMonthName(Number(month.slice(5, 7)));
  return `${name[0]!.toUpperCase()}${name.slice(1)} ${month.slice(0, 4)}`;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** The month and account a cartola-history request asked for, or null when the call is another. */
export function cartolaHistoryRequest(call: Pick<ApiCall, "endpoint" | "requestBody">): { month: string; account: string } | null {
  if (call.endpoint !== CARTOLA_HISTORY_ENDPOINT) return null;
  const input = record(record(call.requestBody)?.INPUT);
  const year = text(input?.ANOCONSULTA);
  const month = text(input?.MESCONSULTA);
  const account = text(input?.CONTRATO);
  if (!/^\d{4}$/.test(year) || !/^\d{1,2}$/.test(month) || !account) return null;
  return { month: `${year}-${month.padStart(2, "0")}`, account };
}

/**
 * The bank's answer for `month` of `account` among the recorded calls (the newest one), or null
 * when the view never asked for it. Any answer but a cartola or «no record» throws, as does a
 * cartola row naming another account: the step must not guess what the view shows.
 */
export function cartolaMonthAnswer(
  calls: readonly Pick<ApiCall, "endpoint" | "requestBody" | "responseBody" | "status">[],
  month: string,
  account: string,
): CartolaMonthAnswer | null {
  const want = normalizeAccountNumber(account);
  const call = calls.filter((c) => {
    const req = cartolaHistoryRequest(c);
    return req !== null && req.month === month && normalizeAccountNumber(req.account) === want;
  }).at(-1);
  if (!call) return null;
  const answer = record(record(record(call.responseBody)?.DATA)?.AS_TIB_ConsultaUltCartolaHistorica);
  const info = record(answer?.INFO);
  const code = text(info?.CODERR);
  if (call.status !== 200 || !info) {
    throw new Error(`${CARTOLA_HISTORY_ENDPOINT} for ${month}: unexpected answer (HTTP ${call.status})`);
  }
  if (code === NO_CARTOLA_CODE) return { kind: "not_issued", month, message: text(info.DESERR) || text(info.MSGUSUARIO) };
  if (code !== "00" && code !== "0") {
    throw new Error(`${CARTOLA_HISTORY_ENDPOINT} for ${month}: code ${code || "(none)"} ${text(info.DESERR)}`.trim());
  }
  const rows = record(answer?.OUTPUT)?.MATRIZ;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`${CARTOLA_HISTORY_ENDPOINT} for ${month}: answered OK with no cartola row`);
  }
  const first = record(rows[0]);
  if (normalizeAccountNumber(text(first?.NUMEROCUENTA)) !== want) {
    throw new Error(`${CARTOLA_HISTORY_ENDPOINT} for ${month}: the cartola row names another account`);
  }
  return { kind: "issued", month, cartolaNumber: text(first?.NUMEROCARTOLA) };
}

/** The value printed right of a header label («N° Cuenta:», «Tipo de Cuenta:») anywhere in the sheet's top rows. */
function labelledCell(rows: unknown[][], label: RegExp): string | null {
  for (const row of rows.slice(0, 30)) {
    for (let i = 0; i < row.length - 1; i++) {
      if (label.test(String(row[i] ?? "").trim())) return String(row[i + 1] ?? "").trim();
    }
  }
  return null;
}

export type CartolaXlsxHeader = {
  account: string | null;
  accountType: string | null;
  /** DESDE / HASTA as ISO days, null when absent or unreadable. */
  from: string | null;
  to: string | null;
};

/** The account, product and period the cartola workbook's header prints (the sheet the reader reads). */
export function peekCartolaXlsxHeader(workbook: XLSX.WorkBook): CartolaXlsxHeader {
  const sheetName = workbook.SheetNames.find((n) => /cartola/i.test(n)) ?? workbook.SheetNames[0];
  const sheet = sheetName ? workbook.Sheets[sheetName] : undefined;
  if (!sheet) return { account: null, accountType: null, from: null, to: null };
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" }) as unknown[][];
  const day = (label: RegExp): string | null => {
    const raw = labelledCell(rows, label);
    return raw ? parseDdMmYyToIso(raw) : null;
  };
  return {
    account: labelledCell(rows, /^n[°º]?\s*cuenta:?$/i),
    accountType: labelledCell(rows, /^tipo de cuenta:?$/i),
    from: day(/^desde:?$/i),
    to: day(/^hasta:?$/i),
  };
}

/** An xlsx is a zip: «PK\x03\x04». The bank's error page is HTML. */
function looksLikeXlsx(bytes: Buffer): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/**
 * Why a cartola header is not one month of the configured peso cuenta corriente, or null when it is:
 * «N° Cuenta» the account (by digits), «Tipo de Cuenta» CUENTA CORRIENTE ML, HASTA printed and
 * DESDE the close before HASTA's month.
 */
export function cartolaHeaderRefusal(header: CartolaXlsxHeader, account: string): string | null {
  if (!header.account) return "no «N° Cuenta» in the header";
  if (normalizeAccountNumber(header.account) !== normalizeAccountNumber(account)) {
    return `cartola of account …${normalizeAccountNumber(header.account).slice(-4)}, not the configured cuenta corriente`;
  }
  if (!header.accountType || !/corriente\s+ml\b/i.test(header.accountType)) {
    return `«Tipo de Cuenta» is ${JSON.stringify(header.accountType)}, not the peso cuenta corriente (CUENTA CORRIENTE ML)`;
  }
  if (!header.to) return "no HASTA in the header";
  if (!header.from) return "no DESDE in the header";
  const month = header.to.slice(0, 7);
  if (header.from < `${addCalendarMonths(month, -1)}-01` || header.from > header.to) {
    return `DESDE ${header.from} is not the close before ${month}`;
  }
  return null;
}

/** The month a workbook is the configured cuenta corriente's cartola of (by its header), or null; a zip XLSX cannot read throws. */
export function cartolaXlsxHeaderMonth(bytes: Buffer, account: string): string | null {
  if (!looksLikeXlsx(bytes)) return null;
  const header = peekCartolaXlsxHeader(XLSX.read(bytes, { type: "buffer", cellDates: false }));
  return cartolaHeaderRefusal(header, account) === null ? header.to!.slice(0, 7) : null;
}

/**
 * Throw unless `bytes` (saved as `fileName`) is the peso cuenta corriente's cartola of `month`
 * for `account`; return the reader's reading. Each refusal names what was printed.
 */
export function validateDownloadedCartolaXlsx(
  bytes: Buffer,
  fileName: string,
  expected: { month: string; account: string },
): ParsedCheckingCartola {
  if (!fileName.toLowerCase().endsWith(".xlsx") || !looksLikeXlsx(bytes)) {
    throw new Error(`${fileName}: not an xlsx workbook (${bytes.length} bytes starting ${JSON.stringify(bytes.subarray(0, 15).toString("latin1"))})`);
  }
  const nameMonth = periodMonthFromCartolaFileName(fileName);
  if (nameMonth !== expected.month) {
    throw new Error(`${fileName}: the bank's file name names ${nameMonth ?? "no month"}, expected ${expected.month}`);
  }
  const header = peekCartolaXlsxHeader(XLSX.read(bytes, { type: "buffer", cellDates: false }));
  const refusal = cartolaHeaderRefusal(header, expected.account);
  if (refusal) throw new Error(`${fileName}: ${refusal}`);
  if (header.to!.slice(0, 7) !== expected.month) throw new Error(`${fileName}: HASTA ${header.to} is not in ${expected.month}`);
  // The reader itself last: its saldo identity and running balances are the content checks.
  const cartola = parseCheckingCartolaBuffer(bytes, fileName);
  if (cartola.period_to !== header.to || cartola.period_month !== expected.month) {
    throw new Error(`${fileName}: the reader read ${cartola.period_month} (HASTA ${cartola.period_to}), the header prints HASTA ${header.to}`);
  }
  return cartola;
}

/**
 * The configured peso cuenta corriente, as the organizer reads it: `santander_checking_cartola_account`
 * in `cfraser/organize-identifiers.json` (`NW_TRACKER_ORGANIZE_IDENTIFIERS` overrides the path).
 */
export function checkingCartolaAccount(env: NodeJS.ProcessEnv = process.env): string {
  const file = env.NW_TRACKER_ORGANIZE_IDENTIFIERS || path.join(resolveCfraserDir(), "organize-identifiers.json");
  if (!fs.existsSync(file)) throw new Error(`missing ${file}: it names the cuenta corriente the cartola must be of`);
  const raw = record(JSON.parse(fs.readFileSync(file, "utf8")));
  const account = text(raw?.santander_checking_cartola_account);
  if (!normalizeAccountNumber(account)) throw new Error(`${file} declares no santander_checking_cartola_account`);
  return account;
}
