import { useMemo, type ReactNode } from "react";
import { useTranslation } from "../../i18n";
import { buildCcDailyHistorialRows } from "../../ccDailyHistorial";
import { windowCcHistorialRows } from "../../chartRangeWindow";
import { useDailySeries } from "../../queries/hooks";
import { monthYearSurfacePeriod, useSurfacePrefs } from "../../surfaceDisplayPrefs";
import { timeRangeToDays } from "../../timeRange";
import type { AccountCcInstallmentsResponse } from "../../types";
import { CcInstallmentHistoryChart } from "../charts/CcInstallmentHistoryChart";
import { SurfaceControls } from "../ui/SurfaceControls";
import { CreditCardDetallePorMesTable } from "../../pages/accountDetail/CreditCardDetallePorMesTable";
import styles from "../../pages/AccountDetailPage.module.css";

/**
 * The two CC ledger surfaces — historial chart and detalle-por-mes table — rendered once for
 * both hosts: a card's own page (`variant: "account"`, `cc.<id>.*` prefs, account-scope daily
 * series) and the Pasivos / credit-card group section (`variant: "group"`, `liab.cc.<slug>.*`
 * prefs, group-scope daily series summed over the merged ledger's masters). Each surface owns
 * its Período control: the historial is D/M/Y + Rango, the table M/Y only (billing detail has
 * no day-grain form). One implementation so the two hosts cannot drift.
 */

type Variant = "account" | "group";

type Heading = { as: "h2" | "h3"; className: string };

const HEADINGS: Record<Variant, { historial: Heading; detalle: Heading }> = {
  account: {
    historial: { as: "h2", className: styles.sectionTitle },
    detalle: { as: "h3", className: styles.subsectionTitleMid },
  },
  group: {
    historial: { as: "h3", className: styles.subsectionTitleMid },
    detalle: { as: "h3", className: styles.subsectionTitleMid },
  },
};

const MONTH_YEAR = ["month", "year"] as const;

function SurfaceHeading({ heading, children }: { heading: Heading; children: ReactNode }) {
  const Tag = heading.as;
  return <Tag className={heading.className}>{children}</Tag>;
}

/** Per-surface prefs scope: `cc.<accountId>` on a card page, `liab.cc.<slug>` on a group page. */
export type CcSurfaceScope =
  | { variant: "account"; accountId: number }
  | { variant: "group"; portfolioGroup: string };

function surfaceIdPrefix(scope: CcSurfaceScope): string {
  return scope.variant === "account" ? `cc.${scope.accountId}` : `liab.cc.${scope.portfolioGroup}`;
}

/**
 * «Historial» — saldo total + deuda en cuotas lines over the stacked facturación bars (cuotas,
 * rest of CLP, US$). D/M/Y + Rango. Day mode swaps in the daily-series CC block (owed walk, plan
 * debt, plan tail and each card's bar on its close day — fetched in CLP for this scope). Renders
 * nothing without an installment ledger, like before.
 */
export function CreditCardHistorialSurface({
  ccLedger,
  scope,
}: {
  ccLedger: AccountCcInstallmentsResponse;
  scope: CcSurfaceScope;
}) {
  const { t } = useTranslation();
  const heading = HEADINGS[scope.variant].historial;
  const prefs = useSurfacePrefs(`${surfaceIdPrefix(scope)}.historial`, "month", "3y");
  const timeRange = prefs.range;
  const isDaily = prefs.period === "day";
  const rows = ccLedger.historial_chart;
  const hasHistorial = ccLedger.has_installment_ledger && (rows?.length ?? 0) > 0;

  const daily = useDailySeries(
    scope.variant === "account"
      ? { accountId: scope.accountId }
      : { portfolioGroup: scope.portfolioGroup },
    "clp",
    timeRangeToDays(timeRange),
    isDaily && hasHistorial
  );
  const dailyRows = useMemo(
    () => (isDaily && daily.data ? buildCcDailyHistorialRows(daily.data, timeRange) : null),
    [isDaily, daily.data, timeRange]
  );
  // Monthly/yearly: the same range window as the daily grid (left-clip + pad the empty 20 %
  // lead so the left edge matches across D/M/Y; the right edge keeps the projected plan
  // tail). The yearly rollup runs inside the chart over these windowed rows.
  const windowedRows = useMemo(
    () => (isDaily ? (rows ?? []) : windowCcHistorialRows(rows ?? [], timeRange)),
    [rows, isDaily, timeRange]
  );

  if (!hasHistorial) return null;

  return (
    <section className={styles.chartBlock}>
      <div className="chart-panel-title-row">
        <SurfaceHeading heading={heading}>{t("accountDetail.creditCard.historialTitle")}</SurfaceHeading>
        <SurfaceControls
          period={prefs.period}
          onPeriodChange={prefs.setPeriod}
          range={prefs.range}
          onRangeChange={prefs.setRange}
        />
      </div>
      {isDaily && dailyRows == null ? (
        daily.isError ? (
          <p className="error">
            {daily.error instanceof Error ? daily.error.message : t("common.loadFailed")}
          </p>
        ) : (
          <p className="muted">
            {daily.data ? t("accountDetail.creditCard.historialEmpty") : t("common.loading")}
          </p>
        )
      ) : (
        <CcInstallmentHistoryChart
          rows={windowedRows}
          openBillingMonth={ccLedger.open_billing_month}
          dailyRows={dailyRows}
          period={prefs.period}
        />
      )}
    </section>
  );
}

/** «Detalle por mes / por año» — billing detail table (full history, paginated). M/Y period only. */
export function CreditCardDetalleSurface({
  ccLedger,
  scope,
}: {
  ccLedger: AccountCcInstallmentsResponse;
  scope: CcSurfaceScope;
}) {
  const { t } = useTranslation();
  const heading = HEADINGS[scope.variant].detalle;
  const prefs = useSurfacePrefs(`${surfaceIdPrefix(scope)}.detalle`, "month", "total");
  const period = monthYearSurfacePeriod(prefs.period);
  const isYearly = period === "year";
  const rows = ccLedger.billing_detail_by_month ?? [];

  if (rows.length === 0) return null;

  return (
    <>
      <div className="chart-panel-title-row">
        <SurfaceHeading heading={heading}>
          {t(isYearly ? "accountDetail.yearlyDetailTitle" : "accountDetail.monthlyDetailTitle")}
        </SurfaceHeading>
        <SurfaceControls period={period} onPeriodChange={prefs.setPeriod} periodOptions={MONTH_YEAR} />
      </div>
      <CreditCardDetallePorMesTable rows={rows} period={period} />
    </>
  );
}
