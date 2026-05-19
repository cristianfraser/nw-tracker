import { Fragment } from "react";
import { useTranslation } from "../i18n";
import { useMarketTickerMarquee } from "../hooks/useMarketTickerMarquee";
import { AppMarquee } from "./AppMarquee";
import { DeltaMetricFlow } from "./DeltaMetricFlow";

function MarqueeSegmentSeparator() {
  return <span className="market-ticker-panel__sep" aria-hidden />;
}

function MarqueeItemContent({
  label,
  value,
  delta,
  deltaFractionDigits,
  deltaUsd,
  showDelta,
  seed,
}: {
  label: string;
  value: string;
  delta?: number | null;
  deltaFractionDigits?: number;
  deltaUsd?: boolean;
  showDelta?: boolean;
  seed: string;
}) {
  return (
    <span className="market-ticker-panel__item">
      <span className="market-ticker-panel__label">{label}</span>
      <span className="market-ticker-panel__value mono">{value}</span>
      {showDelta ? (
        <DeltaMetricFlow
          delta={delta ?? null}
          showUsd={deltaUsd ?? false}
          animated={false}
          mountSeedId={seed}
          fractionDigits={deltaFractionDigits ?? 0}
          className="market-ticker-panel__delta"
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
            deltaUsd={item.kind === "equity"}
            showDelta={item.kind === "usd_live" || item.kind === "equity"}
            seed={`ticker:${item.kind}:${item.label}`}
          />
          <MarqueeSegmentSeparator />
        </Fragment>
      ))}
    </>
  );
}

/** Fixed top-right panel with a Bloomberg-style rates marquee. */
export function MarketTickerPanel() {
  const { t } = useTranslation();
  const { items, loading } = useMarketTickerMarquee();
  const ready = !loading && items.length > 0;

  return (
    <aside className="market-ticker-panel" aria-label={t("marketTicker.panelAria")}>
      <div
        className={`market-ticker-panel__marquee-wrap${ready ? "" : " market-ticker-panel__marquee-wrap--idle"}`}
      >
        {ready ? (
          <AppMarquee speed={42} play>
            <MarqueeTrack items={items} />
          </AppMarquee>
        ) : (
          <span className="market-ticker-panel__loading muted">{loading ? "…" : ""}</span>
        )}
      </div>
    </aside>
  );
}
