import { Fragment, useState, type CSSProperties, type ReactNode } from "react";
import { readPref, writePref } from "../../usePersistedPref";
import { ChevronIcon } from "../ui/ChevronIcon";
import { ColorMarker } from "../ui/ColorMarker";
import { Link } from "react-router-dom";
import { cn } from "../../cn";
import { useTranslation } from "../../i18n";
import { formatMoney, formatPct } from "../../format";
import type {
  GroupGlanceCashDto,
  GroupGlanceDto,
  GroupGlancePeriodFigureDto,
  GroupGlanceRowDto,
  Money,
} from "../../types";
import {
  CompositionGroup,
  GlanceRail,
  GlanceTitleLine,
  PendingCompositionGroup,
  PeriodsGroup,
} from "../account/PositionGlance";
import { formatSignedMoney, formatSignedPct, pctOf } from "../account/positionGlanceLayout";
import { loadableClass } from "../ui/Loadable";
import { openByDefault, rowKey } from "./groupGlanceRows";
import styles from "./GroupGlance.module.css";

const BLANK = " ";

function toneClass(v: number | null | undefined): string | undefined {
  if (v == null || v === 0) return undefined;
  return v > 0 ? styles.positive : styles.negative;
}

function SignedMoney({ money }: { money: Money | null }) {
  if (!money) return <>—</>;
  return <span className={toneClass(money.value)}>{formatSignedMoney(money)}</span>;
}

/**
 * The group page's title line: the group's name, today's value and the day's P/L (server
 * `group_glance`); on a cash group the day's change of the balance, the figure its strip shows
 * (`cash.change.day`). `glance` undefined = pending: the nav's name, blank figures.
 */
export function GroupGlanceTitle({
  glance,
  fallbackTitle,
  loading = false,
}: {
  glance: GroupGlanceDto | undefined;
  fallbackTitle: string;
  loading?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <GlanceTitleLine
      // The nav's label (translated like the sidebar's) once known; the server's before.
      title={fallbackTitle || glance?.title || ""}
      value={glance?.value ?? null}
      day={glance?.cash ? glance.cash.change.day : (glance?.day ?? null)}
      dayLabel={glance?.cash ? t("groupPage.cashGlance.dayChange") : undefined}
      loading={loading}
    />
  );
}

/**
 * A row's display name: the server's label, or its i18n key translated at render (a liquidated
 * row's with the number of rows it folds).
 */
function useRowLabel(): (row: Pick<GroupGlanceRowDto, "kind" | "label" | "label_i18n_key" | "members">) => string {
  const { t } = useTranslation();
  return (row) =>
    !row.label_i18n_key
      ? row.label
      : row.kind === "liquidated"
        ? t(row.label_i18n_key, { count: row.members.length })
        : t(row.label_i18n_key);
}

/**
 * A cash group's balances by the currency its accounts hold (server `group_glance.cash`): a bar
 * to scale, each currency's balance in that currency (and in the display unit when it is
 * another), and at the right what the linked cards owe, when the group nets them.
 */
