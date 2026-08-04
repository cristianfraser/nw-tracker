/**
 * Which accounts require `units_delta` (shares, coin, Fintual/AFP cuotas) on manual API creates.
 */

import { accountUsesBrokerageFlowKinds } from "./accountBrokerageFlows.js";
import { accountUsesUsdCashFlowKinds } from "./accountUsdCashFlows.js";
import { accountUsesClpCashFlowKinds } from "./accountClpCashFlows.js";
import {
  BROKERAGE_FLOW_KINDS,
  BROKERAGE_UNITS_REQUIRED_FLOW_KINDS,
  signedAmountClpForBrokerageFlow,
} from "./brokerageFlowMovement.js";
import {
  resolveTransferEndpoints,
  validateTransferCreate,
  type TransferCreateInput,
} from "./movementTransfer.js";
import { accountRowForId } from "./accountRowForMovement.js";
import { equityTickerForAccount } from "./accountEquityTicker.js";
import { accountBucketKindSlug } from "./accountBucket.js";
import { equityQuoteCurrency } from "./equityQuote.js";
import { isClpCashAccount } from "./clpCashAccounts.js";
import { isUsdCashAccount } from "./usdCashAccounts.js";
import { assertManualUnitsClpReconcile } from "./manualUnitsFlow.js";
import { isMovementCurrency, type MovementCurrency } from "./movementAmounts.js";
export type AccountRow = {
  bucket_slug: string;
  group_slug: string;
  notes?: string | null;
  import_key?: string | null;
  equity_ticker?: string | null;
};

export type UnitsFieldRequirement = "required" | "optional";

export type MovementCreateSchema = {
  ledger: "movements";
  units_delta: UnitsFieldRequirement;
  /** Spanish label for API errors / UI hints (e.g. cuotas, acciones, BTC). */
  unit_label: string;
  /** SPY/VEA: valid `flow_kind` values on POST movements. */
  brokerage_flow_kinds?: readonly string[];
  /** Flow kinds that must include `units_delta` (share-changing). */
  units_required_for_flow_kinds?: readonly string[];
};

const MOVEMENTS_UNITS_BY_CATEGORY: Record<string, { unit_label: string }> = {
  afp: { unit_label: "cuotas" },
  bitcoin: { unit_label: "BTC" },
  eth: { unit_label: "ETH" },
  fintual_risky_norris: { unit_label: "cuotas" },
  fondo_reserva: { unit_label: "cuotas" },
  apv: { unit_label: "cuotas" },
};

export function movementCreateSchemaForAccount(account: AccountRow): MovementCreateSchema | null {
  if (accountUsesBrokerageFlowKinds(account)) {
    return {
      ledger: "movements",
      units_delta: "optional",
      unit_label: "acciones",
      brokerage_flow_kinds: BROKERAGE_FLOW_KINDS,
      units_required_for_flow_kinds: BROKERAGE_UNITS_REQUIRED_FLOW_KINDS,
    };
  }
  if (accountUsesUsdCashFlowKinds(account)) {
    return {
      ledger: "movements",
      units_delta: "optional",
      unit_label: "USD",
      brokerage_flow_kinds: [
        "deposit_clp",
        "compra_usd_venta_clp",
        "savings_earnings",
        "withdrawal_usd",
        "withdrawal_clp",
        "other",
      ],
      units_required_for_flow_kinds: [],
    };
  }
  if (accountUsesClpCashFlowKinds(account)) {
    return {
      ledger: "movements",
      units_delta: "optional",
      unit_label: "CLP",
      brokerage_flow_kinds: ["deposit_clp", "savings_earnings", "withdrawal_clp", "other"],
      units_required_for_flow_kinds: [],
    };
  }
  const spec = MOVEMENTS_UNITS_BY_CATEGORY[accountBucketKindSlug(account.bucket_slug)];
  if (!spec) {
    return { ledger: "movements", units_delta: "optional", unit_label: "unidades" };
  }
  return { ledger: "movements", units_delta: "required", unit_label: spec.unit_label };
}

