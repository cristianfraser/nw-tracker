import { Link } from "react-router-dom";
import { useTranslation } from "../../i18n";
import { formatClp } from "../../format";
import { formatYearMonthLabel } from "../../formatDateLabel";
import type { CcUpcomingPaymentDto, CcUpcomingPaymentRowDto, CcUpcomingPaymentsDto } from "../../types";
import { PageGridTile } from "../layout/PageGridTile";
import { dashboardTileOrder } from "../../dashboardLayout";
import { loadableClass } from "../ui/Loadable";
import styles from "./DashboardFlowsSummary.module.css";

/**
 * Pay-by with its provenance: one derived from the close (no statement prints it yet) reads «≈»;
 * one passed with something still owed is marked overdue.
 */
function PayByCell({ row }: { row: CcUpcomingPaymentRowDto }) {
  const { t } = useTranslation();
  if (row.overdue) {
    return (
      <span style={{ color: "var(--negative)" }} title={t("dashboard.ccUpcoming.overdueHint")}>
        {row.pay_by_iso} · {t("dashboard.ccUpcoming.overdue")}
      </span>
    );
  }
  if (row.pay_by_source === "derived") {
    return (
      <span className="muted" title={t("accountDetail.creditCard.payByDerivedHint")}>
        {row.pay_by_iso} ≈
      </span>
    );
  }
  return <>{row.pay_by_iso}</>;
}

/** What is still owed; once part is paid, the facturación's total beside it. */
function AmountCell({ row }: { row: CcUpcomingPaymentRowDto }) {
  const { t } = useTranslation();
  if (row.amount_clp === row.billed_clp) return <>{formatClp(row.amount_clp)}</>;
  const billed = formatClp(row.billed_clp);
  return (
    <span title={t("dashboard.ccUpcoming.partlyPaidHint", { amount: billed })}>
      {formatClp(row.amount_clp)}{" "}
      <span className="muted">{t("dashboard.ccUpcoming.billedOf", { amount: billed })}</span>
    </span>
  );
}

function MonthCell({ row }: { row: CcUpcomingPaymentRowDto }) {
  const { t } = useTranslation();
  return (
    <>
      {formatYearMonthLabel(row.billing_month)}
      {row.is_provisional_close ? (
        <span className="muted" title={t("accountDetail.creditCard.provisionalCloseHint")}>
          *
        </span>
      ) : null}
    </>
  );
}

/** One facturación of one card on one line: card and month, then the pay-by and the amount. */
function PaymentLine({ payment }: { payment: CcUpcomingPaymentDto }) {
  const { t } = useTranslation();
  const { row } = payment;
  return (
    <div className={styles.line}>
      <dt>
        {payment.name} · <MonthCell row={row} />
      </dt>
      <dd>
        <span className="muted">
          {t("dashboard.ccUpcoming.payByShort")}{" "}
          <span className="mono">
            <PayByCell row={row} />
          </span>
        </span>{" "}
        <span className="mono">
          <AmountCell row={row} />
        </span>
      </dd>
    </div>
  );
}

/**
 * «Próximos pagos» on the home dashboard: what each active card's latest closed facturación and
 * open one still owe, grouped by the month they are due in — a card per pay month, its total on
 * the heading line and its payments below — as the server built them (`cc_upcoming_payments` on
 * the page bundle). Pesos in both display units. Renders nothing before the server has answered
 * (`data` null on a placeholder bundle) and nothing when nothing is due.
 */
export function CcUpcomingPaymentsPanel({
  data,
  loading,
}: {
  data: CcUpcomingPaymentsDto | null;
  loading: boolean;
}) {
  const { t } = useTranslation();
  if (!data || data.months.length === 0) return null;
  return (
    <PageGridTile id="cc-upcoming" order={dashboardTileOrder("cc-upcoming")}>
      <div className="chart-panel-title-row">
        <h2>{t("dashboard.ccUpcoming.title")}</h2>
        {data.liabilities_route_path ? (
          <Link to={data.liabilities_route_path} className={styles.link}>
            {t("dashboard.ccUpcoming.viewLiabilities")}
          </Link>
        ) : null}
      </div>
      <div className={loadableClass(loading, "cards cards--list")}>
        {data.months.map((month) => (
          <div key={month.pay_month} className={`card ${styles.period}`}>
            <div className={styles.monthHeading}>
              <span>{formatYearMonthLabel(month.pay_month)}</span>{" "}
              <span className="mono">{formatClp(month.total_clp)}</span>
            </div>
            <dl className={styles.lines}>
              {month.payments.map((payment) => (
                <PaymentLine key={`${payment.account_id}|${payment.row.billing_month}`} payment={payment} />
              ))}
            </dl>
          </div>
        ))}
      </div>
    </PageGridTile>
  );
}
