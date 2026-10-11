import fs from "node:fs";
import path from "node:path";
import type { BankAccountMovement, BankAccountMovementsPayload } from "nw-tracker-contracts";
import { requestNamesUsdAccount, transactionsRequestAccount } from "./checkingUsd.js";

/**
 * The dollar cuenta corriente's movements, from the capture the `checking-usd-movements` step
 * writes (`checkingUsd.ts`): the SPA's Apigee call
 * `POST openbanking.santander.cl/…/current-accounts/transactions` for the dollar account, kept
 * verbatim under `cfraser/santander-captures/<stamp>-usd/` → a `bank_account.movements` payload
 * in dollars. First read on the 2026-10-10 captures (two rows: a «Rec Or de Pago» credit and a
 * «Giro en Efectivo por Caja» debit).
 *
 * The answer (`movements`, newest first): `accountingDate` / `transactionDate` ISO dates,
 * `operationTime` HHMM, `movementAmount` and `newBalance` as fixed-width digits with two implied
 * decimals and a trailing «-» on a negative figure, `chargePaymentFlag` D (debit) / H (credit),
 * `expandedCode` (the bank's wording), `observation` (its reference, blank-padded), a running
 * `movementNumber`, `codeOperationMovement`. Nothing is guessed: a flag that disagrees with the
 * sign, an unreadable amount, an unknown shape or a listing whose balances do not chain throw.
 */

/** `additionalInfo` code the bank answers with on success. */
const OK_CODE = "00";
/** The wording Santander files an incoming wire under; its observation carries the order number. */
const INCOMING_WIRE_CODE = /^rec\.?\s*or\.?\s*de\s*pago$/i;
const INCOMING_WIRE_OBSERVATION = /^REC\s+OR\s+DE\s+PAGO\s+(\d+)$/i;

type ApigeeMovement = {
  accountingDate: string;
  transactionDate: string;
  operationTime: string;
  newBalance: string;
  codeOperationMovement: string;
  movementAmount: string;
  observation: string;
  expandedCode: string;
  movementNumber: string;
  chargePaymentFlag: string;
};

const MOVEMENT_FIELDS: (keyof ApigeeMovement)[] = [
  "accountingDate",
  "transactionDate",
  "operationTime",
  "newBalance",
  "codeOperationMovement",
  "movementAmount",
  "observation",
  "expandedCode",
  "movementNumber",
  "chargePaymentFlag",
];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A fixed-width amount with two implied decimals and an optional trailing «-», in cents. */
export function parseImpliedCentsAmount(raw: string, field: string): number {
  const m = /^(\d+)(-?)$/.exec(String(raw ?? "").trim());
  if (!m) throw new Error(`${field}: not a fixed-width implied-decimals amount: «${raw}»`);
  const cents = Number(m[1]);
  if (!Number.isSafeInteger(cents)) throw new Error(`${field}: amount out of range: «${raw}»`);
  return m[2] === "-" ? -cents : cents;
}

function readMovement(row: unknown, index: number): ApigeeMovement {
  if (!isRecord(row)) throw new Error(`movements[${index}] is not an object`);
  const out: Partial<ApigeeMovement> = {};
  for (const f of MOVEMENT_FIELDS) {
    const v = row[f];
    if (typeof v !== "string") throw new Error(`movements[${index}].${f} is missing or not a string`);
    out[f] = v;
  }
  return out as ApigeeMovement;
}

function isoDate(raw: string, field: string, index: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!m) throw new Error(`movements[${index}].${field}: not an ISO date: «${raw}»`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (d.toISOString().slice(0, 10) !== raw.trim()) throw new Error(`movements[${index}].${field}: not a real date: «${raw}»`);
  return raw.trim();
}

function normalizeText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export type DecodedUsdMovement = BankAccountMovement & {
  /** The bank's running balance after the row, in cents (a check the chain is complete). */
  balance_cents: number;
  movement_number: number;
  /** HH:MM, the bank's own clock. */
  operation_time: string;
};

/**
 * The movements of one Apigee transactions answer, oldest first. Throws on anything it cannot
 * account for: the bank's own error code, a shape change, a flag that disagrees with the sign,
 * or balances that do not chain from one row to the next (a row the answer left out).
 */
