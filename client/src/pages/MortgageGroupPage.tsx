import { useMemo } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import { cn } from "../cn";
import { useTranslation } from "../i18n";
import { useDisplayPreferences } from "../context/DisplayPreferencesContext";
import { useMortgageGroupGlance, useSidebarNav } from "../queries/hooks";
import { queryLoadError, queryShowsLoading } from "../queries/pageShapeReady";
import { findBestNavNodeForPathname } from "../portfolioNavFromApi";
import { resolveNavTreeLabel } from "../sidebarNavFromApi";
import { DASHBOARD_PATH } from "../dashboardPath";
import { formatMoney } from "../format";
import { PageGridTile } from "../components/layout/PageGridTile";
import { loadableClass } from "../components/ui/Loadable";
import { ChartBox } from "../components/depto/DeptoCharts";
import { pct1, signedMoney, toneOf } from "../components/depto/deptoFormat";
import { MortgageGroupChart } from "../components/liabilities/MortgageGroupChart";
import { DeptoPaymentsList } from "../components/depto/DeptoPaymentsList";
import depto from "../components/depto/Depto.module.css";
import styles from "../components/liabilities/MortgageGroup.module.css";
import type { MortgageGroupGlanceDto, MortgageGroupLoanDto } from "../types";

const BLANK = " ";

/**
 * Pasivos › mortgage (`/liabilities/mortgage`): the loan page's look over every loan of the group
 * (server `mortgage-glance`, `mortgageGroupGlance.ts`). The header and balance band are the
 * mortgage page's, summed in the display unit; the loan list keeps each loan's own currency beside
 * it and links to its page, where the payoff projection lives; then every loan's payments as one
 * list, the loan page's list merged by the server. The page only picks and formats;
 * while the payload is pending the frames render blank and dimmed.
 */
export function MortgageGroupPage() {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const { displayUnit } = useDisplayPreferences();
  const { data: sidebarNav, isPending: navPending, isFetching: navFetching } = useSidebarNav(); // convention-ok: nav refetch gates «not found» only, no dim
  const navSettled = !navPending && !navFetching;
  const node = useMemo(() => findBestNavNodeForPathname(sidebarNav?.main, pathname), [sidebarNav, pathname]);
  const query = useMortgageGroupGlance(node?.slug, displayUnit);
  const glance = query.data;
  const loading = queryShowsLoading(query);
  const error = queryLoadError(query);

  if (!node && navSettled) return <Navigate to={DASHBOARD_PATH} replace />;
  const title = node ? resolveNavTreeLabel(node) : "";
  if (error) {
    return (
      <main>
        <h1>{title || BLANK}</h1>
        <p className="error">{error instanceof Error ? error.message : t("common.loadFailed")}</p>
      </main>
    );
  }

  return (
    <main>
      <MortgageGroupHeader title={title} glance={glance} loading={loading} />
      <div className={cn("page-grid", depto.scope)}>
        <PageGridTile id="mortgage-next">
          <NextPayments glance={glance} loading={loading} />
        </PageGridTile>
        <PageGridTile id="mortgage-loans">
          <div className={loadableClass(loading, styles.frame)}>
            <LoanList glance={glance} />
          </div>
        </PageGridTile>
        <BalanceBand glance={glance} loading={loading} />
        {node ? <PaymentsTile slug={node.slug} glance={glance} loading={loading} /> : null}
      </div>
    </main>
  );
}

function MortgageGroupHeader({
  title,
  glance,
  loading,
}: {
  title: string;
  glance: MortgageGroupGlanceDto | undefined;
  loading: boolean;
}) {
  const { t } = useTranslation();
  const strip = glance?.strip;
  const cells = [
    { key: "day", label: t("accountDetail.depto.day"), value: strip?.day },
    { key: "month", label: t("accountDetail.depto.month"), value: strip?.month },
    { key: "year", label: t("accountDetail.depto.year"), value: strip?.year },
    { key: "total", label: t("accountDetail.depto.total"), value: strip?.total },
  ];
  return (
    <header className={cn(depto.scope, depto.head)}>
      <h1>{title || BLANK}</h1>
      <div className={loadableClass(loading, depto.hero)}>
        <span className={cn("mono", depto.heroBig)}>
          {glance ? formatMoney({ value: glance.balance, currency: glance.unit }) : BLANK}
        </span>
        {glance && glance.loans.length > 1 ? (
          <span className={cn("mono", depto.heroSec)}>{t("liabilities.mortgageGroup.loanCount", { count: glance.loans.length })}</span>
        ) : null}
      </div>
      <div className={cn("mono", depto.strip, styles.headStrip)}>
        {cells.map((c) => (
          <div key={c.key} className={loadableClass(loading)}>
            <em>{c.label}</em>
            <span>
              {c.value != null && glance ? (
                <span className={depto[toneOf(c.value) ?? "muted"]}>{signedMoney(c.value, glance.unit)}</span>
              ) : (
                BLANK
              )}
            </span>
          </div>
        ))}
      </div>
    </header>
  );
}

