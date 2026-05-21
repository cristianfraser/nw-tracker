/**
 * Re-apply UNO certificate cuotas on Table 1-3 rows, refresh orphan-month movements, optional Modelo prior
 * gap, and website reconcile — without re-running full import:excel.
 *
 *   npm run afp:uno:refresh-cert-derived -w nw-tracker-server -- --account-id=16 --pdf=... --dry-run
 *   npm run afp:uno:refresh-cert-derived -w nw-tracker-server -- --account-id=16 --csv=... --apply
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  AFP_UNO_WEBSITE_CUOTAS_TARGET,
  computeAfpCuotasWebsiteReconciliationDelta,
  readOptionalAfpUnoWebsiteCuotasTarget,
  tryReadModeloCotizacionesRows,
  type MonthKey,
} from "../src/afpModeloPriorCuotasBackfill.js";
import { applyAfpUnoCertificadoCuotasToMovements } from "../src/afpUnoCertMovementSync.js";
import {
  computeOrphanUnoCertMonthMovements,
  firstAfpCumulativeMovementMonth,
} from "../src/afpUnoOrphanCertMonths.js";
import { afpCuotasCumulativeThroughDate } from "../src/afpUnoValuation.js";
import { chileCalendarTodayYmd } from "../src/chileDate.js";
import { db } from "../src/db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultCfraserDir = path.resolve(__dirname, "..", "..", "cfraser");

function arg(name: string): string | undefined {
  const p = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!p) return undefined;
  return p.slice(name.length + 3);
}

function readCertBody(pdfPath?: string, csvPath?: string): { body: string; sourceName: string } {
  if (csvPath) {
    return { body: fs.readFileSync(csvPath, "utf8"), sourceName: path.basename(csvPath) };
  }
  if (pdfPath) {
    const body = execFileSync("pdftotext", ["-layout", pdfPath, "-"], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    return { body, sourceName: path.basename(pdfPath) };
  }
  throw new Error("Pass --pdf=… or --csv=…");
}

function monthEndDate(ym: string): string {
  const [ys, ms] = ym.split("-");
  const y = Number(ys);
  const mo = Number(ms);
  return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
}

function main(): void {
  const accountId = Number(arg("account-id"));
  const dryRun = !process.argv.includes("--apply");
  const pdf = arg("pdf");
  const csv = arg("csv");
  const cfraserDir = path.resolve(arg("cfraser-dir") ?? defaultCfraserDir);
  if (!Number.isFinite(accountId) || accountId <= 0) {
    console.error("Required: --account-id=NN [--pdf=… | --csv=…] [--apply]");
    process.exit(1);
  }
  if (!pdf && !csv) {
    const fallback = path.join(cfraserDir, "afp-uno-certificado-cotizaciones.csv");
    if (!fs.existsSync(fallback)) {
      console.error("Pass --pdf=… or --csv=… (or place afp-uno-certificado-cotizaciones.csv in cfraser/).");
      process.exit(1);
    }
    const body = fs.readFileSync(fallback, "utf8");
    run(accountId, body, path.basename(fallback), cfraserDir, dryRun);
    return;
  }
  const { body, sourceName } = readCertBody(pdf, csv);
  run(accountId, body, sourceName, cfraserDir, dryRun);
}

function run(
  accountId: number,
  certBody: string,
  certSourceFileName: string,
  cfraserDir: string,
  dryRun: boolean
): void {
  const slug = db
    .prepare(`SELECT c.slug FROM accounts a JOIN categories c ON c.id = a.category_id WHERE a.id = ?`)
    .get(accountId) as { slug: string } | undefined;
  if (slug?.slug !== "afp") {
    console.error(`Account ${accountId} is not category afp`);
    process.exit(1);
  }

  const asOf = chileCalendarTodayYmd();
  const sum0 = afpCuotasCumulativeThroughDate(accountId, asOf);
  console.log(`${dryRun ? "[dry-run] " : ""}Σ cuotas before: ${sum0.toFixed(4)}`);

  const certR = applyAfpUnoCertificadoCuotasToMovements({
    accountId,
    certText: certBody,
    certSourceFileName,
    dryRun,
    seedFundUnitDaily: false,
  });
  console.log(
    `cert-sync: matched=${certR.matched} warnings=${certR.warned}${dryRun ? " (no writes)" : ""}`
  );

  const delOrphan = db.prepare(
    `DELETE FROM movements WHERE account_id = ? AND note LIKE 'import:excel|afp-orphan-cert-month%'`
  );
  const delReconcile = db.prepare(
    `DELETE FROM movements WHERE account_id = ? AND (
      note LIKE 'import:excel|afp-cuotas-website-reconcile%'
      OR note LIKE 'import:excel|afp-cuotas-synthetic-trim%'
    )`
  );

  if (!dryRun) {
    delOrphan.run(accountId);
    delReconcile.run(accountId);
  }

  const afpMovs = db
    .prepare(
      `SELECT occurred_on, note, COALESCE(units_delta, 0) AS units_delta FROM movements WHERE account_id = ? AND note LIKE '%Table1-3|AFP%'`
    )
    .all(accountId) as { occurred_on: string; note: string | null; units_delta: number }[];
  const existingMk = new Set(afpMovs.map((m) => m.occurred_on.slice(0, 7) as MonthKey));
  const table1UnitsByMonth = new Map<MonthKey, number>();
  for (const m of afpMovs) {
    const mk = m.occurred_on.slice(0, 7) as MonthKey;
    table1UnitsByMonth.set(mk, (table1UnitsByMonth.get(mk) ?? 0) + m.units_delta);
  }
  const modeloRows = tryReadModeloCotizacionesRows(cfraserDir);
  const orphans = computeOrphanUnoCertMonthMovements({
    unoCertText: certBody,
    unoCertSourceFileName: certSourceFileName,
    modeloRows,
    firstCumulativeMk: firstAfpCumulativeMovementMonth(afpMovs),
    existingMovementMonths: existingMk,
    table1UnitsByMonth,
    asOfYmd: asOf,
  });

  const insMov = db.prepare(
    `INSERT INTO movements (account_id, amount_clp, occurred_on, note, units_delta) VALUES (?,?,?,?,?)`
  );
  if (!dryRun) {
    for (const o of orphans) {
      insMov.run(accountId, o.amountClp, o.occurredOn, o.note, o.unitsDelta);
    }
  }
  console.log(
    `orphans: ${orphans.length} row(s) Σ=${orphans.reduce((s, x) => s + x.unitsDelta, 0).toFixed(4)}` +
      (orphans.length ? ` (${orphans.map((x) => x.periodYm).join(", ")})` : "")
  );

  const target =
    readOptionalAfpUnoWebsiteCuotasTarget(cfraserDir) ?? AFP_UNO_WEBSITE_CUOTAS_TARGET;
  const sumBeforeRecon = dryRun
    ? sum0 +
      orphans.reduce((s, x) => s + x.unitsDelta, 0) -
      (
        db
          .prepare(
            `SELECT COALESCE(SUM(units_delta), 0) AS u FROM movements WHERE account_id = ? AND (
              note LIKE 'import:excel|afp-orphan-cert-month%'
              OR note LIKE 'import:excel|afp-cuotas-website-reconcile%'
              OR note LIKE 'import:excel|afp-cuotas-synthetic-trim%'
            )`
          )
          .get(accountId) as { u: number }
      ).u
    : afpCuotasCumulativeThroughDate(accountId, asOf);

  const reconDelta = computeAfpCuotasWebsiteReconciliationDelta(sumBeforeRecon, target);
  if (reconDelta != null) {
    const reconDay = monthEndDate("2017-06");
    const note = `import:excel|afp-cuotas-website-reconcile|delta=${reconDelta}|target=${target}|sum_before=${sumBeforeRecon}|amount_clp_placeholder=1|script=afp-uno-refresh-cert-derived`;
    if (!dryRun) insMov.run(accountId, 1, reconDay, note, reconDelta);
    console.log(
      `website-reconcile: ${reconDelta >= 0 ? "+" : ""}${reconDelta} → Σ≈${(sumBeforeRecon + reconDelta).toFixed(2)} (target ${target})`
    );
  } else {
    console.log(`website-reconcile: not needed (Σ≈${sumBeforeRecon.toFixed(2)} ≈ ${target})`);
  }

  const sumFinal = dryRun
    ? sumBeforeRecon + (reconDelta ?? 0)
    : afpCuotasCumulativeThroughDate(accountId, asOf);
  console.log(`${dryRun ? "[dry-run] " : ""}Σ cuotas after: ${sumFinal.toFixed(4)}`);
}

try {
  main();
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
