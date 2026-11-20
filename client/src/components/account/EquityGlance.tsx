import type { ReactNode } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "../../cn";
import { useTranslation } from "../../i18n";
import { formatInstrumentUnits, formatMoney, formatPct } from "../../format";
import { formatMonthShortLabel } from "../../formatDateLabel";
import type { AccountDetailBundleResponse, AccountPositionSnapshot, EquityGlanceDto, EquityGlancePeriodDto } from "../../types";
import { queryKeys } from "../../queries/keys";
import { loadableClass } from "../ui/Loadable";
import { HoverPopover } from "../ui/HoverPopover";
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
} from "./equityGlanceLayout";
import styles from "./EquityGlance.module.css";

const BLANK = " ";

/** The sparkline's drawing box (stretched to the rail's width; the stroke does not scale). */
const SPARK_W = 360;
const SPARK_H = 50;

/**
 * Which optional rows a stock account's glance has, remembered per account (`equity_glance_shape`)
 * so the page picks the stock page while its bundle is pending and the pending glance has the
 * loaded one's rows: the instrument name, the composition bar, the broker split.
 */
type EquityGlanceShape = { has_name: boolean; has_composition: boolean; brokers: number };

function isEquityGlanceShape(v: unknown): v is EquityGlanceShape {
  if (v == null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.has_name === "boolean" && typeof o.has_composition === "boolean" && typeof o.brokers === "number";
}

const EQUITY_GLANCE_SHAPE = persistedPayload<EquityGlanceShape>("equity_glance_shape", isEquityGlanceShape);

/** The guess for a stock this browser has not shown: a name, a composition bar, one broker. */
const GUESSED_SHAPE: EquityGlanceShape = { has_name: true, has_composition: true, brokers: 1 };

/**
 * What the client knows of an account's glance before its bundle is in: a glance react-query still
 * holds for it (another unit's bundle, this session), else the browser's stored shape. Null: no
 * sign it is a stock page (the standard page's frame stays until the bundle says).
 */
export function usePendingEquityGlanceShape(accountId: number): EquityGlanceShape | null {
  const queryClient = useQueryClient();
  if (accountId <= 0) return null;
  const held = queryClient
    .getQueriesData<AccountDetailBundleResponse>({ queryKey: queryKeys.accountDetailAll(String(accountId)) })
    .map(([, data]) => data)
    .find((d) => d?.equity_glance != null);
  if (held?.equity_glance) return shapeOf(held.equity_glance, held.summary.position?.brokers?.length ?? 0);
  return readPersistedPayload(EQUITY_GLANCE_SHAPE, [String(accountId)]) ?? null;
}

function shapeOf(glance: EquityGlanceDto, brokers: number): EquityGlanceShape {
  return { has_name: glance.name != null, has_composition: glance.composition != null, brokers };
}

/**
 * Remembers the account's glance shape once the bundle states it: a glance stores its rows, an
 * explicit null (not a stock page) drops the entry.
 */
export function useRememberEquityGlanceShape(
  accountId: number,
  glance: EquityGlanceDto | null | undefined,
  brokers: number
): void {
  const key = glance == null ? (glance === null ? "none" : null) : JSON.stringify(shapeOf(glance, brokers));
  useEffect(() => {
    if (accountId <= 0 || key == null) return;
    if (key === "none") removePersistedPayload(EQUITY_GLANCE_SHAPE, [String(accountId)]);
    else writePersistedPayload(EQUITY_GLANCE_SHAPE, [String(accountId)], JSON.parse(key) as EquityGlanceShape);
  }, [accountId, key]);
}

function toneClass(tone: "positive" | "negative" | "neutral"): string | undefined {
  return tone === "positive" ? styles.positive : tone === "negative" ? styles.negative : undefined;
}

function directionClass(direction: EquityGlancePeriodDto["direction"]): string | undefined {
  return direction === "up" ? styles.positive : direction === "down" ? styles.negative : undefined;
}

/** Today's price in a pill outline of its colour: green above the average cost, red below, text when equal. */
function PricePill({ glance, className }: { glance: EquityGlanceDto; className?: string }) {
  return (
    <span className={cn("mono", styles.pricePill, toneClass(priceTone(glance.price_vs_cost)), className)}>
      {formatMoney(glance.quote.price)}
    </span>
  );
}

/** «al cierre de NYSE» / «en vivo · NYSE». */
function useSessionLabel(): (quote: EquityGlanceDto["quote"]) => string {
  const { t } = useTranslation();
  return (quote) => {
    const market = t(`accountDetail.equityGlance.market.${quote.market_kind}`);
    return quote.session === "open"
      ? t("accountDetail.equityGlance.sessionOpen", { market })
      : t("accountDetail.equityGlance.sessionClosed", { market });
  };
}

/**
 * The stock page's title line: ticker, today's value and the day's P/L; under it the instrument's
 * name and today's price with its session (two rows on a phone). `glance` undefined = pending: the
 * title (from the nav) with blank figures, at the loaded height.
 */
export function EquityGlanceTitle({
  glance,
  fallbackTitle,
  pendingShape,
  loading = false,
}: {
  glance: EquityGlanceDto | undefined;
  /** Held prior-unit figures: they dim (the ticker does not). */
  loading?: boolean;
  /** The account's name while the glance is pending (the ticker, for a stock). */
  fallbackTitle: string;
  pendingShape: EquityGlanceShape | null;
}) {
  const { t } = useTranslation();
  const sessionLabel = useSessionLabel();
  const day = glance?.periods.day;
  const hasName = glance ? glance.name != null : (pendingShape ?? GUESSED_SHAPE).has_name;
  return (
    <div className={styles.titleBlock}>
      <div className={styles.titleLine}>
        <h1 className={styles.ticker}>{glance?.ticker ?? (fallbackTitle || BLANK)}</h1>
        <span className={loadableClass(loading, styles.titleFigures)}>
          <span className={cn("mono", styles.titleValue)}>{glance ? formatMoney(glance.value) : BLANK}</span>
          {day?.pl ? (
            <span className={cn("mono", styles.titleDay, directionClass(day.direction))} title={t("accountDetail.equityGlance.dayPl")}>
              {directionArrow(day.direction)}
              {formatMoney({ value: Math.abs(day.pl.value), currency: day.pl.currency })}
              {day.pct != null ? ` (${formatPct(Math.abs(day.pct) * 100)})` : null}
            </span>
          ) : null}
        </span>
      </div>
      <div className={loadableClass(loading, styles.sub)}>
        {hasName ? <span className={styles.subName}>{glance?.name ?? BLANK}</span> : null}
        {hasName ? (
          <span className={styles.subSep} aria-hidden="true">
            ·
          </span>
        ) : null}
        <span className={styles.subQuote}>
          {glance ? (
            <>
              <PricePill glance={glance} /> {sessionLabel(glance.quote)}
            </>
          ) : (
            BLANK
          )}
        </span>
      </div>
    </div>
  );
}

/** One group of the rail, hairlines between groups. */
function Group({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn(styles.group, className)}>{children}</div>;
}

/** a. Today's price, its change and the previous close; the price since first held under it. */
function QuoteGroup({ glance }: { glance: EquityGlanceDto }) {
  const { t } = useTranslation();
  const { quote, sparkline } = glance;
  const tone = toneClass(priceTone(glance.price_vs_cost));
  const last = sparkline.points[sparkline.points.length - 1];
  return (
    <Group>
      <div className={styles.quoteLine}>
        {quote.previous_close ? (
          <span className={styles.previous}>
            {t("accountDetail.equityGlance.previous")} <span className="mono">{formatMoney(quote.previous_close)}</span>
          </span>
        ) : null}
      </div>
      <div className={styles.spark}>
        <svg
          viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={t("accountDetail.equityGlance.sparkline", { ticker: glance.ticker })}
        >
          <line
            className={styles.sparkCost}
            x1={0}
            x2={SPARK_W}
            y1={(1 - sparkline.cost_y) * SPARK_H}
            y2={(1 - sparkline.cost_y) * SPARK_H}
            vectorEffect="non-scaling-stroke"
          />
          <polyline
            className={styles.sparkLine}
            points={sparklinePoints(sparkline.points, SPARK_W, SPARK_H)}
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        {last ? <i className={cn(styles.sparkDot, tone)} style={{ top: `${(1 - last.y) * SPARK_H}px` }} /> : null}
        <div className={cn("mono", styles.sparkLabels)}>
          <span>{formatMonthShortLabel(sparkline.first_date)}</span>
          <span>{formatMonthShortLabel(sparkline.last_date)}</span>
        </div>
      </div>
    </Group>
  );
}

/** b. The average cost, today's price and the highest close on one track. */
function TrackGroup({ glance }: { glance: EquityGlanceDto }) {
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
            ariaLabel={t("accountDetail.equityGlance.high")}
            className={styles.highTrigger}
            trigger={<i className={cn(styles.tick, styles.tickHigh)} />}
          >
            <span className={styles.highTip}>
              {t("accountDetail.equityGlance.high")} <span className="mono">{formatMoney(track.high.price)}</span>
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

/** c. Today's value as deposited + price + dividends, to scale, with their amounts under it. */
function CompositionGroup({ composition }: { composition: NonNullable<EquityGlanceDto["composition"]> }) {
  const { t } = useTranslation();
  const flow = composition.segments.filter((s) => s.kind !== "loss");
  const loss = composition.segments.find((s) => s.kind === "loss");
  const hasPrice = composition.segments.some((s) => s.kind === "price" || s.kind === "loss");
  const hasDividends = composition.segments.some((s) => s.kind === "dividends");
  return (
    <Group>
      <div className={styles.bracket}>
        <i style={{ left: 0, width: pctOf(composition.value_share) }} />
        <span style={{ left: pctOf(composition.value_share / 2) }}>{t("accountDetail.equityGlance.valueToday")}</span>
      </div>
      <div className={styles.compBar}>
        {flow.map((s) => (
          <span key={s.kind} className={styles[`seg_${s.kind}`]} style={{ width: pctOf(s.share) }} />
        ))}
        {loss ? (
          <span className={styles.seg_loss} style={{ left: pctOf(loss.start), width: pctOf(loss.share) }} />
        ) : null}
      </div>
      <div className={styles.compLabels}>
        <span>
          <em>{t("accountDetail.equityGlance.deposited")}</em>
          <b className="mono">{formatMoney(composition.deposited)}</b>
        </span>
        <span className={styles.spacer} />
        {hasPrice ? (
          <span className={styles.labelRight}>
            <em>{t("accountDetail.equityGlance.price")}</em>
            <b className={cn("mono", directionClass(composition.price_direction))}>{formatSignedMoney(composition.price)}</b>
          </span>
        ) : null}
        {hasDividends ? (
          <span className={styles.labelRight}>
            <em>{t("accountDetail.equityGlance.dividends")}</em>
            <b className={cn("mono", styles.dividends)}>{formatSignedMoney(composition.dividends)}</b>
          </span>
        ) : null}
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
function PeriodsGroup({ periods }: { periods: EquityGlanceDto["periods"] | null }) {
  const { t } = useTranslation();
  const rows = [
    { key: "day", label: t("accountDetail.equityGlance.day"), period: periods?.day },
    { key: "month", label: t("accountDetail.equityGlance.month"), period: periods?.month },
    { key: "year", label: t("accountDetail.equityGlance.year"), period: periods?.year },
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
function PendingRail({ shape }: { shape: EquityGlanceShape }) {
  return (
    <>
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
      <Group>
        <div className={styles.track}>
          <div className={styles.trackBar} />
        </div>
      </Group>
      {shape.has_composition ? (
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
      ) : null}
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
 * The stock page's rail (server `equity_glance`, `equityGlance.ts`): the quote with the price since
 * first held, the price track, the composition of today's value, the broker split when the ticker
 * is held through two or more, and the día / mes / año bars. `glance` undefined while the page data
 * is pending (the frames with blank figures, dimmed by the page).
 */
export function EquityGlanceRail({
  glance,
  position,
  pendingShape,
}: {
  glance: EquityGlanceDto | undefined;
  position: AccountPositionSnapshot | null;
  pendingShape: EquityGlanceShape | null;
}) {
  if (!glance) return <div className={styles.rail}><PendingRail shape={pendingShape ?? GUESSED_SHAPE} /></div>;
  return (
    <div className={styles.rail}>
      <QuoteGroup glance={glance} />
      <TrackGroup glance={glance} />
      {glance.composition ? <CompositionGroup composition={glance.composition} /> : null}
      {position && (position.brokers?.length ?? 0) >= 2 ? <BrokersGroup position={position} /> : null}
      <PeriodsGroup periods={glance.periods} />
    </div>
  );
}

export type { EquityGlanceShape };
