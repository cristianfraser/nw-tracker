import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The routes that used to answer every throw with a 400: a request the user can fix still answers
 * 400 with its message; a throw that is not about the request reaches the 500 middleware.
 */
const failing = vi.hoisted(() => ({
  fxBidAsk: false,
  payrollCandidates: false,
  refundMark: null as Error | null,
  merchantBackfill: false,
  marketTicker: false,
  depositsReconciliation: false,
  /** What the provider answers for a symbol: an error to throw, or null for the real provider. */
  describeSymbol: null as Error | null,
  instrumentRegistry: false,
}));

vi.mock("../ccExpenseGenericTransferBackfill.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ccExpenseGenericTransferBackfill.js")>();
  return {
    ...actual,
    backfillGenericTransferUniquePurchases: () => {
      if (failing.merchantBackfill) throw new Error("vitest: the backfill failed");
      return actual.backfillGenericTransferUniquePurchases();
    },
  };
});

vi.mock("../marketTicker.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../marketTicker.js")>();
  return {
    ...actual,
    getMarketTickerPayload: (...args: Parameters<typeof actual.getMarketTickerPayload>) => {
      if (failing.marketTicker) throw new Error("vitest: the ticker could not be built");
      return actual.getMarketTickerPayload(...args);
    },
  };
});

vi.mock("../flowsDepositsReconciliation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../flowsDepositsReconciliation.js")>();
  return {
    ...actual,
    buildDepositsReconciliationPayload: (...args: Parameters<typeof actual.buildDepositsReconciliationPayload>) => {
      if (failing.depositsReconciliation) throw new Error("vitest: the reconciliation could not be built");
      return actual.buildDepositsReconciliationPayload(...args);
    },
  };
});

vi.mock("../priceProviders/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../priceProviders/index.js")>();
  return {
    ...actual,
    describeSymbol: async (symbol: string) => {
      if (failing.describeSymbol) throw failing.describeSymbol;
      return { quote_currency: "usd", market_kind: "nyse", name: null, exchange: null, instrument_type: "EQUITY", display_symbol: symbol };
    },
  };
});

vi.mock("../marketSymbols.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../marketSymbols.js")>();
  return {
    ...actual,
    registerInstrument: (...args: Parameters<typeof actual.registerInstrument>) => {
      if (failing.instrumentRegistry) throw new Error("vitest: the registry write failed");
      return actual.registerInstrument(...args);
    },
  };
});

vi.mock("../fxBidAskGaps.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../fxBidAskGaps.js")>();
  return {
    ...actual,
    upsertManualFxBidAskRow: (...args: Parameters<typeof actual.upsertManualFxBidAskRow>) => {
      if (failing.fxBidAsk) throw new Error("vitest: the bid/ask write failed");
      return actual.upsertManualFxBidAskRow(...args);
    },
  };
});

vi.mock("../payrollWorkEarningsLinking.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../payrollWorkEarningsLinking.js")>();
  return {
    ...actual,
    listPayrollLinkCandidates: () => {
      if (failing.payrollCandidates) throw new Error("vitest: the candidates could not be built");
      return actual.listPayrollLinkCandidates();
    },
  };
});

vi.mock("../checkingExpenseRefunds.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../checkingExpenseRefunds.js")>();
  return {
    ...actual,
    markCheckingExpenseRefund: (...args: Parameters<typeof actual.markCheckingExpenseRefund>) => {
      if (failing.refundMark) throw failing.refundMark;
      return actual.markCheckingExpenseRefund(...args);
    },
  };
});

const { db } = await import("../db.js");
const { registerMarketRoutes } = await import("./market.js");
const { registerMortgageRoutes } = await import("./mortgage.js");
const { registerUsageRoutes } = await import("./usage.js");
const { registerCreditCardRoutes } = await import("./creditCard.js");
const { registerFlowsRoutes } = await import("./flows.js");
const { registerSyncRoutes } = await import("./sync.js");
const { registerMovementMirrorsRoutes } = await import("./movementMirrors.js");

