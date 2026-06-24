import { Link } from "react-router-dom";
import { useTranslation } from "../../i18n";
import type { FxConversionWarning, FxCoverage } from "../../types";

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

  const detail =
    coverage && !coverage.complete && coverage.first_missing_date
      ? t("fxCoverage.missingFromDate", { date: coverage.first_missing_date })
      : coverage?.is_sparse
        ? t("fxCoverage.sparseHistory", {
            daily: coverage.daily_count,
            rows: coverage.row_count,
          })
        : null;

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
      style={{
        margin: "0 0 1rem",
        padding: "0.65rem 0.85rem",
        borderRadius: 8,
        border: "1px solid var(--error-border, #c44)",
        background: "var(--error-bg, rgba(180, 40, 40, 0.12))",
        lineHeight: 1.45,
        maxWidth: "58rem",
      }}
    >
      <strong>{t("fxCoverage.title")}</strong>
      {conversionError ? (
        <p style={{ margin: "0.35rem 0 0", fontSize: "0.92rem" }}>{t("fxCoverage.depositConversionError")}</p>
      ) : null}
      {uniqueWarnings.map((w) => (
        <p key={`${w.code}-${w.date}`} style={{ margin: "0.35rem 0 0", fontSize: "0.92rem" }}>
          {warningMessage(t, w)}
          {w.date ? (
            <span className="mono muted" style={{ marginLeft: "0.35rem" }}>
              ({w.date})
            </span>
          ) : null}
        </p>
      ))}
      {detail ? (
        <p style={{ margin: "0.35rem 0 0", fontSize: "0.92rem" }}>{detail}</p>
      ) : null}
      {rejectedDetail ? (
        <p style={{ margin: "0.35rem 0 0", fontSize: "0.92rem" }}>{rejectedDetail}</p>
      ) : null}
      <p style={{ margin: "0.35rem 0 0", fontSize: "0.85rem" }}>
        {t("fxCoverage.hint")}{" "}
        <Link to="/panel/import-sync">{t("sidebar.importSync")}</Link>
        {" · "}
        <code className="mono">npm run backfill:yahoo-fx-usd -w nw-tracker-server</code>
        {" · "}
        <code className="mono">npm run backfill:fx-bid-ask-from-movements -w nw-tracker-server</code>
      </p>
    </div>
  );
}
