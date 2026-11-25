import { useState } from "react";
import { readPref, writePref } from "../../usePersistedPref";
import { ChevronIcon } from "../ui/ChevronIcon";
import { ColorMarker } from "../ui/ColorMarker";
import { Link } from "react-router-dom";
import { cn } from "../../cn";
import { useTranslation } from "../../i18n";
import { formatMoney, formatPct } from "../../format";
import type { GroupGlanceDto, GroupGlanceRowDto, Money } from "../../types";
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
 * The investment group page's title line: the group's name, today's value and the day's P/L
 * (server `group_glance`). `glance` undefined = pending: the nav's name, blank figures.
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
  return (
    <GlanceTitleLine
      title={glance?.title ?? fallbackTitle}
      value={glance?.value ?? null}
      day={glance?.day ?? null}
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
 * The strip under the band: the «valor hoy» composition bar (the position page's, summed over the
 * group's members by the server) | the día / mes / año bars. Pending: their frames.
 */
export function GroupGlanceStrip({ glance }: { glance: GroupGlanceDto | undefined }) {
  return (
    <>
      <div className={styles.stripComposition}>
        <GlanceRail>
          {glance ? (
            glance.composition ? (
              <CompositionGroup composition={glance.composition} />
            ) : null
          ) : (
            <PendingCompositionGroup />
          )}
        </GlanceRail>
      </div>
      <div className={styles.stripPeriods}>
        <GlanceRail>
          <PeriodsGroup periods={glance?.periods ?? null} />
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
  return row.kind === "group" ? `g:${row.slug}` : `a:${row.account_id}`;
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
function PendingRow({ label, total = false }: { label: string; total?: boolean }) {
  return (
    <div role="row" className={cn(styles.row, total && styles.totalRow)}>
      <span role="cell" className={styles.nameCell}>
        <span className={styles.caretSpace} />
        <span className={cn(styles.dot, styles.dotPending)} />
        <span className={styles.name}>{label || BLANK}</span>
      </span>
      <span role="cell" className={styles.sparkCell} />
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
 */
export function GroupGlanceTable({
  glance,
  title,
  pendingLabels,
  colorFor,
  totalColor,
  loading = false,
}: {
  glance: GroupGlanceDto | undefined;
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
              const open = hasMembers && (openChoices[key] ?? openByDefault(row));
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
