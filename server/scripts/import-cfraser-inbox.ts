/**
 * One-shot pipeline for new files dropped under `cfraser/`:
 *
 * 1. Organize PDFs from `cfraser/pdfs/`:
 *    - CUENTAMATICA → `cfraser/cartolas-cuenta-vista/`
 *    - credit-card → `cfraser/credit-card-statements/`
 *    - checking cartola PDFs → `cfraser/cartolas-cuenta-corriente/`
 * 2. qpdf repair on unreadable credit-card PDFs (`repair:cc-pdfs-qpdf`, skippable)
 * 3. Parse all credit-card statement PDFs → `cfraser/cc-statements-parsed-all.csv`
 * 4. Merge-import parsed CC rows into SQLite (`import:cc-parsed`, default merge mode).
 * 5. Import new Santander checking cartola `.xlsx` under `cfraser/excels/cuenta corriente/` (incremental).
 * 6. Optionally parse/import checking cartola PDFs (`--checking-pdf`).
 * 7. Optionally run full `import:excel` (`--excel`, wipes/rebuilds net-worth import data).
 *
 * Usage (repo root):
 *   npm run import:cfraser-inbox
 *   npm run import:cfraser-inbox -- --dry-run
 *   npm run import:cfraser-inbox -- --skip-organize --account-id=35
 *   npm run import:cfraser-inbox -- --skip-qpdf-repair
 *   npm run import:cfraser-inbox -- --checking-pdf
 *   npm run import:cfraser-inbox -- --excel
 *
 * Env: same as individual steps (`CFRASER_PDFS_DIR`, `CFRASER_CSV_DIR`, …).
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { importCheckingCartolasFromDir } from "../src/checkingCartolaImport.js";
import { importCuentaVistaCartolasFromPdfs } from "../src/cuentaVistaCartolaImport.js";
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
  const skipChecking = hasFlag("skip-checking");
  const checkingPdf = hasFlag("checking-pdf");
  const skipExcel = hasFlag("skip-excel");
  const runExcel = hasFlag("excel");
  const accountId = argValue("account-id");

  if (!skipOrganize) {
    const organizeArgs = [
      path.join(SERVER_ROOT, "scripts", "organize-cfraser-statement-pdfs.py"),
    ];
    if (dryRun) organizeArgs.push("--dry-run");
    const code = runStep("Organize PDFs (cfraser/pdfs → statements/)", "python3", organizeArgs);
    if (code !== 0) process.exit(code);
  } else {
    console.log("\n=== Organize PDFs (skipped) ===");
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
    const repairArgs = [
      path.join(SERVER_ROOT, "scripts", "repair-cc-statement-pdfs-qpdf.py"),
      "--inbox",
    ];
    const repairDir = process.env.CFRASER_PDFS_DIR;
    if (repairDir) repairArgs.push(`--dir=${repairDir}`);
    const repairCode = runStep(
      "qpdf repair unreadable credit-card PDFs",
      "python3",
      repairArgs
    );
    if (repairCode !== 0 && !dryRun) {
      console.warn(
        "# qpdf repair reported failures (see above); continuing with parse — " +
          "re-download garbled PDFs or set CC_STATEMENT_PDF_PASSWORD for encrypted files."
      );
    }
  } else {
    console.log("\n=== qpdf repair credit-card PDFs (skipped) ===");
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

  if (!skipChecking) {
    console.log("\n=== Import checking cartolas (xlsx, incremental) ===");
    const result = importCheckingCartolasFromDir({
      dryRun,
      pdf: checkingPdf,
      skipPdfParse: hasFlag("skip-checking-pdf-parse"),
    });
    if (result.errors.length) {
      console.error(result.errors.join("\n"));
      process.exit(1);
    }
  } else {
    console.log("\n=== Import checking cartolas (skipped) ===");
  }

  if (!hasFlag("skip-cuenta-vista")) {
    console.log("\n=== Import cuenta vista cartolas (pdf, incremental) ===");
    console.log(
      "  PDFs: cfraser/cartolas-cuenta-vista/ (drop new files in cfraser/pdfs/ and re-run inbox to organize)"
    );
    const vistaResult = importCuentaVistaCartolasFromPdfs({
      dryRun,
      skipPdfParse: hasFlag("skip-cuenta-vista-pdf-parse"),
    });
    const imported = vistaResult.filesImported.length;
    const skipped = vistaResult.filesSkipped.length;
    const errs = vistaResult.errors.length;
    console.log(
      `  cuenta vista: ${imported} file(s) imported, ${skipped} month(s) already in DB, ${errs} error(s)`
    );
    if (imported === 0 && skipped > 0 && errs === 0) {
      console.log(
        "  (No new months — drop PDFs in cfraser/pdfs/ or cartolas-cuenta-vista/, then re-run without --skip-cuenta-vista-pdf-parse if parser cache is stale)"
      );
    }
    if (vistaResult.errors.length) {
      console.error(vistaResult.errors.join("\n"));
      process.exit(1);
    }
  } else {
    console.log("\n=== Import cuenta vista cartolas (skipped) ===");
  }

  if (!dryRun && !hasFlag("skip-sync")) {
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
  } else if (hasFlag("skip-sync")) {
    console.log("\n=== Global sync (skipped) ===");
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
