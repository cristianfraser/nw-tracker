/**
 * Dividends paid in a window: every `dividend_payout` movement (a transfer out of the instrument's
 * account into the cash it was paid to, or a single-leg row), the NET credited in its own currency,
 * and what a broker document states beside it (`movement_dividend_details`: the gross, the tax
 * withheld, where and at which rate). With the instrument, the payers behind the receiving cash
 * (`payers.ts`) and whether the instrument sits in a US retirement account (`usRetirementAccounts.ts`)
 * — the facts a return needs to decide whether, where and how a dividend is declared. No
 * conversion, no code.
 */
import { db } from "../db.js";
import type { DateWindow } from "../dateWindow.js";
import type { DividendDetailSource } from "../movementDividendDetails.js";
import { usRetirementAccountIds } from "../usRetirementAccounts.js";
import type { UsRetirementAccountKind } from "../accountIdentityKeys.js";
import { loadAccountPayers, type AccountPayer } from "./payers.js";

/** What the broker document behind a dividend states (`movement_dividend_details`). */
export type DividendDetailFact = {
  currency: string;
  gross: number;
  withholding: number;
  /** As printed; never computed from gross and withholding. */
  withholdingRatePct: number | null;
  /** The country that withheld (`US`), as printed. */
  withholdingJurisdiction: string | null;
  /** The tax residency the broker withheld for (`CHL`, `USA`), as printed. */
  taxResidencyCountry: string | null;
  source: DividendDetailSource;
};

export type DividendFact = {
  movementId: number;
  date: string;
  currency: string;
  /** What was credited, in `currency`. */
  net: number;
  /** The instrument's account (the transfer's from-leg); null for a single-leg row. */
  fromAccountId: number | null;
  /** The cash the dividend was paid into (the transfer's to-leg). */
  toAccountId: number | null;
  /** The from-account's ticker. */
  instrumentTicker: string | null;
  /** Null while no broker document with the gross / withholding split has been imported. */
  detail: DividendDetailFact | null;
  /** Who stands behind the receiving cash. */
  payers: AccountPayer[];
  /** The instrument's account is a US retirement account of this kind (its growth is no income). */
  usRetirementAccount: UsRetirementAccountKind | null;
};

const RETIREMENT_KINDS: readonly UsRetirementAccountKind[] = ["us_401k", "hsa", "roth_ira"];

/** The window's dividends, by date then movement id. */
export function dividendFacts(window: DateWindow): DividendFact[] {
  const payers = loadAccountPayers();
  const retirement = new Map<number, UsRetirementAccountKind>();
  for (const kind of RETIREMENT_KINDS) for (const id of usRetirementAccountIds(kind)) retirement.set(id, kind);
  const rows = db
    .prepare(
      `SELECT m.id, m.occurred_on, m.amount, m.currency, m.from_account_id, m.to_account_id, a.equity_ticker,
              d.movement_id AS detail_id, d.gross_amount, d.withholding_amount, d.currency AS detail_currency,
              d.withholding_rate_pct, d.withholding_jurisdiction, d.tax_residency_country, d.source
         FROM movements m
         LEFT JOIN movement_dividend_details d ON d.movement_id = m.id
         LEFT JOIN accounts a ON a.id = m.from_account_id
        WHERE m.flow_kind = 'dividend_payout' AND m.occurred_on >= ? AND m.occurred_on <= ?
        ORDER BY m.occurred_on, m.id`
    )
    .all(window.fromYmd, window.throughYmd) as {
    id: number;
    occurred_on: string;
    amount: number;
    currency: string;
    from_account_id: number | null;
    to_account_id: number | null;
    equity_ticker: string | null;
    detail_id: number | null;
    gross_amount: number | null;
    withholding_amount: number | null;
    detail_currency: string | null;
    withholding_rate_pct: number | null;
    withholding_jurisdiction: string | null;
    tax_residency_country: string | null;
    source: DividendDetailSource | null;
  }[];
  return rows.map((r) => ({
    movementId: r.id,
    date: r.occurred_on,
    currency: r.currency,
    net: r.amount,
    fromAccountId: r.from_account_id,
    toAccountId: r.to_account_id,
    instrumentTicker: r.equity_ticker,
    detail:
      r.detail_id == null
        ? null
        : {
            currency: r.detail_currency!,
            gross: r.gross_amount!,
            withholding: r.withholding_amount!,
            withholdingRatePct: r.withholding_rate_pct,
            withholdingJurisdiction: r.withholding_jurisdiction,
            taxResidencyCountry: r.tax_residency_country,
            source: r.source!,
          },
    payers: r.to_account_id != null ? (payers.get(r.to_account_id) ?? []) : [],
    usRetirementAccount: r.from_account_id != null ? (retirement.get(r.from_account_id) ?? null) : null,
  }));
}
