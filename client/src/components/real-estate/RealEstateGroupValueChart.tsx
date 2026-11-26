import { buildNiceYAxis } from "../charts/chartLayout";
import { dayNumber, linear, monthTicks, pointsAttr, spreadLabels } from "../depto/deptoChartLayout";
import { axisCompact, monthTickLabel } from "../depto/deptoFormat";
import { formatMoney } from "../../format";
import type { RealEstateGroupSummedDto } from "../../types";

/** An approximate mono character width at the charts' 10px, for label room (as the depto charts). */
const CH = 6.1;
const LABEL_GAP = 11;

/**
 * The property page's value chart over several properties (the server's sums per date, in the
 * unit): the appraisals' value dashed, what is owed as the band under it, deposited thin, and the
 * net equity as layers, one per property in its row's colour, under the total's line. Drawn at the
 * size of its box, like the depto charts; the end figures name the lines.
 */
export function RealEstateGroupValueChart({ summed, unit, w, h }: { summed: RealEstateGroupSummedDto; unit: string; w: number; h: number }) {
  const { dates, series, totals } = summed.value;
  const n = dates.length;
  if (n === 0) return null;
  const last = totals[n - 1]!;
  const colorOf = new Map(summed.properties.map((p) => [p.account_id, `rgb(${p.color_rgb})`]));
  const ends = [
    { key: "value", text: formatMoney({ value: last.value, currency: unit }), fill: "var(--muted)", y0: last.value },
    { key: "mortgage", text: formatMoney({ value: last.mortgage, currency: unit }), fill: "var(--negative)", y0: (last.value + last.equity) / 2 },
    { key: "deposited", text: formatMoney({ value: last.deposited, currency: unit }), fill: "var(--muted)", y0: last.deposited },
    { key: "equity", text: formatMoney({ value: last.equity, currency: unit }), fill: "var(--text)", y0: last.equity },
  ];
  // The properties' net equity can sum below zero (owed more than the appraisals): the axis spans it.
  const axis = buildNiceYAxis(Math.min(0, ...totals.map((t) => t.equity)), Math.max(...totals.map((t) => Math.max(t.value, t.deposited))));
  const tickLabels = axis.ticks.map((t) => axisCompact(t, unit));
  const ml = Math.max(...tickLabels.map((s) => s.length * CH)) + 8;
  const mr = Math.max(...ends.map((e) => e.text.length * CH)) + 12;
  const mt = 8;
  const mb = 18;
  const x = linear(dayNumber(dates[0]!), dayNumber(dates[n - 1]!), ml, w - mr);
  const y = linear(axis.domain[0], axis.domain[1], h - mb, mt);
  const xs = dates.map((d) => x(dayNumber(d)));
  const line = (key: "value" | "equity" | "deposited") => totals.map((t, i) => [xs[i]!, y(t[key])] as const);
  const valueLine = line("value");
  const equityLine = line("equity");

  // Running stack of the properties' net equity: a layer starts at its property's first point.
  const base = dates.map(() => 0);
  const layers = series.map((s) => {
    const first = s.equity.findIndex((v) => v != null);
    const lower: (readonly [number, number])[] = [];
    const upper: (readonly [number, number])[] = [];
    for (let i = Math.max(first, 0); i < n; i++) {
      const v = s.equity[i] ?? 0;
      lower.push([xs[i]!, y(base[i]!)]);
      base[i] = base[i]! + v;
      upper.push([xs[i]!, y(base[i]!)]);
    }
    return { accountId: s.account_id, area: [...upper, ...lower.reverse()] };
  });

  const labels = spreadLabels(
    ends.map((e) => ({ ...e, y: y(e.y0) + 3 })),
    LABEL_GAP,
    mt + 6,
    h - mb
  );
  const months = dates.map((d) => d.slice(0, 7));
  const ticks = monthTicks(months, (w - ml - mr) / Math.max(1, n - 1), 56);
  return (
    <g>
      {axis.ticks.map((t, i) => (
        <g key={t}>
          <line x1={ml} x2={w - mr} y1={y(t)} y2={y(t)} stroke="var(--hairline)" strokeDasharray={t === 0 ? undefined : "2 4"} />
          <text x={ml - 6} y={y(t) + 3} textAnchor="end">
            {tickLabels[i]}
          </text>
        </g>
      ))}
      <polygon points={pointsAttr([...valueLine, ...[...equityLine].reverse()])} style={{ fill: "var(--negative)" }} opacity={0.08} />
      {layers.map((l) => (
        <polygon key={l.accountId} points={pointsAttr(l.area)} style={{ fill: colorOf.get(l.accountId) ?? "var(--accent)" }} fillOpacity={0.45} />
      ))}
      <polyline points={pointsAttr(valueLine)} fill="none" style={{ stroke: "var(--muted)" }} strokeDasharray="3 3" />
      <polyline points={pointsAttr(line("deposited"))} fill="none" style={{ stroke: "var(--muted)" }} strokeOpacity={0.7} />
      <polyline points={pointsAttr(equityLine)} fill="none" style={{ stroke: "var(--text)" }} strokeWidth={1.5} strokeLinejoin="round" />
      <circle cx={xs[n - 1]} cy={y(last.equity)} r={2.6} style={{ fill: "var(--text)" }} />
      {labels.map((l) => (
        <text key={l.key} x={w - mr + 8} y={l.at} style={{ fill: l.fill }}>
          {l.text}
        </text>
      ))}
      {ticks.map((t) => (
        <text key={t.month} x={xs[t.index]} y={h - 4} textAnchor="middle">
          {monthTickLabel(t.month, t.withYear)}
        </text>
      ))}
    </g>
  );
}
