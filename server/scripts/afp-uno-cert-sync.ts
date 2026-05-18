/**
 * Parse AFP Uno certificate (PDF / text / CSV), match rows to `import:excel` AFP cumulative movements by
 * **contribution month** (`YYYY-MM` from `occurred_on` month-end vs cert `MM-YYYY` period), set `movements.units_delta`
 * from certificate **cuotas**, and optionally seed `fund_unit_daily` for `afp_uno_cuota_a` (legacy **cotizaciones**
 * extract only — movimientos CSV does not seed scratch fund rows).
 *
 * Sources:
 *   - **Movimientos** (UNO-15+): `pdftotext -layout` on “CERTIFICADO DE MOVIMIENTOS”, or **`--csv=`** from
 *     `npm run afp:uno:cert-pdf-to-csv`.
 *   - **Cotizaciones** (legacy): “CERTIFICADO COTIZACIONES” text.
 *
 * Usage:
 *   npm run afp:uno:cert-sync -w nw-tracker-server -- --account-id=NN --pdf=/path/to/Certificado_UNO-15.pdf
 *   npm run afp:uno:cert-sync -w nw-tracker-server -- --account-id=NN --csv=/path/to/afp-uno-certificado-cotizaciones.csv
 *   npm run afp:uno:cert-sync -w nw-tracker-server -- --account-id=NN --text=/path/to/cert.txt --dry-run
 *   npm run afp:uno:cert-sync -w nw-tracker-server -- --account-id=NN --pdf=... --apply --no-seed-valor
 */
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { db } from "../src/db.js";
import { parseAfpCertificadoBody } from "../src/afpUnoCertMovimientosParse.js";
import { applyAfpUnoCertificadoCuotasToMovements } from "../src/afpUnoCertMovementSync.js";

function arg(name: string): string | undefined {
  const p = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!p) return undefined;
  return p.slice(name.length + 3);
}

const APPLY = process.argv.includes("--apply");
const DRY = process.argv.includes("--dry-run") || !APPLY;
const NO_SEED = process.argv.includes("--no-seed-valor");

function readCertBody(pdfPath?: string, textPath?: string, csvPath?: string): string {
  if (csvPath) {
    return fs.readFileSync(csvPath, "utf8");
  }
  if (textPath) {
    return fs.readFileSync(textPath, "utf8");
  }
  if (pdfPath) {
    try {
      return execFileSync("pdftotext", ["-layout", pdfPath, "-"], {
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      });
    } catch {
      throw new Error(
        "Could not run `pdftotext` on the PDF. Install Poppler (macOS: `brew install poppler`) or pass `--csv=` / `--text=`."
      );
    }
  }
  throw new Error("Pass --pdf=…, --text=…, or --csv=…");
}

function main(): void {
  const accountId = Number(arg("account-id"));
  if (!Number.isFinite(accountId) || accountId <= 0) {
    console.error("Required: --account-id=NN (AFP account, category afp).");
    process.exit(1);
  }
  const pdf = arg("pdf");
  const text = arg("text");
  const csv = arg("csv");
  if (!pdf && !text && !csv) {
    console.error("Pass --pdf=…, --text=…, or --csv=…");
    process.exit(1);
  }

  const slug = db
    .prepare(`SELECT c.slug FROM accounts a JOIN categories c ON c.id = a.category_id WHERE a.id = ?`)
    .get(accountId) as { slug: string } | undefined;
  if (slug?.slug !== "afp") {
    console.error(`Account ${accountId} must be category "afp" (found ${slug?.slug ?? "none"}).`);
    process.exit(1);
  }

  const body = readCertBody(pdf, text, csv);
  if (!body.trim()) {
    console.error("Empty certificate body.");
    process.exit(1);
  }

  const srcHint = csv ?? text ?? pdf ?? "";
  const preview = parseAfpCertificadoBody(body, path.basename(srcHint));
  console.log(
    `Parsed ${preview.rows.length} row(s) (${preview.isMovimientos ? "movimientos / CSV" : "cotizaciones"}).`
  );
  if (preview.rows.length === 0) {
    console.error("No rows parsed — check input format or extend afpUnoCertMovimientosParse.ts / afpUnoCertParse.ts.");
    process.exit(1);
  }

  const r = applyAfpUnoCertificadoCuotasToMovements({
    accountId,
    certText: body,
    certSourceFileName: path.basename(srcHint),
    dryRun: DRY,
    seedFundUnitDaily: !NO_SEED,
  });

  console.log(
    `${DRY ? "[dry-run] " : ""}Done. matched=${r.matched} warnings=${r.warned} ` +
      `fund_unit_daily ${DRY ? `would_seed=${r.fundUnitWouldSeed}` : `seeded=${r.fundUnitSeeded}`} ` +
      `${NO_SEED ? "(--no-seed-valor)" : ""} ${DRY ? "(no DB writes — pass --apply)" : ""}`
  );
}

try {
  main();
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