/** Accept `units_delta` or alias `unit_amount` from API clients. */
export function parseUnitsDeltaField(body: Record<string, unknown>): number | null | undefined {
  if (Object.prototype.hasOwnProperty.call(body, "units_delta")) {
    const v = body.units_delta;
    if (v === null || v === undefined) return null;
    return typeof v === "number" ? v : Number(v);
  }
  if (Object.prototype.hasOwnProperty.call(body, "unit_amount")) {
    const v = body.unit_amount;
    if (v === null || v === undefined) return null;
    return typeof v === "number" ? v : Number(v);
  }
  return undefined;
}

function unitsValueInvalid(n: number): boolean {
  return !Number.isFinite(n) || n === 0;
}

export type MovementCreateValidation =
  | {
      ok: true;
      mode: "standard";
      amount: number;
      currency: MovementCurrency;
      occurred_on: string;
      note: string | null;
      units_delta: number | null;
      flow_kind: null;
      counter_amount: null;
      counter_currency: null;
      ticker: null;
    }
  | {
      ok: true;
      mode: "brokerage";
      amount: number;
      currency: MovementCurrency;
      occurred_on: string;
      note: string | null;
      units_delta: number | null;
      flow_kind: string;
      counter_amount: number | null;
      counter_currency: MovementCurrency | null;
      ticker: string | null;
    }
  | {
      ok: true;
      mode: "transfer";
      from_account_id: number;
      to_account_id: number;
      amount: number;
      currency: MovementCurrency;
      counter_amount: number | null;
      counter_currency: MovementCurrency | null;
      occurred_on: string;
      note: string | null;
      units_delta: number | null;
      flow_kind: string | null;
      ticker: string | null;
    }
  | { ok: false; status: number; error: string };

/**
 * Native amount fields on create requests: `amount` + `currency`, plus the optional
 * `counter_amount`/`counter_currency` to-leg on cross-currency conversions. Numbers are
 * coerced like the legacy fields were; a malformed currency is a 400, never a guess.
 */
type ParsedAmountFields = {
  amount: number | null;
  currency: MovementCurrency | null;
  counter_amount: number | null;
  counter_currency: MovementCurrency | null;
};

function parseAmountFields(body: Record<string, unknown>): ParsedAmountFields | { error: string } {
  const num = (v: unknown): number | null =>
    v === undefined || v === null ? null : typeof v === "number" ? v : Number(v);
  const amount = num(body.amount);
  const counter_amount = num(body.counter_amount);
  const currencyRaw = body.currency ?? null;
  const counterCurrencyRaw = body.counter_currency ?? null;
  if (currencyRaw != null && !isMovementCurrency(currencyRaw)) {
    return { error: `currency must be one of clp/usd/eur.` };
  }
  if (counterCurrencyRaw != null && !isMovementCurrency(counterCurrencyRaw)) {
    return { error: `counter_currency must be one of clp/usd/eur.` };
  }
  if (currencyRaw === "eur" || counterCurrencyRaw === "eur") {
    return { error: "eur movements are not supported yet." };
  }
  if (amount != null && currencyRaw == null) {
    return { error: "currency is required when amount is set." };
  }
  if ((counter_amount != null) !== (counterCurrencyRaw != null)) {
    return { error: "counter_amount and counter_currency must be set together." };
  }
  return {
    amount,
    currency: (currencyRaw as MovementCurrency | null) ?? null,
    counter_amount,
    counter_currency: (counterCurrencyRaw as MovementCurrency | null) ?? null,
  };
}

/** The request's leg in `currency`, or null — mirrors movementAmounts.legOf for parsed input. */
function parsedLeg(fields: ParsedAmountFields, currency: MovementCurrency): number | null {
  if (fields.currency === currency) return fields.amount;
  if (fields.counter_currency === currency) return fields.counter_amount;
  return null;
}

/** Quote currency of the stock leg on a trade transfer (buy: to_account, sell/dividend: from_account). */
function stockTradeQuoteCurrency(input: TransferCreateInput): "usd" | "clp" {
  const stockAccountId =
    input.flow_kind === "stock_buy" ? input.to_account_id : input.from_account_id;
  const ticker = input.ticker?.trim() || equityTickerForAccount(stockAccountId);
  if (!ticker) return "usd";
  return equityQuoteCurrency(ticker);
}

function transferInputLeg(input: TransferCreateInput, currency: MovementCurrency): number | null {
  if (input.currency === currency) return input.amount;
  if (input.counter_currency === currency) return input.counter_amount;
  return null;
}

