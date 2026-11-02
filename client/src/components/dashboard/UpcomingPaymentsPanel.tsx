import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "../../i18n";
import { formatClp } from "../../format";
import { formatYearMonthLabel } from "../../formatDateLabel";
import type { CcUpcomingPaymentRowDto, UpcomingPaymentItemDto, UpcomingPaymentsDto } from "../../types";
import { PageGridTile } from "../layout/PageGridTile";
import { dashboardTileOrder } from "../../dashboardLayout";
import { loadableClass } from "../ui/Loadable";
import styles from "./DashboardFlowsSummary.module.css";

/** Pay months shown before «Show more» (the server sends its whole horizon). */
const COLLAPSED_MONTHS = 2;

/** The due date and how it reads: «by» a deadline or «on» a day; overdue in red. */
function DueCell({ item }: { item: UpcomingPaymentItemDto }) {
  const { t } = useTranslation();
  const word = item.due_kind === "on" ? t("dashboard.ccUpcoming.payOnShort") : t("dashboard.ccUpcoming.payByShort");
  if (item.overdue) {
    return (
      <span style={{ color: "var(--negative)" }} title={t("dashboard.ccUpcoming.overdueHint")}>
        {word} <span className="mono">{item.due_iso}</span> · {t("dashboard.ccUpcoming.overdue")}
      </span>
    );
  }
  // A card's pay-by that no statement prints yet is derived from its close; the dates read dimmed
  // already, so it says so on hover only.
  const derived = item.card?.pay_by_source === "derived";
  return (
    <span className="muted" title={derived ? t("accountDetail.creditCard.payByDerivedHint") : undefined}>
      {word} <span className="mono">{item.due_iso}</span>
    </span>
  );
}

/** What is owed: a card's after its payments (with the facturación beside it once part is paid), the mortgage's range. */
function AmountCell({ item }: { item: UpcomingPaymentItemDto }) {
  const { t } = useTranslation();
  const card: CcUpcomingPaymentRowDto | null = item.card;
  if (card && card.amount_clp !== card.billed_clp) {
    const billed = formatClp(card.billed_clp);
    return (
      <span className="mono" title={t("dashboard.ccUpcoming.partlyPaidHint", { amount: billed })}>
        {formatClp(card.amount_clp)} <span className="muted">{t("dashboard.ccUpcoming.billedOf", { amount: billed })}</span>
      </span>
    );
  }
  // An estimate reads dimmed (no «≈»), its reason on hover.
  const hint = item.kind === "mortgage" ? t("dashboard.ccUpcoming.mortgageRangeHint") : item.estimated ? t("dashboard.ccUpcoming.estimatedHint") : undefined;
  return (
    <span className={item.estimated ? "mono muted" : "mono"} title={hint}>
      {formatClp(item.amount_clp)}
      {item.amount_max_clp != null ? ` – ${formatClp(item.amount_max_clp)}` : ""}
    </span>
  );
}

/** What the payment is: the card and its facturación, the mortgage cuota, a place's bill, a declared payment. */
function ItemLabel({ item }: { item: UpcomingPaymentItemDto }) {
  const { t } = useTranslation();
  switch (item.kind) {
    case "card": {
      const row = item.card!;
      return (
        <>
          {item.name} · {formatYearMonthLabel(row.billing_month)}
          {row.is_provisional_close ? (
            <span className="muted" title={t("accountDetail.creditCard.provisionalCloseHint")}>
              *
            </span>
          ) : null}
        </>
      );
    }
    case "mortgage":
      return (
        <>
          <span title={item.name}>{t("dashboard.ccUpcoming.kindMortgage")}</span> ·{" "}
          {t("dashboard.ccUpcoming.cuota", { n: item.cuota })}
        </>
      );
    case "hoa":
      return (
        <>
          {t("dashboard.ccUpcoming.kindHoa")} · {item.name} · {formatYearMonthLabel(item.bill_month!)}
        </>
      );
    case "contribuciones":
      return (
        <>
          {t("dashboard.ccUpcoming.kindContribuciones")} · {item.name} ·{" "}
          {t("dashboard.ccUpcoming.cuotaOf", { n: item.cuota, count: item.cuota_count })}
        </>
      );
    case "recurring":
      return (
        <span title={t("dashboard.ccUpcoming.wipHint")}>
          {item.name}
          <span className="muted">*</span>
        </span>
      );
  }
}

/**
 * «Próximos pagos» on the home dashboard: what is due, grouped by the month it is due in — the
 * cards' facturaciones, the mortgage cuota, gastos comunes, contribuciones and declared payments —
 * as the server built it (`upcoming_payments` on the page bundle). A card per month, its total
 * beside its name, its payments below with the date and amount on the right. The first two months
 * show; «Show more» opens the rest of the server's horizon. Pesos in both display units. Renders
 * nothing before the server has answered (`data` null on a placeholder bundle) and nothing when
 * nothing is due.
 */
export function UpcomingPaymentsPanel({ data, loading }: { data: UpcomingPaymentsDto | null; loading: boolean }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  if (!data || data.months.length === 0) return null;
  const months = expanded ? data.months : data.months.slice(0, COLLAPSED_MONTHS);
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
        {months.map((month) => (
          <div key={month.pay_month} className={`card ${styles.period}`}>
            <div className={styles.monthHeading}>
              <span>{formatYearMonthLabel(month.pay_month)}</span>{" "}
              <span className="mono">{formatClp(month.total_clp)}</span>
            </div>
            <dl className={styles.lines}>
              {month.items.map((item) => (
                <div key={item.key} className={styles.paymentLine}>
                  <dt className="muted">
                    <ItemLabel item={item} />
                  </dt>
                  <dd>
                    <DueCell item={item} /> <AmountCell item={item} />
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
      {data.months.length > COLLAPSED_MONTHS ? (
        <button type="button" className={styles.toggle} onClick={() => setExpanded((v) => !v)}>
          {expanded ? t("dashboard.ccUpcoming.showLess") : t("dashboard.ccUpcoming.showMore")}
        </button>
      ) : null}
    </PageGridTile>
  );
}
