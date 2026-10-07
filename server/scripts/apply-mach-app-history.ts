/**
 * Puts the MACH app's own movement list (July 2021 → March 2024, transcribed from its
 * «Movimientos» screen) into the MACH account that `build-mach-account-from-mails.ts` built from the
 * mails, which stop in early 2021.
 *
 *   npx tsx scripts/apply-mach-app-history.ts --plan=<plan.json>            # report (rolled back)
 *   npx tsx scripts/apply-mach-app-history.ts --plan=<plan.json> --apply
 *
 * The plan names the MACH account, the app's rows (`{date, kind, amount, who, category?,
 * big_group?}`) and the balance MACH held before the first one, which the walk proves: the app's
 * rows end at 0 only from that start. In one IMMEDIATE transaction (rolled back without --apply):
 * - every top-up (`card_load`), withdrawal to the corriente and wire from it must already be in the
 *   ledger: same pesos, the ledger's day 0–3 days after the app's. A transfer with the corriente
 *   moves to MACH's day and keeps the corriente's as its bank posting day there (after the 14:00
 *   cutoff the corriente posts the next business day);
 * - the stand-ins and the closing debit the mail build wrote after the first app row go — the app
 *   names what they stood for;
 * - each payment («Pago enviado»), card purchase and «Pago recibido» is written, payments as MACH
 *   debits in their category, «Pago recibido» as refunds in theirs; a big group when the plan names
 *   one;
 * - the balance before the first app row is one stand-in credit dated that day;
 * - the account never goes below zero and ends at exactly 0.
 */
import fs from "node:fs";
import { db } from "../src/db.js";
import { markCheckingExpenseRefund } from "../src/checkingExpenseRefunds.js";
import { assignFlowExpenseLineCategory } from "../src/assignFlowExpenseLineCategory.js";
import { checkingGastosMovementPurchaseKey } from "../src/flowsCheckingGastos.js";
import { setCcExpensePurchaseBigGroup } from "../src/ccExpenseBigGroups.js";
import { getCcExpenseCategoryBySlug } from "../src/ccExpenseCategories.js";
import { clearAggregationCache } from "../src/aggregationCache.js";
import { recordBankPosting } from "../src/movementBankPostings.js";
import { clearCheckingBalanceCache } from "../src/checkingCartolaBalances.js";

type Row = {
  date: string;
  kind: "card_load" | "withdrawal" | "wire_in" | "paid_to" | "paid_by" | "card_purchase";
  amount: number;
  who: string;
  category?: string;
  big_group?: string;
};
type Plan = { mach_account_id: number; rows_file: string; opening_balance: number };

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const planPath = args.find((a) => a.startsWith("--plan="))?.slice("--plan=".length);
if (!planPath) throw new Error("--plan=<plan.json> is required");
const plan = JSON.parse(fs.readFileSync(planPath, "utf8")) as Plan;
const rows = (JSON.parse(fs.readFileSync(plan.rows_file, "utf8")) as Row[]).slice().sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount);
const MACH = plan.mach_account_id;
const first = rows[0]!.date;
const fmt = (n: number) => Math.round(n).toLocaleString("es-CL"); // convention-ok: script console output
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

class Rollback extends Error {}
const report: string[] = [];
const say = (s: string) => report.push(s);

