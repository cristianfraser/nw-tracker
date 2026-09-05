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
  /**
   * Bank-stated «crédito restante» after this payment, in UF. The derived balance
   * (prior − amortización UF legs) can miss the statement by ±0,0001–0,0002 UF because the
   * bank amortizes in UF at higher precision than the CLP components can express; when
   * provided, the stated figure wins so the ledger re-syncs to statement truth each month.
   * Guarded: a stated value farther than a small tolerance from the derived one throws.
   */
  credito_restante_uf?: number | null;
};
