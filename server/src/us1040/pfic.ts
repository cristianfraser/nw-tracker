/**
 * Which holdings the 1040 treats as passive foreign investment companies (Form 8621): a Chilean fund
 * — an account valued by a peso fund series (a fondo mutuo, the money-market fund) — or a share of a
 * Santiago-listed fondo (an ETF registered as an art. 107 `fund`), unless it is held inside a
 * treaty-covered pension. Whether a Chilean fondo is a «foreign corporation» and «marketable» is
 * assumed by `form8621.ts` (docs/us-1040-readings.md §7), not decided here.
 */
import { accountProfileOptional } from "../accountProfile.js";
import { art107InstrumentKind } from "../art107Instruments.js";
import { equityMarketKind } from "../equityQuote.js";
import { bookMarkedFundSeriesKey } from "../taxFacts/fundHoldings.js";

/**
 * Treaty Art. 18(4) (Chile–US convention, in force 2023-12-19) defers a plan's undistributed
 * earnings when the plan is «generally exempt from income taxation» in the other State and operated
 * for retirement benefits. The AFP (DL 3500) is covered (Protocol ¶18); the APV's coverage has no
 * IRS position (docs/us-1040-readings.md §8, UNVERIFIED). True: APV and AFP accounts are not PFIC
 * holdings (Reg. §1.1298-1(c)(4) switches off the reporting; the taxes follow Art. 18(4)). False: the
 * APV's funds are PFICs like any other Chilean fund (the AFP and AFC stay out either way: DL 3500
 * social security, Art. 18(3)).
 */
export const CHILEAN_PENSION_ACCOUNTS_TREATY_DEFERRED = true;

/** The behaviour kinds of Chilean pension accounts. */
const SOCIAL_SECURITY_KINDS: ReadonlySet<string> = new Set(["afp", "afc"]);
const VOLUNTARY_PENSION_KINDS: ReadonlySet<string> = new Set(["apv"]);

/** True when account `accountId` holds a PFIC for the 1040. */
export function isPficInstrument(accountId: number): boolean {
  const profile = accountProfileOptional(accountId);
  if (!profile) return false;
  if (SOCIAL_SECURITY_KINDS.has(profile.kind)) return false;
  if (VOLUNTARY_PENSION_KINDS.has(profile.kind) && CHILEAN_PENSION_ACCOUNTS_TREATY_DEFERRED) return false;
  const holding = profile.holding;
  if (holding.kind === "fund") return holding.quote === "clp";
  // A book-marked fund account (the money-market fund): its cuotas are a fund series', its mark a peso valuation.
  if (holding.kind === "currency") return holding.code === "clp" && bookMarkedFundSeriesKey(accountId) != null;
  if (holding.kind === "stock") {
    return equityMarketKind(holding.ticker) === "santiago" && art107InstrumentKind(holding.ticker) === "fund";
  }
  return false;
}
