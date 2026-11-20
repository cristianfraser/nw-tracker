import type { ReactNode } from "react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "../../cn";
import { useTranslation } from "../../i18n";
import { formatInstrumentUnits, formatMoney, formatPct } from "../../format";
import { formatDayMonthShortLabel, formatMonthYearShortLabel } from "../../formatDateLabel";
import type {
  AccountDetailBundleResponse,
  AccountPositionSnapshot,
  PositionGlanceBasketDto,
  PositionGlanceDto,
  PositionGlancePeriodDto,
  PositionGlanceSegmentDto,
  PositionGlanceSparkRange,
} from "../../types";
import { queryKeys } from "../../queries/keys";
import { loadableClass } from "../ui/Loadable";
import { HoverPopover } from "../ui/HoverPopover";
import { SurfaceControls } from "../ui/SurfaceControls";
import { useSurfacePrefs } from "../../surfaceDisplayPrefs";
import {
  persistedPayload,
  readPersistedPayload,
  removePersistedPayload,
  writePersistedPayload,
} from "../../queries/persistedPayloadCache";
import {
  directionArrow,
  formatSignedMoney,
  formatSignedPct,
  pctOf,
  periodBarBox,
  priceTone,
  sparklinePoints,
  centredLabelLeft,
  fundSeriesLabel,
} from "./positionGlanceLayout";
import styles from "./PositionGlance.module.css";

const BLANK = " ";

/** The sparkline's drawing box (stretched to the rail's width; the stroke does not scale). */
const SPARK_W = 360;
const SPARK_H = 50;

/**
 * Which optional rows a unit position's glance has, remembered per account (`position_glance_shape`)
 * so the page picks the unit-position page while its bundle is pending and the pending glance has
 * the loaded one's rows: the sub-line's name, the fund's basket, the composition bar, the broker split.
 */
type PositionGlanceShape = { has_name: boolean; has_composition: boolean; basket_rows: number; brokers: number };

function isPositionGlanceShape(v: unknown): v is PositionGlanceShape {
  if (v == null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.has_name === "boolean" &&
    typeof o.has_composition === "boolean" &&
    typeof o.basket_rows === "number" &&
    typeof o.brokers === "number"
  );
}

const POSITION_GLANCE_SHAPE = persistedPayload<PositionGlanceShape>("position_glance_shape", isPositionGlanceShape);

/** The guess for a position this browser has not shown: a name, a composition bar, one broker, no basket. */
const GUESSED_SHAPE: PositionGlanceShape = { has_name: true, has_composition: true, basket_rows: 0, brokers: 1 };

/**
 * What the client knows of an account's glance before its bundle is in: a glance react-query still
 * holds for it (another unit's bundle, this session), else the browser's stored shape. Null: no
 * sign it is a unit-position page (the standard page's frame stays until the bundle says).
 */
export function usePendingPositionGlanceShape(accountId: number): PositionGlanceShape | null {
  const queryClient = useQueryClient();
  if (accountId <= 0) return null;
  const held = queryClient
    .getQueriesData<AccountDetailBundleResponse>({ queryKey: queryKeys.accountDetailAll(String(accountId)) })
    .map(([, data]) => data)
    .find((d) => d?.position_glance != null);
  if (held?.position_glance) return shapeOf(held.position_glance, held.summary.position?.brokers?.length ?? 0);
  return readPersistedPayload(POSITION_GLANCE_SHAPE, [String(accountId)]) ?? null;
}

function shapeOf(glance: PositionGlanceDto, brokers: number): PositionGlanceShape {
  return {
    // A fund's series is always worded; a market instrument's registry name may be missing.
    has_name: glance.instrument.kind === "fund" || glance.instrument.name != null,
    has_composition: glance.composition != null,
    basket_rows: glance.basket?.rows.length ?? 0,
    brokers,
  };
}

