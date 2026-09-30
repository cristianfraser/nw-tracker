/**
 * Send the card-movement files `fetch:santander` staged to the server, oldest first.
 *
 *   npm run import:santander-movements -w nw-tracker-ingest              # send + archive
 *   npm run import:santander-movements -w nw-tracker-ingest -- --dry-run # parse only
 *
 * Each file becomes one `card.unbilled_movements` payload (`cardFeed.ts`); the server applies it
 * and answers with what it did. A file moves to `imported/` only once the server has applied it;
 * the first failure stops the run and leaves that file and the later ones staged for the next.
 */
import fs from "node:fs";
import path from "node:path";
import {
  cardUnbilledMovementsKind,
  type CardUnbilledMovementsApplyDetails,
} from "nw-tracker-contracts";
import { log } from "../log.js";
import { resolveMovementsDir } from "../paths.js";
import { describeIngestFailure, ingestClient } from "../serverApi.js";
import { santanderCardFeedPayload, type SantanderMovementsFile } from "./cardFeed.js";

const dryRun = process.argv.includes("--dry-run");
const dir = resolveMovementsDir("santander");

function stagedFiles(): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => /^card-movements-.*\.json$/.test(name))
    .sort()
    .map((name) => path.join(dir, name));
}

// Chilean grouping for a CLI log line, not user-facing UI.
const fmt = (n: number) => Math.round(n).toLocaleString("es-CL"); // convention-ok: CLI log

function printDetails(details: CardUnbilledMovementsApplyDetails): void {
  const cupo = details.issuer_balances;
  if (cupo.status === "missing") console.log(`  bank cupo NOT captured — ${cupo.error}`);
  else if (cupo.status !== "absent") {
    console.log(`  bank cupo ${cupo.status}: ${cupo.snapshots} card/currency row(s) observed ${cupo.observed_at}`);
  }
  for (const card of details.cards) {
    console.log(
      `  account ${card.account} (id ${card.account_id}): ${card.inserted} inserted, ` +
        `${card.skipped_duplicate} duplicate, batch ${card.batch_id ?? "-"}`
    );
    for (const plan of card.plans_created) {
      console.log(
        `    cuota plan created: ${plan.purchase_date} ${plan.merchant} $${fmt(plan.principal_clp)} ` +
          `in ${plan.cuotas} (${plan.kind}), first cuota ${plan.first_due_month}`
      );
    }
    for (const n of card.first_due_nudges) {
      console.log(`    first cuota of plan ${n.purchase_id} (${n.merchant}) ${n.from ?? "unset"} → ${n.to} [${n.rule}]`);
    }
    if (card.cuota_lines_tagged > 0) {
      console.log(`    ${card.cuota_lines_tagged} cuota purchase line(s) tagged (count unknown until the statement)`);
    }
    for (const r of card.removed_by_mirror ?? []) {
      console.log(
        `    no longer listed by the bank, removed: ${r.date} ${r.merchant} ` +
          (r.amount_usd ? `US$${r.amount_usd}` : `$${fmt(r.amount_clp ?? 0)}`)
      );
    }
    const close = card.close;
    if (!close) continue;
    const usd = close.billed_usd != null ? ` + US$${close.billed_usd.toFixed(2)}` : "";
    console.log(
      `    close ${close.date} (${close.status}): SALDO INICIAL $${fmt(close.billed_clp ?? 0)}${usd}; ` +
        `rows filed under ${close.rows_billing_month}` +
        (close.lines_moved_forward > 0 ? `, ${close.lines_moved_forward} line(s) moved forward` : "")
    );
    const check = close.provisional_check;
    if (check) {
      const gap = check.bank_total_clp - check.app_estimate_clp;
      console.log(
        `    provisional ${close.billing_month}: bank $${fmt(check.bank_total_clp)} vs app estimate ` +
          `$${fmt(check.app_estimate_clp)} (${gap >= 0 ? "+" : ""}${fmt(gap)})`
      );
    }
  }
}

async function main(): Promise<number> {
  const files = stagedFiles();
  if (files.length === 0) {
    console.log(`No fetched movement files in ${dir}. Run: npm run fetch:santander`);
    return 0;
  }
  if (dryRun) console.log(`Dry run — ${files.length} file(s) in ${dir}\n`);
  const client = dryRun ? null : ingestClient();
  let sent = 0;
  for (const file of files) {
    const name = path.basename(file);
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as SantanderMovementsFile;
    // Validated here too, so a decoding problem names the file before any request.
    const payload = cardUnbilledMovementsKind.payload.parse(santanderCardFeedPayload(raw));
    console.log(name);
    if (!client) {
      for (const card of payload.cards) {
        const byCurrency = card.lines.reduce<Record<string, number>>((acc, line) => {
          acc[line.currency] = (acc[line.currency] ?? 0) + 1;
          return acc;
        }, {});
        const close = card.close ? `, close ${card.close.date}` : "";
        console.log(`  account ${card.account.number}: ${card.lines.length} lines`, byCurrency, close);
      }
      continue;
    }
    try {
      const result = await client.send(cardUnbilledMovementsKind, payload, {
        channel: "web_session",
        ref: name,
        label: name,
        ...(Number.isNaN(Date.parse(raw.fetchedAt)) ? {} : { fetched_at: raw.fetchedAt }),
      });
      printDetails(result.details as CardUnbilledMovementsApplyDetails);
    } catch (err) {
      log(`FAILED ${name}: ${describeIngestFailure(err)}`);
      return 1;
    }
    const archive = path.join(dir, "imported");
    fs.mkdirSync(archive, { recursive: true });
    fs.renameSync(file, path.join(archive, name));
    sent++;
  }
  console.log(dryRun ? "\nNothing sent. Re-run without --dry-run to import." : `\nImported ${sent} file(s); originals moved to ${dir}/imported/`);
  return 0;
}

process.exitCode = await main();
