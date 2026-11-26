import type { ReactNode } from "react";
import { cn } from "../../cn";
import { buildNiceYAxis } from "../charts/chartLayout";
import { useElementSize } from "../charts/useElementSize";
import { formatMonthShortLabel } from "../../formatDateLabel";
import type {
  DeptoBalanceBandDto,
  DeptoCostBandDto,
  DeptoPlMonthDto,
  DeptoProjectionDto,
  DeptoPropertyPlBandDto,
  DeptoPropertyValueBandDto,
  RealEstateChartSeriesDto,
} from "../../types";
import {
  dayNumber,
  linear,
  monthTicks,
  pointsAttr,
  spreadLabels,
  stepPoints,
} from "./deptoChartLayout";
import { axisCompact, loanWholeBare, monthTickLabel, signOf, signedMoney } from "./deptoFormat";
import styles from "./Depto.module.css";
import { formatMoney, formatCurrency } from "../../format";

/**
 * The property and mortgage pages' charts, drawn as plain SVG at the size of their box (measured):
 * on a desktop the box is as tall as the rail beside it, on a phone a fixed height (CSS). Text is
 * 10px mono whatever the width (no viewBox scaling). No legends: lines are told apart by colour and
 * by their end figures, each in its line's colour.
 */

/** An approximate mono character width at the charts' 10px, for label room. */
const CH = 6.1;
const LABEL_GAP = 11;

/** The measured box a chart draws into. `children` gets its width and height (not called before measured). */
export function ChartBox({
  ariaLabel,
  className,
  children,
}: {
  ariaLabel: string;
  className?: string;
  children: (w: number, h: number) => ReactNode;
}) {
  const { ref, width, height } = useElementSize<HTMLDivElement>();
  return (
    <div ref={ref} className={cn(styles.chartBox, className)}>
      <svg className={styles.svg} width={width} height={height} viewBox={`0 0 ${Math.max(width, 1)} ${Math.max(height, 1)}`} role="img" aria-label={ariaLabel}>
        {width > 0 && height > 0 ? children(width, height) : null}
      </svg>
    </div>
  );
}

/** A label's room in px. */
function textW(s: string): number {
  return s.length * CH;
}

const TONE_FILL: Record<"pos" | "neg" | "hi" | "muted" | "acc" | "amb", string> = {
  pos: "var(--positive)",
  neg: "var(--negative)",
  hi: "var(--text)",
  muted: "var(--muted)",
  acc: "var(--accent)",
  amb: "var(--depto-amber)",
};

function toneFill(n: number): string {
  return n > 0 ? TONE_FILL.pos : n < 0 ? TONE_FILL.neg : TONE_FILL.muted;
}

/* ---------------- property: value band ---------------- */

/**
 * Month-ends of the property: its value dashed, the mortgage as the band between value and net
 * equity, deposited thin, net equity in the accent; prepagos marked on the x axis.
 */
