import { buildNiceYAxis } from "../charts/chartLayout";
import { dayNumber, linear, pointsAttr, stepPoints } from "../depto/deptoChartLayout";
import { axisCompact, signedMoney } from "../depto/deptoFormat";
import { formatMoney } from "../../format";
import type { MortgageGroupGlanceDto } from "../../types";

/**
 * The mortgage group's balance chart: each loan's balance (the server's values in the unit, at each
 * date's rate) stacked as steps up to today, a loan in its own colour when there are several —
 * one loan reads like its own page (text-coloured steps over a faint red area) —, prepagos as
 * amber drops with what they took off. Drawn at the size of its box, like the depto charts.
 */
export function MortgageGroupChart({ glance, w, h }: { glance: MortgageGroupGlanceDto; w: number; h: number }) {
  const { chart, unit } = glance;
  const n = chart.dates.length;
  if (n === 0 || chart.series.length === 0) return null;
  const single = chart.series.length === 1;
  const colorOf = new Map(glance.loans.map((l) => [l.account_id, `rgb(${l.color_rgb})`]));

  // Running stack: tops[s][i] = Σ series 0..s at date i.
  const tops: number[][] = [];
  chart.series.forEach((s, si) => {
    tops.push(s.values.map((v, i) => (si === 0 ? 0 : tops[si - 1]![i]!) + (v ?? 0)));
  });
  const total = tops[tops.length - 1]!;
  const topMax = Math.max(...total);
  if (!(topMax > 0)) return null;
  const axis = buildNiceYAxis(0, topMax);
  const endText = formatMoney({ value: total[n - 1]!, currency: unit });
  const tickTexts = axis.ticks.map((t) => axisCompact(t, unit));
  const ml = Math.max(...tickTexts.map((s) => s.length)) * 6.1 + 8;
  const mr = endText.length * 6.1 + 14;
  const mt = 10;
  const mb = 18;
  const d0 = dayNumber(chart.dates[0]!);
  const d1 = dayNumber(chart.dates[n - 1]!);
  const x = linear(d0, d1, ml, w - mr);
  const y = linear(0, axis.domain[1], h - mb, mt);
  const years: { year: number; day: number }[] = [];
  for (let yy = new Date(d0 * 86_400_000).getUTCFullYear() + 1; yy <= new Date(d1 * 86_400_000).getUTCFullYear(); yy++) {
    years.push({ year: yy, day: Date.UTC(yy, 0, 1) / 86_400_000 });
  }

  const xs = chart.dates.map((d) => x(dayNumber(d)));
  const layers = chart.series.map((s, si) => {
    // A loan's layer starts at its first value (the dates before it carry nothing).
    const first = s.values.findIndex((v) => v != null);
    const idx = xs.map((_, i) => i).filter((i) => i >= first);
    const upper = stepPoints(idx.map((i) => [xs[i]!, y(tops[si]![i]!)] as const));
    const lower = stepPoints(idx.map((i) => [xs[i]!, y(si === 0 ? 0 : tops[si - 1]![i]!)] as const));
    return { s, upper, area: [...upper, ...[...lower].reverse()] };
  });

  return (
    <g>
      {years.map((yl) => (
        <line key={yl.year} x1={x(yl.day)} x2={x(yl.day)} y1={mt} y2={h - mb} stroke="var(--hairline)" />
      ))}
      {axis.ticks.map((t, i) =>
        t > 0 ? (
          <g key={t}>
            <line x1={ml} x2={w - mr} y1={y(t)} y2={y(t)} stroke="var(--hairline)" strokeDasharray="2 3" />
            <text x={ml - 6} y={y(t) + 3} textAnchor="end">
              {tickTexts[i]}
            </text>
          </g>
        ) : null
      )}
      {layers.map(({ s, area }) => (
        <polygon
          key={`a${s.account_id}`}
          points={pointsAttr(area)}
          style={{ fill: single ? "var(--negative)" : colorOf.get(s.account_id) }}
          fillOpacity={single ? 0.09 : 0.22}
        />
      ))}
      {layers.map(({ s, upper }) => (
        <polyline
          key={`l${s.account_id}`}
          points={pointsAttr(upper)}
          fill="none"
          style={{ stroke: single ? "var(--text)" : colorOf.get(s.account_id) }}
          strokeWidth={1.5}
        />
      ))}
      <line x1={ml} x2={w - mr} y1={h - mb} y2={h - mb} stroke="var(--hairline)" />
      <text x={ml - 6} y={h - mb + 3} textAnchor="end">
        {axisCompact(0, unit)}
      </text>
      <text x={ml + 3} y={h - 4}>
        {new Date(d0 * 86_400_000).getUTCFullYear()}
      </text>
      {years.map((yl) => (
        <text key={yl.year} x={x(yl.day) + 3} y={h - 4}>
          {yl.year}
        </text>
      ))}
      {chart.prepagos.map((p) => {
        const si = chart.series.findIndex((s) => s.account_id === p.account_id);
        const i = chart.dates.indexOf(p.date);
        if (si < 0 || i <= 0) return null;
        const px = xs[i]!;
        // The drop is the prepago's own step (its label), ending at the loan's layer that day: the
        // stacked sum since the previous chart date also holds cuotas and UF drift.
        const yTo = y(tops[si]![i]!);
        const yFrom = y(tops[si]![i]! - p.step);
        return (
          <g key={`${p.account_id}-${p.date}`}>
            <line x1={px} x2={px} y1={yFrom} y2={yTo} style={{ stroke: "var(--depto-amber)" }} strokeWidth={2.4} />
            <text x={px + 5} y={(yFrom + yTo) / 2 + 3} style={{ fill: "var(--depto-amber)" }}>
              {signedMoney(p.step, unit)}
            </text>
          </g>
        );
      })}
      <circle cx={xs[n - 1]} cy={y(total[n - 1]!)} r={3} style={{ fill: "var(--text)" }} />
      <text x={xs[n - 1]! + 8} y={y(total[n - 1]!) + 3} style={{ fill: "var(--text)" }}>
        {endText}
      </text>
    </g>
  );
}
