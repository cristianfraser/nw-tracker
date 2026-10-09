/** GET /api/tax-return — the local Formulario 22 (server: f22DraftPayload.ts). */
export type TaxReturnRowSection =
  | "income"
  | "subtotal"
  | "deduction"
  | "tax"
  | "credit"
  | "result"
  | "memo"
  | "payment"
  | "other";

export type TaxReturnRow = {
  code: number;
  section: TaxReturnRowSection;
  filed: number | null;
  informed: number | null;
  draft: number | null;
  changed: boolean;
  informed_mismatch: boolean;
  estimated: boolean;
};

export type TaxReturnCryptoSale = {
  date: string;
  coin: string;
  units: number;
  proceeds_clp: number;
  cost_clp: number;
  cost_reajustado_clp: number;
  gain_clp: number;
  december_pct: number;
  gain_december_clp: number;
};

export type TaxReturnDividend = {
  date: string;
  net_usd: number;
  /** Null until the broker document with the gross / withholding split is imported. */
  gross_usd: number | null;
  withholding_usd: number | null;
  gross_clp: number | null;
  withholding_clp: number | null;
};

export type TaxReturnForeignShareSale = {
  date: string;
  account_name: string;
  units: number;
  gain_usd: number;
  result_clp: { usd_31dic: number; clp_ipc: number };
};

/** An art. 107 LIR instrument: a fund unit (code 1813, art. 107 N°2) or a share (code 1809, N°1). */
export type TaxReturnArt107Sale = {
  date: string;
  account_name: string;
  ticker: string;
  kind: "fund" | "share";
  units: number;
  proceeds_clp: number;
  cost_clp: number;
  cost_reajustado_clp: number;
  /** The 31-December close option's cost; null when no close is stored or the lot was bought in an open year. */
  cost_close_dec31_clp: number | null;
  /** The result under each resident cost option; `close_dec31` is null when its cost is. */
  result_clp: { cost_paid: number; close_dec31: number | null };
  /** By sale date: `tax_10pct` before 2027, `inr` (ingreso no renta, no code) from 2027. */
  regime: "tax_10pct" | "inr";
};

export type TaxReturnArt107Distribution = {
  date: string;
  account_name: string;
  amount_clp: number;
};

/** GET /api/tax-return `art107`: the art. 107 LIR fund and share sales and the fund distributions (server: art107TaxGains.ts). */
export type TaxReturnArt107 = {
  lot_method: "fifo" | "lifo" | "average";
  provisional: boolean;
  /** The sale date from which the mayor valor is ingreso no renta (the reform's vigencia). */
  inr_from: string;
  default_option: "cost_paid" | "close_dec31";
  sales: TaxReturnArt107Sale[];
  /** Results of the `tax_10pct` sales only, under each cost option. */
  totals_clp: { cost_paid: number; close_dec31: number | null };
  /** F22 1814: the year's net art. 107 result under the default option. */
  result_clp: number;
  /** F22 1815: the carried-forward loss, reajustada (≤ 0). */
  carried_loss_clp: number;
  /** Where the carried loss came from: the filed previous return, the app's own result, or none. */
  carried_loss_source: "filed" | "app" | null;
  /** F22 1816: the art. 107 base or loss. */
  base_clp: number;
  /** F22 1830: the 10% single tax on the base (line 66), added to the settlement (305). */
  tax_clp: number;
  /** DJ 1891 «Monto Total Ventas» for the fund units, beside the app's proceeds. */
  informed_sales_clp: number | null;
  /** DJ 1922 B1 «…que cumplen requisitos art. 107 LIR (actualizada)»: the informed art. 107 difference. */
  informed_result_clp: number | null;
  distributions: TaxReturnArt107Distribution[];
  /** The estimate behind code 105 (dividends afectos al IGC): the cash the fund credited. */
  distributions_clp: number;
};

export type TaxReturnLossOffsetSource = "crypto" | "foreign_shares" | "foreign_dividends" | "funds_interest" | "usd_fx";

/** A realized disposal of dollars bought with pesos (server: usdFxTaxGains.ts): proceeds and cost at the dólar observado. */
export type TaxReturnUsdFxDisposal = {
  date: string;
  account_name: string;
  usd: number;
  /** Distinct purchase dates of the lots consumed, oldest first. */
  purchase_dates: string[];
  proceeds_clp: number;
  /** Nominal pesos, no IPC reajuste. */
  cost_clp: number;
  gain_clp: number;
  /** The December reajuste on the result (IPC from the month before the disposal), never negative. */
  december_pct: number;
  gain_december_clp: number;
};

