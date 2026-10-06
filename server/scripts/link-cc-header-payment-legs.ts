/**
 * One-time surgery: date the header payments («monto pagado período anterior») that card statements
 * print without a date, from the bank debits that paid them, and pair those debits with the card.
 *
 * The parser dates a header payment only when exactly one body line carries it, so a period paid in
 * several transfers, or by a debit the card printed no line for, stays undated — and the cuota
 * retirement, which reads dated payments only, then saw those facturaciones as unpaid and retired
 * later cuotas months late (·0161, 2023). For each undated header: the dated payment lines inside
 * its period (previous close, close] — counted once, a statement's card groups repeat them — leave
 * a remainder; when unlinked card-payment debits on the checking accounts (previous close, close + 4
 * days] add up to it exactly, each becomes a leg (`cc_header_payment_legs`, source bank_debit) and
 * the ordinary pairing converts it into a `pago_tarjeta` transfer. A remainder a credit note in the
 * period explains (BCI counts a nota de crédito in its «monto pagado») needs nothing. A remainder
 * with no debit at all in the period gets one leg dated at the previous facturación's pay-by
 * (source pay_by): the 2019-07..12 cuenta corriente cartolas are lost. Anything else is reported
 * and left alone.
 *
 * One IMMEDIATE transaction; every header's lines + legs must equal it, every checking statement
 * month must still reconcile, and without --apply everything is rolled back, so the report IS the
 * plan. A second run finds nothing to do.
 *
 *   npx tsx scripts/link-cc-header-payment-legs.ts            # report only
 *   npx tsx scripts/link-cc-header-payment-legs.ts --apply
 */
import { db } from "../src/db.js";
import { parseDdMmYyToIso, normalizeTransactionDateIso } from "../src/ccInstallmentPayBy.js";
import { isCcPaymentMerchant } from "../src/ccPaymentLines.js";
import { chileCalendarAddDays } from "../src/chileDate.js";
import { listCreditCardMasterAccountIds } from "../src/creditCardTree.js";
import { accountIdsUnderCheckingAccounts } from "../src/movementBalanceCashAccounts.js";
import { CC_PAYMENT_DESC_RE } from "../src/checkingDescriptionPredicates.js";
import { convertCcPaymentMirrors, listCcPaymentMirrorCandidates } from "../src/ccPaymentMirrors.js";
import { checkingMovementBalanceAtMonthEnd, clearCheckingBalanceCache } from "../src/checkingCartolaBalances.js";
import { clearAggregationCache } from "../src/aggregationCache.js";

const apply = process.argv.includes("--apply");
const LINEA_RE = /A\s+L[IÍ]NEA\s+CR[EÉ]DITO/i;
const DIVISAS_RE = /DIVISAS/i;
const MAX_SUBSET = 14;

class Rollback extends Error {}

const nameOf = (id: number) =>
  (db.prepare(`SELECT name FROM accounts WHERE id = ?`).get(id) as { name: string }).name;

type Debit = { id: number; acct: number; iso: string; clp: number };
type Leg = { account_id: number; close: string; paid_on: string; amount: number; source: "bank_debit" | "pay_by"; debit?: Debit };

function exactSubset<T extends { clp: number }>(items: T[], target: number): T[] | null {
  const n = Math.min(items.length, MAX_SUBSET);
  for (let mask = 1; mask < 1 << n; mask++) {
    let t = 0;
    const pick: T[] = [];
    for (let j = 0; j < n; j++) {
      if (mask & (1 << j)) {
        t += items[j]!.clp;
        pick.push(items[j]!);
      }
    }
    if (t === target) return pick;
  }
  return null;
}

function checkingMonthsOff(): string[] {
  const off: string[] = [];
  for (const acc of accountIdsUnderCheckingAccounts()) {
    clearCheckingBalanceCache(acc);
    const rows = db
      .prepare(`SELECT period_month, saldo_final_clp FROM checking_cartola_imports WHERE account_id = ?`)
      .all(acc) as { period_month: string; saldo_final_clp: number }[];
    for (const r of rows) {
      if (Math.round(checkingMovementBalanceAtMonthEnd(acc, r.period_month)) !== Math.round(r.saldo_final_clp)) {
        off.push(`${nameOf(acc)} ${r.period_month}`);
      }
    }
  }
  return off;
}

const checkingIds = accountIdsUnderCheckingAccounts();
const debits: Debit[] = (
  db
    .prepare(
      `SELECT id, account_id, occurred_on, amount, note FROM movements
       WHERE account_id IN (${checkingIds.join(",")}) AND currency = 'clp' AND amount < 0
         AND flow_kind IS NULL AND from_account_id IS NULL AND to_account_id IS NULL`
    )
    .all() as { id: number; account_id: number; occurred_on: string; amount: number; note: string | null }[]
)
  .filter((d) => d.note && CC_PAYMENT_DESC_RE.test(d.note) && !LINEA_RE.test(d.note) && !DIVISAS_RE.test(d.note))
  .map((d) => ({ id: d.id, acct: d.account_id, iso: d.occurred_on, clp: -Math.round(d.amount) }));