const tx = db.transaction(() => {
  // 1. Top-ups, withdrawals and wires: already in the ledger.
  const signed = `CASE WHEN account_id = @m THEN amount WHEN to_account_id = @m THEN amount ELSE -amount END`;
  const ledger = db
    .prepare(`SELECT id, occurred_on, ${signed} AS amt, note FROM movements WHERE @m IN (account_id, from_account_id, to_account_id) AND occurred_on >= @from ORDER BY occurred_on, id`)
    .all({ m: MACH, from: first }) as { id: number; occurred_on: string; amt: number; note: string | null }[];
  const claimed = new Set<number>();
  let redated = 0;
  for (const r of rows.filter((r) => r.kind === "card_load" || r.kind === "withdrawal" || r.kind === "wire_in")) {
    const hit = ledger.find((l) => !claimed.has(l.id) && l.amt === r.amount && l.occurred_on >= r.date && l.occurred_on <= addDays(r.date, 3) && !(l.note ?? "").startsWith("import:mach-mail|"));
    if (!hit) throw new Error(`app ${r.kind} ${r.date} ${r.amount} is not in the ledger`);
    claimed.add(hit.id);
    // A transfer with the corriente happened on MACH's day; the corriente posted it later (after
    // the bank's cutoff), which stays as its posting day there.
    if (r.kind !== "card_load" && hit.occurred_on !== r.date) {
      const t = db.prepare(`SELECT from_account_id, to_account_id FROM movements WHERE id = ?`).get(hit.id) as { from_account_id: number; to_account_id: number };
      const bank = t.from_account_id === MACH ? t.to_account_id : t.from_account_id;
      db.prepare(`UPDATE movements SET occurred_on = ? WHERE id = ?`).run(r.date, hit.id);
      recordBankPosting(hit.id, bank, hit.occurred_on);
      redated++;
    }
  }
  say(`${claimed.size} top-ups / withdrawals / wires: all in the ledger already; ${redated} re-dated to MACH's day (the corriente's day kept as its posting)`);

  // 2. What the mail build guessed after the first app row goes.
  const guesses = ledger.filter((l) => /^import:mach-mail\|(?:standin|closing)\|/.test(l.note ?? ""));
  for (const g of guesses) {
    db.prepare(`DELETE FROM cc_expense_unique_purchases WHERE account_id = ? AND purchase_key = ?`).run(MACH, checkingGastosMovementPurchaseKey(g.id));
    db.prepare(`DELETE FROM movements WHERE id = ?`).run(g.id);
    say(`  removed ${g.occurred_on} ${fmt(g.amt).padStart(9)}  ${g.note}`);
  }
  const unexplained = ledger.filter((l) => !claimed.has(l.id) && !guesses.includes(l));
  if (unexplained.length) throw new Error(`ledger rows the app does not list: ${unexplained.map((l) => `${l.id} ${l.occurred_on} ${l.amt}`).join("; ")}`);

  // 3. The app's own rows.
  const ins = db.prepare(`INSERT INTO movements (account_id, amount, currency, occurred_on, note) VALUES (?, ?, 'clp', ?, ?)`);
  const label: Record<string, string> = { paid_to: "Pago enviado a", paid_by: "Pago recibido de", card_purchase: "Compra" };
  let written = 0;
  for (const r of rows.filter((r) => r.kind === "paid_to" || r.kind === "paid_by" || r.kind === "card_purchase")) {
    const cat = r.category ?? "unclassified";
    if (!getCcExpenseCategoryBySlug(cat)) throw new Error(`unknown category ${cat}`);
    const id = Number(ins.run(MACH, r.amount, r.date, `import:mach-mail|app|${label[r.kind]} ${r.who}`).lastInsertRowid);
    if (r.kind === "paid_by") markCheckingExpenseRefund(id, cat);
    else if (cat !== "unclassified") assignFlowExpenseLineCategory({ lineId: id, source: "checking", unique: true, categorySlug: cat });
    if (r.big_group) setCcExpensePurchaseBigGroup({ accountId: MACH, purchaseKey: checkingGastosMovementPurchaseKey(id), groupSlug: r.big_group });
    written++;
  }
  say(`${written} payments, purchases and «Pago recibido» written`);

  // 4. The balance before the first app row.
  if (plan.opening_balance > 0) {
    const id = Number(ins.run(MACH, plan.opening_balance, first, `import:mach-mail|standin|Saldo previo a ${first} (no registrado)`).lastInsertRowid);
    markCheckingExpenseRefund(id, "unclassified");
    say(`stand-in: ${fmt(plan.opening_balance)} on ${first}, the balance before the first app row`);
  }

  // 5. Never below zero, 0 at the end.
  const walk = db
    .prepare(`SELECT occurred_on, SUM(${signed}) OVER (ORDER BY occurred_on, ${signed} DESC, id) AS bal FROM movements WHERE @m IN (account_id, from_account_id, to_account_id) ORDER BY occurred_on, ${signed} DESC, id`)
    .all({ m: MACH }) as { occurred_on: string; bal: number }[];
  const low = Math.min(...walk.map((w) => w.bal));
  const final = walk.at(-1)!.bal;
  if (low < 0 || final !== 0) throw new Error(`MACH walk: lowest ${low}, final ${final}`);
  say(`MACH: never below zero, ${fmt(final)} at the end (${walk.at(-1)!.occurred_on})`);
  clearCheckingBalanceCache();
  clearAggregationCache();
  for (const s of report) console.log(s);
  if (!apply) throw new Rollback();
});

try {
  tx.immediate();
  console.log("applied");
} catch (e) {
  if (!(e instanceof Rollback)) throw e;
  console.log("report only — rolled back (pass --apply to write)");
}
