/**
 * Which accounts require `units_delta` (shares, coin, Fintual/AFP cuotas) on manual API creates.
 */

import { accountUsesBrokerageFlowKinds } from "./accountBrokerageFlows.js";
import { accountUsesUsdCashFlowKinds } from "./accountUsdCashFlows.js";
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
import { accountBucketKindSlug } from "./accountBucket.js";
import { isUsdCashAccount } from "./usdCashAccounts.js";
export type AccountRow = {
  bucket_slug: string;
  group_slug: string;
  notes?: string | null;
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
        "withdrawal_usd",
        "withdrawal_clp",
        "other",
      ],
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
      amount_clp: number;
      occurred_on: string;
      note: string | null;
      units_delta: number | null;
      flow_kind: null;
      amount_usd: null;
      ticker: null;
    }
  | {
      ok: true;
      mode: "brokerage";
      amount_clp: number;
      occurred_on: string;
      note: string | null;
      units_delta: number | null;
      flow_kind: string;
      amount_usd: number | null;
      ticker: string | null;
    }
  | {
      ok: true;
      mode: "transfer";
      from_account_id: number;
      to_account_id: number;
      amount_clp: number;
      occurred_on: string;
      note: string | null;
      units_delta: number | null;
      flow_kind: string | null;
      amount_usd: number | null;
      ticker: string | null;
    }
  | { ok: false; status: number; error: string };

