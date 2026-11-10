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

/** One place's rent of the year (server: f22Rentals.ts), reajustada to December. */
export type TaxReturnRentalPlace = {
  slug: string;
  label: string;
  /** DFL-2: the rent is not declared (DFL N° 2 art. 15); otherwise it is code 1849. */
  dfl2: boolean;
  credits: number;
  rent_clp: number;
  /** Contribuciones paid in the year (they credit the IGC only on a taxable place). */
  property_tax_paid_clp: number;
};

/** GET /api/tax-return `rentals`: the year's rents, taxable (1849 → 955, credit 1637) and exempt DFL-2. */
export type TaxReturnRentals = {
  provisional: boolean;
  places: TaxReturnRentalPlace[];
  taxable_rent_clp: number;
  exempt_rent_clp: number;
  /** Línea 39: the contribuciones paid on the taxable places, the cap (IGC on the rent) and the credit; null without taxable rent. */
  property_tax_credit: { paid_clp: number; cap_clp: number; credit_clp: number } | null;
};

/**
 * GET /api/tax-return `foreign_income` (server: f22ForeignIncome.ts): a salary earned abroad (US pay
 * stubs → code 1030, its credit 748 / 1018 under art. 41 A and the Chile–US treaty) and a foreign
 * broker's interest (in 1104).
 */
export type TaxReturnForeignIncome = {
  salary: {
    /** The year is open: the latest observado stood in for the year end's. */
    provisional: boolean;
    stubs: number;
    /** Gross pay, dollars (nothing deducted: FICA is not a Chilean-law contribution, Circular 31/2021). */
    income_usd: number;
    /** The same in pesos at the 31-December observado (art. 41 A N°7 letra a), no reajuste). */
    gross_clp: number;
    /** The 1040's line 24 (total tax): the filed return's, or the draft's. */
    us_tax_usd: number;
    us_tax_source: "filed" | "draft" | null;
    us_tax_clp: number;
    /** Code 1030: gross less the US tax. */
    net_clp: number;
    /** min(US tax, 35 % of the gross): the incremento in 748 and the credit before its cap. */
    credit_clp: number;
    /** The IGC on this income (the credit's cap, no refund) and what 1018 took; null without a credit. */
    credit_cap_clp: number | null;
    credit_applied_clp: number | null;
  };
  interest: {
    lines: { date: string; account_name: string; usd: number }[];
    usd: number;
    /** At the 31-December observado, in 1104. */
    clp: number;
  };
};

export type TaxJurisdiction = "cl" | "us";

/** A declared tax residency period (server: taxResidency.ts; GET|POST /api/tax-residency). */
export type TaxResidencyPeriodDto = {
  id: number;
  jurisdiction: TaxJurisdiction;
  from: string;
  /** Null: the open period. */
  to: string | null;
  note: string | null;
};

/** The regime of an income year under the declared residency: Chile the whole year, none of it, or the departure year. */
export type TaxReturnRegime = "resident" | "nonresident" | "split";

export type TaxReturnDateWindow = { from: string; through: string };

/** Why an item of a non-resident window enters no code (server: f22Draft.ts, «Residency»). */
export type TaxReturnExcludedReason = "nonresident" | "treaty_art13_8" | "fund_unico_withheld" | "withheld_at_source" | "no_igc";

export type TaxReturnExcludedKind =
  | "us_salary"
  | "foreign_dividends"
  | "foreign_interest"
  | "foreign_shares"
  | "usd_fx"
  | "crypto"
  | "fund_redemptions"
  | "fund_distributions"
  | "chile_interest"
  | "mortgage_interest"
  | "apv"
  | "property_tax_credit";

/** An item the non-resident part does not declare, kept in the payload with its amount and reason. */
export type TaxReturnExcludedItem = {
  kind: TaxReturnExcludedKind;
  reason: TaxReturnExcludedReason;
  clp: number;
  /** Lines, sales, stubs… behind the amount (0 for a yearly DJ figure). */
  count: number;
  window: TaxReturnDateWindow;
};

/** The declared residency the draft was built on. */
export type TaxReturnResidency = {
  regime: TaxReturnRegime;
  /** A declared period covers the year (false: Chile, the undeclared default). */
  declared: boolean;
  cl: "full" | "none" | { through: string };
  us: "full" | "none" | { from: string };
  /** The assumption the return states when a residency is declared (the client shows its own translation); null otherwise. */
  assumption: string | null;
  periods: TaxResidencyPeriodDto[];
  resident_window: TaxReturnDateWindow | null;
  art103_departure_return_built: false;
};

