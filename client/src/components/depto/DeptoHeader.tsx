import { cn } from "../../cn";
import { useTranslation } from "../../i18n";
import { loadableClass } from "../ui/Loadable";
import { ExportToolbarButton } from "../export/ExportModal";
import type { DeptoGlanceDto, DeptoGlanceHeaderDto } from "../../types";
import { pct1, pct1Signed, signedMoney, toneOf } from "./deptoFormat";
import styles from "./Depto.module.css";
import { formatCurrency, formatMoney } from "../../format";

const BLANK = " ";

/** A share as a percent: signed only when negative («1,2%», «−0,8%»). */
function pctLoose(share: number): string {
  return share < 0 ? pct1Signed(share) : pct1(share);
}

/**
 * The head both depto pages share: the account's name, the hero in the loan currency with its
 * display-unit value under it (none when the unit is the loan currency), and the día / mes / año /
 * total strip (the property's P/L, the mortgage's financing cost) with «exportar». `glance`
 * undefined while the bundle is pending (blank figures at the loaded height).
 */
export function DeptoHeader({
  title,
  glance,
  exportPath,
  loading,
}: {
  title: string;
  glance: DeptoGlanceDto | undefined;
  exportPath: string;
  loading: boolean;
}) {
  const header = glance?.header;
  return (
    <DeptoHeaderView
      title={title}
      figures={
        header && glance
          ? {
              unit: glance.unit,
              hero: formatCurrency(header.hero_loan, glance.loan_currency),
              sub: header.hero != null ? formatMoney({ value: header.hero, currency: glance.unit }) : null,
              strip: header.strip,
            }
          : undefined
      }
      exportPath={exportPath}
      loading={loading}
    />
  );
}

/**
 * The depto header's frame over figures already picked: the hero as text (the caller formats it in
 * its currency), an optional second line, the strip in `unit`. The property and mortgage pages, and
 * the real-estate group page (its hero the properties' net equity in the unit).
 */
export function DeptoHeaderView({
  title,
  figures,
  wideHero = false,
  exportPath,
  loading,
}: {
  title: string;
  figures: { unit: string; hero: string; sub: string | null; strip: DeptoGlanceHeaderDto["strip"] } | undefined;
  /** The hero is a display-unit amount (longer than a loan-currency one): on a phone it keeps clear of «exportar». */
  wideHero?: boolean;
  /** Undefined until the page knows what it exports: no «exportar» yet. */
  exportPath: string | undefined;
  loading: boolean;
}) {
  const { t } = useTranslation();
  const header = figures;
  const unit = figures?.unit;
  const cells: { key: string; label: string; value: number | null | undefined; pct: number | null | undefined }[] = [
    { key: "day", label: t("accountDetail.depto.day"), value: header?.strip.day, pct: null },
    { key: "month", label: t("accountDetail.depto.month"), value: header?.strip.month, pct: null },
    { key: "year", label: t("accountDetail.depto.year"), value: header?.strip.year, pct: header?.strip.year_pct },
    { key: "total", label: t("accountDetail.depto.total"), value: header?.strip.total, pct: header?.strip.total_pct },
  ];
  return (
    <header className={cn(styles.scope, styles.head)}>
      <h1>{title || BLANK}</h1>
      <div className={loadableClass(loading, cn(styles.hero, wideHero && styles.heroWide))}>
        <span className={cn("mono", styles.heroBig)}>{header ? header.hero : BLANK}</span>
        {header?.sub != null ? <span className={cn("mono", styles.heroSec)}>{header.sub}</span> : null}
      </div>
      <div className={cn("mono", styles.strip)}>
        {cells.map((c) => (
          <div key={c.key} className={loadableClass(loading)}>
            <em>{c.label}</em>
            <span>
              {c.value != null && unit ? (
                <span className={styles[toneOf(c.value) ?? "muted"]}>{signedMoney(c.value, unit)}</span>
              ) : (
                BLANK
              )}
              {c.pct != null ? <span className={styles.muted}> {pctLoose(c.pct)}</span> : null}
            </span>
          </div>
        ))}
        {exportPath ? (
          <div className={styles.exp}>
            <ExportToolbarButton exportPath={exportPath} triggerClassName={styles.lnk} />
          </div>
        ) : null}
      </div>
    </header>
  );
}
