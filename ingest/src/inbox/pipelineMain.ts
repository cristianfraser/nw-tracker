/**
 * Inbox pipeline for new files dropped under `cfraser/inbox/` (an ingest command since Phase 4;
 * it was the server script `import-cfraser-inbox.ts`). Every step is an ingest command that reads
 * documents and sends them to the server, or a server task it asks for over the API — this
 * process never opens the database.
 *
 * 0. A Fintual certificado dropped in the inbox: install + reconcile, report only
 *    (`import:fintual-cert --from-inbox`).
 * 1. qpdf repair on inbox PDFs only
 * 2. Organize inbox PDFs → credit-card / cartola folders (writes the inbox manifest)
 * 3. Organize checking cartola `.xlsx` from the inbox → `excels/cuenta corriente/`
 * 4. Parse credit-card PDFs (per-PDF cache) → merged CSV
 * 5. Send the parsed statements (`card.parsed_statements`)
 * 6. Checking cartolas (when the inbox filed one, or `--checking`), the daily «ultimos
 *    movimientos» xlsx, the card-payment receipts, then the server tasks
 *    `synthetic_cc_payments_check` and `cc_payment_mirrors`
 * 7. Cuenta vista cartolas (when the inbox filed one, or `--cuenta-vista`)
 * 8. Grocery receipts
 *
 * Usage (repo root):
 *   npm run import:cfraser-inbox
 *   npm run import:cfraser-inbox -- --dry-run
 *   npm run import:cfraser-inbox -- --checking          # full checking cartola import
 *   npm run import:cfraser-inbox -- --cuenta-vista      # full cuenta vista import
 *   npm run import:cfraser-inbox -- --full              # re-import every card statement
 *   npm run import:cfraser-inbox -- --skip-organize
 *   npm run import:cfraser-inbox -- --skip-checking-pdf
 *
 * `--skip-checking`, `--skip-cuenta-vista` disable those steps. Market data is not this
 * pipeline's: the server's own scheduler syncs what is stale (the old `--sync` flag is gone).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IngestTaskName } from "nw-tracker-contracts";
import { resolveInboxDir, resolveRepoRoot } from "../paths.js";
import { loadRootDotenv } from "../rootDotenv.js";
import { describeIngestFailure, ingestClient } from "../serverApi.js";
import {
  basenamesFromCfraserOrganizePaths,
  emptyCfraserOrganizeManifest,
  loadCfraserOrganizeManifest,
  resolveCfraserOrganizeManifestPath,
} from "./organizeManifest.js";

const REPO_ROOT = resolveRepoRoot();

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function argValue(name: string): string | undefined {
  const eq = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(eq));
  if (hit) return hit.slice(eq.length);
  const idx = process.argv.indexOf(`--${name}`);
  const next = idx >= 0 ? process.argv[idx + 1] : undefined;
  return next && !next.startsWith("--") ? next : undefined;
}

function runStep(label: string, cmd: string, args: string[], env?: NodeJS.ProcessEnv): number {
  console.log(`\n=== ${label} ===`);
  const r = spawnSync(cmd, args, {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  if (r.error) {
    console.error(r.error.message);
    return 1;
  }
  return r.status ?? 1;
}

/** A server task as a step: its report, and 1 when it fails or the server cannot be reached. */
async function runTaskStep(label: string, task: IngestTaskName, dryRun: boolean): Promise<number> {
  console.log(`\n=== ${label} ===`);
  try {
    const result = await ingestClient().runTask(task, { dry_run: dryRun });
    for (const line of result.report) (result.ok ? console.log : console.error)(line);
    return result.ok ? 0 : 1;
  } catch (err) {
    console.error(`FAILED — ${describeIngestFailure(err)}`);
    return 1;
  }
}

