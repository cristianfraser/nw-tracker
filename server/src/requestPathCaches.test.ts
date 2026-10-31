import { afterAll, describe, expect, it } from "vitest";
import { clearAggregationCache, invalidateAggregationForAccountDate } from "./aggregationCache.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { buildDashboardNavContext, buildDashboardNavSnapshot } from "./dashboardAccounts.js";
import { db } from "./db.js";
import { buildFlowsExpensesPayload } from "./flowsExpenses.js";
import { buildFlowsExpensesGastosPayload } from "./flowsExpensesGastos.js";
import { cachedFlowsExpensesGastosPayload, cachedFlowsExpensesPayload } from "./flowsMortgageCarrying.js";
import { MOVEMENT_AMOUNT_COLUMNS_SQL } from "./movementAmounts.js";
import {
  signedClpDeltaForAccountMovement,
  signedUsdDeltaForAccountMovement,
  sumClpThroughDate,
  sumUsdThroughDate,
  transferFromLegUnits,
  transferLegUnitsThroughDate,
  transferToLegUnits,
  type MovementTransferRow,
} from "./movementTransfer.js";
import { getDashboardOverviewBlock } from "./valuationTimeseries.js";
import { createManualCcInstallmentPurchase, deleteManualCcInstallmentPurchase } from "./ccInstallmentManual.js";
import { creditCardGroupLedgerResponse } from "./creditCardGroupLedger.js";
import { creditCardInstallmentsResponse } from "./creditCardInstallments.js";
import { listCreditCardMasterAccountIds } from "./creditCardTree.js";
import { snapshotTables } from "./test/snapshotTables.js";
import { buildAccountDetailBundle, cachedAccountDetailBundle } from "./accountDetailBundle.js";

afterAll(() => clearAggregationCache());

/** The per-call SQL sums the ledger prefix replaced, verbatim. */
function sqlSums(accountId: number, asOfYmd: string): { clp: number; usd: number; legUnits: number } {
  const rows = db
    .prepare(
      `SELECT account_id, from_account_id, to_account_id, ${MOVEMENT_AMOUNT_COLUMNS_SQL}, units_delta, flow_kind, note
       FROM movements
       WHERE (account_id = ? OR from_account_id = ? OR to_account_id = ?)
         AND occurred_on <= ?`
    )
    .all(accountId, accountId, accountId, asOfYmd) as MovementTransferRow[];
  let clp = 0;
  let usd = 0;
  for (const r of rows) {
    clp += signedClpDeltaForAccountMovement(r, accountId);
    usd += signedUsdDeltaForAccountMovement(r, accountId);
  }
  const legs = db
    .prepare(
      `SELECT from_account_id, to_account_id, units_delta, counter_units_delta, flow_kind
       FROM movements
       WHERE account_id IS NULL AND units_delta IS NOT NULL
         AND (from_account_id = ? OR to_account_id = ?)
         AND date(occurred_on) <= date(?)`
    )
    .all(accountId, accountId, asOfYmd) as MovementTransferRow[];
  let legUnits = 0;
  for (const r of legs) {
    if (r.flow_kind != null && ["stock_buy", "stock_sell", "compra_usd", "compra_usd_venta_clp"].includes(r.flow_kind)) {
      continue;
    }
    if (r.to_account_id === accountId) legUnits += Math.abs(transferToLegUnits(r) ?? 0);
    else if (r.from_account_id === accountId) legUnits -= Math.abs(transferFromLegUnits(r) ?? 0);
  }
  return { clp: Math.round(clp), usd, legUnits };
}

function ledgerSums(accountId: number, asOfYmd: string) {
  return {
    clp: sumClpThroughDate(accountId, asOfYmd),
    usd: sumUsdThroughDate(accountId, asOfYmd),
    legUnits: transferLegUnitsThroughDate(accountId, asOfYmd),
  };
}

