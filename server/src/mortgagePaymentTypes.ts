/** User-provided fields when logging a mortgage cuota in-app. */
export type MortgagePaymentInput = {
  occurred_on: string;
  pago_clp: number;
  interes_clp: number;
  incendio_clp: number;
  /** When omitted, computed from prior balance × desgravamen rate. */
  desgravamen_clp?: number | null;
  /** Auto: last numeric cuota + 1. */
  cuota?: string | null;
  amortizacion_ext_clp?: number | null;
};
