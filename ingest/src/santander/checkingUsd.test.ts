import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Recorder, SANTANDER_API_HOST_FRAGMENTS } from "../capture.js";
import { loadBankConfig } from "../config.js";
import {
  requestNamesUsdAccount,
  transactionsRequestAccount,
  transactionsRouteOf,
  writeUsdCapture,
  type UsdTransactionsCall,
} from "./checkingUsd.js";

// Synthetic: a contract number that exists nowhere.
const USD_NUMBER = "009900112233";
const APIGEE_URL =
  "https://openbanking.santander.cl/account_balances_transactions_and_withholdings_retail/v1/current-accounts/transactions";
const TIBCO_URL = "https://api-dsk.santander.cl/perdsk/datosCliente/consultas/mvtosYDeposiDocCtas";

describe("transactionsRouteOf", () => {
  it("names the Apigee and Tibco transactions endpoints and nothing else", () => {
    expect(transactionsRouteOf(APIGEE_URL)).toBe("apigee");
    expect(transactionsRouteOf(`${TIBCO_URL}?x=1`)).toBe("tibco");
    expect(transactionsRouteOf("https://api-dsk.santander.cl/perdsk/consultaUltimosMovimientos")).toBeNull();
    expect(transactionsRouteOf("https://openbanking.santander.cl/other/v1/current-accounts/balances")).toBeNull();
  });
});

describe("transactionsRequestAccount", () => {
  it("reads the Apigee body (accountId + currency), as JSON text or parsed", () => {
    const body = { accountId: `0401${USD_NUMBER}`, currency: "USD", commercialGroup: "CCC", openingDate: "2026-09-01", closingDate: "2026-10-09" };
    expect(transactionsRequestAccount(APIGEE_URL, JSON.stringify(body))).toEqual({ route: "apigee", account: `0401${USD_NUMBER}`, currency: "USD" });
    expect(transactionsRequestAccount(APIGEE_URL, body)).toEqual({ route: "apigee", account: `0401${USD_NUMBER}`, currency: "USD" });
  });

  it("reads the Tibco body (Entrada.NumeroCuenta + Divisa)", () => {
    const body = { Cabecera: {}, Entrada: { NumeroCuenta: USD_NUMBER, Divisa: "USD" } };
    expect(transactionsRequestAccount(TIBCO_URL, JSON.stringify(body))).toEqual({ route: "tibco", account: USD_NUMBER, currency: "USD" });
    expect(transactionsRequestAccount(TIBCO_URL, { Entrada: { NumeroCuenta: USD_NUMBER } })).toEqual({ route: "tibco", account: USD_NUMBER, currency: null });
  });

  it("answers null for another endpoint, an empty or unparseable body, or a body naming no account", () => {
    expect(transactionsRequestAccount("https://api-dsk.santander.cl/perdsk/consultaUltimosMovimientos", "{}")).toBeNull();
    expect(transactionsRequestAccount(APIGEE_URL, null)).toBeNull();
    expect(transactionsRequestAccount(APIGEE_URL, "not json")).toBeNull();
    expect(transactionsRequestAccount(APIGEE_URL, { currency: "USD" })).toBeNull();
  });
});

describe("requestNamesUsdAccount", () => {
  it("matches the configured number at the end of the request's account, leading zeros ignored", () => {
    expect(requestNamesUsdAccount({ route: "apigee", account: `0401${USD_NUMBER}`, currency: "USD" }, USD_NUMBER)).toBe(true);
    expect(requestNamesUsdAccount({ route: "tibco", account: USD_NUMBER.replace(/^0+/, ""), currency: null }, USD_NUMBER)).toBe(true);
    expect(requestNamesUsdAccount({ route: "apigee", account: "0401009900119999", currency: "USD" }, USD_NUMBER)).toBe(false);
    expect(requestNamesUsdAccount({ route: "apigee", account: `0401${USD_NUMBER}`, currency: "CLP" }, USD_NUMBER)).toBe(false);
    expect(requestNamesUsdAccount({ route: "apigee", account: `0401${USD_NUMBER}`, currency: "USD" }, "")).toBe(false);
  });
});

