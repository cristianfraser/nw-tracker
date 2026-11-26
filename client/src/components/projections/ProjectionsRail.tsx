import { cn } from "../../cn";
import { useTranslation } from "../../i18n";
import { formatCurrency, formatGroupedDecimalTrimmed } from "../../format";
import type { ProjectionsGlance, ProjectionsStrategy } from "../../types";
import { GlanceGroup, GlanceRail } from "../account/PositionGlance";
import { pctOf } from "../account/positionGlanceLayout";
import { projectionLineStyle } from "../charts/ProjectionsChart";
import glance from "../account/PositionGlance.module.css";
import styles from "./ProjectionsRail.module.css";

const BLANK = " ";

type Composition = NonNullable<ProjectionsGlance["composition"]>;

const SEGMENT_CLASS: Record<Composition["segments"][number]["kind"], string> = {
  today: glance.seg_deposited,
  contributions: styles.segContributions,
  growth: glance.seg_price,
  loss: glance.seg_loss,
};

/** A projected amount with its sign: whole units in every currency. */
function signedMoney(value: number, unit: string): string {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${formatCurrency(Math.abs(value), unit)}`;
}

function pct(n: number): string {
  return `${formatGroupedDecimalTrimmed(n)}%`;
}

/** Net worth at retirement as today + contributions + real growth, to scale (the position page's «value today» bar). */
function CompositionGroup({ composition, unit, retireAge }: { composition: Composition; unit: string; retireAge: number }) {
  const { t } = useTranslation();
  const flow = composition.segments.filter((s) => s.kind !== "loss");
  const loss = composition.segments.find((s) => s.kind === "loss");
  return (
    <GlanceGroup>
      <div className={glance.bracket}>
        <i style={{ left: 0, width: pctOf(composition.value_share) }} />
        <span style={{ left: pctOf(composition.value_share / 2) }}>{t("projections.rail.netWorthAt", { age: retireAge })}</span>
      </div>
      <div className={glance.compBar}>
        {flow.map((s) => (
          <span key={s.kind} className={SEGMENT_CLASS[s.kind]} style={{ width: pctOf(s.share) }} />
        ))}
        {loss ? <span className={SEGMENT_CLASS.loss} style={{ left: pctOf(loss.start), width: pctOf(loss.share) }} /> : null}
      </div>
      <div className={glance.compLabels}>
        <span>
          <em>{t("projections.rail.today")}</em>
          <b className="mono">{formatCurrency(composition.today, unit)}</b>
        </span>
        <span className={glance.labelNext}>
          <em>{t("projections.rail.contributions")}</em>
          <b className={cn("mono", styles.contributions)}>{signedMoney(composition.contributions, unit)}</b>
        </span>
        <span className={glance.results}>
          <span className={glance.labelRight}>
            <em>{t("projections.rail.realGrowth")}</em>
            <b className={cn("mono", composition.growth < 0 ? glance.negative : composition.growth > 0 ? glance.positive : undefined)}>
              {signedMoney(composition.growth, unit)}
            </b>
          </span>
        </span>
      </div>
    </GlanceGroup>
  );
}

function useStrategyWords(): {
  name: (s: ProjectionsStrategy) => string;
  lasts: (s: ProjectionsStrategy) => string;
} {
  const { t } = useTranslation();
  return {
    name: (s) =>
      s.kind === "fixed_income"
        ? t("projections.strategy.fixed_income")
        : t(`projections.strategy.${s.kind}`, { pct: s.pct != null ? pct(s.pct) : "—" }),
    lasts: (s) =>
      s.lasts.kind === "always" ? t("projections.lasts.always") : t(`projections.lasts.${s.lasts.kind}`, { age: s.lasts.age }),
  };
}

/**
 * The /projections rail (server `glance`, `projections.ts`), in the position page's rail: net
 * worth at retirement by where it comes from, the pot the strategies draw from, and each
 * strategy's monthly income with how long its pot lasts on the span retirement → end age.
 * `glance` undefined while the first response is pending: the frames with blank figures.
 */
export function ProjectionsRail({ glance: g, unit }: { glance: ProjectionsGlance | undefined; unit: string }) {
  const { t } = useTranslation();
  const words = useStrategyWords();
  const money = (value: number) => formatCurrency(value, unit);
  const potRows: [label: string, value: string][] = [
    [g ? t("projections.rail.invested", { age: g.retire_age }) : BLANK, g ? money(g.invested_at_retire) : BLANK],
    [g ? t("projections.rail.other") : BLANK, g ? money(g.other_at_retire) : BLANK],
    [
      g ? t("projections.rail.pot", { pct: pct(g.liquidate_other_pct) }) : BLANK,
      g ? money(g.pot_at_retire) : BLANK,
    ],
  ];
  return (
    <GlanceRail>
      {g == null ? (
        <GlanceGroup>
          <div className={glance.bracket} />
          <div className={glance.compBar} />
          <div className={glance.compLabels}>
            <span>
              <em>{BLANK}</em>
              <b className="mono">{BLANK}</b>
            </span>
          </div>
        </GlanceGroup>
      ) : g.composition ? (
        <CompositionGroup composition={g.composition} unit={unit} retireAge={g.retire_age} />
      ) : null}
      <GlanceGroup>
        <dl className={styles.pot}>
          {potRows.map(([label, value], i) => (
            <div key={i} className={styles.potRow}>
              <dt>{label}</dt>
              <dd className="mono">{value}</dd>
            </div>
          ))}
        </dl>
      </GlanceGroup>
      <GlanceGroup className={glance.groupLast}>
        <div className={styles.strategiesHead}>
          <span>{g ? t("projections.rail.incomeTitle", { age: g.retire_age }) : BLANK}</span>
          <span>{g ? t("projections.rail.lastsHead") : BLANK}</span>
        </div>
        <ul className={styles.strategies}>
          {(g?.strategies ?? PENDING_STRATEGIES).map((s, i) => (
            <li
              key={s?.kind ?? i}
              className={styles.strategy}
              aria-label={
                s
                  ? t("projections.rail.strategyAria", {
                      name: words.name(s),
                      amount: money(s.monthly_income),
                      lasts: words.lasts(s),
                    })
                  : undefined
              }
            >
              {s ? (
                <>
                  <span className={styles.strategyName} aria-hidden="true">
                    <i className={styles.swatch} style={{ background: projectionLineStyle(s.line_key).stroke }} />
                    {words.name(s)}
                  </span>
                  <span className={styles.lastsBar} aria-hidden="true">
                    <i
                      className={s.lasts.kind === "depleted" ? styles.depleted : undefined}
                      style={{ width: pctOf(s.lasts_share) }}
                    />
                  </span>
                  <span className={cn("mono", styles.amount)} aria-hidden="true">
                    {money(s.monthly_income)}
                  </span>
                  <span className={cn("mono", styles.lasts, s.lasts.kind === "depleted" && styles.lastsDepleted)} aria-hidden="true">
                    {words.lasts(s)}
                  </span>
                </>
              ) : (
                <span>{BLANK}</span>
              )}
            </li>
          ))}
          {g ? (
            <li className={styles.strategy} aria-hidden="true">
              <span />
              <span className={cn("mono", styles.ages)}>
                <span>{g.retire_age}</span>
                <span>{g.end_age}</span>
              </span>
            </li>
          ) : null}
        </ul>
        {g && g.monthly_rent > 0 ? (
          <p className={styles.note}>{t("projections.rail.rentNote", { amount: money(g.monthly_rent) })}</p>
        ) : null}
        {g?.strategies.some((s) => s.income_is_initial) ? (
          <p className={styles.note}>{t("projections.rail.initialNote")}</p>
        ) : null}
      </GlanceGroup>
    </GlanceRail>
  );
}

/** Three blank rows while the first response is pending (every payload has the three strategies). */
const PENDING_STRATEGIES: (ProjectionsStrategy | null)[] = [null, null, null];
