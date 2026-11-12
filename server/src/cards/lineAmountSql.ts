/**
 * A card statement line's peso and dollar view, derived from what it stores: `amount` + `currency`
 * and `cuota_amount` (migration 319). Until migration 324 the table carried these four as generated
 * columns (`amount_clp`, `amount_usd`, `valor_cuota_mensual_clp`, `valor_cuota_mensual_usd`); the
 * readers that still speak in pesos and dollars read them through here, with the same values: a
 * peso line's pesos are its amount (dollars NULL), a dollar line's pesos 0 and its dollars its
 * amount; a line in any other currency reads NULL in all four. A reader that handles any currency
 * reads `amount` / `currency` / `cuota_amount` directly.
 */

/** `alias.` or nothing. */
function col(alias: string, name: string): string {
  return alias ? `${alias}.${name}` : name;
}

/** SQL: the line's pesos (0 for a dollar line, NULL for another currency). */
export function lineAmountClpSql(alias = "l"): string {
  return `(CASE ${col(alias, "currency")} WHEN 'clp' THEN ${col(alias, "amount")} WHEN 'usd' THEN 0 END)`;
}

/** SQL: the line's dollars (NULL unless a dollar line). */
export function lineAmountUsdSql(alias = "l"): string {
  return `(CASE ${col(alias, "currency")} WHEN 'usd' THEN ${col(alias, "amount")} END)`;
}

/** SQL: a peso line's monthly cuota (0 for a dollar line, NULL for another currency). */
export function lineCuotaClpSql(alias = "l"): string {
  return `(CASE ${col(alias, "currency")} WHEN 'clp' THEN ${col(alias, "cuota_amount")} WHEN 'usd' THEN 0 END)`;
}

/** SQL: a dollar line's monthly cuota (NULL unless a dollar line). */
export function lineCuotaUsdSql(alias = "l"): string {
  return `(CASE ${col(alias, "currency")} WHEN 'usd' THEN ${col(alias, "cuota_amount")} END)`;
}

/** SQL select items naming the four views as the old columns were named. */
export function lineLegacyAmountColumnsSql(alias = "l"): string {
  return [
    `${lineAmountClpSql(alias)} AS amount_clp`,
    `${lineAmountUsdSql(alias)} AS amount_usd`,
    `${lineCuotaClpSql(alias)} AS valor_cuota_mensual_clp`,
    `${lineCuotaUsdSql(alias)} AS valor_cuota_mensual_usd`,
  ].join(", ");
}

export type LineLegacyAmounts = {
  amount_clp: number | null;
  amount_usd: number | null;
  valor_cuota_mensual_clp: number | null;
  valor_cuota_mensual_usd: number | null;
};

/** The same four views of a line held in memory. */
export function lineLegacyAmounts(line: {
  amount: number | null;
  currency: string;
  cuota_amount: number | null;
}): LineLegacyAmounts {
  switch (line.currency) {
    case "clp":
      return { amount_clp: line.amount, amount_usd: null, valor_cuota_mensual_clp: line.cuota_amount, valor_cuota_mensual_usd: null };
    case "usd":
      return { amount_clp: 0, amount_usd: line.amount, valor_cuota_mensual_clp: 0, valor_cuota_mensual_usd: line.cuota_amount };
    default:
      return { amount_clp: null, amount_usd: null, valor_cuota_mensual_clp: null, valor_cuota_mensual_usd: null };
  }
}

/** A line in pesos or dollars, the two currencies the peso / dollar view carries (any other reads NULL there). */
export function lineHasPesoDollarView(currency: string): boolean {
  return lineLegacyAmounts({ amount: 1, currency, cuota_amount: 1 }).amount_clp != null;
}
