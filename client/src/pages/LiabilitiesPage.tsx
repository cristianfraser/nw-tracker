import { useMemo } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import { cn } from "../cn";
import { useTranslation } from "../i18n";
import { useDisplayPreferences } from "../context/DisplayPreferencesContext";
import {
  useDailySeries,
  useLiabilitiesGlance,
  useMortgageGroupGlance,
  usePortfolioGroupBundle,
  usePortfolioGroupCcLanes,
  useSidebarNav,
} from "../queries/hooks";
import { dailyPayloadPending, queryLoadError, queryShowsLoading } from "../queries/pageShapeReady";
import { findBestNavNodeForPathname } from "../portfolioNavFromApi";
import { resolveNavTreeLabel } from "../sidebarNavFromApi";
import { DASHBOARD_PATH } from "../dashboardPath";
import { formatMoney, formatPct } from "../format";
import { formatYearMonthLabel } from "../formatDateLabel";
import { timeRangeToDays } from "../timeRange";
import { useSurfacePrefs } from "../surfaceDisplayPrefs";
import { PageGridTile } from "../components/layout/PageGridTile";
import { loadableClass } from "../components/ui/Loadable";
import { SurfaceControls } from "../components/ui/SurfaceControls";
import { CoverageLineChart } from "../components/charts/lazyCharts";
import { DebtGlanceHeader } from "../components/liabilities/DebtGlanceHeader";
import { CreditCardGroupLanes } from "../components/liabilities/CreditCardGroupLanes";
import { MortgageLoanList } from "../components/liabilities/MortgageLoanList";
import { LiabilitiesUpcomingList } from "../components/liabilities/LiabilitiesUpcomingList";
import depto from "../components/depto/Depto.module.css";
import mortgageStyles from "../components/liabilities/MortgageGroup.module.css";
import styles from "../components/liabilities/Liabilities.module.css";
import type { CcGroupLanesResponse, LiabilitiesGlanceDto, NavTreeNodeDto } from "../types";

const BLANK = " ";
/** The two groups the page is made of (their nav nodes and their pages). */
const CREDIT_CARD_SLUG = "liabilities_credit_card";
const MORTGAGE_SLUG = "liabilities_mortgage";
const CREDIT_CARD_PATH = "/liabilities/credit-card";
const MORTGAGE_PATH = "/liabilities/mortgage";

/** The lanes' frame while the first payload loads (`CreditCardGroupSection`'s, dimmed). */
const EMPTY_LANES: CcGroupLanesResponse = {
  billing_currency: "clp", // convention-ok: placeholder frame only; every figure is zero and dimmed
  today_iso: "",
  axis: { start_iso: "", end_iso: "", days: 1, today_share: 0, ticks: [] },
  total: { owed: [], owed_total: 0, cuotas_ahead: 0, cupo: null, next_payment: null },
  cards: [],
  upcoming_months: [],
};

/**
 * Pasivos (`/liabilities`): the two debt group pages composed. The head is the mortgage page's
 * look over everything owed (server `liabilities-glance`, `liabilitiesGlance.ts`, built from the
 * two groups' payloads): the total, its financing-cost strip, the split mortgage | cards and the
 * next payments. Then each group as its page draws it — the credit-card group's lanes
 * (`cc-lanes`) and the mortgage group's loan list (`mortgage-glance`) — under a title that links
 * there, where the history, the monthly detail, the balance chart and the payments live. Last,
 * «Upcoming payments» over both beside «Liabilities coverage». The page only picks and formats.
 */
