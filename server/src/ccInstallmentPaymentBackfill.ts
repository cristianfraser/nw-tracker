import { db } from "./db.js";

const SYNTH_PARSER_PREFIX = "synthetic:cuota-";

type PurchaseRow = {
  id: number;
  purchase_date: string;
  total_amount_clp: number;
  cuotas_totales: number;
};

type PaymentRow = {
  pay_by_date: string;
  amount_clp: number;
  cuota_current: number | null;
  cuota_total: number | null;
  parser_row_id: string | null;
};

function parseIsoDateUtcNoon(iso: string): number {
  const t = String(iso ?? "").trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (!m) return NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0, 0);
}

function formatIsoUtcMidnight(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
}

function interpolatePayBy(aIso: string, bIso: string, frac: number): string {
  const ta = parseIsoDateUtcNoon(aIso);
  const tb = parseIsoDateUtcNoon(bIso);
  if (!Number.isFinite(ta) || !Number.isFinite(tb) || ta >= tb) return aIso;
  const f = Math.min(0.999, Math.max(0.001, frac));
  return formatIsoUtcMidnight(Math.round(ta + (tb - ta) * f));
}

function medianPositive(nums: number[]): number {
  const a = nums.filter((n) => n > 0).sort((x, y) => x - y);
  if (a.length === 0) return 0;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 === 1 ? a[mid]! : Math.round((a[mid - 1]! + a[mid]!) / 2);
}

/**
 * Remove prior synthetic gap rows, then insert inferred payments for missing cuota indices
 * 1..M where M = max(non-null cuota_current) ≤ cuotas_totales, so the ledger reflects every
 * installment up to the last one seen on PDFs (e.g. only 3/3 present → backfill 1 and 2).
 */
export function backfillMissingInstallmentPaymentsForAccount(accountId: number): { inserted: number } {
  const delSynth = db.prepare(`
    DELETE FROM cc_installment_payments
    WHERE purchase_id IN (SELECT id FROM cc_installment_purchases WHERE account_id = ?)
      AND parser_row_id LIKE ?
  `);
  delSynth.run(accountId, `${SYNTH_PARSER_PREFIX}%`);

  const purchases = db
    .prepare(
      `SELECT id, purchase_date, total_amount_clp, cuotas_totales
       FROM cc_installment_purchases WHERE account_id = ? ORDER BY id`
    )
    .all(accountId) as PurchaseRow[];

  const selPay = db.prepare(
    `SELECT pay_by_date, amount_clp, cuota_current, cuota_total, parser_row_id
     FROM cc_installment_payments WHERE purchase_id = ? ORDER BY pay_by_date, id`
  );

  const ins = db.prepare(
    `INSERT INTO cc_installment_payments (
       purchase_id, pay_by_date, statement_date, source_pdf, amount_clp, cuota_current, cuota_total, parser_row_id
     ) VALUES (@purchase_id, @pay_by_date, @statement_date, @source_pdf, @amount_clp, @cuota_current, @cuota_total, @parser_row_id)`
  );

  let inserted = 0;

  for (const pr of purchases) {
    const rows = selPay.all(pr.id) as PaymentRow[];
    const byCuota = new Map<number, { pay_by_date: string; amount_clp: number }>();
    for (const r of rows) {
      const c = r.cuota_current;
      if (c == null || c <= 0) continue;
      const cur = byCuota.get(c);
      if (!cur || r.pay_by_date < cur.pay_by_date) {
        byCuota.set(c, { pay_by_date: r.pay_by_date, amount_clp: r.amount_clp });
      }
    }
    if (byCuota.size === 0) continue;

    const M = Math.min(pr.cuotas_totales, Math.max(...[...byCuota.keys()]));
    if (M <= 0) continue;

    const knownAmts = [...byCuota.values()].map((v) => v.amount_clp);
    let amt = medianPositive(knownAmts);
    if (amt <= 0) amt = Math.max(1, Math.round(pr.total_amount_clp / pr.cuotas_totales));

    const usedPayBy = new Set(rows.map((r) => r.pay_by_date));

    const sortedKeys = [...byCuota.keys()].sort((a, b) => a - b);

    const allocatePayBy = (proposed: string): string => {
      let d = proposed;
      let guard = 0;
      while (usedPayBy.has(d) && guard++ < 120) {
        const ms = parseIsoDateUtcNoon(d);
        d = formatIsoUtcMidnight(ms + 86400000);
      }
      usedPayBy.add(d);
      return d;
    };

    for (let k = 1; k <= M; k++) {
      if (byCuota.has(k)) continue;

      let prevK = 0;
      for (const x of sortedKeys) {
        if (x < k) prevK = x;
      }
      let nextK = M + 1;
      for (const x of sortedKeys) {
        if (x > k) {
          nextK = x;
          break;
        }
      }

      const purchaseIso = String(pr.purchase_date ?? "2000-01-01").trim();

      let payBy: string;
      if (prevK > 0 && nextK <= M) {
        const prevDate = byCuota.get(prevK)!.pay_by_date;
        const nextDate = byCuota.get(nextK)!.pay_by_date;
        const frac = (k - prevK) / (nextK - prevK);
        payBy = interpolatePayBy(prevDate, nextDate, frac);
      } else if (prevK === 0 && nextK <= M) {
        const frac = k / nextK;
        payBy = interpolatePayBy(purchaseIso, byCuota.get(nextK)!.pay_by_date, frac);
      } else if (prevK > 0 && nextK === M + 1) {
        const prevDate = byCuota.get(prevK)!.pay_by_date;
        const ta = parseIsoDateUtcNoon(prevDate);
        const span = M - prevK;
        const step = k - prevK;
        payBy = formatIsoUtcMidnight(ta + Math.round(86400000 * 31 * (step / Math.max(1, span))));
      } else {
        payBy = purchaseIso;
      }

      payBy = allocatePayBy(payBy);

      ins.run({
        purchase_id: pr.id,
        pay_by_date: payBy,
        statement_date: null,
        source_pdf: "synthetic-gap-fill",
        amount_clp: amt,
        cuota_current: k,
        cuota_total: pr.cuotas_totales,
        parser_row_id: `${SYNTH_PARSER_PREFIX}${k}`,
      });
      inserted += 1;
    }
  }

  return { inserted };
}
