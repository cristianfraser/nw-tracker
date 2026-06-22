#!/usr/bin/env npx tsx
/**
 * Consolidate USD-cash FX pairs and relabel stock transfers.
 *
 * 1. deposit_clp + compra_usd (same USD account, same date, matching CLP, no units)
 *    → one `compra_usd_venta_clp` row.
 * 2. Standalone compra_usd on USD account (no units, both CLP+USD) → `compra_usd_venta_clp`.
 * 3. Transfer rows with compra_usd + units → `stock_buy` / `stock_sell`.
 *
 * Usage:
 *   npx tsx server/scripts/migrate-brokerage-flow-kinds.ts [--dry-run]
 */

import { db } from "../src/db.js";
import { isUsdCashAccount } from "../src/usdCashAccounts.js";
import { isMovementTransferRow } from "../src/movementTransfer.js";

function parseArgs(argv: string[]): { dryRun: boolean } {
  return { dryRun: argv.includes("--dry-run") };
}

type MovRow = {
  id: number;
  account_id: number | null;
  from_account_id: number | null;
  to_account_id: number | null;
  occurred_on: string;
  flow_kind: string | null;
  amount_clp: number;
  amount_usd: number | null;
  units_delta: number | null;
  note: string | null;
};

function hasUnits(row: Pick<MovRow, "units_delta">): boolean {
  const u = row.units_delta;
  return u != null && Number.isFinite(u) && u !== 0;
}

function clpMagnitude(n: number | null | undefined): number {
  if (n == null || !Number.isFinite(n)) return 0;
  return Math.abs(n);
}

function listUsdCashAccountIds(): number[] {
  const rows = db.prepare(`SELECT id FROM accounts ORDER BY id`).all() as { id: number }[];
  return rows.map((r) => r.id).filter(isUsdCashAccount);
}

function main() {
  const { dryRun } = parseArgs(process.argv.slice(2));

  let mergedFxPairs = 0;
  let relabeledFxStandalone = 0;
  let relabeledStockTransfers = 0;
  let skipped = 0;

  const updateFlowKind = db.prepare(`UPDATE movements SET flow_kind = ? WHERE id = ?`);
  const updateFxMerge = db.prepare(
    `UPDATE movements SET flow_kind = 'compra_usd_venta_clp', amount_clp = ?, note = ? WHERE id = ?`
  );
  const deleteMov = db.prepare(`DELETE FROM movements WHERE id = ?`);
  const existsNote = db.prepare(`SELECT 1 FROM movements WHERE note = ? LIMIT 1`);

  const run = db.transaction(() => {
    for (const usdAccountId of listUsdCashAccountIds()) {
      const deposits = db
        .prepare(
          `SELECT id, account_id, occurred_on, flow_kind, amount_clp, amount_usd, units_delta, note
           FROM movements
           WHERE account_id = ? AND flow_kind = 'deposit_clp'
           ORDER BY occurred_on, id`
        )
        .all(usdAccountId) as MovRow[];

      for (const dep of deposits) {
        const compra = db
          .prepare(
            `SELECT id, account_id, occurred_on, flow_kind, amount_clp, amount_usd, units_delta, note
             FROM movements
             WHERE account_id = ?
               AND occurred_on = ?
               AND flow_kind = 'compra_usd'
               AND (units_delta IS NULL OR units_delta = 0)
             ORDER BY id
             LIMIT 1`
          )
          .get(usdAccountId, dep.occurred_on) as MovRow | undefined;

        if (!compra) continue;
        if (clpMagnitude(compra.amount_clp) !== clpMagnitude(dep.amount_clp)) continue;

        const mergeNote = `migration:fx-merge|dep=${dep.id}|compra=${compra.id}`;
        if (existsNote.get(mergeNote)) {
          skipped += 1;
          continue;
        }

        const clpAmt = clpMagnitude(compra.amount_clp) || clpMagnitude(dep.amount_clp);
        if (!dryRun) {
          updateFxMerge.run(clpAmt, mergeNote, compra.id);
          deleteMov.run(dep.id);
        }
        mergedFxPairs += 1;
      }

      const standaloneFx = db
        .prepare(
          `SELECT id, amount_clp, amount_usd, note
           FROM movements
           WHERE account_id = ?
             AND flow_kind = 'compra_usd'
             AND (units_delta IS NULL OR units_delta = 0)
             AND amount_usd IS NOT NULL
             AND amount_usd != 0`
        )
        .all(usdAccountId) as Pick<MovRow, "id" | "amount_clp" | "amount_usd" | "note">[];

      for (const row of standaloneFx) {
        if (clpMagnitude(row.amount_clp) === 0) continue;
        if (!dryRun) updateFlowKind.run("compra_usd_venta_clp", row.id);
        relabeledFxStandalone += 1;
      }
    }

    const transferRows = db
      .prepare(
        `SELECT id, account_id, from_account_id, to_account_id, flow_kind, units_delta, note
         FROM movements
         WHERE from_account_id IS NOT NULL AND to_account_id IS NOT NULL AND account_id IS NULL`
      )
      .all() as MovRow[];

    for (const row of transferRows) {
      if (!isMovementTransferRow(row)) continue;
      if (row.flow_kind !== "compra_usd" || !hasUnits(row)) continue;

      const note = row.note ?? "";
      if (note.startsWith("migration:stock-flow-kind|")) {
        skipped += 1;
        continue;
      }

      const nextKind = (row.units_delta ?? 0) > 0 ? "stock_buy" : "stock_sell";
      const nextNote = note.trim()
        ? `${note}|migration:stock-flow-kind`
        : `migration:stock-flow-kind|mov=${row.id}`;

      if (!dryRun) {
        db.prepare(`UPDATE movements SET flow_kind = ?, note = ? WHERE id = ?`).run(
          nextKind,
          nextNote,
          row.id
        );
      }
      relabeledStockTransfers += 1;
    }
  });

  run();

  if (dryRun) {
    console.log("[dry-run] no changes written; counts reflect planned work");
  }

  console.log(
    JSON.stringify(
      {
        dry_run: dryRun,
        merged_fx_pairs: mergedFxPairs,
        relabeled_fx_standalone: relabeledFxStandalone,
        relabeled_stock_transfers: relabeledStockTransfers,
        skipped_idempotent: skipped,
      },
      null,
      2
    )
  );
}

main();
