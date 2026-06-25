import { ymCompare } from "./calendarMonth.js";
import { recomputeCcBillingMonthBalances } from "./ccBillingBalances.js";
import { parseDdMmYyToIso } from "./ccInstallmentPayBy.js";
import {
  billingMonthForManualLedgerPurchase,
  periodToIsoForBillingMonth,
  statementCloseDdMmYyyyForBillingMonth,
} from "./ccManualBillingMonth.js";
import { db } from "./db.js";
import { listCcStatementLinesForStatement, listCcStatementsForAccount } from "./ccStatementsDb.js";
import { creditCardMasterMetaForAccount } from "./ccWebPasteParse.js";

export const OPEN_WEB_PASTE_SOURCE_PREFIX = "import:web-paste|open|";

export function openWebPasteSourcePdf(billingMonth: string): string {
  return `${OPEN_WEB_PASTE_SOURCE_PREFIX}${billingMonth}`;
}

export function parseOpenWebPasteBillingMonth(sourcePdf: string): string | null {
  const m = /^import:web-paste\|open\|(\d{4}-\d{2})$/.exec(String(sourcePdf ?? "").trim());
  return m?.[1] ?? null;
}

function linePurchaseIso(transaction_date: string | null, posting_date: string | null): string | null {
  return (
    parseDdMmYyToIso(String(transaction_date ?? "").trim()) ??
    parseDdMmYyToIso(String(posting_date ?? "").trim()) ??
    null
  );
}

const findOpenStmt = db.prepare(
  `SELECT id FROM cc_statements
   WHERE account_id = ? AND card_group = ? AND source_pdf = ? AND statement_date = ?`
);

const insOpenStmt = db.prepare(`
  INSERT INTO cc_statements (
    account_id, card_group, source_pdf, statement_date, period_from, period_to, pay_by,
    card_last4, card_product, layout, currency,
    saldo_anterior, abono, compras_cargos, deuda_total, monto_facturado
  ) VALUES (
    ?, ?, ?, ?, NULL, NULL, NULL,
    ?, NULL, 'compact', 'clp',
    NULL, NULL, NULL, NULL, NULL
  )
`);

const moveLine = db.prepare(`UPDATE cc_statement_lines SET statement_id = ? WHERE id = ?`);

function ensureOpenWebPasteStatementId(
  accountId: number,
  billingMonth: string,
  cardGroup: string,
  cardLast4: string
): number {
  const sourcePdf = openWebPasteSourcePdf(billingMonth);
  const statementDate = statementCloseDdMmYyyyForBillingMonth(accountId, billingMonth);
  const existing = findOpenStmt.get(accountId, cardGroup, sourcePdf, statementDate) as
    | { id: number }
    | undefined;
  if (existing) return existing.id;
  const r = insOpenStmt.run(
    accountId,
    cardGroup,
    sourcePdf,
    statementDate,
    cardLast4
  );
  return Number(r.lastInsertRowid);
}

export type CcOpenWebPasteRepairResult = {
  lines_moved: number;
  target_billing_month: string | null;
};

/**
 * Move open-bucket web-paste lines dated after a month's facturación close into the
 * current open facturación bucket (post-close purchases belong on the next statement).
 * Unmatched survivors on stale `open|{M}` after a PDF close stay put; read paths attribute
 * them to the current open month (see {@link listStaleOpenWebPasteStatementDates}).
 */
export function repairMisplacedOpenWebPasteBuckets(accountId: number): CcOpenWebPasteRepairResult {
  const openBm = billingMonthForManualLedgerPurchase(accountId);
  if (!openBm) {
    return { lines_moved: 0, target_billing_month: null };
  }

  const meta = creditCardMasterMetaForAccount(accountId);
  if (!meta) {
    return { lines_moved: 0, target_billing_month: openBm };
  }

  let linesMoved = 0;
  const targetStmtId = ensureOpenWebPasteStatementId(
    accountId,
    openBm,
    meta.cardGroup,
    meta.cardLast4
  );

  for (const st of listCcStatementsForAccount(accountId)) {
    const bucketBm = parseOpenWebPasteBillingMonth(st.source_pdf);
    if (!bucketBm) continue;

    const periodTo = periodToIsoForBillingMonth(accountId, bucketBm);
    if (!periodTo) continue;

    const staleBucket = ymCompare(bucketBm, openBm) < 0;
    for (const line of listCcStatementLinesForStatement(st.id)) {
      const purchaseIso = linePurchaseIso(line.transaction_date, line.posting_date);
      if (!purchaseIso) continue;
      if (purchaseIso <= periodTo) continue;
      if (!staleBucket && bucketBm === openBm) continue;

      if (st.id === targetStmtId) continue;
      moveLine.run(targetStmtId, line.id);
      linesMoved += 1;
    }
  }

  if (linesMoved > 0) {
    recomputeCcBillingMonthBalances(accountId);
  }

  return { lines_moved: linesMoved, target_billing_month: openBm };
}
