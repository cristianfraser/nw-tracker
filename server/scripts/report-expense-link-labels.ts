/**
 * Report only: the short label an expense row would show for each kind of link (a processor or
 * shop receipt, an App Store app, a bank transfer's counterparty), as proposed — with a flag on the
 * ones that still carry redundant or out-of-place text (a tagline, a parenthesis, the processor or a
 * bank, a legal suffix, shouting caps). Reads the database, writes nothing.
 *
 * Proposed rules:
 *   - receipt: the payee alone (never «(<processor>)»)
 *   - App Store: the app's printed name before its tagline, case kept («Grindr - Gay Dating & Chat» → «Grindr»)
 *   - transfer: the counterparty's name («Veronica Fraser», no bank)
 *
 *   npx tsx scripts/report-expense-link-labels.ts            (from server/; flagged labels first)
 *   npx tsx scripts/report-expense-link-labels.ts --flagged  (only the flagged ones)
 */
import { db } from "../src/db.js";
import { loadPaymentProcessorReceipts } from "../src/paymentProcessorReceipts.js";
import { deriveMerchantChargeLinks } from "../src/merchantExpenseNotes.js";

type Row = { kind: string; source: string; full: string; label: string; count: number; flags: string[] };

/** «Grindr - Gay Dating & Chat» → «Grindr»: the name before its tagline, case kept. */
function appShortName(name: string): string {
  return name.split(/ - | – |: |, | \(/)[0]!.trim();
}

function flagsFor(label: string, source: string): string[] {
  const f: string[] = [];
  if (/[()]/.test(label)) f.push("parenthesis");
  if (/ [-–] |: /.test(label)) f.push("tagline");
  if (source && label.toLowerCase().includes(source.toLowerCase())) f.push("names-source");
  if (/\b(banco|bank|bci|santander|edwards|citi|scotiabank|itau|itaú|estado)\b/i.test(label)) f.push("bank");
  if (/\b(spa|s\.?\s?a\.?|ltda\.?|limitada|eirl|s\.?p\.?a\.?|inc\.?|llc|gmbh)\b\.?$/i.test(label) || /\b(spa|ltda|limitada|eirl)\b/i.test(label))
    f.push("legal-suffix");
  if (/\d{1,2}\.?\d{3}\.?\d{3}-[\dkK]/.test(label)) f.push("rut");
  if (label.length > 24) f.push("long");
  if (label.length > 4 && label === label.toUpperCase() && /[A-Z]/.test(label)) f.push("all-caps");
  if (/^[\s?—-]*$/.test(label)) f.push("empty");
  return f;
}

function add(rows: Map<string, Row>, kind: string, source: string, full: string, label: string) {
  const key = `${kind}|${source}|${full}`;
  const r = rows.get(key);
  if (r) r.count++;
  else rows.set(key, { kind, source, full, label, count: 1, flags: flagsFor(label, source) });
}

const rows = new Map<string, Row>();

for (const r of loadPaymentProcessorReceipts()) add(rows, "receipt", r.processor, r.payee, r.payee.trim());

for (const link of deriveMerchantChargeLinks().links) add(rows, "app_store", "App Store", link.name, appShortName(link.name));

const transfers = db
  .prepare(
    `SELECT n.kind, CASE WHEN n.kind = 'incoming' THEN n.from_name ELSE n.to_name END AS name,
            CASE WHEN n.kind = 'incoming' THEN n.from_bank ELSE n.to_bank END AS bank
     FROM movement_transfer_notices t JOIN bank_transfer_notices n USING (message_id)
     WHERE n.kind <> 'between_own_products'`
  )
  .all() as { kind: string; name: string | null; bank: string | null }[];
for (const t of transfers) add(rows, "transfer", t.bank ?? "", t.name ?? "", (t.name ?? "").trim());

const onlyFlagged = process.argv.includes("--flagged");
const list = [...rows.values()]
  .filter((r) => !onlyFlagged || r.flags.length > 0)
  .sort((a, b) => b.flags.length - a.flags.length || a.kind.localeCompare(b.kind) || b.count - a.count);

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));
console.log(`${pad("kind", 10)} ${pad("source", 16)} ${pad("n", 4)} ${pad("label (proposed)", 34)} ${pad("flags", 30)} full`);
for (const r of list) {
  console.log(
    `${pad(r.kind, 10)} ${pad(r.source, 16)} ${pad(String(r.count), 4)} ${pad(r.label, 34)} ${pad(r.flags.join(","), 30)} ${r.full === r.label ? "" : r.full}`
  );
}

console.log("\nSummary (distinct labels / flagged):");
for (const kind of ["receipt", "app_store", "transfer"]) {
  const ofKind = [...rows.values()].filter((r) => r.kind === kind);
  const byFlag = new Map<string, number>();
  for (const r of ofKind) for (const f of r.flags) byFlag.set(f, (byFlag.get(f) ?? 0) + 1);
  console.log(
    `  ${pad(kind, 10)} ${ofKind.length} distinct, ${ofKind.filter((r) => r.flags.length > 0).length} flagged` +
      (byFlag.size ? ` — ${[...byFlag].map(([f, n]) => `${f} ${n}`).join(", ")}` : "")
  );
}
