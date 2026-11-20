import { Link } from "react-router-dom";
import { cn } from "../../cn";
import { useTranslation } from "../../i18n";
import { formatInstrumentUnits, formatMoney, formatPct } from "../../format";
import type { BasketGlanceDto, BasketGlanceMemberDto } from "../../types";
import {
  CompositionGroup,
  GlanceGroup,
  GlanceRail,
  GlanceSparklineGroup,
  GlanceTitleLine,
  PendingCompositionGroup,
  PendingSparklineGroup,
  PeriodsGroup,
  PricePill,
} from "../account/PositionGlance";
import { pctOf } from "../account/positionGlanceLayout";
import styles from "./BasketGlance.module.css";

const BLANK = " ";

/**
 * The basket page's title line: the group's name, today's value and the day's P/L (the group
 * card's figures, server `basket_glance`). `glance` undefined = pending: the nav's name, blank figures.
 */
export function BasketGlanceTitle({
  glance,
  fallbackTitle,
  loading = false,
}: {
  glance: BasketGlanceDto | undefined;
  fallbackTitle: string;
  loading?: boolean;
}) {
  return (
    <GlanceTitleLine
      title={glance?.title ?? fallbackTitle}
      value={glance?.value ?? null}
      day={glance?.periods.day ?? null}
      loading={loading}
    />
  );
}

/** One member: name (its page) | share bar | share | value; under it the units and today's price pill. */
function MemberRow({ member }: { member: BasketGlanceMemberDto }) {
  const { t } = useTranslation();
  const { units, quote } = member;
  return (
    <div className={cn(styles.member, !member.held && styles.unheld)}>
      <Link to={member.route_path} className={styles.memberName}>
        {member.name}
      </Link>
      <span className={styles.shareBar}>
        <i style={{ width: pctOf(member.share) }} />
      </span>
      <span className={cn("mono", styles.memberShare)}>{formatPct(member.share * 100, 1)}</span>
      <span className={cn("mono", styles.memberValue)}>{formatMoney(member.value)}</span>
      {units || quote ? (
        <span className={styles.memberSub}>
          {units ? (
            <span className="mono">
              {t(`groupPage.basketGlance.units.${units.kind}`, { units: formatInstrumentUnits(units.amount, units.kind) })}
            </span>
          ) : null}
          {quote ? (
            <span
              title={t("groupPage.basketGlance.priceTitle", {
                date: quote.price_as_of,
                cost: formatMoney(quote.average_cost),
              })}
            >
              <PricePill price={quote.price} priceVsCost={quote.price_vs_cost} />
            </span>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

/** The breakdown block: one line per member, heaviest first (the server's order and shares). */
function MembersGroup({ members }: { members: readonly BasketGlanceMemberDto[] }) {
  return (
    <GlanceGroup>
      <div className={styles.members}>
        {members.map((m) => (
          <MemberRow key={m.account_id} member={m} />
        ))}
      </div>
    </GlanceGroup>
  );
}

/** The breakdown's frame while the payload is pending: one blank line per member, at the loaded height. */
function PendingMembersGroup({ rows }: { rows: number }) {
  return (
    <GlanceGroup>
      <div className={styles.members}>
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className={styles.member}>
            <span className={styles.memberName}>{BLANK}</span>
            <span className={styles.memberSub}>{BLANK}</span>
          </div>
        ))}
      </div>
    </GlanceGroup>
  );
}

/**
 * The basket page's rail (server `basket_glance`, `basketGlance.ts`): the members' breakdown, the
 * basket's value index since its start, the composition of its value and the día / mes / año
 * bars. No price track: a basket has no one unit price. `glance` undefined while the nav context
 * is pending (the frames with blank figures, `pendingMembers` lines; the page dims them).
 */
export function BasketGlanceRail({
  groupSlug,
  glance,
  pendingMembers,
}: {
  groupSlug: string;
  glance: BasketGlanceDto | undefined;
  /** The member count the nav tree states (the pending breakdown's height). */
  pendingMembers: number;
}) {
  const { t } = useTranslation();
  return (
    <GlanceRail>
      {glance ? (
        <>
          <MembersGroup members={glance.members} />
          {glance.sparklines.length > 0 ? (
            <GlanceSparklineGroup
              surfaceId={`group.${groupSlug}.sparkline`}
              lines={glance.sparklines}
              tone="neutral"
              ariaLabel={t("groupPage.basketGlance.sparkline", { name: glance.title })}
            />
          ) : null}
          {glance.composition ? <CompositionGroup composition={glance.composition} /> : null}
          <PeriodsGroup periods={glance.periods} />
        </>
      ) : (
        <>
          <PendingMembersGroup rows={pendingMembers} />
          <PendingSparklineGroup />
          <PendingCompositionGroup />
          <PeriodsGroup periods={null} />
        </>
      )}
    </GlanceRail>
  );
}
