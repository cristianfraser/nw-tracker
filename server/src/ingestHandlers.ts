import {
  findIngestKind,
  INGEST_KINDS,
  type CardUnbilledMovementsApplyDetails,
  type IngestKindName,
  type IngestPayloadOf,
  type IngestResult,
  type IngestSource,
} from "nw-tracker-contracts";
import { receiveIngestDocument, type IngestApplyContext, type IngestHandlerResult } from "./ingestReceiver.js";
import { applyBankAccountMovements } from "./bankAccountMovementsApply.js";
import { applyBankAccountBalances } from "./bankAccountBalances.js";
import { applyBankProductSummary } from "./bankProductSummaryApply.js";
import { applyBankTransferNotices } from "./bankTransferNotices.js";
import { applyIncomingWires } from "./incomingWires.js";
import { buildFlowsExpenseLines } from "./flowsExpenses.js";
import { requestExpenseLinkSync, withExpenseLinkSyncDeferred } from "./expenseLinkSync.js";
import { matchPaymentReceiptsToExpenseLines, storePaymentProcessorReceipts } from "./paymentProcessorReceipts.js";
import { applyBankAccountStatements } from "./bankAccountStatementsApply.js";
import { applyBrokerNotifications } from "./brokerNotificationsApply.js";
import { applyCardStatement } from "./cardStatementApply.js";
import { applyParsedCcStatements } from "./ccParsedStatementsApply.js";
import { applyMerchantPurchaseDocument } from "./merchantPurchaseDocumentApply.js";
import { applyPensionAccountBalance, applyPensionAccountCertificates } from "./pensionAccountCertificatesApply.js";
import { applyUnemploymentFundBalance } from "./unemploymentFundBalanceApply.js";
import { applyFintualWalletRead } from "./fintualWalletInterestApply.js";
import { applyRacionalRead } from "./racionalMovementsImport.js";
import { applyCardPaymentReceipt } from "./santanderCcPaymentReceipts.js";
import { applyStoreReceipt } from "./storeReceiptApply.js";
import { applyEmploymentPayslips } from "./payslipsApply.js";
import { applyPayrollParameters } from "./payrollParametersApply.js";
import { applyBrokerDividendStatement } from "./brokerDividendStatementApply.js";
import { applyFundAccountTransactions } from "./fintualCertImport.js";
import { applyUnemploymentFundDocuments } from "./afcCertImport.js";
import { applyMortgageSheetPayments } from "./mortgageSheetPaymentsApply.js";
import { applyUtilityBills } from "./utilityBillsApply.js";
import {
  applyCardUnbilledMovements,
  type CardUnbilledMovementsImportResult,
} from "./cardUnbilledMovementsApply.js";

export type { IngestApplyContext, IngestHandlerResult } from "./ingestReceiver.js";

/**
 * Applies one validated document to the ledger and reports what it did (`ingestReceiver.ts`
 * decides the status). Throws `IngestConflict` when the document disagrees with what the server
 * holds, anything else on a server fault (→ 500). Runs inside the receiver's transaction.
 */
export interface IngestHandler<P = unknown> {
  apply(ctx: IngestApplyContext<P>): IngestHandlerResult;
}

/** One handler per contract kind — the type makes a kind without a handler a compile error. */
export type IngestHandlerMap = { [K in IngestKindName]: IngestHandler<IngestPayloadOf<K>> };

/** The import result as the contract's `details` (what the feeder prints). */
function cardUnbilledDetails(result: CardUnbilledMovementsImportResult): CardUnbilledMovementsApplyDetails {
  return {
    cards: result.accounts.map((a) => ({
      account: a.account,
      account_id: a.account_id,
      lines: a.lines_parsed,
      inserted: a.inserted,
      skipped_duplicate: a.skipped_duplicate,
      skipped_cuota_billing: a.skipped_cuota_billing,
      batch_id: a.batch_id,
      close: a.feed_close
        ? {
            date: a.feed_close.close_iso,
            billing_month: a.feed_close.billing_month,
            status: a.feed_close.status,
            billed_clp: a.feed_close.saldo_inicial_clp,
            billed_usd: a.feed_close.saldo_inicial_usd,
            rows_billing_month: a.feed_close.rows_billing_month,
            lines_in_later_cycle: a.feed_close.lines_in_later_cycle,
            lines_moved_forward: a.feed_close.lines_moved_forward,
            provisional_check: a.feed_close.provisional_check,
          }
        : null,
      plans_created: a.plans_created,
      first_due_nudges: a.first_due_nudges,
      cuota_lines_tagged: a.cuota_lines_tagged,
      planted_payments: {
        replaced: a.planted_payments.replaced.map((r) => ({
          planted_line_id: r.planted_line_id,
          bank_line_merchant: r.bank_line_merchant,
          bank_line_date: r.bank_line_date,
          amount: r.amount,
          currency: r.currency,
        })),
        confirmed_in_place: a.planted_payments.confirmed_in_place.map((r) => ({
          planted_line_id: r.planted_line_id,
          bank_line_merchant: r.bank_line_merchant,
          amount: r.amount,
          currency: r.currency,
        })),
        ambiguous: a.planted_payments.ambiguous,
      },
      removed_by_mirror: a.mirror?.removed ?? null,
    })),
    issuer_balances: result.bank_cupo,
  };
}

