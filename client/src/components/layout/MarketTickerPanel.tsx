import { Fragment } from "react";
import { useTranslation } from "../../i18n";
import { useMarketTickerMarquee } from "../../hooks/useMarketTickerMarquee";
import { AppMarquee } from "./AppMarquee";
import { DeltaMetricFlow } from "../dashboard/DeltaMetricFlow";
import { cn } from "../../cn";
import styles from "./MarketTickerPanel.module.css";

function MarqueeSegmentSeparator() {
  return <span className={styles.sep} aria-hidden />;
}

function MarqueeItemContent({
  label,
  value,
  delta,
  deltaFractionDigits,
  showDelta,
  seed,
}: {
  label: string;
  value: string;
  delta?: number | null;
  deltaFractionDigits?: number;
  showDelta?: boolean;
  seed: string;
}) {
  return (
    <span className={styles.item}>
      <span className={styles.label}>{label}</span>
      <span className={cn(styles.value, "mono")}>{value}</span>
      {showDelta ? (
        <DeltaMetricFlow
          delta={delta ?? null}
          animated={false}
          mountSeedId={seed}
          fractionDigits={deltaFractionDigits ?? 2}
          deltaFormat="percent"
          className={styles.delta}
        />
      ) : null}
    </span>
  );
}

function MarqueeTrack({ items }: { items: ReturnType<typeof useMarketTickerMarquee>["items"] }) {
  return (
    <>
      {items.map((item, i) => (
        <Fragment key={`${item.kind}-${item.label}-${i}`}>
          <MarqueeItemContent
            label={item.label}
            value={item.value}
            delta={"delta" in item ? item.delta : undefined}
            deltaFractionDigits={"fractionDigits" in item ? item.fractionDigits : 0}
            showDelta={
              item.kind === "usd_live" ||
              item.kind === "uno_a" ||
              item.kind === "risky_norris" ||
              item.kind === "risky_norris_proxy" ||
              item.kind === "equity"
            }
            seed={`ticker:${item.kind}:${item.label}`}
          />
          <MarqueeSegmentSeparator />
        </Fragment>
      ))}
    </>
  );
}

export function MarketTickerPanel() {
  const { t } = useTranslation();
  const { items, loading } = useMarketTickerMarquee();
  const ready = !loading && items.length > 0;

  return (
    <aside className="market-ticker-panel" aria-label={t("marketTicker.panelAria")}>
      <div
        className={cn(styles.marqueeWrap, !ready && styles.marqueeWrapIdle)}
      >
        {ready ? (
          <AppMarquee speed={42} play>
            <MarqueeTrack items={items} />
          </AppMarquee>
        ) : (
          <span className={cn(styles.loading, "muted")}>{loading ? "…" : ""}</span>
        )}
      </div>
    </aside>
  );
}
