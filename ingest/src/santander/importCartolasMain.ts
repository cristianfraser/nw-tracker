/**
 * Send Santander's monthly cartolas to the server as one `bank_account.statements` per account.
 * The server imports the periods it does not hold yet.
 *
 *   npm run import:checking-cartolas -w nw-tracker-ingest [-- flags]
 *   npm run import:cuenta-vista-cartolas -w nw-tracker-ingest [-- flags]
 *
 * Flags: --dry-run (report only), --force-reimport (re-import periods already imported),
 * --skip-pdf-parse (read the parsers' last JSON), --only-pdf=a.pdf,b.pdf; cuenta corriente also
 * --xlsx-only, --only-xlsx=a.xlsx,b.xlsx, --dir=<xlsx dir>. To start an account's cartola ledger
 * over, wipe it on the server first (`npm run wipe:cartola-ledger -w nw-tracker-server`).
 *
 * `--only-xlsx=` / `--only-pdf=` with an empty list send none of that format; without the flag a
 * full scan sends every document on disk (the explicit cross-check of history).
 *
 * `--write-payload=<file>`: the readers run and the validated `bank_account.statements` payload is
 * written to that file as JSON — nothing is sent and the pending list is left as it is (the input
 * of `server/scripts/rebuild-checking-ledger-from-cartolas.ts --payload=`). Exits non-zero when a
 * document could not be read (it is in the payload's `unreadable`, which the rebuild ignores).
 *
 * Exit status: non-zero when a cartola could not be read or imported, or the server refused one
 * (the ledger does not agree with it, or it states a month on file differently): each reason is a
 * step problem, listed in the run's notification. Such a cartola stays pending
 * (`cartolaPending.ts`) and the inbox pipeline sends it again on every run until it imports.
 */
import fs from "node:fs";
import path from "node:path";
import { bankAccountStatementsKind, type BankAccountStatementsApplyDetails } from "nw-tracker-contracts";
import { describeIngestFailure, ingestClient } from "../serverApi.js";
import { listCartolaPdfs, readCheckingCartolas, readCuentaVistaCartolas, statementsTheContractTakes } from "./cartolas.js";
import { reportStepResult } from "../stepResult.js";
import {
  isDocumentName,
  nextPendingCartolas,
  pendingAfterFailedSend,
  readPendingCartolas,
  writePendingCartolas,
  type ReaderFailure,
} from "./cartolaPending.js";

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const list = (name: string) =>
  argv
    .find((a) => a.startsWith(`--${name}=`))
    ?.slice(name.length + 3)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
const account = argv.find((a) => a.startsWith("--account="))?.slice("--account=".length);