const HANDLERS: IngestHandlerMap = {
  "unemployment_fund.documents": { apply: ({ payload }) => ({ details: applyUnemploymentFundDocuments(payload) }) },
  "fund_account.transactions": { apply: ({ payload }) => ({ details: applyFundAccountTransactions(payload) }) },
  "broker.dividend_statement": { apply: ({ payload }) => ({ details: applyBrokerDividendStatement(payload) }) },
  "employment.payslips": { apply: ({ payload }) => ({ details: applyEmploymentPayslips(payload) }) },
  "store.receipt": {
    apply({ payload }) {
      const details = applyStoreReceipt(payload);
      // Waiting for its card line: the feeder sends it again.
      return { details, retry: !details.final };
    },
  },
  "bank_account.statements": { apply: ({ payload }) => ({ details: applyBankAccountStatements(payload) }) },
  "card.parsed_statements": {
    apply({ payload }) {
      const records = payload.rows.map((values) => Object.fromEntries(payload.columns.map((c, i) => [c, values[i]!])));
      return { details: applyParsedCcStatements(records, { dryRun: false, full: payload.full }) };
    },
  },
  "merchant.purchase_document": {
    apply: ({ payload, envelope }) => ({ details: applyMerchantPurchaseDocument(payload, envelope.source.ref) }),
  },
  "card.statement": { apply: ({ payload }) => ({ details: applyCardStatement(payload) }) },
  "payroll.parameters": { apply: ({ payload }) => ({ details: applyPayrollParameters(payload) }) },
  "pension_account.balance": { apply: ({ payload }) => ({ details: applyPensionAccountBalance(payload) }) },
  "unemployment_fund.balance": { apply: ({ payload }) => ({ details: applyUnemploymentFundBalance(payload) }) },
  "pension_account.certificates": {
    apply: ({ payload, envelope }) => ({ details: applyPensionAccountCertificates(payload, envelope.source.ref) }),
  },
  "broker.movements": {
    apply({ payload, envelope }) {
      const details =
        payload.broker === "fintual"
          ? applyFintualWalletRead(payload)
          : applyRacionalRead(payload, envelope.source.ref);
      return { details };
    },
  },
  "broker.notifications": { apply: ({ payload }) => ({ details: applyBrokerNotifications(payload) }) },
  "card.payment_receipt": {
    apply({ payload, envelope }) {
      const details = applyCardPaymentReceipt(payload, envelope.source.ref);
      // Two debits fit: the next run may find one of them taken.
      return { details, retry: details.status === "ambiguous" };
    },
  },
  "bank_account.balances": {
    apply: ({ payload, envelope }) => ({ details: applyBankAccountBalances(payload, envelope.source.ref) }),
  },
  "bank.product_summary": {
    apply: ({ payload, envelope }) => ({ details: applyBankProductSummary(payload, envelope.source.ref) }),
  },
  "bank_account.transfer_notices": { apply: ({ payload }) => ({ details: applyBankTransferNotices(payload) }) },
  "bank_account.incoming_wires": { apply: ({ payload }) => ({ details: applyIncomingWires(payload) }) },
  "payment.processor_receipts": {
    apply({ payload }) {
      const stored = storePaymentProcessorReceipts(payload);
      // The pairing is derived when the expense lines are built; report what the page will show.
      const match = matchPaymentReceiptsToExpenseLines(buildFlowsExpenseLines());
      return { details: { ...stored, paired: match.paired, unpaired: match.unpaired, ambiguous: match.ambiguous } };
    },
  },
  "bank_account.movements": {
    apply: ({ payload, envelope }) => ({ details: applyBankAccountMovements(payload, envelope.source.ref) }),
  },
  "mortgage.sheet_payments": { apply: ({ payload }) => ({ details: applyMortgageSheetPayments(payload) }) },
  "utility.bill": { apply: ({ payload }) => ({ details: applyUtilityBills(payload) }) },
  "card.unbilled_movements": {
    apply: ({ payload, envelope }) => ({ details: cardUnbilledDetails(applyCardUnbilledMovements(payload, envelope.source.ref)) }),
  },
};

/**
 * Every applied document can move what an expense line pairs with (a checking movement, a deposit,
 * a payslip, a card line): the expense deposit links re-sync once, at the end of the handler —
 * inside the document's transaction, so a dry run rolls the sync back with the rest.
 */
function syncingExpenseLinks(handlers: IngestHandlerMap): IngestHandlerMap {
  const out: Record<string, IngestHandler<unknown>> = {};
  for (const [name, handler] of Object.entries(handlers) as [string, IngestHandler<unknown>][]) {
    out[name] = {
      ...handler,
      apply: (ctx) =>
        withExpenseLinkSyncDeferred(() => {
          const result = handler.apply(ctx);
          requestExpenseLinkSync();
          return result;
        }),
    };
  }
  return out as IngestHandlerMap;
}

export const INGEST_HANDLERS: IngestHandlerMap = syncingExpenseLinks(HANDLERS);

/**
 * Receives one document the way `POST /api/ingest/<kind>` does, without HTTP (tests, and a
 * server-side caller that holds a validated payload).
 */
export function receiveIngest<K extends IngestKindName>(
  name: K,
  payload: IngestPayloadOf<K>,
  options: { source: IngestSource; dryRun?: boolean }
): IngestResult {
  const kind = findIngestKind(INGEST_KINDS, name);
  if (!kind) throw new Error(`Unknown ingest kind: ${name}`);
  const handler = INGEST_HANDLERS[name] as IngestHandler<IngestPayloadOf<K>>;
  return receiveIngestDocument(
    kind,
    { schema_version: kind.schema_version, feeder_id: "server", source: options.source, dry_run: options.dryRun ?? false, payload },
    (ctx) => handler.apply(ctx)
  );
}
