import type { CSSProperties } from "react";
import { useTranslation } from "../../i18n";
import { formatMoney } from "../../format";
import { formatYearMonthLabel } from "../../formatDateLabel";
import type { CcGroupLanesResponse, CcGroupUpcomingMonthDto } from "../../types";
import styles from "./CcUpcomingPaymentsList.module.css";

type Kind = CcGroupUpcomingMonthDto["parts"][number]["kind"];

const KIND_LABEL: Record<Kind, string> = {
  billed: "groupPage.creditCardLanes.kindBilled",
  open: "groupPage.creditCardLanes.kindOpen",
  cuotas: "groupPage.creditCardLanes.kindCuotas",
};

/**
 * «Upcoming payments» on the credit-card group page, a list: one row per pay month
 * (server `upcoming_months`, `ccGroupLanes.ts`) with its total, a bar stacked by card in the lanes'
 * order (each card's colour; a segment's hover names its kind) on one scale for every row, and each
 * card's amount under it, «≈» when it holds an open bill. The client only lays the server's parts out.
 */
export function CcUpcomingPaymentsList({ data, loading }: { data: CcGroupLanesResponse; loading?: boolean }) {
  const { t } = useTranslation();
  const billing = data.billing_currency;
  const months = data.upcoming_months;
  const money = (v: number) => formatMoney({ value: v, currency: billing });
  const cardOf = (id: number) => data.cards.find((c) => c.account_id === id);
  const scale = Math.max(1, ...months.map((m) => m.total));

  if (months.length === 0) {
    return loading ? null : <p className="muted">{t("groupPage.creditCardLanes.upcomingEmpty")}</p>;
  }
  return (
    <div className={styles.frame}>
      <ol className={styles.list}>
        {months.map((m) => {
          // Each card's amount in the month (its kinds summed), for the line under the bar.
          const byCard = new Map<number, { amount: number; estimate: boolean }>();
          for (const p of m.parts) {
            const cur = byCard.get(p.account_id) ?? { amount: 0, estimate: false };
            byCard.set(p.account_id, { amount: cur.amount + p.amount, estimate: cur.estimate || p.kind === "open" });
          }
          return (
            <li key={m.month} className={styles.row}>
              <span className={styles.month}>{formatYearMonthLabel(m.month)}</span>
              <span className={styles.bar} aria-hidden>
                {m.parts.map((p) => {
                  const card = cardOf(p.account_id);
                  return (
                    <i
                      key={`${p.account_id}-${p.kind}`}
                      title={`${card?.name ?? p.account_id} · ${t(KIND_LABEL[p.kind])}: ${money(p.amount)}`}
                      style={
                        {
                          width: `${(p.amount / scale) * 100}%`,
                          background: card ? `rgb(${card.color_rgb})` : "var(--muted)",
                        } as CSSProperties
                      }
                    />
                  );
                })}
              </span>
              <b className={`${styles.total} mono`}>{money(m.total)}</b>
              <span className={styles.parts}>
                {[...byCard.entries()].map(([id, v]) => {
                  const card = cardOf(id);
                  return (
                    <span key={id} className={styles.part}>
                      <i className={styles.swatch} style={{ background: card ? `rgb(${card.color_rgb})` : "var(--muted)" }} aria-hidden />
                      {card?.name ?? id}{" "}
                      <span className="mono" title={v.estimate ? t("groupPage.creditCardLanes.estimateHint") : undefined}>
                        {v.estimate ? "≈ " : ""}
                        {money(v.amount)}
                      </span>
                    </span>
                  );
                })}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
