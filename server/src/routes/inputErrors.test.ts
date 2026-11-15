import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The routes that used to answer every throw with a 400: a request the user can fix still answers
 * 400 with its message; a throw that is not about the request reaches the 500 middleware.
 */
const failing = vi.hoisted(() => ({ fxBidAsk: false, payrollCandidates: false, refundMark: null as Error | null }));

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
