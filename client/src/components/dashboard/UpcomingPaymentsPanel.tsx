import { useState } from "react";
import type { TFunction } from "i18next";
import { Link } from "react-router-dom";
import { useTranslation } from "../../i18n";
import { formatClp, formatCurrency } from "../../format";
import { useDisplayPreferences } from "../../context/DisplayPreferencesContext";
import { dayOfMonthLabelParts, formatYearMonthLabel } from "../../formatDateLabel";
import type { CcUpcomingPaymentRowDto, UpcomingPaymentDetailDto, UpcomingPaymentItemDto, UpcomingPaymentsDto } from "../../types";
import { PageGridTile } from "../layout/PageGridTile";
import { hasSchemaVersion, persistedPayload, usePersistedPayload } from "../../queries/persistedPayloadCache";
import { dashboardTileOrder, dashboardTileSmallSpan } from "../../dashboardLayout";
import { loadableClass } from "../ui/Loadable";
import styles from "./DashboardFlowsSummary.module.css";

/** A stored «Próximos pagos» entry the panel can draw. */
function isUpcomingPayments(v: unknown): v is UpcomingPaymentsDto {
  if (v == null || typeof v !== "object") return false;
  const months = (v as { months?: unknown }).months;
  return (
    typeof (v as { unit?: unknown }).unit === "string" &&
    Array.isArray(months) &&
    months.every(
      (m) =>
        m != null &&
        typeof m.pay_month === "string" &&
        Number.isFinite(m.total_clp) &&
        Number.isFinite(m.total_in_unit) &&
        Array.isArray(m.items) &&
        m.items.every(
          (i: { kind?: unknown; due_iso?: unknown; amount_clp?: unknown; amount_in_unit?: unknown }) =>
            typeof i.kind === "string" &&
            typeof i.due_iso === "string" &&
            Number.isFinite(i.amount_clp) &&
            Number.isFinite(i.amount_in_unit)
        )
    )
  );
}

const UPCOMING_PAYMENTS = persistedPayload(
  "upcoming_payments",
  (v): v is UpcomingPaymentsDto => hasSchemaVersion(v, "upcoming_payments") && isUpcomingPayments(v)
);

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
  const { day, suffix } = dayOfMonthLabelParts(item.due_iso);
  // A card's pay-by that no statement prints yet is derived from its close; the dates read dimmed
  // already, so it says so on hover only.
  const derived = item.card?.pay_by_source === "derived";
  const hint = derived ? `${item.due_iso} · ${t("accountDetail.creditCard.payByDerivedHint")}` : item.due_iso;
  return (
    <span className="muted" title={hint}>
      <span className={styles.dueWord}>
        {item.due_kind === "on" ? t("dashboard.ccUpcoming.payOnDay") : t("dashboard.ccUpcoming.payByDay")}
      </span>{" "}
      <span className="mono">{day}</span>
      {suffix}
    </span>
  );
}

/** The breathing period's base; each dot takes it ± `DUE_SOON_PERIOD_JITTER_S` so dots side by side drift apart. */
const DUE_SOON_PERIOD_S = 7.5;
const DUE_SOON_PERIOD_JITTER_S = 0.2;

/** A breathing dot between the date and the amount: full on a payment's last day, fainter the day before. */
function DueSoonDot({ dueSoon }: { dueSoon: "today" | "tomorrow" }) {
  const { t } = useTranslation();
  // Picked once per mount, so the period stays steady while the dot is on screen.
  const [periodS] = useState(() => DUE_SOON_PERIOD_S + (Math.random() * 2 - 1) * DUE_SOON_PERIOD_JITTER_S);
  const label = dueSoon === "today" ? t("dashboard.ccUpcoming.dueTodayHint") : t("dashboard.ccUpcoming.dueTomorrowHint");
  return (
    <dd className={styles.dueSoonCell}>
      <span
        className={dueSoon === "today" ? `${styles.dueSoonDot} ${styles.dueSoonToday}` : styles.dueSoonDot}
        style={{ animationDuration: `${periodS.toFixed(2)}s` }}
        title={label}
        role="img"
        aria-label={label}
      />
    </dd>
  );
}

/**
 * The bills are pesos and read in pesos; in a display unit other than pesos the hover adds the
 * amount in it (the server's `*_in_unit`, at today's rate).
 */
function withUnitHint(hint: string | undefined, amountInUnit: number, unit: string): string | undefined {
  if (unit === "clp") return hint;
  const inUnit = `≈ ${formatCurrency(amountInUnit, unit)}`;
  return hint ? `${hint} · ${inUnit}` : inUnit;
}

/** What is owed: a card's after its payments (with the facturación beside it once part is paid), the mortgage's range. */
function AmountCell({ item, unit }: { item: UpcomingPaymentItemDto; unit: string }) {
  const { t } = useTranslation();
  const card: CcUpcomingPaymentRowDto | null = item.card;
  if (card && card.amount_clp !== card.billed_clp) {
    const billed = formatClp(card.billed_clp);
    return (
      <span
        className="mono"
        title={withUnitHint(t("dashboard.ccUpcoming.partlyPaidHint", { amount: billed }), item.amount_in_unit, unit)}
      >
        {formatClp(card.amount_clp)} <span className="muted">{t("dashboard.ccUpcoming.billedOf", { amount: billed })}</span>
      </span>
    );
  }
  const className = item.estimated ? `mono ${styles.estimate}` : "mono";
  // A range (the mortgage) shows its minimum, what counts in the month's total; the maximum is on hover.
  if (item.amount_max_clp != null) {
    const hint = `${t("dashboard.ccUpcoming.mortgageMaxHint", { amount: formatClp(item.amount_max_clp) })} · ${t("dashboard.ccUpcoming.mortgageRangeHint")}`;
    return (
      <span className={className} title={withUnitHint(hint, item.amount_in_unit, unit)}>
        {formatClp(item.amount_clp)}
      </span>
    );
  }
  // An estimate reads in italics (no «≈»), its reason on hover.
  return (
    <span
      className={className}
      title={withUnitHint(item.estimated ? t("dashboard.ccUpcoming.estimatedHint") : undefined, item.amount_in_unit, unit)}
    >
      {formatClp(item.amount_clp)}
    </span>
  );
}

