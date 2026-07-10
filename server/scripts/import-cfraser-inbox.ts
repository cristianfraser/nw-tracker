/**
 * Inbox pipeline for new files dropped under `cfraser/inbox/`:
 *
 * 1. qpdf repair on inbox PDFs only
 * 2. Organize inbox PDFs → credit-card / cartola folders (writes inbox manifest)
 * 3. Organize checking cartola `.xlsx` from inbox → `excels/cuenta corriente/`
 * 4. Parse credit-card PDFs (per-PDF cache) → merged CSV
 * 5. Merge-import CC rows into SQLite
 * 6. Optionally import checking / cuenta vista / sync / excel (see flags below)
 *
 * Default (credit-card inbox only): steps 1–5; skips checking, cuenta vista, sync, excel.
 * Checking / cuenta vista run only when inbox filed PDFs or xlsx this run, unless forced.
 *
 * Usage (repo root):
 *   npm run import:cfraser-inbox
 *   npm run import:cfraser-inbox -- --dry-run
 *   npm run import:cfraser-inbox -- --checking          # full checking cartola import
 *   npm run import:cfraser-inbox -- --cuenta-vista      # full cuenta vista import
 *   npm run import:cfraser-inbox -- --sync              # run global sync after import
 *   npm run import:cfraser-inbox -- --excel             # reload cfraser.xlsx + companion CSVs
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
import { importCuentaVistaCartolasFromPdfs } from "../src/cuentaVistaCartolaImport.js";
import { processFintualCertificadoInboxCsv } from "../src/fintualCertificadoInbox.js";
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
  const skipExcel = hasFlag("skip-excel");
  const runExcel = hasFlag("excel");
  const accountId = argValue("account-id");
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
    const importArgs = ["run", "import:cc-parsed", "-w", "nw-tracker-server", "--"];
    if (dryRun) importArgs.push("--dry-run");
    const csv = argValue("csv");
    if (csv) importArgs.push(`--csv=${csv}`);
    if (accountId) importArgs.push(`--account-id=${accountId}`);
    const code = runStep("Import parsed credit-card CSV", "npm", importArgs);
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
    const code = runStep(
      "Import Fintual certificado → cert account movements",
      "npm",
      ["run", "import:fintual-cert", "-w", "nw-tracker-server"]
    );
    if (code !== 0) process.exit(code);
  }

  if (runExcel && !skipExcel) {
    const code = runStep(
      "Import net-worth excel + companion CSVs (full wipe of import:excel scope)",
      "npm",
      ["run", "import:excel", "-w", "nw-tracker-server"]
    );
    if (code !== 0) process.exit(code);
  } else if (!skipExcel && !runExcel) {
    console.log(
      "\n=== import:excel (skipped; pass --excel to reload cfraser.xlsx + companion CSVs) ==="
    );
  }

  console.log("\n=== import:cfraser-inbox done ===");
}

main();
