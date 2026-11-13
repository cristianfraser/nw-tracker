/**
 * Send the card-movement files `fetch:lider-bci` staged to the server, oldest first.
 *
 *   npm run import:lider-movements -w nw-tracker-ingest              # send + archive
 *   npm run import:lider-movements -w nw-tracker-ingest -- --dry-run # decode only
 *
 * Each file becomes one `card.unbilled_movements` payload (`cardFeed.ts`); the server applies it
 * and answers with what it did. A file moves to `imported/` only once the server has applied it;
 * the first failure stops the run and leaves that file and the later ones staged for the next.
 */
import fs from "node:fs";
import path from "node:path";
import { cardUnbilledMovementsKind, type CardUnbilledMovementsApplyDetails } from "nw-tracker-contracts";
import { resolveCfraserDir } from "../paths.js";
import { sendStaged } from "../stagedFiles.js";
import { ingestClient } from "../serverApi.js";
import { reportStepResult } from "../stepResult.js";
import { liderCardFeedPayload, type LiderCardFeedFile } from "./cardFeed.js";

const dryRun = process.argv.includes("--dry-run");
const dir = path.join(resolveCfraserDir(), "lider-card-feed");

function stagedFiles(): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => /^lider-card-movements-.*\.json$/.test(name))
    .sort()
    .map((name) => path.join(dir, name));
}

function decode(file: string): { raw: LiderCardFeedFile; payload: ReturnType<typeof liderCardFeedPayload> } {
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as LiderCardFeedFile;
  // Validated here too, so a decoding problem names the file before any request.
  return { raw, payload: cardUnbilledMovementsKind.payload.parse(liderCardFeedPayload(raw)) };
}

function describeFile(name: string, raw: LiderCardFeedFile, payload: ReturnType<typeof liderCardFeedPayload>): void {
  console.log(name);
  for (const card of payload.cards) {
    const byCurrency = card.lines.reduce<Record<string, number>>((acc, line) => {
      acc[line.currency] = (acc[line.currency] ?? 0) + 1;
      return acc;
    }, {});
    console.log(`  card ${card.account.issuer} ·${card.account.number}: ${card.lines.length} lines`, byCurrency);
  }
  if (!raw.international) console.log(`  international list: none — ${raw.international_error ?? "not read"}`);
  if (payload.issuer_balances?.status === "unavailable") console.log(`  bank cupo: none — ${payload.issuer_balances.reason}`);
}

function printDetails(details: CardUnbilledMovementsApplyDetails): number {
  let inserted = 0;
  const cupo = details.issuer_balances;
  if (cupo.status === "missing") console.log(`  bank cupo NOT captured — ${cupo.error}`);
  else if (cupo.status !== "absent") {
    console.log(`  bank cupo ${cupo.status}: ${cupo.snapshots} card/currency row(s) observed ${cupo.observed_at}`);
  }
  for (const card of details.cards) {
    inserted += card.inserted;
    console.log(
      `  account ${card.account} (id ${card.account_id}): ${card.inserted} inserted, ` +
        `${card.skipped_duplicate} duplicate, batch ${card.batch_id ?? "-"}`
    );
    const planted = card.planted_payments ?? { replaced: [], confirmed_in_place: [], ambiguous: [] };
    for (const r of planted.replaced) {
      console.log(`    planted payment line ${r.planted_line_id} replaced by the bank's ${r.bank_line_date} ${r.bank_line_merchant}`);
    }
    for (const r of planted.ambiguous) {
      console.log(
        `    AMBIGUOUS planted payment: bank ${r.bank_line_date} ${r.bank_line_merchant} fits planted line(s) ` +
          `${r.planted_line_ids.join(", ")} — nothing replaced`
      );
    }
    for (const r of card.removed_by_mirror ?? []) {
      console.log(`    no longer listed by the bank, removed: ${r.date} ${r.merchant}`);
    }
  }
  return inserted;
}

async function main(): Promise<number> {
  const files = stagedFiles();
  if (files.length === 0) {
    console.log(`No fetched movement files in ${dir}. Run: npm run fetch:lider-bci -w nw-tracker-ingest`);
    return 0;
  }
  if (dryRun) {
    console.log(`Dry run — ${files.length} file(s) in ${dir}\n`);
    for (const file of files) {
      const { raw, payload } = decode(file);
      describeFile(path.basename(file), raw, payload);
    }
    console.log("\nNothing sent. Re-run without --dry-run to import.");
    return 0;
  }
  const client = ingestClient();
  let inserted = 0;
  const { exitCode, sent } = await sendStaged(files, {
    path: (file) => file,
    async send(file) {
      const name = path.basename(file);
      const { raw, payload } = decode(file);
      describeFile(name, raw, payload);
      const result = await client.send(cardUnbilledMovementsKind, payload, {
        channel: "web_session",
        ref: name,
        label: name,
        fetched_at: raw.observed_at,
      });
      inserted += printDetails(result.details as CardUnbilledMovementsApplyDetails);
      return result;
    },
    report: () => undefined,
  });
  reportStepResult({ inserted });
  if (exitCode === 0) console.log(`\nImported ${sent} file(s); originals moved to ${dir}/imported/`);
  return exitCode;
}

process.exitCode = await main();
