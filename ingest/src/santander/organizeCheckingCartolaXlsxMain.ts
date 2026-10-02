/**
 * File the monthly cuenta corriente cartola xlsx found in `cfraser/inbox/` under
 * `cfraser/excels/cuenta corriente/` (canonical names), and write what moved to `--manifest`
 * (JSON `{moved, skipped, errors}`), which the inbox pipeline reads to import just those.
 *
 *   npm run organize:checking-cartola-xlsx -w nw-tracker-ingest -- --manifest=<path> [--dry-run]
 *
 * Exit status: non-zero when a file's canonical name cannot be derived.
 */
import fs from "node:fs";
import { organizeCheckingCartolaXlsxFromInbox } from "./checkingCartolaInbox.js";

const manifest = process.argv.find((a) => a.startsWith("--manifest="))?.slice("--manifest=".length);
const result = organizeCheckingCartolaXlsxFromInbox({ dryRun: process.argv.includes("--dry-run") });
for (const m of result.moved) console.log(`  ${m.from} -> excels/cuenta corriente/${m.to}`);
for (const s of result.skipped) console.log(`  skip ${s.file}: ${s.reason}`);
for (const e of result.errors) console.error(`  ${e.file}: ${e.error}`);
if (manifest) fs.writeFileSync(manifest, `${JSON.stringify(result, null, 2)}\n`);
process.exitCode = result.errors.length > 0 ? 1 : 0;