/** The sub-line's name: a market instrument's registry name (null when none), a fund's series worded. */
function useInstrumentName(): (glance: PositionGlanceDto) => string | null {
  const { t } = useTranslation();
  return (glance) =>
    glance.instrument.kind === "market" ? glance.instrument.name : fundSeriesLabel(glance.instrument.series, t);
}

/**
 * Remembers the account's glance shape once the bundle states it: a glance stores its rows, an
 * explicit null (not a unit position) drops the entry.
 */
export function useRememberPositionGlanceShape(
  accountId: number,
  glance: PositionGlanceDto | null | undefined,
  brokers: number
): void {
  const key = glance == null ? (glance === null ? "none" : null) : JSON.stringify(shapeOf(glance, brokers));
  useEffect(() => {
    if (accountId <= 0 || key == null) return;
    if (key === "none") removePersistedPayload(POSITION_GLANCE_SHAPE, [String(accountId)]);
    else writePersistedPayload(POSITION_GLANCE_SHAPE, [String(accountId)], JSON.parse(key) as PositionGlanceShape);
  }, [accountId, key]);
}

function toneClass(tone: "positive" | "negative" | "neutral"): string | undefined {
  return tone === "positive" ? styles.positive : tone === "negative" ? styles.negative : undefined;
}

function directionClass(direction: PositionGlancePeriodDto["direction"]): string | undefined {
  return direction === "up" ? styles.positive : direction === "down" ? styles.negative : undefined;
}

/** Today's price in a pill outline of its colour: green above the average cost, red below, text when equal. */
export function PricePill({
  price,
  priceVsCost,
  className,
}: {
  price: { value: number; currency: string };
  priceVsCost: PositionGlanceDto["price_vs_cost"];
  className?: string;
}) {
  return (
    <span className={cn("mono", styles.pricePill, toneClass(priceTone(priceVsCost)), className)}>
      {formatMoney(price)}
    </span>
  );
}

/**
 * What today's price is: a market's session («al cierre de NYSE» / «en vivo · NYSE»), a fund's
 * publication day («al 2026-11-19») or the proxy's estimate («estimado»).
 */
function useSessionLabel(): (glance: PositionGlanceDto) => string {
  const { t } = useTranslation();
  return (glance) => {
    const quote = glance.instrument;
    if (quote.kind === "fund") {
      return quote.price_source === "proxy"
        ? t("accountDetail.positionGlance.fundEstimated")
        : t("accountDetail.positionGlance.fundAsOf", { date: quote.published_on });
    }
    const market = t(`accountDetail.positionGlance.market.${quote.market_kind}`);
    return quote.session === "open"
      ? t("accountDetail.positionGlance.sessionOpen", { market })
      : t("accountDetail.positionGlance.sessionClosed", { market });
  };
}

/**
 * The unit-position page's title line: ticker (a fund: its account name), today's value and the
 * day's P/L; under it the instrument's name (a fund: its series) and today's price with its session
 * or publication day (two rows on a phone). `glance` undefined = pending: the
 * title (from the nav) with blank figures, at the loaded height.
 */
export function PositionGlanceTitle({
  glance,
  fallbackTitle,
  pendingShape,
  loading = false,
}: {
  glance: PositionGlanceDto | undefined;
  /** Held prior-unit figures: they dim (the ticker does not). */
  loading?: boolean;
  /** The account's name while the glance is pending (the ticker, for a stock). */
  fallbackTitle: string;
  pendingShape: PositionGlanceShape | null;
}) {
  const sessionLabel = useSessionLabel();
  const instrumentName = useInstrumentName();
  const name = glance ? instrumentName(glance) : null;
  const hasName = glance ? name != null : (pendingShape ?? GUESSED_SHAPE).has_name;
  return (
    <GlanceTitleLine
      title={glance?.title ?? fallbackTitle}
      value={glance?.value ?? null}
      day={glance?.periods.day ?? null}
      loading={loading}
    >
      <div className={loadableClass(loading, styles.sub)}>
        {hasName ? <span className={styles.subName}>{name ?? BLANK}</span> : null}
        {hasName ? (
          <span className={styles.subSep} aria-hidden="true">
            ·
          </span>
        ) : null}
        <span className={styles.subQuote}>
          {glance ? (
            <>
              <PricePill price={glance.quote.price} priceVsCost={glance.price_vs_cost} /> {sessionLabel(glance)}
            </>
          ) : (
            BLANK
          )}
        </span>
      </div>
    </GlanceTitleLine>
  );
}

