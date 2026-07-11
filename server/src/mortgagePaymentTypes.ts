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
  /**
   * Bank "cuota mínima" (the scheduled French-amortization payment) in UF. Required to
   * split amortización from the prepago (amortización extra) unless `amortizacion_ext_clp`
   * is given directly. This is a real figure off the statement — there is no formula
   * fallback (the scenario table's model rate diverges from the bank's by a few CLP).
   */
  min_uf?: number | null;
  amortizacion_ext_clp?: number | null;
};
