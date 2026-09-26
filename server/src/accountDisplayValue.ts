import type { AccountMarkAtYmd } from "./accountMarkClpAtYmd.js";
import { equityTickerForAccount } from "./accountEquityTicker.js";
import { accountUsesEquityMtm } from "./brokerageEquityMtm.js";
import { accountUsesCryptoMtm } from "./cryptoValuation.js";
import { isCuotaLedgerKindSlug } from "./cuotaLedgerAccounts.js";
import { isFintualCertV2ValuationNotes } from "./fintualFundUnitDaily.js";

/**
 * The value an account shows today, on the dashboard row and the account page header alike:
 * its mark (`accountMarkClpAtYmd` at Chile today — the same function its prior-day and
 * month-end marks, the charts and the daily series read), except where the position is valued
 * from units × price — cuota ledgers (AFP/AFC), Fintual cert funds and crypto — whose position
 * mark wins. Stocks keep the mark: their position value is the same MTM.
 */
export function accountDisplayValue(args: {
  accountId: number;
  kindSlug: string;
  importKey: string | null;
  mark: AccountMarkAtYmd | null;
  position: { value_clp: number | null; value_as_of: string | null } | null | undefined;
}): { value_clp: number | null; as_of_date: string | null } {
  const { accountId, kindSlug, importKey, mark, position } = args;
  const unitsPriced =
    isCuotaLedgerKindSlug(kindSlug) ||
    isFintualCertV2ValuationNotes(importKey) ||
    ((kindSlug === "bitcoin" || kindSlug === "eth") && accountUsesCryptoMtm(accountId));
  const equityMtm = equityTickerForAccount(accountId) != null && accountUsesEquityMtm(accountId);
  if (unitsPriced && !equityMtm && position?.value_clp != null) {
    return {
      value_clp: position.value_clp,
      as_of_date: position.value_as_of ?? mark?.as_of_date ?? null,
    };
  }
  return { value_clp: mark?.value_clp ?? null, as_of_date: mark?.as_of_date ?? null };
}
