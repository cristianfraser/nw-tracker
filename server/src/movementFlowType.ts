import {
  DEPOSIT_FLOW_KIND_PERSONAL,
  DEPOSIT_FLOW_KIND_STATE,
  DEPOSIT_FLOW_KIND_TRASPASO,
  depositFlowKindLabel,
  isDepositFlowKind,
  type DepositFlowKind,
} from "./depositFlowKind.js";
import {
  BROKERAGE_FLOW_KIND_LABELS,
  type CurrencyNamedFlowKind,
  isBrokerageFlowKind,
  type BrokerageFlowKind,
} from "./brokerageFlowMovement.js";

export const FLOW_KIND_PAGO_CUOTA_HIPOTECARIO = "pago_cuota_hipotecario" as const;
/** Checking→CC payment mirror transfer (ccPaymentMirrors.ts) — internal to the CC-netted cash bucket. */
export const FLOW_KIND_PAGO_TARJETA = "pago_tarjeta" as const;
export const FLOW_KIND_PREPAGO_PARCIAL_HIPOTECARIO = "prepago_parcial_hipotecario" as const;
/**
 * Card → own cash account load (a MACH top-up paid with the card): the card leg is inert, as for
 * `pago_tarjeta` — card flows come from statement evidence — and the cash leg is its deposit.
 */
export const FLOW_KIND_CARGA_TARJETA = "carga_tarjeta" as const;
/**
 * AFP fund switch: a transfer between two cuota accounts carrying both counts — the cuotas
 * sold on the from-leg (`units_delta`) and the cuotas bought on the to-leg
 * (`counter_units_delta`). Ordinary transfer legs to every flow reader (a withdrawal from the
 * sender, a deposit into the receiver; inside the AFP group they cancel).
 */
export const FLOW_KIND_AFP_FUND_SWITCH = "afp_fund_switch" as const;
/** A stock split's new shares on the holder (`equitySplits.ts`): units only, no money. */
export const FLOW_KIND_STOCK_SPLIT = "stock_split" as const;

export type MortgageFlowKind =
  | typeof FLOW_KIND_PAGO_CUOTA_HIPOTECARIO
  | typeof FLOW_KIND_PREPAGO_PARCIAL_HIPOTECARIO;

export type MovementFlowType =
  | DepositFlowKind
  | MortgageFlowKind
  | BrokerageFlowKind
  | typeof FLOW_KIND_PAGO_TARJETA
  | typeof FLOW_KIND_CARGA_TARJETA
  | typeof FLOW_KIND_AFP_FUND_SWITCH
  | typeof FLOW_KIND_STOCK_SPLIT
  | "withdrawal"
  | "deposit"
  | "other";

/**
 * The type of a transfer shown once, between two accounts of the same page (group flows). A
 * kind-less transfer has no side to call it a deposit or a withdrawal from: in one currency it
 * is «Traspaso <CODE>» (`internal_transfer_<code>`, any currency), between two currencies a
 * «Cambio de divisas» whatever the pair (the amount column shows it). A kind that reads the same
 * from either side (a share purchase, a dividend, a card payment, …) keeps its type.
 * `originLegType` is the type the origin's leg carries.
 */
export function internalTransferFlowType(
  originLegType: MovementFlowType,
  currency: string,
  counterCurrency: string | null
): { flow_type: string; flow_type_label: string } {
  if (originLegType !== "withdrawal") {
    return {
      flow_type: originLegType,
      flow_type_label: movementFlowTypeLabel(originLegType, { currency, counter_currency: counterCurrency }),
    };
  }
  if (counterCurrency != null && counterCurrency !== currency) {
    return { flow_type: "internal_fx_exchange", flow_type_label: "Cambio de divisas" };
  }
  return { flow_type: `internal_transfer_${currency}`, flow_type_label: `Traspaso ${currency.toUpperCase()}` };
}

function isMortgageFlowKind(flowKind: string | null | undefined): flowKind is MortgageFlowKind {
  return (
    flowKind === FLOW_KIND_PAGO_CUOTA_HIPOTECARIO ||
    flowKind === FLOW_KIND_PREPAGO_PARCIAL_HIPOTECARIO
  );
}

function isDepositMovementFlowType(flowType: MovementFlowType): flowType is DepositFlowKind {
  return (
    flowType === DEPOSIT_FLOW_KIND_PERSONAL ||
    flowType === DEPOSIT_FLOW_KIND_STATE ||
    flowType === DEPOSIT_FLOW_KIND_TRASPASO
  );
}