export function ValueChart({
  value,
  unit,
  loanCurrency,
  w,
  h,
}: {
  value: DeptoPropertyValueBandDto;
  unit: string;
  loanCurrency: string;
  w: number;
  h: number;
}) {
  const pts = value.points;
  if (pts.length === 0) return null;
  const last = pts[pts.length - 1]!;
  const ends = [
    { key: "value", text: formatMoney({ value: last.value, currency: unit }), fill: TONE_FILL.muted, y0: last.value },
    { key: "mortgage", text: formatMoney({ value: last.mortgage, currency: unit }), fill: TONE_FILL.neg, y0: (last.value + last.equity) / 2 },
    { key: "deposited", text: formatMoney({ value: last.deposited, currency: unit }), fill: TONE_FILL.muted, y0: last.deposited },
    { key: "equity", text: formatMoney({ value: last.equity, currency: unit }), fill: TONE_FILL.acc, y0: last.equity },
  ];
  const axis = buildNiceYAxis(0, Math.max(...pts.map((p) => p.value)));
  const tickLabels = axis.ticks.map((t) => axisCompact(t, unit));
  const ml = Math.max(...tickLabels.map(textW)) + 8;
  const mr = Math.max(...ends.map((e) => textW(e.text))) + 12;
  const mt = 8;
  const mb = 18;
  const x = linear(dayNumber(pts[0]!.date), dayNumber(last.date), ml, w - mr);
  const y = linear(axis.domain[0], axis.domain[1], h - mb, mt);
  const line = (key: "value" | "equity" | "deposited") => pts.map((p) => [x(dayNumber(p.date)), y(p[key])] as const);
  const valueLine = line("value");
  const equityLine = line("equity");
  const band = [...valueLine, ...[...equityLine].reverse()];
  const labels = spreadLabels(
    ends.map((e) => ({ ...e, y: y(e.y0) + 3 })),
    LABEL_GAP,
    mt + 6,
    h - mb
  );
  const months = pts.map((p) => p.date.slice(0, 7));
  const pxPerMonth = (w - ml - mr) / Math.max(1, months.length - 1);
  const ticks = monthTicks(months, pxPerMonth, 56);
  // A prepago's amount over its tick, left out where it would run into the previous one's.
  const prepagoMarks: { date: string; x: number; text: string | null }[] = [];
  let lastRight = -Infinity;
  for (const p of value.prepagos) {
    const px = x(dayNumber(p.date));
    const text = formatCurrency(p.amount_loan, loanCurrency);
    const half = (text.length * CH * 0.9) / 2;
    const fits = px - half > lastRight + 4;
    if (fits) lastRight = px + half;
    prepagoMarks.push({ date: p.date, x: px, text: fits ? text : null });
  }
  return (
    <g>
      {axis.ticks.map((t, i) => (
        <g key={t}>
          <line
            x1={ml}
            x2={w - mr}
            y1={y(t)}
            y2={y(t)}
            stroke="var(--hairline)"
            strokeDasharray={t === 0 ? undefined : "2 4"}
          />
          <text x={ml - 6} y={y(t) + 3} textAnchor="end">
            {tickLabels[i]}
          </text>
        </g>
      ))}
      <polygon points={pointsAttr(band)} style={{ fill: TONE_FILL.neg }} opacity={0.08} />
      <polyline points={pointsAttr(valueLine)} fill="none" style={{ stroke: TONE_FILL.muted }} strokeDasharray="3 3" />
      <polyline points={pointsAttr(line("deposited"))} fill="none" style={{ stroke: TONE_FILL.muted }} strokeOpacity={0.7} />
      <polyline points={pointsAttr(equityLine)} fill="none" style={{ stroke: TONE_FILL.acc }} strokeWidth={1.7} strokeLinejoin="round" />
      <circle cx={x(dayNumber(last.date))} cy={y(last.equity)} r={2.6} style={{ fill: TONE_FILL.acc }} />
      {labels.map((l) => (
        <text key={l.key} x={w - mr + 8} y={l.at} style={{ fill: l.fill }}>
          {l.text}
        </text>
      ))}
      {ticks.map((t) => (
        <text key={t.month} x={x(dayNumber(pts[t.index]!.date))} y={h - 4} textAnchor="middle">
          {monthTickLabel(t.month, t.withYear)}
        </text>
      ))}
      {prepagoMarks.map((p) => (
        <g key={p.date}>
          <line x1={p.x} x2={p.x} y1={h - mb} y2={h - mb - 6} style={{ stroke: TONE_FILL.pos }} />
          {p.text != null ? (
            <text x={p.x} y={h - mb - 10} textAnchor="middle" className={styles.small} style={{ fill: TONE_FILL.pos }}>
              {p.text}
            </text>
          ) : null}
        </g>
      ))}
    </g>
  );
}

/* ---------------- property: P/L band ---------------- */

export type PlMode = "pl" | "value";

