/**
 * Inbox pipeline for new files dropped under `cfraser/inbox/`:
 *
 * 1. qpdf repair on inbox PDFs only
 * 2. Organize inbox PDFs → credit-card / cartola folders (writes inbox manifest)
 * 3. Organize checking cartola `.xlsx` from inbox → `excels/cuenta corriente/`
 * 4. Parse credit-card PDFs (per-PDF cache) → merged CSV
 * 5. Merge-import CC rows into SQLite
 * 6. Optionally import checking / cuenta vista / sync (see flags below)
 *
 * A Fintual certificado dropped in the inbox is installed (step 0) and imported into its
 * cert accounts via `import:fintual-cert` at the end of the run. A Lider BCI «últimos
 * movimientos» CSV (`lider-bci-movimientos-*.csv`, dropped by its own scheduled fetch) is
 * imported through the web-paste path at the end of the run and archived. The daily checking
 * «ultimos movimientos-Cuenta Corriente.xlsx» (dropped by fetch:santander) is sent to the server
 * by ingest (`import:checking-movements`, `bank_account.movements`) and archived under
 * `cfraser/checking-ultimos-movimientos/imported/`.
 *
 * Default (credit-card inbox only): steps 1–5; skips checking, cuenta vista, sync.
 * Checking / cuenta vista run only when inbox filed PDFs or xlsx this run, unless forced.
 *
 * Usage (repo root):
 *   npm run import:cfraser-inbox
 *   npm run import:cfraser-inbox -- --dry-run
 *   npm run import:cfraser-inbox -- --checking          # full checking cartola import
 *   npm run import:cfraser-inbox -- --cuenta-vista      # full cuenta vista import
 *   npm run import:cfraser-inbox -- --sync              # run global sync after import
 *   npm run import:cfraser-inbox -- --skip-organize
 *   npm run import:cfraser-inbox -- --skip-checking-pdf
 *
 * Legacy `--skip-checking`, `--skip-cuenta-vista`, `--skip-sync` still disable those steps.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { importCheckingCartolasFromDir } from "../src/checkingCartolaImport.js";
import { organizeCheckingCartolaXlsxFromInbox } from "../src/checkingCartolaInbox.js";
import {
  basenamesFromCfraserOrganizePaths,
  emptyCfraserOrganizeManifest,
  loadCfraserOrganizeManifest,
  resolveCfraserOrganizeManifestPath,
} from "../src/cfraserOrganizeManifest.js";
import { resolveCfraserInboxDir } from "../src/cfraserPaths.js";
import { hasPendingGroceryReceipts } from "../src/groceryReceiptsImport.js";
import { listGroceryReceiptInboxFiles } from "../src/groceryReceiptsIngest.js";
import { importCuentaVistaCartolasFromPdfs } from "../src/cuentaVistaCartolaImport.js";
import { processFintualCertificadoInboxCsv } from "../src/fintualCertificadoInbox.js";
import { listLiderMovementInboxFiles } from "../src/liderMovementsImport.js";
import { loadRootDotenv } from "../src/rootDotenv.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SERVER_ROOT = path.resolve(__dirname, "..");

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function argValue(name: string): string | undefined {
  const eq = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(eq));
  if (hit) return hit.slice(eq.length);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith("--")) {
    return process.argv[idx + 1];
  }
  return undefined;
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

function main(): void {
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
  const forceSync = hasFlag("sync");

  let fintualCertInstalled = false;
  if (!skipFintualCert) {
    console.log("\n=== Fintual certificado de transacciones (CSV install) ===");
    try {
      const r = processFintualCertificadoInboxCsv({ dryRun });
      if (r.inboxPath) {
        console.log(
          `  ${r.rows} row(s) → ${r.csvPath}${r.archivedTo ? `; archived ${r.archivedTo}` : ""}`
        );
        fintualCertInstalled = true;
      } else {
        console.log("  (no certificado CSV in cfraser/inbox/)");
      }
    } catch (e) {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    }
  } else {
    console.log("\n=== Fintual certificado CSV (skipped) ===");
  }

  if (!skipParse) {
    const restoreCode = runStep(
      "Restore false -CORRUPT credit-card PDF names",
      "python3",
      [path.join(SERVER_ROOT, "scripts", "restore-cc-corrupt-pdfs.py")]
    );
    if (restoreCode !== 0) process.exit(restoreCode);
  }

  if (!skipQpdfRepair) {
    const inboxDir = resolveCfraserInboxDir();
    const pdfDeps = path.join(SERVER_ROOT, "scripts", ".pdf_deps");
    const repairArgs = [
      path.join(SERVER_ROOT, "scripts", "repair-cc-statement-pdfs-qpdf.py"),
      `--dir=${inboxDir}`,
    ];
    const repairCode = runStep(
      "qpdf repair unreadable credit-card PDFs (inbox before organize)",
      "python3",
      repairArgs,
      { PYTHONPATH: pdfDeps }
    );
    if (repairCode !== 0 && !dryRun) {
      process.exit(repairCode);
    }
  } else {
    console.log("\n=== qpdf repair credit-card PDFs (skipped) ===");
  }

  let organizeManifest = emptyCfraserOrganizeManifest();
  if (!skipOrganize) {
    const manifestPath = resolveCfraserOrganizeManifestPath();
    const organizeArgs = [
      path.join(SERVER_ROOT, "scripts", "organize-cfraser-statement-pdfs.py"),
      `--manifest=${manifestPath}`,
    ];
    if (dryRun) organizeArgs.push("--dry-run");
    const code = runStep("Organize PDFs (cfraser/inbox → statements/)", "python3", organizeArgs, {
      PYTHONPATH: path.join(SERVER_ROOT, "scripts", ".pdf_deps"),
    });
    if (code !== 0) process.exit(code);
    organizeManifest = loadCfraserOrganizeManifest(manifestPath);
  } else {
    console.log("\n=== Organize PDFs (skipped) ===");
  }

  let xlsxMoved: { from: string; to: string }[] = [];
  if (!skipOrganize) {
    console.log("\n=== Organize checking cartola xlsx (inbox → excels/) ===");
    const xlsxOrg = organizeCheckingCartolaXlsxFromInbox({ dryRun });
    xlsxMoved = xlsxOrg.moved;
    for (const m of xlsxOrg.moved) {
      console.log(`  ${m.from} -> excels/cuenta corriente/${m.to}`);
    }
    for (const s of xlsxOrg.skipped) {
      console.log(`  skip ${s.file}: ${s.reason}`);
    }
    if (xlsxOrg.errors.length) {
      console.error(xlsxOrg.errors.map((e) => `${e.file}: ${e.error}`).join("\n"));
      process.exit(1);
    }
  }

  if (!skipParse) {
    const code = runStep("Parse credit-card PDFs", "npm", ["run", "parse:cc-pdfs"], {
      PYTHONPATH: path.join(SERVER_ROOT, "scripts", ".pdf_deps"),
    });
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

    console.log("\n=== Import checking cartolas (incremental) ===");
    if (forceChecking) {
      console.log("  (--checking: full xlsx + pdf scan)");
    } else {
      if (onlyXlsxBasenames?.length) {
        console.log(`  xlsx from inbox: ${onlyXlsxBasenames.join(", ")}`);
      }
      if (onlyPdfBasenames?.length) {
        console.log(`  pdf from inbox: ${onlyPdfBasenames.join(", ")}`);
      }
    }
    const result = importCheckingCartolasFromDir({
      dryRun,
      pdf: runCheckingPdf,
      skipPdfParse: hasFlag("skip-checking-pdf-parse"),
      onlyXlsxBasenames,
      onlyPdfBasenames,
    });
    const imported = result.filesImported.length;
    const skipped = result.filesSkipped.length;
    const errs = result.errors.length;
    console.log(
      `  checking: ${imported} file(s) imported, ${skipped} month(s) already in DB, ${errs} error(s)`
    );
    if (result.errors.length) {
      console.error(result.errors.map((e) => `${e.file}: ${e.error}`).join("\n"));
      process.exit(1);
    }
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
    const overdue = runStep("Synthesized card payments without a bank listing", "npm", [
      "run",
      "check:synthetic-cc-payments",
      "-w",
      "nw-tracker-server",
    ]);
    if (overdue !== 0) process.exit(overdue);
  }

  // Checking↔CC payment mirrors: convert unblocked pairs into pago_tarjeta
  // transfers dated at the card's credit date. Runs after the receipts step so a re-dated
  // debit converts as a same-day pair in the same night.
  if (!hasFlag("skip-checking") && !dryRun) {
    const code = runStep("Convert CC payment mirrors", "npm", [
      "run",
      "convert:cc-payment-mirrors",
      "-w",
      "nw-tracker-server",
    ]);
    if (code !== 0) process.exit(code);
  } else if (dryRun) {
    const code = runStep("Convert CC payment mirrors (dry run)", "npm", [
      "run",
      "convert:cc-payment-mirrors",
      "-w",
      "nw-tracker-server",
      "--",
      "--dry-run",
    ]);
    if (code !== 0) process.exit(code);
  }

  const inboxVistaPdfs = basenamesFromCfraserOrganizePaths(organizeManifest.cuenta_vista_pdfs);
  const runCuentaVista =
    !hasFlag("skip-cuenta-vista") &&
    (forceCuentaVista || inboxVistaPdfs.length > 0);

  if (runCuentaVista) {
    console.log("\n=== Import cuenta vista cartolas (pdf) ===");
    if (forceCuentaVista) {
      console.log("  (--cuenta-vista: full pdf scan)");
    } else {
      console.log(`  pdf from inbox: ${inboxVistaPdfs.join(", ")}`);
    }
    const vistaResult = importCuentaVistaCartolasFromPdfs({
      dryRun,
      skipPdfParse: hasFlag("skip-cuenta-vista-pdf-parse"),
      onlyPdfBasenames: forceCuentaVista ? undefined : inboxVistaPdfs,
    });
    const imported = vistaResult.filesImported.length;
    const skipped = vistaResult.filesSkipped.length;
    const errs = vistaResult.errors.length;
    console.log(
      `  cuenta vista: ${imported} file(s) imported, ${skipped} month(s) already in DB, ${errs} error(s)`
    );
    if (vistaResult.errors.length) {
      console.error(
        vistaResult.errors.map((e) => `${e.file}: ${e.error}`).join("\n")
      );
      process.exit(1);
    }
  } else {
    console.log(
      "\n=== Import cuenta vista cartolas (skipped; pass --cuenta-vista or drop CM cartola in inbox) ==="
    );
  }

  if (!dryRun && forceSync && !hasFlag("skip-sync")) {
    console.log(
      "\n(Global sync below only refreshes Fintual/SBIF/equity — not bank PDFs. 'Stale: none' / 'No changes' is normal.)"
    );
    const code = runStep("Global sync (reconciliation)", "npm", [
      "run",
      "sync:all",
      "-w",
      "nw-tracker-server",
    ]);
    if (code !== 0) process.exit(code);
  } else if (hasFlag("skip-sync") || !forceSync) {
    console.log("\n=== Global sync (skipped; pass --sync to run sync:all) ===");
  }

  if (fintualCertInstalled && !dryRun) {
    // Report-only: surface certificado rows missing from the DB without changing curated data.
    // Run `npm run import:fintual-cert -- --apply` to add them.
    const code = runStep(
      "Reconcile Fintual certificado vs cert accounts (report only)",
      "npm",
      ["run", "import:fintual-cert", "-w", "nw-tracker-server"]
    );
    if (code !== 0) process.exit(code);
  }

  let deferredFailureCode = 0;
  // Grocery receipts: the Lider «Boleta Digital» PDFs staged by fetch:lider-boletas plus the
  // generic cfraser/grocery-receipts/ root (photo inbox → staged) — grocery receipt+items
  // always, an open-month card line when paid with the chain's own card. Incremental: the gate
  // is "a photo in the inbox, or a staged dir whose parse has no current import stamp", so the
  // hourly poll runs it unconditionally and a quiet corpus costs nothing.
  if (listGroceryReceiptInboxFiles().length > 0 || hasPendingGroceryReceipts()) {
    const receiptArgs = ["run", "import:grocery-receipts", "-w", "nw-tracker-server"];
    if (dryRun) receiptArgs.push("--", "--dry-run");
    const code = runStep(`Import grocery receipts${dryRun ? " (dry run)" : ""}`, "npm", receiptArgs);
    // A receipt that will not parse fails the step so the nightly names it, but it is not a
    // reason to hold back the steps below — the pipeline still exits non-zero at the end. (A
    // new store is not a failure: the receipt is flagged and pairs with the card's own line.)
    if (code !== 0) deferredFailureCode = code;
  } else {
    console.log("\n=== Grocery receipts (nothing pending) ===");
  }

  // Lider BCI «últimos movimientos» CSV, dropped in the inbox by its own scheduled fetch.
  // Same shape as a manual web paste, so it goes through the web-paste import path; the file is
  // archived to cfraser/lider-movements/imported/ once read.
  if (listLiderMovementInboxFiles().length > 0) {
    const code = runStep(
      `Import Lider movements CSV${dryRun ? " (dry run)" : ""}`,
      "npm",
      [
        "run",
        "import:lider-movements",
        "-w",
        "nw-tracker-server",
        ...(dryRun ? ["--", "--dry-run"] : []),
      ]
    );
    if (code !== 0) process.exit(code);
  } else {
    console.log("\n=== Lider movements CSV (none in inbox) ===");
  }

  console.log("\n=== import:cfraser-inbox done ===");
  if (deferredFailureCode !== 0) process.exit(deferredFailureCode);
}

main();
