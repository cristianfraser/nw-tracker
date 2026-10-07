/**
 * Dated legs for the dollar payments old international statements print only in their header.
 *
 *   npx tsx scripts/link-cc-usd-header-abono-legs.ts [--apply]
 *
 * A Santander international statement prints the period's payments as «ABONO REALIZADO» in its
 * header and, from 2018 on, as «ABONO DE DIVISAS» lines too; two ·0161 statements (2017-10-24,
 * −249,86; 2020-01-23, −78,40) print the header alone, so the owed walk never subtracted those
 * dollars and the month-end anchors after them disagreed with the walk by their pesos. For each
 * dollar statement whose header abono exceeds its negative lines (refunds count, the header nets
 * them; a «traspaso de deuda» leg does not, the header leaves it out) the gap becomes a dollar leg
 * (`cc_header_payment_legs`, migration 218):
 * - `bank_debit`: dated on the one checking «Compra de Divisas» debit in the period (after the
 *   previous close, up to this close) whose pesos ÷ the gap is a plausible rate, which the
 *   card-payment converter then pairs as a `pago_tarjeta` transfer;
 * - `pay_by`: no such debit (or several), dated on the previous statement's pay-by.
 * Report-first, IMMEDIATE; `--apply` writes. Then re-stamp the anchors (`restamp-cc-anchor-frame.ts`).
 */
import { db } from "../src/db.js";
import { parseDdMmYyToIso } from "../src/ccInstallmentPayBy.js";
import { convertCcPaymentMirrors, listCcPaymentMirrorCandidates } from "../src/ccPaymentMirrors.js";
import { accountIdsUnderCheckingAccounts } from "../src/movementBalanceCashAccounts.js";
import { clearAggregationCache } from "../src/aggregationCache.js";

const apply = process.argv.includes("--apply");
const FX_MIN = 300;
const FX_MAX = 2000;

type Stmt = { id: number; account_id: number; statement_date: string; pay_by: string | null; abono: number };

class Rollback extends Error {}
const tx = db.transaction(() => {
  const usdStatements = db
    .prepare(
      `SELECT id, account_id, statement_date, pay_by, abono FROM cc_statements
       WHERE currency = 'usd' AND source_pdf NOT LIKE 'import:web-paste%' ORDER BY account_id`
    )
    .all() as Stmt[];
  const iso = (d: string) => {
    const v = parseDdMmYyToIso(d);
    if (!v) throw new Error(`unreadable date ${d}`);
    return v;
  };
  const byAccount = new Map<number, Stmt[]>();
  for (const s of usdStatements) byAccount.set(s.account_id, [...(byAccount.get(s.account_id) ?? []), s]);
  for (const list of byAccount.values()) list.sort((a, b) => iso(a.statement_date).localeCompare(iso(b.statement_date)));

  const negLines = db.prepare(
    `SELECT COALESCE(SUM(amount_usd), 0) AS s FROM cc_statement_lines
     WHERE statement_id = ? AND amount_usd < 0 AND id NOT IN (SELECT usd_line_id FROM cc_traspaso_deuda_links)`
  );
  const hasLeg = db.prepare(`SELECT 1 FROM cc_header_payment_legs WHERE account_id = ? AND statement_close_iso = ? AND currency = 'usd'`);
  const checking = accountIdsUnderCheckingAccounts();
  const divisas = db.prepare(
    `SELECT id, account_id, occurred_on, -amount AS pesos FROM movements
     WHERE account_id IN (${checking.map(() => "?").join(",")}) AND from_account_id IS NULL AND flow_kind IS NULL
       AND amount < 0 AND note LIKE '%Compra de Divisas%' AND occurred_on > ? AND occurred_on <= ?`
  );
  const ins = db.prepare(
    `INSERT INTO cc_header_payment_legs (account_id, statement_close_iso, currency, paid_on, amount, source) VALUES (?, ?, 'usd', ?, ?, ?)`
  );
  const debitIds: number[] = [];
  let n = 0;
  for (const [account, list] of byAccount) {
    list.forEach((s, i) => {
      const header = -(s.abono ?? 0);
      const lines = -(negLines.get(s.id) as { s: number }).s;
      const gap = Math.round((header - lines) * 100) / 100;
      if (gap <= 0.005) return;
      const close = iso(s.statement_date);
      if (hasLeg.get(account, close)) return;
      const prev = list[i - 1];
      if (!prev) throw new Error(`card ${account} ${close}: a header abono of US$${gap} and no earlier statement to bound it`);
      const debits = (divisas.all(...checking, iso(prev.statement_date), close) as { id: number; account_id: number; occurred_on: string; pesos: number }[])
        .filter((d) => d.pesos / gap >= FX_MIN && d.pesos / gap <= FX_MAX);
      if (debits.length === 1) {
        const d = debits[0]!;
        ins.run(account, close, d.occurred_on, gap, "bank_debit");
        debitIds.push(d.id);
        console.log(`  card ${account} ${close}: US$${gap.toFixed(2)} → debit #${d.id} ${d.occurred_on} $${d.pesos} (${(d.pesos / gap).toFixed(1)} CLP/USD)`);
      } else {
        if (!prev.pay_by) throw new Error(`card ${account} ${close}: no pay-by on the previous statement`);
        const payBy = iso(prev.pay_by);
        ins.run(account, close, payBy, gap, "pay_by");
        console.log(`  card ${account} ${close}: US$${gap.toFixed(2)} → pay-by ${payBy} (${debits.length} divisas debits in the period)`);
      }
      n++;
    });
  }
  clearAggregationCache();
  const cands = listCcPaymentMirrorCandidates().filter((c) => debitIds.includes(c.out.movement_id));
  const blocked = cands.filter((c) => c.blocked);
  if (blocked.length) throw new Error(`blocked pairs: ${blocked.map((c) => c.out.movement_id).join(", ")}`);
  const { converted } = convertCcPaymentMirrors(
    cands.map((c) => ({ out_movement_id: c.out.movement_id, statement_line_id: c.evidence.statement_line_id, statement_id: c.evidence.statement_id }))
  );
  if (converted.length !== debitIds.length) throw new Error(`paired ${converted.length} of ${debitIds.length} divisas debits`);
  console.log(`${n} dollar leg(s); ${converted.length} divisas debit(s) paired as pago_tarjeta transfers`);
  if (!apply) throw new Rollback();
});

try {
  tx.immediate();
  console.log("applied");
} catch (e) {
  if (!(e instanceof Rollback)) throw e;
  console.log("report only — rolled back (pass --apply to write)");
}