async function main(): Promise<void> {
  loadRootDotenv();
  const dryRun = hasFlag("dry-run");
  const skipOrganize = hasFlag("skip-organize");
  const skipParse = hasFlag("skip-parse");
  const skipQpdfRepair = hasFlag("skip-qpdf-repair");
  const skipCcImport = hasFlag("skip-cc-import");
  const skipCheckingPdf = hasFlag("skip-checking-pdf");
  const skipFintualCert = hasFlag("skip-fintual-cert");

  const forceChecking = hasFlag("checking");
  const forceCuentaVista = hasFlag("cuenta-vista");

  if (!skipFintualCert) {
    // A certificado dropped in the inbox is installed and reconciled against the cert accounts,
    // report only (ingest: `import:fintual-cert --from-inbox`; nothing to do without one). Run
    // `npm run import:fintual-cert -- --apply` to add the rows it reports missing.
    const args = ["run", "import:fintual-cert", "-w", "nw-tracker-ingest", "--", "--from-inbox"];
    if (dryRun) args.push("--dry-run");
    const code = runStep("Fintual certificado de transacciones (install + reconcile, report only)", "npm", args);
    if (code !== 0) process.exit(code);
  } else {
    console.log("\n=== Fintual certificado CSV (skipped) ===");
  }

  if (!skipParse) {
    const restoreCode = runStep("Restore false -CORRUPT credit-card PDF names", "npm", [
      "run",
      "restore:cc-corrupt-pdfs",
      "-w",
      "nw-tracker-ingest",
    ]);
    if (restoreCode !== 0) process.exit(restoreCode);
  }

  if (!skipQpdfRepair) {
    const repairCode = runStep("qpdf repair unreadable credit-card PDFs (inbox before organize)", "npm", [
      "run",
      "repair:cc-pdfs-qpdf",
      "-w",
      "nw-tracker-ingest",
      "--",
      `--dir=${resolveInboxDir()}`,
    ]);
    if (repairCode !== 0 && !dryRun) {
      process.exit(repairCode);
    }
  } else {
    console.log("\n=== qpdf repair credit-card PDFs (skipped) ===");
  }

  let organizeManifest = emptyCfraserOrganizeManifest();
  if (!skipOrganize) {
    const manifestPath = resolveCfraserOrganizeManifestPath();
    const organizeArgs = ["run", "organize:inbox", "-w", "nw-tracker-ingest", "--", `--manifest=${manifestPath}`];
    if (dryRun) organizeArgs.push("--dry-run");
    const code = runStep("Organize PDFs (cfraser/inbox → statements/)", "npm", organizeArgs);
    if (code !== 0) process.exit(code);
    organizeManifest = loadCfraserOrganizeManifest(manifestPath);
  } else {
    console.log("\n=== Organize PDFs (skipped) ===");
  }

  let xlsxMoved: { from: string; to: string }[] = [];
  if (!skipOrganize) {
    const xlsxManifest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nw-inbox-")), "checking-xlsx.json");
    const args = ["run", "organize:checking-cartola-xlsx", "-w", "nw-tracker-ingest", "--", `--manifest=${xlsxManifest}`];
    if (dryRun) args.push("--dry-run");
    const code = runStep("Organize checking cartola xlsx (inbox → excels/)", "npm", args);
    if (code !== 0) process.exit(code);
    xlsxMoved = (JSON.parse(fs.readFileSync(xlsxManifest, "utf8")) as { moved: { from: string; to: string }[] }).moved;
  }

  if (!skipParse) {
    const code = runStep("Parse credit-card PDFs", "npm", ["run", "parse:cc-pdfs", "-w", "nw-tracker-ingest"]);
    if (code !== 0) {
      console.error(
        "Parse failed or left PDFs with 0 rows (see # WARN zero_rows in output). Fix parser or PDF, then retry."
      );
      process.exit(code);
    }
  } else {
    console.log("\n=== Parse credit-card PDFs (skipped) ===");
  }

  if (!skipCcImport) {
    // Ingest sends the parsed statements (`card.parsed_statements`) and the server imports the
    // ones whose rows changed; `--full` forces the from-scratch pass that re-reconciles every
    // statement in history (slow, but the periodic sanity check). One card account only: run
    // `npm run import:cc-parsed -- --account-id=<id>` by hand.
    const importArgs = ["run", "import:cc-statements", "-w", "nw-tracker-ingest", "--"];
    if (dryRun) importArgs.push("--dry-run");
    if (hasFlag("full")) importArgs.push("--full");
    const csv = argValue("csv");
    if (csv) importArgs.push(`--csv=${csv}`);
    const code = runStep("Import parsed credit-card statements (ingest)", "npm", importArgs);
    if (code !== 0) process.exit(code);
  } else {
    console.log("\n=== Import parsed credit-card CSV (skipped) ===");
  }

  const inboxCheckingPdfs = basenamesFromCfraserOrganizePaths(organizeManifest.checking_pdfs);
  const inboxChecking =
    xlsxMoved.length > 0 || inboxCheckingPdfs.length > 0;
  const runChecking =
    !hasFlag("skip-checking") && (forceChecking || inboxChecking);

  if (runChecking) {
    const onlyXlsxBasenames = forceChecking
      ? undefined
      : xlsxMoved.map((m) => m.to);
    const onlyPdfBasenames = forceChecking ? undefined : inboxCheckingPdfs;
    const runCheckingPdf =
      !skipCheckingPdf && (forceChecking || inboxCheckingPdfs.length > 0);

    const args = ["run", "import:checking-cartolas", "-w", "nw-tracker-ingest", "--"];
    if (forceChecking) console.log("\n  (--checking: full xlsx + pdf scan)");
    if (onlyXlsxBasenames?.length) args.push(`--only-xlsx=${onlyXlsxBasenames.join(",")}`);
    if (onlyPdfBasenames?.length) args.push(`--only-pdf=${onlyPdfBasenames.join(",")}`);
    if (!runCheckingPdf) args.push("--xlsx-only");
    if (hasFlag("skip-checking-pdf-parse")) args.push("--skip-pdf-parse");
    if (dryRun) args.push("--dry-run");
    const code = runStep("Import checking cartolas (incremental)", "npm", args);
    if (code !== 0) process.exit(code);
  } else {
    console.log("\n=== Import checking cartolas (skipped; pass --checking or drop cartola in inbox) ===");
  }

  // Daily checking «últimos movimientos» xlsx from the web session (fetchCheckingMovements):
  // ingest decodes it and sends the rows to the server (`bank_account.movements`). Rows dated
  // after today are real: Santander's bank day ends at 14:00, so wires after the cutoff post on
  // the next workday — the monthly cartola carries the same posting date, so the incremental row
  // dedupes against it.
  if (!hasFlag("skip-checking")) {
    const code = runStep("Checking ultimos movimientos xlsx (ingest)", "npm", [
      "run",
      "import:checking-movements",
      "-w",
      "nw-tracker-ingest",
      ...(dryRun ? ["--", "--dry-run"] : []),
    ]);
    if (code !== 0) process.exit(code);
  }

  // Santander CC payment receipts (staged by fetch:santander-docs): ingest sends each one
  // (`card.payment_receipt`) and the server re-dates the checking debit from the bank's
  // next-workday posting date to the real payment date, or synthesizes the payment when no feed
  // has listed it yet. Runs AFTER the xlsx import so a same-run debit is re-dated the same night.
  // Then the server's alarm for synthesized payments no bank feed ever listed — on every run,
  // not only when a receipt is staged.
  if (!hasFlag("skip-checking")) {
    const receipts = runStep(`CC payments from Santander receipts (ingest)${dryRun ? " (dry run)" : ""}`, "npm", [
      "run",
      "import:santander-receipts",
      "-w",
      "nw-tracker-ingest",
      ...(dryRun ? ["--", "--dry-run"] : []),
    ]);
    if (receipts !== 0) process.exit(receipts);
    const overdue = await runTaskStep("Synthesized card payments without a bank listing", "synthetic_cc_payments_check", false);
    if (overdue !== 0) process.exit(overdue);
  }

  // Checking↔CC payment mirrors: convert unblocked pairs into pago_tarjeta
  // transfers dated at the card's credit date. Runs after the receipts step so a re-dated
  // debit converts as a same-day pair in the same night.
  if (!hasFlag("skip-checking")) {
    const code = await runTaskStep(`Convert CC payment mirrors${dryRun ? " (dry run)" : ""}`, "cc_payment_mirrors", dryRun);
    if (code !== 0) process.exit(code);
  }

  const inboxVistaPdfs = basenamesFromCfraserOrganizePaths(organizeManifest.cuenta_vista_pdfs);
  const runCuentaVista =
    !hasFlag("skip-cuenta-vista") &&
    (forceCuentaVista || inboxVistaPdfs.length > 0);

  if (runCuentaVista) {
    const args = ["run", "import:cuenta-vista-cartolas", "-w", "nw-tracker-ingest", "--"];
    if (forceCuentaVista) console.log("\n  (--cuenta-vista: full pdf scan)");
    else args.push(`--only-pdf=${inboxVistaPdfs.join(",")}`);
    if (hasFlag("skip-cuenta-vista-pdf-parse")) args.push("--skip-pdf-parse");
    if (dryRun) args.push("--dry-run");
    const code = runStep("Import cuenta vista cartolas (pdf)", "npm", args);
    if (code !== 0) process.exit(code);
  } else {
    console.log(
      "\n=== Import cuenta vista cartolas (skipped; pass --cuenta-vista or drop CM cartola in inbox) ==="
    );
  }

  let deferredFailureCode = 0;
  // Grocery receipts (ingest: photo inbox → staged → OCR/parse → `store.receipt`): the Lider
  // «Boleta Digital» PDFs staged by fetch:lider-boletas plus the generic cfraser/grocery-receipts/
  // root. Incremental: the command stops at once when no photo waits in the inbox and every
  // staged receipt carries a current import stamp, so it runs on every pass.
  {
    const receiptArgs = ["run", "import:grocery-receipts", "-w", "nw-tracker-ingest"];
    if (dryRun) receiptArgs.push("--", "--dry-run");
    const code = runStep(`Import grocery receipts${dryRun ? " (dry run)" : ""}`, "npm", receiptArgs);
    // A receipt that will not parse fails the step so the nightly names it, but it is not a
    // reason to hold back the steps below — the pipeline still exits non-zero at the end. (A
    // new store is not a failure: the receipt is flagged and pairs with the card's own line.)
    if (code !== 0) deferredFailureCode = code;
  }

  console.log("\n=== import:cfraser-inbox done ===");
  if (deferredFailureCode !== 0) process.exit(deferredFailureCode);
}

await main();