/** An occurrence's detail as the hover reads it. */
function detailText(t: TFunction, detail: UpcomingPaymentDetailDto): string {
  switch (detail.kind) {
    case "billing_month":
      return t("dashboard.ccUpcoming.billingMonthHint", { month: formatYearMonthLabel(detail.month) });
    case "bill_month":
      return formatYearMonthLabel(detail.month);
    case "cuota":
      return detail.count == null
        ? t("dashboard.ccUpcoming.cuota", { n: detail.n })
        : t("dashboard.ccUpcoming.cuotaOf", { n: detail.n, count: detail.count });
    case "text":
      return detail.text;
  }
}

/** The kind's word before the name, for the kinds that have one (a card and a declared payment are their name). */
function kindWord(t: TFunction, kind: UpcomingPaymentItemDto["kind"]): string | null {
  switch (kind) {
    case "mortgage":
      return t("dashboard.ccUpcoming.kindMortgage");
    case "hoa":
      return t("dashboard.ccUpcoming.kindHoaShort");
    case "contribuciones":
      return t("dashboard.ccUpcoming.kindContribuciones");
    case "card":
    case "recurring":
      return null;
  }
}

/**
 * What the payment is (the whole label links to its page when it has one): its kind and the name
 * the server sends; the occurrence's detail is on hover. A provisional card close and a declared
 * payment carry an asterisk, explained on hover too.
 */
function ItemLabel({ item }: { item: UpcomingPaymentItemDto }) {
  const { t } = useTranslation();
  const word = kindWord(t, item.kind);
  const asterisk =
    item.kind === "recurring"
      ? t("dashboard.ccUpcoming.wipHint")
      : item.card?.is_provisional_close
        ? t("accountDetail.creditCard.provisionalCloseHint")
        : null;
  const hint = [item.detail ? detailText(t, item.detail) : null, asterisk].filter((s) => s != null).join(" · ");
  return (
    <span title={hint || undefined}>
      {word ? `${word} · ` : ""}
      {item.name}
      {asterisk ? <span className="muted">*</span> : null}
    </span>
  );
}

/**
 * «Próximos pagos» on the home dashboard: what is due, grouped by the month it is due in — the
 * cards' facturaciones, the mortgage cuota, gastos comunes, contribuciones and declared payments —
 * as the server built it (`upcoming_payments` on the page bundle). A card per month, its total
 * beside its name, its payments below with the date and amount on the right. The first two months
 * show; «Show more» opens the rest of the server's horizon. The bills read in pesos whatever the
 * display unit; in another unit the hover adds each amount in it (stored per unit). The
 * panel is always there: dimmed and empty before the server has answered (`data` null on a
 * placeholder bundle, no stored copy), an empty state when nothing is due.
 */
export function UpcomingPaymentsPanel({ data: live, loading: liveLoading }: { data: UpcomingPaymentsDto | null; loading: boolean }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  // One stored entry per display unit (the hover's converted amounts); until the bundle answers,
  // the last stored one. A held bundle of another unit is not stored under this one, but its pesos
  // are the same, so it shows (its hover in its own unit) until this unit's arrives.
  const { displayUnit } = useDisplayPreferences();
  const liveInUnit = live != null && live.unit === displayUnit ? live : null;
  const { value: stored, cached } = usePersistedPayload(UPCOMING_PAYMENTS, [displayUnit], liveInUnit);
  const data = stored ?? live;
  const unit = data?.unit ?? displayUnit;
  const loading = liveLoading && !cached;
  const allMonths = data?.months ?? [];
  const months = expanded ? allMonths : allMonths.slice(0, COLLAPSED_MONTHS);
  return (
    <PageGridTile id="cc-upcoming" order={dashboardTileOrder("cc-upcoming")} smallSpan={dashboardTileSmallSpan("cc-upcoming")}>
      <h2>{t("dashboard.ccUpcoming.title")}</h2>
      {data != null && allMonths.length === 0 ? <p className="muted">{t("dashboard.ccUpcoming.empty")}</p> : null}
      <div className={loadableClass(loading || data == null, "cards cards--list", styles.upcoming)}>
        {months.map((month) => (
          <div key={month.pay_month} className={`card ${styles.period}`}>
            <div className={styles.monthHeading}>
              <span>{formatYearMonthLabel(month.pay_month)}</span>{" "}
              <span className="mono" title={withUnitHint(undefined, month.total_in_unit, unit)}>
                {formatClp(month.total_clp)}
              </span>
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
                  <dd className={styles.due}>
                    <DueCell item={item} />
                  </dd>
                  {item.due_soon ? <DueSoonDot dueSoon={item.due_soon} /> : null}
                  <dd className={styles.amount}>
                    <AmountCell item={item} unit={unit} />
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
