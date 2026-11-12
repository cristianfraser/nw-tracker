import { Link } from "react-router-dom";
import { useTranslation } from "../../i18n";
import type { FxConversionWarning, FxCoverage, FxCoveragePair } from "../../types";

/** A rate pair as the copy names it (`USD/CLP`, `EUR/USD`). */
export function fxPairLabel(p: { base: string; quote: string }): string {
  return `${p.base.toUpperCase()}/${p.quote.toUpperCase()}`;
}

/** The pairs the banner talks about: those with a problem, else every pair checked. */
function pairsWithProblems(coverage: FxCoverage): FxCoveragePair[] {
  const bad = coverage.pairs.filter((p) => !p.complete || p.is_sparse);
  return bad.length > 0 ? bad : coverage.pairs;
}

function warningMessage(t: (k: string) => string, w: FxConversionWarning): string {
  switch (w.code) {
    case "buy_rate_missing":
      return t("fxCoverage.warningBuyRateMissing");
    case "sell_rate_missing":
      return t("fxCoverage.warningSellRateMissing");
    case "usd_reference_clp":
      return t("fxCoverage.warningUsdReferenceClp");
    default:
      return w.code;
  }
}

export function FxCoverageBanner({
  coverage,
  conversionError,
  conversionWarnings,
}: {
  coverage: FxCoverage | null | undefined;
  conversionError?: boolean;
  conversionWarnings?: readonly FxConversionWarning[];
}) {
  const { t } = useTranslation();
  const warnings = [
    ...(conversionWarnings ?? []),
    ...(coverage?.conversion_warnings ?? []),
  ];
  if (!coverage && warnings.length === 0 && !conversionError) return null;

  const rejected = coverage?.yahoo_rejected ?? [];
  const show =
    conversionError ||
    warnings.length > 0 ||
    (coverage != null &&
      (!coverage.complete || coverage.is_sparse || rejected.length > 0));
  if (!show) return null;

  const problemPairs = coverage ? pairsWithProblems(coverage) : [];
  // The conversion warnings are USD/CLP buy/sell fallbacks: name that pair when nothing else is checked.
  const titlePair =
    problemPairs.length > 0 ? problemPairs.map(fxPairLabel).join(", ") : fxPairLabel({ base: "usd", quote: "clp" });
  const unitLabel = (coverage?.unit ?? "usd").toUpperCase();

  const details = problemPairs
    .map((p) =>
      !p.complete && p.first_missing_date
        ? t("fxCoverage.missingFromDate", { pair: fxPairLabel(p), date: p.first_missing_date, unit: unitLabel })
        : p.is_sparse
          ? t("fxCoverage.sparseHistory", { pair: fxPairLabel(p), daily: p.daily_count, rows: p.row_count })
          : null
    )
    .filter((d): d is string => d != null);

  const rejectedDetail =
    rejected.length > 0
      ? t("fxCoverage.yahooRejected", {
          count: rejected.length,
          dates: rejected
            .slice(0, 5)
            .map((r) => `${r.date} (${Math.round(r.raw_clp_per_usd)})`)
            .join(", "),
        })
      : null;

  const uniqueWarnings = [...new Map(warnings.map((w) => [w.code, w])).values()];

  return (
    <div
      className="error"
      role="alert"
      style={{ lineHeight: 1.45 }}
    >
      <strong>{t("fxCoverage.title", { pair: titlePair })}</strong>
      {conversionError ? (
        <p style={{ margin: 0, fontSize: "var(--font-size-ui)" }}>{t("fxCoverage.depositConversionError", { unit: unitLabel })}</p>
      ) : null}
      {uniqueWarnings.map((w) => (
        <p key={`${w.code}-${w.date}`} style={{ margin: 0, fontSize: "var(--font-size-ui)" }}>
          {warningMessage(t, w)}
          {w.date ? (
            <span className="mono muted" style={{ marginLeft: "0.35rem" }}>
              ({w.date})
            </span>
          ) : null}
        </p>
      ))}
      {details.map((d) => (
        <p key={d} style={{ margin: 0, fontSize: "var(--font-size-ui)" }}>
          {d}
        </p>
      ))}
      {rejectedDetail ? (
        <p style={{ margin: 0, fontSize: "var(--font-size-ui)" }}>{rejectedDetail}</p>
      ) : null}
      <p style={{ margin: 0, fontSize: "var(--font-size-prose)" }}>
        {t("fxCoverage.hint")}{" "}
        <Link to="/panel/import-sync">{t("panel.importSyncTitle")}</Link>
        {" · "}
        <code className="mono">npm run backfill:yahoo-fx-usd -w nw-tracker-server</code>
        {" · "}
        <code className="mono">npm run backfill:fx-bid-ask-from-movements -w nw-tracker-server</code>
      </p>
    </div>
  );
}
