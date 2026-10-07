/**
 * Estimates the dollar side of facturaciones whose international statement is missing or unreadable.
 *
 *   npx tsx scripts/estimate-cc-missing-usd-statements.ts --plan=<plan.json> [--apply]
 *
 * ·0161's dollar statements of 2017-07, 2017-08 and 2018-10 were never mailed (the peso ones were),
 * and those of 2020-01..03 are scans with no text layer whose OCR'd headers do not add up. The
 * balances either side are printed (the next statement's «saldo anterior facturado», the previous
 * one's «deuda total»), and the checking debits that bought the dollars («Egreso por Compra de
 * Divisas») are on file, so the gap is estimated, not guessed:
 * - `missing`: a statement written as `import:estimate|<close> estado de cuenta tarjeta usd <last4>`,
 *   header from the plan (saldo anterior, abono, compras, deuda = facturado), one estimated charge
 *   line («COMPRAS INTERNACIONALES (ESTIMADO)») and an «ABONO DE DIVISAS» line per payment the plan
 *   names; its debit is then paired by the card-payment converter;
 * - `fix`: a stored statement whose header and lines the plan corrects — header fields set, an
 *   estimated charge line added, dollar header legs (`cc_header_payment_legs`, migration 218) for
 *   its payments, the dated ones paired with their debit.
 * Every statement must satisfy saldo anterior + compras + abono = deuda, and its lines compras +
 * abono, to the cent. A payment's dollars are the debit's pesos at the plan's rate (the day's
 * dólar × the divisas spread). Report-first, IMMEDIATE; then re-stamp the anchors.
 */
import fs from "node:fs";
import { db } from "../src/db.js";
import { convertCcPaymentMirrors, listCcPaymentMirrorCandidates } from "../src/ccPaymentMirrors.js";
import { clearAggregationCache } from "../src/aggregationCache.js";

type Payment = { date: string; usd: number; debit_id: number | null };
type Header = { saldo_anterior: number; abono: number; compras_cargos: number; deuda_total: number };
type Plan = {
  account_id: number;
  missing: {
    close: string;
    period_from: string;
    pay_by: string;
    card_last4: string;
    header: Header;
    charge: { date: string; usd: number };
    payments: Payment[];
  }[];
  fix: {
    statement_id: number;
    header: Partial<Header>;
    charge: { date: string; usd: number } | null;
    legs: Payment[];
  }[];
};

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const planPath = args.find((a) => a.startsWith("--plan="))?.slice("--plan=".length);
if (!planPath) throw new Error("--plan=<plan.json> is required");
const plan = JSON.parse(fs.readFileSync(planPath, "utf8")) as Plan;

const cents = (n: number) => Math.round(n * 100);
const ddmmyyyy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const ESTIMATE = "COMPRAS INTERNACIONALES (ESTIMADO)";

function assertHeader(where: string, h: Header): void {
  if (cents(h.saldo_anterior) + cents(h.compras_cargos) + cents(h.abono) !== cents(h.deuda_total)) {
    throw new Error(`${where}: ${h.saldo_anterior} + ${h.compras_cargos} + ${h.abono} ≠ ${h.deuda_total}`);
  }
}

