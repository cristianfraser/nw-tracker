import { Fragment, type CSSProperties } from "react";
import { useTranslation } from "../../i18n";
import { formatMoney } from "../../format";
import { formatYearMonthLabel } from "../../formatDateLabel";
import type { LiabilitiesGlanceDto } from "../../types";
import styles from "./CcUpcomingPaymentsList.module.css";
import own from "./Liabilities.module.css";

/**
 * «Upcoming payments» on the Liabilities page — the credit-card group's list (same look and
 * layout, `CcUpcomingPaymentsList`) with the loans in it: a row per pay month (server
 * `upcoming_months`, `liabilitiesGlance.ts`) with its total, one bar on a scale shared by every row,
 * each debt in its colour — a loan's minimum cuota followed by the room up to its maximum
 * (hatched), then the cards' payments; under the bar each debt's amount, «≈» when it is an
 * estimate, a loan's «min … max»; under the total, the month with each loan at its maximum. The
 * client only lays the server's parts out.
 */
export function LiabilitiesUpcomingList({ data, loading }: { data: LiabilitiesGlanceDto | undefined; loading: boolean }) {
  const { t } = useTranslation();
  const months = data?.upcoming_months ?? [];
  if (data == null || months.length === 0) {
    return data == null || loading ? null : <p className="muted">{t("liabilities.page.upcomingEmpty")}</p>;
  }
  const unit = data.unit;
  const money = (v: number) => formatMoney({ value: v, currency: unit });
  const scale = Math.max(1, ...months.map((m) => m.total_max ?? m.total));
  return (
    <div className={styles.frame}>
      <ol className={styles.list}>
        {months.map((m) => (
          <li key={m.month} className={styles.row}>
            <span className={styles.month}>{formatYearMonthLabel(m.month)}</span>
            <span className={styles.bar} aria-hidden>
              {m.parts.map((p, i) => (
                <Fragment key={`${p.kind}-${p.account_id}-${i}`}>
                  <i
                    title={`${p.name}: ${money(p.amount)}${p.amount_max != null ? ` … ${money(p.amount_max)}` : ""}`}
                    style={{ width: `${(p.amount / scale) * 100}%`, background: `rgb(${p.color_rgb})` }}
                  />
                  {p.amount_max != null && p.amount_max > p.amount ? (
                    <i
                      className={own.range}
                      title={`${p.name}: ${t("liabilities.page.upToMax", { amount: money(p.amount_max) })}`}
                      style={{ width: `${((p.amount_max - p.amount) / scale) * 100}%`, "--range-color": `rgb(${p.color_rgb})` } as CSSProperties}
                    />
                  ) : null}
                </Fragment>
              ))}
            </span>
            <b className={`${styles.total} mono`}>
              {money(m.total)}
              {m.total_max != null ? (
                <span className={own.totalMax} title={t("liabilities.page.upToMax", { amount: money(m.total_max) })}>
                  … {money(m.total_max)}
                </span>
              ) : null}
            </b>
            <span className={styles.parts}>
              {m.parts.map((p, i) => (
                <span key={`${p.kind}-${p.account_id}-${i}`} className={styles.part}>
                  <i className={styles.swatch} style={{ background: `rgb(${p.color_rgb})` }} aria-hidden />
                  {p.name}{" "}
                  <span className="mono" title={p.estimate ? t("liabilities.page.estimateHint") : undefined}>
                    {p.estimate ? "≈ " : ""}
                    {money(p.amount)}
                    {p.amount_max != null ? ` … ${money(p.amount_max)}` : ""}
                  </span>
                </span>
              ))}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
