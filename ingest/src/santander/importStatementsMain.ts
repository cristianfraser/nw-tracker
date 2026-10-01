/**
 * Send the Santander facturación JSON `fetch:santander` staged to the server, one `card.statement`
 * per facturación. Report by default; `--apply` writes.
 *
 *   npm run import:santander-statements -w nw-tracker-ingest
 *   npm run import:santander-statements -w nw-tracker-ingest -- --dir=<capture dir>
 *   npm run import:santander-statements -w nw-tracker-ingest -- --apply
 *
 * A facturación's two currencies pair on (account, NumExtracto) — both endpoints are asked for the
 * same statement number — and the international one, which carries no dates of its own, is dated
 * from its national twin; an international with no twin is reported, never sent
 * (`assembleSantanderStatementBatch`). Facturaciones go oldest first per account, each answered
 * before the next is sent: a later close's period start is the previous close in the ledger, which
 * may be the one just written.
 *
 * The server decides what each side is (a cross-check of a PDF-owned close, a write candidate, a
 * stale echo) and answers with its report. The staging dir only grows — the scraper writes one file
 * per (account, extracto, endpoint) and never deletes — so with `--apply` a superseded facturación
 * (any but its account's newest extracto, which the scraper keeps re-fetching) moves to
 * `<dir>/archive/` once every statement of it is verified; anything else stays and is sent again.
 */
import fs from "node:fs";
import path from "node:path";
import { cardStatementKind, type CardStatementApplyDetails } from "nw-tracker-contracts";
import { resolveStatementJsonDir } from "../paths.js";
import { describeIngestFailure, ingestClient } from "../serverApi.js";
import {
  assembleSantanderStatementBatch,
  listSantanderStatementFiles,
  parseSantanderStatementFile,
  selectSantanderStatementGroupsToArchive,
  statementGroupPayload,
  type ParsedSantanderStatement,
  type SantanderStatementGroupOutcomes,
} from "./statementJson.js";

const apply = process.argv.includes("--apply");
const dirArg = process.argv.find((a) => a.startsWith("--dir="))?.split("=")[1];
const dir = dirArg ? path.resolve(dirArg) : resolveStatementJsonDir("santander");

async function main(): Promise<number> {
  const files = dirArg
    ? fs
        .readdirSync(dir)
        .filter((n) => /estadoCuenta(Nacional|Internacional)/i.test(n) && n.endsWith(".json"))
        .sort()
        .map((n) => path.join(dir, n))
    : listSantanderStatementFiles(dir);
  if (files.length === 0) {
    console.log(`No statement JSON in ${dir}.`);
    console.log("Run `npm run fetch:santander` (statements are saved on every run), or pass --dir=<capture dir>.");
    return 0;
  }

  const statements: ParsedSantanderStatement[] = [];
  for (const file of files) {
    const parsed = parseSantanderStatementFile(file);
    if (parsed) statements.push(parsed);
    else console.log(`\n${path.basename(file)}\n  not a statement response (no OUTPUT) — skipped`);
  }
  const { groups, duplicates } = assembleSantanderStatementBatch(statements);
  for (const { file, copy_of } of duplicates) {
    console.log(`\n${file}\n  identical copy of ${copy_of} (a retried fetch) — skipped`);
  }

  const client = ingestClient();
  const outcomes = new Map<string, SantanderStatementGroupOutcomes>();
  const tally = { clean: 0, dirty: 0, pdfOwned: 0, written: 0, unpaired: 0 };
  for (const group of groups) {
    const payload = statementGroupPayload(group, apply);
    if (!payload) {
      tally.unpaired += 1;
      console.log(`\n${group.international!.file}  [usd]  (no statement date)`);
      console.log(
        `  unpaired: no national statement of extracto ${group.extracto} for account ${group.account} — ` +
          `the international feed carries no close of its own, so it is neither dated nor imported`
      );
      continue;
    }
    let details: CardStatementApplyDetails;
    try {
      const result = await client.send(cardStatementKind, payload, {
        channel: "web_session",
        ref: `${group.account}-extracto-${group.extracto}`,
      });
      details = result.details as CardStatementApplyDetails;
    } catch (err) {
      console.log(`\naccount ${group.account} extracto ${group.extracto}: FAILED — ${describeIngestFailure(err)}`);
      return 1;
    }
    for (const s of details.statements) {
      if (s.report.length > 0) console.log(`\n${s.report.join("\n")}`);
      if (s.outcome === "clean") tally.clean += 1;
      if (s.outcome === "dirty") tally.dirty += 1;
      if (s.owner === "pdf") tally.pdfOwned += 1;
    }
    if (details.written) {
      tally.written += details.written.currencies.length;
      console.log(
        `\nWROTE account ${details.account_id} ${payload.close}: ${details.written.currencies.join("+")} ` +
          `(${details.written.lines_inserted} lines inserted)`
      );
    }
    outcomes.set(group.key, Object.fromEntries(details.statements.map((s) => [s.currency, s.outcome])));
  }

  const { archive, keep } = selectSantanderStatementGroupsToArchive(groups, outcomes);
  if (archive.length > 0 || keep.length > 0) console.log("");
  for (const group of keep) {
    console.log(
      `KEPT account ${group.account} extracto ${group.extracto} (${group.close ?? "no close"}): ` +
        `superseded, but not every statement is verified — stays in place`
    );
  }
  if (apply && archive.length > 0) {
    const archiveDir = path.join(dir, "archive");
    const moves = archive.flatMap((group) => group.files.map((file) => ({ from: path.join(dir, file), to: path.join(archiveDir, file) })));
    // Never overwrite an archived statement, and check every destination before the first move.
    const taken = moves.filter((move) => fs.existsSync(move.to));
    if (taken.length > 0) {
      throw new Error(
        `Cannot archive: ${taken.map((move) => path.relative(dir, move.to)).join(", ")} already exist(s) — a ` +
          `statement archived earlier was staged again. Compare the copies and remove one by hand.`
      );
    }
    fs.mkdirSync(archiveDir, { recursive: true });
    for (const move of moves) fs.renameSync(move.from, move.to);
  }
  for (const group of archive) {
    console.log(
      `${apply ? "ARCHIVED" : "would archive (--apply)"} account ${group.account} extracto ${group.extracto} ` +
        `(${group.close}): ${group.files.join(", ")}${apply ? " → archive/" : ""}`
    );
  }

  const writeSummary = apply ? `${tally.written} statement(s) written` : "nothing written (pass --apply to write the candidates above)";
  const archiveSummary = apply ? `${archive.length} superseded facturación(es) archived` : `${archive.length} superseded facturación(es) to archive with --apply`;
  console.log(
    `\n${tally.clean} PDF-owned statement(s) reconcile, ${tally.dirty} problem(s), ${tally.pdfOwned} PDF-owned skip(s), ` +
      `${tally.unpaired} unpaired international file(s) · ${writeSummary} · ${archiveSummary}`
  );
  return 0;
}

process.exitCode = await main();
