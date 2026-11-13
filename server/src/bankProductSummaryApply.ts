/**
 * The hourly balance poll's question (`bank.product_summary`): the bank's stated card cupos and
 * deposit-account balances, recorded as the card listing's cupo capture and the
 * `bank_account.balances` snapshot are, judged against the app at once, and answered with the
 * movement listings the session should read — only those of the products that disagree.
 *
 * A card that disagrees (or a summary with no card rows) reads the card feed; the peso cuenta
 * corriente its «últimos movimientos» xlsx; the dollar account its movements capture. A cuenta
 * vista, or an account in a currency the session has no listing for (Santander lists pesos and
 * dollars), has no daily listing: it is reported, and the check after the poll notifies. The summary
 * carries no feed close, so a card is compared without one — a close the app has not seen yet can
 * read as a mismatch, which costs one card-feed read and settles itself.
 */
import type { BankProductSummaryApplyDetails, BankProductSummaryFetchStep, BankProductSummaryPayload } from "nw-tracker-contracts";
import { applyBankAccountBalances, judgeLatestBankAccountBalances } from "./bankAccountBalances.js";
import { judgeLatestBankCupoCapture } from "./ccBankCupoCheck.js";
import { bankCupoCaptureFromListing, recordBankCupoCapture } from "./santanderBankCupo.js";
import { requireCcIssuerSlug } from "./ccIssuers.js";

/** The session's checking listing for each currency it reads (the fetcher's step names). */
const CHECKING_LISTING_BY_CURRENCY: Readonly<Record<string, BankProductSummaryFetchStep>> = {
  clp: "checking-movements",
  usd: "checking-usd-movements",
};

export function applyBankProductSummary(
  payload: BankProductSummaryPayload,
  sourceRef: string
): BankProductSummaryApplyDetails {
  const fetch = new Set<BankProductSummaryFetchStep>();
  const mismatches: string[] = [];

  const issuer = requireCcIssuerSlug(payload.issuer, "bank.product_summary");
  const cupo = recordBankCupoCapture(issuer, sourceRef, bankCupoCaptureFromListing(payload.cards), new Map());
  if (cupo.status === "missing") {
    fetch.add("card-movements");
    mismatches.push(`card cupos not stated (${cupo.error}) — reading the card feed`);
  } else {
    for (const v of judgeLatestBankCupoCapture({ issuer }).verdicts) {
      if (v.status === "ok") continue;
      fetch.add("card-movements");
      const what = v.status === "mismatch" ? `app − bank ${v.diff}` : (v.reason ?? "not comparable");
      mismatches.push(`card ${v.snapshot.account_id} ${v.snapshot.currency.toUpperCase()}: ${what} — reading the card feed`);
    }
  }

  if (payload.accounts.length > 0) {
    const balances = applyBankAccountBalances(
      { issuer: payload.issuer, observed_at: payload.observed_at, accounts: payload.accounts },
      sourceRef
    );
    const numberOf = new Map(balances.known.map((k) => [`${k.account_id}|${k.currency}`, k.number]));
    for (const v of judgeLatestBankAccountBalances()) {
      if (v.status === "ok") continue;
      const number = numberOf.get(`${v.account_id}|${v.currency}`);
      // A declared account the summary did not list this time: its latest snapshot is an older one.
      if (number == null) continue;
      const product = payload.accounts.find((a) => a.number === number && a.currency === v.currency)!.product;
      const step: BankProductSummaryFetchStep | null =
        product === "demand_deposit" ? null : (CHECKING_LISTING_BY_CURRENCY[v.currency] ?? null);
      if (step) fetch.add(step);
      mismatches.push(
        `${v.account_name} ${v.currency.toUpperCase()}: app − bank ${v.diff} — ` +
          (step ? `reading ${step}` : "no movement listing to read")
      );
    }
  }
  return { fetch: [...fetch], mismatches };
}
