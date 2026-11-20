import { formatMoney, formatPct } from "../../format";
import type {
  PositionGlanceDirection,
  PositionGlanceDto,
  PositionGlanceFundSeriesDto,
  PositionGlancePeriodDto,
} from "../../types";

/**
 * Formatting and layout for the unit-position page's glance (PositionGlance.tsx). Every figure, share and
 * side is the server's (`positionGlance.ts`); these only turn them into text and CSS positions.
 */

type Money = { value: number; currency: string };

/** «+» / «−» by the figure's sign (a real minus, not a hyphen), nothing at zero. */
function signOf(n: number): string {
  return n > 0 ? "+" : n < 0 ? "−" : "";
}

/** A display-unit amount with its sign before the symbol: «+$51.200», «−$1.200». */
export function formatSignedMoney(m: Money): string {
  return `${signOf(m.value)}${formatMoney({ value: Math.abs(m.value), currency: m.currency })}`;
}

/** A fraction as a signed percent: 0.0207 → «+2,07%», −0.0062 → «−0,62%». */
export function formatSignedPct(p: number, frac = 2): string {
  return `${signOf(p)}${formatPct(Math.abs(p) * 100, frac)}`;
}

/** ▲ / ▼ by direction (the title line's day P/L), nothing when flat. */
export function directionArrow(direction: PositionGlanceDirection, small = false): string {
  if (direction === "up") return small ? "▴" : "▲";
  if (direction === "down") return small ? "▾" : "▼";
  return "";
}

/** A share (0..1) as a CSS percentage. */
export function pctOf(share: number): string {
  return `${share * 100}%`;
}

/** A period's zero-centred bar: from the centre to the right when up, to the left when down. */
export function periodBarBox(period: Pick<PositionGlancePeriodDto, "share" | "direction">): {
  left: string;
  width: string;
} | null {
  if (period.direction === "flat" || !(period.share > 0)) return null;
  const half = period.share * 50;
  return {
    left: `${period.direction === "up" ? 50 : 50 - half}%`,
    width: `${half}%`,
  };
}

/**
 * A track label's left edge in px (layout only: the share is the server's, the widths measured):
 * centred on its tick at `share` of the track, pushed in where centring would cross an end.
 */
export function centredLabelLeft(share: number, trackWidth: number, labelWidth: number): number {
  const left = share * trackWidth - labelWidth / 2;
  return Math.min(Math.max(left, 0), Math.max(0, trackWidth - labelWidth));
}

/** The colour role of every rendering of today's price: above the average cost, below, or equal. */
export function priceTone(priceVsCost: PositionGlanceDto["price_vs_cost"]): "positive" | "negative" | "neutral" {
  return priceVsCost === "above" ? "positive" : priceVsCost === "below" ? "negative" : "neutral";
}

/** A sparkline's polyline points on a `width` × `height` box, from the server's 0..1 positions (x by day, y by price). */
export function sparklinePoints(points: readonly { x: number; y: number }[], width: number, height: number): string {
  return points.map((p) => `${(p.x * width).toFixed(1)},${((1 - p.y) * height).toFixed(1)}`).join(" ");
}

/** The AFP managers the client has names for (`accountDetail.positionGlance.fundSeries.afpManager`). */
const AFP_MANAGERS: ReadonlySet<string> = new Set(["uno", "planvital", "modelo"]);

type Translate = (key: string, options?: Record<string, string>) => string;

/**
 * A fund series as the sub-line words it: a Fintual fund by the name Fintual states, an AFP fund as
 * «Fondo A · AFP UNO» (an AFP manager the client has no name for throws: never a guessed label), the
 * AFC's «Fondo de Cesantía (CIC)», any other series by its key.
 */
export function fundSeriesLabel(series: PositionGlanceFundSeriesDto, t: Translate): string {
  switch (series.kind) {
    case "fintual":
      return series.name;
    case "afp": {
      if (!AFP_MANAGERS.has(series.manager)) {
        throw new Error(`position_glance: no name for the AFP manager «${series.manager}» (${series.series_key})`);
      }
      const manager = t(`accountDetail.positionGlance.fundSeries.afpManager.${series.manager}`);
      return t("accountDetail.positionGlance.fundSeries.afp", { fund: series.fund, manager });
    }
    case "afc":
      return t("accountDetail.positionGlance.fundSeries.afc");
    case "other":
      return series.series_key;
  }
}