let server: Server;
let base = "";

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  registerMarketRoutes(app);
  registerMortgageRoutes(app);
  registerUsageRoutes(app);
  registerCreditCardRoutes(app);
  registerFlowsRoutes(app);
  registerSyncRoutes(app);
  registerMovementMirrorsRoutes(app);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err), terminal: true });
  });
  server = await new Promise<Server>((resolve) => {
    const started: Server = app.listen(0, "127.0.0.1", () => resolve(started));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: { error?: string; terminal?: boolean } }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as { error?: string; terminal?: boolean } };
}

const UNKNOWN_ID = 987_654_321;

describe("market routes", () => {
  it("fx bid/ask: a bad body is a 400, a failing write a 500", async () => {
    const bad = await call("POST", "/api/fx/bid-ask", { date: "2031-01-02", buy_clp_per_usd: 900, sell_clp_per_usd: 910 });
    expect(bad.status).toBe(400);
    failing.fxBidAsk = true;
    try {
        const broken = await call("POST", "/api/fx/bid-ask", { date: "2031-01-02", buy_clp_per_usd: 910, sell_clp_per_usd: 900 });
        expect(broken.status).toBe(500);
        expect(broken.json.terminal).toBe(true);
    } finally {
      failing.fxBidAsk = false;
    }
  });

  it("equity splits: a ratio that is no split is a 400 with the reason", async () => {
    const r = await call("POST", "/api/equity-splits", { ticker: "SPY", ex_date: "2020-01-02", numerator: 2, denominator: 2 });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/is not a split/);
    expect(r.json.terminal).toBeUndefined();
  });

  it("watchlist: an unknown row or a bad field is a 400", async () => {
    const missing = await call("PATCH", `/api/watchlist/${UNKNOWN_ID}`, { sort_order: 3 });
    expect(missing).toMatchObject({ status: 400, json: { error: `watchlist row ${UNKNOWN_ID} not found` } });
    const slug = "vitest_input_errors_builtin";
    db.prepare(`DELETE FROM market_display_series WHERE slug = ?`).run(slug);
    const row = { id: Number(db.prepare(`INSERT INTO market_display_series (slug, label, kind, source) VALUES (?, 'Vitest', 'uf', 'builtin')`).run(slug).lastInsertRowid) };
    try {
    const badField = await call("PATCH", `/api/watchlist/${row.id}`, { show_in_marquee: 2 });
    expect(badField).toMatchObject({ status: 400, json: { error: "show_in_marquee must be 0 or 1" } });
    const builtIn = await call("DELETE", `/api/watchlist/${row.id}`);
    expect(builtIn).toMatchObject({ status: 400, json: { error: "only manual watchlist rows can be deleted" } });
    const gone = await call("DELETE", `/api/watchlist/${UNKNOWN_ID}`);
    expect(gone.status).toBe(400);
    } finally {
      db.prepare(`DELETE FROM market_display_series WHERE slug = ?`).run(slug);
    }
  });
});

describe("routes that used to answer a failing read by hand", () => {
  it("market ticker and deposits reconciliation: a failing build reaches the 500 middleware", async () => {
    failing.marketTicker = true;
    failing.depositsReconciliation = true;
    try {
      const ticker = await call("GET", "/api/market-ticker");
      expect(ticker).toMatchObject({ status: 500, json: { error: "vitest: the ticker could not be built", terminal: true } });
      const reconciliation = await call("GET", "/api/flows/deposits/reconciliation");
      expect(reconciliation).toMatchObject({
        status: 500,
        json: { error: "vitest: the reconciliation could not be built", terminal: true },
      });
    } finally {
      failing.marketTicker = false;
      failing.depositsReconciliation = false;
    }
  });
});

