/**
 * Decode every archived «últimos movimientos» workbook and write them as JSON, each with the
 * instant it was downloaded (the file's mtime, kept through the archive rename) — the input of the
 * server's `redate-forward-posted-checking-rows.ts`, which re-dates the rows the bank listed under
 * the next workday (post-14:00 movements) to the day the listing was read:
 *
 *   npm run dump:checking-listings -w nw-tracker-ingest -- --out=<listings.json> [--dir=<archive dir>]
 *
 * `--dir` defaults to `cfraser/checking-ultimos-movimientos/imported/`. A relative path is read
 * from where the command was typed. A workbook that is not the peso account's listing fails.
 */
import fs from "node:fs";
import path from "node:path";
import { resolveCfraserDir } from "../paths.js";
import { santanderCheckingMovementsPayload } from "./checkingMovements.js";

function argValue(name: string): string | null {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  if (!hit) return null;
  return path.resolve(process.env.INIT_CWD ?? process.cwd(), hit.slice(name.length + 3));
}

const out = argValue("out");
if (!out) throw new Error("missing --out=");
const dir = argValue("dir") ?? path.join(resolveCfraserDir(), "checking-ultimos-movimientos", "imported");
const files = fs
  .readdirSync(dir)
  .filter((name) => /ultimos movimientos.*\.xlsx$/i.test(name))
  .map((name) => path.join(dir, name));
const listings = files
  .map((file) => {
    const payload = santanderCheckingMovementsPayload(fs.readFileSync(file));
    return {
      file: path.basename(file),
      fetched_at: fs.statSync(file).mtime.toISOString(),
      account: payload.account,
      movements: payload.movements.map((m) => ({
        date: m.date,
        description: m.description,
        amount: m.amount,
        document_no: m.document_no ?? "",
      })),
    };
  })
  .sort((a, b) => a.fetched_at.localeCompare(b.fetched_at));
fs.writeFileSync(out, JSON.stringify({ dir, listings }, null, 1));
console.log(`${listings.length} listing(s), ${listings.reduce((n, l) => n + l.movements.length, 0)} row(s) → ${out}`);
