/**
 * The `position` block of the account page summary and of the dashboard row, in the request's
 * display unit (docs/any-currency-plan.md, Phase A item 1). Built from the position's frame in
 * pesos (`positionClpFrameFromMeta`): a value that is the account's today value converts as that
 * value does (`todayValueInUnit`, the dashboard row's own rule), a mark dated another day converts
 * as the account's value on that day (`accountValueInUnitFromClp`). The per-unit price takes the
 * value's own conversion, so units × price = value in every unit.
 */
import { positionClpFrameFromMeta, type AccountPositionMeta, type UnitsKind } from "./accountPosition.js";
import { todayValueInUnit, type AccountTodayValue } from "./accountTodayValue.js";
import { accountValueInUnitFromClp } from "./accountValue.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import type { DisplayUnitCode } from "./rates.js";
import { clpToUnitAt } from "./valueConvert.js";

export type AccountPositionSnapshot = {
  ticker: string;
  units_kind: UnitsKind;
  units: number | null;
  /** The currency every money field below is in: the request's display unit. */
  unit: DisplayUnitCode;
  /** Net personal capital deposited, in `unit`; null when a rate it needs is missing. */
  deposited: number | null;
  value: number | null;
  value_as_of: string | null;
  value_per_unit: number | null;
};

/**
 * The position in `unit`. `deposited` is already in `unit` (the caller's deposits: the page's
 * personal capital, the row's deposits). Null when the account has no position meta.
 */
export function positionSnapshotInUnit(
  accountId: number,
  meta: AccountPositionMeta | null,
  today: AccountTodayValue | null | undefined,
  deposited: number | null,
  unit: DisplayUnitCode
): AccountPositionSnapshot | null {
  const frame = positionClpFrameFromMeta(accountId, meta, today);
  if (frame == null) return null;
  const todayYmd = chileCalendarTodayYmd();
  const asOf = frame.value_as_of ?? todayYmd;
  const value =
    frame.value_clp == null
      ? null
      : frame.value_is_today && today
        ? todayValueInUnit(accountId, today, unit)
        : accountValueInUnitFromClp(accountId, frame.value_clp, asOf, unit);
  const perUnitClp = frame.value_per_unit_clp;
  const value_per_unit =
    perUnitClp == null
      ? null
      : value != null && frame.value_clp != null && frame.value_clp !== 0
        ? perUnitClp * (value / frame.value_clp)
        : clpToUnitAt(perUnitClp, asOf, unit);
  return {
    ticker: frame.ticker,
    units_kind: frame.units_kind,
    units: frame.units,
    unit,
    deposited,
    value,
    value_as_of: frame.value_as_of,
    value_per_unit,
  };
}
