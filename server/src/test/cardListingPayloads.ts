import {
  cardUnbilledMovementsKind,
  type CardListingLine,
  type CardUnbilledMovementsPayload,
} from "nw-tracker-contracts";
import {
  applyCardUnbilledMovements,
  type CardUnbilledMovementsImportResult,
} from "../cardUnbilledMovementsApply.js";

/**
 * Canonical `card.unbilled_movements` fixtures for server tests: what a feeder sends, never a
 * bank's own format (decoding a bank's feed is ingest's to test).
 */

type Card = CardUnbilledMovementsPayload["cards"][number];
type BalanceRow = Extract<
  NonNullable<CardUnbilledMovementsPayload["issuer_balances"]>,
  { status: "observed" }
>["rows"][number];

/** A listing line; `amount` debt-positive (charge +, credit −). */
export function listingLine(
  date: string,
  merchant: string,
  amount: number,
  opts: { currency?: "clp" | "usd"; cuota?: CardListingLine["cuota_purchase"]; raw?: string } = {}
): CardListingLine {
  return {
    date,
    merchant,
    currency: opts.currency ?? "clp",
    amount,
    raw_text: opts.raw ?? `${date} ${merchant} ${amount}`,
    ...(opts.cuota ? { cuota_purchase: opts.cuota } : {}),
  };
}

export function listingCard(
  number: string,
  lines: CardListingLine[],
  close?: { date: string; clp?: number | null; usd?: number | null }
): Card {
  return {
    account: { issuer: "santander", number },
    close: close ? { date: close.date, billed: { clp: close.clp ?? null, usd: close.usd ?? null } } : null,
    lines,
  };
}

export function balanceRow(
  number: string,
  last4: string,
  currency: "clp" | "usd",
  limit: number,
  used: number,
  available = limit - used
): BalanceRow {
  return { account: { issuer: "santander", number }, card_last4: last4, currency, limit, used, available };
}

export function listing(
  cards: Card[],
  issuerBalances?: CardUnbilledMovementsPayload["issuer_balances"],
  observedAt = "2026-10-02T01:00:40.000Z"
): CardUnbilledMovementsPayload {
  return { observed_at: observedAt, cards, ...(issuerBalances ? { issuer_balances: issuerBalances } : {}) };
}

/** Validate against the contract (what the route does), then apply. */
export function applyListing(payload: CardUnbilledMovementsPayload, sourceRef: string): CardUnbilledMovementsImportResult {
  return applyCardUnbilledMovements(cardUnbilledMovementsKind.payload.parse(payload), sourceRef);
}