/**
 * A glance page's title line (a unit position's, a basket's): the name, today's value and the
 * day's P/L ▲/▼ with its %; `children` is the sub-line under it, if any. `value` null = pending
 * (blank figures at the loaded height).
 */
export function GlanceTitleLine({
  title,
  value,
  day,
  loading = false,
  children,
}: {
  title: string;
  value: { value: number; currency: string } | null;
  day: PositionGlancePeriodDto | null;
  /** Held or pending figures dim (the name does not). */
  loading?: boolean;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className={styles.titleBlock}>
      <div className={styles.titleLine}>
        <h1 className={styles.ticker}>{title || BLANK}</h1>
        <span className={loadableClass(loading, styles.titleFigures)}>
          <span className={cn("mono", styles.titleValue)}>{value ? formatMoney(value) : BLANK}</span>
          {day?.pl ? (
            <span className={cn("mono", styles.titleDay, directionClass(day.direction))} title={t("accountDetail.positionGlance.dayPl")}>
              {directionArrow(day.direction)}
              {formatMoney({ value: Math.abs(day.pl.value), currency: day.pl.currency })}
              {day.pct != null ? ` (${formatPct(Math.abs(day.pct) * 100)})` : null}
            </span>
          ) : null}
        </span>
      </div>
      {children}
    </div>
  );
}

/** One group of the rail, hairlines between groups. */
export function GlanceGroup({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn(styles.group, className)}>{children}</div>;
}

const Group = GlanceGroup;

/** The rail's column of groups (beside the valuation chart on a desktop, under it on a phone). */
export function GlanceRail({ children }: { children: ReactNode }) {
  return <div className={styles.rail}>{children}</div>;
}

/** Ranges up to 90 days label their axis ends by day («nov 13»), longer ones by month and year («nov 25»). */
const DAY_LABEL_RANGES: ReadonlySet<string> = new Set(["30d", "60d", "90d"]);

/** One range of a glance sparkline: a unit price's (`PositionGlanceSparklineDto`) or a basket index's. */
export type GlanceSparkline = {
  range: PositionGlanceSparkRange;
  from: string;
  to: string;
  points: readonly { x: number; y: number }[];
  /** The dotted cost line's height (0..1); null: none drawn. */
  cost_y: number | null;
  held: readonly { start: number; end: number }[];
};

/**
 * A line over the chosen range (its own compact range row, default a year, remembered under
 * `surfaceId`): the axis always spans the whole range, the history placed by day, faint outside
 * the held stretches; the dotted line is the cost, the dot today's point in `tone`.
 */
