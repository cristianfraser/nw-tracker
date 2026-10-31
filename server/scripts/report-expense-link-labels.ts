/**
 * Report only: the names an expense row would show, to build the vendor catalog. Reads the
 * database, writes nothing.
 *
 * Sections:
 *   1. Link labels — the short label proposed for each kind of link (a processor or shop receipt,
 *      an App Store app, a bank transfer's counterparty), flagged when it still carries redundant
 *      or out-of-place text (a tagline, a parenthesis, the processor or a bank, a legal suffix,
 *      shouting caps, length).
 *   2. Transfer counterparties — one row per counterparty name: RUT, bank, how many movements,
 *      first / last date, pesos, the movements' categories and a sample comment, so a name can be
 *      told apart (who is it, what was it paying).
 *   3. Merchants — the expense lines' merchants as the bank prints them (card and checking), the
 *      most frequent first, with their categories: candidates for a display name («AMZN Mktp US…»).
 *
 * Proposed label rules:
 *   - receipt: the payee alone (never «(<processor>)»)
 *   - App Store: the app's printed name before its tagline, case kept («Grindr - Gay Dating & Chat» → «Grindr»)
 *   - transfer: the counterparty's name («Veronica Fraser», no bank)
 *
 *   npx tsx scripts/report-expense-link-labels.ts                  (all sections)
 *   npx tsx scripts/report-expense-link-labels.ts --flagged        (section 1: flagged labels only)
 *   npx tsx scripts/report-expense-link-labels.ts --merchants=300  (section 3: top N, default 150)
 *   npx tsx scripts/report-expense-link-labels.ts --detail=gesmob  (every movement of the transfers whose
 *                                                                   counterparty name or RUT contains the text)
 */
import { db } from "../src/db.js";
import { loadPaymentProcessorReceipts } from "../src/paymentProcessorReceipts.js";
import { deriveMerchantChargeLinks } from "../src/merchantExpenseNotes.js";
import { buildFlowsExpensesPayload } from "../src/flowsExpenses.js";

const arg = (name: string): string | null => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));
const padL = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padStart(n));
const clp = (n: number) => Math.round(n).toLocaleString("es-CL"); // convention-ok: server report script, not UI
const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

const detail = arg("detail");
const lines = buildFlowsExpensesPayload().lines;
const categoryByMovement = new Map<number, string>();
for (const l of lines) if (l.source === "checking") categoryByMovement.set(l.statement_line_id, l.category_slug);

// ---------------------------------------------------------------------------------------------
// --detail: every movement of the matching counterparties, then stop.
// ---------------------------------------------------------------------------------------------
type TransferRow = {
  movement_id: number;
  account: string;
  kind: string;
  name: string | null;
  rut: string | null;
  bank: string | null;
  account_number: string | null;
  comment: string | null;
  notice_date: string;
  occurred_on: string | null;
  amount: number;
  note: string | null;
};
const transferRows = db
  .prepare(
    `SELECT t.movement_id, a.name AS account, n.kind,
            CASE WHEN n.kind = 'incoming' THEN n.from_name ELSE n.to_name END AS name,
            CASE WHEN n.kind = 'incoming' THEN n.from_rut ELSE n.to_rut END AS rut,
            CASE WHEN n.kind = 'incoming' THEN n.from_bank ELSE n.to_bank END AS bank,
            CASE WHEN n.kind = 'incoming' THEN n.from_account_number ELSE n.to_account_number END AS account_number,
            n.comment, n.notice_date, m.occurred_on, n.amount, m.note
     FROM movement_transfer_notices t
     JOIN bank_transfer_notices n USING (message_id)
     JOIN accounts a ON a.id = t.account_id
     LEFT JOIN movements m ON m.id = t.movement_id
     WHERE n.kind <> 'between_own_products'
     ORDER BY n.notice_date`
  )
  .all() as TransferRow[];

