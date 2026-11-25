import type { ReactNode } from "react";
import { cn } from "../../cn";
import { useTranslation } from "../../i18n";
import { formatMoney } from "../../format";
import { loadableClass } from "../ui/Loadable";
import { signedMoney, toneOf } from "../depto/deptoFormat";
import depto from "../depto/Depto.module.css";
import styles from "./MortgageGroup.module.css";

const BLANK = "\u00a0";

/**
 * The head of a debt page — the mortgage page's look: the title, the amount owed in the unit with
 * an optional second line, and the día / mes / año / total financing-cost strip (negative = cost).
 * The mortgage group page and the Liabilities page; the figures are the server's. Pending: blank
 * and dimmed; a period no member has reads «—».
 */
export function DebtGlanceHeader({
  title,
  figures,
  sub,
  loading,
}: {
  title: string;
  figures: { unit: string; value: number; strip: { day: number | null; month: number | null; year: number | null; total: number | null } } | undefined;
  sub?: ReactNode;
  loading: boolean;
}) {
  const { t } = useTranslation();
  const strip = figures?.strip;
  const cells = [
    { key: "day", label: t("accountDetail.depto.day"), value: strip?.day },
    { key: "month", label: t("accountDetail.depto.month"), value: strip?.month },
    { key: "year", label: t("accountDetail.depto.year"), value: strip?.year },
    { key: "total", label: t("accountDetail.depto.total"), value: strip?.total },
  ];
  return (
    <header className={cn(depto.scope, depto.head)}>
      <h1>{title || BLANK}</h1>
      <div className={loadableClass(loading, depto.hero)}>
        <span className={cn("mono", depto.heroBig)}>
          {figures ? formatMoney({ value: figures.value, currency: figures.unit }) : BLANK}
        </span>
        {sub != null ? <span className={cn("mono", depto.heroSec)}>{sub}</span> : null}
      </div>
      <div className={cn("mono", depto.strip, styles.headStrip)}>
        {cells.map((c) => (
          <div key={c.key} className={loadableClass(loading)}>
            <em>{c.label}</em>
            <span>
              {figures == null ? (
                BLANK
              ) : c.value != null ? (
                <span className={depto[toneOf(c.value) ?? "muted"]}>{signedMoney(c.value, figures.unit)}</span>
              ) : (
                <span className={depto.muted}>—</span>
              )}
            </span>
          </div>
        ))}
      </div>
    </header>
  );
}
