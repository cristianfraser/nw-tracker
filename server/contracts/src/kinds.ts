import type { z } from "zod";
import type { IngestKindDefinition } from "./defineKind.js";
import { bankAccountMovementsKind } from "./kinds/bankAccountMovements.js";
import { bankAccountBalancesKind } from "./kinds/bankAccountBalances.js";
import { bankAccountTransferNoticesKind } from "./kinds/bankAccountTransferNotices.js";
import { bankAccountStatementsKind } from "./kinds/bankAccountStatements.js";
import { brokerMovementsKind } from "./kinds/brokerMovements.js";
import { brokerNotificationsKind } from "./kinds/brokerNotifications.js";
import { cardPaymentReceiptKind } from "./kinds/cardPaymentReceipt.js";
import { cardParsedStatementsKind } from "./kinds/cardParsedStatements.js";
import { cardStatementKind } from "./kinds/cardStatement.js";
import { cardUnbilledMovementsKind } from "./kinds/cardUnbilledMovements.js";
import { merchantPurchaseDocumentKind } from "./kinds/merchantPurchaseDocument.js";
import { pensionAccountCertificatesKind } from "./kinds/pensionAccountCertificates.js";
import { storeReceiptKind } from "./kinds/storeReceipt.js";
import { employmentPayslipsKind } from "./kinds/employmentPayslips.js";
import { brokerDividendStatementKind } from "./kinds/brokerDividendStatement.js";
import { fundAccountTransactionsKind } from "./kinds/fundAccountTransactions.js";
import { unemploymentFundDocumentsKind } from "./kinds/unemploymentFundDocuments.js";

export { defineIngestKind, type IngestKindDefinition } from "./defineKind.js";

/** Every kind the server accepts. */
export const INGEST_KINDS = [cardUnbilledMovementsKind, bankAccountMovementsKind, cardPaymentReceiptKind, brokerNotificationsKind, brokerMovementsKind, pensionAccountCertificatesKind, cardStatementKind, merchantPurchaseDocumentKind, cardParsedStatementsKind, bankAccountStatementsKind, storeReceiptKind, employmentPayslipsKind, brokerDividendStatementKind, fundAccountTransactionsKind, unemploymentFundDocumentsKind, bankAccountBalancesKind, bankAccountTransferNoticesKind] as const satisfies readonly IngestKindDefinition[];

export type IngestKind = (typeof INGEST_KINDS)[number];
export type IngestKindName = IngestKind["kind"];
export type IngestPayloadOf<K extends IngestKindName> = z.infer<
  Extract<IngestKind, { kind: K }>["payload"]
>;

/** Looks a kind up by name among `kinds`; null when the name is unknown. */
export function findIngestKind(
  kinds: readonly IngestKindDefinition[],
  name: string
): IngestKindDefinition | null {
  return kinds.find((k) => k.kind === name) ?? null;
}

/** Throws when two definitions share a name — a registry must be unambiguous. */
export function assertUniqueIngestKinds(kinds: readonly IngestKindDefinition[]): void {
  const seen = new Set<string>();
  for (const k of kinds) {
    if (seen.has(k.kind)) throw new Error(`Duplicate ingest kind: ${k.kind}`);
    seen.add(k.kind);
  }
}