function validateBrokerageTransferEndpoints(
  input: TransferCreateInput
): MovementCreateValidation | null {
  const fk = input.flow_kind;
  const inputClpLeg = transferInputLeg(input, "clp");
  const inputUsdLeg = transferInputLeg(input, "usd");
  const tradeQuoteCurrency =
    fk === "stock_buy" || fk === "stock_sell" || fk === "dividend_payout"
      ? stockTradeQuoteCurrency(input)
      : null;
  // Fail fast on a leg that doesn't belong to the flow kind (e.g. a stale value left in a
  // hidden input on the client): the amount must be in the stock's quote currency, never both.
  if (fk === "stock_buy" || fk === "stock_sell" || fk === "dividend_payout") {
    if (tradeQuoteCurrency === "usd" && inputClpLeg != null && inputClpLeg !== 0) {
      return {
        ok: false,
        status: 400,
        error: `a CLP amount is not allowed on ${fk} for a USD-quoted stock (a CLP wire is a separate compra_usd_venta_clp movement).`,
      };
    }
    if (tradeQuoteCurrency === "clp" && inputUsdLeg != null && inputUsdLeg !== 0) {
      return {
        ok: false,
        status: 400,
        error: `a USD amount is not allowed on ${fk} for a CLP-quoted stock (trade settles in CLP).`,
      };
    }
  }
  if (fk === "dividend_payout" && input.units_delta != null && input.units_delta !== 0) {
    return {
      ok: false,
      status: 400,
      error: "units_delta is not allowed on dividend_payout (a cash dividend does not change share units).",
    };
  }
  if (fk === "compra_usd_venta_clp") {
    // With a counterpart, this is a CLP→USD conversion moving money between two cash accounts:
    // debit CLP from the source (from_account), credit USD to the USD cash account (to_account).
    if (!isUsdCashAccount(input.to_account_id)) {
      return {
        ok: false,
        status: 400,
        error: "compra_usd_venta_clp must credit the bought USD to a USD cash account (to_account).",
      };
    }
    if (isUsdCashAccount(input.from_account_id)) {
      return {
        ok: false,
        status: 400,
        error: "compra_usd_venta_clp from_account must be the CLP source account, not USD cash.",
      };
    }
    if (input.currency !== "clp" || input.amount === 0) {
      return {
        ok: false,
        status: 400,
        error: "compra_usd_venta_clp requires amount in CLP (the CLP spent, the from-leg).",
      };
    }
    if (input.counter_currency !== "usd" || input.counter_amount == null || input.counter_amount === 0) {
      return {
        ok: false,
        status: 400,
        error: "compra_usd_venta_clp requires counter_amount in USD (the USD bought, the to-leg).",
      };
    }
    return null;
  }
  if (fk === "stock_buy") {
    if (tradeQuoteCurrency === "clp") {
      if (!isClpCashAccount(input.from_account_id)) {
        return {
          ok: false,
          status: 400,
          error:
            "stock_buy for a CLP-quoted stock must transfer from CLP cash (from_account) to the stock account (to_account).",
        };
      }
      if (inputClpLeg == null || inputClpLeg === 0) {
        return {
          ok: false,
          status: 400,
          error: "a CLP amount (CLP spent) is required for a CLP-quoted stock_buy.",
        };
      }
    } else if (!isUsdCashAccount(input.from_account_id)) {
      return {
        ok: false,
        status: 400,
        error: "stock_buy must transfer from USD cash (from_account) to the stock account (to_account).",
      };
    }
    const toRow = accountRowForId(input.to_account_id);
    if (!toRow || !accountUsesBrokerageFlowKinds(toRow)) {
      return {
        ok: false,
        status: 400,
        error: "stock_buy to_account must be an equity brokerage account.",
      };
    }
  }
  if (fk === "stock_sell") {
    if (tradeQuoteCurrency === "clp") {
      if (!isClpCashAccount(input.to_account_id)) {
        return {
          ok: false,
          status: 400,
          error: "stock_sell for a CLP-quoted stock must transfer proceeds to CLP cash (to_account).",
        };
      }
      if (inputClpLeg == null || inputClpLeg === 0) {
        return {
          ok: false,
          status: 400,
          error: "a CLP amount (CLP proceeds) is required for a CLP-quoted stock_sell.",
        };
      }
    } else if (!isUsdCashAccount(input.to_account_id)) {
      return {
        ok: false,
        status: 400,
        error: "stock_sell must transfer proceeds to USD cash (to_account).",
      };
    }
    const fromRow = accountRowForId(input.from_account_id);
    if (!fromRow || !accountUsesBrokerageFlowKinds(fromRow)) {
      return {
        ok: false,
        status: 400,
        error: "stock_sell from_account must be an equity brokerage account.",
      };
    }
  }
  if (fk === "dividend_payout") {
    if (tradeQuoteCurrency === "clp") {
      return {
        ok: false,
        status: 400,
        error:
          "dividend_payout is not supported for CLP-quoted stocks yet (USD dividends only).",
      };
    }
    if (!isUsdCashAccount(input.to_account_id)) {
      return {
        ok: false,
        status: 400,
        error: "dividend_payout must credit the cash dividend to USD cash (to_account).",
      };
    }
    const fromRow = accountRowForId(input.from_account_id);
    if (!fromRow || !accountUsesBrokerageFlowKinds(fromRow)) {
      return {
        ok: false,
        status: 400,
        error: "dividend_payout from_account must be an equity brokerage account (the paying stock).",
      };
    }
    if (inputUsdLeg == null || inputUsdLeg === 0) {
      return { ok: false, status: 400, error: "a USD amount is required for dividend_payout." };
    }
  }
  return null;
}

