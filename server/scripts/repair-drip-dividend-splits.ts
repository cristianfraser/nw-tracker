/**
 * Report-first split of the 8 merged DRIP `dividend_usd` rows into explicit transfers,
 * so no brokerage flow is missing a counterpart account:
 *
 *   dividend_usd (single-leg on the stock, dividend cash + reinvested units on one row)
 *     → dividend_payout  stock → USD cash   (the dividend arriving as cash, no units)
 *     → stock_buy        USD cash → stock   (the reinvestment purchase, carries the units)
 *
 * Per-account handling:
 *   - SPY (6 rows) / OILK (1 row): true same-day DRIPs at Fintual → payout + buy both on
 *     the original row date, through Fintual USD. Capital-flow neutral to the peso (both
 *     legs are usd_reference at the same date, so they cancel exactly).
 *   - VEA (1 row): NOT reinvested on the dividend date (Racional pays cash; the ~US$5
 *     buy minimum forced a CLP topup). Real history: payout US$0,54 on 2026-03-24
 *     (ex-div, recorded in the row's own note) into Racional USD; the reinvestment was
 *     part of the single 2026-03-26 purchase. So the payout is inserted at 03-24 and the
 *     0,54 / 0,008543 units are ABSORBED into buy m10795 (54,68 → 55,22). The composite
 *     wire+residual branch in equityBrokerageCapitalFlows keeps the true 50.000 CLP wire
 *     at face; expected aportes drift is ref(0,54@03-26) − ref(0,54@03-24) ≈ +6 CLP.
 *
 * Also backfills ticker='VEA' on the existing payout m11105 (display-only).
 *
 * Abort-fast: the script verifies the exact expected DB state (row ids, accounts, dates,
 * amounts, units) and refuses to run on drift. Apply runs in one transaction with post-
 * assertions (share units bit-identical, cash USD balances unchanged, dividend USD totals
 * unchanged, capital-flow sums unchanged except VEA's documented +6 CLP) — any failure
 * rolls everything back.
 *
 * Usage (from server/):
 *   npx tsx scripts/repair-drip-dividend-splits.ts            # report only
 *   npx tsx scripts/repair-drip-dividend-splits.ts --apply    # write + verify + commit
 */
import { db } from "../src/db.js";
import { loadEquityBrokerageCapitalInflowEvents } from "../src/equityBrokerageCapitalFlows.js";
import { totalDividendsClpForAccount } from "../src/equityReturns.js";
import { usdToClpReferenceRounded } from "../src/fxRates.js";

const APPLY = process.argv.includes("--apply");

const USD_TOL = 1e-6;
const UNITS_TOL = 1e-9;

type AccountRow = { id: number; name: string; equity_ticker: string | null };

type MovementRow = {
  id: number;
  account_id: number | null;
  from_account_id: number | null;
  to_account_id: number | null;
  amount_clp: number | null;
  occurred_on: string;
  note: string | null;
  units_delta: number | null;
  flow_kind: string | null;
  amount_usd: number | null;
  ticker: string | null;
};

/** Expected merged rows — validated against the DB before anything is planned. */
const SPECS = [
  { id: 10252, stockKey: "import:excel|key=spy", occurred_on: "2025-01-31", usd: 1.7, units: 0.002830314, mode: "split" },
  { id: 10254, stockKey: "import:excel|key=spy", occurred_on: "2025-04-30", usd: 1.47, units: 0.002609733, mode: "split" },
  { id: 10256, stockKey: "import:excel|key=spy", occurred_on: "2025-07-31", usd: 1.53, units: 0.002426383, mode: "split" },
  { id: 10258, stockKey: "import:excel|key=spy", occurred_on: "2025-10-31", usd: 1.59, units: 0.002355415, mode: "split" },
  { id: 10260, stockKey: "import:excel|key=spy", occurred_on: "2026-01-30", usd: 1.74, units: 0.00252046, mode: "split" },
  { id: 10262, stockKey: "import:excel|key=spy", occurred_on: "2026-04-30", usd: 1.57, units: 0.002175298, mode: "split" },
  { id: 10796, stockKey: "import:panel|ticker=OILK|key=oilk", occurred_on: "2026-06-10", usd: 73.18, units: 1.296092947, mode: "split" },
  { id: 10269, stockKey: "import:excel|key=vea", occurred_on: "2026-03-27", usd: 0.54, units: 0.00854311424286759, mode: "absorb" },
] as const;

