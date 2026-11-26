import { useState } from "react";
import { Link } from "react-router-dom";
import { cn } from "../../cn";
import { expenseKindLabel, useTranslation } from "../../i18n";
import { PageGridTile } from "../layout/PageGridTile";
import { loadableClass } from "../ui/Loadable";
import type { DeptoCostBandDto, DeptoPropertyGlanceDto, DeptoPropertyPlBandDto, DeptoMonthSplitDto } from "../../types";
import { ChartBox, CostChart, PlChart, ValueChart, costKindColor, type PlMode } from "./DeptoCharts";
import { pct0, pct1, pct1Signed, signedMoney, toneOf } from "./deptoFormat";
import styles from "./Depto.module.css";
import { formatMoney, formatCurrency } from "../../format";

const BLANK = " ";

/** A share of a bar as a CSS width. */
const w = (share: number) => `${share * 100}%`;

/** The month's payments by their ledger labels («12», «12, prepago 2»). */
function cuotasList(labels: readonly string[]): string {
  return labels.join(", ");
}

/**
 * The property page's three bands, each a chart beside its rail: value (the appraisal, the
 * mortgage, deposited and net equity; ownership, appraisal, purchase, pie), P/L (monthly bars and
 * the cumulative line; total, years, this month's split) and the cost of living (the place's bills
 * and the cuota parts; the 12-month window by kind, «movimientos»). `glance` undefined while the
 * bundle is pending: the frames, blank.
 */
