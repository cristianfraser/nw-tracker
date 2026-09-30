/**
 * Print the ingest contract as JSON Schema (or write it with `--out=<file>`), for a feeder not
 * written in TypeScript:
 *
 *   npm run schema -w nw-tracker-contracts -- --out=/tmp/ingest-schema.json
 */
import fs from "node:fs";
import { ingestJsonSchemas } from "../src/index.js";

const outArg = process.argv.find((a) => a.startsWith("--out="));
const text = `${JSON.stringify(ingestJsonSchemas(), null, 2)}\n`;
if (outArg) {
  fs.writeFileSync(outArg.slice("--out=".length), text);
} else {
  process.stdout.write(text);
}
