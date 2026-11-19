import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CcGlanceCupoBar } from "../charts/lazyCharts";
import type { CcGlanceCupoBarSegment } from "../charts/CcGlanceCupoBar";
import { useTranslation } from "../../i18n";
import { currencyFormatInfo, formatGroupedDecimal, formatMoney } from "../../format";
import { formatMonthShortLabel, formatYearMonthLabel } from "../../formatDateLabel";
import type {
  AccountDetailBundleResponse,
  CcGlanceAmountDto,
  CcGlanceDto,
  CcGlanceSegmentDto,
  CcGlanceSideDto,
} from "../../types";
import { queryKeys } from "../../queries/keys";
import { persistedPayload, readPersistedPayload, writePersistedPayload } from "../../queries/persistedPayloadCache";
import styles from "./CreditCardGlance.module.css";

/** Percent of the bar for a server share (layout only). */
const pct = (share: number): string => `${share * 100}%`;

/** A count of days as copy: «hoy», «en N días», «hace N días». */
function useDaysLabel(): (days: number) => string {
  const { t } = useTranslation();
  return (days) => {
    if (days === 0) return t("accountDetail.creditCard.glance.today");
    if (days === 1) return t("accountDetail.creditCard.glance.inOneDay");
    if (days > 1) return t("accountDetail.creditCard.glance.inDays", { n: days });
    if (days === -1) return t("accountDetail.creditCard.glance.oneDayAgo");
    return t("accountDetail.creditCard.glance.daysAgo", { n: -days });
  };
}

/** Amounts in their own currencies joined by « + », the billing currency plain and the others in the accent colour. */
function AmountsJoined({ amounts, billing }: { amounts: readonly CcGlanceAmountDto[]; billing: string }) {
  return (
    <>
      {amounts.map((a, i) => (
        <Fragment key={a.currency}>
          {i > 0 ? " + " : null}
          <span className={a.currency === billing ? undefined : styles.foreign}>
            {formatMoney({ value: a.amount, currency: a.currency })}
          </span>
        </Fragment>
      ))}
    </>
  );
}

/** A bar label's amount: the currency's digits without its symbol. */
function bareAmount(amount: number, currency: string): string {
  return formatGroupedDecimal(amount, currencyFormatInfo(currency).minorDigits);
}

type SegmentLook = { background: string; color: string; name: string; kindName: string };

/**
 * The billing currency's bar: to scale over the cupo, its segments left to right, the bracket over the
 * open facturación, and one row of labels under it — a label only while it fits inside its own
 * segment, stopping at the first that does not (measured: the one computation this block makes).
 */
