/**
 * Skeleton for the monthly declaration of «rentas esporádicas» (art. 69 N°3 LIR; Formulario 50,
 * line 61: base in code 77, tax in code 125), due «dentro del mes siguiente al de obtención de la
 * renta». Circular 40/2021 §6.2.2 reserves it for taxpayers who do not normally file an annual
 * return — this user files one every year, so the default is `applies: false` and the yearly
 * Formulario 22 carries these results instead. Art. 17 N°8 results (crypto) are never esporádicas,
 * and foreign dividends are excluded by the article itself.
 *
 * What it would collect: realized first-category results of a month — foreign share/ETF sales
 * and, under Oficio 2573/2022, the exchange result of dollars spent on instruments. The rate and
 * the pesos frame are parameters because no oficio applies art. 69 N°3 to these results.
 */

export type EsporadicaSource = "foreign_share_sale" | "fx_2573";

export type EsporadicaItem = { date: string; source: EsporadicaSource; resultClp: number; movementId: number };

export type EsporadicaMonth = {
  month: string;
  items: EsporadicaItem[];
  /** Formulario 50 code 77 — the month's net result, never below zero. */
  baseClp: number;
  /** Formulario 50 code 125. */
  taxClp: number;
  /** Last day of the following month. */
  dueBy: string;
};

export type EsporadicasPolicy = {
  /** False for a taxpayer who files an annual return (the default: Circular 40/2021 §6.2.2). */
  applies: boolean;
  /** Tax rate on the base; first-category rate by default. */
  rate: number;
};

export const DEFAULT_ESPORADICAS_POLICY: EsporadicasPolicy = { applies: false, rate: 0.25 };

function lastDayOfNextMonth(month: string): string {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const d = new Date(Date.UTC(y, m + 1, 0));
  return d.toISOString().slice(0, 10);
}

/** Groups items by calendar month; empty when the policy says the regime does not apply. */
export function rentasEsporadicasByMonth(items: readonly EsporadicaItem[], policy: EsporadicasPolicy): EsporadicaMonth[] {
  if (!policy.applies) return [];
  const byMonth = new Map<string, EsporadicaItem[]>();
  for (const it of items) {
    const month = `${it.date.slice(0, 7)}-01`;
    byMonth.set(month, [...(byMonth.get(month) ?? []), it]);
  }
  return [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, its]) => {
      const baseClp = Math.max(0, its.reduce((s, x) => s + x.resultClp, 0));
      return { month, items: its, baseClp, taxClp: baseClp * policy.rate, dueBy: lastDayOfNextMonth(month) };
    });
}