export function decodeCurrentAccountTransactions(response: unknown): DecodedUsdMovement[] {
  if (!isRecord(response)) throw new Error("transactions response is not an object");
  const info = response.additionalInfo;
  if (Array.isArray(info)) {
    const code = info.find((e) => isRecord(e) && e.key === "code-ms");
    const message = info.find((e) => isRecord(e) && e.key === "message-ms");
    const codeValue = isRecord(code) ? String(code.value ?? "") : null;
    if (codeValue !== null && codeValue !== OK_CODE) {
      throw new Error(`the bank answered code ${codeValue}: ${isRecord(message) ? String(message.value ?? "") : "(no message)"}`);
    }
  }
  const rows = response.movements;
  if (!Array.isArray(rows)) throw new Error("transactions response carries no `movements` array");
  const decoded = rows.map((raw, i) => {
    const r = readMovement(raw, i);
    const cents = parseImpliedCentsAmount(r.movementAmount, `movements[${i}].movementAmount`);
    if (cents === 0) throw new Error(`movements[${i}]: zero amount`);
    const flag = r.chargePaymentFlag.trim().toUpperCase();
    if (flag !== "D" && flag !== "H") throw new Error(`movements[${i}].chargePaymentFlag: unknown flag «${r.chargePaymentFlag}»`);
    if (cents < 0 !== (flag === "D")) {
      throw new Error(`movements[${i}]: amount «${r.movementAmount}» disagrees with flag ${flag}`);
    }
    const signed = cents;
    const balance_cents = parseImpliedCentsAmount(r.newBalance, `movements[${i}].newBalance`);
    const date = isoDate(r.accountingDate, "accountingDate", i);
    isoDate(r.transactionDate, "transactionDate", i);
    const time = /^(\d{2})(\d{2})$/.exec(r.operationTime.trim());
    if (!time) throw new Error(`movements[${i}].operationTime: not HHMM: «${r.operationTime}»`);
    const movement_number = Number(r.movementNumber.trim());
    if (!Number.isSafeInteger(movement_number)) throw new Error(`movements[${i}].movementNumber: not a number: «${r.movementNumber}»`);
    const code = normalizeText(r.expandedCode);
    if (!code) throw new Error(`movements[${i}].expandedCode is blank`);
    const observation = normalizeText(r.observation);
    const description = observation ? `${code} ${observation}` : code;
    let wire_reference: string | null = null;
    if (INCOMING_WIRE_CODE.test(code)) {
      const m = INCOMING_WIRE_OBSERVATION.exec(observation);
      if (!m) throw new Error(`movements[${i}]: an incoming wire («${code}») without its order number in the observation: «${observation}»`);
      if (signed < 0) throw new Error(`movements[${i}]: an incoming wire («${code}») listed as a debit`);
      wire_reference = m[1]!;
    }
    const mv: DecodedUsdMovement = {
      date,
      description: description.slice(0, 180),
      currency: "usd",
      amount: signed / 100,
      document_no: null,
      wire_reference,
      balance_cents,
      movement_number,
      operation_time: `${time[1]}:${time[2]}`,
    };
    return mv;
  });
  // Newest first as the bank lists them; the balance after each row must be the next (older)
  // row's balance plus this row's amount, else a row is missing between them.
  for (let i = 0; i + 1 < decoded.length; i++) {
    const newer = decoded[i]!;
    const older = decoded[i + 1]!;
    if (newer.movement_number <= older.movement_number) {
      throw new Error(`movements are not newest first: #${newer.movement_number} (${newer.date}) before #${older.movement_number} (${older.date})`);
    }
    const expected = older.balance_cents + Math.round(newer.amount * 100);
    if (expected !== newer.balance_cents) {
      throw new Error(
        `balance does not chain: after #${older.movement_number} ${older.balance_cents / 100}, ` +
          `#${newer.movement_number} ${newer.amount} should leave ${expected / 100}, the bank prints ${newer.balance_cents / 100}`,
      );
    }
  }
  return [...decoded].reverse();
}

export type UsdCapture = {
  dir: string;
  stamp: string;
  request: { url: string; body: string | null };
  response: unknown;
  fetchedAt: string | null;
};

/** The capture under `dir` (`request.json`, `response.json`, `meta.json`); throws on a missing file. */
export function readUsdCapture(dir: string): UsdCapture {
  const requestFile = path.join(dir, "request.json");
  const responseFile = path.join(dir, "response.json");
  if (!fs.existsSync(requestFile) || !fs.existsSync(responseFile)) {
    throw new Error(`${dir}: not a USD capture (request.json / response.json missing)`);
  }
  const request = JSON.parse(fs.readFileSync(requestFile, "utf8")) as unknown;
  if (!isRecord(request) || typeof request.url !== "string") throw new Error(`${dir}/request.json: no url`);
  const body = request.body == null ? null : String(request.body);
  const response = JSON.parse(fs.readFileSync(responseFile, "utf8")) as unknown;
  let fetchedAt: string | null = null;
  const metaFile = path.join(dir, "meta.json");
  if (fs.existsSync(metaFile)) {
    const meta = JSON.parse(fs.readFileSync(metaFile, "utf8")) as unknown;
    if (isRecord(meta) && typeof meta.fetchedAt === "string") fetchedAt = meta.fetchedAt;
  }
  const stamp = path.basename(dir).replace(/-usd$/, "");
  return { dir, stamp, request: { url: request.url, body }, response, fetchedAt };
}

/**
 * A capture as one `bank_account.movements` payload for the configured dollar account. The
 * capture's request must name that account (the contract number, leading zeros ignored, as
 * `checkingUsd.ts` identifies it) in dollars; the payload names the account by the configured
 * number, which the server checks against its own declaration.
 */
export function santanderUsdMovementsPayload(capture: UsdCapture, usdAccountNumber: string): BankAccountMovementsPayload {
  const request = transactionsRequestAccount(capture.request.url, capture.request.body);
  if (!request) throw new Error(`${capture.dir}: the captured request is not a transactions call for an account`);
  if (!requestNamesUsdAccount(request, usdAccountNumber)) {
    throw new Error(`${capture.dir}: the captured request is for account …${request.account.slice(-4)} (${request.currency ?? "no currency"}), not the configured dollar account`);
  }
  if (request.currency === null || !/^usd$/i.test(request.currency.trim())) {
    throw new Error(`${capture.dir}: the captured request names currency «${request.currency ?? ""}», not USD`);
  }
  const movements = decodeCurrentAccountTransactions(capture.response).map(
    ({ balance_cents: _b, movement_number: _n, operation_time: _t, ...mv }) => mv,
  );
  return {
    account: { issuer: "santander", product: "checking", currency: "usd", number: usdAccountNumber.replace(/\D/g, "") },
    movements,
    rejected_rows: [],
  };
}

/** The `<stamp>-usd` capture directories under `capturesDir`, oldest first. */
export function stagedUsdCaptureDirs(capturesDir: string): string[] {
  if (!fs.existsSync(capturesDir)) return [];
  return fs
    .readdirSync(capturesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /-usd$/.test(e.name))
    .map((e) => e.name)
    .sort()
    .map((name) => path.join(capturesDir, name));
}