function CurrencyGroup({ cash, unit }: { cash: GroupGlanceCashDto; unit: string }) {
  const { t } = useTranslation();
  return (
    <div className={styles.currencies}>
      <div className={styles.stripCaption}>{t("groupPage.cashGlance.byCurrency")}</div>
      <div className={styles.currencyBar}>
        {cash.by_currency.map((c, i) => (
          <span key={c.currency} className={styles[`currency${Math.min(i, 3)}`]} style={{ width: pctOf(c.share) }} />
        ))}
      </div>
      <div className={styles.currencyLabels}>
        {cash.by_currency.map((c, i) => (
          <span key={c.currency}>
            <em>
              <i className={styles[`currency${Math.min(i, 3)}`]} />
              {c.currency.toUpperCase()}
            </em>
            <b className="mono">{formatMoney(c.native, { precision: "full" })}</b>
            {c.currency !== unit ? <small className="mono">{formatMoney(c.value)}</small> : null}
          </span>
        ))}
        {cash.linked_cards ? (
          <span className={styles.currencyCards}>
            <em>
              <Link to={cash.linked_cards.route_path}>
                {cash.linked_cards.label_i18n_key ? t(cash.linked_cards.label_i18n_key) : cash.linked_cards.label}
              </Link>
            </em>
            <b className={cn("mono", toneClass(cash.linked_cards.value.value))}>
              {formatMoney(cash.linked_cards.value)}
            </b>
          </span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The strip under the band: the «valor hoy» composition bar (the position page's, summed over the
 * group's members by the server) | the día / mes / año bars. A cash group (`cash`): its balances
 * by currency | the change of its balance over the day, the month and the year, on the same bars.
 * Pending: their frames.
 */
export function GroupGlanceStrip({ glance, cash = false }: { glance: GroupGlanceDto | undefined; cash?: boolean }) {
  const { t } = useTranslation();
  return (
    <>
      <div className={styles.stripComposition}>
        <GlanceRail>
          {glance ? (
            glance.cash ? (
              <CurrencyGroup cash={glance.cash} unit={glance.unit} />
            ) : glance.composition ? (
              <CompositionGroup composition={glance.composition} />
            ) : null
          ) : (
            <PendingCompositionGroup />
          )}
        </GlanceRail>
      </div>
      <div className={styles.stripPeriods}>
        <GlanceRail>
          {cash ? <div className={styles.stripCaption}>{t("groupPage.cashGlance.change")}</div> : null}
          <PeriodsGroup periods={cash ? (glance?.cash?.change ?? null) : (glance?.periods ?? null)} />
        </GlanceRail>
      </div>
    </>
  );
}

const SPARK_W = 120;
const SPARK_H = 20;

/** Height 0..1 from the bottom → the spark's SVG y (1px inset top and bottom). */
function sparkY(y: number): string {
  return ((1 - y) * (SPARK_H - 2) + 1).toFixed(1);
}

/**
 * A row's one-year sparkline (server points, x/y in 0..1): the balance on the row's own scale, or
 * the chained return on the table's shared scale with a dashed 0 % line at `zeroY`.
 */
function Spark({
  points,
  zeroY,
  className,
}: {
  points: readonly { x: number; y: number }[];
  zeroY?: number;
  className?: string;
}) {
  if (points.length < 2) return <span className={styles.spark} />;
  const d = points.map((p) => `${(p.x * SPARK_W).toFixed(1)},${sparkY(p.y)}`).join(" ");
  return (
    <svg className={cn(styles.spark, className)} viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} preserveAspectRatio="none" aria-hidden="true">
      {zeroY != null ? (
        <line
          className={styles.sparkZero}
          x1={0}
          x2={SPARK_W}
          y1={sparkY(zeroY)}
          y2={sparkY(zeroY)}
          vectorEffect="non-scaling-stroke"
        />
      ) : null}
      <polyline points={d} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

type SparkMode = "perf" | "balance";
const SPARK_MODES: readonly SparkMode[] = ["perf", "balance"];
const SPARK_MODE_LS_KEY = "nw-tracker.groupGlance.spark";

function parseSparkMode(raw: string | null): SparkMode {
  return raw === "balance" ? "balance" : "perf";
}

/** What the sparklines draw: the chained return on the shared scale, or the row's balance. */
type SparkView = { mode: "perf"; zeroY: number } | { mode: "balance" };

const GLANCE_OPEN_LS_PREFIX = "nw-tracker.groupGlance.open.";

/** Tolerant parse of the stored choices (a per-viewer convenience): anything else is no choice. */
function parseOpenChoices(raw: string | null): Record<string, boolean> {
  if (raw == null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: Record<string, boolean> = {};
  for (const [key, open] of Object.entries(parsed)) {
    if (typeof open === "boolean") out[key] = open;
  }
  return out;
}

/**
 * One line of a cash group's table: dot + name | one-year balance line | balance in the currency
 * the accounts hold | value in the unit | weight | month change | year change.
 */
function CashGlanceRow({
  row,
  color,
  variant,
  caret,
}: {
  row: GroupGlanceRowDto;
  color: string;
  variant: "total" | "child" | "member";
  caret?: { open: boolean; onToggle: () => void };
}) {
  const { t } = useTranslation();
  const label = useRowLabel()(row);
  const sold = !row.held && variant !== "total";
  const cards = row.kind === "linked_cards";
  return (
    <div
      role="row"
      className={cn(
        styles.row,
        variant === "total" && styles.totalRow,
        variant === "member" && styles.memberRow,
        sold && styles.soldRow
      )}
    >
      <span role="cell" className={styles.nameCell}>
        {caret ? (
          <button
            type="button"
            className={cn(styles.caret, caret.open && styles.caretOpen)}
            aria-expanded={caret.open}
            aria-label={t(caret.open ? "groupPage.investmentGlance.collapse" : "groupPage.investmentGlance.expand", {
              name: label,
            })}
            onClick={caret.onToggle}
          >
            <ChevronIcon />
          </button>
        ) : (
          <span className={styles.caretSpace} />
        )}
        <ColorMarker color={color} className={styles.dot} />
        <Link to={row.route_path} className={styles.name}>
          {label}
        </Link>
      </span>
      <span role="cell" className={styles.sparkCell}>
        <Spark points={row.spark} className={variant !== "total" ? styles.sparkChild : styles.sparkTotalPerf} />
      </span>
      <span role="cell" className={cn("mono", styles.num, styles.native)}>
        {row.native.length > 0
          ? row.native.map((m) => <span key={m.currency}>{formatMoney(m, { precision: "full" })}</span>)
          : "—"}
      </span>
      <span role="cell" className={cn("mono", styles.num, styles.value, cards && toneClass(row.value.value))}>
        {formatMoney(row.value)}
      </span>
      <span role="cell" className={styles.shareCell}>
        {sold || cards ? null : (
          <>
            <span className={styles.shareBar}>
              <i style={{ width: pctOf(row.share), background: variant === "total" ? undefined : color }} />
            </span>
            <span className={cn("mono", styles.sharePct)}>{formatPct(row.share * 100, 2)}</span>
          </>
        )}
      </span>
      <span role="cell" className={cn("mono", styles.num, styles.month)}>
        <SignedMoney money={row.change?.month ?? null} />
      </span>
      <span role="cell" className={cn("mono", styles.num, styles.year)}>
        <SignedMoney money={row.change?.year ?? null} />
      </span>
    </div>
  );
}

/**
 * The «hoy» cell: today's value, and under it the day's P/L and % (a sold-out row: the value only).
 */
function TodayCell({ row, sold }: { row: GroupGlanceRowDto; sold: boolean }) {
  const { t } = useTranslation();
  const pl = row.period_figures?.day.pl ?? null;
  const pct = row.day_pct;
  const showChange = !sold && (pl != null || pct != null);
  return (
    <span role="cell" className={cn("mono", styles.num, styles.today)}>
      <span className={styles.value}>{formatMoney(row.value)}</span>
      {showChange ? (
        <span className={cn(styles.todayChange, toneClass(pl?.value ?? pct))}>
          <span className={styles.figureAmount}>
            <span className="visually-hidden">{t("groupPage.investmentGlance.figure.dayPl")} </span>
            {pl ? formatSignedMoney(pl) : "—"}
          </span>
          <span>{pct != null ? formatSignedPct(pct) : "—"}</span>
        </span>
      ) : null}
    </span>
  );
}

/**
 * A period cell (mes, año, total): the % on top, the period's P/L under it and, after a thin rule,
 * the period's net aportes in the neutral tone. The aportes line keeps its place when there are
 * none, so a row's cells line up. A sold-out row's month and year read «—».
 */
function PeriodCell({
  pct,
  figure,
  className,
  empty = false,
}: {
  pct: number | null;
  figure: GroupGlancePeriodFigureDto | null;
  className: string | undefined;
  empty?: boolean;
}) {
  const { t } = useTranslation();
  if (empty) {
    return (
      <span role="cell" className={cn("mono", styles.num, styles.period, className)}>
        <span className={styles.periodPct}>—</span>
      </span>
    );
  }
  const pl = figure?.pl ?? null;
  const deposits = figure?.deposits ?? null;
  const depositsShown = deposits != null && deposits.value !== 0;
  return (
    <span role="cell" className={cn("mono", styles.num, styles.period, className)}>
      <span className={cn(styles.periodPct, toneClass(pct ?? pl?.value))}>{pct != null ? formatSignedPct(pct) : "—"}</span>
      <span className={cn(styles.figureAmount, toneClass(pl?.value))}>
        <span className="visually-hidden">{t("groupPage.investmentGlance.figure.pl")} </span>
        {pl ? formatSignedMoney(pl) : "—"}
      </span>
      <span
        className={cn(styles.periodDeposits, !depositsShown && styles.periodDepositsEmpty)}
        title={depositsShown ? t("groupPage.investmentGlance.figure.deposits") : undefined}
        aria-hidden={depositsShown ? undefined : true}
      >
        {depositsShown ? (
          <>
            <span className="visually-hidden">{t("groupPage.investmentGlance.figure.deposits")} </span>
            {formatSignedMoney(deposits)}
          </>
        ) : (
          BLANK
        )}
      </span>
    </span>
  );
}

/**
 * One line of the table: dot + name | sparkline | hoy (value, the day's P/L and %) | peso | mes |
 * año | total — each period its %, P/L and aportes stacked. A member row is indented by its `depth`
 * under the page's rows. A liquidated row has no page: a click on its name opens it, like its caret.
 */
function GlanceRow({
  row,
  color,
  variant,
  depth = 1,
  sparkView,
  caret,
}: {
  row: GroupGlanceRowDto;
  color: string;
  variant: "total" | "child" | "member";
  depth?: number;
  sparkView: SparkView;
  caret?: { open: boolean; onToggle: () => void };
}) {
  const { t } = useTranslation();
  const label = useRowLabel()(row);
  const sold = !row.held && variant !== "total";
  const figures = row.period_figures;
  return (
    <div
      role="row"
      className={cn(
        styles.row,
        styles.periodRow,
        variant === "total" && styles.totalRow,
        variant === "member" && styles.memberRow,
        sold && styles.soldRow
      )}
      style={variant === "member" ? ({ "--glance-depth": depth } as CSSProperties) : undefined}
    >
      <span role="cell" className={styles.nameCell}>
        {caret ? (
          <button
            type="button"
            className={cn(styles.caret, caret.open && styles.caretOpen)}
            aria-expanded={caret.open}
            aria-label={t(caret.open ? "groupPage.investmentGlance.collapse" : "groupPage.investmentGlance.expand", {
              name: label,
            })}
            onClick={caret.onToggle}
          >
            <ChevronIcon />
          </button>
        ) : (
          <span className={styles.caretSpace} />
        )}
        <ColorMarker color={color} className={styles.dot} />
        {row.kind === "liquidated" ? (
          // A pointer target only: the caret beside it is the control (name and state).
          <span className={cn(styles.name, styles.nameToggle)} onClick={caret?.onToggle}>
            {label}
          </span>
        ) : (
          <Link to={row.route_path} className={styles.name}>
            {label}
          </Link>
        )}
      </span>
      <span role="cell" className={styles.sparkCell}>
        <Spark
          points={sparkView.mode === "perf" ? row.perf_spark : row.spark}
          zeroY={sparkView.mode === "perf" ? sparkView.zeroY : undefined}
          className={
            variant !== "total" ? styles.sparkChild : sparkView.mode === "perf" ? styles.sparkTotalPerf : undefined
          }
        />
      </span>
      <TodayCell row={row} sold={sold} />
      <span role="cell" className={styles.shareCell}>
        {sold ? null : (
          <>
            <span className={styles.shareBar}>
              <i style={{ width: pctOf(row.share), background: variant === "total" ? undefined : color }} />
            </span>
            <span className={cn("mono", styles.sharePct)}>{formatPct(row.share * 100, 2)}</span>
          </>
        )}
      </span>
      <PeriodCell pct={row.month_pct} figure={figures?.month ?? null} className={styles.month} empty={sold} />
      <PeriodCell pct={row.year_pct} figure={figures?.year ?? null} className={styles.year} empty={sold} />
      <PeriodCell
        pct={row.total_pct}
        figure={{ pl: row.total_pl, deposits: row.deposits }}
        className={styles.total}
      />
    </div>
  );
}

/** A pending row: the name from the nav tree, blank figures at the loaded height. */
function PendingRow({ label, total = false, cash = false }: { label: string; total?: boolean; cash?: boolean }) {
  const head = (
    <>
      <span role="cell" className={styles.nameCell}>
        <span className={styles.caretSpace} />
        <span className={cn(styles.dot, styles.dotPending)} />
        <span className={styles.name}>{label || BLANK}</span>
      </span>
      <span role="cell" className={styles.sparkCell} />
    </>
  );
  if (cash) {
    return (
      <div role="row" className={cn(styles.row, total && styles.totalRow)}>
        {head}
        <span role="cell" className={cn(styles.num, styles.native)} />
        <span role="cell" className={cn(styles.num, styles.value)}>
          {BLANK}
        </span>
        <span role="cell" className={styles.shareCell} />
        <span role="cell" className={cn(styles.num, styles.month)} />
        <span role="cell" className={cn(styles.num, styles.year)} />
      </div>
    );
  }
  return (
    <div role="row" className={cn(styles.row, total && styles.totalRow)}>
      {head}
      <span role="cell" className={cn(styles.num, styles.today)}>
        {BLANK}
      </span>
      <span role="cell" className={styles.shareCell} />
      <span role="cell" className={cn(styles.num, styles.month)} />
      <span role="cell" className={cn(styles.num, styles.year)} />
      <span role="cell" className={cn(styles.num, styles.total)} />
    </div>
  );
}

/**
 * The children table (server `group_glance`): the group's own row first, a hairline, then one
 * row per child heaviest first, a row with rows under it opening them (indented under a caret, at
 * any depth; `openByDefault`, toggles kept per page), sold-out children last and muted — two or
 * more folded by the server into one «Liquidadas (n)» row, closed until opened. The sparkline column
 * draws each row's chained return on one shared scale (default) or its balance, one choice kept for
 * every group page. «hoy» is today's value over the day's P/L and %; mes, año and total stack the
 * %, the P/L and the period's aportes (lifetime for total). One row list at every width: a
 * container query keeps name, hoy, mes and total when narrow (no horizontal scroll). Each dot takes the child's chart
 * colour (`colorFor`, the page's group colour maps), so dot, band and bar match.
 *
 * A cash group (`cash`): the same rows without return figures — the line is always the balance,
 * the columns the balance in the currency the accounts hold, the value in the unit, the weight
 * and the month's and year's change; the linked cards are a row of their own (negative). Narrow,
 * it keeps name, balance and value.
 */
export function GroupGlanceTable({
  glance,
  title,
  pendingLabels,
  colorFor,
  totalColor,
  loading = false,
  cash = false,
}: {
  glance: GroupGlanceDto | undefined;
  /** A cash group's table (known from the nav node before the glance is in). */
  cash?: boolean;
  /** The group's name (the pending total row's). */
  title: string;
  /** The nav node's children, for the pending rows. */
  pendingLabels: readonly string[];
  colorFor: (row: GroupGlanceRowDto) => string;
  /** The total row's dot (the group's own colour). */
  totalColor: string;
  loading?: boolean;
}) {
  const { t } = useTranslation();
  // The viewer's open/closed choices, kept per page; a row without one follows `openByDefault`.
  const storageKey = `${GLANCE_OPEN_LS_PREFIX}${glance?.slug ?? ""}`;
  const [choices, setChoices] = useState<{ key: string; open: Record<string, boolean> }>(() => ({
    key: storageKey,
    open: parseOpenChoices(readPref(storageKey)),
  }));
  // Another page (or the slug arriving after the pending frame) reads its own stored choices.
  const openChoices = choices.key === storageKey ? choices.open : parseOpenChoices(readPref(storageKey));
  const toggle = (key: string, current: boolean) => {
    const next = { ...openChoices, [key]: !current };
    setChoices({ key: storageKey, open: next });
    if (glance) writePref(storageKey, JSON.stringify(next));
  };
  // One choice for every group page.
  const [sparkMode, setSparkModeState] = useState<SparkMode>(() => parseSparkMode(readPref(SPARK_MODE_LS_KEY)));
  const setSparkMode = (mode: SparkMode) => {
    setSparkModeState(mode);
    writePref(SPARK_MODE_LS_KEY, mode);
  };
  const sparkView: SparkView | undefined = glance
    ? sparkMode === "perf"
      ? { mode: "perf", zeroY: glance.perf_zero_y }
      : { mode: "balance" }
    : undefined;
  const rowOpen = (row: GroupGlanceRowDto) => row.members.length > 0 && (openChoices[rowKey(row)] ?? openByDefault(row));
  /**
   * A row and, while open, the rows under it, at any depth. A row's colour is its parent's, the
   * page's rows their own; a liquidated row passes on the colour its list has. Open choices are
   * kept by the row's path (a page row's is its own key; a row that gets folded starts over).
   */
  const renderRow = (
    row: GroupGlanceRowDto,
    depth: number,
    path: string,
    inherited: string | null,
    view: SparkView
  ): ReactNode => {
    const folded = row.kind === "liquidated";
    const color = folded ? "transparent" : (inherited ?? colorFor(row));
    const hasMembers = row.members.length > 0;
    const open = hasMembers && (openChoices[path] ?? openByDefault(row));
    const membersView: SparkView =
      view.mode === "perf" && row.members_perf_zero_y != null ? { mode: "perf", zeroY: row.members_perf_zero_y } : view;
    return (
      <Fragment key={path}>
        <GlanceRow
          row={row}
          color={color}
          variant={depth === 0 ? "child" : "member"}
          depth={depth}
          sparkView={view}
          caret={hasMembers ? { open, onToggle: () => toggle(path, open) } : undefined}
        />
        {open
          ? row.members.map((m) =>
              renderRow(m, depth + 1, `${path}>${rowKey(m)}`, folded ? inherited : color, membersView)
            )
          : null}
      </Fragment>
    );
  };
  if (cash) {
    return (
      <div className={loadableClass(loading, styles.frame)}>
        <div
          role="table"
          className={cn(styles.table, styles.tableCash)}
          aria-label={t("groupPage.cashGlance.tableLabel", { name: title })}
        >
          <div role="row" className={cn(styles.row, styles.headRow)}>
            <span role="columnheader" className={styles.nameCell} />
            <span role="columnheader" className={cn(styles.sparkCell, styles.num)}>
              {t("groupPage.cashGlance.col.spark")}
            </span>
            <span role="columnheader" className={cn(styles.num, styles.native)}>
              {t("groupPage.cashGlance.col.native")}
            </span>
            <span role="columnheader" className={cn(styles.num, styles.value)}>
              {t("groupPage.investmentGlance.col.value")}
            </span>
            <span role="columnheader" className={styles.shareCell}>
              {t("groupPage.investmentGlance.col.share")}
            </span>
            <span role="columnheader" className={cn(styles.num, styles.month)}>
              {t("groupPage.investmentGlance.col.month")}
            </span>
            <span role="columnheader" className={cn(styles.num, styles.year)}>
              {t("groupPage.investmentGlance.col.year")}
            </span>
          </div>
          {glance ? (
            <>
              <CashGlanceRow row={glance.total} color={totalColor} variant="total" />
              {glance.rows.map((row) => {
                const key = rowKey(row);
                const color = colorFor(row);
                const open = rowOpen(row);
                return (
                  <div key={key} role="rowgroup" className={styles.rowGroup}>
                    <CashGlanceRow
                      row={row}
                      color={color}
                      variant="child"
                      caret={row.members.length > 0 ? { open, onToggle: () => toggle(key, open) } : undefined}
                    />
                    {open
                      ? row.members.map((m) => <CashGlanceRow key={rowKey(m)} row={m} color={color} variant="member" />)
                      : null}
                  </div>
                );
              })}
            </>
          ) : (
            <>
              <PendingRow label={title} total cash />
              {pendingLabels.map((label, i) => (
                <div key={i} role="rowgroup" className={styles.rowGroup}>
                  <PendingRow label={label} cash />
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className={loadableClass(loading, styles.frame)}>
      <div role="table" className={styles.table} aria-label={t("groupPage.investmentGlance.tableLabel", { name: title })}>
        <div role="row" className={cn(styles.row, styles.headRow)}>
          <span role="columnheader" className={styles.nameCell} />
          <span role="columnheader" className={styles.sparkCell}>
            <span
              className={cn("surface-controls__set", styles.sparkToggle)}
              role="group"
              aria-label={t("groupPage.investmentGlance.sparkMode.label")}
            >
              {SPARK_MODES.map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={mode === sparkMode ? "is-on" : undefined}
                  aria-pressed={mode === sparkMode}
                  onClick={() => setSparkMode(mode)}
                >
                  {t(`groupPage.investmentGlance.sparkMode.${mode}`)}
                </button>
              ))}
            </span>
          </span>
          <span role="columnheader" className={cn(styles.num, styles.today)}>
            {t("groupPage.investmentGlance.col.today")}
          </span>
          <span role="columnheader" className={styles.shareCell}>
            {t("groupPage.investmentGlance.col.share")}
          </span>
          <span role="columnheader" className={cn(styles.num, styles.month)}>
            {t("groupPage.investmentGlance.col.month")}
          </span>
          <span role="columnheader" className={cn(styles.num, styles.year)}>
            {t("groupPage.investmentGlance.col.year")}
          </span>
          <span role="columnheader" className={cn(styles.num, styles.total)}>
            {t("groupPage.investmentGlance.col.total")}
          </span>
        </div>
        {glance && sparkView ? (
          <>
            <GlanceRow row={glance.total} color={totalColor} variant="total" sparkView={sparkView} />
            {glance.rows.map((row) => (
              <div key={rowKey(row)} role="rowgroup" className={styles.rowGroup}>
                {renderRow(row, 0, rowKey(row), null, sparkView)}
              </div>
            ))}
          </>
        ) : (
          <>
            <PendingRow label={title} total />
            {pendingLabels.map((label, i) => (
              <div key={i} role="rowgroup" className={styles.rowGroup}>
                <PendingRow label={label} />
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
