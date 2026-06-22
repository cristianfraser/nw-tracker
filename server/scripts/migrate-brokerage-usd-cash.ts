#!/usr/bin/env npx tsx
/**
 * Move brokerage FX/deposit rows to a USD cash account; convert share buys to USD→stock transfers.
 *
 * Usage:
 *   npx tsx server/scripts/migrate-brokerage-usd-cash.ts --usd-account-id=123 [--dry-run]
 */

import { db } from "../src/db.js";
import { equityTickerForAccount } from "../src/brokerageEquityMtm.js";
import { kindSlugForAccount } from "../src/portfolioGroupTree.js";
import { isUsdCashAccount } from "../src/usdCashAccounts.js";

function parseArgs(argv: string[]): { usdAccountId: number; dryRun: boolean } {
  let usdAccountId = 0;
  let dryRun = false;
  for (const arg of argv) {
    if (arg === "--dry-run") dryRun = true;
    const m = /^--usd-account-id=(\d+)$/.exec(arg);
    if (m) usdAccountId = Number(m[1]);
  }
  if (!Number.isFinite(usdAccountId) || usdAccountId <= 0) {
    throw new Error("--usd-account-id=<id> is required (create USD account via panel first)");
  }
  return { usdAccountId, dryRun };
}

type MovRow = {
  id: number;
  account_id: number;
  occurred_on: string;
  flow_kind: string | null;
  amount_clp: number;
  amount_usd: number | null;
  units_delta: number | null;
  ticker: string | null;
  note: string | null;
};

function isEquityBrokerageAccount(accountId: number): boolean {
  if (equityTickerForAccount(accountId)) return true;
  const kind = kindSlugForAccount(accountId);
  return kind === "spy" || kind === "vea" || kind === "oilk";
}

function hasUnits(row: MovRow): boolean {
  const u = row.units_delta;
  return u != null && Number.isFinite(u) && u !== 0;
}

function main() {
  const { usdAccountId, dryRun } = parseArgs(process.argv.slice(2));
  if (!isUsdCashAccount(usdAccountId)) {
    throw new Error(`account ${usdAccountId} is not a USD cash account`);
  }

  const stockAccounts = (
    db
      .prepare(
        `SELECT DISTINCT a.id FROM accounts a
         JOIN movements m ON m.account_id = a.id
         WHERE m.flow_kind IS NOT NULL`
      )
      .all() as { id: number }[]
  )
    .map((r) => r.id)
    .filter(isEquityBrokerageAccount);

  let moved = 0;
  let converted = 0;
  let skipped = 0;

  const updateAccount = db.prepare(`UPDATE movements SET account_id = ? WHERE id = ?`);
  const deleteMov = db.prepare(`DELETE FROM movements WHERE id = ?`);
  const insTransfer = db.prepare(
    `INSERT INTO movements (
       account_id, from_account_id, to_account_id, amount_clp, occurred_on, note,
       units_delta, flow_kind, amount_usd, ticker
     ) VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const existsMirror = db.prepare(
    `SELECT 1 FROM movements WHERE note = ? LIMIT 1`
  );

  const run = db.transaction(() => {
    for (const stockId of stockAccounts) {
      const rows = db
        .prepare(
          `SELECT id, account_id, occurred_on, flow_kind, amount_clp, amount_usd, units_delta, ticker, note
           FROM movements WHERE account_id = ? AND flow_kind IS NOT NULL
           ORDER BY occurred_on, id`
        )
        .all(stockId) as MovRow[];

      for (const row of rows) {
        const fk = row.flow_kind ?? "";
        if (fk === "dividend_usd") continue;

        if (fk === "deposit_clp" || fk === "withdrawal_clp") {
          if (!dryRun) updateAccount.run(usdAccountId, row.id);
          moved += 1;
          continue;
        }

        if (fk === "compra_usd" && !hasUnits(row)) {
          if (!dryRun) updateAccount.run(usdAccountId, row.id);
          moved += 1;
          continue;
        }

        if (fk === "compra_usd" && hasUnits(row)) {
          const mirrorNote = `migration:usd-cash|from=${stockId}|mov=${row.id}`;
          if (existsMirror.get(mirrorNote)) {
            skipped += 1;
            continue;
          }
          const amountUsd = row.amount_usd != null ? Math.abs(row.amount_usd) : 0;
          if (!dryRun) {
            insTransfer.run(
              usdAccountId,
              stockId,
              0,
              row.occurred_on,
              mirrorNote,
              row.units_delta,
              "stock_buy",
              amountUsd > 0 ? amountUsd : null,
              row.ticker
            );
            deleteMov.run(row.id);
          }
          converted += 1;
        }
      }
    }
  });

  run();

  if (dryRun) {
    console.log(`[dry-run] no changes written; counts reflect planned work for: ${stockAccounts.join(", ")}`);
  }

  console.log(
    JSON.stringify(
      {
        usd_account_id: usdAccountId,
        dry_run: dryRun,
        stock_accounts: stockAccounts,
        moved_to_usd: moved,
        converted_to_transfers: converted,
        skipped_idempotent: skipped,
      },
      null,
      2
    )
  );
}

main();