function NextPayments({ glance, loading }: { glance: MortgageGroupGlanceDto | undefined; loading: boolean }) {
  const { t } = useTranslation();
  const next = glance?.next;
  if (glance && next == null) return null;
  const unit = glance?.unit;
  return (
    <div className={loadableClass(loading, cn("mono", styles.next))}>
      <em>{next && next.count > 1 ? t("liabilities.mortgageGroup.nextPayments") : t("liabilities.mortgageGroup.nextPayment")}</em>
      {next && unit ? (
        <>
          <span>{next.first_date === next.last_date ? next.first_date : `${next.first_date} … ${next.last_date}`}</span>
          <span>
            {formatMoney({ value: next.min, currency: unit })}
            {next.max != null ? ` … ${formatMoney({ value: next.max, currency: unit })}` : ""}
          </span>
        </>
      ) : (
        <span>{BLANK}</span>
      )}
    </div>
  );
}

function PaidBar({ paidShare }: { paidShare: number }) {
  return (
    <div className={styles.bar}>
      <i style={{ width: `${paidShare * 100}%`, background: "var(--accent)" }} />
    </div>
  );
}

function LoanRow({ loan, unit, several }: { loan: MortgageGroupLoanDto; unit: string; several: boolean }) {
  const { t } = useTranslation();
  const native = (value: number) => formatMoney({ value, currency: loan.loan_currency });
  const showUnit = loan.loan_currency !== unit;
  return (
    <li className={styles.row}>
      <span className={cn(styles.name, styles.cName)}>
        {several ? <i className={styles.sw} style={{ background: `rgb(${loan.color_rgb})` }} /> : null}
        <Link to={`/account/${loan.account_id}`}>{loan.name}</Link>
      </span>
      <span className={cn("mono", styles.r, styles.cBal)}>
        {native(loan.balance_loan)}
        {showUnit ? <span className={styles.sub}>{formatMoney({ value: loan.balance, currency: unit })}</span> : null}
      </span>
      <span className={cn("mono", styles.cPaid)}>
        <PaidBar paidShare={loan.paid_share} />
        <span className={styles.sub}>
          {t("liabilities.mortgageGroup.paidOf", { share: pct1(loan.paid_share), original: native(loan.original_loan) })}
          {loan.prepaid_loan > 0 ? (
            <>
              {" · "}
              <span className={depto.amb}>{native(loan.prepaid_loan)}</span> {t("accountDetail.depto.prepaid")}
            </>
          ) : null}
        </span>
      </span>
      <span className={cn("mono", styles.r, styles.cNext)}>
        {loan.next ? (
          <>
            <em className={styles.lbl}>{t("liabilities.mortgageGroup.colNext")} </em>
            {native(loan.next.min_loan)}
            <span className={styles.sub}>
              {loan.next.date}
              {showUnit ? ` · ${formatMoney({ value: loan.next.min, currency: unit })}` : ""}
            </span>
          </>
        ) : (
          "—"
        )}
      </span>
      <span className={cn("mono", styles.r, styles.cRate)}>
        {loan.annual_rate != null ? (
          <>
            <em className={styles.lbl}>{t("liabilities.mortgageGroup.colRate")} </em>
            {pct1(loan.annual_rate)}
          </>
        ) : null}
      </span>
      <span className={cn("mono", styles.r, styles.cPayoff)}>
        {loan.payoff ? (
          <>
            <em className={styles.lbl}>{t("liabilities.mortgageGroup.colPayoff")}</em>
            <span>
              <span className={depto.acc}>{loan.payoff.date}</span>
              <span className={styles.sub}>{t(loan.payoff.cuotas === 1 ? "liabilities.mortgageGroup.cuotasLeftOne" : "liabilities.mortgageGroup.cuotasLeft", { count: loan.payoff.cuotas })}</span>
            </span>
          </>
        ) : null}
      </span>
    </li>
  );
}

