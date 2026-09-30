/**
 * Imports one año tributario's SII documents from a folder: the filed «F22 Compacto» PDF
 * (F22Compacto_*.pdf, read with `pdftotext -layout`) into `sii_f22_filed`, and every
 * DJ_<code>_<año>_<rut>.xlsx summary into `sii_informed_dj` (migration 198). The year's rows are
 * replaced whole. A file for another year, a second compact form, or a compact form that fails
 * its own arithmetic throws before anything is written.
 *
 * Usage (from server/):
 *   npx tsx scripts/import-sii-tax-year.ts --year=2026 --dir=../cfraser/sii/AT2026 [--apply]
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { db } from "../src/db.js";
import { assertF22Identities, parseF22CompactoText } from "../src/siiF22Compacto.js";
import { informedDjFileKey, parseInformedDjXlsx, type InformedDjField } from "../src/siiInformedDj.js";

const APPLY = process.argv.includes("--apply");
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const year = Number(arg("year"));
const dir = arg("dir");
if (!Number.isInteger(year) || !dir) throw new Error("--year=<año tributario> and --dir=<folder> are required");

const files = fs.readdirSync(dir).sort();
const compact = files.filter((f) => /^F22Compacto_.*\.pdf$/.test(f));
if (compact.length !== 1) throw new Error(`${dir}: ${compact.length} F22Compacto PDF(s), expected 1`);
const f22File = compact[0]!;
const f22 = parseF22CompactoText(execFileSync("pdftotext", ["-layout", path.join(dir, f22File), "-"]).toString());
assertF22Identities(f22);
if (!/_\d{4}_/.test(f22File) || !f22File.includes(`_${year}_`)) throw new Error(`${f22File} is not año tributario ${year}`);

const djs: { djCode: number; file: string; fields: InformedDjField[] }[] = [];
for (const f of files.filter((f) => f.endsWith(".xlsx"))) {
  const key = informedDjFileKey(f);
  if (!key) throw new Error(`${f}: not a DJ_<code>_<year>_<rut>.xlsx summary`);
  if (key.taxYear !== year) throw new Error(`${f} is año tributario ${key.taxYear}, not ${year}`);
  djs.push({ djCode: key.djCode, file: f, fields: parseInformedDjXlsx(fs.readFileSync(path.join(dir, f))) });
}

console.log(`AT${year}: ${f22.size} F22 amount code(s) from ${f22File}; ${djs.length} DJ summar(ies): ${djs.map((d) => d.djCode).join(", ")}`);
for (const d of djs) for (const f of d.fields) console.log(`  DJ ${d.djCode}  ${f.field} = ${f.value}`);

if (!APPLY) {
  console.log("Report only — pass --apply to write sii_f22_filed / sii_informed_dj.");
} else {
  db.transaction(() => {
    db.prepare(`DELETE FROM sii_f22_filed WHERE tax_year = ?`).run(year);
    db.prepare(`DELETE FROM sii_informed_dj WHERE tax_year = ?`).run(year);
    const putF22 = db.prepare(`INSERT INTO sii_f22_filed (tax_year, code, amount, source_file) VALUES (?, ?, ?, ?)`);
    for (const [code, amount] of f22) putF22.run(year, code, amount, f22File);
    const putDj = db.prepare(
      `INSERT INTO sii_informed_dj (tax_year, dj_code, field, value, source_file) VALUES (?, ?, ?, ?, ?)`
    );
    for (const d of djs) for (const f of d.fields) putDj.run(year, d.djCode, f.field, f.value, d.file);
  })();
  console.log(`Wrote AT${year}.`);
}
