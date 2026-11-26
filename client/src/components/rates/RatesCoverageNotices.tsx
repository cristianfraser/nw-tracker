import { Link } from "react-router-dom";
import { formatCurrencyFine, formatGroupedDecimal } from "../../format";
import { useTranslation } from "../../i18n";
import type { RatesCoverageNotice } from "../../types";
import { PageGridTile } from "../layout/PageGridTile";
import { loadableClass } from "../ui/Loadable";
import { OpenRow, OpenRows, RowFacts, StatusWord, type StatusTone } from "../ui/OpenRows";
import { ratesPairLabel } from "./ratesSeries";
import styles from "./Rates.module.css";

type NoticeCopy = {
  tone: StatusTone;
  status: string;
  first: string;
  facts: [string, string][];
};

/** The words of one notice: a status word, one line, and the figures behind it. */
function noticeCopy(n: RatesCoverageNotice, t: (key: string, vars?: Record<string, unknown>) => string): NoticeCopy {
  const pair = ratesPairLabel(n);
  switch (n.kind) {
    case "missing_rates":
      return {
        tone: "bad",
        status: t("rates.coverage.missingRates.status"),
        first: t("rates.coverage.missingRates.first", {
          pair,
          date: n.first_missing_date,
          unit: n.unit.toUpperCase(),
        }),
        facts: [
          [t("rates.coverage.factSince"), n.first_missing_date],
          [t("rates.coverage.factDays"), formatGroupedDecimal(n.missing_count, 0)],
        ],
      };
    case "sparse_history":
      return {
        tone: "bad",
        status: t("rates.coverage.sparseHistory.status"),
        first: t("rates.coverage.sparseHistory.first", {
          daily: formatGroupedDecimal(n.daily_count, 0),
          rows: formatGroupedDecimal(n.row_count, 0),
        }),
        facts: [
          [
            t("rates.coverage.factLongestGap"),
            t(n.max_gap_days === 1 ? "rates.coverage.daysOne" : "rates.coverage.days", {
              count: formatGroupedDecimal(n.max_gap_days, 0),
            }),
          ],
        ],
      };
    case "rejected_dates":
      return {
        tone: "bad",
        status: t(n.count === 1 ? "rates.coverage.rejectedDates.statusOne" : "rates.coverage.rejectedDates.status", {
          count: formatGroupedDecimal(n.count, 0),
        }),
        first: t("rates.coverage.rejectedDates.first"),
        // Each rejected date with the rate received, in the pair's quote.
        facts: n.dates.map((d) => [d.date, formatCurrencyFine(d.raw_rate, n.quote)]),
      };
    case "buy_rate_missing":
    case "sell_rate_missing":
      return {
        tone: "muted",
        status: t("rates.coverage.midRateUsed.status"),
        first: t(
          n.kind === "buy_rate_missing" ? "rates.coverage.midRateUsed.firstBuy" : "rates.coverage.midRateUsed.firstSell"
        ),
        facts: [[t("rates.coverage.factLatest"), n.date]],
      };
    case "reference_rate":
      return {
        tone: "muted",
        status: t("rates.coverage.referenceRate.status"),
        first: t("rates.coverage.referenceRate.first"),
        facts: [[t("rates.coverage.factLatest"), n.date]],
      };
  }
}

/**
 * What is wrong with the stored rate history, one row per problem (the server's
 * `coverage_notices`), opening into its figures and a link to the import sync page. Renders
 * nothing when there is none.
 */
export function RatesCoverageNotices({
  notices,
  syncStale,
  loading,
}: {
  notices: readonly RatesCoverageNotice[];
  /** The notices are a held payload's (the previous display unit's): dimmed until this unit's land. */
  loading?: boolean;
  /** A rate source's sync is stale or failed (the sync status' own list). */
  syncStale: boolean;
}) {
  const { t } = useTranslation();
  if (notices.length === 0 && !syncStale) return null;
  const syncLink = <Link to="/panel/import-sync">{t("panel.importSyncTitle")}</Link>;
  return (
    <PageGridTile id="rates-coverage" className={loadableClass(loading)} aria-label={t("rates.coverage.title")}>
      <OpenRows>
        {syncStale ? (
          <OpenRow
            title={t("rates.coverage.syncStale.title")}
            status={<StatusWord tone="bad">{t("rates.coverage.syncStale.status")}</StatusWord>}
            first={t("rates.coverage.syncStale.first")}
            action={syncLink}
          />
        ) : null}
        {notices.map((n) => {
          const copy = noticeCopy(n, t);
          return (
            <OpenRow
              key={`${n.kind}:${n.base}:${n.quote}`}
              title={<span className={styles.pair}>{ratesPairLabel(n)}</span>}
              status={<StatusWord tone={copy.tone}>{copy.status}</StatusWord>}
              first={copy.first}
              hideFirstWhenOpen
            >
              <p className="muted">{copy.first}</p>
              <RowFacts facts={[...copy.facts, [t("rates.coverage.factWhere"), syncLink]]} />
            </OpenRow>
          );
        })}
      </OpenRows>
    </PageGridTile>
  );
}