export function LiabilitiesPage() {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const { displayUnit } = useDisplayPreferences();
  const { data: sidebarNav, isPending: navPending, isFetching: navFetching } = useSidebarNav(); // convention-ok: nav refetch gates «not found» only, no dim
  const navSettled = !navPending && !navFetching;
  const node = useMemo(() => findBestNavNodeForPathname(sidebarNav?.main, pathname), [sidebarNav, pathname]);
  const slug = node?.slug;

  const glanceQuery = useLiabilitiesGlance(slug, displayUnit);
  const glance = glanceQuery.data;
  const glanceLoading = queryShowsLoading(glanceQuery);
  // Before the head answers, a group is drawn (dimmed); the head then says which ones exist.
  const hasCards = glance == null || glance.cards != null;
  const hasMortgage = glance == null || glance.mortgage != null;
  const lanesQuery = usePortfolioGroupCcLanes(CREDIT_CARD_SLUG, Boolean(slug) && hasCards);
  const mortgageQuery = useMortgageGroupGlance(hasMortgage && slug ? MORTGAGE_SLUG : undefined, displayUnit);

  const error = queryLoadError(glanceQuery);
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

  const lanesLoading = queryShowsLoading(lanesQuery);
  const mortgageLoading = queryShowsLoading(mortgageQuery);
  const lanesError = queryLoadError(lanesQuery);
  const mortgageError = queryLoadError(mortgageQuery);

  return (
    <main>
      <DebtGlanceHeader
        title={title}
        figures={glance ? { unit: glance.unit, value: glance.total, strip: glance.strip } : undefined}
        sub={glance ? <CountsLine glance={glance} /> : null}
        loading={glanceLoading}
      />
      <div className={cn("page-grid", depto.scope)}>
        <PageGridTile id="liabilities-split">
          <Split glance={glance} node={node} loading={glanceLoading} />
          <NextPayments glance={glance} loading={glanceLoading} />
        </PageGridTile>

        {hasCards ? (
          <PageGridTile id="cc-lanes" className={loadableClass(lanesLoading)} aria-busy={lanesLoading || undefined}>
            <h2 className={styles.sectionTitle}>
              <Link to={CREDIT_CARD_PATH}>{t("groupPage.pasivos.creditCardSectionTitle")}</Link>
            </h2>
            {lanesError ? (
              <p className="error">{lanesError instanceof Error ? lanesError.message : t("common.loadFailed")}</p>
            ) : (
              <CreditCardGroupLanes data={lanesQuery.data ?? EMPTY_LANES} loading={lanesLoading || lanesQuery.data == null} />
            )}
          </PageGridTile>
        ) : null}

        {hasMortgage ? (
          <PageGridTile id="mortgage-loans">
            <h2 className={styles.sectionTitle}>
              <Link to={MORTGAGE_PATH}>{t("groupPage.pasivos.mortgageSectionTitle")}</Link>
            </h2>
            {mortgageError ? (
              <p className="error">{mortgageError instanceof Error ? mortgageError.message : t("common.loadFailed")}</p>
            ) : (
              <div className={loadableClass(mortgageLoading, mortgageStyles.frame)}>
                <MortgageLoanList glance={mortgageQuery.data} />
              </div>
            )}
          </PageGridTile>
        ) : null}

        {slug ? <ChartsRow slug={slug} glance={glance} loading={glanceLoading} /> : null}
      </div>
    </main>
  );
}

/** «N cards · N loans» under the total. */
function CountsLine({ glance }: { glance: LiabilitiesGlanceDto }) {
  const { t } = useTranslation();
  const parts: string[] = [];
  if (glance.cards) {
    parts.push(t(glance.cards.count === 1 ? "liabilities.page.cardCountOne" : "liabilities.page.cardCount", { count: glance.cards.count }));
  }
  if (glance.mortgage) {
    parts.push(t(glance.mortgage.count === 1 ? "liabilities.page.loanCountOne" : "liabilities.page.loanCount", { count: glance.mortgage.count }));
  }
  return <>{parts.join(" · ")}</>;
}

