/**
 * Rename misfiled cuenta corriente cartola PDFs to `{period_to} cartola …` and align
 * `checking_cartola_imports` + `cfraser/checking-cartolas-from-pdf.json`.
 *
 *   npm run repair:checking-cartola-source-pdf -w nw-tracker-server [--dry-run]
 */
import fs from "node:fs";
import path from "node:path";
import { db } from "../src/db.js";
import {
  resolveCfraserCheckingCartolaPdfsDir,
  resolveCfraserCheckingCartolasDir,
} from "../src/cfraserPaths.js";
import {
  loadCheckingCartolasFromPdfJson,
  resolveCheckingCartolasFromPdfJsonPath,
  type CheckingCartolaPdfEntry,
  type CheckingCartolaPdfJson,
} from "../src/checkingCartolaPdfImport.js";
import { loadRootDotenv } from "../src/rootDotenv.js";

const RE_ISO_PREFIX = /^(\d{4}-\d{2}-\d{2})(.*)$/;

type RenamePlan = {
  oldBase: string;
  newBase: string;
  periodTo: string;
  periodFrom: string | null;
  inDb: boolean;
};

function cartolaPdfDirs(): string[] {
  return [resolveCfraserCheckingCartolaPdfsDir(), resolveCfraserCheckingCartolasDir()];
}

