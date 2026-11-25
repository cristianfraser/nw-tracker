import { Fragment, type CSSProperties } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "../../i18n";
import { formatMoney, formatPct } from "../../format";
import { formatDayMonthShortLabel, formatMonthShortLabel } from "../../formatDateLabel";
import { cn } from "../../cn";
import type {
  CcGlanceAmountDto,
  CcGroupLaneCardDto,
  CcGroupLaneEventDto,
  CcGroupLanesResponse,
  CcGroupNextPaymentDto,
} from "../../types";
import styles from "./CreditCardGroupLanes.module.css";

/** A count of days as copy («today», «in N days», «N days ago»): the card glance's wording. */
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

/** Owed per currency: the billing currency plain, the others in the accent colour after « + ». */
function OwedSplit({ owed, billing }: { owed: readonly CcGlanceAmountDto[]; billing: string }) {
  return (
    <>
      {owed.map((a, i) => (
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

/** The billing-currency figure, with its split under it when the card owes in another currency too. */
function OwedCell({ owedTotal, owed, billing }: { owedTotal: number; owed: readonly CcGlanceAmountDto[]; billing: string }) {
  return (
    <span className={cn(styles.owed, "mono")}>
      <b>{formatMoney({ value: owedTotal, currency: billing })}</b>
      {owed.length > 1 ? (
        <span className={styles.split}>
          <OwedSplit owed={owed} billing={billing} />
        </span>
      ) : null}
    </span>
  );
}

function CupoCell({ cupo, billing, withTotal }: { cupo: CcGroupLaneCardDto["cupo"]; billing: string; withTotal: boolean }) {
  const { t } = useTranslation();
  if (cupo == null) return <span className={cn(styles.cupo, "mono")}>—</span>;
  return (
    <span className={cn(styles.cupo, "mono")} title={t("groupPage.creditCardLanes.cupoOf", { total: formatMoney({ value: cupo.total, currency: billing }) })}>
      <span className={styles.cupoLine}>
        <span className={styles.cupoBar} aria-hidden>
          <i style={{ width: `${Math.min(1, cupo.used_share) * 100}%` }} />
        </span>
        {formatPct(cupo.used_share * 100, 0)}
      </span>
      {withTotal ? (
        <span className={styles.sub}>
          {t("groupPage.creditCardLanes.cupoOf", { total: formatMoney({ value: cupo.total, currency: billing }) })}
        </span>
      ) : null}
    </span>
  );
}

/** «Next payment: <card> $X by YYYY-MM-DD · in N days», the estimate marked «≈». */
function NextPaymentLine({
  next,
  cardName,
  billing,
}: {
  next: CcGroupNextPaymentDto;
  cardName: string;
  billing: string;
}) {
  const { t } = useTranslation();
  const daysLabel = useDaysLabel();
  return (
    <span className={styles.next}>
      {t("groupPage.creditCardLanes.nextPayment")}: <b>{cardName}</b>{" "}
      <span className="mono" title={next.estimate ? t("groupPage.creditCardLanes.estimateHint") : undefined}>
        {next.estimate ? "≈ " : ""}
        {formatMoney({ value: next.amount, currency: billing })}
      </span>{" "}
      · {t("accountDetail.creditCard.glance.payBy")} <b className="mono">{next.pay_by_iso}</b> ·{" "}
      <span className={next.days < 0 ? styles.overdue : undefined}>
        {next.days < 0 ? t("groupPage.creditCardLanes.overdue") : daysLabel(next.days)}
      </span>
    </span>
  );
}

const BLANK = "\u00a0";

/** Where a label sits against its dot: centred, or held inside the lane at either edge. */
function edgeClass(share: number): string | undefined {
  if (share < 0.08) return styles.alignStart;
  if (share > 0.92) return styles.alignEnd;
  return undefined;
}

/**
 * A card's lane: the shared date axis with today marked and each event on its day — a close
 * (ring) and the pay-bys (filled), kind over the dot, amount under it. Two events closer than a
 * label's width go on two tiers so their labels never overlap (layout only).
 */
function Lane({
  card,
  axis,
  billing,
}: {
  card: CcGroupLaneCardDto;
  axis: CcGroupLanesResponse["axis"];
  billing: string;
}) {
  const { t } = useTranslation();
  const color = `rgb(${card.color_rgb})`;
  let prevShare = -1;
  let prevTier = 1;
  const placed = card.events.map((e) => {
    const tier = e.share - prevShare < 0.16 && prevTier === 0 ? 1 : 0;
    prevShare = e.share;
    prevTier = tier;
    return { e, tier };
  });
  const kindLabel = (e: CcGroupLaneEventDto) =>
    e.kind === "close"
      ? t("accountDetail.creditCard.glance.closes")
      : e.days < 0
        ? t("groupPage.creditCardLanes.overdue")
        : t("accountDetail.creditCard.glance.payBy");
  return (
    <div className={styles.lane}>
      <div className={styles.rail} />
      <div className={styles.today} style={{ left: `${axis.today_share * 100}%` }} />
      {placed.map(({ e, tier }) => (
        <span
          key={`${e.kind}-${e.billing_month}`}
          className={cn(styles.event, tier === 1 && styles.tier1, edgeClass(e.share), e.kind === "pay_by" && e.days < 0 && styles.overdue)}
          style={{ left: `${e.share * 100}%`, "--lane-color": color } as CSSProperties}
          title={`${e.iso} · ${formatMonthShortLabel(e.billing_month)}${e.estimate ? ` · ${t("groupPage.creditCardLanes.estimateHint")}` : ""}`}
        >
          {/* Tier 0: kind over the dot, amount under it; tier 1: the dot, then amount and kind under it. */}
          {tier === 0 ? <em>{kindLabel(e)}</em> : null}
          <i className={e.kind === "close" ? styles.ring : styles.dot} aria-hidden />
          <b className="mono">
            {e.estimate ? "≈" : ""}
            {formatMoney({ value: e.amount, currency: billing })}
          </b>
          {tier === 1 ? <em>{kindLabel(e)}</em> : null}
        </span>
      ))}
      <div className={styles.laneTicks} aria-hidden>
        {axis.ticks.map((tk) => (
          <span key={tk.iso} style={{ left: `${tk.share * 100}%` }}>
            {formatDayMonthShortLabel(tk.iso)}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * The credit-card group page's head (server `ccGroupLanes.ts`): a total row, then one lane per
 * card — owed, its cupo, its close and pay-bys on a date axis shared by every card. The markup is
 * in that order, which is the drawn order at every width. Every figure is
 * the server's (each card's glance); the client only places them. One rendering at every width: a
 * container query moves the lane under the card on a narrow tile.
 */
export function CreditCardGroupLanes({ data, loading }: { data: CcGroupLanesResponse; loading?: boolean }) {
  const { t } = useTranslation();
  const billing = data.billing_currency;
  const n = data.cards.length;
  const nextCard = data.total.next_payment
    ? data.cards.find((c) => c.account_id === data.total.next_payment!.account_id)
    : undefined;
  if (n === 0 && !loading) return <p className="muted">{t("groupPage.creditCardLanes.noCards")}</p>;
  return (
    <div className={styles.frame}>
      <div className={styles.lanes} role="table" aria-busy={loading || undefined}>
        <div className={cn(styles.row, styles.head)} role="row">
          <span className={styles.name} role="columnheader">
            {t("groupPage.creditCardLanes.colCard")}
          </span>
          <span className={styles.owedHead} role="columnheader">
            {t("groupPage.creditCardLanes.colOwed")}
          </span>
          <span className={styles.cupoHead} role="columnheader">
            {t("groupPage.creditCardLanes.colCupo")}
          </span>
          <span className={styles.laneCol} aria-hidden>
            <span className={styles.headTicks}>
              {data.axis.ticks.map((tk) => (
                <span key={tk.iso} style={{ left: `${tk.share * 100}%` }}>
                  {formatDayMonthShortLabel(tk.iso)}
                </span>
              ))}
            </span>
          </span>
        </div>

        <div className={cn(styles.row, styles.totalRow)} role="row">
          <span className={styles.name} role="rowheader">
            {/* The placeholder frame (no cards yet) keeps the row's height with blank text. */}
            {n === 0 ? BLANK : n === 1 ? t("groupPage.creditCardLanes.totalOne") : t("groupPage.creditCardLanes.total", { n })}
            <span className={styles.sub}>
              {n === 0 ? (
                BLANK
              ) : (
                <>
                  {t("groupPage.creditCardLanes.inCuotas")}{" "}
                  <span className="mono">{formatMoney({ value: data.total.cuotas_ahead, currency: billing })}</span>
                </>
              )}
            </span>
          </span>
          {n === 0 ? <span className={styles.owed}>{BLANK}</span> : <OwedCell owedTotal={data.total.owed_total} owed={data.total.owed} billing={billing} />}
          {n === 0 ? <span className={styles.cupo}>{BLANK}</span> : <CupoCell cupo={data.total.cupo} billing={billing} withTotal />}
          <span className={cn(styles.laneCol, styles.nextCol)}>
            {data.total.next_payment && nextCard ? (
              <NextPaymentLine next={data.total.next_payment} cardName={nextCard.name} billing={billing} />
            ) : null}
          </span>
        </div>

        {data.cards.map((card) => (
          <div key={card.account_id} className={styles.row} role="row">
            <span className={styles.name} role="rowheader">
              <Link to={`/account/${card.account_id}`} className={styles.cardLink}>
                <i className={styles.swatch} style={{ background: `rgb(${card.color_rgb})` }} aria-hidden />
                {card.name}
              </Link>
              <span className={styles.sub}>
                {card.previous == null ? null : card.previous.paid ? (
                  <span className={styles.paid}>
                    ✓ {t("groupPage.creditCardLanes.paidMonth", { month: formatMonthShortLabel(card.previous.billing_month) })}
                  </span>
                ) : (
                  t("groupPage.creditCardLanes.billedToPay", { month: formatMonthShortLabel(card.previous.billing_month) })
                )}
                {card.cuotas_ahead > 0 ? (
                  <>
                    {card.previous != null ? " · " : null}
                    {t("groupPage.creditCardLanes.inCuotas")}{" "}
                    <span className="mono">{formatMoney({ value: card.cuotas_ahead, currency: billing })}</span>
                  </>
                ) : null}
              </span>
            </span>
            <OwedCell owedTotal={card.owed_total} owed={card.owed} billing={billing} />
            <CupoCell cupo={card.cupo} billing={billing} withTotal={false} />
            <span className={styles.laneCol}>
              <Lane card={card} axis={data.axis} billing={billing} />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
