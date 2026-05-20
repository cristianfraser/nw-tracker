/**
 * Which accounts require `units_delta` (shares, coin, Fintual/AFP cuotas) on manual API creates.
 */

export type AccountRow = {
  category_slug: string;
  group_slug: string;
};

export type UnitsFieldRequirement = "required" | "optional";

export type MovementCreateSchema = {
  ledger: "movements";
  units_delta: UnitsFieldRequirement;
  /** Spanish label for API errors / UI hints (e.g. cuotas, acciones, BTC). */
  unit_label: string;
};

export type BrokerageFlowCreateSchema = {
  ledger: "brokerage_flows";
  units_delta: UnitsFieldRequirement;
  unit_label: string;
  /** Flow kinds that must include `units_delta` (share-changing). */
  units_required_for_flow_kinds: readonly string[];
};

const MOVEMENTS_UNITS_BY_CATEGORY: Record<string, { unit_label: string }> = {
  afp: { unit_label: "cuotas" },
  bitcoin: { unit_label: "BTC" },
  eth: { unit_label: "ETH" },
  fintual_risky_norris: { unit_label: "cuotas" },
  fondo_reserva: { unit_label: "cuotas" },
  apv: { unit_label: "cuotas" },
};

const BROKERAGE_TICKER_SLUGS = new Set(["spy", "vea"]);

export const BROKERAGE_UNITS_REQUIRED_FLOW_KINDS = ["compra_usd", "dividend_usd"] as const;

export function movementCreateSchemaForAccount(account: AccountRow): MovementCreateSchema | null {
  if (BROKERAGE_TICKER_SLUGS.has(account.category_slug)) {
    return null;
  }
  const spec = MOVEMENTS_UNITS_BY_CATEGORY[account.category_slug];
  if (!spec) {
    return { ledger: "movements", units_delta: "optional", unit_label: "unidades" };
  }
  return { ledger: "movements", units_delta: "required", unit_label: spec.unit_label };
}

export function brokerageFlowCreateSchemaForAccount(
  account: AccountRow
): BrokerageFlowCreateSchema | null {
  if (!BROKERAGE_TICKER_SLUGS.has(account.category_slug)) {
    return null;
  }
  return {
    ledger: "brokerage_flows",
    units_delta: "optional",
    unit_label: "acciones",
    units_required_for_flow_kinds: BROKERAGE_UNITS_REQUIRED_FLOW_KINDS,
  };
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
  | { ok: true; amount_clp: number; occurred_on: string; note: string | null; units_delta: number | null }
  | { ok: false; status: number; error: string };

export function validateMovementCreate(
  account: AccountRow,
  body: Record<string, unknown>
): MovementCreateValidation {
  if (BROKERAGE_TICKER_SLUGS.has(account.category_slug)) {
    return {
      ok: false,
      status: 400,
      error:
        "This account uses brokerage flows (SPY/VEA). POST /api/accounts/:id/brokerage-flows with flow_kind, amount_clp or amount_usd, and units_delta when buying shares.",
    };
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
    return { ok: true, amount_clp, occurred_on, note, units_delta: unitsRaw };
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
    amount_clp,
    occurred_on,
    note,
    units_delta: unitsProvided && unitsRaw !== null ? unitsRaw : null,
  };
}

export type BrokerageFlowCreateValidation =
  | {
      ok: true;
      occurred_on: string;
      flow_kind: string;
      amount_clp: number | null;
      amount_usd: number | null;
      ticker: string | null;
      note: string | null;
      units_delta: number | null;
    }
  | { ok: false; status: number; error: string };

export function validateBrokerageFlowCreate(
  account: AccountRow,
  body: Record<string, unknown>
): BrokerageFlowCreateValidation {
  const schema = brokerageFlowCreateSchemaForAccount(account);
  if (!schema) {
    return {
      ok: false,
      status: 400,
      error: "Brokerage flows are only supported for SPY and VEA accounts.",
    };
  }

  const kinds = ["deposit_clp", "compra_usd", "dividend_usd", "withdrawal_clp", "other"];
  const flow_kind = typeof body.flow_kind === "string" ? body.flow_kind : "";
  const occurred_on = typeof body.occurred_on === "string" ? body.occurred_on.trim() : "";

  if (!occurred_on || !/^\d{4}-\d{2}-\d{2}$/.test(occurred_on)) {
    return { ok: false, status: 400, error: "occurred_on is required (YYYY-MM-DD)." };
  }
  if (!flow_kind || !kinds.includes(flow_kind)) {
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

  if ((amount_clp == null || amount_clp === 0) && (amount_usd == null || amount_usd === 0)) {
    return { ok: false, status: 400, error: "amount_clp or amount_usd is required." };
  }

  const ticker = typeof body.ticker === "string" ? body.ticker : body.ticker == null ? null : String(body.ticker);
  const note = typeof body.note === "string" ? body.note : body.note == null ? null : String(body.note);

  const unitsRequired = (BROKERAGE_UNITS_REQUIRED_FLOW_KINDS as readonly string[]).includes(flow_kind);
  const unitsRaw = parseUnitsDeltaField(body);
  const unitsProvided = unitsRaw !== undefined;

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
      occurred_on,
      flow_kind,
      amount_clp,
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
    occurred_on,
    flow_kind,
    amount_clp,
    amount_usd,
    ticker,
    note,
    units_delta: unitsProvided && unitsRaw !== null ? unitsRaw : null,
  };
}
