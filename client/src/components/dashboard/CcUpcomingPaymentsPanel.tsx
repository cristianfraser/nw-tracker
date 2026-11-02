import { Link } from "react-router-dom";
import { useTranslation } from "../../i18n";
import { formatClp } from "../../format";
import { formatYearMonthLabel } from "../../formatDateLabel";
import type {
  CcUpcomingPaymentRowDto,
  CcUpcomingPaymentsCardDto,
  CcUpcomingPaymentsDto,
} from "../../types";
import { PageGridTile } from "../layout/PageGridTile";
import { dashboardTileOrder } from "../../dashboardLayout";
import { loadableClass } from "../ui/Loadable";
import styles from "./DashboardFlowsSummary.module.css";

/** Close date with its evidence: ✓ when the bank published it, ≈ when announced or estimated. */
function CloseCell({ row }: { row: CcUpcomingPaymentRowDto }) {
  const { t } = useTranslation();
  if (row.close_observed) {
    return (
      <span title={t("dashboard.ccUpcoming.closeObservedHint")}>
        {row.close_date_iso} ✓
      </span>
    );
  }
  const hint =
    row.close_date_source === "announced"
      ? t("accountDetail.creditCard.closeDateAnnouncedHint")
      : t("accountDetail.creditCard.closeDateEstimatedHint");
  return (
    <span className="muted" title={hint}>
      {row.close_date_iso} ≈
    </span>
  );
}

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

/** One facturación of one card: title, then one line — close (by pay-by) and the amount. */
function PaymentCard({ card, row }: { card: CcUpcomingPaymentsCardDto; row: CcUpcomingPaymentRowDto }) {
  const { t } = useTranslation();
  return (
    <div className={`card ${styles.period}`}>
      <div className={styles.periodTitle}>
        {card.name} · <MonthCell row={row} />
      </div>
      <dl className={styles.lines}>
        <div className={styles.line}>
          <dt className="mono">
            <CloseCell row={row} />{" "}
            <span className="muted">
              ({t("dashboard.ccUpcoming.payByShort")} <PayByCell row={row} />)
            </span>
          </dt>
          <dd className="mono">
            <AmountCell row={row} />
          </dd>
        </div>
      </dl>
    </div>
  );
}

/**
 * «Próximos pagos» on the home dashboard: per active card, what the latest closed facturación
 * and the open one still owe, as the server built them (`cc_upcoming_payments` on the page
 * bundle), drawn like the «Flujos» period cards (a `.cards` block of label–value lines). Pesos in
 * both display units. Renders nothing before the server has answered (`data` null on a
 * placeholder bundle) and nothing when no card has anything pending.
 */
export function CcUpcomingPaymentsPanel({
  data,
  loading,
}: {
  data: CcUpcomingPaymentsDto | null;
  loading: boolean;
}) {
  const { t } = useTranslation();
  if (!data || data.cards.length === 0) return null;
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
        {data.cards.flatMap((card) =>
          card.rows.map((row) => (
            <PaymentCard key={`${card.account_id}|${row.billing_month}`} card={card} row={row} />
          ))
        )}
        {data.totals_by_month.length > 0 ? (
          <div className={`card ${styles.period}`}>
            <div className={styles.periodTitle}>{t("dashboard.ccUpcoming.totalToPay")}</div>
            <dl className={styles.lines}>
              {data.totals_by_month.map((m) => (
                <div key={m.pay_month} className={styles.line}>
                  <dt>{formatYearMonthLabel(m.pay_month)}</dt>
                  <dd className="mono">{formatClp(m.total_clp)}</dd>
                </div>
              ))}
            </dl>
          </div>
        ) : null}
      </div>
    </PageGridTile>
  );
}