function validateBrokerageMovementCreate(
  account: AccountRow,
  body: Record<string, unknown>,
  defaultTicker: string | null
): MovementCreateValidation {
  const schema = movementCreateSchemaForAccount(account);
  if (!schema?.brokerage_flow_kinds) {
    return {
      ok: false,
      status: 400,
      error: "Brokerage flows are only supported for equity brokerage accounts.",
    };
  }

  const flow_kind = typeof body.flow_kind === "string" ? body.flow_kind : "";
  const occurred_on = typeof body.occurred_on === "string" ? body.occurred_on.trim() : "";

  if (!occurred_on || !/^\d{4}-\d{2}-\d{2}$/.test(occurred_on)) {
    return { ok: false, status: 400, error: "occurred_on is required (YYYY-MM-DD)." };
  }
  if (!flow_kind || !(BROKERAGE_FLOW_KINDS as readonly string[]).includes(flow_kind)) {
    return { ok: false, status: 400, error: "occurred_on and valid flow_kind are required." };
  }
  if (flow_kind === "stock_buy" || flow_kind === "stock_sell") {
    return {
      ok: false,
      status: 400,
      error: `${flow_kind} requires counterpart_account_id (USD cash transfer).`,
    };
  }
  if (flow_kind === "dividend_payout") {
    return {
      ok: false,
      status: 400,
      error: "dividend_payout requires counterpart_account_id (stock → USD cash transfer).",
    };
  }
  if (flow_kind === "compra_usd_venta_clp") {
    // A cross-currency conversion always moves money between two accounts; the single-leg
    // form cannot carry the counter leg (schema CHECK) and no such rows exist.
    return {
      ok: false,
      status: 400,
      error: "compra_usd_venta_clp requires counterpart_account_id (CLP cash → USD cash transfer).",
    };
  }

  const parsed = parseAmountFields(body);
  if ("error" in parsed) return { ok: false, status: 400, error: parsed.error };
  if (parsed.counter_amount != null) {
    return { ok: false, status: 400, error: "counter_amount is only supported on cross-currency transfers." };
  }
  const amount_clp = parsedLeg(parsed, "clp");
  const amount_usd = parsedLeg(parsed, "usd");

  const unitsRawEarly = parseUnitsDeltaField(body);
  const unitsProvidedEarly = unitsRawEarly !== undefined && unitsRawEarly !== null;
  const sharePurchaseStockBuy =
    flow_kind === "stock_buy" && unitsProvidedEarly && !unitsValueInvalid(unitsRawEarly!);
  const legacySharePurchaseCompraUsd =
    flow_kind === "compra_usd" && unitsProvidedEarly && !unitsValueInvalid(unitsRawEarly!);

  if (parsed.amount == null || parsed.amount === 0) {
    if (!sharePurchaseStockBuy && !legacySharePurchaseCompraUsd) {
      return { ok: false, status: 400, error: "amount (with currency) is required." };
    }
  }

  const tickerRaw = body.ticker;
  const ticker =
    typeof tickerRaw === "string" && tickerRaw.trim()
      ? tickerRaw.trim().toUpperCase()
      : defaultTicker;
  const note = typeof body.note === "string" ? body.note : body.note == null ? null : String(body.note);

  const unitsRaw = parseUnitsDeltaField(body);
  const unitsProvided = unitsRaw !== undefined;
  const unitsRequired =
    flow_kind === "stock_buy" ||
    (flow_kind === "compra_usd" && unitsProvided && unitsRaw !== null);

  if (unitsRequired) {
    if (!unitsProvided || unitsRaw === null) {
      return {
        ok: false,
        status: 400,
        error: `units_delta (or unit_amount) is required for flow_kind ${flow_kind} (${schema.unit_label}).`,
      };
    }
    if (unitsValueInvalid(unitsRaw)) {
      return {
        ok: false,
        status: 400,
        error: `units_delta must be a non-zero number (${schema.unit_label} bought or credited).`,
      };
    }
    return {
      ok: true,
      mode: "brokerage",
      occurred_on,
      flow_kind,
      ...brokerageNativeAmount(flow_kind, parsed, amount_clp, amount_usd),
      counter_amount: null,
      counter_currency: null,
      ticker,
      note,
      units_delta: unitsRaw,
    };
  }

  if (unitsProvided && unitsRaw !== null && unitsValueInvalid(unitsRaw)) {
    return {
      ok: false,
      status: 400,
      error: "units_delta must be a non-zero number when provided.",
    };
  }

  return {
    ok: true,
    mode: "brokerage",
    occurred_on,
    flow_kind,
    ...brokerageNativeAmount(flow_kind, parsed, amount_clp, amount_usd),
    counter_amount: null,
    counter_currency: null,
    ticker,
    note,
    units_delta: unitsProvided && unitsRaw !== null ? unitsRaw : null,
  };
}

