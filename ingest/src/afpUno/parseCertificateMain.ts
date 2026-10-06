/**
 * Read an AFP UNO movements certificate PDF and write its rows as JSON — the input of the
 * server's `rebuild-afp-ledger-from-certificate.ts`, which rebuilds the account's whole cuota
 * ledger from a full-history certificate:
 *
 *   npm run parse:afp-uno-certificate -w nw-tracker-ingest -- --pdf=<movimientos.pdf> --out=<rows.json>
 *
 * A relative path is read from where the command was typed. Fails on any row the parser cannot
 * account for, as the nightly read does.
 */
import fs from "node:fs";
import path from "node:path";
import { parseMovementsCertificate, pdfLayoutText } from "./certificates.js";

function arg(name: string): string {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  if (!hit) throw new Error(`missing --${name}=`);
  const value = hit.slice(name.length + 3);
  return path.resolve(process.env.INIT_CWD ?? process.cwd(), value);
}

const pdf = arg("pdf");
const out = arg("out");
const cert = parseMovementsCertificate(pdfLayoutText(fs.readFileSync(pdf)));
fs.writeFileSync(out, JSON.stringify({ source_pdf: path.basename(pdf), ...cert }, null, 1));
console.log(`${cert.rows.length} rows, períodos ${cert.from_period} → ${cert.to_period}, folio ${cert.folio} → ${out}`);