describe("writeUsdCapture", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "nw-usd-capture-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes the request without headers, the raw response verbatim, and meta.json", () => {
    const call: UsdTransactionsCall = {
      url: APIGEE_URL,
      status: 200,
      requestBody: JSON.stringify({ accountId: `0401${USD_NUMBER}`, currency: "USD" }),
      responseBody: '{"data":{"transactions":[{"amount":"1.50"}]}}\n',
      receivedAt: "2026-10-09T01:02:03.000Z",
      request: { route: "apigee", account: `0401${USD_NUMBER}`, currency: "USD" },
    };
    const out = writeUsdCapture(dir, "2026-10-09T01-02-00", call, { fetchedAt: "2026-10-09T01:02:04.000Z", slideIndex: 3, carouselLabels: ["Cuenta Corriente", "Cta Corriente MX"] }, "slide.png");
    expect(path.basename(out)).toBe("2026-10-09T01-02-00-usd");
    expect(fs.readFileSync(path.join(out, "response.json"), "utf8")).toBe(call.responseBody);
    const request = JSON.parse(fs.readFileSync(path.join(out, "request.json"), "utf8")) as Record<string, unknown>;
    expect(request).toEqual({ url: APIGEE_URL, route: "apigee", status: 200, receivedAt: call.receivedAt, body: call.requestBody });
    expect(Object.keys(request)).not.toContain("headers");
    const meta = JSON.parse(fs.readFileSync(path.join(out, "meta.json"), "utf8")) as Record<string, unknown>;
    expect(meta).toEqual({
      fetchedAt: "2026-10-09T01:02:04.000Z",
      slideIndex: 3,
      route: "apigee",
      status: 200,
      carouselLabels: ["Cuenta Corriente", "Cta Corriente MX"],
      requestFile: "request.json",
      responseFile: "response.json",
      screenshotFile: "slide.png",
    });
  });
});

describe("the santander-fetch.json usd_checking_account_number field", () => {
  let cfraserDir: string;
  let prevEnv: string | undefined;
  beforeEach(() => {
    cfraserDir = fs.mkdtempSync(path.join(os.tmpdir(), "nw-cfraser-"));
    prevEnv = process.env.CFRASER_CSV_DIR;
    process.env.CFRASER_CSV_DIR = cfraserDir;
  });
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.CFRASER_CSV_DIR;
    else process.env.CFRASER_CSV_DIR = prevEnv;
    fs.rmSync(cfraserDir, { recursive: true, force: true });
  });
  const write = (cfg: Record<string, unknown>) =>
    fs.writeFileSync(path.join(cfraserDir, "santander-fetch.json"), JSON.stringify({ rut: "11.111.111-1", ...cfg }));

  it("is null when absent and the digits when declared", () => {
    write({});
    expect(loadBankConfig("santander").usd_checking_account_number).toBeNull();
    write({ usd_checking_account_number: USD_NUMBER });
    expect(loadBankConfig("santander").usd_checking_account_number).toBe(USD_NUMBER);
  });

  it("refuses a value that is not the number's digits", () => {
    write({ usd_checking_account_number: "0-099-00-11223-3" });
    expect(() => loadBankConfig("santander")).toThrow(/digits only/);
  });
});

describe("the Santander recorder's host filter", () => {
  it("records both API hosts and nothing else", () => {
    const recorder = new Recorder(false, "t", "santander", SANTANDER_API_HOST_FRAGMENTS);
    expect(recorder.recordsUrl(TIBCO_URL)).toBe(true);
    expect(recorder.recordsUrl(APIGEE_URL)).toBe(true);
    expect(recorder.recordsUrl("https://mibanco.santander.cl/UI.Web.HB/Private_new/frame/")).toBe(false);
    expect(new Recorder(false, "t", "santander", "api-dsk.santander.cl").recordsUrl(APIGEE_URL)).toBe(false);
    expect(new Recorder(false, "t", "racional").recordsUrl("https://anything.example/x")).toBe(true);
  });
});
