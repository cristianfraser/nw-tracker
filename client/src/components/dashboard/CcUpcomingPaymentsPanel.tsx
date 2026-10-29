import { Fragment } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "../../i18n";
import { formatClp } from "../../format";
import { formatYearMonthLabel } from "../../formatDateLabel";
import type {
  CcUpcomingPaymentRowDto,
  CcUpcomingPaymentsCardDto,
  CcUpcomingPaymentsDto,
} from "../../types";
import { ChartPanelTitleRow } from "../charts/ChartPanelTitleRow";
import { Loadable } from "../ui/Loadable";
import { Table } from "../ui/Table";
import { TableMobileCard, TableMobileCardRow, TableMobileCardSection } from "../ui/TableMobileCard";

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

function CardRows({ card }: { card: CcUpcomingPaymentsCardDto }) {
  const { t } = useTranslation();
  return (
    <>
      {card.rows.map((row, i) => (
        <tr key={`${card.account_id}|${row.billing_month}`}>
          <td className="desktop-only">{i === 0 ? card.name : null}</td>
          <td className="mono desktop-only">
            <MonthCell row={row} />
          </td>
          <td className="mono desktop-only">
            <CloseCell row={row} />
          </td>
          <td className="mono desktop-only">
            <PayByCell row={row} />
          </td>
          <td className="mono desktop-only">
            <AmountCell row={row} />
          </td>
          <td className="mobile-only">
            <TableMobileCard
              title={
                <>
                  {card.name} · <MonthCell row={row} />
                </>
              }
            >
              <TableMobileCardSection>
                <TableMobileCardRow
                  label={t("accountDetail.creditCard.colCloseDate")}
                  value={<CloseCell row={row} />}
                />
                <TableMobileCardRow
                  label={t("accountDetail.creditCard.colPayBy")}
                  value={<PayByCell row={row} />}
                />
                <TableMobileCardRow
                  label={t("dashboard.ccUpcoming.colAmount")}
                  value={<AmountCell row={row} />}
                />
              </TableMobileCardSection>
            </TableMobileCard>
          </td>
        </tr>
      ))}
    </>
  );
}

/**
 * «Tarjetas: próximos pagos» on the home dashboard: per active card, what the latest closed
 * facturación and the open one still owe, as the server built them (`cc_upcoming_payments` on the page bundle).
 * Pesos in both display units. Renders nothing before the server has answered (`data` null on a
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
  const link = data.liabilities_route_path ? (
    <Link to={data.liabilities_route_path}>{t("dashboard.ccUpcoming.viewLiabilities")}</Link>
  ) : null;
  return (
    <Loadable loading={loading} className="chart-grid chart-grid--full-line" style={{ marginTop: "1.75rem" }}>
      <div className="chart-grid__col">
        <ChartPanelTitleRow title={t("dashboard.ccUpcoming.title")} controls={link} />
        <Table
          tableClassName="table--parallel-mobile"
          header={
            <thead>
              <tr>
                <th className="desktop-only">{t("dashboard.ccUpcoming.colCard")}</th>
                <th className="desktop-only">{t("dashboard.ccUpcoming.colBillingMonth")}</th>
                <th className="desktop-only">{t("accountDetail.creditCard.colCloseDate")}</th>
                <th className="desktop-only">{t("accountDetail.creditCard.colPayBy")}</th>
                <th className="desktop-only">{t("dashboard.ccUpcoming.colAmount")}</th>
                <th className="mobile-only" aria-hidden="true" />
              </tr>
            </thead>
          }
        >
          {data.cards.map((card) => (
            <Fragment key={card.account_id}>
              <CardRows card={card} />
            </Fragment>
          ))}
          {data.totals_by_month.length > 0 ? (
            <tr>
              <td className="desktop-only" colSpan={4}>
                <strong>{t("dashboard.ccUpcoming.totalToPay")}</strong>
              </td>
              <td className="mono desktop-only">
                {data.totals_by_month.map((m) => (
                  <div key={m.pay_month}>
                    {formatYearMonthLabel(m.pay_month)}: <strong>{formatClp(m.total_clp)}</strong>
                  </div>
                ))}
              </td>
              <td className="mobile-only">
                <TableMobileCard title={t("dashboard.ccUpcoming.totalToPay")}>
                  {data.totals_by_month.map((m) => (
                    <TableMobileCardRow
                      key={m.pay_month}
                      label={formatYearMonthLabel(m.pay_month)}
                      value={formatClp(m.total_clp)}
                    />
                  ))}
                </TableMobileCard>
              </td>
            </tr>
          ) : null}
        </Table>
      </div>
    </Loadable>
  );
}
