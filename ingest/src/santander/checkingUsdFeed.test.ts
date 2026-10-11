import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bankAccountMovementsKind } from "nw-tracker-contracts";
import {
  decodeCurrentAccountTransactions,
  parseImpliedCentsAmount,
  readUsdCapture,
  santanderUsdMovementsPayload,
  stagedUsdCaptureDirs,
} from "./checkingUsdFeed.js";

// Synthetic: a contract number that exists nowhere; the office prefix the bank glues in front.
const USD_NUMBER = "009900112233";
const APIGEE_URL =
  "https://openbanking.santander.cl/account_balances_transactions_and_withholdings_retail/v1/current-accounts/transactions";

/** The 2026-10-10 answer's shape: a wire in, then a branch withdrawal that emptied the account. */
function response(movements: unknown[] = DEFAULT_ROWS, code = "00") {
  return {
    additionalInfo: [
      { key: "code-ms", value: code },
      { key: "message-ms", value: code === "00" ? "" : "Servicio no disponible" },
    ],
    movements,
  };
}

const WIRE_ROW = {
  accountingDate: "2026-10-08",
  transactionDate: "2026-10-08",
  operationTime: "1246",
  newBalance: "000000000113853",
  codeOperationMovement: "2241",
  movementAmount: "000000000113853",
  observation: "REC OR DE PAGO 202600000042",
  expandedCode: "Rec Or de Pago",
  movementNumber: "000000002",
  chargePaymentFlag: "H",
};
const CASH_ROW = {
  accountingDate: "2026-10-09",
  transactionDate: "2026-10-09",
  operationTime: "1314",
  newBalance: "000000",
  codeOperationMovement: "2590",
  movementAmount: "00000000113853-",
  observation: " ",
  expandedCode: "Giro en Efectivo por Caja",
  movementNumber: "000000003",
  chargePaymentFlag: "D",
};
const DEFAULT_ROWS = [CASH_ROW, WIRE_ROW];

describe("parseImpliedCentsAmount", () => {
  it("reads two implied decimals and a trailing minus", () => {
    expect(parseImpliedCentsAmount("000000000113853", "x")).toBe(113853);
    expect(parseImpliedCentsAmount("00000000113853-", "x")).toBe(-113853);
    expect(parseImpliedCentsAmount("000000", "x")).toBe(0);
    expect(() => parseImpliedCentsAmount("1.138,53", "x")).toThrow(/not a fixed-width/);
    expect(() => parseImpliedCentsAmount("-113853", "x")).toThrow(/not a fixed-width/);
  });
});

describe("decodeCurrentAccountTransactions", () => {
  it("reads the rows oldest first, cents signed by the flag, the wire's order number as its reference", () => {
    expect(decodeCurrentAccountTransactions(response())).toEqual([
      {
        date: "2026-10-08",
        description: "Rec Or de Pago REC OR DE PAGO 202600000042",
        currency: "usd",
        amount: 1138.53,
        document_no: null,
        wire_reference: "202600000042",
        balance_cents: 113853,
        movement_number: 2,
        operation_time: "12:46",
      },
      {
        date: "2026-10-09",
        description: "Giro en Efectivo por Caja",
        currency: "usd",
        amount: -1138.53,
        document_no: null,
        wire_reference: null,
        balance_cents: 0,
        movement_number: 3,
        operation_time: "13:14",
      },
    ]);
  });

  it("accepts an empty listing", () => {
    expect(decodeCurrentAccountTransactions(response([]))).toEqual([]);
  });

  it("throws on the bank's own error code", () => {
    expect(() => decodeCurrentAccountTransactions(response([], "99"))).toThrow(/code 99: Servicio no disponible/);
  });

  it("throws when a flag disagrees with the sign, on an unknown flag and on a zero amount", () => {
    expect(() => decodeCurrentAccountTransactions(response([{ ...WIRE_ROW, chargePaymentFlag: "D" }]))).toThrow(/disagrees with flag D/);
    expect(() => decodeCurrentAccountTransactions(response([{ ...CASH_ROW, chargePaymentFlag: "H" }]))).toThrow(/disagrees with flag H/);
    expect(() => decodeCurrentAccountTransactions(response([{ ...WIRE_ROW, chargePaymentFlag: "X" }]))).toThrow(/unknown flag/);
    expect(() => decodeCurrentAccountTransactions(response([{ ...WIRE_ROW, movementAmount: "000000" }]))).toThrow(/zero amount/);
  });

  it("throws when the balances do not chain (a row the answer left out) or the order is wrong", () => {
    const skipped = { ...CASH_ROW, newBalance: "000000000050000", movementNumber: "000000004" };
    expect(() => decodeCurrentAccountTransactions(response([skipped, WIRE_ROW]))).toThrow(/balance does not chain/);
    expect(() => decodeCurrentAccountTransactions(response([WIRE_ROW, CASH_ROW]))).toThrow(/not newest first/);
  });

  it("throws on a shape change: a missing field, a non-ISO date, an incoming wire without its order number", () => {
    const { observation: _o, ...noObservation } = WIRE_ROW;
    expect(() => decodeCurrentAccountTransactions(response([noObservation]))).toThrow(/observation is missing/);
    expect(() => decodeCurrentAccountTransactions(response([{ ...WIRE_ROW, accountingDate: "08/10/2026" }]))).toThrow(/not an ISO date/);
    expect(() => decodeCurrentAccountTransactions(response([{ ...WIRE_ROW, observation: "OTRA COSA" }]))).toThrow(/without its order number/);
    expect(() => decodeCurrentAccountTransactions({ movements: "no" })).toThrow(/no `movements` array/);
  });
});

