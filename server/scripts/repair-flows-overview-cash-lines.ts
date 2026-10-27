/**
 * One-off data repair for the flows overview's cash identity (2026-10-27). Report-first; `--apply`
 * writes, in one IMMEDIATE transaction.
 *
 * 1. Card lines that move debt between the user's own cards are internal transfers, not spending
 *    (`checking_internal_transfer`), when they count toward gastos today:
 *    - «TRASPASO A DEUDA NACIONAL»: the peso leg of a debt reclassification, kept only when the
 *      same card prints its «TRASPASO DE DEUDA INTERNACIO…» leg for the same pesos on the same day;
 *    - «RECAUDACION …» (a Lider store's payment counter): the payment of another card's facturado,
 *      kept only when another card master has a closed statement whose «Monto facturado» is
 *      exactly the line's pesos, closed within 20 days before the line.
 *    Each is set through the app's own per-line category path (`assignFlowExpenseLineCategory`),
 *    the «Único» row a re-import carries onto the replacing line.
 * 2. Checking debits to Khipu («Transf a khipu …») that are payments of a card: converted through
 *    the card-payment mirror conversion (`convertCcPaymentMirrors`), only the unblocked candidates.
 *
 *   npx tsx scripts/repair-flows-overview-cash-lines.ts            # report
 *   npx tsx scripts/repair-flows-overview-cash-lines.ts --apply    # write
 */
import { assignFlowExpenseLineCategory } from "../src/assignFlowExpenseLineCategory.js";
import { CHECKING_INTERNAL_TRANSFER_CC_EXPENSE_SLUG } from "../src/ccExpenseCategories.js";
import { convertCcPaymentMirrors, listCcPaymentMirrorCandidates } from "../src/ccPaymentMirrors.js";
import { db } from "../src/db.js";
import { buildFlowsExpenseLines, listCreditCardMasterAccountIds } from "../src/flowsExpenses.js";
import { countsTowardGastosMes } from "../src/flowsExpensesGastos.js";
import { clearAggregationCache } from "../src/aggregationCache.js";

const apply = process.argv.includes("--apply");

type Retag = { lineId: number; accountId: number; day: string; merchant: string; amount: number; category: string; why: string };

function ddmmyyyyToIso(s: string): string {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s.trim());
  if (!m) throw new Error(`statement_date ${s}: not dd/mm/yyyy`);
  return `${m[3]}-${m[2]}-${m[1]}`;
}

function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
}

function planRetags(): Retag[] {
  const cards = listCreditCardMasterAccountIds();
  const lines = buildFlowsExpenseLines(cards);
  const ccLines = lines.filter((l) => l.source === "cc" && l.statement_line_id > 0);
  const statements = db
    .prepare(
      `SELECT account_id, statement_date, monto_facturado FROM cc_statements
       WHERE currency = 'clp' AND monto_facturado IS NOT NULL AND monto_facturado > 0
         AND source_pdf NOT LIKE 'import:web-paste%'`
    )
    .all() as { account_id: number; statement_date: string; monto_facturado: number }[];
  const out: Retag[] = [];
  for (const l of ccLines) {
    const counts = countsTowardGastosMes(l, "split") || countsTowardGastosMes(l, "total");
    if (!counts || l.amount_clp <= 0 || l.line_role !== "purchase") continue;
    const merchant = String(l.merchant ?? "").trim().toUpperCase();
    const day = String(l.purchase_on ?? "").slice(0, 10);
    if (/^TRASPASO A DEUDA NACIONAL\b/.test(merchant)) {
      const twins = ccLines.filter(
        (o) =>
          o.account_id === l.account_id &&
          String(o.purchase_on ?? "").slice(0, 10) === day &&
          o.amount_clp === -l.amount_clp &&
          /^TRASPASO DE DEUDA INTERNACIO/.test(String(o.merchant ?? "").trim().toUpperCase())
      );
      if (twins.length !== 1) {
        console.log(`  skip ${l.statement_line_id} ${day} ${merchant} ${l.amount_clp}: ${twins.length} international legs`);
        continue;
      }
      out.push({
        lineId: l.statement_line_id,
        accountId: l.account_id,
        day,
        merchant,
        amount: l.amount_clp,
        category: l.category_slug,
        why: `traspaso de deuda: international leg line ${twins[0]!.statement_line_id}`,
      });
      continue;
    }
    if (/^RECAUDACION\b/.test(merchant)) {
      const paid = statements.filter((s) => {
        if (s.account_id === l.account_id || Math.round(s.monto_facturado) !== l.amount_clp) return false;
        const gap = dayDiff(day, ddmmyyyyToIso(s.statement_date));
        return gap >= 0 && gap <= 20;
      });
      if (paid.length !== 1) {
        console.log(`  skip ${l.statement_line_id} ${day} ${merchant} ${l.amount_clp}: ${paid.length} facturados it could pay`);
        continue;
      }
      out.push({
        lineId: l.statement_line_id,
        accountId: l.account_id,
        day,
        merchant,
        amount: l.amount_clp,
        category: l.category_slug,
        why: `pays account ${paid[0]!.account_id}'s facturado of ${paid[0]!.statement_date}`,
      });
    }
  }
  return out;
}

