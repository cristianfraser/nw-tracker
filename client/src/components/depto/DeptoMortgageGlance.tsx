import { cn } from "../../cn";
import { useTranslation } from "../../i18n";
import { PageGridTile } from "../layout/PageGridTile";
import { loadableClass } from "../ui/Loadable";
import type { DeptoBalanceBandDto, DeptoProjectionDto } from "../../types";
import { BalanceChart, ChartBox, ProjectionChart } from "./DeptoCharts";
import { pct1, signedMoney, toneOf, years1 } from "./deptoFormat";
import styles from "./Depto.module.css";
import { formatMoney, formatCurrency } from "../../format";

const BLANK = " ";

const w = (share: number) => `${share * 100}%`;

/**
 * The mortgage's balance band: the balance's steps (prepagos in the accent) beside a rail with what
 * is paid vs left and the financing cost by year. `balance` undefined while the bundle is pending.
 */
export function DeptoBalanceBand({
  balance,
  asOf,
  unit,
  loanCurrency,
  loading,
}: {
  balance: DeptoBalanceBandDto | undefined;
  asOf: string | undefined;
  unit: string;
  loanCurrency: string;
  loading: boolean;
}) {
  const { t } = useTranslation();
  return (
    <PageGridTile id="depto-balance" className={cn("page-grid", styles.scope, styles.bands)}>
      <div className={loadableClass(loading, styles.bandChart)}>
        <ChartBox ariaLabel={t("accountDetail.depto.balanceChart")}>
          {(cw, ch) => (balance && asOf ? <BalanceChart balance={balance} asOf={asOf} loanCurrency={loanCurrency} w={cw} h={ch} /> : null)}
        </ChartBox>
      </div>
      <div className={loadableClass(loading, styles.bandRail)}>
        {balance ? (
          <>
            <div className={styles.grp}>
              <div className={styles.paidBar}>
                <i style={{ width: w(balance.paid_share), background: "var(--accent)" }} />
                <i style={{ flex: 1, marginLeft: 1, background: "var(--depto-owed)" }} />
              </div>
              <div className={cn("mono", styles.ownl)}>
                <span className={styles.acc}>
                  {formatCurrency(balance.paid_loan, loanCurrency)} · {pct1(balance.paid_share)}
                </span>
                <span className={styles.muted}>{formatCurrency(balance.left_loan, loanCurrency)}</span>
              </div>
              <div className={cn("mono", styles.q)}>
                <span className={styles.amb}>{formatCurrency(balance.prepaid_loan, loanCurrency)}</span> ·{" "}
                <span>{formatCurrency(balance.cuotas_paid_loan, loanCurrency)}</span>
              </div>
            </div>
            <div className={styles.grp}>
              <div className={cn("mono", styles.kv)}>
                <span />
                <span className={styles[toneOf(balance.financing_cost.total) ?? "muted"]}>
                  {signedMoney(balance.financing_cost.total, unit)}
                </span>
              </div>
              <div className={cn("mono", styles.yrs)}>
                {balance.financing_cost.years.map((y) => (
                  <div key={y.year}>
                    <em>{y.year}</em>
                    <span className={styles[toneOf(y.cost) ?? "muted"]}>{signedMoney(y.cost, unit)}</span>
                  </div>
                ))}
              </div>
            </div>
          </>
        ) : (
          <>
            <div className={styles.grp}>
              <div className={styles.paidBar} />
              <div>{BLANK}</div>
              <div className={styles.q}>{BLANK}</div>
            </div>
            <div className={styles.grp}>
              <div>{BLANK}</div>
              <div className={styles.yrs}>
                <div>
                  <em>{BLANK}</em>
                  {BLANK}
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </PageGridTile>
  );
}

/**
 * The payoff projection: the balance so far and the two paths to zero (the usual pace, the
 * minimum), their end dates, cuotas, years and interest, the saving between them, then the term
 * strip with the usual pace at its place.
 */
export function DeptoProjection({
  balance,
  projection,
  unit,
  loanCurrency,
  payCurrency,
}: {
  balance: DeptoBalanceBandDto;
  projection: DeptoProjectionDto;
  unit: string;
  loanCurrency: string;
  payCurrency: string;
}) {
  const { t } = useTranslation();
  const { usual, minimum, saving } = projection;
  const term = (s: DeptoProjectionDto["terms"][number]) =>
    s.term === "max" ? t("accountDetail.depto.termMax") : t("accountDetail.depto.termYears", { years: years1(s.years ?? 0) });
  return (
    <PageGridTile id="depto-projection" className={cn(styles.scope, styles.projection)}>
      <ChartBox ariaLabel={t("accountDetail.depto.projectionChart")}>
        {(cw, ch) => <ProjectionChart balance={balance} projection={projection} loanCurrency={loanCurrency} w={cw} h={ch} />}
      </ChartBox>
      <div className={styles.payoff}>
        <div>
          <div className={styles.q}>
            {usual.amortization_loan != null
              ? t("accountDetail.depto.usualPace", { amount: formatCurrency(usual.amortization_loan, loanCurrency) })
              : null}
          </div>
          <div className={cn("mono", styles.payoffKey, styles.acc)}>{usual.end_date}</div>
          <div className={cn("mono", styles.q)}>
            {t("accountDetail.depto.cuotasYears", { cuotas: usual.cuotas, years: years1(usual.years) })} ·{" "}
            <span className={styles.neg}>{formatCurrency(usual.interest_loan, loanCurrency)}</span>
          </div>
        </div>
        <div>
          <div className={styles.q}>{t("accountDetail.depto.minimum")}</div>
          <div className={cn("mono", styles.payoffKey)}>{minimum.end_date}</div>
          <div className={cn("mono", styles.q)}>
            {t("accountDetail.depto.cuotasYears", { cuotas: minimum.cuotas, years: years1(minimum.years) })} ·{" "}
            <span className={styles.neg}>{formatCurrency(minimum.interest_loan, loanCurrency)}</span>
          </div>
        </div>
        <div>
          <div className={styles.q}>{t("accountDetail.depto.saving")}</div>
          <div className={cn("mono", styles.payoffKey, styles.pos)}>{formatCurrency(saving.interest_loan, loanCurrency)}</div>
          <div className={cn("mono", styles.q)}>
            {formatMoney({ value: saving.interest, currency: unit })} · {t("accountDetail.depto.yearsEarlier", { years: years1(saving.years_earlier) })}
          </div>
        </div>
      </div>
      <div className={cn("mono", styles.terms)}>
        {projection.terms.map((s) => (
          <div key={String(s.term)} className={s.highlighted ? styles.you : undefined}>
            <em>{term(s)}</em>
            <span>{s.payment_loan != null ? formatMoney({ value: s.payment_loan, currency: loanCurrency }) : "—"}</span>
            <i>{s.payment_pay != null ? formatMoney({ value: s.payment_pay, currency: payCurrency }) : "—"}</i>
          </div>
        ))}
      </div>
    </PageGridTile>
  );
}