function SegmentedBar({
  side,
  figure,
  onLabelLines,
}: {
  side: CcGlanceSideDto;
  figure: ReactNode;
  /** How many text lines the labels row took (2 with a segment label, 1 with only the free amount, 0 empty). */
  onLabelLines: (lines: LabelLines) => void;
}) {
  const { t } = useTranslation();
  const segments = side.segments ?? [];
  let cuotaIndex = 0;
  const looks: SegmentLook[] = segments.map((s: CcGlanceSegmentDto) => {
    if (s.kind === "previous") {
      return {
        background: "var(--muted)",
        color: "var(--text)",
        name: formatMonthShortLabel(s.billing_month),
        kindName: t("accountDetail.creditCard.glance.segmentPrevious"),
      };
    }
    if (s.kind === "purchases") {
      return {
        background: "var(--accent)",
        color: "var(--accent)",
        name: t("accountDetail.creditCard.glance.purchases"),
        kindName: t("accountDetail.creditCard.glance.purchases"),
      };
    }
    // Each later month fades a step further into the track, down to a floor.
    const strength = Math.max(32, 100 - 9 * cuotaIndex++);
    return {
      background: `color-mix(in srgb, var(--cuota-billed) ${strength}%, var(--surface2))`,
      color: "var(--cuota-billed)",
      name: formatMonthShortLabel(s.billing_month),
      kindName: t("accountDetail.creditCard.glance.segmentCuotas"),
    };
  });
  const labels = segments.map((s, i) => ({ name: looks[i]!.name, amount: bareAmount(s.amount, side.currency) }));
  // What the fit check reads: the labels' text and the segments' widths.
  const fitKey = segments.map((s, i) => `${labels[i]!.name}|${labels[i]!.amount}|${s.share}`).join(" ");
  const shares = segments.map((s) => s.share);
  // The chart's segments with their tooltips (month, what the segment is, its amount).
  const barSegments: CcGlanceCupoBarSegment[] = segments.map((s, i) => ({
    key: `${s.kind}-${s.billing_month}`,
    share: s.share,
    fill: looks[i]!.background,
    title: formatYearMonthLabel(s.billing_month),
    name: looks[i]!.kindName,
    value: formatMoney({ value: s.amount, currency: side.currency }),
  }));

  const barRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [fitting, setFitting] = useState(0);
  useLayoutEffect(() => {
    const bar = barRef.current;
    const measure = measureRef.current;
    if (!bar || !measure) return;
    const fit = () => {
      const width = bar.getBoundingClientRect().width;
      const widths = [...measure.children].map((el) => el.getBoundingClientRect().width);
      let n = 0;
      while (n < shares.length && widths[n]! <= shares[n]! * width) n++;
      setFitting(n);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(bar);
    return () => ro.disconnect();
  }, [fitKey]); // eslint-disable-line react-hooks/exhaustive-deps -- `fitKey` carries `shares`
  const labelLines: LabelLines = fitting > 0 ? 2 : side.free != null ? 1 : 0;
  useEffect(() => onLabelLines(labelLines), [labelLines, onLabelLines]);

  const bracket = side.bracket;
  return (
    <>
      <div className={styles.bracket}>
        {bracket ? (
          <>
            <i style={{ left: pct(bracket.start_share), width: pct(bracket.share) }} />
            {bracket.amount != null ? (
              <span className="mono" style={{ left: pct(bracket.start_share + bracket.share / 2) }}>
                {formatMoney({ value: bracket.amount, currency: side.currency })}
              </span>
            ) : null}
          </>
        ) : null}
      </div>
      {/* The track (the free part) with the Recharts bar over it at full width, no margin: the
          bracket above and the labels below use the same shares over the same width. */}
      <div className={styles.bar} ref={barRef}>
        <CcGlanceCupoBar segments={barSegments} gapPx={2} />
      </div>
      <div className={styles.labels}>
        {segments.slice(0, fitting).map((s, i) => (
          <span key={`${s.kind}-${s.billing_month}`} style={{ width: pct(s.share) }}>
            <em>{labels[i]!.name}</em>
            <b className="mono" style={{ color: looks[i]!.color }}>
              {labels[i]!.amount}
            </b>
          </span>
        ))}
        <span className={styles.spacer} />
        {side.free != null ? <span className={`${styles.free} mono`}>{bareAmount(side.free, side.currency)}</span> : null}
      </div>
      {/* After the labels in the markup so a one-column layout reads bar, labels, figure; on two
          columns it is pinned beside the bar. */}
      <div className={`${styles.figure} mono`} style={{ gridRow: 2 }}>
        {figure}
      </div>
      {/* Hidden copies of every label at their natural width, for the fit check. */}
      <div className={styles.measure} ref={measureRef} aria-hidden>
        {labels.map((l, i) => (
          <span key={i}>
            <em>{l.name}</em>
            <b className="mono">{l.amount}</b>
          </span>
        ))}
      </div>
    </>
  );
}

/** Another currency's thin bar: used over the bar, with its tooltip. */
function ThinBar({ side }: { side: CcGlanceSideDto }) {
  const { t } = useTranslation();
  const used = formatMoney({ value: side.used, currency: side.currency });
  const total = side.total != null ? formatMoney({ value: side.total, currency: side.currency }) : null;
  const usedLabel = t("accountDetail.creditCard.glance.cupoUsed");
  const ofLabel = t("accountDetail.creditCard.glance.of");
  const segments = useMemo<CcGlanceCupoBarSegment[]>(
    () => [
      {
        key: side.currency,
        share: side.used_share,
        fill: "var(--accent)",
        title: usedLabel,
        name: side.currency.toUpperCase(),
        value: used,
        subValue: total != null ? `${ofLabel} ${total}` : undefined,
      },
    ],
    [side.currency, side.used_share, used, total, usedLabel, ofLabel]
  );
  return <CcGlanceCupoBar segments={segments} />;
}

/** «<used> de <total>», the used figure emphasised. */
function UsedOfTotal({ side, accent }: { side: CcGlanceSideDto; accent: boolean }) {
  const { t } = useTranslation();
  return (
    <>
      <b className={accent ? styles.foreign : undefined}>{formatMoney({ value: side.used, currency: side.currency })}</b>
      {side.total != null ? (
        <>
          {" "}
          {t("accountDetail.creditCard.glance.of")} {formatMoney({ value: side.total, currency: side.currency })}
        </>
      ) : null}
    </>
  );
}

const BLANK = "\u00a0";

type LabelLines = 0 | 1 | 2;

/**
 * Which rows a card's block has, remembered per card (`cc_glance_shape`) so the pending block has the
 * loaded one's height: no amounts, only the sides' currencies (billing first; a second side adds the
 * split line, a thin bar and the sum), the previous facturación's state (its line count) and the
 * labels row's line count.
 */
type GlanceShape = {
  currencies: string[];
  previous: "none" | "paid" | "due";
  label_lines: LabelLines;
};

function isGlanceShape(v: unknown): v is GlanceShape {
  if (v == null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    Array.isArray(o.currencies) &&
    o.currencies.length > 0 &&
    o.currencies.every((c) => typeof c === "string") &&
    (o.previous === "none" || o.previous === "paid" || o.previous === "due") &&
    (o.label_lines === 0 || o.label_lines === 1 || o.label_lines === 2)
  );
}

const GLANCE_SHAPE = persistedPayload<GlanceShape>("cc_glance_shape", isGlanceShape);

/** The guess for a card this browser has never shown: two currencies, previous facturación paid. */
const GUESSED_SHAPE: Omit<GlanceShape, "currencies"> & { sides: number } = { sides: 2, previous: "paid", label_lines: 2 };

function shapeOf(glance: CcGlanceDto, labelLines: LabelLines): GlanceShape {
  const prev = glance.previous;
  return {
    currencies: glance.sides.map((s) => s.currency),
    previous: prev == null ? "none" : prev.paid ? "paid" : "due",
    label_lines: labelLines,
  };
}

/**
 * The pending block's shape: a glance react-query still holds for this card (another unit's bundle,
 * this session), else the browser's stored copy, else the guess.
 */
function usePendingShape(accountId: number): { sides: number; previous: GlanceShape["previous"]; label_lines: LabelLines } {
  const queryClient = useQueryClient();
  const stored = readPersistedPayload(GLANCE_SHAPE, [String(accountId)]);
  const held = queryClient
    .getQueriesData<AccountDetailBundleResponse>({ queryKey: queryKeys.accountDetailAll(String(accountId)) })
    .map(([, data]) => data?.ccLedger?.glance)
    .find((g): g is CcGlanceDto => g != null);
  if (held) {
    const shape = shapeOf(held, stored?.label_lines ?? GUESSED_SHAPE.label_lines);
    return { sides: shape.currencies.length, previous: shape.previous, label_lines: shape.label_lines };
  }
  if (stored) return { sides: stored.currencies.length, previous: stored.previous, label_lines: stored.label_lines };
  return GUESSED_SHAPE;
}

/**
 * The block while the page data is pending (the page dims it): the loaded block's rows with blank
 * text, in the card's remembered shape (`usePendingShape`), so nothing moves when the data lands. The
 * figure column has a fixed minimum width (CSS), so blank figures keep it.
 */
function PendingGlance({ accountId }: { accountId: number }) {
  const shape = usePendingShape(accountId);
  const multi = shape.sides > 1;
  return (
    <div className={styles.glance}>
      <div className={styles.facturacion}>
        <div className={styles.bill}>
          <div className={styles.month}>{BLANK}</div>
          <div className={`${styles.big} mono`}>{BLANK}</div>
          {multi ? <div className={`${styles.split} mono`}>{BLANK}</div> : null}
          <div className={styles.quiet}>{BLANK}</div>
        </div>
        <div className={styles.foot}>
          {shape.previous === "none" ? null : shape.previous === "paid" ? (
            BLANK
          ) : (
            <>
              {BLANK}
              <br />
              {BLANK}
            </>
          )}
        </div>
      </div>
      <div className={styles.cupo}>
        <div className={styles.bracket} />
        <div className={styles.bar} />
        <div className={styles.labels}>
          {shape.label_lines === 2 ? (
            <span>
              <em>{BLANK}</em>
              <b className="mono">{BLANK}</b>
            </span>
          ) : shape.label_lines === 1 ? (
            <span className={`${styles.free} mono`}>{BLANK}</span>
          ) : null}
        </div>
        <div className={`${styles.figure} mono`} style={{ gridRow: 2 }}>
          {BLANK}
        </div>
        {Array.from({ length: shape.sides - 1 }, (_, i) => (
          <Fragment key={i}>
            <div className={styles.thinBar} />
            <div className={`${styles.figure} ${styles.thinFigure} mono`}>{BLANK}</div>
          </Fragment>
        ))}
        {multi ? <div className={`${styles.sum} mono`}>{BLANK}</div> : null}
      </div>
    </div>
  );
}

/**
 * The credit-card page's «at a glance» block (server `glance`, `ccGlance.ts`): the open facturación and
 * the previous one on the left, the cupo per currency on the right. `glance` undefined while the page
 * data is not in (an empty frame, dimmed by the page); null when the card has no open facturación.
 */
export function CreditCardGlance({ accountId, glance }: { accountId: number; glance: CcGlanceDto | null | undefined }) {
  const { t } = useTranslation();
  const daysLabel = useDaysLabel();
  // The labels row's line count, reported by the bar once it has measured the labels.
  const [labelLines, setLabelLines] = useState<LabelLines | null>(null);
  const shapeKey = glance && labelLines != null ? JSON.stringify(shapeOf(glance, labelLines)) : null;
  useEffect(() => {
    if (shapeKey != null) writePersistedPayload(GLANCE_SHAPE, [String(accountId)], JSON.parse(shapeKey) as GlanceShape);
  }, [accountId, shapeKey]);
  if (glance === null) return null;
  if (glance === undefined) return <PendingGlance accountId={accountId} />;
  const billing = glance.billing_currency;
  const multi = glance.sides.length > 1;
  const [main, ...others] = glance.sides;
  const prev = glance.previous;
  return (
    <div className={styles.glance}>
      <div className={styles.facturacion}>
        <div className={styles.bill}>
          <div className={styles.month}>{formatYearMonthLabel(glance.open.billing_month)}</div>
          <div className={`${styles.big} mono`}>{formatMoney({ value: glance.open.total, currency: billing })}</div>
          {multi ? (
            <div className={`${styles.split} mono`}>
              <AmountsJoined amounts={glance.open.amounts} billing={billing} />
            </div>
          ) : null}
          <div className={styles.quiet}>
            {t("accountDetail.creditCard.glance.closes")} <b className="mono">{glance.open.close_iso}</b> ·{" "}
            {daysLabel(glance.open.days_to_close)}
          </div>
        </div>
        <div className={styles.foot}>
          {prev == null ? null : prev.paid ? (
            <>
              {formatMonthShortLabel(prev.billing_month)}{" "}
              <span className="mono">{formatMoney({ value: prev.total, currency: billing })}</span>{" "}
              <span className={styles.paid}>{t("accountDetail.creditCard.glance.paid")}</span>
              {prev.is_provisional_close ? (
                <span title={t("accountDetail.creditCard.provisionalCloseHint")}>*</span>
              ) : null}
            </>
          ) : (
            <>
              <span className={styles.due}>
                {formatMonthShortLabel(prev.billing_month)}{" "}
                <span className="mono">
                  <AmountsJoined amounts={prev.owed} billing={billing} />
                </span>
                {prev.is_provisional_close ? (
                  <span title={t("accountDetail.creditCard.provisionalCloseHint")}>*</span>
                ) : null}
              </span>
              <br />
              {t("accountDetail.creditCard.glance.payBy")} <b className="mono">{prev.pay_by_iso}</b> ·{" "}
              {daysLabel(prev.days_to_pay_by)}
            </>
          )}
        </div>
      </div>
      <div className={styles.cupo}>
        {main ? <SegmentedBar side={main} figure={<UsedOfTotal side={main} accent={false} />} onLabelLines={setLabelLines} /> : null}
        {others.map((side) => (
          <Fragment key={side.currency}>
            <div className={styles.thinBar}>
              <ThinBar side={side} />
            </div>
            <div className={`${styles.figure} ${styles.thinFigure} mono`}>
              <UsedOfTotal side={side} accent />
            </div>
          </Fragment>
        ))}
        {glance.total_owed != null ? (
          <div className={`${styles.sum} mono`}>{formatMoney({ value: glance.total_owed, currency: billing })}</div>
        ) : null}
      </div>
    </div>
  );
}
