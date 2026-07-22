/**
 * Checking↔credit-card payment mirrors: converts a checking "Traspaso a T. Crédito"/PAGO
 * TARJETA debit plus the card's payment evidence into one transfer row, collapsing the
 * bank's posting-date skew (card credits the payment one to three days before the cartola
 * debits checking, which bumped the CC-netted cash bucket for the gap).
 *
 * The "in" side is statement evidence, never a movement: a PAGO/MONTO CANCELADO statement
 * line (legacy formats) or the statement's `monto_pagado_anterior` header (current format,
 * migration 166). The evidence stays untouched — the CC daily owed walk keeps reading it —
 * and the transfer's card leg is inert for CC valuation (CC balances never read movements).
 * The transfer takes the CARD's credit date (the immovable evidence side; the checking
 * cartola date is preserved as `out_occurred_on` in `movement_mirror_merges`, mirroring the
 * month-precision exception in movementMirrorConvert.ts).
 *
 * flow_kind `pago_tarjeta`: the transfer is internal to the CC-netted cash bucket (paying
 * your own card moves no wealth), so deposit/aportes readers skip it (accountDeposits.ts).
 */
import { invalidateAggregationForAccountDate, invalidateCcBillingDetail } from "./aggregationCache.js";
import { accountKindSlugForAccountId } from "./accountBucket.js";
import { clearCheckingBalanceCache } from "./checkingCartolaBalances.js";
import { CC_PAYMENT_DESC_RE } from "./checkingDescriptionPredicates.js";
import { parseDdMmYyToIso } from "./ccInstallmentPayBy.js";
import { db } from "./db.js";
import { FLOW_KIND_PAGO_TARJETA } from "./movementFlowType.js";

const MATCH_WINDOW_DAYS = 4;

export type CcPaymentEvidence = {
  cc_account_id: number;
  cc_account_name: string;
  /** Exactly one of these is set (statement line vs header payment). */
  statement_line_id: number | null;
  statement_id: number | null;
  pago_iso: string;
  /** Positive CLP amount of the payment. */
  amount_clp: number;
  label: string;
};

export type CcPaymentMirrorCandidate = {
  out: {
    movement_id: number;
    account_id: number;
    account_name: string;
    occurred_on: string;
    amount_clp: number;
    note: string | null;
  };
  evidence: CcPaymentEvidence;
  skew_days: number;
  blocked: boolean;
  blocked_reason: string | null;
};

export type CcPaymentMirrorRef = {
  out_movement_id: number;
  statement_line_id?: number | null;
  statement_id?: number | null;
};

function dayDiff(aIso: string, bIso: string): number {
  const a = Date.parse(`${aIso}T00:00:00Z`);
  const b = Date.parse(`${bIso}T00:00:00Z`);
  return Math.round((a - b) / 86_400_000);
}