export function GlanceSparklineGroup({
  surfaceId,
  lines,
  tone,
  ariaLabel,
}: {
  surfaceId: string;
  lines: readonly GlanceSparkline[];
  tone: "positive" | "negative" | "neutral";
  ariaLabel: string;
}) {
  const prefs = useSurfacePrefs(surfaceId, "day", "1y");
  const line = lines.find((l) => l.range === prefs.range);
  if (!line) throw new Error(`glance: no sparkline for range ${prefs.range}`);
  const toneCls = toneClass(tone);
  const last = line.points[line.points.length - 1];
  const label = DAY_LABEL_RANGES.has(line.range) ? formatDayMonthShortLabel : formatMonthYearShortLabel;
  // The whole line dimmed, the stretches held drawn again over it through a clip of the server's spans.
  const clipId = `spark-held-${useId().replace(/:/g, "")}`;
  const linePoints = sparklinePoints(line.points, SPARK_W, SPARK_H);
  return (
    <Group>
      <div className={styles.quoteLine}>
        <SurfaceControls range={prefs.range} onRangeChange={prefs.setRange} compact />
      </div>
      <div className={styles.spark}>
        <svg viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} preserveAspectRatio="none" role="img" aria-label={ariaLabel}>
          {line.cost_y != null ? (
            <line
              className={styles.sparkCost}
              x1={0}
              x2={SPARK_W}
              y1={(1 - line.cost_y) * SPARK_H}
              y2={(1 - line.cost_y) * SPARK_H}
              vectorEffect="non-scaling-stroke"
            />
          ) : null}
          <defs>
            <clipPath id={clipId}>
              {line.held.map((h) => (
                <rect key={h.start} x={h.start * SPARK_W} y={-2} width={(h.end - h.start) * SPARK_W} height={SPARK_H + 4} />
              ))}
            </clipPath>
          </defs>
          <polyline
            className={cn(styles.sparkLine, styles.sparkLineUnheld)}
            points={linePoints}
            vectorEffect="non-scaling-stroke"
          />
          <polyline
            className={styles.sparkLine}
            points={linePoints}
            clipPath={`url(#${clipId})`}
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        {last ? (
          <i
            className={cn(styles.sparkDot, toneCls)}
            style={{ left: pctOf(last.x), top: `${(1 - last.y) * SPARK_H}px` }}
          />
        ) : null}
        <div className={cn("mono", styles.sparkLabels)}>
          <span>{label(line.from)}</span>
          <span>{label(line.to)}</span>
        </div>
      </div>
    </Group>
  );
}

/** a. The instrument's price since first held; the dotted line is the average cost. */
function QuoteGroup({ glance, accountId }: { glance: PositionGlanceDto; accountId: number }) {
  const { t } = useTranslation();
  return (
    <GlanceSparklineGroup
      surfaceId={`account.${accountId}.sparkline`}
      lines={glance.sparklines}
      tone={priceTone(glance.price_vs_cost)}
      ariaLabel={t("accountDetail.positionGlance.sparkline", { ticker: glance.title })}
    />
  );
}