async function main(): Promise<number> {
  if (account !== "checking" && account !== "cuenta-vista") {
    console.error("Usage: --account=checking|cuenta-vista");
    return 2;
  }
  const dryRun = flag("dry-run");
  const writePayload = argv.find((a) => a.startsWith("--write-payload="))?.slice("--write-payload=".length);
  if (writePayload === "") {
    console.error("--write-payload= names a file");
    return 2;
  }
  const onlyXlsx = list("only-xlsx");
  const onlyPdf = list("only-pdf");
  const raw =
    account === "checking"
      ? readCheckingCartolas({
          dir: argv.find((a) => a.startsWith("--dir="))?.slice("--dir=".length),
          pdf: !flag("xlsx-only"),
          skipPdfParse: flag("skip-pdf-parse"),
          onlyXlsx,
          onlyPdf,
        })
      : readCuentaVistaCartolas({ skipPdfParse: flag("skip-pdf-parse"), onlyPdf });
  // A statement the contract refuses (a cell outside the shared reading) is that document's
  // problem, never the run's: it goes as unreadable (named, pending) and the others are sent.
  const read = statementsTheContractTakes(raw);
  const payload = bankAccountStatementsKind.payload.parse({
    account: { issuer: "santander", product: account === "checking" ? "checking" : "demand_deposit" },
    force_reimport: flag("force-reimport"),
    statements: read.statements,
    unreadable: read.unreadable,
  });
  if (writePayload != null) {
    const out = path.resolve(writePayload);
    fs.writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`);
    console.log(`wrote ${payload.statements.length} statement(s) to ${out}; nothing sent`);
    for (const u of payload.unreadable) console.error(`  UNREADABLE ${u.document}: ${u.error}`);
    return payload.unreadable.length > 0 ? 1 : 0;
  }
  // The documents this run asked for: a format without its `--only-…` list is read in full (the
  // PDFs not at all with `--xlsx-only`).
  const pdfRead = account === "cuenta-vista" || !flag("xlsx-only");
  const asked = (doc: string): boolean =>
    /\.xlsx$/i.test(doc) ? (account === "checking" && (onlyXlsx == null || onlyXlsx.includes(doc))) : pdfRead && (onlyPdf == null || onlyPdf.includes(doc));
  const previous = readPendingCartolas(account);
  const now = new Date().toISOString();
  // A PDF reader that failed as a whole comes back as one unreadable entry under a bare tag: the
  // PDFs it was asked for (the `--only-pdf` list; a full scan: every PDF in the account's folder)
  // were read by nobody, and stay pending with its error.
  const wholeFailure = read.unreadable.find((u) => !isDocumentName(u.document));
  const readerFailure: ReaderFailure | null = wholeFailure ? { documents: onlyPdf ?? listCartolaPdfs(account), error: wholeFailure.error } : null;
  let details: BankAccountStatementsApplyDetails;
  try {
    const result = await ingestClient().send(bankAccountStatementsKind, payload, { channel: "file", ref: `${account}-cartolas` }, { dryRun });
    details = result.details as BankAccountStatementsApplyDetails;
  } catch (err) {
    console.error(`FAILED — ${describeIngestFailure(err)}`);
    // Nothing was applied: every document of this run waits for the next one, an unreadable one
    // with its own reason (and named as a step problem: the server never saw it).
    const why = describeIngestFailure(err);
    const unreadable = payload.unreadable.filter((u) => isDocumentName(u.document));
    if (!dryRun) {
      writePendingCartolas(
        account,
        pendingAfterFailedSend(
          previous,
          [
            ...payload.statements.map((s) => ({ document: s.document, status: "not_sent", problem: why })),
            ...unreadable.map((u) => ({ document: u.document, status: "parse_error", problem: u.error })),
            ...(readerFailure?.documents ?? []).map((d) => ({ document: d, status: "parse_error", problem: readerFailure!.error })),
          ],
          now
        )
      );
    }
    reportStepResult({
      problems: [
        `${account} cartolas not sent: ${why}`,
        ...unreadable.map((u) => `${u.document}: ${u.error}`),
        ...(wholeFailure ? [`${wholeFailure.document}: ${wholeFailure.error}`] : []),
      ],
    });
    return 1;
  }
  const problems: string[] = [];
  for (const f of details.files) {
    if (f.status === "skipped_already_imported") continue;
    if (f.status === "refused") {
      // Nothing of it was written; every reason reaches the run's notification.
      console.error(`  ${f.file} ${f.period_month} REFUSED, nothing written:`);
      for (const p of f.problems) {
        console.error(`    ${p}`);
        problems.push(`${f.file}: ${p}`);
      }
      continue;
    }
    if (f.status === "parse_error") problems.push(`${f.file}${f.period_month ? ` ${f.period_month}` : ""}: ${f.error ?? "could not be read"}`);
    console.log(`  ${f.file} ${f.period_month} ${f.status}${f.movements_imported ? ` (${f.movements_imported} movement(s))` : ""}${f.error ? ` — ${f.error}` : ""}`);
  }
  for (const line of details.report) console.log(line);
  if (!dryRun) {
    const next = nextPendingCartolas(previous, asked, details.files, now, readerFailure);
    writePendingCartolas(account, next.pending);
    for (const doc of next.resolved) console.log(`  pending cartola ${doc}: imported, no longer pending`);
    const notices = next.dropped.map((doc) => `pending cartola ${doc} was not found on disk: no longer pending`);
    for (const n of notices) console.log(`  ${n}`);
    for (const p of next.pending) console.error(`  PENDING since ${p.since.slice(0, 10)}: ${p.document} (${p.status}) — sent again on every pipeline run`);
    if (notices.length > 0) reportStepResult({ notices });
  }
  if (problems.length > 0) reportStepResult({ problems });
  return problems.length > 0 ? 1 : 0;
}

process.exitCode = await main();
