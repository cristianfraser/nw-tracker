import {
  cartolaStatementMonths,
  isCartolaDesdeBoundaryPhantomMonth,
  monthKeyFromYmd,
} from "./calendarMonth.js";
import { addCalendarMonths } from "./ccYearMonth.js";
import type { ParsedCheckingCartola } from "./checkingCartolaParse.js";

/** Calendar months covered by a cartola's movements and statement month. */
export function cartolaCalendarMonths(cartola: ParsedCheckingCartola): string[] {
  return cartolaStatementMonths({
    period_from: cartola.period_from,
    period_to: cartola.period_to,
    period_month: cartola.period_month,
    movements: cartola.movements,
  });
}

/**
 * Fan out a multi-month cuenta vista cartola into one slice per calendar month.
 * Single-month cartolas are returned unchanged.
 */
export function splitCuentaVistaCartolaByCalendarMonth(
  cartola: ParsedCheckingCartola
): ParsedCheckingCartola[] {
  const months = cartolaCalendarMonths(cartola);
  if (months.length <= 1) return [cartola];

  const monthSaldo = cartola.month_saldo_final_clp;
  const byMonth = new Map<string, ParsedCheckingCartola["movements"]>();
  for (const mv of cartola.movements) {
    const ym = monthKeyFromYmd(mv.occurred_on);
    if (!ym) continue;
    const list = byMonth.get(ym) ?? [];
    list.push(mv);
    byMonth.set(ym, list);
  }

  const firstMonth = months[0]!;
  const lastMonth = months[months.length - 1]!;

  return months
    .map((periodMonth) => {
      const prevMonth = addCalendarMonths(periodMonth, -1);
      const saldoFinalFromMap = monthSaldo?.[periodMonth];
      const saldoInicialFromMap =
        periodMonth === firstMonth
          ? cartola.saldo_inicial_clp
          : (monthSaldo?.[prevMonth] ?? null);

      return {
        ...cartola,
        period_month: periodMonth,
        movements: byMonth.get(periodMonth) ?? [],
        saldo_inicial_clp: monthSaldo
          ? saldoInicialFromMap
          : periodMonth === firstMonth
            ? cartola.saldo_inicial_clp
            : null,
        saldo_final_clp: monthSaldo
          ? (saldoFinalFromMap ?? null)
          : periodMonth === lastMonth
            ? cartola.saldo_final_clp
            : null,
        skipped: periodMonth === lastMonth ? cartola.skipped : [],
        notes: periodMonth === lastMonth ? cartola.notes : [],
      };
    })
    .filter(
      (slice) =>
        !isCartolaDesdeBoundaryPhantomMonth({
          period_month: slice.period_month,
          period_from: slice.period_from,
          period_to: slice.period_to,
          movement_count: slice.movements.length,
        })
    );
}
