/**
 * Accounts whose balance is stored in `valuations` (book snapshots) with CLP flows in
 * `movements` — not MTM, cartola, cert import, or brokerage flow_kind ledgers.
 */

import { accountBucketKindSlug } from "./accountBucket.js";
import { accountUsesEquityMtm } from "./brokerageEquityMtm.js";
import { accountUsesCryptoMtm } from "./cryptoValuation.js";
import { isFintualCertV2ValuationNotes } from "./fintualFundUnitDaily.js";
import { isMovementBalanceCashCategory } from "./movementBalanceCashAccounts.js";
import { accountUsesUsdCashFlowKinds } from "./accountUsdCashFlows.js";
import { accountRowForId } from "./accountRowForMovement.js";
import { movementCreateSchemaForAccount } from "./movementUnitsPolicy.js";

export type BookLedgerEditSchema = {
  valuations: true;
  movements: { units_delta: "optional" };
};

export function bookLedgerEditSchemaForAccount(accountId: number): BookLedgerEditSchema | null {
  if (!Number.isFinite(accountId) || accountId <= 0) return null;
  const account = accountRowForId(accountId);
  if (!account) return null;

  const kind = accountBucketKindSlug(account.bucket_slug);
  if (kind === "afp") return null;
  if (isMovementBalanceCashCategory(kind)) return null;
  if (accountUsesUsdCashFlowKinds({ bucket_slug: account.bucket_slug, group_slug: account.bucket_slug })) return null;
  if (kind === "credit_card") return null;
  if (kind === "property" || kind === "mortgage") return null;
  if (account.import_key && isFintualCertV2ValuationNotes(account.import_key)) return null;
  if (accountUsesEquityMtm(accountId)) return null;
  if (accountUsesCryptoMtm(accountId)) return null;

  const schema = movementCreateSchemaForAccount(account);
  if (!schema || schema.ledger !== "movements") return null;
  if (schema.brokerage_flow_kinds?.length) return null;
  if (schema.units_delta === "required") return null;

  return {
    valuations: true,
    movements: { units_delta: "optional" },
  };
}
