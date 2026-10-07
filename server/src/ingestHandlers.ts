import type {
  CardUnbilledMovementsApplyDetails,
  IngestEnvelope,
  IngestKindDefinition,
  IngestKindName,
  IngestPayloadOf,
  IngestResult,
} from "nw-tracker-contracts";
import { applyBankAccountMovements } from "./bankAccountMovementsApply.js";
import { applyBankAccountBalances } from "./bankAccountBalances.js";
import { applyBankTransferNotices } from "./bankTransferNotices.js";
import { buildFlowsExpensesPayload } from "./flowsExpenses.js";
import { matchPaymentReceiptsToExpenseLines, storePaymentProcessorReceipts } from "./paymentProcessorReceipts.js";
import { applyBankAccountStatements } from "./bankAccountStatementsApply.js";
import { applyBrokerNotifications } from "./brokerNotificationsApply.js";
import { applyCardStatement } from "./cardStatementApply.js";
import { applyParsedCcStatements } from "./ccParsedStatementsApply.js";
import { applyMerchantPurchaseDocument } from "./merchantPurchaseDocumentApply.js";
import { applyPensionAccountCertificates } from "./pensionAccountCertificatesApply.js";
import { applyRacionalRead } from "./racionalMovementsImport.js";
import { applyCardPaymentReceipt } from "./santanderCcPaymentReceipts.js";
import { applyStoreReceipt } from "./storeReceiptApply.js";
import { applyEmploymentPayslips } from "./payslipsApply.js";
import { applyBrokerDividendStatement } from "./brokerDividendStatementApply.js";
import { applyFundAccountTransactions } from "./fintualCertImport.js";
import { applyUnemploymentFundDocuments } from "./afcCertImport.js";
import {
  applyCardUnbilledMovements,
  type CardUnbilledMovementsImportResult,
} from "./cardUnbilledMovementsApply.js";

/** What a handler reports; the route adds the kind and version to make the IngestResult. */
export type IngestApplyOutcome = Omit<IngestResult, "kind" | "schema_version">;

export interface IngestApplyContext<P> {
  kind: IngestKindDefinition;
  /** The validated payload (the kind's schema output). */
  payload: P;
  envelope: IngestEnvelope<P>;
}

/**
 * Applies one validated document to the ledger. Throws on a server fault (→ 500); returns
 * `conflict` when the document disagrees with what the server holds.
 */
export interface IngestHandler<P = unknown> {
  apply(ctx: IngestApplyContext<P>): Promise<IngestApplyOutcome> | IngestApplyOutcome;
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
            lines_moved_forward: a.feed_close.lines_moved_forward,
            provisional_check: a.feed_close.provisional_check,
          }
        : null,
      plans_created: a.plans_created,
      first_due_nudges: a.first_due_nudges,
      cuota_lines_tagged: a.cuota_lines_tagged,
      removed_by_mirror: a.mirror?.removed ?? null,
    })),
    issuer_balances: result.bank_cupo,
  };
}

export const INGEST_HANDLERS: IngestHandlerMap = {
  "unemployment_fund.documents": {
    apply({ payload }) {
      return { status: "applied", details: applyUnemploymentFundDocuments(payload) };
    },
  },
  "fund_account.transactions": {
    apply({ payload }) {
      return { status: "applied", details: applyFundAccountTransactions(payload) };
    },
  },
  "broker.dividend_statement": {
    apply({ payload }) {
      return { status: "applied", details: applyBrokerDividendStatement(payload) };
    },
  },
  "employment.payslips": {
    apply({ payload }) {
      return { status: "applied", details: applyEmploymentPayslips(payload) };
    },
  },
  "store.receipt": {
    apply({ payload }) {
      return { status: "applied", details: applyStoreReceipt(payload) };
    },
  },
  "bank_account.statements": {
    apply({ payload }) {
      return { status: "applied", details: applyBankAccountStatements(payload) };
    },
  },
  "card.parsed_statements": {
    apply({ payload }) {
      const records = payload.rows.map((values) => Object.fromEntries(payload.columns.map((c, i) => [c, values[i]!])));
      return { status: "applied", details: applyParsedCcStatements(records, { dryRun: !payload.apply, full: payload.full }) };
    },
  },
  "merchant.purchase_document": {
    apply({ payload, envelope }) {
      const outcome = applyMerchantPurchaseDocument(payload, envelope.source.ref);
      return outcome.status === "conflict"
        ? { status: "conflict", message: outcome.message }
        : { status: outcome.status, details: outcome.details };
    },
  },
  "card.statement": {
    apply({ payload }) {
      return { status: "applied", details: applyCardStatement(payload) };
    },
  },
  "pension_account.certificates": {
    apply({ payload, envelope }) {
      return { status: "applied", details: applyPensionAccountCertificates(payload, envelope.source.ref) };
    },
  },
  "broker.movements": {
    apply({ payload, envelope }) {
      return { status: "applied", details: applyRacionalRead(payload, envelope.source.ref) };
    },
  },
  "broker.notifications": {
    apply({ payload }) {
      return { status: "applied", details: applyBrokerNotifications(payload) };
    },
  },
  "card.payment_receipt": {
    apply({ payload, envelope }) {
      return { status: "applied", details: applyCardPaymentReceipt(payload, envelope.source.ref) };
    },
  },
  "bank_account.balances": {
    apply({ payload, envelope }) {
      const { duplicate, details } = applyBankAccountBalances(payload, envelope.source.ref);
      return { status: duplicate ? "duplicate" : "applied", details };
    },
  },
  "bank_account.transfer_notices": {
    apply({ payload }) {
      const details = applyBankTransferNotices(payload);
      return { status: details.new_notices === 0 ? "duplicate" : "applied", details };
    },
  },
  "payment.processor_receipts": {
    apply({ payload }) {
      const stored = storePaymentProcessorReceipts(payload);
      // The pairing is derived when the expense lines are built; report what the page will show.
      const match = matchPaymentReceiptsToExpenseLines(buildFlowsExpensesPayload().lines);
      return {
        status: stored.new_receipts === 0 ? "duplicate" : "applied",
        details: { ...stored, paired: match.paired, unpaired: match.unpaired, ambiguous: match.ambiguous },
      };
    },
  },
  "bank_account.movements": {
    apply({ payload, envelope }) {
      return { status: "applied", details: applyBankAccountMovements(payload, envelope.source.ref) };
    },
  },
  "card.unbilled_movements": {
    apply({ payload, envelope }) {
      const result = applyCardUnbilledMovements(payload, envelope.source.ref);
      return { status: "applied", details: cardUnbilledDetails(result) };
    },
  },
};