/** The non-resident part: the Impuesto Adicional (línea 72, codes 32 / 34) on the Chilean-source items of its window. */
export type TaxReturnNonresidentPart = {
  window: TaxReturnDateWindow;
  tax_computed: boolean;
  /** 1849 / 955 / 158 / 32 / 34 and the art. 107 codes of this part (zeros left out). */
  codes: Record<string, number>;
  taxable_rent_clp: number;
  exempt_rent_clp: number;
  places: { slug: string; label: string; dfl2: boolean; credits: number; rent_clp: number }[];
  /** Art. 107 sales of the window at the general-rule cost, the 10 % único (withheld by the broker, art. 107 N°6). */
  art107: { sales: number; result_clp: number; tax_clp: number };
};

export type TaxReturnResponse = {
  tax_year: number;
  income_year: number;
  available_tax_years: number[];
  /** The income year's US tax year when it has a 1040 (GET /api/tax-return/us); null otherwise. */
  us_tax_year: number | null;
  provisional: boolean;
  base: "filed" | "informed" | "payroll" | "fees" | "none";
  regime: TaxReturnRegime;
  residency: TaxReturnResidency;
  /** The non-resident part (a non-resident year, or the departure year's second part); null for a resident year. */
  nonresident: TaxReturnNonresidentPart | null;
  excluded: TaxReturnExcludedItem[];
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
  /** The fees box drafted from the boletas de honorarios issued (null: none, or a filed year). */
  fees: {
    receipts: number;
    gross_clp: number;
    presumed_expenses_clp: number;
    apv_clp: number;
    net_clp: number;
    retention_clp: number;
  } | null;
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
  /** The income tax determined as filed / as drafted: the IGC (304) plus the Impuesto Adicional (34). */
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
  rentals: TaxReturnRentals;
  foreign_income: TaxReturnForeignIncome;
  usd_fx: TaxReturnUsdFx;
};

/** GET /api/tax-return/us — the local Form 1040, v1 (server: f1040Payload.ts). */
export type UsTaxReturnRowSection = "income" | "subtotal" | "deduction" | "tax" | "credit" | "payment" | "result";

/** One 1040 line; whole dollars. `line` is the role (the 2024 form's numbering: «1a», «12», «35a»), `printed_line` the year's number («12e» on the 2025 form). */
export type UsTaxReturnRow = {
  line: string;
  printed_line: string;
  section: UsTaxReturnRowSection;
  /** Null without a filed return; a line the filed return leaves out reads 0. */
  filed: number | null;
  draft: number;
  /** Filed and draft both present and different. */
  changed: boolean;
};

/** A W-2 rebuilt from the year's pay stubs (dollars to the cent). */
export type UsTaxReturnW2 = {
  employer: string;
  ein: string;
  stubs: number;
  box1_wages: number;
  box2_federal_withheld: number;
  box3_social_security_wages: number;
  box4_social_security_tax: number;
  box5_medicare_wages: number;
  box6_medicare_tax: number;
  /** Box 12 code D: pre-tax 401(k). */
  box12_d: number;
  /** Box 12 code AA: Roth 401(k). */
  box12_aa: number;
  /** Box 12 code W: HSA through the cafeteria plan. */
  box12_w: number;
};

export type UsTaxReturnNote = "no_state_return" | "first_year_full_resident" | "open_year" | "law_provisional";

export type UsTaxReturnResponse = {
  jurisdiction: "us";
  /** The calendar tax year. */
  tax_year: number;
  available_tax_years: number[];
  /** The year has not ended: the stubs to date. */
  provisional: boolean;
  /** Whose law the draft applied: the tax year, or the latest listed year for an open year. */
  law_year: number;
  filing_status: "single" | "married_jointly";
  stubs: number;
  notes: UsTaxReturnNote[];
  w2s: UsTaxReturnW2[];
  /** Social Security and Medicare withheld (W-2 boxes 4 and 6): reported, not part of the 1040's tax. */
  fica: { social_security: number; medicare: number; total: number; additional_medicare_tax: number };
  rows: UsTaxReturnRow[];
  /** Line 24 (total tax) as filed / as drafted. */
  tax_filed: number | null;
  tax_draft: number;
  /** Line 35a / line 37 of the draft. */
  refund_draft: number;
  owed_draft: number;
  filed: { filed_on: string; filing_status: "single" | "married_jointly"; source_file: string } | null;
  /** How the filed return was settled: its refund or payment against the linked movements. */
  settlement: {
    expected: { kind: "refund" | "payment"; amount: number } | null;
    links: {
      kind: "refund" | "payment";
      account_id: number;
      account_name: string;
      movement_id: number;
      occurred_on: string;
      amount: number;
      description: string;
    }[];
    settled: number;
    difference: number | null;
  } | null;
};
