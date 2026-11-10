/**
 * What each fund account held and was worth on given days: an account whose holding is a fund's
 * cuotas (`accountProfile.ts` holding kind `fund` — a mutual fund, an APV, the AFP and AFC cuota
 * ledgers, a 401(k) or HSA target fund), its cuotas and its value in the fund's own currency, read
 * through the valuation core (`accountValue.ts`). What a mark-to-market or a PFIC statement needs:
 * the position at the start and at the end of a window. No conversion beyond the fund's own price.
 */
import { addDaysIso } from "nw-tracker-contracts";
import { accountProfileOptional } from "../accountProfile.js";
import { accountHoldingQtyAt, accountValueAt } from "../accountValue.js";
import { db } from "../db.js";
import type { DateWindow } from "../dateWindow.js";
import type { CurrencyCode } from "../rates.js";

export type FundPositionFact = {
  date: string;
  /** Cuotas held; null when that day's value is not a cuota position (before the fund's price series starts, a peso mark stands in). */
  cuotas: number | null;
  /** The position's value in the fund's currency; null without a value on file. */
  value: number | null;
  /** The day the value is as of (a price carried from an earlier day). */
  asOf: string | null;
};

export type FundHoldingFact = {
  accountId: number;
  accountName: string;
  seriesKey: string;
  currency: CurrencyCode;
  /** One per requested day, in the order asked. */
  positions: FundPositionFact[];
};

/** Every fund account (by id) with its position on each of `dates`. */
export function fundPositionsOn(dates: readonly string[]): FundHoldingFact[] {
  const ids = (db.prepare(`SELECT id FROM accounts ORDER BY id`).all() as { id: number }[]).map((r) => r.id);
  const out: FundHoldingFact[] = [];
  for (const id of ids) {
    const profile = accountProfileOptional(id);
    if (profile?.holding.kind !== "fund") continue;
    const holding = profile.holding;
    out.push({
      accountId: id,
      accountName: profile.name,
      seriesKey: holding.seriesKey,
      currency: holding.quote,
      positions: dates.map((date) => {
        const qty = accountHoldingQtyAt(id, date);
        const value = accountValueAt(id, date, holding.quote);
        return {
          date,
          cuotas: qty != null && qty.holding.kind === "fund" ? qty.qty : null,
          value: value?.value ?? null,
          asOf: value?.as_of_date ?? null,
        };
      }),
    });
  }
  return out;
}

/** Every fund account's position when the window opens (the close of the day before) and when it ends. */
export function fundHoldingFacts(window: DateWindow): FundHoldingFact[] {
  return fundPositionsOn([addDaysIso(window.fromYmd, -1), window.throughYmd]);
}