/**
 * Monthly bars with a running line, the calendar years as bands with their totals at the top.
 * P/L mode: the month's P/L and the cumulative P/L on one axis. Δ valor mode: the month's change of
 * value (bars) and the month-end value (the line, on its own axis).
 */
export function PlChart({
  pl,
  mode,
  unit,
  w,
  h,
}: {
  pl: DeptoPropertyPlBandDto;
  mode: PlMode;
  unit: string;
  w: number;
  h: number;
}) {
  const months = pl.months;
  if (months.length === 0) return null;
  const bar = (m: DeptoPlMonthDto) => (mode === "pl" ? m.pl : m.value_change);
  const lineOf = (m: DeptoPlMonthDto) => (mode === "pl" ? m.pl_cumulative : m.closing);
  const bars = months.map(bar);
  const lineVals = months.map(lineOf);
  const barNums = bars.filter((v): v is number => v != null);
  const lastM = months[months.length - 1]!;
  const lastBar = bar(lastM);
  const lastLine = lineOf(lastM);
  const ends = [
    ...(lastBar != null ? [{ key: "bar", text: signedMoney(lastBar, unit), fill: toneFill(lastBar), v: lastBar, scale: "bar" as const }] : []),
    {
      key: "line",
      text: mode === "pl" ? signedMoney(lastLine, unit) : formatMoney({ value: lastLine, currency: unit }),
      fill: TONE_FILL.hi,
      v: lastLine,
      scale: "line" as const,
    },
  ];
  const ml = 4;
  const mr = Math.max(...ends.map((e) => textW(e.text))) + 14;
  const mt = 26;
  const mb = 18;
  const plotW = w - ml - mr;
  const slot = plotW / months.length;
  const barAxis = mode === "pl" ? buildNiceYAxis(Math.min(0, ...barNums, ...lineVals), Math.max(0, ...barNums, ...lineVals)) : buildNiceYAxis(Math.min(0, ...barNums), Math.max(0, ...barNums));
  const lineAxis = mode === "pl" ? barAxis : buildNiceYAxis(0, Math.max(...lineVals));
  const yBar = linear(barAxis.domain[0], barAxis.domain[1], h - mb, mt);
  const yLine = linear(lineAxis.domain[0], lineAxis.domain[1], h - mb, mt);
  const cx = (i: number) => ml + slot * (i + 0.5);
  const bw = Math.max(1, slot * 0.64);
  const index = new Map(months.map((m, i) => [m.month, i]));
  const zero = yBar(0);
  const labels = spreadLabels(
    ends.map((e) => ({ ...e, y: (e.scale === "bar" ? yBar(e.v) : yLine(e.v)) + 3 })),
    LABEL_GAP,
    mt,
    h - mb
  );
  const ticks = monthTicks(
    months.map((m) => m.month),
    slot,
    40
  );
  const linePts = lineVals.map((v, i) => [cx(i), yLine(v)] as const);
  return (
    <g>
      <line x1={ml} x2={w - mr} y1={zero} y2={zero} stroke="var(--hairline)" />
      {pl.years.map((yr, k) => {
        const i0 = index.get(yr.first_month);
        const i1 = index.get(yr.last_month);
        if (i0 == null || i1 == null) throw new Error(`depto P/L: year ${yr.year} names a month outside the chart`);
        const x0 = ml + slot * i0;
        const x1 = ml + slot * (i1 + 1);
        const total = mode === "pl" ? yr.pl : yr.value_change;
        const totalText = signedMoney(total, unit);
        const room = x1 - x0 - 8 - textW(yr.year) - 6;
        return (
          <g key={yr.year}>
            {k > 0 ? <line x1={x0} x2={x0} y1={12} y2={h - mb} stroke="var(--hairline)" /> : null}
            <text x={x0 + 4} y={18} className={styles.year}>
              {yr.year}
            </text>
            {room >= textW(totalText) ? (
              <text x={x1 - 4} y={18} textAnchor="end" style={{ fill: toneFill(total) }}>
                {totalText}
              </text>
            ) : null}
          </g>
        );
      })}
      {bars.map((v, i) =>
        v == null || v === 0 ? null : (
          <rect
            key={months[i]!.month}
            x={cx(i) - bw / 2}
            y={Math.min(yBar(v), zero)}
            width={bw}
            height={Math.max(0.5, Math.abs(yBar(v) - zero))}
            style={{ fill: toneFill(v) }}
            fillOpacity={0.85}
          />
        )
      )}
      <polyline points={pointsAttr(linePts)} fill="none" style={{ stroke: TONE_FILL.muted }} strokeWidth={1.2} />
      <circle cx={cx(months.length - 1)} cy={yLine(lastLine)} r={2.4} style={{ fill: TONE_FILL.muted }} />
      {labels.map((l) => (
        <text key={l.key} x={w - mr + 8} y={l.at} style={{ fill: l.fill }}>
          {l.text}
        </text>
      ))}
      {ticks.map((t) => (
        <text key={t.month} x={cx(t.index)} y={h - 4} textAnchor="middle">
          {formatMonthShortLabel(t.month)}
        </text>
      ))}
    </g>
  );
}