function resolveCartolaPdfPath(sourceFile: string): string | null {
  const base = sourceFile.split(/[/\\]/).pop() ?? sourceFile;
  for (const dir of cartolaPdfDirs()) {
    const full = path.join(dir, base);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

function targetExists(newBase: string): string | null {
  for (const dir of cartolaPdfDirs()) {
    const full = path.join(dir, newBase);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

function canonicalBasename(oldBase: string, periodTo: string): string | null {
  const m = RE_ISO_PREFIX.exec(oldBase);
  if (!m) return null;
  if (m[1] === periodTo) return null;
  return periodTo + m[2];
}

function buildPlans(
  jsonEntries: CheckingCartolaPdfEntry[],
  dbSourceFiles: Set<string>
): { plans: RenamePlan[]; errors: string[] } {
  const errors: string[] = [];
  const byOld = new Map<string, RenamePlan>();
  const jsonBySource = new Map(
    jsonEntries.map((e) => [e.source_file, e] as const)
  );

  for (const entry of jsonEntries) {
    if (entry.parse_status !== "ok") continue;
    const periodTo = String(entry.period_to ?? "").trim();
    if (!periodTo) continue;
    const oldBase = entry.source_file;
    const newBase = canonicalBasename(oldBase, periodTo);
    if (!newBase) continue;

    const inDb = dbSourceFiles.has(oldBase);
    if (!resolveCartolaPdfPath(oldBase)) {
      if (inDb) {
        errors.push(`missing PDF on disk for DB source_file=${oldBase}`);
      }
      continue;
    }

    const existingTarget = targetExists(newBase);
    if (existingTarget && path.basename(existingTarget) !== oldBase) {
      errors.push(`target already exists: ${newBase} (from ${oldBase})`);
      continue;
    }

    byOld.set(oldBase, {
      oldBase,
      newBase,
      periodTo,
      periodFrom: entry.period_from ?? null,
      inDb,
    });
  }

  for (const oldBase of dbSourceFiles) {
    if (!oldBase.toLowerCase().endsWith(".pdf")) continue;
    if (byOld.has(oldBase)) continue;
    const entry = jsonBySource.get(oldBase);
    if (entry?.parse_status === "ok") {
      const periodTo = String(entry.period_to ?? "").trim();
      if (periodTo && oldBase.slice(0, 10) === periodTo) continue;
    }
    if (!resolveCartolaPdfPath(oldBase)) {
      errors.push(`missing PDF on disk for DB source_file=${oldBase}`);
      continue;
    }
    errors.push(`DB source_file ${oldBase} has no JSON parse entry with mismatched period_to`);
  }

  const plans = [...byOld.values()].sort((a, b) => a.oldBase.localeCompare(b.oldBase));
  return { plans, errors };
}

function patchJsonSourceFiles(
  json: CheckingCartolaPdfJson,
  renames: Map<string, string>
): number {
  let patched = 0;
  for (const entry of json.cartolas) {
    const next = renames.get(entry.source_file);
    if (!next) continue;
    entry.source_file = next;
    patched += 1;
  }
  return patched;
}

function main(): void {
  loadRootDotenv();
  const dryRun = process.argv.includes("--dry-run");

  const jsonPath = resolveCheckingCartolasFromPdfJsonPath();
  const json = loadCheckingCartolasFromPdfJson(jsonPath);

  const dbSourceFiles = new Set(
    (
      db
        .prepare(
          `SELECT DISTINCT source_file FROM checking_cartola_imports
           WHERE source_file LIKE '%.pdf'
             AND source_file LIKE '%cuenta corriente%'`
        )
        .all() as { source_file: string }[]
    ).map((r) => r.source_file)
  );

  const { plans, errors: planErrors } = buildPlans(json.cartolas, dbSourceFiles);
  const errors = [...planErrors];

  const updImports = db.prepare(
    `UPDATE checking_cartola_imports
     SET source_file = ?, period_to = ?, period_from = ?
     WHERE source_file = ?`
  );

  let renamedFiles = 0;
  let dbRows = 0;
  let jsonEntries = 0;

  const applyDb = db.transaction(() => {
    for (const plan of plans) {
      console.log(`  ${plan.oldBase} -> ${plan.newBase}`);
      if (plan.inDb) {
        const info = updImports.run(
          plan.newBase,
          plan.periodTo,
          plan.periodFrom,
          plan.oldBase
        );
        dbRows += info.changes;
      }
      renamedFiles += 1;
    }
  });

  if (plans.length === 0) {
    console.log("repair-checking-cartola-source-pdf-names: nothing to rename");
  } else if (dryRun) {
    db.exec("SAVEPOINT repair_checking_cartola_source_pdf_dry");
    try {
      applyDb();
    } finally {
      db.exec("ROLLBACK TO repair_checking_cartola_source_pdf_dry");
      db.exec("RELEASE repair_checking_cartola_source_pdf_dry");
    }
    jsonEntries = patchJsonSourceFiles(
      json,
      new Map(plans.map((p) => [p.oldBase, p.newBase]))
    );
    console.log(
      `\nrepair-checking-cartola-source-pdf-names: would rename=${renamedFiles} db_rows=${dbRows} json_entries=${jsonEntries} errors=${errors.length} (dry-run)`
    );
  } else if (errors.length > 0) {
    console.error("Aborting: fix errors before applying renames.");
  } else {
    const renameMap = new Map<string, string>();
    for (const plan of plans) {
      const oldPath = resolveCartolaPdfPath(plan.oldBase);
      if (!oldPath) {
        errors.push(`missing PDF on disk at apply time: ${plan.oldBase}`);
        continue;
      }
      const newPath = path.join(path.dirname(oldPath), plan.newBase);
      if (fs.existsSync(newPath) && path.resolve(newPath) !== path.resolve(oldPath)) {
        errors.push(`target already exists at apply time: ${plan.newBase}`);
      }
    }

    if (errors.length === 0) {
      for (const plan of plans) {
        const oldPath = resolveCartolaPdfPath(plan.oldBase)!;
        const newPath = path.join(path.dirname(oldPath), plan.newBase);
        fs.renameSync(oldPath, newPath);
        renameMap.set(plan.oldBase, plan.newBase);
      }
      applyDb();
      jsonEntries = patchJsonSourceFiles(json, renameMap);
      const out = { ...json, repaired_at: new Date().toISOString() };
      fs.writeFileSync(jsonPath, `${JSON.stringify(out, null, 2)}\n`, "utf8");
    }

    console.log(
      `\nrepair-checking-cartola-source-pdf-names: renamed=${renameMap.size} db_rows=${dbRows} json_entries=${jsonEntries} errors=${errors.length}`
    );
  }

  if (errors.length > 0) {
    console.error("\nErrors:");
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  backfillPeriodRangeFromJson(json.cartolas, dryRun);
}

function backfillPeriodRangeFromJson(
  jsonEntries: CheckingCartolaPdfEntry[],
  dryRun: boolean
): void {
  const jsonBySource = new Map(
    jsonEntries
      .filter((e) => e.parse_status === "ok" && e.period_to)
      .map((e) => [e.source_file, e] as const)
  );
  const rows = db
    .prepare(
      `SELECT account_id, period_month, source_file, period_to
       FROM checking_cartola_imports
       WHERE source_file LIKE '%cuenta corriente%.pdf'
         AND (period_to IS NULL OR period_to = '')`
    )
    .all() as {
    account_id: number;
    period_month: string;
    source_file: string;
    period_to: string | null;
  }[];

  const upd = db.prepare(
    `UPDATE checking_cartola_imports
     SET period_to = ?, period_from = ?
     WHERE account_id = ? AND period_month = ?`
  );

  let patched = 0;
  const apply = db.transaction(() => {
    for (const row of rows) {
      const entry = jsonBySource.get(row.source_file);
      if (!entry?.period_to) continue;
      upd.run(entry.period_to, entry.period_from ?? null, row.account_id, row.period_month);
      patched += 1;
    }
  });

  if (dryRun) {
    db.exec("SAVEPOINT repair_checking_cartola_backfill_dry");
    try {
      apply();
    } finally {
      db.exec("ROLLBACK TO repair_checking_cartola_backfill_dry");
      db.exec("RELEASE repair_checking_cartola_backfill_dry");
    }
  } else {
    apply();
  }

  if (patched > 0) {
    console.log(
      dryRun
        ? `[dry-run] would backfill period_to/period_from on ${patched} import row(s)`
        : `Backfilled period_to/period_from on ${patched} import row(s).`
    );
  }
}

main();
