/**
 * Drop useless suffixes from cuenta vista cartola PDF names (` 0`, ` (2)`, cartola no.)
 * so files are `{period_to} cartola cuenta vista.pdf`. Removes orphan duplicates that
 * block the canonical name, then updates DB + JSON refs.
 *
 *   npm run repair:cuenta-vista-cartola-suffixes -w nw-tracker-server [--dry-run]
 */
import fs from "node:fs";
import path from "node:path";
import { db } from "../src/db.js";
import { resolveCfraserCuentaVistaCartolaPdfsDir } from "../src/cfraserPaths.js";
import {
  loadCuentaVistaCartolasFromPdfJson,
  resolveCuentaVistaCartolasFromPdfJsonPath,
  type CuentaVistaCartolaPdfJson,
} from "../src/cuentaVistaCartolaPdfImport.js";
import type { CheckingCartolaPdfEntry } from "../src/checkingCartolaPdfImport.js";
import { loadRootDotenv } from "../src/rootDotenv.js";

const RE_VISTA = /^(\d{4}-\d{2}-\d{2}) cartola cuenta vista(?: (.+))?\.pdf$/i;

type VistaName = { periodTo: string; suffix: string; base: string };

function parseVistaName(base: string): VistaName | null {
  const m = RE_VISTA.exec(base);
  if (!m) return null;
  return { periodTo: m[1]!, suffix: (m[2] ?? "").trim(), base };
}

function canonicalVistaBasename(periodTo: string): string {
  return `${periodTo} cartola cuenta vista.pdf`;
}

function vistaPdfDir(): string {
  return resolveCfraserCuentaVistaCartolaPdfsDir();
}

function resolveVistaPdfPath(base: string): string | null {
  const full = path.join(vistaPdfDir(), base);
  return fs.existsSync(full) ? full : null;
}

type RenamePlan = { oldBase: string; newBase: string; periodTo: string };

function buildRenamePlans(dbRefs: Set<string>, jsonBySource: Map<string, CheckingCartolaPdfEntry>): {
  plans: RenamePlan[];
  orphanDeletes: string[];
  errors: string[];
} {
  const errors: string[] = [];
  const plans: RenamePlan[] = [];
  const orphanDeletes = new Set<string>();

  for (const oldBase of dbRefs) {
    const parsed = parseVistaName(oldBase);
    if (!parsed) continue;
    const entry = jsonBySource.get(oldBase);
    const periodTo = String(entry?.period_to ?? parsed.periodTo).trim();
    const newBase = canonicalVistaBasename(periodTo);
    if (oldBase === newBase) continue;

    if (!resolveVistaPdfPath(oldBase)) {
      errors.push(`missing PDF on disk for DB source_file=${oldBase}`);
      continue;
    }

    const targetPath = resolveVistaPdfPath(newBase);
    if (targetPath) {
      if (dbRefs.has(newBase) && newBase !== oldBase) {
        errors.push(`canonical target ${newBase} already referenced in DB (from ${oldBase})`);
        continue;
      }
      if (!dbRefs.has(newBase)) {
        orphanDeletes.add(newBase);
      }
    }

    plans.push({ oldBase, newBase, periodTo });
  }

  return {
    plans: plans.sort((a, b) => a.oldBase.localeCompare(b.oldBase)),
    orphanDeletes: [...orphanDeletes].sort(),
    errors,
  };
}

function patchJson(
  json: CuentaVistaCartolaPdfJson,
  renames: Map<string, string>,
  deleted: Set<string>
): number {
  let patched = 0;
  json.cartolas = json.cartolas.filter((entry) => {
    if (deleted.has(entry.source_file)) {
      patched += 1;
      return false;
    }
    const next = renames.get(entry.source_file);
    if (next) {
      entry.source_file = next;
      patched += 1;
    }
    return true;
  });
  return patched;
}

