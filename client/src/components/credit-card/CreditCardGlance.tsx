import { Fragment, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "../../i18n";
import { currencyFormatInfo, formatGroupedDecimal, formatMoney } from "../../format";
import { formatMonthShortLabel, formatYearMonthLabel } from "../../formatDateLabel";
import type { CcGlanceAmountDto, CcGlanceDto, CcGlanceSegmentDto, CcGlanceSideDto } from "../../types";
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

type SegmentLook = { background: string; color: string; name: string };

/**
 * The billing currency's bar: to scale over the cupo, its segments left to right, the bracket over the
 * open facturación, and one row of labels under it — a label only while it fits inside its own
 * segment, stopping at the first that does not (measured: the one computation this block makes).
 */
function SegmentedBar({ side, figure }: { side: CcGlanceSideDto; figure: ReactNode }) {
  const { t } = useTranslation();
  const segments = side.segments ?? [];
  let cuotaIndex = 0;
  const looks: SegmentLook[] = segments.map((s: CcGlanceSegmentDto) => {
    if (s.kind === "previous") {
      return { background: "var(--muted)", color: "var(--text)", name: formatMonthShortLabel(s.billing_month) };
    }
    if (s.kind === "purchases") {
      return { background: "var(--accent)", color: "var(--accent)", name: t("accountDetail.creditCard.glance.purchases") };
    }
    // Each later month fades a step further into the track, down to a floor.
    const strength = Math.max(32, 100 - 9 * cuotaIndex++);
    return {
      background: `color-mix(in srgb, var(--cuota-billed) ${strength}%, var(--surface2))`,
      color: "var(--cuota-billed)",
      name: formatMonthShortLabel(s.billing_month),
    };
  });
  const labels = segments.map((s, i) => ({ name: looks[i]!.name, amount: bareAmount(s.amount, side.currency) }));
  // What the fit check reads: the labels' text and the segments' widths.
  const fitKey = segments.map((s, i) => `${labels[i]!.name}|${labels[i]!.amount}|${s.share}`).join(" ");
  const shares = segments.map((s) => s.share);

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
      <div className={styles.bar} ref={barRef}>
        {segments.map((s, i) => (
          <span
            key={`${s.kind}-${s.billing_month}`}
            style={{ width: pct(s.share), background: looks[i]!.background }}
            title={i < fitting ? undefined : `${labels[i]!.name} ${labels[i]!.amount}`}
          />
        ))}
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

/**
 * The credit-card page's «at a glance» block (server `glance`, `ccGlance.ts`): the open facturación and
 * the previous one on the left, the cupo per currency on the right. `glance` undefined while the page
 * data is not in (an empty frame, dimmed by the page); null when the card has no open facturación.
 */
export function CreditCardGlance({ glance }: { glance: CcGlanceDto | null | undefined }) {
  const { t } = useTranslation();
  const daysLabel = useDaysLabel();
  if (glance === null) return null;
  if (glance === undefined) {
    return (
      <div className={styles.glance}>
        <div className={styles.facturacion}>
          <div className={styles.bill} />
          <div className={styles.foot} />
        </div>
        <div className={styles.cupo} />
      </div>
    );
  }
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
        {main ? <SegmentedBar side={main} figure={<UsedOfTotal side={main} accent={false} />} /> : null}
        {others.map((side) => (
          <Fragment key={side.currency}>
            <div className={styles.thinBar}>
              <i style={{ width: pct(side.used_share) } as CSSProperties} />
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
