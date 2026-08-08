/**
 * Report/apply traspaso-de-deuda USD↔CLP leg links (`cc_traspaso_deuda_links`) for every CC
 * master account with traspaso legs on PDF statements. Report by default; `--apply` rebuilds
 * the links. Imports maintain links from here on — this script is the one-time backfill and
 * the manual re-check.
 *
 *   npx tsx server/scripts/relink-cc-traspaso-deuda.ts [--apply]
 */
import { db } from "../src/db.js";
import {
  computeCcTraspasoDeudaPairsForAccount,
  relinkCcTraspasoDeudaLinksForAccount,
} from "../src/ccTraspasoDeudaLinks.js";

const apply = process.argv.includes("--apply");

const accountRows = db
  .prepare(
    `SELECT DISTINCT s.account_id AS id
     FROM cc_statement_lines l
     JOIN cc_statements s ON s.id = l.statement_id
     WHERE l.installment_flag = 0
       AND UPPER(l.merchant) LIKE '%TRASPASO%DEUDA%'
       AND s.source_pdf NOT LIKE 'import:web-paste%'
     ORDER BY s.account_id`
  )
  .all() as { id: number }[];

if (accountRows.length === 0) {
  console.log("No traspaso de deuda legs on any account.");
  process.exit(0);
}

let totalPairs = 0;
for (const { id } of accountRows) {
  const existing = (
    db.prepare(`SELECT COUNT(*) AS n FROM cc_traspaso_deuda_links WHERE account_id = ?`).get(id) as {
      n: number;
    }
  ).n;
  const pairs = computeCcTraspasoDeudaPairsForAccount(id);
  totalPairs += pairs.length;
  console.log(`\naccount ${id}: ${pairs.length} pair(s) (${existing} link row(s) stored)`);
  for (const p of pairs) {
    const rate = p.amount_clp / p.amount_usd;
    console.log(
      `  ${p.statement_date}  +${p.amount_clp} CLP ↔ −${p.amount_usd.toFixed(2)} USD` +
        `  (implied ${rate.toFixed(2)} CLP/USD; lines ${p.clp_line_id}/${p.usd_line_id})`
    );
  }
  if (apply) {
    const { links } = relinkCcTraspasoDeudaLinksForAccount(id);
    console.log(`  → relinked: ${links} link(s) written`);
  }
}

console.log(
  `\n${apply ? "Applied" : "Report only — nothing was written"}: ${totalPairs} pair(s) across ${accountRows.length} account(s).` +
    (apply ? "" : " Run with --apply to write links.")
);