/** GET /api/tax-return `usd_fx`: the year's exchange result on the dollars bought with pesos. */
export type TaxReturnUsdFx = {
  /** Where it goes on the form: art. 20 N°5 income (line 58 d, code 1901 + IDPC credited back) or the crypto's 1032 / 169. */
  route: "idpc_1901" | "igc_1032";
  /** Which outflows realize it: Oficio 2573 (spending dollars sells them), Oficio 2390 (only to a third party / pesos), none. */
  posture: "oficio_2573" | "oficio_2390" | "none";
  purchase_cost: "observado" | "pesos_paid";
  /** The income year's November IPC is not published: the reajuste runs to `reajuste_to_month`. */
  provisional: boolean;
  reajuste_to_month: string;
  disposals: TaxReturnUsdFxDisposal[];
  /** Dollars charged as fees: their cost is lost, never deducted. */
  fees: { date: string; account_name: string; usd: number; cost_lost_clp: number }[];
  fees_lost_clp: number;
  /** What the other posture would have realized (information only). */
  deferred: { date: string; account_name: string; usd: number; gain_clp: number }[];
  deferred_clp: number;
  result_clp: number;
  result_december_clp: number;
  /** The pesos the route puts in each code; null when the code is not used (a loss under 1901 states nothing). */
  codes: { 1901: number | null; idpc_clp: number | null; 1032: number | null; loss169: number | null };
};

/** Gains and losses that offset each other within one year, and what is left on either side. */
export type TaxReturnOffsetBalance = {
  gains_clp: number;
  losses_clp: number;
  deducted_clp: number;
  unused_loss_clp: number;
  taxed_gain_clp: number;
  /** IGC at stake for the unused loss or the taxed gain; null without a tax chain. */
  tax_effect_clp: number | null;
};

/** The year's code-169 pool (F22 line 17): losses deduct only from these gains, in the same year. */
export type TaxReturnLossOffset = TaxReturnOffsetBalance & {
  parts: { source: TaxReturnLossOffsetSource; gain_clp: number; loss_clp: number }[];
};

export type TaxReturnResponse = {
  tax_year: number;
  income_year: number;
  available_tax_years: number[];
  provisional: boolean;
  base: "filed" | "informed" | "payroll" | "none";
  tax_computed: boolean;
  uta_clp: number;
  uta_provisional: boolean;
  salary: {
    months: number;
    taxable_pay_clp: number;
    withheld_tax_clp: number;
    incomplete_months: string[];
    provisional: boolean;
  };
  year_end_observado: number;
  /** How the filed form was settled: its refund or payment against the linked bank movements. */
  settlement: {
    expected: { kind: "refund" | "payment"; amount: number } | null;
    links: {
      kind: "refund" | "payment" | "offset_kept" | "offset_paid";
      account_id: number | null;
      account_name: string | null;
      movement_id: number | null;
      /** An offset's other tax year: the debt it paid (`offset_kept`) or the refund that paid it (`offset_paid`). */
      other_tax_year: number | null;
      occurred_on: string;
      amount: number;
      description: string;
    }[];
    settled: number;
    difference: number | null;
  } | null;
  /** The year's salary payslips: tax withheld vs the monthly table on each payslip's taxable amount. */
  payroll_withholding: {
    income_year: number;
    payslips: number;
    withheld: number;
    by_table: number;
    difference: number;
    months_with_differences: string[];
    months: { payslip_id: number; period_month: string; origin: "document" | "rebuilt"; withheld: number; by_table: number; difference: number }[];
  };
  rows: TaxReturnRow[];
  tax_filed: number | null;
  tax_draft: number | null;
  crypto: {
    method: "fifo" | "lifo" | "average";
    fee_policy: "excluded" | "included";
    informed_sales_clp: number | null;
    sales_clp: number;
    gain_december_clp: number;
    provisional: boolean;
    reajuste_to_month: string;
    sales: TaxReturnCryptoSale[];
  };
  dividends: TaxReturnDividend[];
  loss_offset: TaxReturnLossOffset;
  /** Foreign share sales netted among themselves: a loss offsets nothing else. */
  foreign_share_offset: TaxReturnOffsetBalance;
  foreign_shares: {
    default_mode: "usd_31dic" | "clp_ipc";
    provisional: boolean;
    total_clp: { usd_31dic: number; clp_ipc: number };
    idpc_clp: number;
    sales: TaxReturnForeignShareSale[];
  };
  art107: TaxReturnArt107;
  usd_fx: TaxReturnUsdFx;
};
