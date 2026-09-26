import { ymCompare } from "./calendarMonth.js";
import { recomputeCcBillingMonthBalances } from "./ccBillingBalances.js";
import { parseDdMmYyToIso } from "./ccInstallmentPayBy.js";
import {
  statementCloseDdMmYyyyForBillingMonth,
  targetBillingMonthForManualImports,
} from "./ccManualBillingMonth.js";
import { nextPeriodStartIsoForBillingMonth } from "./ccBillingCloses.js";
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

function existingOpenWebPasteStatementId(
  accountId: number,
  billingMonth: string,
  cardGroup: string
): number | null {
  const sourcePdf = openWebPasteSourcePdf(billingMonth);
  const statementDate = statementCloseDdMmYyyyForBillingMonth(accountId, billingMonth);
  const existing = findOpenStmt.get(accountId, cardGroup, sourcePdf, statementDate) as
    | { id: number }
    | undefined;
  return existing?.id ?? null;
}

function ensureOpenWebPasteStatementId(
  accountId: number,
  billingMonth: string,
  cardGroup: string,
  cardLast4: string
): number {
  const existing = existingOpenWebPasteStatementId(accountId, billingMonth, cardGroup);
  if (existing != null) return existing;
  const sourcePdf = openWebPasteSourcePdf(billingMonth);
  const statementDate = statementCloseDdMmYyyyForBillingMonth(accountId, billingMonth);
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
  target_billing_month: string;
};

/**
 * Move open-bucket web-paste lines dated on/after the first day of the cycle that follows their
 * bucket's facturación into the current open facturación bucket (post-close purchases belong on
 * the next statement). The boundary is `nextPeriodStartIsoForBillingMonth`: the close day itself
 * on Santander (a close-day purchase bills next month), the day after on BCI, from the statement,
 * the feed-observed close or the announced one — so a provisionally closed month hands its
 * post-close lines forward before its statement exists. Unmatched survivors on stale `open|{M}`
 * after a PDF close stay put; read paths attribute them to the current open month (see
 * {@link listStaleOpenWebPasteStatementDates}). The open bucket is created only when a line
 * moves into it: this runs on every card merge, and an eager create left a retired card an empty
 * «open» facturación each month (·0161, 2026-05 → 09).
 */
export function repairMisplacedOpenWebPasteBuckets(
  accountId: number,
  opts?: { skipRecompute?: boolean }
): CcOpenWebPasteRepairResult {
  const meta = creditCardMasterMetaForAccount(accountId);
  const openBm = targetBillingMonthForManualImports(accountId, meta.cardLast4);

  let linesMoved = 0;
  let targetStmtId = existingOpenWebPasteStatementId(accountId, openBm, meta.cardGroup);

  const statements = listCcStatementsForAccount(accountId);
  for (const st of statements) {
    const bucketBm = parseOpenWebPasteBillingMonth(st.source_pdf);
    if (!bucketBm) continue;

    const nextStart = nextPeriodStartIsoForBillingMonth(accountId, bucketBm, statements).iso;

    const staleBucket = ymCompare(bucketBm, openBm) < 0;
    for (const line of listCcStatementLinesForStatement(st.id)) {
      const purchaseIso = linePurchaseIso(line.transaction_date, line.posting_date);
      if (!purchaseIso) continue;
      if (purchaseIso < nextStart) continue;
      if (!staleBucket && bucketBm === openBm) continue;

      if (st.id === targetStmtId) continue;
      targetStmtId ??= ensureOpenWebPasteStatementId(accountId, openBm, meta.cardGroup, meta.cardLast4);
      moveLine.run(targetStmtId, line.id);
      linesMoved += 1;
    }
  }

  if (linesMoved > 0 && !opts?.skipRecompute) {
    recomputeCcBillingMonthBalances(accountId);
  }

  return { lines_moved: linesMoved, target_billing_month: openBm };
}

export type CcOpenBucketMoveResult = {
  moved: number;
  /** Bucket months the moved lines came from. */
  from_billing_months: string[];
};

/**
 * Move open-bucket lines whose one-shot key the post-close card feed still lists into
 * `targetBillingMonth`'s bucket. After a close the feed («movimientos por facturar») lists only
 * the next facturación's rows — a line already filed under the closed month that the feed keeps
 * listing was NOT billed at that close (a close-day purchase, a pending authorization that settled
 * after it), so it follows the feed forward instead of being deleted with the closed cycle when the
 * statement arrives. Exact key match only (merchant + amount + date, `webPasteLineDedupeKey`);
 * statement lines never move.
 */
export function moveOpenBucketLinesByDedupeKey(
  accountId: number,
  dedupeKeys: ReadonlySet<string>,
  targetBillingMonth: string
): CcOpenBucketMoveResult {
  if (dedupeKeys.size === 0) return { moved: 0, from_billing_months: [] };
  const meta = creditCardMasterMetaForAccount(accountId);
  let targetStmtId: number | null = null;
  let moved = 0;
  const from = new Set<string>();
  for (const st of listCcStatementsForAccount(accountId)) {
    const bucketBm = parseOpenWebPasteBillingMonth(st.source_pdf);
    if (!bucketBm || ymCompare(bucketBm, targetBillingMonth) >= 0) continue;
    for (const line of listCcStatementLinesForStatement(st.id)) {
      if (!line.dedupe_key || !dedupeKeys.has(line.dedupe_key)) continue;
      targetStmtId ??= ensureOpenWebPasteStatementId(
        accountId,
        targetBillingMonth,
        meta.cardGroup,
        meta.cardLast4
      );
      moveLine.run(targetStmtId, line.id);
      moved += 1;
      from.add(bucketBm);
    }
  }
  return { moved, from_billing_months: [...from].sort() };
}

/** Move the given open-bucket lines into `targetBillingMonth`'s bucket (created on demand). */
export function moveOpenBucketLinesToBillingMonth(
  accountId: number,
  lineIds: readonly number[],
  targetBillingMonth: string
): number {
  if (lineIds.length === 0) return 0;
  const meta = creditCardMasterMetaForAccount(accountId);
  const targetStmtId = ensureOpenWebPasteStatementId(
    accountId,
    targetBillingMonth,
    meta.cardGroup,
    meta.cardLast4
  );
  for (const id of lineIds) moveLine.run(targetStmtId, id);
  return lineIds.length;
}