describe("watchlist add route", () => {
  const TICKER = "ZZVTADD";
  const clean = () => {
    db.prepare(`DELETE FROM market_display_series WHERE series_key = ?`).run(TICKER);
    db.prepare(`DELETE FROM market_symbols WHERE ticker = ?`).run(TICKER);
  };

  it("a malformed symbol is a 400, a listed one a 409, a symbol the provider refuses a 502, a failing add a 500", async () => {
    clean();
    try {
      const malformed = await call("POST", "/api/watchlist", { ticker: "not a ticker!" });
      expect(malformed).toMatchObject({ status: 400, json: { error: "invalid ticker symbol" } });

      failing.describeSymbol = new Error(`Yahoo has no price for ${TICKER}`);
      const refused = await call("POST", "/api/watchlist", { ticker: TICKER });
      expect(refused).toMatchObject({ status: 502, json: { error: `Yahoo has no price for ${TICKER}` } });
      expect(refused.json.terminal).toBeUndefined();
      failing.describeSymbol = null;

      failing.instrumentRegistry = true;
      const broken = await call("POST", "/api/watchlist", { ticker: TICKER });
      expect(broken).toMatchObject({ status: 500, json: { error: "vitest: the registry write failed", terminal: true } });
      failing.instrumentRegistry = false;
      expect(db.prepare(`SELECT 1 FROM market_display_series WHERE series_key = ?`).get(TICKER)).toBeUndefined();

      db.prepare(
        `INSERT INTO market_display_series (slug, label, kind, series_key, source) VALUES (?, ?, 'equity', ?, 'manual')`
      ).run(`vitest_input_errors_${TICKER.toLowerCase()}`, TICKER, TICKER);
      const listed = await call("POST", "/api/watchlist", { ticker: TICKER.toLowerCase() });
      expect(listed).toMatchObject({ status: 409, json: { error: `ticker ${TICKER} is already on the watchlist` } });
    } finally {
      failing.describeSymbol = null;
      failing.instrumentRegistry = false;
      clean();
    }
  });
});

describe("generic unique merchants routes", () => {
  const KEY = "VITEST INPUT ERRORS MERCHANT";
  const clean = () => db.prepare(`DELETE FROM cc_expense_generic_unique_merchants WHERE merchant_key LIKE 'VITEST INPUT ERRORS%'`).run();

  it("a listed key is a 409, an unknown id a 404, a failing backfill a 500", async () => {
    clean();
    try {
      const created = await call("POST", "/api/import-sync/generic-unique-merchants", { merchant: KEY });
      expect(created.status).toBe(200);
      const id = (created.json as unknown as { row: { id: number; merchant_key: string } }).row.id;
      const key = (created.json as unknown as { row: { merchant_key: string } }).row.merchant_key;

      const twice = await call("POST", "/api/import-sync/generic-unique-merchants", { merchant: KEY });
      expect(twice).toMatchObject({ status: 409, json: { error: "merchant_key already exists" } });
      const noBody = await call("POST", "/api/import-sync/generic-unique-merchants", {});
      expect(noBody).toMatchObject({ status: 400, json: { error: "merchant required" } });

      const missing = await call("PATCH", `/api/import-sync/generic-unique-merchants/${UNKNOWN_ID}`, { merchant: `${KEY} 2` });
      expect(missing).toMatchObject({ status: 404, json: { error: "not found" } });
      const other = await call("POST", "/api/import-sync/generic-unique-merchants", { merchant: `${KEY} 2` });
      const otherId = (other.json as unknown as { row: { id: number } }).row.id;
      const clash = await call("PATCH", `/api/import-sync/generic-unique-merchants/${otherId}`, { merchant: key });
      expect(clash).toMatchObject({ status: 409, json: { error: "merchant_key already exists" } });

      failing.merchantBackfill = true;
      const broken = await call("PATCH", `/api/import-sync/generic-unique-merchants/${id}`, { merchant: `${KEY} 3` });
      expect(broken).toMatchObject({ status: 500, json: { error: "vitest: the backfill failed", terminal: true } });
      failing.merchantBackfill = false;

      const res = await fetch(`${base}/api/import-sync/generic-unique-merchants/${id}`, { method: "DELETE" });
      expect(res.status).toBe(204);
      const gone = await call("DELETE", `/api/import-sync/generic-unique-merchants/${id}`);
      expect(gone).toMatchObject({ status: 404, json: { error: "not found" } });
    } finally {
      failing.merchantBackfill = false;
      clean();
    }
  });
});

