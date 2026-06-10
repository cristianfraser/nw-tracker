import { Link } from "react-router-dom";
import { useTranslation } from "../../i18n";
import type { FxCoverage } from "../../types";

export function FxCoverageBanner({
  coverage,
  conversionError,
}: {
  coverage: FxCoverage | null | undefined;
  conversionError?: boolean;
}) {
  const { t } = useTranslation();
  if (!coverage) return null;

  const rejected = coverage.yahoo_rejected ?? [];
  const show =
    conversionError ||
    !coverage.complete ||
    coverage.is_sparse ||
    rejected.length > 0;
  if (!show) return null;

  const detail =
    !coverage.complete && coverage.first_missing_date
      ? t("fxCoverage.missingFromDate", { date: coverage.first_missing_date })
      : coverage.is_sparse
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
        <code className="mono">npm run backfill:sbif-fx-eur -w nw-tracker-server</code>
      </p>
    </div>
  );
}