const KHIPU_RE = /\bTRANSF\w*\.?\s+A\s+KHIPU\b/i;

const run = db.transaction(() => {
  const retags = planRetags();
  console.log(`Card lines to set to ${CHECKING_INTERNAL_TRANSFER_CC_EXPENSE_SLUG}: ${retags.length}`);
  for (const r of retags) {
    console.log(`  line ${r.lineId} acct ${r.accountId} ${r.day} ${r.merchant} ${r.amount} (was ${r.category}) — ${r.why}`);
  }
  const khipu = listCcPaymentMirrorCandidates().filter((c) => KHIPU_RE.test(c.out.note ?? ""));
  console.log(`Khipu card-payment pairs: ${khipu.length}`);
  for (const c of khipu) {
    console.log(
      `  movement ${c.out.movement_id} ${c.out.occurred_on} ${c.out.amount_clp} → card ${c.evidence.cc_account_id} ` +
        `${c.evidence.label} ${c.evidence.pago_iso} (line ${c.evidence.statement_line_id ?? "-"}, statement ${c.evidence.statement_id ?? "-"})` +
        (c.blocked ? ` BLOCKED: ${c.blocked_reason}` : "")
    );
  }
  if (!apply) return;
  for (const r of retags) {
    assignFlowExpenseLineCategory({
      lineId: r.lineId,
      source: "cc",
      unique: true,
      categorySlug: CHECKING_INTERNAL_TRANSFER_CC_EXPENSE_SLUG,
    });
  }
  const refs = khipu
    .filter((c) => !c.blocked)
    .map((c) => ({
      out_movement_id: c.out.movement_id,
      statement_line_id: c.evidence.statement_line_id,
      statement_id: c.evidence.statement_id,
    }));
  const { converted } = convertCcPaymentMirrors(refs);
  for (const c of converted) {
    console.log(`  converted movement ${c.out_movement_id} → transfer ${c.transfer_movement_id} (${c.occurred_on})`);
  }
  // Verify inside the transaction: every planned line now reads the internal-transfer category.
  clearAggregationCache();
  const after = new Map(
    buildFlowsExpenseLines(listCreditCardMasterAccountIds())
      .filter((l) => l.source === "cc")
      .map((l) => [l.statement_line_id, l])
  );
  for (const r of retags) {
    const l = after.get(r.lineId);
    if (!l || l.category_slug !== CHECKING_INTERNAL_TRANSFER_CC_EXPENSE_SLUG) {
      throw new Error(`line ${r.lineId} reads ${l?.category_slug ?? "missing"} after the write`);
    }
  }
  if (listCcPaymentMirrorCandidates().some((c) => KHIPU_RE.test(c.out.note ?? "") && !c.blocked)) {
    throw new Error("an unblocked Khipu pair is still a candidate after the conversion");
  }
});

run.immediate();
console.log(apply ? "Applied." : "Report only (pass --apply to write).");
