import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "../../i18n";
import { formatClp } from "../../format";
import { formatDayOfMonthLabel, formatYearMonthLabel } from "../../formatDateLabel";
import type { CcUpcomingPaymentRowDto, UpcomingPaymentItemDto, UpcomingPaymentsDto } from "../../types";
import { PageGridTile } from "../layout/PageGridTile";
import { usePanelCache } from "../../queries/panelCache";
import { dashboardTileOrder, dashboardTileSmallSpan } from "../../dashboardLayout";
import { loadableClass } from "../ui/Loadable";
import styles from "./DashboardFlowsSummary.module.css";

/** A stored «Próximos pagos» entry the panel can draw. */
function isUpcomingPayments(v: unknown): v is UpcomingPaymentsDto {
  if (v == null || typeof v !== "object") return false;
  const months = (v as { months?: unknown }).months;
  return (
    Array.isArray(months) &&
    months.every(
      (m) =>
        m != null &&
        typeof m.pay_month === "string" &&
        Number.isFinite(m.total_clp) &&
        Array.isArray(m.items) &&
        m.items.every((i: { kind?: unknown; due_iso?: unknown; amount_clp?: unknown }) => typeof i.kind === "string" && typeof i.due_iso === "string" && Number.isFinite(i.amount_clp))
    )
  );
}

/** Pay months shown before «Show more» (the server sends its whole horizon). */
const COLLAPSED_MONTHS = 2;

/**
 * The due date and how it reads: «by» a deadline or «on» a day. The row sits under its month, so
 * only the day shows; an overdue row (counted in the current month) keeps its full date, in red.
 */
function DueCell({ item }: { item: UpcomingPaymentItemDto }) {
  const { t } = useTranslation();
  if (item.overdue) {
    const word = item.due_kind === "on" ? t("dashboard.ccUpcoming.payOnShort") : t("dashboard.ccUpcoming.payByShort");
    return (
      <span style={{ color: "var(--negative)" }} title={t("dashboard.ccUpcoming.overdueHint")}>
        {word} <span className="mono">{item.due_iso}</span>
      </span>
    );
  }
  const day = formatDayOfMonthLabel(item.due_iso);
  // A card's pay-by that no statement prints yet is derived from its close; the dates read dimmed
  // already, so it says so on hover only.
  const derived = item.card?.pay_by_source === "derived";
  const hint = derived ? `${item.due_iso} · ${t("accountDetail.creditCard.payByDerivedHint")}` : item.due_iso;
  return (
    <span className="muted" title={hint}>
      {item.due_kind === "on" ? t("dashboard.ccUpcoming.payOnDay", { day }) : t("dashboard.ccUpcoming.payByDay", { day })}
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
  // An estimate reads dimmed and in italics (no «≈»), its reason on hover.
  const hint = item.kind === "mortgage" ? t("dashboard.ccUpcoming.mortgageRangeHint") : item.estimated ? t("dashboard.ccUpcoming.estimatedHint") : undefined;
  return (
    <span className={item.estimated ? `mono muted ${styles.estimate}` : "mono"} title={hint}>
      {formatClp(item.amount_clp)}
      {item.amount_max_clp != null ? ` – ${formatClp(item.amount_max_clp)}` : ""}
    </span>
  );
}

/**
 * What the payment is, short (the whole label links to its page when it has one): the card, the
 * mortgage or a bill by its place. The detail — the facturación, the cuota, the month billed —
 * is on hover.
 */
function ItemLabel({ item }: { item: UpcomingPaymentItemDto }) {
  const { t } = useTranslation();
  switch (item.kind) {
    case "card": {
      const row = item.card!;
      const hint = t("dashboard.ccUpcoming.billingMonthHint", { month: formatYearMonthLabel(row.billing_month) });
      return (
        <span title={row.is_provisional_close ? `${hint} · ${t("accountDetail.creditCard.provisionalCloseHint")}` : hint}>
          {item.name}
          {row.is_provisional_close ? <span className="muted">*</span> : null}
        </span>
      );
    }
    case "mortgage":
      return (
        <span title={`${item.name} · ${t("dashboard.ccUpcoming.cuota", { n: item.cuota })}`}>
          {t("dashboard.ccUpcoming.kindMortgage")}
          {item.place_label ? ` · ${item.place_label}` : ""}
        </span>
      );
    case "hoa":
      return (
        <span title={`${t("dashboard.ccUpcoming.kindHoa")} · ${formatYearMonthLabel(item.bill_month!)}`}>
          {t("dashboard.ccUpcoming.kindHoaShort")} · {item.name}
        </span>
      );
    case "contribuciones":
      return (
        <span title={t("dashboard.ccUpcoming.cuotaOf", { n: item.cuota, count: item.cuota_count })}>
          {t("dashboard.ccUpcoming.kindContribuciones")} · {item.name}
        </span>
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
 * show; «Show more» opens the rest of the server's horizon. Pesos in both display units. The
 * panel is always there: dimmed and empty before the server has answered (`data` null on a
 * placeholder bundle, no stored copy), an empty state when nothing is due.
 */
export function UpcomingPaymentsPanel({ data: live, loading: liveLoading }: { data: UpcomingPaymentsDto | null; loading: boolean }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  // Pesos in both units, so one stored entry; until the bundle answers, the last stored one.
  const { value: data, cached } = usePanelCache("upcoming-v2", live, isUpcomingPayments);
  const loading = liveLoading && !cached;
  const allMonths = data?.months ?? [];
  const months = expanded ? allMonths : allMonths.slice(0, COLLAPSED_MONTHS);
  return (
    <PageGridTile id="cc-upcoming" order={dashboardTileOrder("cc-upcoming")} smallSpan={dashboardTileSmallSpan("cc-upcoming")}>
      <h2>{t("dashboard.ccUpcoming.title")}</h2>
      {data != null && allMonths.length === 0 ? <p className="muted">{t("dashboard.ccUpcoming.empty")}</p> : null}
      <div className={loadableClass(loading || data == null, "cards cards--list")}>
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
                    {item.route_path ? (
                      <Link to={item.route_path} className="text-link">
                        <ItemLabel item={item} />
                      </Link>
                    ) : (
                      <ItemLabel item={item} />
                    )}
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
      {allMonths.length > COLLAPSED_MONTHS ? (
        <button type="button" className={styles.toggle} onClick={() => setExpanded((v) => !v)}>
          {expanded ? t("dashboard.ccUpcoming.showLess") : t("dashboard.ccUpcoming.showMore")}
        </button>
      ) : null}
    </PageGridTile>
  );
}