if (detail) {
  const q = fold(detail);
  const hits = transferRows.filter((r) => fold(r.name ?? "").includes(q) || fold(r.rut ?? "").includes(q));
  console.log(`${hits.length} movement(s) for «${detail}»:\n`);
  console.log(`${pad("date", 11)} ${pad("dir", 4)} ${padL("pesos", 12)} ${pad("account", 20)} ${pad("category", 18)} ${pad("counterparty", 34)} ${pad("rut", 13)} comment / note`);
  for (const r of hits) {
    console.log(
      `${pad(r.occurred_on ?? r.notice_date, 11)} ${pad(r.kind === "incoming" ? "in" : "out", 4)} ${padL(clp(r.amount), 12)} ${pad(r.account, 20)} ${pad(categoryByMovement.get(r.movement_id) ?? "—", 18)} ${pad(r.name ?? "?", 34)} ${pad(r.rut ?? "", 13)} ${r.comment ? `«${r.comment}» ` : ""}${r.note ?? ""}`
    );
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------------------------
// 1. Link labels.
// ---------------------------------------------------------------------------------------------
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
for (const t of transferRows) add(rows, "transfer", t.bank ?? "", t.name ?? "", (t.name ?? "").trim());

const onlyFlagged = process.argv.includes("--flagged");
const list = [...rows.values()]
  .filter((r) => !onlyFlagged || r.flags.length > 0)
  .sort((a, b) => b.flags.length - a.flags.length || a.kind.localeCompare(b.kind) || b.count - a.count);

console.log("=== 1. Link labels ===\n");
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

// ---------------------------------------------------------------------------------------------
// 2. Transfer counterparties, grouped by RUT (or by folded name when the mail prints no RUT).
// ---------------------------------------------------------------------------------------------
type Party = {
  key: string;
  rut: string | null;
  names: Map<string, number>;
  banks: Set<string>;
  out: number;
  in: number;
  pesos: number;
  first: string;
  last: string;
  categories: Map<string, number>;
  comments: Set<string>;
};
const parties = new Map<string, Party>();
for (const r of transferRows) {
  const rut = r.rut?.replace(/[.\s]/g, "").toUpperCase() || null;
  const key = rut ? `rut:${rut}` : `name:${fold(r.name ?? "?")}`;
  let p = parties.get(key);
  if (!p) {
    p = { key, rut, names: new Map(), banks: new Set(), out: 0, in: 0, pesos: 0, first: r.notice_date, last: r.notice_date, categories: new Map(), comments: new Set() };
    parties.set(key, p);
  }
  const name = (r.name ?? "?").trim();
  p.names.set(name, (p.names.get(name) ?? 0) + 1);
  if (r.bank) p.banks.add(r.bank);
  if (r.kind === "incoming") p.in++;
  else p.out++;
  p.pesos += r.amount;
  if (r.notice_date < p.first) p.first = r.notice_date;
  if (r.notice_date > p.last) p.last = r.notice_date;
  const cat = categoryByMovement.get(r.movement_id);
  if (cat) p.categories.set(cat, (p.categories.get(cat) ?? 0) + 1);
  if (r.comment && p.comments.size < 3) p.comments.add(r.comment);
}
const top = <K,>(m: Map<K, number>, n: number) =>
  [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, c]) => `${k}${c > 1 ? `×${c}` : ""}`).join(", ");

console.log("\n=== 2. Transfer counterparties (by RUT; same RUT = one row) ===\n");
console.log(`${pad("rut", 13)} ${padL("out", 4)} ${padL("in", 4)} ${padL("pesos", 13)} ${pad("first", 11)} ${pad("last", 11)} ${pad("names (×count)", 60)} ${pad("categories", 32)} comments`);
for (const p of [...parties.values()].sort((a, b) => b.out + b.in - (a.out + a.in))) {
  console.log(
    `${pad(p.rut ?? "—", 13)} ${padL(String(p.out), 4)} ${padL(String(p.in), 4)} ${padL(clp(p.pesos), 13)} ${pad(p.first, 11)} ${pad(p.last, 11)} ${pad(top(p.names, 4), 60)} ${pad(top(p.categories, 3) || "—", 32)} ${[...p.comments].map((c) => `«${c}»`).join(" ")}`
  );
}
const multiName = [...parties.values()].filter((p) => p.names.size > 1);
console.log(`\n${parties.size} counterparties; ${multiName.length} RUT(s) written more than one way.`);

// ---------------------------------------------------------------------------------------------
// 3. Merchants as the bank prints them.
// ---------------------------------------------------------------------------------------------
type Merchant = { source: string; merchant: string; count: number; pesos: number; first: string; last: string; categories: Map<string, number> };
const merchants = new Map<string, Merchant>();
for (const l of lines) {
  if (l.source !== "cc" && l.source !== "checking") continue;
  const merchant = (l.merchant ?? "").trim();
  if (!merchant) continue;
  const key = `${l.source}|${merchant}`;
  const day = l.purchase_on ?? l.occurred_on;
  let m = merchants.get(key);
  if (!m) {
    m = { source: l.source, merchant, count: 0, pesos: 0, first: day, last: day, categories: new Map() };
    merchants.set(key, m);
  }
  m.count++;
  m.pesos += l.amount_clp;
  if (day < m.first) m.first = day;
  if (day > m.last) m.last = day;
  m.categories.set(l.category_slug, (m.categories.get(l.category_slug) ?? 0) + 1);
}
const limit = Number(arg("merchants") ?? 150);
console.log(`\n=== 3. Merchants as printed (top ${limit} by lines, of ${merchants.size}) ===\n`);
console.log(`${pad("source", 9)} ${padL("n", 5)} ${padL("pesos", 13)} ${pad("first", 11)} ${pad("last", 11)} ${pad("merchant", 40)} categories`);
for (const m of [...merchants.values()].sort((a, b) => b.count - a.count).slice(0, limit)) {
  console.log(
    `${pad(m.source, 9)} ${padL(String(m.count), 5)} ${padL(clp(m.pesos), 13)} ${pad(m.first, 11)} ${pad(m.last, 11)} ${pad(m.merchant, 40)} ${top(m.categories, 3)}`
  );
}

// Merchants that look like one vendor printed several ways: same first word (folded), 3+ spellings.
const byStem = new Map<string, Set<string>>();
for (const m of merchants.values()) {
  const stem = fold(m.merchant).replace(/[^a-z0-9 ]/g, " ").split(" ").filter(Boolean)[0];
  if (!stem || stem.length < 3) continue;
  const set = byStem.get(stem) ?? new Set<string>();
  set.add(m.merchant);
  byStem.set(stem, set);
}
const families = [...byStem].filter(([, s]) => s.size >= 3).sort((a, b) => b[1].size - a[1].size);
console.log(`\nMerchant families (same first word, 3+ spellings): ${families.length}`);
for (const [stem, set] of families.slice(0, 60)) {
  const sample = [...set].slice(0, 6).join(" | ");
  console.log(`  ${pad(stem, 14)} ${padL(String(set.size), 3)}  ${sample}${set.size > 6 ? " | …" : ""}`);
}
