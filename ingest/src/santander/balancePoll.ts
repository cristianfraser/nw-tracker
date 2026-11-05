import {
  BANK_PRODUCT_SUMMARY_FETCH_STEPS,
  bankProductSummaryKind,
  type BankProductSummaryApplyDetails,
  type BankProductSummaryFetchStep,
  type BankProductSummaryPayload,
} from "nw-tracker-contracts";
import type { Recorder } from "../capture.js";
import { log } from "../log.js";
import { ingestClient } from "../serverApi.js";
import { santanderAccountBalances, santanderIssuerBalances } from "./cardFeed.js";
import { collectCardCupos, collectDepositBalances, type CardMovementsResult } from "./cards.js";

/**
 * The hourly balance poll (`fetch:santander --balance-poll`): after the login, the product summary
 * the landing page requested (card cupos, deposit-account balances) goes to the server as
 * `bank.product_summary`, and the server answers which movement listings disagree with the app.
 * The session then reads only those — on most hours, none.
 */

/** The line the hourly runner reads back from the step's output to know what to import. */
export const BALANCE_POLL_RESULT_PREFIX = "balance poll fetch:";

export function formatBalancePollResult(steps: readonly BankProductSummaryFetchStep[]): string {
  return `${BALANCE_POLL_RESULT_PREFIX} ${steps.length > 0 ? steps.join(",") : "none"}`;
}

/** The listings the last result line of `output` names; null when the poll never answered. */
export function parseBalancePollResult(output: string): BankProductSummaryFetchStep[] | null {
  const lines = output.split("\n").filter((l) => l.includes(BALANCE_POLL_RESULT_PREFIX));
  const last = lines.at(-1);
  if (last == null) return null;
  const list = last.slice(last.indexOf(BALANCE_POLL_RESULT_PREFIX) + BALANCE_POLL_RESULT_PREFIX.length).trim();
  if (list === "none") return [];
  return list.split(",").map((s) => {
    const step = s.trim() as BankProductSummaryFetchStep;
    if (!BANK_PRODUCT_SUMMARY_FETCH_STEPS.includes(step)) throw new Error(`unknown balance poll step "${s}"`);
    return step;
  });
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
  return details.fetch;
}