function LoanList({ glance }: { glance: MortgageGroupGlanceDto | undefined }) {
  const { t } = useTranslation();
  const unit = glance?.unit;
  const several = (glance?.loans.length ?? 0) > 1;
  return (
    <ul className={styles.list} aria-label={t("liabilities.mortgageGroup.loansLabel")}>
      <li className={cn(styles.row, styles.head)} aria-hidden="true">
        <span>{t("liabilities.mortgageGroup.colLoan")}</span>
        <span className={styles.r}>{t("liabilities.mortgageGroup.colBalance")}</span>
        <span>{t("liabilities.mortgageGroup.colPaid")}</span>
        <span className={styles.r}>{t("liabilities.mortgageGroup.colNext")}</span>
        <span className={styles.r}>{t("liabilities.mortgageGroup.colRate")}</span>
        <span className={styles.r}>{t("liabilities.mortgageGroup.colPayoff")}</span>
      </li>
      {glance && unit
        ? glance.loans.map((l) => <LoanRow key={l.account_id} loan={l} unit={unit} several={several} />)
        : (
          <li className={styles.row}>
            <span className={styles.cName}>{BLANK}</span>
          </li>
        )}
      {glance?.loans_without_ledger.map((l) => (
        <li key={l.account_id} className={styles.row}>
          <span className={cn(styles.name, styles.cName)}>
            <Link to={`/account/${l.account_id}`}>{l.name}</Link>
          </span>
          <span className={styles.empty}>{t("accountDetail.depto.noLedger")}</span>
        </li>
      ))}
      {glance?.total && unit ? (
        <li className={cn(styles.row, styles.total)}>
          <span className={styles.cName}>{t("liabilities.mortgageGroup.total")}</span>
          <span className={cn("mono", styles.r, styles.cBal)}>{formatMoney({ value: glance.total.balance, currency: unit })}</span>
          <span className={cn("mono", styles.cPaid)}>
            <PaidBar paidShare={glance.total.paid_share} />
            <span className={styles.sub}>{t("liabilities.mortgageGroup.paidShare", { share: pct1(glance.total.paid_share) })}</span>
          </span>
          <span className={cn("mono", styles.r, styles.cNext)}>
            {glance.total.next_min != null ? (
              <>
                <em className={styles.lbl}>{t("liabilities.mortgageGroup.colNext")} </em>
                {formatMoney({ value: glance.total.next_min, currency: unit })}
              </>
            ) : null}
          </span>
          <span className={styles.cRate} />
          <span className={styles.cPayoff} />
        </li>
      ) : null}
    </ul>
  );
}

/** The loan page's balance band over the group: the stacked balances beside the rail (paid vs left, financing cost by year). */
function BalanceBand({ glance, loading }: { glance: MortgageGroupGlanceDto | undefined; loading: boolean }) {
  const { t } = useTranslation();
  const rail = glance?.rail;
  const unit = glance?.unit;
  const money = (value: number) => formatMoney({ value, currency: unit! });
  return (
    <PageGridTile id="mortgage-balance" className={cn("page-grid", depto.bands)}>
      <div className={loadableClass(loading, depto.bandChart)}>
        <ChartBox ariaLabel={t("accountDetail.depto.balanceChart")}>
          {(cw, ch) => (glance ? <MortgageGroupChart glance={glance} w={cw} h={ch} /> : null)}
        </ChartBox>
      </div>
      <div className={loadableClass(loading, depto.bandRail)}>
        {rail && unit ? (
          <>
            <div className={depto.grp}>
              <div className={depto.paidBar}>
                <i style={{ width: `${rail.paid_share * 100}%`, background: "var(--accent)" }} />
                <i style={{ flex: 1, marginLeft: 1, background: "var(--depto-owed)" }} />
              </div>
              <div className={cn("mono", depto.ownl)}>
                <span className={depto.acc}>
                  {money(rail.paid)} · {pct1(rail.paid_share)}
                </span>
                <span className={depto.muted}>{money(rail.left)}</span>
              </div>
              <div className={cn("mono", depto.q)}>
                <span className={depto.amb}>{money(rail.prepaid)}</span> {t("accountDetail.depto.prepaid")} ·{" "}
                {t("liabilities.mortgageGroup.inCuotas", { amount: money(rail.cuotas_paid) })}
              </div>
            </div>
            <div className={depto.grp}>
              <div className={cn("mono", depto.kv)}>
                <span>{t("liabilities.mortgageGroup.financingCost")}</span>
                <span className={depto[toneOf(rail.financing_cost.total) ?? "muted"]}>{signedMoney(rail.financing_cost.total, unit)}</span>
              </div>
              <div className={cn("mono", depto.yrs)}>
                {rail.financing_cost.years.map((y) => (
                  <div key={y.year}>
                    <em>{y.year}</em>
                    <span className={depto[toneOf(y.cost) ?? "muted"]}>{signedMoney(y.cost, unit)}</span>
                  </div>
                ))}
              </div>
            </div>
          </>
        ) : (
          <div className={depto.grp}>
            <div className={depto.paidBar} />
            <div>{BLANK}</div>
            <div className={depto.q}>{BLANK}</div>
          </div>
        )}
      </div>
    </PageGridTile>
  );
}

/**
 * Every loan's payments as one list (the server's merge of the loan pages' lists): each loan's next
 * cuota, one Σ row, the payments newest first, a loan's swatch on its rows when there are several.
 * Payments are recorded from the loan's page.
 */
function PaymentsTile({ slug, glance, loading }: { slug: string; glance: MortgageGroupGlanceDto | undefined; loading: boolean }) {
  const { t } = useTranslation();
  const payments = glance?.payments;
  if (glance && payments == null) return null;
  return (
    <PageGridTile id="mortgage-payments">
      <h2>{t("accountDetail.depto.paymentsTitle")}</h2>
      <div className={loadableClass(loading)} aria-busy={loading || undefined}>
        {glance && payments ? (
          <DeptoPaymentsList
            scope={{ portfolioGroup: slug }}
            payments={payments}
            unit={glance.unit}
            loanCurrency={payments.loan_currency}
            payCurrency={payments.payment_currency}
            onRegisterPayment={null}
          />
        ) : null}
      </div>
    </PageGridTile>
  );
}