/**
 * Native single-leg amount for a brokerage/cash flow row. USD rows store the request
 * amount as passed; CLP rows keep the legacy sign convention baked at create
 * (deposit +, withdrawal −, conversion −). A row with no amount (share-only purchase)
 * stores a 0-CLP amount, matching the legacy amount_clp NOT NULL DEFAULT 0.
 */
function brokerageNativeAmount(
  flow_kind: string,
  parsed: ParsedAmountFields,
  clpLeg: number | null,
  usdLeg: number | null
): { amount: number; currency: MovementCurrency } {
  if (parsed.currency === "usd" && parsed.amount != null) {
    return { amount: parsed.amount, currency: "usd" };
  }
  return { amount: signedAmountClpForBrokerageFlow(flow_kind, clpLeg, usdLeg), currency: "clp" };
}

function validateUsdCashMovementCreate(
  account: AccountRow,
  body: Record<string, unknown>
): MovementCreateValidation {
  const schema = movementCreateSchemaForAccount(account);
  if (!schema?.brokerage_flow_kinds) {
    return { ok: false, status: 400, error: "USD cash flows are only supported for USD cash accounts." };
  }
  const flow_kind = typeof body.flow_kind === "string" ? body.flow_kind : "";
  const occurred_on = typeof body.occurred_on === "string" ? body.occurred_on.trim() : "";
  if (!occurred_on || !/^\d{4}-\d{2}-\d{2}$/.test(occurred_on)) {
    return { ok: false, status: 400, error: "occurred_on is required (YYYY-MM-DD)." };
  }
  if (!flow_kind || !(schema.brokerage_flow_kinds as readonly string[]).includes(flow_kind)) {
    return { ok: false, status: 400, error: "occurred_on and valid flow_kind are required." };
  }
  const parsed = parseAmountFields(body);
  if ("error" in parsed) return { ok: false, status: 400, error: parsed.error };
  if (parsed.counter_amount != null) {
    return { ok: false, status: 400, error: "counter_amount is only supported on cross-currency transfers." };
  }
  const amount_clp = parsedLeg(parsed, "clp");
  const amount_usd = parsedLeg(parsed, "usd");
  const unitsRaw = parseUnitsDeltaField(body);
  if (unitsRaw !== undefined && unitsRaw !== null && !unitsValueInvalid(unitsRaw)) {
    return { ok: false, status: 400, error: "units_delta is not supported on USD cash accounts." };
  }
  if (flow_kind === "compra_usd_venta_clp") {
    // A conversion always moves money between two accounts; the single-leg form cannot
    // carry the counter leg (schema CHECK) and no such rows exist.
    return {
      ok: false,
      status: 400,
      error: "compra_usd_venta_clp requires counterpart_account_id (CLP cash → USD cash transfer).",
    };
  }
  if (flow_kind === "withdrawal_usd" && (amount_usd == null || amount_usd === 0)) {
    return { ok: false, status: 400, error: "a USD amount is required for withdrawal_usd." };
  }
  if (flow_kind === "savings_earnings" && (amount_usd == null || amount_usd === 0)) {
    return { ok: false, status: 400, error: "a USD amount is required for savings_earnings (interest received in USD)." };
  }
  if (flow_kind === "compra_usd" && (amount_usd == null || amount_usd === 0)) {
    return { ok: false, status: 400, error: "a USD amount is required for compra_usd." };
  }
  if (
    (flow_kind === "deposit_clp" || flow_kind === "withdrawal_clp") &&
    (amount_clp == null || amount_clp === 0)
  ) {
    return { ok: false, status: 400, error: "a CLP amount is required." };
  }
  const note = typeof body.note === "string" ? body.note : body.note == null ? null : String(body.note);
  return {
    ok: true,
    mode: "brokerage",
    occurred_on,
    flow_kind,
    ...(parsed.currency === "usd" && parsed.amount != null
      ? { amount: Math.abs(parsed.amount), currency: "usd" as const }
      : { amount: signedAmountClpForBrokerageFlow(flow_kind, amount_clp, amount_usd), currency: "clp" as const }),
    counter_amount: null,
    counter_currency: null,
    ticker: null,
    note,
    units_delta: null,
  };
}

