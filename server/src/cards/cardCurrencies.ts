import { ccIssuerBySlug } from "../ccIssuers.js";
import { ccIssuerSlugForMasterAccount } from "../ccIssuerForAccount.js";
import { requireLoadedCurrency } from "../ingestCurrencies.js";
import { IngestRefusal } from "../ingestReceiver.js";
import { lineHasPesoDollarView } from "./lineAmountSql.js";

/**
 * The currencies a card's documents may carry (docs/any-currency-plan.md C3): pesos and dollars,
 * as every card's always have, and any currency the card's issuer declares it bills in
 * (`CC_ISSUERS[…].statement_currencies`). A currency the app does not know is `unknown_currency`;
 * a known one the issuer does not bill in is `unsupported_currency`, naming `where` — a 4xx through
 * the ingest route, never a 500.
 */
export function requireCardCurrency(code: string, accountId: number, where: string): string {
  requireLoadedCurrency(code, where);
  if (lineHasPesoDollarView(code)) return code;
  const slug = ccIssuerSlugForMasterAccount(accountId);
  const issuer = ccIssuerBySlug(slug);
  const declared: readonly string[] = issuer
    ? [issuer.statement_currencies.primary, ...issuer.statement_currencies.secondary]
    : [];
  if (declared.includes(code)) return code;
  throw new IngestRefusal(
    "unsupported_currency",
    `${where}: ${code.toUpperCase()} is not a currency the card's issuer (${slug}) bills in`
  );
}