describe("captures on disk", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "usd-feed-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function writeCapture(name: string, body: Record<string, unknown>, res: unknown = response()): string {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "request.json"), JSON.stringify({ url: APIGEE_URL, route: "apigee", status: 200, body: JSON.stringify(body) }));
    fs.writeFileSync(path.join(dir, "response.json"), JSON.stringify(res));
    fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ fetchedAt: "2026-10-11T01:01:17.055Z", slideIndex: 2 }));
    return dir;
  }

  it("turns a capture into a dollar payload the contract accepts, naming the configured account", () => {
    const dir = writeCapture("2026-10-11T01-00-25-usd", { accountId: `0401${USD_NUMBER}`, currency: "USD", commercialGroup: "" });
    const capture = readUsdCapture(dir);
    expect(capture.stamp).toBe("2026-10-11T01-00-25");
    expect(capture.fetchedAt).toBe("2026-10-11T01:01:17.055Z");
    const payload = santanderUsdMovementsPayload(capture, USD_NUMBER);
    expect(bankAccountMovementsKind.payload.safeParse(payload).success).toBe(true);
    expect(payload).toEqual({
      account: { issuer: "santander", product: "checking", currency: "usd", number: USD_NUMBER },
      movements: [
        { date: "2026-10-08", description: "Rec Or de Pago REC OR DE PAGO 202600000042", currency: "usd", amount: 1138.53, document_no: null, wire_reference: "202600000042" },
        { date: "2026-10-09", description: "Giro en Efectivo por Caja", currency: "usd", amount: -1138.53, document_no: null, wire_reference: null },
      ],
      rejected_rows: [],
    });
  });

  it("refuses a capture of another account or of the peso currency", () => {
    const other = readUsdCapture(writeCapture("a-usd", { accountId: "0401009900998877", currency: "USD" }));
    expect(() => santanderUsdMovementsPayload(other, USD_NUMBER)).toThrow(/not the configured dollar account/);
    const pesos = readUsdCapture(writeCapture("b-usd", { accountId: `0401${USD_NUMBER}`, currency: "CLP" }));
    expect(() => santanderUsdMovementsPayload(pesos, USD_NUMBER)).toThrow(/not the configured dollar account/);
  });

  it("lists the -usd capture directories oldest first and nothing else", () => {
    writeCapture("2026-10-11T01-00-25-usd", { accountId: `0401${USD_NUMBER}`, currency: "USD" });
    writeCapture("2026-10-10T01-00-08-usd", { accountId: `0401${USD_NUMBER}`, currency: "USD" });
    fs.mkdirSync(path.join(root, "2026-10-10T01-00-08"), { recursive: true });
    fs.writeFileSync(path.join(root, "stray-usd"), "");
    expect(stagedUsdCaptureDirs(root).map((d) => path.basename(d))).toEqual(["2026-10-10T01-00-08-usd", "2026-10-11T01-00-25-usd"]);
    expect(() => readUsdCapture(path.join(root, "2026-10-10T01-00-08"))).toThrow(/not a USD capture/);
  });
});