function validateClpCashMovementCreate(
  account: AccountRow,
  body: Record<string, unknown>
): MovementCreateValidation {
  const schema = movementCreateSchemaForAccount(account);
  if (!schema?.brokerage_flow_kinds) {
    return { ok: false, status: 400, error: "CLP cash flows are only supported for CLP cash accounts." };
  }
  const flow_kind = typeof body.flow_kind === "string" ? body.flow_kind : "";
  const occurred_on = typeof body.occurred_on === "string" ? body.occurred_on.trim() : "";
  if (!occurred_on || !/^\d{4}-\d{2}-\d{2}$/.test(occurred_on)) {
    return { ok: false, status: 400, error: "occurred_on is required (YYYY-MM-DD)." };
  }
  if (!flow_kind || !(schema.brokerage_flow_kinds as readonly string[]).includes(flow_kind)) {
    return { ok: false, status: 400, error: "occurred_on and valid flow_kind are required." };
  }
  const parsed = parseAmountFields(body);
  if ("error" in parsed) return { ok: false, status: 400, error: parsed.error };
  if (parsed.counter_amount != null) {
    return { ok: false, status: 400, error: "counter_amount is only supported on cross-currency transfers." };
  }
  if (parsed.currency != null && parsed.currency !== "clp") {
    return { ok: false, status: 400, error: "CLP cash movements must be denominated in CLP." };
  }
  const amount_clp = parsedLeg(parsed, "clp");
  const unitsRaw = parseUnitsDeltaField(body);
  if (unitsRaw !== undefined && unitsRaw !== null && !unitsValueInvalid(unitsRaw)) {
    return { ok: false, status: 400, error: "units_delta is not supported on CLP cash accounts." };
  }
  if (amount_clp == null || amount_clp === 0 || !Number.isFinite(amount_clp)) {
    return { ok: false, status: 400, error: "a CLP amount is required." };
  }
  const note = typeof body.note === "string" ? body.note : body.note == null ? null : String(body.note);
  return {
    ok: true,
    mode: "brokerage",
    occurred_on,
    flow_kind,
    amount: signedAmountClpForBrokerageFlow(flow_kind, amount_clp, null),
    currency: "clp",
    counter_amount: null,
    counter_currency: null,
    ticker: null,
    note,
    units_delta: null,
  };
}