export function DeptoPropertyBands({
  glance,
  unit,
  loanCurrency,
  loading,
  onToggleMovements,
}: {
  glance: DeptoPropertyGlanceDto | undefined;
  unit: string;
  loanCurrency: string | undefined;
  loading: boolean;
  /** Opens the account's movements under the bands; null where there is no such list (the group page). */
  onToggleMovements: (() => void) | null;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<PlMode>("pl");
  const cost = glance?.cost;
  return (
    <PageGridTile id="depto-bands" className={cn("page-grid", styles.scope, styles.bands)}>
      {/* value */}
      <div className={loadableClass(loading, styles.bandChart)}>
        <ChartBox ariaLabel={t("accountDetail.depto.valueChart")}>
          {(cw, ch) => (glance && loanCurrency ? <ValueChart value={glance.value} unit={unit} loanCurrency={loanCurrency} w={cw} h={ch} /> : null)}
        </ChartBox>
      </div>
      <div className={loadableClass(loading, styles.bandRail)}>
        {glance && loanCurrency ? <ValueRail glance={glance} unit={unit} loanCurrency={loanCurrency} /> : <PendingGroups lines={[2, 4]} />}
      </div>

      {/* P/L */}
      <div className={loadableClass(loading, styles.bandChart)}>
        <div className={styles.ctl}>
          <button type="button" className={mode === "pl" ? styles.on : undefined} onClick={() => setMode("pl")}>
            {t("accountDetail.depto.plMode")}
          </button>
          <button type="button" className={mode === "value" ? styles.on : undefined} onClick={() => setMode("value")}>
            {t("accountDetail.depto.valueChangeMode")}
          </button>
        </div>
        <ChartBox ariaLabel={t("accountDetail.depto.plChart")}>
          {(cw, ch) => (glance ? <PlChart pl={glance.pl} mode={mode} unit={unit} w={cw} h={ch} /> : null)}
        </ChartBox>
      </div>
      <div className={loadableClass(loading, styles.bandRail)}>
        {glance && loanCurrency ? <PlRail pl={glance.pl} unit={unit} currencyLabel={loanCurrency.toUpperCase()} /> : <PendingGroups lines={[3, 3]} />}
      </div>

      {/* cost of living: absent when no tracked place names this property */}
      {cost !== null ? (
        <>
          <div className={loadableClass(loading, styles.bandChart)}>
            <ChartBox ariaLabel={t("accountDetail.depto.costChart")} className={styles.costBox}>
              {(cw, ch) => (cost ? <CostChart cost={cost} unit={unit} w={cw} h={ch} /> : null)}
            </ChartBox>
            {cost ? (
              <div className={styles.links}>
                <Link className={styles.lnk} to={`/flows/expenses/real_estate/${encodeURIComponent(cost.place_slug)}`}>
                  {t("accountDetail.depto.expensesLink")}
                </Link>
              </div>
            ) : null}
          </div>
          <div className={loadableClass(loading, styles.bandRail)}>
            {cost ? <CostRail cost={cost} unit={unit} /> : <PendingGroups lines={[3, 8]} />}
            {glance && onToggleMovements ? <MovementsGroup count={glance.movement_count} onToggle={onToggleMovements} /> : null}
          </div>
        </>
      ) : glance && onToggleMovements ? (
        <div className={styles.bandRail}>
          <MovementsGroup count={glance.movement_count} onToggle={onToggleMovements} />
        </div>
      ) : null}
    </PageGridTile>
  );
}

/** Rail groups while the bundle is pending: blank lines at the loaded groups' rough height. */
export function PendingGroups({ lines }: { lines: readonly number[] }) {
  return (
    <>
      {lines.map((n, i) => (
        <div key={i} className={styles.grp}>
          {Array.from({ length: n }, (_, k) => (
            <div key={k}>{BLANK}</div>
          ))}
        </div>
      ))}
    </>
  );
}

function ValueRail({ glance, unit, loanCurrency }: { glance: DeptoPropertyGlanceDto; unit: string; loanCurrency: string }) {
  const { ownership, appraisal, purchase, pie } = glance.value;
  return (
    <>
      <div className={styles.grp}>
        <div className={styles.own}>
          <i style={{ width: w(ownership.owned_share), background: "var(--accent)" }} />
          <i style={{ flex: 1, background: "var(--negative)", opacity: 0.55 }} />
        </div>
        <div className={cn("mono", styles.ownl)}>
          <span>
            <b>{formatCurrency(ownership.owned_loan, loanCurrency)}</b> <em>{pct1(ownership.owned_share)}</em>
          </span>
          <span>
            <b>{formatCurrency(ownership.owed_loan, loanCurrency)}</b> <em>{pct1(ownership.owed_share)}</em>
          </span>
        </div>
      </div>
      <div className={cn("mono", styles.grp, styles.kv)}>
        <span>{formatCurrency(appraisal.value_loan, loanCurrency)}</span>
        <span>{formatMoney({ value: appraisal.value, currency: unit })}</span>
        <span>{purchase.date}</span>
        <span className={styles.muted}>{formatMoney({ value: purchase.value, currency: unit })}</span>
        <span />
        <span className={styles[toneOf(purchase.revaluation) ?? "muted"]}>
          {signedMoney(purchase.revaluation, unit)} <em>{pct1Signed(purchase.revaluation_pct)}</em>
        </span>
        <span>{formatCurrency(pie.pie_loan, loanCurrency)}</span>
        <span className={styles.muted}>{formatMoney({ value: pie.pie, currency: unit })}</span>
      </div>
    </>
  );
}

/** The P/L band's rail: total, years, this month's split (`currencyLabel` names the currency part's side). */
export function PlRail({ pl, unit, currencyLabel }: { pl: DeptoPropertyPlBandDto; unit: string; currencyLabel: string }) {
  const { total, years, this_month: month } = pl;
  return (
    <>
      <div className={styles.grp}>
        <div className={cn("mono", styles.kv)}>
          <span />
          <span className={styles[toneOf(total.pl) ?? "muted"]}>
            {signedMoney(total.pl, unit)} {total.pct != null ? <em>{pct1Signed(total.pct)}</em> : null}
          </span>
        </div>
        <div className={cn("mono", styles.yrs)}>
          {years.map((y) => (
            <div key={y.year}>
              <em>{y.year}</em>
              <span className={styles[toneOf(y.pl) ?? "muted"]}>{signedMoney(y.pl, unit)}</span>
            </div>
          ))}
        </div>
      </div>
      {month ? <MonthSplit month={month} unit={unit} currencyLabel={currencyLabel} /> : null}
    </>
  );
}

/** This month's P/L as two parts: the cuotas' part that did not become equity, and the currency's move. */
function MonthSplit({ month, unit, currencyLabel }: { month: DeptoMonthSplitDto; unit: string; currencyLabel: string }) {
  const { t } = useTranslation();
  return (
    <div className={styles.grp}>
      <div className={cn("mono", styles.kv)}>
        <span>{month.month}</span>
        <span className={styles[toneOf(month.pl) ?? "muted"]}>{signedMoney(month.pl, unit)}</span>
      </div>
      <div className={styles.dv}>
        <div>
          <i style={{ width: w(month.cuota_share), background: "var(--negative)", borderRadius: "3px 0 0 3px" }} />
        </div>
        <div>
          {month.currency_part != null ? (
            <i
              style={{
                width: w(month.currency_share),
                background: month.currency_part < 0 ? "var(--negative)" : "var(--positive)",
                borderRadius: "0 3px 3px 0",
              }}
            />
          ) : null}
        </div>
      </div>
      <div className={cn("mono", styles.dvl)}>
        <span>
          {month.cuotas.length ? <em>{t("accountDetail.depto.cuotas", { list: cuotasList(month.cuotas) })} </em> : null}
          <b className={styles[toneOf(month.cuota_part) ?? "muted"]}>{signedMoney(month.cuota_part, unit)}</b>
        </span>
        {month.currency_part != null ? (
          <span>
            <b className={styles[toneOf(month.currency_part) ?? "muted"]}>{signedMoney(month.currency_part, unit)}</b>{" "}
            <em>{currencyLabel}</em>
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** The cost band's rail: the 12-month window's total, its cost | equity split, a row per kind. */
export function CostRail({ cost, unit }: { cost: Pick<DeptoCostBandDto, "window">; unit: string }) {
  const win = cost.window;
  if (!win) return null;
  const costRows = win.rows.filter((r) => r.direction === "cost");
  const equityRows = win.rows.filter((r) => r.direction === "equity");
  const row = (r: (typeof win.rows)[number]) => (
    <div key={r.kind}>
      <i className={styles.sw} style={{ background: costKindColor(r.kind) }} />
      <span className={styles.kindName}>{expenseKindLabel(r.kind)}</span>
      <div className={styles.hbar}>
        <i style={{ width: w(r.share), background: costKindColor(r.kind) }} />
      </div>
      <span className={cn("mono", styles.r, r.direction === "equity" && styles.pos)}>{formatMoney({ value: r.total, currency: unit })}</span>
    </div>
  );
  return (
    <>
      <div className={styles.grp}>
        <div className={cn("mono", styles.window)}>
          {win.from} → {win.to}
        </div>
        <div className={cn("mono", styles.big)}>{formatMoney({ value: win.total, currency: unit })}</div>
        <div className={styles.split}>
          <i style={{ width: w(win.cost_share), background: "var(--negative)" }} />
          <i style={{ flex: 1, background: "var(--positive)" }} />
        </div>
        <div className={cn("mono", styles.splitl)}>
          <span>
            <b>{formatMoney({ value: win.cost, currency: unit })}</b> <em>{pct0(win.cost_share)}</em>
          </span>
          <span>
            <b className={styles.pos}>{formatMoney({ value: win.equity, currency: unit })}</b> <em>{pct0(win.equity_share)}</em>
          </span>
        </div>
      </div>
      <div className={cn(styles.grp, styles.kinds)}>
        {costRows.map(row)}
        {costRows.length && equityRows.length ? <span className={styles.gap} /> : null}
        {equityRows.map(row)}
      </div>
    </>
  );
}

/** «movimientos (N)» on the property's rail: opens the account's movements under the bands. */
function MovementsGroup({ count, onToggle }: { count: number; onToggle: () => void }) {
  const { t } = useTranslation();
  return (
    <div className={styles.grp}>
      <button type="button" className={styles.lnk} onClick={onToggle}>
        {t("accountDetail.depto.movements", { count })}
      </button>
    </div>
  );
}
