/**
 * How each filed F22 was settled (`f22_settlements`): proposes, per tax year with a filed form, the
 * Tesorería's refund credit (a checking credit «DEV IMPUESTO» from April of the tax year, of the
 * refund the form states plus its inflation adjustment, at most 6 %) or the payment (a card line
 * «SII» / «F22 RENTA» / «TGR», or a checking debit, of exactly the amount the form says to pay, in
 * April–June). Report-first; --apply writes the unique proposals and every --extra.
 *
 *   npx tsx scripts/link-f22-settlements.ts [--extra=<year>:<refund|payment>:<account id>:<YYYY-MM-DD>:<pesos>[:<movement id>],…] [--apply]
 *
 * Descriptions are read here, once, to propose; the app reads the stored link.
 */
import { db } from "../src/db.js";
import { parseDdMmYyToIso } from "../src/ccInstallmentPayBy.js";

function isoDay(raw: string): string {
  const d = parseDdMmYyToIso(raw);
  if (!d) throw new Error(`not a dd/mm/yy date: ${raw}`);
  return d;
}

const apply = process.argv.includes("--apply");
const extras = (process.argv.find((a) => a.startsWith("--extra="))?.slice(8) ?? "").split(",").filter(Boolean);

type Link = { tax_year: number; kind: "refund" | "payment"; account_id: number; movement_id: number | null; occurred_on: string; amount: number; description: string };

const filed = db.prepare(`SELECT tax_year, code, amount FROM sii_f22_filed WHERE code IN (87, 91, 305)`).all() as {
  tax_year: number;
  code: number;
  amount: number;
}[];
const years = [...new Set(filed.map((r) => r.tax_year))].sort();
const code = (y: number, c: number) => filed.find((r) => r.tax_year === y && r.code === c)?.amount ?? null;

const proposals: Link[] = [];
const report: string[] = [];
for (const y of years) {
  const result = code(y, 305);
  if (result == null || result === 0) continue;
  if (result < 0) {
    const refund = code(y, 87) ?? -result;
    const rows = db
      .prepare(
        `SELECT id, account_id, occurred_on, amount, note FROM movements
          WHERE account_id IS NOT NULL AND amount BETWEEN ? AND ? AND occurred_on BETWEEN ? AND ?
            AND note LIKE '%DEV IMPUESTO%' ORDER BY occurred_on`
      )
      .all(refund, refund * 1.06, `${y}-04-01`, `${y}-12-31`) as { id: number; account_id: number; occurred_on: string; amount: number; note: string }[];
    if (rows.length === 1) {
      const r = rows[0]!;
      proposals.push({ tax_year: y, kind: "refund", account_id: r.account_id, movement_id: r.id, occurred_on: r.occurred_on, amount: r.amount, description: `Devolución de impuesto (Tesorería), F22 ${refund}` });
      report.push(`AT${y} refund ${refund} → movement ${r.id} ${r.occurred_on} ${r.amount} (adjustment ${r.amount - refund})`);
    } else report.push(`AT${y} refund ${refund}: ${rows.length} candidate(s) — use --extra`);
  } else {
    const pay = code(y, 91) ?? result;
    const card = db
      .prepare(
        `SELECT l.transaction_date, s.account_id, l.amount_clp, l.merchant FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id
          WHERE l.amount_clp = ? AND (l.merchant LIKE 'SII%' OR l.merchant LIKE 'F22%' OR l.merchant LIKE 'TGR%')`
      )
      .all(pay) as { transaction_date: string; account_id: number; amount_clp: number; merchant: string }[];
    const inWindow = [...new Map(card.map((c) => [`${c.account_id}|${isoDay(c.transaction_date)}`, c])).values()].filter((c) => {
      const d = isoDay(c.transaction_date);
      return d >= `${y}-04-01` && d <= `${y}-06-30`;
    });
    if (inWindow.length === 1) {
      const c = inWindow[0]!;
      const day = isoDay(c.transaction_date);
      proposals.push({ tax_year: y, kind: "payment", account_id: c.account_id, movement_id: null, occurred_on: day, amount: pay, description: `Pago F22 con tarjeta («${c.merchant}»)` });
      report.push(`AT${y} payment ${pay} → card account ${c.account_id} ${day}`);
    } else report.push(`AT${y} payment ${pay}: ${inWindow.length} card candidate(s) — use --extra`);
  }
}

for (const e of extras) {
  const [y, kind, account, day, pesos, movement] = e.split(":");
  if (kind !== "refund" && kind !== "payment") throw new Error(`--extra ${e}: kind must be refund or payment`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? "")) throw new Error(`--extra ${e}: bad date`);
  proposals.push({
    tax_year: Number(y),
    kind,
    account_id: Number(account),
    movement_id: movement ? Number(movement) : null,
    occurred_on: day!,
    amount: Number(pesos),
    description: kind === "refund" ? "Devolución de impuesto (indicada a mano)" : "Pago F22 (indicado a mano)",
  });
  report.push(`AT${y} ${kind} (extra) → account ${account} ${day} ${pesos}${movement ? ` movement ${movement}` : ""}`);
}

for (const line of report) console.log(line);
if (!apply) {
  console.log("report only — pass --apply to write");
  process.exit(0);
}
db.transaction(() => {
  const ins = db.prepare(
    `INSERT OR IGNORE INTO f22_settlements (tax_year, kind, account_id, movement_id, occurred_on, amount, description)
     VALUES (@tax_year, @kind, @account_id, @movement_id, @occurred_on, @amount, @description)`
  );
  for (const p of proposals) {
    if (p.movement_id != null) {
      const m = db.prepare(`SELECT account_id, amount, occurred_on FROM movements WHERE id = ?`).get(p.movement_id) as
        | { account_id: number; amount: number; occurred_on: string }
        | undefined;
      if (!m || m.account_id !== p.account_id || Math.abs(m.amount) !== p.amount || m.occurred_on !== p.occurred_on) {
        throw new Error(`AT${p.tax_year}: movement ${p.movement_id} is not ${p.account_id} ${p.occurred_on} ${p.amount}`);
      }
    }
    ins.run(p);
  }
})();
console.log(`written: ${proposals.length} link(s)`);