function parseCounterpartAccountId(body: Record<string, unknown>): number | null {
  const raw = body.counterpart_account_id;
  if (raw === undefined || raw === null) return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function validateTransferMovementCreate(
  currentAccountId: number,
  body: Record<string, unknown>
): MovementCreateValidation {
  const counterpartAccountId = parseCounterpartAccountId(body);
  if (counterpartAccountId == null) {
    return { ok: false, status: 400, error: "counterpart_account_id must be a positive number." };
  }
  const roleRaw = body.counterpart_role;
  const counterpart_role =
    roleRaw === "from" || roleRaw === "to" ? roleRaw : ("to" as const);
  let endpoints: { from_account_id: number; to_account_id: number };
  try {
    endpoints = resolveTransferEndpoints(currentAccountId, counterpartAccountId, counterpart_role);
  } catch (e) {
    return { ok: false, status: 400, error: e instanceof Error ? e.message : String(e) };
  }

  const occurred_on = typeof body.occurred_on === "string" ? body.occurred_on.trim() : "";
  const parsed = parseAmountFields(body);
  if ("error" in parsed) return { ok: false, status: 400, error: parsed.error };
  const clpLegRaw = parsedLeg(parsed, "clp");
  const unitsRaw = parseUnitsDeltaField(body);
  const flow_kind_raw = typeof body.flow_kind === "string" && body.flow_kind.trim() ? body.flow_kind.trim() : null;
  const unitsProvided = unitsRaw !== undefined && unitsRaw !== null && !unitsValueInvalid(unitsRaw);
  const currentRow = accountRowForId(currentAccountId);
  const currentSchema = currentRow ? movementCreateSchemaForAccount(currentRow) : null;
  const isManualUnitsAccount =
    !!currentSchema && currentSchema.units_delta === "required" && !currentSchema.brokerage_flow_kinds;

  let flow_kind = flow_kind_raw;
  if (isManualUnitsAccount) {
    if (!unitsProvided) {
      return {
        ok: false,
        status: 400,
        error: `units_delta is required for this account (${currentSchema!.unit_label}).`,
      };
    }
    if (clpLegRaw == null || !Number.isFinite(clpLegRaw) || clpLegRaw === 0) {
      return { ok: false, status: 400, error: "a CLP amount is required." };
    }
    try {
      assertManualUnitsClpReconcile({
        accountId: currentAccountId,
        ymd: occurred_on,
        amountClpAbs: Math.abs(clpLegRaw),
        unitsAbs: Math.abs(unitsRaw!),
      });
    } catch (e) {
      return { ok: false, status: 400, error: e instanceof Error ? e.message : String(e) };
    }
    // Fintual/crypto/AFP transfers carry cuotas but no equity flow_kind; the sign is derived from the leg.
  } else if (unitsProvided && flow_kind == null) {
    flow_kind = unitsRaw! > 0 ? "stock_buy" : "stock_sell";
  }
  const tickerRaw = body.ticker;
  let ticker =
    typeof tickerRaw === "string" && tickerRaw.trim() ? tickerRaw.trim().toUpperCase() : null;
  // Default the ticker from the equity account on share trades (the client may not know it on the
  // first buy, before a position exists): stock_buy → to_account, stock_sell → from_account.
  if (ticker == null && (flow_kind === "stock_buy" || flow_kind === "stock_sell")) {
    const equityAccountId =
      flow_kind === "stock_buy" ? endpoints.to_account_id : endpoints.from_account_id;
    ticker = equityTickerForAccount(equityAccountId);
  }
  const note = typeof body.note === "string" ? body.note : body.note == null ? null : String(body.note);

  // Transfers store positive amounts (direction lives in from/to); units-only transfers
  // keep the legacy 0-CLP amount.
  const input: TransferCreateInput = {
    from_account_id: endpoints.from_account_id,
    to_account_id: endpoints.to_account_id,
    occurred_on,
    note,
    amount: parsed.amount != null && Number.isFinite(parsed.amount) ? Math.abs(parsed.amount) : 0,
    currency: parsed.currency ?? "clp",
    counter_amount:
      parsed.counter_amount != null && Number.isFinite(parsed.counter_amount)
        ? Math.abs(parsed.counter_amount)
        : null,
    counter_currency: parsed.counter_amount != null ? parsed.counter_currency : null,
    units_delta:
      unitsRaw !== undefined && unitsRaw !== null && !unitsValueInvalid(unitsRaw)
        ? isManualUnitsAccount
          ? Math.abs(unitsRaw)
          : unitsRaw
        : null,
    flow_kind,
    ticker,
  };
  try {
    validateTransferCreate(input);
  } catch (e) {
    return { ok: false, status: 400, error: e instanceof Error ? e.message : String(e) };
  }
  if (!isManualUnitsAccount) {
    const endpointErr = validateBrokerageTransferEndpoints(input);
    if (endpointErr) return endpointErr;
  }

  return {
    ok: true,
    mode: "transfer",
    from_account_id: input.from_account_id,
    to_account_id: input.to_account_id,
    amount: input.amount,
    currency: input.currency,
    counter_amount: input.counter_amount,
    counter_currency: input.counter_currency,
    occurred_on: input.occurred_on,
    note: input.note,
    units_delta: input.units_delta,
    flow_kind: input.flow_kind,
    ticker: input.ticker,
  };
}

export function validateMovementCreate(
  account: AccountRow,
  body: Record<string, unknown>,
  currentAccountId?: number
): MovementCreateValidation {
  if (parseCounterpartAccountId(body) != null) {
    if (currentAccountId == null || currentAccountId <= 0) {
      return { ok: false, status: 400, error: "currentAccountId is required for transfers." };
    }
    return validateTransferMovementCreate(currentAccountId, body);
  }
  if (accountUsesBrokerageFlowKinds(account)) {
    const defaultTicker = account.equity_ticker?.trim().toUpperCase() ?? null;
    return validateBrokerageMovementCreate(account, body, defaultTicker);
  }
  if (accountUsesUsdCashFlowKinds(account)) {
    return validateUsdCashMovementCreate(account, body);
  }
  if (accountUsesClpCashFlowKinds(account)) {
    return validateClpCashMovementCreate(account, body);
  }

  const parsed = parseAmountFields(body);
  if ("error" in parsed) return { ok: false, status: 400, error: parsed.error };
  if (parsed.counter_amount != null) {
    return { ok: false, status: 400, error: "counter_amount is only supported on cross-currency transfers." };
  }
  if (parsed.currency != null && parsed.currency !== "clp") {
    return { ok: false, status: 400, error: "This account's movements must be denominated in CLP." };
  }
  const amount_clp = parsed.amount;
  const occurred_on = typeof body.occurred_on === "string" ? body.occurred_on.trim() : "";
  const note = typeof body.note === "string" ? body.note : body.note == null ? null : String(body.note);

  if (amount_clp == null || !Number.isFinite(amount_clp) || amount_clp === 0) {
    return {
      ok: false,
      status: 400,
      error: "amount must be a non-zero number (positive = deposit, negative = withdrawal).",
    };
  }
  if (!occurred_on || !/^\d{4}-\d{2}-\d{2}$/.test(occurred_on)) {
    return { ok: false, status: 400, error: "occurred_on is required (YYYY-MM-DD)." };
  }

  const schema = movementCreateSchemaForAccount(account);
  const unitsRaw = parseUnitsDeltaField(body);
  const unitsProvided = unitsRaw !== undefined;

  if (schema?.units_delta === "required") {
    if (!unitsProvided || unitsRaw === null) {
      return {
        ok: false,
        status: 400,
        error: `units_delta (or unit_amount) is required for this account (${schema.unit_label}).`,
      };
    }
    if (unitsValueInvalid(unitsRaw)) {
      return {
        ok: false,
        status: 400,
        error: `units_delta must be a non-zero number (${schema.unit_label} gained or lost on this movement).`,
      };
    }
    return {
      ok: true,
      mode: "standard",
      amount: amount_clp,
      currency: "clp",
      occurred_on,
      note,
      units_delta: unitsRaw,
      flow_kind: null,
      counter_amount: null,
      counter_currency: null,
      ticker: null,
    };
  }

  if (unitsProvided && unitsRaw !== null && unitsValueInvalid(unitsRaw)) {
    return {
      ok: false,
      status: 400,
      error: "units_delta must be a non-zero number when provided.",
    };
  }

  return {
    ok: true,
    mode: "standard",
    amount: amount_clp,
    currency: "clp",
    occurred_on,
    note,
    units_delta: unitsProvided && unitsRaw !== null ? unitsRaw : null,
    flow_kind: null,
    counter_amount: null,
    counter_currency: null,
    ticker: null,
  };
}
