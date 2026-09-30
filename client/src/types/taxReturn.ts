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
  gross_usd: number;
  withholding_usd: number;
  gross_clp: number;
  withholding_clp: number;
};

export type TaxReturnForeignShareSale = {
  date: string;
  account_name: string;
  units: number;
  gain_usd: number;
  result_clp: { usd_31dic: number; clp_ipc: number };
};

export type TaxReturnResponse = {
  tax_year: number;
  income_year: number;
  available_tax_years: number[];
  uta_clp: number;
  year_end_observado: number;
  rows: TaxReturnRow[];
  tax_filed: number;
  tax_draft: number;
  crypto: {
    method: "fifo" | "lifo" | "average";
    fee_policy: "excluded" | "included";
    informed_sales_clp: number | null;
    sales_clp: number;
    gain_december_clp: number;
    sales: TaxReturnCryptoSale[];
  };
  dividends: TaxReturnDividend[];
  foreign_shares: {
    default_mode: "usd_31dic" | "clp_ipc";
    provisional: boolean;
    total_clp: { usd_31dic: number; clp_ipc: number };
    idpc_clp: number;
    sales: TaxReturnForeignShareSale[];
  };
};
