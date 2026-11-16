import { HOME_CURRENCY } from "nw-tracker-contracts/dto/apiConstants";
import { parseNumberInputOrThrow } from "../format";
import type { BrokerageFlowKind } from "./brokerageFlowKinds";
import {
  brokerageFlowKindShowsUnits,
  counterpartRoleForBrokerageFlowKind,
  isOptionPremiumFlowKind,
} from "./brokerageFlowKinds";

/**
 * One row of a movement form before it is posted. `amountClp` is typed pesos; `amountCash` is
 * typed in a cash account's own currency — the form's own account on a cash ledger form, the
 * chosen cash account on a stock (or option contract) form.
 */
export type InitialMovementDraft = {
  id: string;
  flowKind: BrokerageFlowKind;
  occurredOn: string;
  amountClp: string;
  amountCash: string;
  unitsDelta: string;
  counterpartAccountId: number | "";
};

export function categorySlugFromTicker(ticker: string): string {
  return ticker
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function newMovementRowId(): string {
  return `mv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function emptyMovementRow(flowKind: BrokerageFlowKind): InitialMovementDraft {
  return {
    id: newMovementRowId(),
    flowKind,
    occurredOn: "",
    amountClp: "",
    amountCash: "",
    unitsDelta: "",
    counterpartAccountId: "",
  };
}

/**
 * The kind a new row of a form starts on: a share buy on a form that offers one (a stock
 * account's), else the first kind the form offers (a cash ledger's deposit, a contract's first
 * premium kind) — never a kind missing from the form's own list.
 */
export function defaultMovementRowKind(flowKinds: readonly BrokerageFlowKind[]): BrokerageFlowKind {
  if (flowKinds.includes("stock_buy")) return "stock_buy";
  const first = flowKinds[0];
  if (first == null) throw new Error("movement form: no flow kinds offered");
  return first;
}

export function appendMovementRow(
  movements: InitialMovementDraft[],
  kind: BrokerageFlowKind
): InitialMovementDraft[] {
  return [...movements, emptyMovementRow(kind)];
}

export function updateMovementRow(
  movements: InitialMovementDraft[],
  id: string,
  next: InitialMovementDraft
): InitialMovementDraft[] {
  return movements.map((r) => (r.id === id ? next : r));
}

export function removeMovementRow(
  movements: InitialMovementDraft[],
  id: string
): InitialMovementDraft[] {
  return movements.filter((r) => r.id !== id);
}

/**
 * The stock (or option contract) form's kinds that settle against a cash account: a share trade,
 * a dividend paid out and an option premium. The amount is in that cash account's currency,
 * whatever the stock is quoted in (the server's `validateTradeSettlement`).
 */
export function stockFormKindSettlesInCash(kind: BrokerageFlowKind): boolean {
  return kind === "stock_buy" || kind === "stock_sell" || kind === "dividend_payout" || isOptionPremiumFlowKind(kind);
}

/**
 * Which amount field a stock form row shows: `cash` (the draft's `amountCash`, in the chosen cash
 * account's currency) for a kind that settles against one; `pesos` (the draft's `amountClp`) for
 * the account's own single-leg capital rows; neither for an option expiry, which moves no money.
 */
export function stockFormRowFields(kind: BrokerageFlowKind): { pesos: boolean; cash: boolean } {
  if (stockFormKindSettlesInCash(kind)) return { pesos: false, cash: true };
  if (kind === "option_expire") return { pesos: false, cash: false };
  return { pesos: true, cash: false };
}

/** The accounts list's cash ledgers, by id: the currency each one holds (`AccountListRow.cash_currency`). */
export function cashCurrencyByAccountId(
  accounts: readonly { id: number; cash_currency?: string | null }[]
): Map<number, string> {
  const out = new Map<number, string>();
  for (const a of accounts) {
    if (a.cash_currency != null) out.set(a.id, a.cash_currency);
  }
  return out;
}

/** The currency the row's chosen cash account holds; null with no account chosen or one that is not a cash ledger. */
export function draftSettlementCurrency(
  row: InitialMovementDraft,
  cashCurrencies: ReadonlyMap<number, string>
): string | null {
  if (row.counterpartAccountId === "") return null;
  return cashCurrencies.get(row.counterpartAccountId) ?? null;
}

/**
 * Body for `POST /api/accounts/:id/movements` on a stock or option contract account.
 * `cashCurrencies` is the cash ledger accounts' currencies by account id
 * ({@link cashCurrencyByAccountId}). A kind that settles against cash posts its amount in the
 * chosen cash account's currency; without a cash account chosen the row has no body (null).
 * Only the field the kind shows is sent, so a value left behind in a now-hidden input never is.
 * Throws the localized message when a shown number field isn't a number (see `parseNumberInput`).
 */
export function buildBrokerageMovementPostBody(
  row: InitialMovementDraft,
  cashCurrencies: ReadonlyMap<number, string>
): Record<string, unknown> | null {
  const occurred_on = row.occurredOn.trim();
  if (!occurred_on) return null;
  const fields = stockFormRowFields(row.flowKind);
  const units = brokerageFlowKindShowsUnits(row.flowKind)
    ? { units_delta: parseNumberInputOrThrow(row.unitsDelta) }
    : {};
  if (fields.cash) {
    const currency = draftSettlementCurrency(row, cashCurrencies);
    if (currency == null) return null;
    const amount = parseNumberInputOrThrow(row.amountCash);
    return {
      occurred_on,
      flow_kind: row.flowKind,
      ...(amount != null ? { amount, currency } : {}),
      ...units,
      counterpart_account_id: row.counterpartAccountId,
      counterpart_role: counterpartRoleForBrokerageFlowKind(row.flowKind, "stock"),
    };
  }
  const pesos = fields.pesos ? parseNumberInputOrThrow(row.amountClp) : null;
  return {
    occurred_on,
    flow_kind: row.flowKind,
    ...(pesos != null ? { amount: pesos, currency: HOME_CURRENCY } : {}),
    ...units,
  };
}