/* ---------------- property: cost of living ---------------- */

/**
 * One hue per bill kind on this chart: costs warm (the mortgage's interest and insurance red),
 * equity green. A kind the server adds without a colour here throws.
 */
export const COST_KIND_COLORS: Record<RealEstateChartSeriesDto["kind"], string> = {
  mortgage_carrying: "#f87171",
  gastos_comunes: "#d08a4a",
  electricidad: "#f59e0b",
  gas: "#fcd34d",
  water: "#38bdf8",
  internet: "#8b98a8",
  contribuciones: "#5b6676",
  management_fee: "#a78bfa",
  rent: "#c084fc",
  mortgage_amortization: "#34d399",
  mortgage_extra_amortization: "#1f8a65",
};

export function costKindColor(kind: string): string {
  const c = (COST_KIND_COLORS as Record<string, string>)[kind];
  if (!c) throw new Error(`depto cost: no colour for kind ${kind}`);
  return c;
}

/**
 * Monthly bills of the property's place: costs stacked up, equity (amortization) down, both to the
 * server's cap; an equity side over the cap is cut and its total printed under the bar. The rail's
 * 12 months are shaded; months after them (bills still coming) are faint.
 */
export function CostChart({ cost, unit, w, h }: { cost: DeptoCostBandDto; unit: string; w: number; h: number }) {
  const months = cost.months;
  if (months.length === 0) return null;
  const tickLabels = cost.axis.ticks.map((t) => axisCompact(t, unit));
  const ml = Math.max(...tickLabels.map(textW)) + 8;
  const mr = 4;
  const mt = 8;
  const mb = 40;
  const plotW = w - ml - mr;
  const slot = plotW / months.length;
  const bw = Math.max(1, slot * 0.68);
  const mid = mt + (h - mt - mb) / 2;
  const half = (h - mt - mb) / 2;
  const px = (v: number) => (Math.min(v, cost.axis.cap) / cost.axis.cap) * half;
  const costKinds = cost.kinds.filter((k) => k.direction === "cost");
  const equityKinds = cost.kinds.filter((k) => k.direction === "equity");
  const inWindow = months.map((m, i) => (m.in_window ? i : -1)).filter((i) => i >= 0);
  const windowTo = cost.window?.to ?? null;
  const ticks = monthTicks(
    months.map((m) => m.month),
    slot,
    34
  );
  return (
    <g>
      {inWindow.length ? (
        <rect
          x={ml + slot * inWindow[0]!}
          y={mt}
          width={slot * (inWindow[inWindow.length - 1]! - inWindow[0]! + 1)}
          height={h - mt - mb + 4}
          style={{ fill: "var(--surface2)" }}
          opacity={0.55}
        />
      ) : null}
      {cost.axis.ticks.map((t, i) => (
        <g key={t}>
          <line x1={ml} x2={w - mr} y1={mid - px(t)} y2={mid - px(t)} stroke="var(--hairline)" strokeDasharray="2 4" />
          <line x1={ml} x2={w - mr} y1={mid + px(t)} y2={mid + px(t)} stroke="var(--hairline)" strokeDasharray="2 4" />
          <text x={ml - 6} y={mid - px(t) + 3} textAnchor="end">
            {tickLabels[i]}
          </text>
          <text x={ml - 6} y={mid + px(t) + 3} textAnchor="end">
            {tickLabels[i]}
          </text>
        </g>
      ))}
      {months.map((m, i) => {
        const x0 = ml + slot * i + (slot - bw) / 2;
        const faint = windowTo != null && m.month > windowTo;
        let up = 0;
        let down = 0;
        const rects: ReactNode[] = [];
        for (const k of costKinds) {
          const v = m.values[k.kind] ?? 0;
          if (v <= 0) continue;
          const hgt = px(up + v) - px(up);
          up += v;
          rects.push(<rect key={k.kind} x={x0} y={mid - px(up)} width={bw} height={hgt} style={{ fill: costKindColor(k.kind) }} />);
        }
        for (const k of equityKinds) {
          const v = m.values[k.kind] ?? 0;
          if (v <= 0) continue;
          const hgt = px(down + v) - px(down);
          if (hgt > 0) {
            rects.push(
              <rect key={k.kind} x={x0} y={mid + 1 + px(down)} width={bw} height={hgt} style={{ fill: costKindColor(k.kind) }} />
            );
          }
          down += v;
        }
        return (
          <g key={m.month} opacity={faint ? 0.45 : undefined}>
            {rects}
            {m.equity_over_cap ? (
              <>
                <path d={`M${x0 - 1},${mid + half - 3} l${bw + 2},-4`} style={{ stroke: "var(--bg)" }} strokeWidth={2} />
                {/* The clipped total under the bar, where it fits the bar's slot (8px text). */}
                {axisCompact(m.equity_total, unit).length * CH * 0.8 <= slot ? (
                  <text x={x0 + bw / 2} y={h - mb + 12} textAnchor="middle" className={styles.tiny}>
                    {axisCompact(m.equity_total, unit)}
                  </text>
                ) : null}
              </>
            ) : null}
          </g>
        );
      })}
      <line x1={ml} x2={w - mr} y1={mid + 0.5} y2={mid + 0.5} style={{ stroke: TONE_FILL.muted }} strokeOpacity={0.6} />
      {ticks.map((t) => (
        <g key={t.month}>
          <text x={ml + slot * (t.index + 0.5)} y={h - mb + 25} textAnchor="middle">
            {formatMonthShortLabel(t.month)}
          </text>
          {t.withYear ? (
            <text x={ml + slot * (t.index + 0.5)} y={h - mb + 37} textAnchor="middle">
              {t.month.slice(0, 4)}
            </text>
          ) : null}
        </g>
      ))}
    </g>
  );
}