/** What is owed, mortgage | cards: one bar (each group's share) and each group's amount, linking to its page. */
function Split({
  glance,
  node,
  loading,
}: {
  glance: LiabilitiesGlanceDto | undefined;
  node: NavTreeNodeDto | null | undefined;
  loading: boolean;
}) {
  const { t } = useTranslation();
  const unit = glance?.unit;
  // Each group in its nav colour (its sidebar square and card pill).
  const colorOf = (slug: string) => {
    const rgb = node?.children?.find((c) => c.slug === slug)?.color_rgb;
    return rgb ? `rgb(${rgb})` : "var(--muted)";
  };
  const groups =
    glance && unit
      ? [
          glance.mortgage && {
            key: "mortgage",
            path: MORTGAGE_PATH,
            label: t("groupPage.pasivos.mortgageSectionTitle"),
            amount: glance.mortgage.balance,
            share: glance.mortgage.share,
            color: colorOf(MORTGAGE_SLUG),
          },
          glance.cards && {
            key: "cards",
            path: CREDIT_CARD_PATH,
            label: t("groupPage.pasivos.creditCardSectionTitle"),
            amount: glance.cards.owed,
            share: glance.cards.share,
            color: colorOf(CREDIT_CARD_SLUG),
          },
        ].filter((g): g is NonNullable<typeof g> => Boolean(g))
      : [];
  return (
    <div className={loadableClass(loading, styles.split)}>
      <div className={styles.splitBar} aria-hidden>
        {groups.map((g) => (
          <i key={g.key} style={{ flexGrow: g.share, flexBasis: 0, background: g.color }} />
        ))}
      </div>
      <div className={cn("mono", styles.splitLabels)}>
        {groups.length && unit
          ? groups.map((g) => (
              <span key={g.key}>
                <i className={styles.swatch} style={{ background: g.color }} aria-hidden />
                <Link to={g.path}>{g.label}</Link> {formatMoney({ value: g.amount, currency: unit })}{" "}
                <span className={styles.muted}>{formatPct(g.share * 100, 1)}</span>
              </span>
            ))
          : BLANK}
      </div>
    </div>
  );
}

/** The first month of «Upcoming payments»: its payments, total and, with a loan in it, its maximum. */
function NextPayments({ glance, loading }: { glance: LiabilitiesGlanceDto | undefined; loading: boolean }) {
  const { t } = useTranslation();
  const first = glance?.upcoming_months[0];
  if (glance && first == null) return null;
  const unit = glance?.unit;
  return (
    <div className={loadableClass(loading, cn("mono", mortgageStyles.next))}>
      <em>{t("liabilities.page.nextPayments")}</em>
      {first && unit ? (
        <>
          <span>{formatYearMonthLabel(first.month)}</span>
          <span>
            {formatMoney({ value: first.total, currency: unit })}
            {first.total_max != null ? ` … ${formatMoney({ value: first.total_max, currency: unit })}` : ""}
          </span>
          <span className={styles.muted}>
            {t(first.parts.length === 1 ? "liabilities.page.paymentCountOne" : "liabilities.page.paymentCount", { count: first.parts.length })}
          </span>
        </>
      ) : (
        <span>{BLANK}</span>
      )}
    </div>
  );
}

/** «Upcoming payments» over both groups beside «Liabilities coverage» (the Pasivos root's chart, on its own controls). */
function ChartsRow({ slug, glance, loading }: { slug: string; glance: LiabilitiesGlanceDto | undefined; loading: boolean }) {
  const { t } = useTranslation();
  const { displayUnit } = useDisplayPreferences();
  // The surface key the root's coverage chart has always used, so a stored choice survives.
  const prefs = useSurfacePrefs(`liab.${slug}.proportional`, "month", "3y");
  const daily = prefs.period === "day";
  const bundle = usePortfolioGroupBundle({ portfolio_group: slug, unit: displayUnit, enabled: !daily });
  const dailySeries = useDailySeries({ portfolioGroup: slug }, displayUnit, timeRangeToDays(prefs.range), daily);
  const dailyPending = dailyPayloadPending(daily, dailySeries);
  const block = daily
    ? dailyPending
      ? null
      : (dailySeries.data?.reference_coverage ?? null)
    : (bundle.data?.ts?.reference_coverage ?? null);
  const coverageLoading = daily ? queryShowsLoading(dailySeries) : queryShowsLoading(bundle);
  return (
    <PageGridTile id="liabilities-charts" className="chart-grid">
      <div className={loadableClass(loading, "chart-grid__col")}>
        <div className="chart-panel-title-row">
          <h3 className="chart-panel-title">{t("liabilities.page.upcomingTitle")}</h3>
        </div>
        <LiabilitiesUpcomingList data={glance} loading={loading} />
      </div>
      <CoverageLineChart
        title={t("charts.liabilitiesCoverage")}
        block={block}
        xAxisGranularity={daily ? "day" : prefs.period === "year" ? "year" : "month"}
        timeRange={prefs.range}
        controls={
          <SurfaceControls
            period={prefs.period}
            onPeriodChange={prefs.setPeriod}
            range={prefs.range}
            onRangeChange={prefs.setRange}
          />
        }
        loading={coverageLoading}
      />
    </PageGridTile>
  );
}