const CASH_KEY_BY_STOCK_KEY: Record<string, string> = {
  "import:excel|key=spy": "import:panel|kind=usd|key=fintual_usd",
  "import:panel|ticker=OILK|key=oilk": "import:panel|kind=usd|key=fintual_usd",
  "import:excel|key=vea": "import:panel|kind=usd|key=usd",
};

const VEA_PAYOUT_DATE = "2026-03-24"; // ex-div, recorded in m10269's note
const VEA_ABSORB_BUY_ID = 10795; // 2026-03-26 Racional USD → VEA, 54,68 / 0,86506942
const VEA_EXISTING_PAYOUT_ID = 11105; // 2026-06-23 payout missing ticker

function fail(msg: string): never {
  console.error(`\nABORT: ${msg}`);
  process.exit(1);
}

function accountByImportKey(key: string): AccountRow {
  const row = db
    .prepare(`SELECT id, name, equity_ticker FROM accounts WHERE import_key = ?`)
    .get(key) as AccountRow | undefined;
  if (!row) fail(`account with import_key ${key} not found`);
  return row;
}

function movementById(id: number): MovementRow | undefined {
  return db.prepare(`SELECT * FROM movements WHERE id = ?`).get(id) as MovementRow | undefined;
}

/** Any table column named like %movement_id% referencing the ids we plan to delete. */
function assertNoExternalRefs(ids: number[]): void {
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'movements'`)
    .all() as { name: string }[];
  const ph = ids.map(() => "?").join(",");
  for (const t of tables) {
    const cols = db.prepare(`PRAGMA table_info(${JSON.stringify(t.name)})`).all() as {
      name: string;
    }[];
    for (const c of cols) {
      if (!/movement_id$/i.test(c.name)) continue;
      const hit = db
        .prepare(`SELECT COUNT(*) AS n FROM ${JSON.stringify(t.name)} WHERE ${JSON.stringify(c.name)} IN (${ph})`)
        .get(...ids) as { n: number };
      if (hit.n > 0) fail(`${t.name}.${c.name} references ${hit.n} row(s) slated for deletion`);
    }
  }
}

/**
 * All-time share units over the share-unit flow kinds. Mirrors
 * `brokerageShareUnitsThroughDate` / `unitsDeltaForAccountMovement` (stock_sell: −abs on
 * the from leg; other transfers: units on the to leg; single-leg rows: as stored) —
 * inlined because importing `brokerageFlowMovement` as this script's module-graph entry
 * point TDZ-faults on its cycle with `brokerageEquityMtm`.
 */
function shareUnitsAllTime(accountId: number): number {
  const rows = db
    .prepare(
      `SELECT account_id, from_account_id, to_account_id, units_delta, flow_kind
       FROM movements
       WHERE (account_id = ? OR from_account_id = ? OR to_account_id = ?)
         AND flow_kind IN ('compra_usd', 'stock_buy', 'stock_sell', 'dividend_usd')`
    )
    .all(accountId, accountId, accountId) as MovementRow[];
  let total = 0;
  for (const r of rows) {
    const units = r.units_delta;
    if (units == null || !Number.isFinite(units) || units === 0) continue;
    if (r.account_id == null) {
      if (r.flow_kind === "stock_sell") {
        if (r.from_account_id === accountId) total -= Math.abs(units);
      } else if (r.to_account_id === accountId) {
        total += units;
      }
    } else if (r.account_id === accountId) {
      total += units;
    }
  }
  return total;
}

function usdBalance(cashId: number): number {
  const r = db
    .prepare(
      `SELECT
         COALESCE((SELECT SUM(amount_usd) FROM movements WHERE account_id = ? AND amount_usd IS NOT NULL), 0)
       + COALESCE((SELECT SUM(amount_usd) FROM movements WHERE to_account_id = ? AND amount_usd IS NOT NULL), 0)
       - COALESCE((SELECT SUM(amount_usd) FROM movements WHERE from_account_id = ? AND amount_usd IS NOT NULL), 0) AS bal`
    )
    .get(cashId, cashId, cashId) as { bal: number };
  return r.bal;
}

function dividendsUsd(stockId: number): number {
  const r = db
    .prepare(
      `SELECT
         COALESCE((SELECT SUM(amount_usd) FROM movements WHERE account_id = ? AND flow_kind = 'dividend_usd'), 0)
       + COALESCE((SELECT SUM(amount_usd) FROM movements WHERE from_account_id = ? AND flow_kind = 'dividend_payout'), 0) AS total`
    )
    .get(stockId, stockId) as { total: number };
  return r.total;
}

function capitalSum(stockId: number): number {
  const events = loadEquityBrokerageCapitalInflowEvents([stockId]).get(stockId) ?? [];
  return events.reduce((s, e) => s + e.amt, 0);
}

function fmtUsd(n: number): string {
  return n.toFixed(2).padStart(9);
}

function main(): void {
  // ── Resolve accounts ────────────────────────────────────────────────────────
  const stocks = new Map<string, AccountRow>();
  const cash = new Map<string, AccountRow>();
  for (const spec of SPECS) {
    if (!stocks.has(spec.stockKey)) stocks.set(spec.stockKey, accountByImportKey(spec.stockKey));
    const cashKey = CASH_KEY_BY_STOCK_KEY[spec.stockKey]!;
    if (!cash.has(cashKey)) cash.set(cashKey, accountByImportKey(cashKey));
  }
  const vea = stocks.get("import:excel|key=vea")!;
  const racional = cash.get("import:panel|kind=usd|key=usd")!;

  // ── Verify DB state matches the plan exactly ────────────────────────────────
  const allDrip = db
    .prepare(`SELECT id FROM movements WHERE flow_kind = 'dividend_usd' ORDER BY id`)
    .all() as { id: number }[];
  const expectedIds = [...SPECS.map((s) => s.id)].sort((a, b) => a - b);
  const actualIds = allDrip.map((r) => r.id);
  if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
    fail(`dividend_usd rows in DB [${actualIds}] != expected [${expectedIds}] — re-diagnose before running`);
  }

  const rows = new Map<number, MovementRow>();
  for (const spec of SPECS) {
    const m = movementById(spec.id);
    if (!m) fail(`movement ${spec.id} not found`);
    const stock = stocks.get(spec.stockKey)!;
    if (m.account_id !== stock.id) fail(`m${spec.id}: account_id ${m.account_id} != ${stock.id} (${stock.name})`);
    if (m.occurred_on !== spec.occurred_on) fail(`m${spec.id}: occurred_on ${m.occurred_on} != ${spec.occurred_on}`);
    if (Math.abs((m.amount_usd ?? 0) - spec.usd) > USD_TOL) fail(`m${spec.id}: amount_usd ${m.amount_usd} != ${spec.usd}`);
    if (Math.abs((m.units_delta ?? 0) - spec.units) > UNITS_TOL) fail(`m${spec.id}: units_delta ${m.units_delta} != ${spec.units}`);
    rows.set(spec.id, m);
  }

  const veaBuy = movementById(VEA_ABSORB_BUY_ID);
  if (
    !veaBuy ||
    veaBuy.flow_kind !== "stock_buy" ||
    veaBuy.from_account_id !== racional.id ||
    veaBuy.to_account_id !== vea.id ||
    veaBuy.occurred_on !== "2026-03-26" ||
    Math.abs((veaBuy.amount_usd ?? 0) - 54.68) > USD_TOL ||
    Math.abs((veaBuy.units_delta ?? 0) - 0.86506942) > UNITS_TOL
  ) {
    fail(`m${VEA_ABSORB_BUY_ID} is not the expected VEA buy (Racional USD → VEA, 2026-03-26, 54,68 / 0,86506942)`);
  }

  const veaPayout = movementById(VEA_EXISTING_PAYOUT_ID);
  if (!veaPayout || veaPayout.flow_kind !== "dividend_payout" || veaPayout.from_account_id !== vea.id) {
    fail(`m${VEA_EXISTING_PAYOUT_ID} is not the expected VEA dividend_payout`);
  }
  const backfill11105 = veaPayout.ticker == null;

  assertNoExternalRefs(SPECS.map((s) => s.id));

  // ── Pre metrics ─────────────────────────────────────────────────────────────
  const stockIds = [...stocks.values()].map((a) => a.id);
  const cashIds = [...cash.values()].map((a) => a.id);
  const pre = {
    units: new Map(stockIds.map((id) => [id, shareUnitsAllTime(id)])),
    cashUsd: new Map(cashIds.map((id) => [id, usdBalance(id)])),
    divUsd: new Map(stockIds.map((id) => [id, dividendsUsd(id)])),
    capital: new Map(stockIds.map((id) => [id, capitalSum(id)])),
    divClp: new Map(stockIds.map((id) => [id, totalDividendsClpForAccount(id)])),
  };

  // Expected VEA aportes drift under the composite wire+residual model.
  const veaRow = rows.get(10269)!;
  const newVeaBuyUsd = (veaBuy.amount_usd ?? 0) + (veaRow.amount_usd ?? 0);
  const residUsd = newVeaBuyUsd - 54.68; // what the reader will compute: buyUsd − wire.usd
  const refResid = usdToClpReferenceRounded(residUsd, veaBuy.occurred_on)!;
  const refPayout = usdToClpReferenceRounded(veaRow.amount_usd ?? 0, VEA_PAYOUT_DATE)!;
  const expectedVeaCapitalDelta = refResid - refPayout;

  // ── Plan ────────────────────────────────────────────────────────────────────
  console.log(`\n${APPLY ? "APPLY" : "DRY-RUN REPORT"} — split merged DRIP dividend_usd rows\n`);
  const nameOf = (id: number) =>
    [...stocks.values(), ...cash.values()].find((a) => a.id === id)?.name ?? `#${id}`;

  for (const spec of SPECS) {
    const m = rows.get(spec.id)!;
    const stock = stocks.get(spec.stockKey)!;
    const cashAcct = cash.get(CASH_KEY_BY_STOCK_KEY[spec.stockKey]!)!;
    const ticker = stock.equity_ticker ?? fail(`${stock.name} has no equity_ticker`);
    console.log(`m${spec.id}  ${ticker.padEnd(4)} ${m.occurred_on}  US$${fmtUsd(m.amount_usd!)}  units ${m.units_delta}`);
    if (spec.mode === "split") {
      console.log(`  + INSERT dividend_payout  ${stock.name} → ${cashAcct.name}  ${m.occurred_on}  US$${fmtUsd(m.amount_usd!)}  (no units)`);
      console.log(`  + INSERT stock_buy        ${cashAcct.name} → ${stock.name}  ${m.occurred_on}  US$${fmtUsd(m.amount_usd!)}  units ${m.units_delta}`);
    } else {
      console.log(`  + INSERT dividend_payout  ${stock.name} → ${cashAcct.name}  ${VEA_PAYOUT_DATE}  US$${fmtUsd(m.amount_usd!)}  (no units; ex-div date from note)`);
      console.log(
        `  ~ UPDATE m${VEA_ABSORB_BUY_ID} (${veaBuy.occurred_on} buy ← ${nameOf(veaBuy.from_account_id!)}): ` +
          `US$54,68 → US$${newVeaBuyUsd.toFixed(2)}  units 0,86506942 → ${(veaBuy.units_delta! + m.units_delta!)}`
      );
    }
    console.log(`  − DELETE m${spec.id}\n`);
  }
  if (backfill11105) {
    console.log(`m${VEA_EXISTING_PAYOUT_ID}  dividend_payout 2026-06-23 VEA → Racional USD: ticker NULL → 'VEA' (display-only)\n`);
  } else {
    console.log(`m${VEA_EXISTING_PAYOUT_ID}: ticker already set — skip\n`);
  }

  console.log("Pre metrics:");
  for (const [key, a] of stocks) {
    console.log(
      `  ${a.name.padEnd(12)} share units ${pre.units.get(a.id)}  dividends US$${fmtUsd(pre.divUsd.get(a.id)!)}  ` +
        `dividends ref CLP ${pre.divClp.get(a.id)}  capital Σ CLP ${pre.capital.get(a.id)}${key ? "" : ""}`
    );
  }
  for (const a of cash.values()) {
    console.log(`  ${a.name.padEnd(12)} USD balance ${fmtUsd(pre.cashUsd.get(a.id)!)}`);
  }
  console.log(
    `\nExpected post-apply deltas: all zero except VEA capital Σ ${expectedVeaCapitalDelta >= 0 ? "+" : ""}${expectedVeaCapitalDelta} CLP ` +
      `(= ref(${residUsd.toFixed(2)} @ ${veaBuy.occurred_on}) ${refResid} − ref(0,54 @ ${VEA_PAYOUT_DATE}) ${refPayout}), ` +
      `VEA dividends ref CLP moves by the 03-27 → 03-24 fx-day change (informational), and Racional USD holds +0,54 during 2026-03-24…25 only.`
  );

  if (!APPLY) {
    console.log("\nReport only — no changes written. Re-run with --apply to execute.");
    return;
  }

  // ── Apply ───────────────────────────────────────────────────────────────────
  const insertTransfer = db.prepare(
    `INSERT INTO movements (account_id, from_account_id, to_account_id, amount_clp, occurred_on, note, units_delta, flow_kind, amount_usd, ticker)
     VALUES (NULL, ?, ?, 0, ?, ?, ?, ?, ?, ?)`
  );

  const run = db.transaction(() => {
    for (const spec of SPECS) {
      const m = rows.get(spec.id)!;
      const stock = stocks.get(spec.stockKey)!;
      const cashAcct = cash.get(CASH_KEY_BY_STOCK_KEY[spec.stockKey]!)!;
      const ticker = stock.equity_ticker!;
      const payoutDate = spec.mode === "absorb" ? VEA_PAYOUT_DATE : m.occurred_on;
      insertTransfer.run(
        stock.id,
        cashAcct.id,
        payoutDate,
        `repair:drip-split|from=m${spec.id}|${m.note ?? ""}`,
        null,
        "dividend_payout",
        m.amount_usd,
        ticker
      );
      if (spec.mode === "split") {
        insertTransfer.run(
          cashAcct.id,
          stock.id,
          m.occurred_on,
          `repair:drip-split|from=m${spec.id}|reinvest|${m.note ?? ""}`,
          m.units_delta,
          "stock_buy",
          m.amount_usd,
          ticker
        );
      } else {
        db.prepare(
          `UPDATE movements
           SET amount_usd = amount_usd + ?, units_delta = units_delta + ?, note = COALESCE(note, '') || ?
           WHERE id = ?`
        ).run(m.amount_usd, m.units_delta, `|repair:drip-absorb|dividend=m${spec.id}`, VEA_ABSORB_BUY_ID);
      }
      db.prepare(`DELETE FROM movements WHERE id = ?`).run(spec.id);
    }
    if (backfill11105) {
      db.prepare(`UPDATE movements SET ticker = 'VEA' WHERE id = ?`).run(VEA_EXISTING_PAYOUT_ID);
    }

    // ── Post assertions (throw → whole transaction rolls back) ──────────────
    for (const a of stocks.values()) {
      const u = shareUnitsAllTime(a.id);
      if (Math.abs(u - pre.units.get(a.id)!) > UNITS_TOL) {
        throw new Error(`${a.name}: share units drifted ${pre.units.get(a.id)} → ${u}`);
      }
      const d = dividendsUsd(a.id);
      if (Math.abs(d - pre.divUsd.get(a.id)!) > USD_TOL) {
        throw new Error(`${a.name}: dividends USD drifted ${pre.divUsd.get(a.id)} → ${d}`);
      }
      const c = capitalSum(a.id);
      const expected = pre.capital.get(a.id)! + (a.id === vea.id ? expectedVeaCapitalDelta : 0);
      if (Math.round(c) !== Math.round(expected)) {
        throw new Error(`${a.name}: capital Σ ${pre.capital.get(a.id)} → ${c}, expected ${expected}`);
      }
    }
    for (const a of cash.values()) {
      const b = usdBalance(a.id);
      if (Math.abs(b - pre.cashUsd.get(a.id)!) > USD_TOL) {
        throw new Error(`${a.name}: USD balance drifted ${pre.cashUsd.get(a.id)} → ${b}`);
      }
    }
    const remaining = db
      .prepare(`SELECT COUNT(*) AS n FROM movements WHERE flow_kind = 'dividend_usd'`)
      .get() as { n: number };
    if (remaining.n !== 0) throw new Error(`${remaining.n} dividend_usd rows remain after split`);
  });

  run();

  console.log("\nApplied. Post metrics:");
  for (const a of stocks.values()) {
    console.log(
      `  ${a.name.padEnd(12)} share units ${shareUnitsAllTime(a.id)}  ` +
        `dividends US$${fmtUsd(dividendsUsd(a.id))}  dividends ref CLP ${totalDividendsClpForAccount(a.id)}  capital Σ CLP ${capitalSum(a.id)}`
    );
  }
  for (const a of cash.values()) {
    console.log(`  ${a.name.padEnd(12)} USD balance ${fmtUsd(usdBalance(a.id))}`);
  }
  console.log("\nAll assertions passed — committed. The running server picks this up via data_version (no restart needed).");
}

main();
