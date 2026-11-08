import { accountProfile } from "./accountProfile.js";
import { cardSuperseded } from "./cards/lifecycle.js";
import { ccIssuerSlugForMasterAccount } from "./ccIssuerForAccount.js";
import { ccIssuerBySlug, type CcIssuerSlug } from "./ccIssuers.js";
import { db } from "./db.js";

/**
 * The operational card masters (Gastos, the category PATCH allowlist, the Pasivos seed): every
 * `credit_card_master|…` account whose profile is a card, superseded masters left out. The one
 * card-master list: Pasivos and the cash netting read its stored copy (the Pasivos group items).
 */
export function listCreditCardMasterAccountIds(): number[] {
  const rows = db
    .prepare(`SELECT id FROM accounts WHERE import_key LIKE 'credit_card_master|%' ORDER BY import_key`)
    .all() as { id: number }[];
  return rows
    .map((r) => r.id)
    .filter((id) => accountProfile(id).kind === "credit_card" && !cardSuperseded(id));
}

/**
 * The masters Pasivos › tarjeta de crédito lists, in its order: by issuer (`CC_ISSUERS`
 * `sort_order`), then as `listCreditCardMasterAccountIds` lists them. The liabilities seed links
 * them as the group's account items.
 */
export function listCreditCardMasterAccountIdsInNavOrder(): number[] {
  const issuerOrder = (id: number) => ccIssuerBySlug(ccIssuerSlugForMasterAccount(id))!.sort_order;
  return listCreditCardMasterAccountIds()
    .map((id, index) => ({ id, index, order: issuerOrder(id) }))
    .sort((a, b) => a.order - b.order || a.index - b.index)
    .map((r) => r.id);
}

/** The operational masters of one issuer (`credit_card_account_config.issuer`). */
export function listCreditCardMasterAccountIdsForIssuer(issuer: CcIssuerSlug): number[] {
  return listCreditCardMasterAccountIds().filter((id) => ccIssuerSlugForMasterAccount(id) === issuer);
}

