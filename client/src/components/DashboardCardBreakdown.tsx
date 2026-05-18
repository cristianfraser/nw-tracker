import type { CardBreakdownLine } from "../dashboardCardBreakdown";

type Props = {
  lines: CardBreakdownLine[];
  formatAmount: (clp: number, usd?: number | null) => string;
};

export function DashboardCardBreakdown({ lines, formatAmount }: Props) {
  if (lines.length === 0) return null;
  return (
    <ul className="card-breakdown">
      {lines.map((line, i) => (
        <li
          key={`${line.depth}-${line.label}-${i}`}
          className={
            line.depth >= 2
              ? "card-breakdown__grandchild"
              : line.depth === 1
                ? "card-breakdown__child"
                : "card-breakdown__group"
          }
        >
          <span className="card-breakdown__label">{line.label}</span>
          <span className="card-breakdown__amount mono">{formatAmount(line.clp, line.usd)}</span>
        </li>
      ))}
    </ul>
  );
}