function main(): void {
  loadRootDotenv();
  const dryRun = process.argv.includes("--dry-run");
  const jsonPath = resolveCuentaVistaCartolasFromPdfJsonPath();
  const json = loadCuentaVistaCartolasFromPdfJson(jsonPath);

  const jsonBySource = new Map(
    json.cartolas.map((e) => [e.source_file, e] as const)
  );

  const dbRefs = loadDbVistaRefs();

  const { plans, orphanDeletes, errors: planErrors } = buildRenamePlans(dbRefs, jsonBySource);
  const errors = [...planErrors];

  const updImports = db.prepare(
    `UPDATE checking_cartola_imports SET source_file = ? WHERE source_file = ?`
  );

  let dbRows = 0;
  let renamed = 0;
  let deleted = 0;
  let jsonPatched = 0;

  const applyDb = db.transaction(() => {
    for (const plan of plans) {
      const info = updImports.run(plan.newBase, plan.oldBase);
      dbRows += info.changes;
    }
  });

  if (plans.length === 0 && orphanDeletes.length === 0) {
    console.log("repair-cuenta-vista-cartola-pdf-suffixes: nothing to change");
  } else {
    for (const plan of plans) {
      console.log(`  rename ${plan.oldBase} -> ${plan.newBase}`);
    }
    for (const base of orphanDeletes) {
      console.log(`  delete orphan ${base}`);
    }

    if (dryRun) {
      db.exec("SAVEPOINT repair_vista_suffix_dry");
      try {
        applyDb();
      } finally {
        db.exec("ROLLBACK TO repair_vista_suffix_dry");
        db.exec("RELEASE repair_vista_suffix_dry");
      }
      jsonPatched = patchJson(
        json,
        new Map(plans.map((p) => [p.oldBase, p.newBase])),
        new Set(orphanDeletes)
      );
      console.log(
        `\nrepair-cuenta-vista-cartola-pdf-suffixes: would rename=${plans.length} delete=${orphanDeletes.length} db_rows=${dbRows} json=${jsonPatched} errors=${errors.length} (dry-run)`
      );
    } else if (errors.length > 0) {
      console.error("Aborting: fix errors before applying changes.");
    } else {
      const renameMap = new Map<string, string>();
      const deletedSet = new Set<string>();

      for (const base of orphanDeletes) {
        const p = resolveVistaPdfPath(base);
        if (!p) {
          errors.push(`orphan delete target missing at apply time: ${base}`);
          continue;
        }
      }

      for (const plan of plans) {
        const oldPath = resolveVistaPdfPath(plan.oldBase);
        if (!oldPath) {
          errors.push(`missing PDF at apply time: ${plan.oldBase}`);
          continue;
        }
        const newPath = path.join(vistaPdfDir(), plan.newBase);
        if (fs.existsSync(newPath) && path.resolve(newPath) !== path.resolve(oldPath)) {
          if (!orphanDeletes.includes(plan.newBase)) {
            errors.push(`target exists at apply time: ${plan.newBase}`);
          }
        }
      }

      if (errors.length === 0) {
        for (const base of orphanDeletes) {
          fs.unlinkSync(resolveVistaPdfPath(base)!);
          deletedSet.add(base);
          deleted += 1;
        }
        for (const plan of plans) {
          const oldPath = resolveVistaPdfPath(plan.oldBase)!;
          const newPath = path.join(vistaPdfDir(), plan.newBase);
          fs.renameSync(oldPath, newPath);
          renameMap.set(plan.oldBase, plan.newBase);
          renamed += 1;
        }
        applyDb();
        jsonPatched = patchJson(json, renameMap, deletedSet);
        const out = { ...json, suffixes_repaired_at: new Date().toISOString() };
        fs.writeFileSync(jsonPath, `${JSON.stringify(out, null, 2)}\n`, "utf8");
      }

      console.log(
        `\nrepair-cuenta-vista-cartola-pdf-suffixes: renamed=${renamed} deleted=${deleted} db_rows=${dbRows} json=${jsonPatched} errors=${errors.length}`
      );
    }
  }

  if (errors.length > 0) {
    console.error("\nErrors:");
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  cleanupOrphanSuffixedPdfs(loadDbVistaRefs(), json, jsonPath, dryRun);
}

function loadDbVistaRefs(): Set<string> {
  return new Set(
    (
      db
        .prepare(
          `SELECT DISTINCT source_file FROM checking_cartola_imports
           WHERE source_file LIKE '%cuenta vista%.pdf'`
        )
        .all() as { source_file: string }[]
    ).map((r) => r.source_file)
  );
}

function cleanupOrphanSuffixedPdfs(
  dbRefs: Set<string>,
  json: CuentaVistaCartolaPdfJson,
  jsonPath: string,
  dryRun: boolean
): void {
  const dir = vistaPdfDir();
  if (!fs.existsSync(dir)) return;

  const toDelete: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.toLowerCase().endsWith(".pdf")) continue;
    const parsed = parseVistaName(name);
    if (!parsed?.suffix) continue;
    if (dbRefs.has(name)) continue;
    toDelete.push(name);
  }

  if (toDelete.length === 0) return;

  for (const name of toDelete.sort()) {
    console.log(dryRun ? `  [dry-run] delete orphan ${name}` : `  delete orphan ${name}`);
  }

  if (dryRun) return;

  const deleted = new Set<string>();
  for (const name of toDelete) {
    fs.unlinkSync(path.join(dir, name));
    deleted.add(name);
  }

  const jsonPatched = patchJson(json, new Map(), deleted);
  if (jsonPatched > 0) {
    const out = { ...json, orphan_suffixes_removed_at: new Date().toISOString() };
    fs.writeFileSync(jsonPath, `${JSON.stringify(out, null, 2)}\n`, "utf8");
  }
  console.log(`Removed ${deleted.size} unreferenced suffixed orphan PDF(s).`);
}

main();