describe("card-payment mirror conversion route", () => {
  it("a pair that is no current candidate is a 409", async () => {
    const stale = await call("POST", "/api/movement-mirrors/convert-cc-payments", {
      pairs: [{ out_movement_id: UNKNOWN_ID, statement_line_id: null, statement_id: null }],
    });
    expect(stale.status).toBe(409);
    expect(stale.json.error).toMatch(/not a current candidate/);
    expect(stale.json.terminal).toBeUndefined();
    const noPairs = await call("POST", "/api/movement-mirrors/convert-cc-payments", { pairs: [] });
    expect(noPairs.status).toBe(400);
  });
});

describe("mortgage routes", () => {
  it("a body without its figures and an account that is no loan are 400s", async () => {
    const noBody = await call("POST", `/api/accounts/${UNKNOWN_ID}/mortgage-payments/preview`, {});
    expect(noBody).toMatchObject({ status: 400, json: { error: "occurred_on is required" } });
    const body = { occurred_on: "2031-01-10", pago_clp: 500_000, interes_clp: 200_000, incendio_clp: 10_000 };
    for (const path of ["mortgage-payments/preview", "mortgage-payments"]) {
      const r = await call("POST", `/api/accounts/${UNKNOWN_ID}/${path}`, body);
      expect(r).toMatchObject({ status: 400, json: { error: "Account not found" } });
    }
  });
});

describe("usage routes", () => {
  it("a window that is not offered is a 400", async () => {
    const report = await call("GET", "/api/usage/report?days=5");
    expect(report.status).toBe(400);
    expect(report.json.error).toMatch(/days must be one of/);
    const trend = await call("GET", "/api/usage/endpoint-trend?method=GET&route=/api/x&days=5");
    expect(trend.status).toBe(400);
  });
});

describe("credit-card config route", () => {
  it("a body the parser refuses is a 400", async () => {
    const card = db.prepare(`SELECT account_id AS id FROM credit_card_account_config ORDER BY account_id LIMIT 1`).get() as { id: number } | undefined;
    if (!card) throw new Error("the test database has no card master");
    const unknownField = await call("PATCH", `/api/accounts/${card.id}/credit-card-config`, { nope: 1 });
    expect(unknownField).toMatchObject({ status: 400, json: { error: "unknown field: nope" } });
    const unknownCurrency = await call("PATCH", `/api/accounts/${card.id}/credit-card-config`, { cupo: [{ currency: "zzz", value: 1 }] });
    expect(unknownCurrency).toMatchObject({ status: 400, json: { error: "cupo entry currency zzz is not a known currency" } });
  });
});

describe("income routes", () => {
  it("work earnings: a movement that is no candidate is a 400, candidates that cannot be built a 500", async () => {
    const notCandidate = await call("PATCH", "/api/work-earnings/1", { movement_id: UNKNOWN_ID });
    expect(notCandidate).toMatchObject({ status: 400, json: { error: `movement ${UNKNOWN_ID} is not an eligible checking income inflow` } });
    failing.payrollCandidates = true;
    try {
      const broken = await call("PATCH", "/api/work-earnings/1", { movement_id: UNKNOWN_ID });
      expect(broken.status).toBe(500);
    } finally {
      failing.payrollCandidates = false;
    }
  });

  it("refund: the stated status answers, any other throw is a 500", async () => {
    const unknown = await call("POST", `/api/income/movements/${UNKNOWN_ID}/refund`, {});
    expect(unknown).toMatchObject({ status: 404, json: { error: `movement ${UNKNOWN_ID} not found` } });
    failing.refundMark = new Error("vitest: the refund write failed");
    try {
      const broken = await call("POST", `/api/income/movements/${UNKNOWN_ID}/refund`, {});
      expect(broken.status).toBe(500);
      expect(broken.json.terminal).toBe(true);
    } finally {
      failing.refundMark = null;
    }
  });
});
