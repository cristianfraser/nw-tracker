import { useState } from "react";
import { readPref, writePref } from "../../usePersistedPref";
import { ChevronIcon } from "../ui/ChevronIcon";
import { ColorMarker } from "../ui/ColorMarker";
import { Link } from "react-router-dom";
import { cn } from "../../cn";
import { useTranslation } from "../../i18n";
import { formatMoney, formatPct } from "../../format";
import type { GroupGlanceCashDto, GroupGlanceDto, GroupGlanceRowDto, Money } from "../../types";
import {
  CompositionGroup,
  GlanceRail,
  GlanceTitleLine,
  PendingCompositionGroup,
  PeriodsGroup,
} from "../account/PositionGlance";
import { formatSignedMoney, formatSignedPct, pctOf } from "../account/positionGlanceLayout";
import { loadableClass } from "../ui/Loadable";
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

/** A row's display name: the server's label, or its i18n key translated at render. */
function useRowLabel(): (row: Pick<GroupGlanceRowDto, "label" | "label_i18n_key">) => string {
  const { t } = useTranslation();
  return (row) => (row.label_i18n_key ? t(row.label_i18n_key) : row.label);
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

/**
 * A child row starts open while it holds something and every row under it is a group (a group of
 * groups); one holding accounts — a basket, a leaf group, a group mixing accounts and sub-groups —
 * or a sold-out one starts closed. Same rule as the accounts tree.
 */
function openByDefault(row: GroupGlanceRowDto): boolean {
  return row.held && row.members.length > 0 && row.members.every((m) => m.kind === "group");
}

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

function rowKey(row: Pick<GroupGlanceRowDto, "kind" | "slug" | "account_id">): string {
  return row.kind === "account" ? `a:${row.account_id}` : row.kind === "group" ? `g:${row.slug}` : `c:${row.slug}`;
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

/** One line of the table: dot + name | sparkline | valor | peso | día | mes | año | total | aportes. */
function GlanceRow({
  row,
  color,
  variant,
  sparkView,
  caret,
}: {
  row: GroupGlanceRowDto;
  color: string;
  variant: "total" | "child" | "member";
  sparkView: SparkView;
  caret?: { open: boolean; onToggle: () => void };
}) {
  const { t } = useTranslation();
  const label = useRowLabel()(row);
  const sold = !row.held && variant !== "total";
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
        <Spark
          points={sparkView.mode === "perf" ? row.perf_spark : row.spark}
          zeroY={sparkView.mode === "perf" ? sparkView.zeroY : undefined}
          className={
            variant !== "total" ? styles.sparkChild : sparkView.mode === "perf" ? styles.sparkTotalPerf : undefined
          }
        />
      </span>
      <span role="cell" className={cn("mono", styles.num, styles.value)}>
        {formatMoney(row.value)}
      </span>
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
      <span role="cell" className={cn("mono", styles.num, styles.day, toneClass(row.day_pct))}>
        {!sold && row.day_pct != null ? formatSignedPct(row.day_pct) : "—"}
      </span>
      <span role="cell" className={cn("mono", styles.num, styles.month, toneClass(row.month_pct))}>
        {!sold && row.month_pct != null ? formatSignedPct(row.month_pct) : "—"}
      </span>
      <span role="cell" className={cn("mono", styles.num, styles.year, toneClass(row.year_pct))}>
        {!sold && row.year_pct != null ? formatSignedPct(row.year_pct) : "—"}
      </span>
      <span
        role="cell"
        className={cn("mono", styles.num, styles.total)}
        title={row.total_pct != null ? formatSignedPct(row.total_pct) : undefined}
      >
        <SignedMoney money={row.total_pl} />
      </span>
      <span role="cell" className={cn("mono", styles.num, styles.deposits)}>
        {row.deposits ? formatMoney(row.deposits) : "—"}
      </span>
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
      <span role="cell" className={cn(styles.num, styles.value)}>
        {BLANK}
      </span>
      <span role="cell" className={styles.shareCell} />
      <span role="cell" className={cn(styles.num, styles.day)} />
      <span role="cell" className={cn(styles.num, styles.month)} />
      <span role="cell" className={cn(styles.num, styles.year)} />
      <span role="cell" className={cn(styles.num, styles.total)} />
      <span role="cell" className={cn(styles.num, styles.deposits)} />
    </div>
  );
}

/**
 * The children table (server `group_glance`): the group's own row first, a hairline, then one
 * row per child heaviest first, a child group opening one level (its rows indented under a caret;
 * `openByDefault`, toggles kept per page), sold-out children last and muted. The sparkline column
 * draws each row's chained return on one shared scale (default) or its balance, one choice kept for
 * every group page. One row list at every width: a container query keeps
 * name, value, mes and total when narrow (no horizontal scroll). Each dot takes the child's chart
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
          <span role="columnheader" className={cn(styles.num, styles.value)}>
            {t("groupPage.investmentGlance.col.value")}
          </span>
          <span role="columnheader" className={styles.shareCell}>
            {t("groupPage.investmentGlance.col.share")}
          </span>
          <span role="columnheader" className={cn(styles.num, styles.day)}>
            {t("groupPage.investmentGlance.col.day")}
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
          <span role="columnheader" className={cn(styles.num, styles.deposits)}>
            {t("groupPage.investmentGlance.col.deposits")}
          </span>
        </div>
        {glance && sparkView ? (
          <>
            <GlanceRow row={glance.total} color={totalColor} variant="total" sparkView={sparkView} />
            {glance.rows.map((row) => {
              const key = rowKey(row);
              const color = colorFor(row);
              const hasMembers = row.members.length > 0;
              const open = rowOpen(row);
              return (
                <div key={key} role="rowgroup" className={styles.rowGroup}>
                  <GlanceRow
                    row={row}
                    color={color}
                    variant="child"
                    sparkView={sparkView}
                    caret={hasMembers ? { open, onToggle: () => toggle(key, open) } : undefined}
                  />
                  {hasMembers && open
                    ? row.members.map((m) => (
                        <GlanceRow
                          key={rowKey(m)}
                          row={m}
                          color={color}
                          variant="member"
                          sparkView={
                            sparkView.mode === "perf" && row.members_perf_zero_y != null
                              ? { mode: "perf", zeroY: row.members_perf_zero_y }
                              : sparkView
                          }
                        />
                      ))
                    : null}
                </div>
              );
            })}
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
