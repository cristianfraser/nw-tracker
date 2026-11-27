import { useMemo, useState } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import { cn } from "../cn";
import { useTranslation } from "../i18n";
import { useDisplayPreferences } from "../context/DisplayPreferencesContext";
import { useHeldRealEstateGroupGlance, useSidebarNav } from "../queries/hooks";
import { findBestNavNodeForPathname } from "../portfolioNavFromApi";
import { resolveNavTreeLabel } from "../sidebarNavFromApi";
import { DASHBOARD_PATH } from "../dashboardPath";
import { formatCurrency, formatMoney } from "../format";
import { PageGridTile } from "../components/layout/PageGridTile";
import { loadableClass } from "../components/ui/Loadable";
import { ChartBox, CostChart, PlChart, type PlMode } from "../components/depto/DeptoCharts";
import { DeptoHeaderView } from "../components/depto/DeptoHeader";
import { CostRail, DeptoPropertyBands, PlRail } from "../components/depto/DeptoPropertyGlance";
import { pct1, pct1Signed, signedMoney, toneOf } from "../components/depto/deptoFormat";
import { RealEstateGroupValueChart } from "../components/real-estate/RealEstateGroupValueChart";
import { RealEstatePropertyList } from "../components/real-estate/RealEstatePropertyList";
import depto from "../components/depto/Depto.module.css";
import styles from "../components/real-estate/RealEstateGroup.module.css";
import type { RealEstateGroupGlanceDto, RealEstateGroupSummedDto } from "../types";

const BLANK = " ";

/**
 * Real estate (`/real_estate`): the property page for every property of the group (server
 * `real-estate-glance`, `realEstateGroupGlance.ts`). With one property it is that property's page
 * — its header and its value, P/L and cost-of-living bands, the same payload block — under the
 * group's title. With several, the header carries their net equity in the display unit, each
 * property's own header is a row linking to its page, and the three bands are the pages' added up.
 * The page only picks and formats; while the payload is pending the frames render blank and dimmed.
 */
export function RealEstateGroupPage() {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const { displayUnit } = useDisplayPreferences();
  const { data: sidebarNav, isPending: navPending, isFetching: navFetching } = useSidebarNav(); // convention-ok: nav refetch gates «not found» only, no dim
  const navSettled = !navPending && !navFetching;
  const node = useMemo(() => findBestNavNodeForPathname(sidebarNav?.main, pathname), [sidebarNav, pathname]);
  // Held across a unit switch (`heldUnitPayload.ts`): formatted in the shown payload's own unit.
  const query = useHeldRealEstateGroupGlance("realEstateGroup.glance", node?.slug, displayUnit);
  const glance = query.data;
  const loading = query.loading;
  const error = query.error;

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

  const single = glance?.single ?? null;
  const several = glance?.several ?? null;
  const unit = glance?.unit ?? displayUnit;
  return (
    <main>
      <DeptoHeaderView
        title={title}
        figures={headerFigures(glance, (count) => t("realEstate.group.propertyCount", { count }))}
        wideHero={Boolean(glance?.several)}
        exportPath={node ? `/api/groups/${encodeURIComponent(node.slug)}/export.xlsx` : undefined}
        loading={loading}
      />
      <div className="page-grid">
        {glance && (several || glance.properties_without_ledger.length > 0) ? (
          <PageGridTile id="real-estate-properties">
            <div className={cn(depto.scope, styles.frame, loadableClass(loading))}>
              <RealEstatePropertyList glance={glance} />
            </div>
          </PageGridTile>
        ) : null}
        {several ? (
          <SummedBands summed={several} unit={unit} loading={loading} />
        ) : glance && !single ? (
          glance.properties_without_ledger.length === 0 ? (
            <PageGridTile id="real-estate-none">
              <p className="muted">{t("realEstate.group.none")}</p>
            </PageGridTile>
          ) : null
        ) : (
          // One property (or the payload still pending): its page's bands, the same component.
          <DeptoPropertyBands
            glance={single?.glance.property}
            unit={unit}
            loanCurrency={single?.glance.loan_currency}
            loading={loading}
            onToggleMovements={null}
          />
        )}
      </div>
    </main>
  );
}