describe("movement ledger prefix sums", () => {
  it("equal the per-call SQL sums to the last bit, for every account and movement day", () => {
    clearAggregationCache();
    const accountIds = (db.prepare(`SELECT id FROM accounts ORDER BY id`).all() as { id: number }[]).map((r) => r.id);
    const days = (db.prepare(`SELECT DISTINCT occurred_on AS d FROM movements ORDER BY d`).all() as { d: string }[]).map(
      (r) => r.d
    );
    const probes = [...days.filter((_, i) => i % 5 === 0), "1990-01-01", chileCalendarTodayYmd(), "9999-12-31"];
    let compared = 0;
    for (const id of accountIds) {
      for (const d of probes) {
        expect(ledgerSums(id, d)).toEqual(sqlSums(id, d));
        compared += 1;
      }
    }
    expect(compared).toBeGreaterThan(100);
  });

  it("see a write at once, inside a transaction and after it", () => {
    const accountId = (
      db.prepare(`SELECT account_id AS id FROM movements WHERE account_id IS NOT NULL AND currency = 'clp' LIMIT 1`).get() as {
        id: number;
      }
    ).id;
    const day = chileCalendarTodayYmd();
    const before = ledgerSums(accountId, day);
    const insert = () =>
      Number(
        db
          .prepare(`INSERT INTO movements (account_id, amount, currency, occurred_on, note) VALUES (?, 12345, 'clp', ?, 'vitest:ledger-prefix')`)
          .run(accountId, day).lastInsertRowid
      );
    // Inside a transaction: the uncommitted row counts, and is gone after the rollback.
    expect(() =>
      db.transaction(() => {
        insert();
        expect(ledgerSums(accountId, day)).toEqual(sqlSums(accountId, day));
        expect(ledgerSums(accountId, day).clp).not.toBe(before.clp);
        throw new Error("rollback");
      })()
    ).toThrow("rollback");
    expect(ledgerSums(accountId, day)).toEqual(before);
    // Outside a transaction: the mark-input log drops the cached prefix before the next read.
    const id = insert();
    try {
      expect(ledgerSums(accountId, day)).toEqual(sqlSums(accountId, day));
      expect(ledgerSums(accountId, day).clp).not.toBe(before.clp);
    } finally {
      db.prepare(`DELETE FROM movements WHERE id = ?`).run(id);
    }
    expect(ledgerSums(accountId, day)).toEqual(before);
  });
});

async function requestPathPayloads(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const unit of ["clp", "usd"] as const) {
    const includeUsd = unit === "usd";
    out.set(`nav_snapshot|${unit}`, JSON.stringify(await buildDashboardNavSnapshot(includeUsd)));
    out.set(`nav_context|${unit}`, JSON.stringify(await buildDashboardNavContext(includeUsd, unit)));
    out.set(`overview|${unit}`, JSON.stringify(getDashboardOverviewBlock(unit)));
    out.set(`gastos|${unit}`, JSON.stringify(cachedFlowsExpensesGastosPayload(unit, new Set())));
  }
  out.set("expenses", JSON.stringify(cachedFlowsExpensesPayload()));
  return out;
}

describe("request-path caches", () => {
  it("serve what a build from an empty cache serves, before and after a write", async () => {
    clearAggregationCache();
    const first = await requestPathPayloads();
    // The cached expense payloads are the uncached builds.
    expect(first.get("expenses")).toBe(JSON.stringify(buildFlowsExpensesPayload()));
    expect(first.get("gastos|clp")).toBe(JSON.stringify(buildFlowsExpensesGastosPayload("clp", new Set())));

    const accountId = (
      db.prepare(`SELECT account_id AS id FROM movements WHERE account_id IS NOT NULL AND currency = 'clp' LIMIT 1`).get() as {
        id: number;
      }
    ).id;
    const id = Number(
      db
        .prepare(`INSERT INTO movements (account_id, amount, currency, occurred_on, note) VALUES (?, 54321, 'clp', ?, 'vitest:request-caches')`)
        .run(accountId, chileCalendarTodayYmd()).lastInsertRowid
    );
    // What every writer does after a movement write (the consolidations are dropped there).
    invalidateAggregationForAccountDate(accountId, chileCalendarTodayYmd());
    try {
      const afterWrite = await requestPathPayloads();
      clearAggregationCache();
      const fresh = await requestPathPayloads();
      expect([...fresh.keys()].filter((k) => afterWrite.get(k) !== fresh.get(k))).toEqual([]);
      // The write reached the nav payloads (otherwise the comparison proves nothing).
      expect(afterWrite.get("nav_snapshot|clp")).not.toBe(first.get("nav_snapshot|clp"));
    } finally {
      db.prepare(`DELETE FROM movements WHERE id = ?`).run(id);
      clearAggregationCache();
    }
  }, 300_000);
});

