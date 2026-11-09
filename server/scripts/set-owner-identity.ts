/**
 * Declare who the owner is, as the bank prints it (`owner_identity`, migration 277): the name
 * patterns the owner's own transfers carry («<owner> - SANTANDER») and the owner's RUT. The
 * checking description rules (server/src/cards/bankDescriptions.ts) read the table; with no row
 * they match nothing, so a live database declares its owner once with this script. Personal data
 * stays out of the repository: the demo and the tests seed their person from the generator.
 *
 *   npx tsx scripts/set-owner-identity.ts --name-pattern='NAME\s+SURNAME' [--name-pattern=…] [--rut=12.345.678-5]
 *
 * Patterns are JavaScript regular expression sources, matched case-insensitively. Running it
 * again with the same values changes nothing; it prints the table afterwards.
 */
import { db } from "../src/db.js";

const argv = process.argv.slice(2);
const names = argv.filter((a) => a.startsWith("--name-pattern=")).map((a) => a.slice("--name-pattern=".length));
const ruts = argv.filter((a) => a.startsWith("--rut=")).map((a) => a.slice("--rut=".length));
if (names.length === 0 && ruts.length === 0) {
  console.error("usage: set-owner-identity.ts --name-pattern=<regex> [--name-pattern=…] [--rut=<rut>]");
  process.exit(2);
}
for (const n of names) new RegExp(n, "i"); // an invalid pattern throws here, before any write

const ins = db.prepare(`INSERT OR IGNORE INTO owner_identity (kind, value) VALUES (?, ?)`);
const tx = db.transaction(() => {
  for (const n of names) ins.run("name_pattern", n);
  for (const r of ruts) ins.run("rut", r);
});
tx();

const rows = db.prepare(`SELECT id, kind, value FROM owner_identity ORDER BY id`).all() as { id: number; kind: string; value: string }[];
console.log(`owner_identity: ${rows.length} row(s)`);
for (const r of rows) console.log(`  ${r.id}  ${r.kind}  ${r.value}`);