function isoFromStatementDate(raw: string | null): string | null {
  const t = String(raw ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  return parseDdMmYyToIso(t);
}

/** Payment evidence across every CC master: PAGO lines + header payments, version-deduped. */
function listCcPaymentEvidence(): CcPaymentEvidence[] {
  const lineRows = db
    .prepare(
      `SELECT l.id AS line_id, s.account_id, a.name AS account_name,
              l.transaction_date, l.amount_clp, l.merchant
       FROM cc_statement_lines l
       JOIN cc_statements s ON s.id = l.statement_id
       JOIN accounts a ON a.id = s.account_id
       WHERE s.currency = 'clp' AND l.installment_flag = 0 AND l.amount_clp < 0
         AND (UPPER(l.merchant) LIKE '%CANCELADO%' OR UPPER(l.merchant) LIKE 'PAGO%')`
    )
    .all() as {
    line_id: number;
    account_id: number;
    account_name: string;
    transaction_date: string | null;
    amount_clp: number;
    merchant: string | null;
  }[];
  const headerRows = db
    .prepare(
      `SELECT s.id AS statement_id, s.account_id, a.name AS account_name,
              s.monto_pagado_anterior AS amt, s.monto_pagado_anterior_date AS pago_iso
       FROM cc_statements s
       JOIN accounts a ON a.id = s.account_id
       WHERE s.currency = 'clp'
         AND s.monto_pagado_anterior IS NOT NULL AND s.monto_pagado_anterior_date IS NOT NULL`
    )
    .all() as {
    statement_id: number;
    account_id: number;
    account_name: string;
    amt: number;
    pago_iso: string;
  }[];

  // One evidence entry per real-world payment: duplicate statement versions carry the same
  // line, and legacy statements describe the same payment as BOTH a line and a header —
  // dedupe by (account, date, amount) with lines preferred (the walk consumes them directly).
  const byKey = new Map<string, CcPaymentEvidence>();
  for (const r of lineRows) {
    const iso = isoFromStatementDate(r.transaction_date);
    if (!iso) continue;
    const amount = Math.round(Math.abs(r.amount_clp));
    if (amount === 0) continue;
    const key = `${r.account_id}|${iso}|${amount}`;
    if (byKey.has(key)) continue;
    byKey.set(key, {
      cc_account_id: r.account_id,
      cc_account_name: r.account_name,
      statement_line_id: r.line_id,
      statement_id: null,
      pago_iso: iso,
      amount_clp: amount,
      label: (r.merchant ?? "PAGO").trim(),
    });
  }
  for (const r of headerRows) {
    const amount = Math.round(Math.abs(r.amt));
    if (amount === 0) continue;
    const key = `${r.account_id}|${r.pago_iso}|${amount}`;
    if (byKey.has(key)) continue;
    byKey.set(key, {
      cc_account_id: r.account_id,
      cc_account_name: r.account_name,
      statement_line_id: null,
      statement_id: r.statement_id,
      pago_iso: r.pago_iso,
      amount_clp: amount,
      label: "MONTO CANCELADO",
    });
  }
  return [...byKey.values()];
}

function convertedEvidenceRefs(): { lineIds: Set<number>; statementIds: Set<number> } {
  const rows = db
    .prepare(
      `SELECT in_statement_line_id AS line_id, in_statement_id AS statement_id
       FROM movement_mirror_merges
       WHERE in_statement_line_id IS NOT NULL OR in_statement_id IS NOT NULL`
    )
    .all() as { line_id: number | null; statement_id: number | null }[];
  const lineIds = new Set<number>();
  const statementIds = new Set<number>();
  for (const r of rows) {
    if (r.line_id != null) lineIds.add(r.line_id);
    if (r.statement_id != null) statementIds.add(r.statement_id);
  }
  return { lineIds, statementIds };
}

/**
 * Candidates: single-leg checking debits whose note matches the card-payment description,
 * paired to payment evidence by exact amount within ±4 days (nearest date wins; ambiguity
 * blocks both sides — fail closed, never guess). Already-converted evidence is excluded.
 */
export function listCcPaymentMirrorCandidates(): CcPaymentMirrorCandidate[] {
  const movements = db
    .prepare(
      `SELECT m.id, m.account_id, a.name AS account_name, m.occurred_on, m.amount_clp, m.note
       FROM movements m
       JOIN accounts a ON a.id = m.account_id
       WHERE m.account_id IS NOT NULL AND m.from_account_id IS NULL AND m.to_account_id IS NULL
         AND m.flow_kind IS NULL AND m.amount_clp < 0
       ORDER BY m.occurred_on, m.id`
    )
    .all() as {
    id: number;
    account_id: number;
    account_name: string;
    occurred_on: string;
    amount_clp: number;
    note: string | null;
  }[];
  const outs = movements.filter(
    (m) =>
      accountKindSlugForAccountId(m.account_id) === "cuenta_corriente" &&
      m.note != null &&
      CC_PAYMENT_DESC_RE.test(m.note)
  );

  const converted = convertedEvidenceRefs();
  const evidence = listCcPaymentEvidence().filter(
    (e) =>
      (e.statement_line_id == null || !converted.lineIds.has(e.statement_line_id)) &&
      (e.statement_id == null || !converted.statementIds.has(e.statement_id))
  );
  const byAmount = new Map<number, CcPaymentEvidence[]>();
  for (const e of evidence) {
    const list = byAmount.get(e.amount_clp) ?? [];
    list.push(e);
    byAmount.set(e.amount_clp, list);
  }

  // Nearest-date matching, then bijectivity check: an evidence entry claimed by two
  // movements (or a movement with two equally-near evidence entries) blocks the pair.
  const picked: { out: (typeof outs)[number]; ev: CcPaymentEvidence; skew: number }[] = [];
  const ambiguous = new Set<number>();
  for (const out of outs) {
    const amount = Math.round(Math.abs(out.amount_clp));
    const near = (byAmount.get(amount) ?? [])
      .map((e) => ({ e, d: Math.abs(dayDiff(out.occurred_on, e.pago_iso)) }))
      .filter((x) => x.d <= MATCH_WINDOW_DAYS)
      .sort((a, b) => a.d - b.d);
    if (near.length === 0) continue;
    if (near.length > 1 && near[0]!.d === near[1]!.d) {
      ambiguous.add(out.id);
      picked.push({ out, ev: near[0]!.e, skew: near[0]!.d });
      continue;
    }
    picked.push({ out, ev: near[0]!.e, skew: near[0]!.d });
  }
  const evidenceClaims = new Map<string, number>();
  const evKey = (e: CcPaymentEvidence) => `${e.statement_line_id ?? ""}|${e.statement_id ?? ""}`;
  for (const p of picked) {
    evidenceClaims.set(evKey(p.ev), (evidenceClaims.get(evKey(p.ev)) ?? 0) + 1);
  }

  return picked.map((p) => {
    const multiClaim = (evidenceClaims.get(evKey(p.ev)) ?? 0) > 1;
    const isAmbiguous = ambiguous.has(p.out.id) || multiClaim;
    return {
      out: {
        movement_id: p.out.id,
        account_id: p.out.account_id,
        account_name: p.out.account_name,
        occurred_on: p.out.occurred_on,
        amount_clp: p.out.amount_clp,
        note: p.out.note,
      },
      evidence: p.ev,
      skew_days: dayDiff(p.out.occurred_on, p.ev.pago_iso),
      blocked: isAmbiguous,
      blocked_reason: isAmbiguous ? "ambiguous match (multiple pairs at equal distance)" : null,
    };
  });
}

export type ConvertedCcPaymentMirror = {
  transfer_movement_id: number;
  out_movement_id: number;
  from_account_id: number;
  to_account_id: number;
  occurred_on: string;
};

/**
 * Converts CC-payment pairs in one all-or-nothing transaction; every ref must be a current,
 * unblocked candidate. The checking leg is deleted (snapshotted in movement_mirror_merges);
 * the statement evidence is referenced, never touched.
 */
export function convertCcPaymentMirrors(refs: CcPaymentMirrorRef[]): {
  converted: ConvertedCcPaymentMirror[];
} {
  if (refs.length === 0) return { converted: [] };
  const insTransfer = db.prepare(
    `INSERT INTO movements (account_id, from_account_id, to_account_id, amount_clp, occurred_on, note, flow_kind)
     VALUES (NULL, ?, ?, ?, ?, ?, ?)`
  );
  const insMerge = db.prepare(
    `INSERT INTO movement_mirror_merges (
       transfer_movement_id,
       out_movement_id, out_occurred_on, out_amount_clp, out_units_delta, out_note,
       in_movement_id, in_statement_line_id, in_statement_id, in_occurred_on, in_amount_clp, in_note
     ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`
  );
  const delIncomeOverride = db.prepare(
    `DELETE FROM checking_income_movement_overrides WHERE movement_id = ?`
  );
  const delLeg = db.prepare(`DELETE FROM movements WHERE id = ?`);

  const run = db.transaction((requested: CcPaymentMirrorRef[]): ConvertedCcPaymentMirror[] => {
    const candidates = new Map(
      listCcPaymentMirrorCandidates().map((c) => [
        `${c.out.movement_id}|${c.evidence.statement_line_id ?? ""}|${c.evidence.statement_id ?? ""}`,
        c,
      ])
    );
    const converted: ConvertedCcPaymentMirror[] = [];
    for (const ref of requested) {
      const key = `${ref.out_movement_id}|${ref.statement_line_id ?? ""}|${ref.statement_id ?? ""}`;
      const cand = candidates.get(key);
      if (!cand) throw new Error(`cc payment mirror ${key}: not a current candidate`);
      if (cand.blocked) throw new Error(`cc payment mirror ${key}: ${cand.blocked_reason}`);

      const note = `Pago tarjeta espejo (cargo cuenta ${cand.out.occurred_on} → abono tarjeta ${cand.evidence.pago_iso})`;
      const r = insTransfer.run(
        cand.out.account_id,
        cand.evidence.cc_account_id,
        cand.evidence.amount_clp,
        cand.evidence.pago_iso,
        note,
        FLOW_KIND_PAGO_TARJETA
      );
      insMerge.run(
        Number(r.lastInsertRowid),
        cand.out.movement_id,
        cand.out.occurred_on,
        cand.out.amount_clp,
        null,
        cand.out.note,
        cand.evidence.statement_line_id,
        cand.evidence.statement_id,
        cand.evidence.pago_iso,
        -cand.evidence.amount_clp,
        cand.evidence.label
      );
      delIncomeOverride.run(cand.out.movement_id);
      delLeg.run(cand.out.movement_id);
      converted.push({
        transfer_movement_id: Number(r.lastInsertRowid),
        out_movement_id: cand.out.movement_id,
        from_account_id: cand.out.account_id,
        to_account_id: cand.evidence.cc_account_id,
        occurred_on: cand.evidence.pago_iso,
      });
    }
    return converted;
  });

  const converted = run(refs);
  for (const c of converted) {
    const merge = db
      .prepare(`SELECT out_occurred_on FROM movement_mirror_merges WHERE transfer_movement_id = ?`)
      .get(c.transfer_movement_id) as { out_occurred_on: string };
    const earliest = merge.out_occurred_on < c.occurred_on ? merge.out_occurred_on : c.occurred_on;
    clearCheckingBalanceCache(c.from_account_id);
    invalidateAggregationForAccountDate(c.from_account_id, earliest);
    invalidateAggregationForAccountDate(c.to_account_id, earliest);
    invalidateCcBillingDetail(c.to_account_id);
  }
  return { converted };
}