export function movementFlowTypeFromRow(row: {
  /** Signed CLP delta from the viewing account's perspective (kind-less single-leg rows are all CLP). */
  signed_clp_delta: number;
  flow_kind?: string | null;
  transfer_direction?: "out" | "in" | null;
  /** The movement's own currency: a kind-less transfer is named in it (a dollar transfer is not «CLP»). */
  currency: string;
}): MovementFlowType {
  if (row.transfer_direction === "out" || row.transfer_direction === "in") {
    if (isBrokerageFlowKind(row.flow_kind)) return row.flow_kind;
    if (row.flow_kind === FLOW_KIND_PAGO_TARJETA) return FLOW_KIND_PAGO_TARJETA;
    if (row.flow_kind === FLOW_KIND_CARGA_TARJETA) return FLOW_KIND_CARGA_TARJETA;
    if (row.flow_kind === FLOW_KIND_AFP_FUND_SWITCH) return FLOW_KIND_AFP_FUND_SWITCH;
    // A kind-less transfer's leg: a withdrawal from the sender, a deposit into the receiver, in
    // the movement's own currency (the label names it).
    return row.transfer_direction === "out" ? "withdrawal" : "deposit";
  }
  if (isBrokerageFlowKind(row.flow_kind)) return row.flow_kind;
  if (row.flow_kind === FLOW_KIND_STOCK_SPLIT) return FLOW_KIND_STOCK_SPLIT;
  // Flow kind is resolved at write time and stored in the column (never parsed from the note).
  if (isMortgageFlowKind(row.flow_kind)) return row.flow_kind;
  if (isDepositFlowKind(row.flow_kind)) return row.flow_kind;
  return movementFlowTypeFromSignedClp(row.signed_clp_delta);
}

/** Fallback for movements whose `flow_kind` column is unset: the sign decides. */
export function movementFlowTypeFromSignedClp(signedClpDelta: number): MovementFlowType {
  if (signedClpDelta < 0) return "withdrawal";
  if (signedClpDelta === 0 || !Number.isFinite(signedClpDelta)) return "other";
  return DEPOSIT_FLOW_KIND_PERSONAL;
}

/** The currencies a movement moves: its own, and a conversion's other side. */
export type MovementCurrencies = { currency: string; counter_currency: string | null };

const currencyCode = (c: string): string => c.toUpperCase();

/**
 * A flow type's label. A label that names a currency takes it from the movement, never from the
 * kind's name: «Depósito CLP», «Retiro USD», «Compra USD / Venta CLP» are the codes the row
 * carries, so another currency needs no new label.
 */
export function movementFlowTypeLabel(flowType: MovementFlowType, currencies: MovementCurrencies): string {
  const own = currencyCode(currencies.currency);
  switch (flowType) {
    case "deposit":
      return `Depósito ${own}`;
    case "withdrawal":
      return `Retiro ${own}`;
    case "fx_purchase":
      return `Compra ${currencyCode(currencies.counter_currency ?? currencies.currency)}`;
    case "fx_exchange": {
      if (currencies.counter_currency == null) {
        throw new Error(`A currency purchase without its other currency (${currencies.currency})`);
      }
      return `Compra ${currencyCode(currencies.counter_currency)} / Venta ${own}`;
    }
  }
  if (isBrokerageFlowKind(flowType)) {
    return BROKERAGE_FLOW_KIND_LABELS[flowType as Exclude<typeof flowType, CurrencyNamedFlowKind>];
  }
  const label = flowType as string;
  if (label === FLOW_KIND_PAGO_CUOTA_HIPOTECARIO) return "Pago cuota hipotecario";
  if (label === FLOW_KIND_PAGO_TARJETA) return "Pago tarjeta";
  if (label === FLOW_KIND_CARGA_TARJETA) return "Carga desde tarjeta";
  if (label === FLOW_KIND_AFP_FUND_SWITCH) return "Traspaso AFP";
  if (label === FLOW_KIND_STOCK_SPLIT) return "División de acciones";
  if (label === FLOW_KIND_PREPAGO_PARCIAL_HIPOTECARIO) return "Prepago parcial hipotecario";
  if (isDepositMovementFlowType(flowType)) {
    return depositFlowKindLabel(flowType);
  }
  return "Otro";
}