/** The card ledgers of every master and every liabilities group, as served. */
function ccLedgerPayloads(): Map<string, string> {
  const out = new Map<string, string>();
  for (const id of listCreditCardMasterAccountIds()) out.set(`card|${id}`, JSON.stringify(creditCardInstallmentsResponse(id)));
  const slugs = (
    db.prepare(`SELECT slug FROM portfolio_groups WHERE slug LIKE 'liabilities%'`).all() as { slug: string }[]
  ).map((r) => r.slug);
  for (const slug of ["liabilities", ...slugs]) out.set(`group|${slug}`, JSON.stringify(creditCardGroupLedgerResponse(slug)));
  return out;
}

/** Uncached: built inside a transaction (the caches build afresh there), rolled back. */
function ccLedgerPayloadsUncached(): Map<string, string> {
  let out = new Map<string, string>();
  try {
    db.transaction(() => {
      out = ccLedgerPayloads();
      throw new Error("rollback");
    })();
  } catch (e) {
    if (!(e instanceof Error) || e.message !== "rollback") throw e;
  }
  return out;
}

describe("card ledger caches", () => {
  it("serve the uncached build, before and after a card write", () => {
    const restoreCardTables = snapshotTables(["valuations", "cc_billing_month_balances"]);
    clearAggregationCache();
    const masterId = listCreditCardMasterAccountIds()[0];
    expect(masterId).toBeDefined();
    const first = ccLedgerPayloads();
    expect(ccLedgerPayloads()).toEqual(first); // the cached reads
    const uncached = ccLedgerPayloadsUncached();
    expect([...first.keys()].filter((k) => first.get(k) !== uncached.get(k))).toEqual([]);

    const { id } = createManualCcInstallmentPurchase(masterId!, {
      purchase_date: chileCalendarTodayYmd(),
      total_amount_clp: 120_000,
      cuotas_totales: 3,
      merchant: "VITEST LEDGER CACHE",
    });
    try {
      const afterWrite = ccLedgerPayloads();
      expect(afterWrite.get(`card|${masterId}`)).not.toBe(first.get(`card|${masterId}`));
      const fresh = ccLedgerPayloadsUncached();
      expect([...fresh.keys()].filter((k) => afterWrite.get(k) !== fresh.get(k))).toEqual([]);
    } finally {
      deleteManualCcInstallmentPurchase(masterId!, id);
      // The plan's writers re-stamp today's valuation and the month snapshot: put them back.
      restoreCardTables();
    }
    clearAggregationCache();
    expect(ccLedgerPayloads()).toEqual(first);
  }, 300_000);
});

describe("account detail bundle cache", () => {
  it("serves the uncached build for every account, before and after a write", async () => {
    clearAggregationCache();
    const ids = (db.prepare(`SELECT id FROM accounts ORDER BY id`).all() as { id: number }[]).map((r) => r.id);
    const snap = async (build: typeof buildAccountDetailBundle) => {
      const out = new Map<string, string>();
      for (const id of ids) {
        for (const unit of ["clp", "usd"] as const) out.set(`${id}|${unit}`, JSON.stringify(await build(id, unit, "monthly")));
      }
      return out;
    };
    const cached = await snap(cachedAccountDetailBundle);
    expect(await snap(cachedAccountDetailBundle)).toEqual(cached);
    const fresh = await snap(buildAccountDetailBundle);
    expect([...fresh.keys()].filter((k) => cached.get(k) !== fresh.get(k))).toEqual([]);

    const accountId = (
      db.prepare(`SELECT account_id AS id FROM movements WHERE account_id IS NOT NULL AND currency = 'clp' LIMIT 1`).get() as {
        id: number;
      }
    ).id;
    const id = Number(
      db
        .prepare(`INSERT INTO movements (account_id, amount, currency, occurred_on, note) VALUES (?, 54321, 'clp', ?, 'vitest:detail-bundle')`)
        .run(accountId, chileCalendarTodayYmd()).lastInsertRowid
    );
    invalidateAggregationForAccountDate(accountId, chileCalendarTodayYmd());
    try {
      const afterWrite = await snap(cachedAccountDetailBundle);
      expect(afterWrite.get(`${accountId}|clp`)).not.toBe(cached.get(`${accountId}|clp`));
      const freshAfter = await snap(buildAccountDetailBundle);
      expect([...freshAfter.keys()].filter((k) => afterWrite.get(k) !== freshAfter.get(k))).toEqual([]);
    } finally {
      db.prepare(`DELETE FROM movements WHERE id = ?`).run(id);
      clearAggregationCache();
    }
  }, 300_000);
});