/** b. The average cost, today's price and the highest close on one track. */
function TrackGroup({ glance }: { glance: PositionGlanceDto }) {
  const { t } = useTranslation();
  const { track } = glance;
  const tone = toneClass(priceTone(glance.price_vs_cost));
  // Today's price above the track and the cost below it, each centred on its own tick
  // (`centredLabelLeft`), placed in px from the measured widths.
  const trackRef = useRef<HTMLDivElement>(null);
  const priceRef = useRef<HTMLSpanElement>(null);
  const costRef = useRef<HTMLSpanElement>(null);
  const [place, setPlace] = useState<{ priceLeft: number; costLeft: number } | null>(null);
  useLayoutEffect(() => {
    const box = trackRef.current;
    if (!box) return;
    const measure = () => {
      const price = priceRef.current;
      const cost = costRef.current;
      if (!price || !cost) return;
      setPlace({
        priceLeft: centredLabelLeft(track.price.share, box.clientWidth, price.offsetWidth),
        costLeft: centredLabelLeft(track.cost.share, box.clientWidth, cost.offsetWidth),
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    return () => ro.disconnect();
  }, [track.price.share, track.cost.share, track.price.price.value, track.cost.price.value]);
  return (
    <Group>
      <div className={styles.track} ref={trackRef}>
        <div className={styles.trackBar} />
        {track.fill.side !== "none" ? (
          <div
            className={cn(styles.trackFill, track.fill.side === "gain" ? styles.fillGain : styles.fillLoss)}
            style={{ left: pctOf(track.fill.start), width: pctOf(track.fill.end - track.fill.start) }}
          />
        ) : null}
        <span
          ref={costRef}
          className={cn(styles.trackLabel, styles.trackDown)}
          style={place ? { left: place.costLeft } : { visibility: "hidden" }}
        >
          <span className="mono">{formatMoney(track.cost.price)}</span>
        </span>
        <span
          ref={priceRef}
          className={cn(styles.trackLabel, styles.trackUp)}
          style={place ? { left: place.priceLeft } : { visibility: "hidden" }}
        >
          <span className={cn("mono", styles.pricePill, tone)}>{formatMoney(track.price.price)}</span>
        </span>
        <i className={styles.tick} style={{ left: pctOf(track.cost.share) }} />
        <span className={styles.highAnchor} style={{ left: pctOf(track.high.share) }}>
          <HoverPopover
            ariaLabel={t("accountDetail.positionGlance.high")}
            className={styles.highTrigger}
            trigger={<i className={cn(styles.tick, styles.tickHigh)} />}
          >
            <span className={styles.highTip}>
              {t("accountDetail.positionGlance.high")} <span className="mono">{formatMoney(track.high.price)}</span>
              <span className="mono">
                {" · "}
                {track.high.date} · {formatSignedPct(track.high.pct_from_high, 1)}
              </span>
            </span>
          </HoverPopover>
        </span>
        <i className={cn(styles.tick, styles.tickNow, tone)} style={{ left: pctOf(track.price.share) }} />
      </div>
    </Group>
  );
}

/** Each composition segment's fill (every kind the DTO lists; a new kind is a compile error here). */
const SEGMENT_CLASS: Record<PositionGlanceSegmentDto["kind"], string | undefined> = {
  deposited: styles.seg_deposited,
  state_bonus: styles.seg_state_bonus,
  price: styles.seg_price,
  dividends: styles.seg_dividends,
  loss: styles.seg_loss,
  withdrawn: styles.seg_withdrawn,
};

/** The segments drawn over the bar's tail at the server's positions (the rest flow left to right). */
const OVERLAY_KINDS: ReadonlySet<PositionGlanceSegmentDto["kind"]> = new Set(["loss", "withdrawn"]);

/**
 * c. Today's value as deposited + state bonus + price + dividends, to scale, with their amounts
 * under it (the capital pieces at the left, the results at the right).
 */
export function CompositionGroup({ composition }: { composition: NonNullable<PositionGlanceDto["composition"]> }) {
  const { t } = useTranslation();
  const flow = composition.segments.filter((s) => !OVERLAY_KINDS.has(s.kind));
  const overlays = composition.segments.filter((s) => OVERLAY_KINDS.has(s.kind));
  const has = (kind: PositionGlanceSegmentDto["kind"]) => composition.segments.some((s) => s.kind === kind);
  const hasPrice = has("price") || has("loss");
  return (
    <Group>
      <div className={styles.bracket}>
        <i style={{ left: 0, width: pctOf(composition.value_share) }} />
        <span style={{ left: pctOf(composition.value_share / 2) }}>
          {composition.is_today
            ? t("accountDetail.positionGlance.valueToday")
            : t("accountDetail.positionGlance.valueOn", { date: composition.as_of })}
        </span>
      </div>
      <div className={styles.compBar}>
        {flow.map((s) => (
          <span key={s.kind} className={SEGMENT_CLASS[s.kind]} style={{ width: pctOf(s.share) }} />
        ))}
        {overlays.map((s) => (
          <span key={s.kind} className={SEGMENT_CLASS[s.kind]} style={{ left: pctOf(s.start), width: pctOf(s.share) }} />
        ))}
      </div>
      <div className={styles.compLabels}>
        {/* Net capital: «depositado», or «retirado neto» once more came out than went in (the overlay). */}
        <span>
          <em>
            {has("withdrawn")
              ? t("accountDetail.positionGlance.withdrawn")
              : t("accountDetail.positionGlance.deposited")}
          </em>
          <b className="mono">{formatMoney(composition.deposited)}</b>
        </span>
        {has("state_bonus") && composition.state_bonus ? (
          <span className={styles.labelNext}>
            <em>{t("accountDetail.positionGlance.stateBonus")}</em>
            <b className={cn("mono", styles.stateBonus)}>{formatMoney(composition.state_bonus)}</b>
          </span>
        ) : null}
        <span className={styles.spacer} />
        {hasPrice ? (
          <span className={styles.labelRight}>
            <em>{t("accountDetail.positionGlance.price")}</em>
            <b className={cn("mono", directionClass(composition.price_direction))}>{formatSignedMoney(composition.price)}</b>
          </span>
        ) : null}
        {has("dividends") ? (
          <span className={styles.labelRight}>
            <em>{t("accountDetail.positionGlance.dividends")}</em>
            <b className={cn("mono", styles.dividends)}>{formatSignedMoney(composition.dividends)}</b>
          </span>
        ) : null}
      </div>
    </Group>
  );
}

/**
 * A proxy-priced fund's basket: the ETFs it states, heaviest first, then its non-ETF rest («Otros»)
 * — ticker and name, a thin bar at its share of the fund, the % and that share of today's value.
 */
function BasketGroup({ basket }: { basket: PositionGlanceBasketDto }) {
  const { t } = useTranslation();
  return (
    <Group>
      <div className={styles.basketHead}>
        <span>{t("accountDetail.positionGlance.basket.title")}</span>
        <span className="mono">{t("accountDetail.positionGlance.basket.asOf", { date: basket.positions_date })}</span>
      </div>
      <div className={styles.basket}>
        {basket.rows.map((row) => (
          <div key={row.kind === "holding" ? row.ticker : "other"} className={styles.basketRow}>
            <span className={styles.basketName}>
              {row.kind === "holding" ? (
                <>
                  <span className="mono">{row.ticker}</span>
                  {row.name ? <span className={styles.basketFull}>{row.name}</span> : null}
                </>
              ) : (
                <span className={styles.basketOther}>{t("accountDetail.positionGlance.basket.other")}</span>
              )}
            </span>
            <span className={styles.basketBar}>
              <i className={row.kind === "other" ? styles.basketBarOther : undefined} style={{ width: pctOf(row.share) }} />
            </span>
            <span className="mono">{formatPct(row.share * 100, 1)}</span>
            <span className="mono">{formatMoney(row.value)}</span>
          </div>
        ))}
      </div>
    </Group>
  );
}

/** The ticker held through more than one cash account (broker): the shares by account. */
function BrokersGroup({ position }: { position: AccountPositionSnapshot }) {
  const { t } = useTranslation();
  const brokers = position.brokers ?? [];
  return (
    <Group>
      <div className={styles.brokersTitle} title={t("accountDetail.brokerHoldings.hint")}>
        {t("accountDetail.brokerHoldings.title")}
      </div>
      <div className={styles.brokers}>
        {brokers.map((h) => (
          <div key={h.cash_account_id ?? "none"} className={styles.brokerRow}>
            <span className={styles.brokerName}>{h.cash_account_name ?? t("accountDetail.brokerHoldings.noCashAccount")}</span>
            <span className="mono">{formatInstrumentUnits(h.units, position.units_kind ?? "shares")}</span>
            <span className="mono">{formatPct(h.share * 100)}</span>
            <span className="mono">{h.value != null ? formatMoney({ value: h.value, currency: position.unit }) : null}</span>
          </div>
        ))}
      </div>
    </Group>
  );
}

/** d. Día / mes / año: a zero-centred bar each, the P/L and its %. */
export function PeriodsGroup({ periods }: { periods: PositionGlanceDto["periods"] | null }) {
  const { t } = useTranslation();
  const rows = [
    { key: "day", label: t("accountDetail.positionGlance.day"), period: periods?.day },
    { key: "month", label: t("accountDetail.positionGlance.month"), period: periods?.month },
    { key: "year", label: t("accountDetail.positionGlance.year"), period: periods?.year },
  ];
  return (
    <Group className={styles.groupLast}>
      <div className={styles.periods}>
        {rows.map(({ key, label, period }) => {
          const box = period ? periodBarBox(period) : null;
          return (
            <div key={key} className={styles.periodRow}>
              <em>{label}</em>
              <div className={styles.thin}>
                {box && period ? <i className={directionClass(period.direction)} style={box} /> : null}
              </div>
              <span className={cn("mono", styles.periodAmount, period && directionClass(period.direction))}>
                {period?.pl
                  ? `${directionArrow(period.direction, true)}${formatMoney({ value: Math.abs(period.pl.value), currency: period.pl.currency })}`
                  : BLANK}
              </span>
              <span className={cn("mono", styles.periodPct)}>
                {period?.pct != null ? formatSignedPct(period.pct) : BLANK}
              </span>
            </div>
          );
        })}
      </div>
    </Group>
  );
}

/** The groups while the bundle is pending: their frames with blank text, at the loaded size. */
/** The sparkline group's frame while its data is pending (blank, at the loaded size). */
export function PendingSparklineGroup() {
  return (
    <Group>
      <div className={styles.quoteLine}>
        <span className="mono">{BLANK}</span>
      </div>
      <div className={styles.spark}>
        <svg viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} preserveAspectRatio="none" aria-hidden="true" />
        <div className={cn("mono", styles.sparkLabels)}>
          <span>{BLANK}</span>
        </div>
      </div>
    </Group>
  );
}

/** The composition group's frame while its data is pending. */
export function PendingCompositionGroup() {
  return (
    <Group>
      <div className={styles.bracket} />
      <div className={styles.compBar} />
      <div className={styles.compLabels}>
        <span>
          <em>{BLANK}</em>
          <b className="mono">{BLANK}</b>
        </span>
      </div>
    </Group>
  );
}

function PendingRail({ shape }: { shape: PositionGlanceShape }) {
  return (
    <>
      <PendingSparklineGroup />
      <Group>
        <div className={styles.track}>
          <div className={styles.trackBar} />
        </div>
      </Group>
      {shape.basket_rows > 0 ? (
        <Group>
          <div className={styles.basketHead}>
            <span>{BLANK}</span>
          </div>
          <div className={styles.basket}>
            {Array.from({ length: shape.basket_rows }, (_, i) => (
              <div key={i} className={styles.basketRow}>
                <span>{BLANK}</span>
              </div>
            ))}
          </div>
        </Group>
      ) : null}
      {shape.has_composition ? <PendingCompositionGroup /> : null}
      {shape.brokers >= 2 ? (
        <Group>
          <div className={styles.brokersTitle}>{BLANK}</div>
          <div className={styles.brokers}>
            {Array.from({ length: shape.brokers }, (_, i) => (
              <div key={i} className={styles.brokerRow}>
                <span>{BLANK}</span>
              </div>
            ))}
          </div>
        </Group>
      ) : null}
      <PeriodsGroup periods={null} />
    </>
  );
}

/**
 * The unit-position page's rail (server `position_glance`, `positionGlance.ts`): the unit price
 * since first held, the price track, a proxy-priced fund's basket, the composition of today's
 * value, the broker split when the ticker is held through two or more, and the día / mes / año bars. `glance` undefined while the page data
 * is pending (the frames with blank figures, dimmed by the page).
 */
export function PositionGlanceRail({
  accountId,
  glance,
  position,
  pendingShape,
}: {
  accountId: number;
  glance: PositionGlanceDto | undefined;
  position: AccountPositionSnapshot | null;
  pendingShape: PositionGlanceShape | null;
}) {
  if (!glance) return <div className={styles.rail}><PendingRail shape={pendingShape ?? GUESSED_SHAPE} /></div>;
  return (
    <div className={styles.rail}>
      <QuoteGroup glance={glance} accountId={accountId} />
      <TrackGroup glance={glance} />
      {glance.basket ? <BasketGroup basket={glance.basket} /> : null}
      {glance.composition ? <CompositionGroup composition={glance.composition} /> : null}
      {position && (position.brokers?.length ?? 0) >= 2 ? <BrokersGroup position={position} /> : null}
      <PeriodsGroup periods={glance.periods} />
    </div>
  );
}

export type { PositionGlanceShape };