/* ---------------- mortgage: balance band ---------------- */

/** Year gridlines (1 January of each year after the first) inside [d0, d1]. */
function yearLines(d0: number, d1: number, every = 1): { year: number; day: number }[] {
  const y0 = new Date(d0 * 86_400_000).getUTCFullYear();
  const y1 = new Date(d1 * 86_400_000).getUTCFullYear();
  const out: { year: number; day: number }[] = [];
  for (let y = y0 + 1; y <= y1; y++) {
    if (y % every === 0) out.push({ year: y, day: Date.UTC(y, 0, 1) / 86_400_000 });
  }
  return out;
}

/**
 * The balance after the pie and every payment (loan currency) as steps up to today, prepagos as
 * accent drops with what they took off.
 */
export function BalanceChart({
  balance,
  asOf,
  loanCurrency,
  w,
  h,
}: {
  balance: DeptoBalanceBandDto;
  asOf: string;
  loanCurrency: string;
  w: number;
  h: number;
}) {
  const pts = balance.points;
  if (pts.length === 0) return null;
  const top = Math.max(...pts.map((p) => p.balance_loan));
  const axis = buildNiceYAxis(0, top);
  const last = pts[pts.length - 1]!;
  const endText = formatCurrency(last.balance_loan, loanCurrency);
  const ml = textW(loanWholeBare(top)) + 8;
  const mr = textW(endText) + 14;
  const mt = 10;
  const mb = 18;
  const d0 = dayNumber(pts[0]!.date);
  const d1 = Math.max(dayNumber(asOf), dayNumber(last.date));
  const x = linear(d0, d1, ml, w - mr);
  const y = linear(0, axis.domain[1], h - mb, mt);
  const steps = stepPoints([...pts.map((p) => [x(dayNumber(p.date)), y(p.balance_loan)] as const), [x(d1), y(last.balance_loan)]]);
  const area = [[steps[0]![0], y(0)] as const, ...steps, [steps[steps.length - 1]![0], y(0)] as const];
  // One gridline between 0 and the original loan: the axis tick nearest its middle.
  const inner = axis.ticks.filter((t) => t > 0 && y(t) - y(balance.original_loan) > 14);
  const midTicks = inner.length
    ? [inner.reduce((a, b) => (Math.abs(b - balance.original_loan / 2) < Math.abs(a - balance.original_loan / 2) ? b : a))]
    : [];
  const years = yearLines(d0, d1);
  return (
    <g>
      {years.map((yl) => (
        <line key={yl.year} x1={x(yl.day)} x2={x(yl.day)} y1={mt} y2={h - mb} stroke="var(--hairline)" />
      ))}
      <polygon points={pointsAttr(area)} style={{ fill: TONE_FILL.neg }} fillOpacity={0.09} />
      {midTicks.map((t) => (
        <g key={t}>
          <line x1={ml} x2={w - mr} y1={y(t)} y2={y(t)} stroke="var(--hairline)" strokeDasharray="2 3" />
          <text x={ml - 6} y={y(t) + 3} textAnchor="end">
            {loanWholeBare(t)}
          </text>
        </g>
      ))}
      <polyline points={pointsAttr(steps)} fill="none" style={{ stroke: TONE_FILL.hi }} strokeWidth={1.5} />
      <line x1={ml} x2={w - mr} y1={h - mb} y2={h - mb} stroke="var(--hairline)" />
      <text x={ml - 6} y={y(balance.original_loan) + 3} textAnchor="end">
        {loanWholeBare(balance.original_loan)}
      </text>
      <text x={ml - 6} y={h - mb + 3} textAnchor="end">
        {loanWholeBare(0)}
      </text>
      <text x={ml + 3} y={h - 4}>
        {new Date(d0 * 86_400_000).getUTCFullYear()}
      </text>
      {years.map((yl) => (
        <text key={yl.year} x={x(yl.day) + 3} y={h - 4}>
          {yl.year}
        </text>
      ))}
      {pts.map((p, i) => {
        if (p.kind !== "prepago" || p.step_loan == null || i === 0) return null;
        const px = x(dayNumber(p.date));
        const yFrom = y(pts[i - 1]!.balance_loan);
        const yTo = y(p.balance_loan);
        return (
          <g key={`${p.date}-${i}`}>
            <line x1={px} x2={px} y1={yFrom} y2={yTo} style={{ stroke: TONE_FILL.amb }} strokeWidth={2.4} />
            <text x={px + 5} y={(yFrom + yTo) / 2 + 3} style={{ fill: TONE_FILL.amb }}>
              {`${signOf(p.step_loan)}${formatCurrency(Math.abs(p.step_loan), loanCurrency)}`}
            </text>
          </g>
        );
      })}
      <circle cx={x(d1)} cy={y(last.balance_loan)} r={3} style={{ fill: TONE_FILL.hi }} />
      <text x={x(d1) + 8} y={y(last.balance_loan) + 3} style={{ fill: TONE_FILL.hi }}>
        {endText}
      </text>
    </g>
  );
}