/** One property: its page's header (loan-currency hero over the unit); several: their net equity in the unit. */
function headerFigures(glance: RealEstateGroupGlanceDto | undefined, countLabel: (count: number) => string) {
  if (glance?.single) {
    const g = glance.single.glance;
    return {
      unit: g.unit,
      hero: formatCurrency(g.header.hero_loan, g.loan_currency),
      sub: g.header.hero != null ? formatMoney({ value: g.header.hero, currency: g.unit }) : null,
      strip: g.header.strip,
    };
  }
  if (glance?.several) {
    return {
      unit: glance.unit,
      hero: formatMoney({ value: glance.several.equity, currency: glance.unit }),
      sub: countLabel(glance.several.properties.length),
      strip: glance.several.strip,
    };
  }
  return undefined;
}

/** The property page's three bands over the server's sums: value, P/L, cost of living. */
function SummedBands({ summed, unit, loading }: { summed: RealEstateGroupSummedDto; unit: string; loading: boolean }) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<PlMode>("pl");
  const { value, pl, cost } = summed;
  const money = (v: number) => formatMoney({ value: v, currency: unit });
  return (
    <PageGridTile id="real-estate-bands" className={cn("page-grid", depto.scope, depto.bands)}>
      {/* value */}
      <div className={loadableClass(loading, depto.bandChart)}>
        <ChartBox ariaLabel={t("realEstate.group.valueChart")}>
          {(cw, ch) => <RealEstateGroupValueChart summed={summed} unit={unit} w={cw} h={ch} />}
        </ChartBox>
      </div>
      <div className={loadableClass(loading, depto.bandRail)}>
        <div className={depto.grp}>
          <div className={depto.own}>
            <i style={{ width: `${value.ownership.owned_share * 100}%`, background: "var(--accent)" }} />
            <i style={{ flex: 1, background: "var(--negative)", opacity: 0.55 }} />
          </div>
          <div className={cn("mono", depto.ownl)}>
            <span>
              <b>{money(value.ownership.owned)}</b> <em>{pct1(value.ownership.owned_share)}</em>
            </span>
            <span>
              <b>{money(value.ownership.owed)}</b> <em>{pct1(value.ownership.owed_share)}</em>
            </span>
          </div>
        </div>
        <div className={cn("mono", depto.grp, depto.kv)}>
          <span>{t("realEstate.group.appraisal")}</span>
          <span>{money(value.appraisal)}</span>
          <span>{t("realEstate.group.atPurchase")}</span>
          <span className={depto.muted}>{money(value.purchase.value)}</span>
          <span />
          <span className={depto[toneOf(value.purchase.revaluation) ?? "muted"]}>
            {signedMoney(value.purchase.revaluation, unit)} <em>{pct1Signed(value.purchase.revaluation_pct)}</em>
          </span>
          <span>{t("realEstate.group.downPayment")}</span>
          <span className={depto.muted}>{money(value.pie)}</span>
        </div>
      </div>

      {/* P/L */}
      <div className={loadableClass(loading, depto.bandChart)}>
        <div className={depto.ctl}>
          <button type="button" className={mode === "pl" ? depto.on : undefined} onClick={() => setMode("pl")}>
            {t("accountDetail.depto.plMode")}
          </button>
          <button type="button" className={mode === "value" ? depto.on : undefined} onClick={() => setMode("value")}>
            {t("accountDetail.depto.valueChangeMode")}
          </button>
        </div>
        <ChartBox ariaLabel={t("accountDetail.depto.plChart")}>{(cw, ch) => <PlChart pl={pl} mode={mode} unit={unit} w={cw} h={ch} />}</ChartBox>
      </div>
      <div className={loadableClass(loading, depto.bandRail)}>
        <PlRail pl={pl} unit={unit} currencyLabel={summed.loan_currencies.map((c) => c.toUpperCase()).join(" · ")} />
      </div>

      {/* cost of living: absent when no property has a tracked place */}
      {cost ? (
        <>
          <div className={loadableClass(loading, depto.bandChart)}>
            <ChartBox ariaLabel={t("accountDetail.depto.costChart")} className={depto.costBox}>
              {(cw, ch) => <CostChart cost={cost} unit={unit} w={cw} h={ch} />}
            </ChartBox>
            <div className={depto.links}>
              <Link className={depto.lnk} to="/flows/expenses/real_estate">
                {t("realEstate.group.expensesLink")}
              </Link>
            </div>
          </div>
          <div className={loadableClass(loading, depto.bandRail)}>
            <CostRail cost={cost} unit={unit} />
          </div>
        </>
      ) : null}
    </PageGridTile>
  );
}
