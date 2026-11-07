import {
  bankProductSummaryKind,
  type BankProductSummaryApplyDetails,
  type BankProductSummaryFetchStep,
  type BankProductSummaryPayload,
} from "nw-tracker-contracts";
import type { Recorder } from "../capture.js";
import { log } from "../log.js";
import { ingestClient } from "../serverApi.js";
import { reportStepResult } from "../stepResult.js";
import { santanderAccountBalances, santanderIssuerBalances } from "./cardFeed.js";
import { collectCardCupos, collectDepositBalances, type CardMovementsResult } from "./cards.js";

/**
 * The hourly balance poll (`fetch:santander --balance-poll`): after the login, the product summary
 * the landing page requested (card cupos, deposit-account balances) goes to the server as
 * `bank.product_summary`, and the server answers which movement listings disagree with the app.
 * The session then reads only those — on most hours, none.
 */

/** The run log's line for what the poll asked to read. */
export function formatBalancePollResult(steps: readonly BankProductSummaryFetchStep[]): string {
  return `balance poll fetch: ${steps.length > 0 ? steps.join(",") : "none"}`;
}

/** The summary as the server's kind states it. Throws when the session got no summary at all. */
export function santanderProductSummaryPayload(
  summary: Pick<CardMovementsResult, "cupos" | "cuposError" | "accounts" | "accountsError">
): BankProductSummaryPayload {
  const file = { fetchedAt: "", slides: [], ...summary };
  const cards = santanderIssuerBalances(file);
  if (!cards) throw new Error("the product summary carried no card section");
  const balances = santanderAccountBalances(file);
  const observedAt = cards.status === "observed" ? cards.observed_at : balances.payload?.observed_at;
  if (!observedAt) {
    throw new Error(`the landing page stated no product this session (cards: ${summary.cuposError}; accounts: ${summary.accountsError})`);
  }
  return bankProductSummaryKind.payload.parse({
    issuer: "santander",
    observed_at: observedAt,
    cards,
    accounts: balances.payload?.accounts ?? [],
  });
}

/** Send this session's summary; the listings the server wants read. */
export async function requestBalancePoll(recorder: Recorder, stamp: string): Promise<BankProductSummaryFetchStep[]> {
  const payload = santanderProductSummaryPayload({ ...collectCardCupos(recorder), ...collectDepositBalances(recorder) });
  const ref = `balance-poll-${stamp}`;
  const result = await ingestClient().send(bankProductSummaryKind, payload, {
    channel: "web_session",
    ref,
    label: ref,
    fetched_at: payload.observed_at,
  });
  const details = result.details as BankProductSummaryApplyDetails;
  for (const m of details.mismatches) log(`  differs: ${m}`);
  // The hourly runner imports what the poll read, and re-judges when a product differed.
  reportStepResult({ fetch: details.fetch, differs: details.mismatches.length > 0 });
  return details.fetch;
}