/* ---------------- mortgage: projection ---------------- */

/** The balance so far, then the two payoff paths to zero (usual pace in the accent, the minimum muted). */
export function ProjectionChart({
  balance,
  projection,
  loanCurrency,
  w,
  h,
}: {
  balance: DeptoBalanceBandDto;
  projection: DeptoProjectionDto;
  loanCurrency: string;
  w: number;
  h: number;
}) {
  const pts = balance.points;
  const usual = projection.usual;
  const minimum = projection.minimum;
  if (pts.length === 0 || usual.path.length === 0 || minimum.path.length === 0) return null;
  const top = Math.max(...pts.map((p) => p.balance_loan));
  const ml = textW(loanWholeBare(top)) + 8;
  const mr = textW(minimum.end_date.slice(0, 7)) / 2 + 6;
  const mt = 10;
  const mb = 20;
  const d0 = dayNumber(pts[0]!.date);
  const d1 = Math.max(dayNumber(usual.end_date), dayNumber(minimum.end_date));
  const x = linear(d0, d1, ml, w - mr);
  const y = linear(0, top, h - mb, mt);
  const today = usual.path[0]!;
  const history = stepPoints([...pts.map((p) => [x(dayNumber(p.date)), y(p.balance_loan)] as const), [x(dayNumber(today.date)), y(today.balance_loan)]]);
  const path = (p: typeof usual.path) => p.map((q) => [x(dayNumber(q.date)), y(q.balance_loan)] as const);
  const spanYears = (d1 - d0) / 365.25;
  const every = (w - ml - mr) / spanYears * 5 >= 48 ? 5 : 10;
  const years = yearLines(d0, d1, every);
  const ends = [
    { key: "usual", date: usual.end_date, fill: TONE_FILL.acc },
    { key: "minimum", date: minimum.end_date, fill: TONE_FILL.muted },
  ];
  return (
    <g>
      {years.map((yl) => (
        <g key={yl.year}>
          <line x1={x(yl.day)} x2={x(yl.day)} y1={mt} y2={h - mb} stroke="var(--hairline)" />
          <text x={x(yl.day) + 3} y={h - 6}>
            {yl.year}
          </text>
        </g>
      ))}
      <line x1={ml} x2={w - mr} y1={h - mb} y2={h - mb} stroke="var(--hairline)" />
      <text x={ml - 6} y={y(top) + 3} textAnchor="end">
        {loanWholeBare(top)}
      </text>
      <text x={ml - 6} y={h - mb + 3} textAnchor="end">
        {loanWholeBare(0)}
      </text>
      <polyline points={pointsAttr(history)} fill="none" style={{ stroke: TONE_FILL.hi }} strokeWidth={1.5} />
      <polyline points={pointsAttr(path(minimum.path))} fill="none" style={{ stroke: TONE_FILL.muted }} strokeWidth={1.3} strokeDasharray="4 3" />
      <polyline points={pointsAttr(path(usual.path))} fill="none" style={{ stroke: TONE_FILL.acc }} strokeWidth={1.6} strokeDasharray="4 3" />
      {ends.map((e) => (
        <g key={e.key}>
          <circle cx={x(dayNumber(e.date))} cy={h - mb} r={3} style={{ fill: e.fill }} />
          <text x={x(dayNumber(e.date))} y={h - mb - 8} textAnchor="middle" style={{ fill: e.fill }}>
            {e.date.slice(0, 7)}
          </text>
        </g>
      ))}
      <text x={x(dayNumber(today.date)) + 6} y={y(today.balance_loan) - 6} style={{ fill: TONE_FILL.hi }}>
        {formatCurrency(today.balance_loan, loanCurrency)}
      </text>
    </g>
  );
}