const tx = db.transaction(() => {
  const offBefore = checkingMonthsOff();
  if (offBefore.length > 0) throw new Error(`checking months already off before the surgery: ${offBefore.join(", ")}`);

  const legs: Leg[] = [];
  const used = new Set<number>();
  const unresolved: string[] = [];
  for (const acc of listCreditCardMasterAccountIds()) {
    const sts = db
      .prepare(
        `SELECT statement_date, pay_by, monto_pagado_anterior h, monto_pagado_anterior_date d FROM cc_statements
         WHERE account_id = ? AND currency = 'clp' AND source_pdf NOT LIKE 'import:web-paste%'`
      )
      .all(acc) as { statement_date: string; pay_by: string | null; h: number | null; d: string | null }[];
    const byClose = new Map<string, { hdr: number | null; date: string | null; payBy: string | null }>();
    for (const r of sts) {
      const c = parseDdMmYyToIso(r.statement_date);
      if (!c) throw new Error(`card ${acc}: unreadable statement date ${r.statement_date}`);
      const cur = byClose.get(c);
      if (!cur || (cur.hdr == null && r.h != null)) {
        byClose.set(c, { hdr: r.h, date: r.d, payBy: r.pay_by ? parseDdMmYyToIso(r.pay_by) : null });
      }
    }
    const closes = [...byClose.keys()].sort();
    const lineRows = db
      .prepare(
        `SELECT l.merchant, l.amount_clp, l.transaction_date, l.posting_date FROM cc_statement_lines l
         JOIN cc_statements s ON s.id = l.statement_id
         WHERE s.account_id = ? AND s.currency = 'clp' AND l.amount_clp < 0 AND l.installment_flag = 0`
      )
      .all(acc) as { merchant: string | null; amount_clp: number; transaction_date: string | null; posting_date: string | null }[];
    const seen = new Set<string>();
    const lines = lineRows
      .map((l) => ({
        payment: isCcPaymentMerchant(l.merchant),
        iso: normalizeTransactionDateIso(l.transaction_date ?? l.posting_date),
        clp: -Math.round(l.amount_clp),
        merchant: l.merchant ?? "",
      }))
      .filter((l): l is typeof l & { iso: string } => l.iso != null)
      .filter((l) => {
        const k = `${l.payment}|${l.merchant}|${l.iso}|${l.clp}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });

    for (let i = 0; i < closes.length; i++) {
      const close = closes[i]!;
      const s = byClose.get(close)!;
      if (!s.hdr || s.date) continue;
      const prev = i > 0 ? closes[i - 1]! : "0000-01-01";
      const header = Math.abs(Math.round(s.hdr));
      const inPeriod = lines.filter((l) => l.iso > prev && l.iso <= close);
      const dated = inPeriod.filter((l) => l.payment).reduce((t, l) => t + l.clp, 0);
      const missing = header - dated;
      if (missing <= 0) continue;
      const cands = debits.filter((d) => !used.has(d.id) && d.iso > prev && d.iso <= chileCalendarAddDays(close, 4));
      const pick = exactSubset(cands, missing);
      if (pick) {
        for (const d of pick) {
          used.add(d.id);
          legs.push({ account_id: acc, close, paid_on: d.iso, amount: d.clp, source: "bank_debit", debit: d });
        }
        continue;
      }
      const credits = inPeriod.filter((l) => !l.payment);
      if (exactSubset(credits, missing)) {
        console.log(`  ${nameOf(acc)} ${close}: ${missing} of the header is a credit note in the period — nothing to link`);
        continue;
      }
      const prevPayBy = i > 0 ? byClose.get(closes[i - 1]!)!.payBy : null;
      if (cands.length === 0 && prevPayBy) {
        legs.push({ account_id: acc, close, paid_on: prevPayBy, amount: missing, source: "pay_by" });
        continue;
      }
      unresolved.push(`${nameOf(acc)} ${close}: header ${header}, dated lines ${dated}, ${missing} unexplained`);
    }
  }

  const insLeg = db.prepare(
    `INSERT INTO cc_header_payment_legs (account_id, statement_close_iso, paid_on, amount_clp, source)
     VALUES (?, ?, ?, ?, ?)`
  );
  for (const leg of legs) {
    insLeg.run(leg.account_id, leg.close, leg.paid_on, leg.amount, leg.source);
    console.log(
      `  ${nameOf(leg.account_id)} ${leg.close}: leg ${leg.paid_on} ${leg.amount} (${leg.source}` +
        (leg.debit ? `, debit #${leg.debit.id} ${nameOf(leg.debit.acct)}` : "") +
        ")"
    );
  }
  for (const u of unresolved) console.log(`  UNRESOLVED ${u}`);
  clearAggregationCache();

  const debitIds = new Set(legs.flatMap((l) => (l.debit ? [l.debit.id] : [])));
  const cands = listCcPaymentMirrorCandidates().filter((c) => debitIds.has(c.out.movement_id));
  const bad = cands.filter((c) => c.blocked || c.skew_days !== 0);
  if (bad.length > 0 || cands.length !== debitIds.size) {
    throw new Error(
      `pairing: ${cands.length} of ${debitIds.size} debits are candidates` +
        (bad.length ? `; not clean: ${bad.map((c) => `#${c.out.movement_id} ${c.blocked_reason ?? `skew ${c.skew_days}`}`).join(", ")}` : "")
    );
  }
  const { converted } = convertCcPaymentMirrors(
    cands.map((c) => ({
      out_movement_id: c.out.movement_id,
      statement_line_id: c.evidence.statement_line_id,
      statement_id: c.evidence.statement_id,
    }))
  );
  const offAfter = checkingMonthsOff();
  if (offAfter.length > 0) throw new Error(`checking months off after the surgery: ${offAfter.join(", ")}`);
  console.log(
    `\n${legs.length} leg(s) (${legs.filter((l) => l.source === "bank_debit").length} bank debits, ` +
      `${legs.filter((l) => l.source === "pay_by").length} at a pay-by), ${converted.length} payment(s) paired, ` +
      `${unresolved.length} unresolved; every checking statement month reconciles`
  );
  if (!apply) throw new Rollback();
});

try {
  tx.immediate();
  console.log("applied");
} catch (e) {
  if (!(e instanceof Rollback)) throw e;
  console.log("report only — rolled back (pass --apply to write)");
}
