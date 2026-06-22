#!/usr/bin/env npx tsx

/**

 * Merge dividend_usd + matching stock_buy transfer (DRIP) into one dividend_usd row with units.

 * Also: partial DRIP (div < buy), orphan small DRIP buys with no dividend row.

 *

 * Usage:

 *   npx tsx server/scripts/migrate-drip-dividend-merge.ts [--dry-run]

 */



import { db } from "../src/db.js";

import { accountUsesEquityMtm } from "../src/brokerageEquityMtm.js";



const DRIP_USD_TOLERANCE = 0.02;

const MAX_DAYS_AFTER_DIVIDEND = 45;

const ORPHAN_DRIP_MAX_USD = 200;

const ORPHAN_DRIP_MAX_FRACTION_OF_LARGEST_BUY = 0.05;



function parseArgs(argv: string[]): { dryRun: boolean } {

  return { dryRun: argv.includes("--dry-run") };

}



function daysBetween(fromYmd: string, toYmd: string): number {

  const a = Date.parse(`${fromYmd}T12:00:00Z`);

  const b = Date.parse(`${toYmd}T12:00:00Z`);

  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.POSITIVE_INFINITY;

  return Math.round((b - a) / 86_400_000);

}



type DivRow = {

  id: number;

  account_id: number;

  occurred_on: string;

  amount_usd: number;

  units_delta: number | null;

  ticker: string | null;

  note: string | null;

};



type BuyRow = {

  id: number;

  to_account_id: number;

  occurred_on: string;

  amount_usd: number;

  units_delta: number | null;

  ticker: string | null;

  note: string | null;

};



function listEquityMtmAccountIds(): number[] {

  const rows = db.prepare(`SELECT id FROM accounts ORDER BY id`).all() as { id: number }[];

  return rows.map((r) => r.id).filter(accountUsesEquityMtm);

}



function main() {

  const { dryRun } = parseArgs(process.argv.slice(2));

  let merged = 0;

  let partialMerged = 0;

  let promotedOrphan = 0;

  let skipped = 0;



  const updateDiv = db.prepare(

    `UPDATE movements SET units_delta = ?, ticker = COALESCE(?, ticker), note = ? WHERE id = ?`

  );

  const deleteBuy = db.prepare(`DELETE FROM movements WHERE id = ?`);

  const insertDiv = db.prepare(

    `INSERT INTO movements (

       account_id, amount_clp, occurred_on, note, units_delta, flow_kind, amount_usd, ticker

     ) VALUES (?, 0, ?, ?, ?, 'dividend_usd', ?, ?)`

  );

  const existsNote = db.prepare(`SELECT 1 FROM movements WHERE note LIKE ? LIMIT 1`);



  const run = db.transaction(() => {

    for (const accountId of listEquityMtmAccountIds()) {

      const dividends = db

        .prepare(

          `SELECT id, account_id, occurred_on, amount_usd, units_delta, ticker, note

           FROM movements

           WHERE account_id = ? AND flow_kind = 'dividend_usd'

           ORDER BY occurred_on, id`

        )

        .all(accountId) as DivRow[];



      const buys = db

        .prepare(

          `SELECT id, to_account_id, occurred_on, amount_usd, units_delta, ticker, note

           FROM movements

           WHERE account_id IS NULL AND to_account_id = ? AND flow_kind = 'stock_buy'

           ORDER BY occurred_on, id`

        )

        .all(accountId) as BuyRow[];



      const usedBuyIds = new Set<number>();

      const maxBuyUsd = buys.reduce((m, b) => Math.max(m, Math.abs(b.amount_usd)), 0);



      for (const div of dividends) {

        const divUsd = Math.abs(div.amount_usd);

        if (!Number.isFinite(divUsd) || divUsd === 0) continue;

        if (div.note?.includes("migration:drip-merge|")) {

          skipped += 1;

          continue;

        }

        const hasUnits =

          div.units_delta != null && Number.isFinite(div.units_delta) && div.units_delta !== 0;

        if (hasUnits) continue;



        let fullMatch: BuyRow | undefined;

        let partialMatch: BuyRow | undefined;

        for (const buy of buys) {

          if (usedBuyIds.has(buy.id)) continue;

          const buyUsd = Math.abs(buy.amount_usd);

          const days = daysBetween(div.occurred_on, buy.occurred_on);

          if (days < 0 || days > MAX_DAYS_AFTER_DIVIDEND) continue;



          if (Math.abs(buyUsd - divUsd) <= DRIP_USD_TOLERANCE) {

            fullMatch = buy;

            break;

          }

          if (buyUsd > divUsd + DRIP_USD_TOLERANCE && !partialMatch) {

            partialMatch = buy;

          }

        }



        const match = fullMatch ?? partialMatch;

        if (!match) continue;



        const buyUsd = Math.abs(match.amount_usd);

        const buyUnits = match.units_delta;

        if (buyUnits == null || !Number.isFinite(buyUnits) || buyUnits === 0) continue;



        const isPartial = fullMatch == null;

        const units = isPartial ? buyUnits * (divUsd / buyUsd) : buyUnits;

        const mergeTag = isPartial ? "migration:partial-drip" : "migration:drip-merge";

        const mergeNote = div.note?.trim()

          ? `${div.note}|${mergeTag}|buy=${match.id}`

          : `${mergeTag}|buy=${match.id}`;



        if (existsNote.get(`%${mergeTag}|buy=${match.id}%`)) {

          skipped += 1;

          continue;

        }



        if (!dryRun) {

          updateDiv.run(units, match.ticker, mergeNote, div.id);

          if (!isPartial) deleteBuy.run(match.id);

        }

        if (isPartial) partialMerged += 1;

        else merged += 1;

        if (!isPartial) usedBuyIds.add(match.id);

      }



      for (const buy of buys) {

        if (usedBuyIds.has(buy.id)) continue;

        const buyUsd = Math.abs(buy.amount_usd);

        if (!Number.isFinite(buyUsd) || buyUsd === 0) continue;

        if (buyUsd > ORPHAN_DRIP_MAX_USD) continue;

        if (maxBuyUsd > 0 && buyUsd > maxBuyUsd * ORPHAN_DRIP_MAX_FRACTION_OF_LARGEST_BUY) continue;



        const hasNearbyDiv = dividends.some((d) => {

          const divUsd = Math.abs(d.amount_usd);

          if (!Number.isFinite(divUsd) || divUsd === 0) return false;

          const days = daysBetween(d.occurred_on, buy.occurred_on);

          return days >= 0 && days <= MAX_DAYS_AFTER_DIVIDEND;

        });

        if (hasNearbyDiv) continue;



        const units = buy.units_delta;

        if (units == null || !Number.isFinite(units) || units === 0) continue;

        const promoteNote = `migration:drip-promote|from_buy=${buy.id}`;

        if (existsNote.get(`%${promoteNote}%`)) {

          skipped += 1;

          continue;

        }



        if (!dryRun) {

          insertDiv.run(

            accountId,

            buy.occurred_on,

            promoteNote,

            units,

            buyUsd,

            buy.ticker

          );

          deleteBuy.run(buy.id);

        }

        promotedOrphan += 1;

        usedBuyIds.add(buy.id);

      }

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

        merged_full_drip_pairs: merged,

        merged_partial_drip_pairs: partialMerged,

        promoted_orphan_drip_buys: promotedOrphan,

        skipped_idempotent: skipped,

      },

      null,

      2

    )

  );

}



main();