function validateBrokerageTransferEndpoints(
  input: TransferCreateInput
): MovementCreateValidation | null {
  const fk = input.flow_kind;
  if (fk === "compra_usd_venta_clp") {
    return {
      ok: false,
      status: 400,
      error: "compra_usd_venta_clp must be posted on the USD cash account without a counterpart transfer.",
    };
  }
  if (fk === "stock_buy") {
    if (!isUsdCashAccount(input.from_account_id)) {
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
    if (!isUsdCashAccount(input.to_account_id)) {
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

  const amount_clp =
    body.amount_clp === undefined || body.amount_clp === null
      ? null
      : typeof body.amount_clp === "number"
        ? body.amount_clp
        : Number(body.amount_clp);
  const amount_usd =
    body.amount_usd === undefined || body.amount_usd === null
      ? null
      : typeof body.amount_usd === "number"
        ? body.amount_usd
        : Number(body.amount_usd);

  const unitsRawEarly = parseUnitsDeltaField(body);
  const unitsProvidedEarly = unitsRawEarly !== undefined && unitsRawEarly !== null;
  const sharePurchaseStockBuy =
    flow_kind === "stock_buy" && unitsProvidedEarly && !unitsValueInvalid(unitsRawEarly!);
  const legacySharePurchaseCompraUsd =
    flow_kind === "compra_usd" && unitsProvidedEarly && !unitsValueInvalid(unitsRawEarly!);

  if ((amount_clp == null || amount_clp === 0) && (amount_usd == null || amount_usd === 0)) {
    if (!sharePurchaseStockBuy && !legacySharePurchaseCompraUsd && flow_kind !== "dividend_usd") {
      return { ok: false, status: 400, error: "amount_clp or amount_usd is required." };
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
    flow_kind === "dividend_usd" ||
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
      amount_clp: signedAmountClpForBrokerageFlow(flow_kind, amount_clp, amount_usd),
      amount_usd,
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
    amount_clp: signedAmountClpForBrokerageFlow(flow_kind, amount_clp, amount_usd),
    amount_usd,
    ticker,
    note,
    units_delta: unitsProvided && unitsRaw !== null ? unitsRaw : null,
  };
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
  const amount_clp =
    body.amount_clp === undefined || body.amount_clp === null
      ? null
      : typeof body.amount_clp === "number"
        ? body.amount_clp
        : Number(body.amount_clp);
  const amount_usd =
    body.amount_usd === undefined || body.amount_usd === null
      ? null
      : typeof body.amount_usd === "number"
        ? body.amount_usd
        : Number(body.amount_usd);
  const unitsRaw = parseUnitsDeltaField(body);
  if (unitsRaw !== undefined && unitsRaw !== null && !unitsValueInvalid(unitsRaw)) {
    return { ok: false, status: 400, error: "units_delta is not supported on USD cash accounts." };
  }
  if (flow_kind === "withdrawal_usd" && (amount_usd == null || amount_usd === 0)) {
    return { ok: false, status: 400, error: "amount_usd is required for withdrawal_usd." };
  }
  if (flow_kind === "compra_usd_venta_clp") {
    if (amount_usd == null || amount_usd === 0) {
      return { ok: false, status: 400, error: "amount_usd is required for compra_usd_venta_clp." };
    }
    if (amount_clp == null || amount_clp === 0) {
      return { ok: false, status: 400, error: "amount_clp is required for compra_usd_venta_clp." };
    }
  } else if (flow_kind === "compra_usd" && (amount_usd == null || amount_usd === 0)) {
    return { ok: false, status: 400, error: "amount_usd is required for compra_usd." };
  }
  if (
    (flow_kind === "deposit_clp" || flow_kind === "withdrawal_clp") &&
    (amount_clp == null || amount_clp === 0)
  ) {
    return { ok: false, status: 400, error: "amount_clp is required." };
  }
  const note = typeof body.note === "string" ? body.note : body.note == null ? null : String(body.note);
  return {
    ok: true,
    mode: "brokerage",
    occurred_on,
    flow_kind,
    amount_clp: signedAmountClpForBrokerageFlow(flow_kind, amount_clp, amount_usd),
    amount_usd: amount_usd != null ? Math.abs(amount_usd) : null,
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
  const amount_clp_raw =
    body.amount_clp === undefined || body.amount_clp === null
      ? 0
      : typeof body.amount_clp === "number"
        ? body.amount_clp
        : Number(body.amount_clp);
  const amount_usd_raw =
    body.amount_usd === undefined || body.amount_usd === null
      ? null
      : typeof body.amount_usd === "number"
        ? body.amount_usd
        : Number(body.amount_usd);
  const unitsRaw = parseUnitsDeltaField(body);
  const flow_kind_raw = typeof body.flow_kind === "string" && body.flow_kind.trim() ? body.flow_kind.trim() : null;
  const unitsProvided = unitsRaw !== undefined && unitsRaw !== null && !unitsValueInvalid(unitsRaw);
  let flow_kind = flow_kind_raw;
  if (unitsProvided && flow_kind == null) {
    flow_kind = unitsRaw! > 0 ? "stock_buy" : "stock_sell";
  }
  const tickerRaw = body.ticker;
  const ticker =
    typeof tickerRaw === "string" && tickerRaw.trim() ? tickerRaw.trim().toUpperCase() : null;
  const note = typeof body.note === "string" ? body.note : body.note == null ? null : String(body.note);

  const input: TransferCreateInput = {
    from_account_id: endpoints.from_account_id,
    to_account_id: endpoints.to_account_id,
    occurred_on,
    note,
    amount_clp: Number.isFinite(amount_clp_raw) ? Math.abs(amount_clp_raw) : 0,
    amount_usd:
      amount_usd_raw != null && Number.isFinite(amount_usd_raw) ? Math.abs(amount_usd_raw) : null,
    units_delta:
      unitsRaw !== undefined && unitsRaw !== null && !unitsValueInvalid(unitsRaw) ? unitsRaw : null,
    flow_kind,
    ticker,
  };
  try {
    validateTransferCreate(input);
  } catch (e) {
    return { ok: false, status: 400, error: e instanceof Error ? e.message : String(e) };
  }
  const endpointErr = validateBrokerageTransferEndpoints(input);
  if (endpointErr) return endpointErr;

  return {
    ok: true,
    mode: "transfer",
    from_account_id: input.from_account_id,
    to_account_id: input.to_account_id,
    amount_clp: input.amount_clp,
    occurred_on: input.occurred_on,
    note: input.note,
    units_delta: input.units_delta,
    flow_kind: input.flow_kind,
    amount_usd: input.amount_usd,
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

  const amount_clp = typeof body.amount_clp === "number" ? body.amount_clp : Number(body.amount_clp);
  const occurred_on = typeof body.occurred_on === "string" ? body.occurred_on.trim() : "";
  const note = typeof body.note === "string" ? body.note : body.note == null ? null : String(body.note);

  if (
    body.amount_clp === undefined ||
    body.amount_clp === null ||
    !Number.isFinite(amount_clp) ||
    amount_clp === 0
  ) {
    return {
      ok: false,
      status: 400,
      error: "amount_clp must be a non-zero number (positive = deposit, negative = withdrawal).",
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
      amount_clp,
      occurred_on,
      note,
      units_delta: unitsRaw,
      flow_kind: null,
      amount_usd: null,
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
    amount_clp,
    occurred_on,
    note,
    units_delta: unitsProvided && unitsRaw !== null ? unitsRaw : null,
    flow_kind: null,
    amount_usd: null,
    ticker: null,
  };
}