class Rollback extends Error {}
const tx = db.transaction(() => {
  const acc = plan.account_id;
  const insLine = db.prepare(
    `INSERT INTO cc_statement_lines (statement_id, transaction_date, posting_date, merchant, description_merged, country,
       amount_orig, orig_currency, amount_clp, amount_usd, installment_flag, nro_cuota_current, nro_cuota_total,
       valor_cuota_mensual_clp, dedupe_key, parser_row_id, raw_line, origin_card_last4)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, 0, ?, 0, 0, 0, 0, ?, ?, ?, ?)`
  );
  const debitIds: number[] = [];

  for (const m of plan.missing) {
    assertHeader(`missing ${m.close}`, m.header);
    const paid = m.payments.reduce((s, p) => s + cents(p.usd), 0);
    if (cents(m.charge.usd) !== cents(m.header.compras_cargos) || -paid !== cents(m.header.abono)) {
      throw new Error(`missing ${m.close}: lines (${m.charge.usd} / −${paid / 100}) ≠ header (${m.header.compras_cargos} / ${m.header.abono})`);
    }
    const source = `import:estimate|${m.close} estado de cuenta tarjeta usd ${m.card_last4}`;
    if (db.prepare(`SELECT 1 FROM cc_statements WHERE account_id = ? AND source_pdf = ?`).get(acc, source)) {
      throw new Error(`${source} already exists`);
    }
    const id = Number(
      db.prepare(
        `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, period_from, period_to, pay_by,
           card_last4, layout, currency, saldo_anterior, abono, compras_cargos, deuda_total, monto_facturado)
         VALUES (?, 'INTL', ?, ?, ?, ?, ?, ?, 'international_usd', 'usd', ?, ?, ?, ?, ?)`
      ).run(acc, source, ddmmyyyy(m.close), ddmmyyyy(m.period_from), ddmmyyyy(m.close), ddmmyyyy(m.pay_by), m.card_last4,
        m.header.saldo_anterior, m.header.abono, m.header.compras_cargos, m.header.deuda_total, m.header.deuda_total).lastInsertRowid
    );
    const key = `estimate|${m.close}|charge`;
    insLine.run(id, ddmmyyyy(m.charge.date), ddmmyyyy(m.charge.date), ESTIMATE, ESTIMATE, m.charge.usd, key, key,
      `estimado: deuda ${m.header.deuda_total} − saldo anterior ${m.header.saldo_anterior} + abonos ${-m.header.abono}`, m.card_last4);
    m.payments.forEach((p, i) => {
      const k = `estimate|${m.close}|abono|${i}`;
      insLine.run(id, ddmmyyyy(p.date), ddmmyyyy(p.date), "ABONO DE DIVISAS", "ABONO DE DIVISAS", -p.usd, k, k,
        `estimado: compra de divisas${p.debit_id != null ? ` #${p.debit_id}` : ""}`, m.card_last4);
      if (p.debit_id != null) debitIds.push(p.debit_id);
    });
    console.log(`  ${m.close}: statement ${id} written — ${m.header.saldo_anterior} + ${m.header.compras_cargos} ${m.header.abono} = ${m.header.deuda_total}`);
  }

  for (const f of plan.fix) {
    const s = db
      .prepare(`SELECT id, account_id, statement_date, card_last4, saldo_anterior, abono, compras_cargos, deuda_total FROM cc_statements WHERE id = ? AND currency = 'usd'`)
      .get(f.statement_id) as ({ id: number; account_id: number; statement_date: string; card_last4: string } & Header) | undefined;
    if (!s || s.account_id !== acc) throw new Error(`statement ${f.statement_id} is not a dollar statement of account ${acc}`);
    const header: Header = { ...s, ...f.header };
    assertHeader(`statement ${s.id} ${s.statement_date}`, header);
    db.prepare(`UPDATE cc_statements SET saldo_anterior = ?, abono = ?, compras_cargos = ?, deuda_total = ? WHERE id = ?`)
      .run(header.saldo_anterior, header.abono, header.compras_cargos, header.deuda_total, s.id);
    if (f.charge) {
      const key = `estimate|${s.statement_date}|charge`;
      insLine.run(s.id, ddmmyyyy(f.charge.date), ddmmyyyy(f.charge.date), ESTIMATE, ESTIMATE, f.charge.usd, key, key,
        "estimado: el escaneo no muestra estas compras (compras impresas − líneas)", s.card_last4);
    }
    const closeIso = `${s.statement_date.slice(6)}-${s.statement_date.slice(3, 5)}-${s.statement_date.slice(0, 2)}`;
    for (const p of f.legs) {
      db.prepare(`INSERT INTO cc_header_payment_legs (account_id, statement_close_iso, currency, paid_on, amount, source) VALUES (?, ?, 'usd', ?, ?, ?)`)
        .run(acc, closeIso, p.date, p.usd, p.debit_id != null ? "bank_debit" : "pay_by");
      if (p.debit_id != null) debitIds.push(p.debit_id);
    }
    const lines = db.prepare(`SELECT COALESCE(SUM(amount_usd), 0) AS s FROM cc_statement_lines WHERE statement_id = ? AND amount_usd > 0`).get(s.id) as { s: number };
    const legs = db.prepare(`SELECT COALESCE(SUM(amount), 0) AS s FROM cc_header_payment_legs WHERE account_id = ? AND statement_close_iso = ? AND currency = 'usd'`).get(acc, closeIso) as { s: number };
    const negLines = db.prepare(`SELECT COALESCE(SUM(amount_usd), 0) AS s FROM cc_statement_lines WHERE statement_id = ? AND amount_usd < 0`).get(s.id) as { s: number };
    if (cents(lines.s) !== cents(header.compras_cargos) || cents(negLines.s) - cents(legs.s) !== cents(header.abono)) {
      throw new Error(`statement ${s.id}: charges ${lines.s} vs ${header.compras_cargos}, payments ${negLines.s} − legs ${legs.s} vs ${header.abono}`);
    }
    console.log(`  statement ${s.id} ${s.statement_date}: header ${JSON.stringify(f.header)}; ${f.charge ? `estimated charge ${f.charge.usd}; ` : ""}${f.legs.length} leg(s)`);
  }

  clearAggregationCache();
  const cands = listCcPaymentMirrorCandidates().filter((c) => debitIds.includes(c.out.movement_id));
  const blocked = cands.filter((c) => c.blocked);
  if (blocked.length) throw new Error(`blocked pairs: ${blocked.map((c) => c.out.movement_id).join(", ")}`);
  const { converted } = convertCcPaymentMirrors(
    cands.map((c) => ({ out_movement_id: c.out.movement_id, statement_line_id: c.evidence.statement_line_id, statement_id: c.evidence.statement_id }))
  );
  if (converted.length !== debitIds.length) {
    const got = new Set(converted.map((c) => c.out_movement_id));
    throw new Error(`paired ${converted.length} of ${debitIds.length} divisas debits; unpaired ${debitIds.filter((d) => !got.has(d)).join(", ")}`);
  }
  console.log(`${plan.missing.length} statement(s) estimated, ${plan.fix.length} corrected; ${converted.length} divisas debit(s) paired`);
  if (!apply) throw new Rollback();
});

try {
  tx.immediate();
  console.log("applied");
} catch (e) {
  if (!(e instanceof Rollback)) throw e;
  console.log("report only — rolled back (pass --apply to write)");
}
