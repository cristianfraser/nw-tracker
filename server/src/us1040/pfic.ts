/**
 * Which holdings the 1040 treats as passive foreign investment companies (PFICs, §1297) — one
 * predicate for Schedule D (which leaves them out: Form 8621 owns their gains and inclusions) and
 * Form 8621, so the two cannot disagree. Read from the instrument registry and the account's kind,
 * never a name:
 *
 * - **an equity-quoted foreign fund**: a Bolsa de Santiago listing that `art107_instruments` names
 *   a fund (a fondo de inversión / ETF — the IPSA ETF), or a non-US ETF the registry lists on
 *   another exchange (a London UCITS line: an Irish fund);
 * - **a fund account** (a Chilean fondo mutuo's cuotas, holding kind `fund` or kind slug `fund`)
 *   that is neither a US retirement account nor held inside a treaty pension.
 *
 * **Treaty pensions** (docs/us-1040-readings.md §8): Art. 18(4) of the convention defers a Chilean
 * pension plan's undistributed earnings, and Reg. §1.1298-1(c)(4) switches off Form 8621 for PFICs
 * held through it. The AFP (DL 3500, Protocol ¶18) and the AFC are covered; the APV is ASSUMED
 * covered ({@link APV_TREATED_AS_TREATY_PENSION}) — no IRS position found; the alternative is that
 * each APV fund is a PFIC of its own.
 *
 * Assumptions stated on the return, not settled by any source read (readings §7): a Chilean fondo is
 * a «foreign corporation» for §1297; the fund and the ETF are «marketable» (Reg. §1.1296-2); the
 * Bolsa de Santiago is a qualified exchange.
 */
import { accountKindSlugForAccountId } from "../accountBucket.js";
import { accountProfileOptional } from "../accountProfile.js";
import { art107InstrumentKind } from "../art107Instruments.js";
import { requireMarketSymbol } from "../marketSymbols.js";
import { usRetirementAccountIds } from "../usRetirementAccounts.js";

/** The APV is read as an Art. 18(4) plan (deferral, no Form 8621); false would make each APV fund a PFIC. */
export const APV_TREATED_AS_TREATY_PENSION = true;

/** Account kind slugs of the Chilean pension system the convention's Art. 18(4) covers. */
const TREATY_PENSION_KIND_SLUGS: readonly string[] = ["afp", "afc", ...(APV_TREATED_AS_TREATY_PENSION ? ["apv"] : [])];

/** Account kind slugs whose holding is a foreign fund's cuotas outside a pension. */
const FUND_KIND_SLUGS: readonly string[] = ["fund", ...(APV_TREATED_AS_TREATY_PENSION ? [] : ["apv"])];

/** A Chilean pension account the convention defers (its earnings are no income until paid). */
export function isTreatyPensionAccount(accountId: number): boolean {
  const slug = accountKindSlugForAccountId(accountId);
  return slug != null && TREATY_PENSION_KIND_SLUGS.includes(slug);
}

/** A US retirement account (401(k), HSA, Roth IRA): growth inside it is no income on the 1040. */
export function isUsRetirementAccount(accountId: number): boolean {
  return (["us_401k", "hsa", "roth_ira"] as const).some((k) => usRetirementAccountIds(k).includes(accountId));
}

/** An equity-quoted instrument that is a foreign fund (a PFIC), from the registry. */
export function isPficEquityTicker(ticker: string): boolean {
  const s = requireMarketSymbol(ticker);
  if (s.market_kind === "santiago") return art107InstrumentKind(ticker) === "fund";
  if (s.market_kind === "london") return s.instrument_type === "ETF";
  return false;
}

/** A fund account whose cuotas are a PFIC: a foreign fund outside a pension and outside a US retirement account. */
export function isPficFundAccount(accountId: number): boolean {
  if (isTreatyPensionAccount(accountId) || isUsRetirementAccount(accountId)) return false;
  const slug = accountKindSlugForAccountId(accountId);
  if (slug != null && FUND_KIND_SLUGS.includes(slug)) return true;
  return accountProfileOptional(accountId)?.holding.kind === "fund";
}

export type PficInstrumentRef = { ticker: string } | { accountId: number };

/** One predicate for both shapes: an equity ticker, or a fund account. */
export function isPficInstrument(ref: PficInstrumentRef): boolean {
  return "ticker" in ref ? isPficEquityTicker(ref.ticker) : isPficFundAccount(ref.accountId);
}
