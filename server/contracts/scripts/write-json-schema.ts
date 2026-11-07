/**
 * Print the ingest contract as JSON Schema (or write it with `--out=<file>`), for a feeder not
 * written in TypeScript:
 *
 *   npm run schema -w nw-tracker-contracts -- --out=/tmp/ingest-schema.json
 *
 * `--shared` (re)writes the schemas of the files read in more than one language under
 * `data/schemas/` (the cc-cards config, the line rules, the parser outputs, the parser CSV columns).
 */
import fs from "node:fs";
import path from "node:path";
import { ingestJsonSchemas } from "../src/index.js";
import { SHARED_SCHEMA_DIR, sharedSchemaFiles } from "../src/schemas/index.js";

if (process.argv.includes("--shared")) {
  fs.mkdirSync(SHARED_SCHEMA_DIR, { recursive: true });
  for (const [file, text] of Object.entries(sharedSchemaFiles())) {
    fs.writeFileSync(path.join(SHARED_SCHEMA_DIR, file), text);
    console.log(`wrote ${path.join(SHARED_SCHEMA_DIR, file)}`);
  }
} else {
  const outArg = process.argv.find((a) => a.startsWith("--out="));
  const text = `${JSON.stringify(ingestJsonSchemas(), null, 2)}\n`;
  if (outArg) {
    fs.writeFileSync(outArg.slice("--out=".length), text);
  } else {
    process.stdout.write(text);
  }
}
