import { Fragment, useState, type ReactNode } from "react";
import { useTranslation } from "../../i18n";
import { cn } from "../../cn";
import { loadableClass } from "../ui/Loadable";
import styles from "./TaxRows.module.css";

/** One code of the F22 or one line of the 1040, as the server states it. */
export type TaxCodeRow = {
  key: string;
  code: string;
  concept: string;
  /** The group the row is drawn under (the server's, in the list's order). */
  group: string;
  filed: number | null;
  informed: number | null;
  draft: number | null;
  /** Draft less filed where the draft changes the filed value. */
  difference: number | null;
  changed: boolean;
  /** The third-party figure is unlike the filed one (or the draft's, with no filed form). */
  informedDiffers: boolean;
  /** Listed by «Differences»: the server's flag. */
  flagged: boolean;
  /** Every source that states the row states the same value. */
  sourcesAgree: boolean;
  estimated: boolean;
  strong: boolean;
  faint: boolean;
};

type View = "all" | "flagged";

/**
 * A return's codes against its sources. Wide: code, concept, filed, (informed,) draft and the
 * difference under a header; a row whose sources agree prints its repeated values muted. Wrapped:
 * code, concept, the value and a mark per source that states it; a row whose sources differ adds
 * a line naming each value. A code the draft changes carries a red rule, a third-party figure
 * that differs an amber rule; «Differences» lists only those.
 */
export function TaxCodeList({
  title,
  rows,
  flaggedCount,
  withInformed,
  money,
  groupLabel,
  labels,
  loading,
  note,
}: {
  title: string;
  rows: TaxCodeRow[];
  /** How many rows «Differences» lists (the server's count). */
  flaggedCount: number;
  /** The F22 has a third source, what third parties informed; the 1040 does not. */
  withInformed: boolean;
  money: (n: number) => string;
  groupLabel: (group: string) => string;
  labels: { code: string; concept: string; filed: string; informed: string; draft: string; difference: string; estimated: string };
  loading?: boolean;
  note?: ReactNode;
}) {
  const { t } = useTranslation();
  const [view, setView] = useState<View>("all");
  const shown = view === "flagged" ? rows.filter((r) => r.flagged) : rows;
  const cell = (n: number | null) => (n == null ? "—" : money(n));
  const value = (label: string, n: number | null, className?: string, prefix = "") => (
    <span className={cn(styles.num, n == null && styles.empty, className)}>
      <span className={styles.label}>{label}</span>
      {prefix}
      {cell(n)}
    </span>
  );
  let group: string | null = null;
  return (
    <>
      <div className="chart-panel-title-row">
        <h2>{title}</h2>
        <div className="surface-controls">
          <span className="surface-controls__set" role="group" aria-label={t("taxReturn.list.viewLabel")}>
            {(["all", "flagged"] as const).map((v) => (
              <button key={v} type="button" className={v === view ? "is-on" : undefined} aria-pressed={v === view} onClick={() => setView(v)}>
                {v === "all" ? t("taxReturn.list.viewAll") : t("taxReturn.list.viewFlagged", { count: flaggedCount })}
              </button>
            ))}
          </span>
        </div>
      </div>
      <div className={cn(styles.frame, withInformed ? styles.codeFrame : styles.codeFrameTwo, loadableClass(loading))}>
        <p className={styles.legend} aria-hidden>
          <span>
            <i className={cn(styles.mark, styles.markFiled)} />
            {labels.filed}
          </span>
          {withInformed ? (
            <span>
              <i className={cn(styles.mark, styles.markInformed)} />
              {labels.informed}
            </span>
          ) : null}
          <span>
            <i className={cn(styles.mark, styles.markDraft)} />
            {labels.draft}
          </span>
        </p>
        <div className={cn(styles.list, withInformed ? styles.codes : styles.codesTwo)}>
          <div className={cn(styles.row, styles.head, styles.codeRow, styles.codeHead)}>
            <span>{labels.code}</span>
            <span>{labels.concept}</span>
            <span className={styles.num}>
              {labels.filed}
            </span>
            {withInformed ? (
              <span className={styles.num}>
                {labels.informed}
              </span>
            ) : null}
            <span className={styles.num}>
              {labels.draft}
            </span>
            <span className={styles.num}>
              {labels.difference}
            </span>
          </div>
          {shown.map((r) => {
            const heading = r.group !== group ? groupLabel(r.group) : null;
            group = r.group;
            // A repeated value is quiet beside the filed one it repeats.
            const repeat = r.sourcesAgree && r.filed != null ? styles.quiet : undefined;
            const approx = r.estimated ? "≈ " : "";
            const stated = [
              r.filed != null ? labels.filed : null,
              withInformed && r.informed != null ? labels.informed : null,
              r.draft != null ? labels.draft : null,
            ].filter((x): x is string => x != null);
            return (
              <Fragment key={r.key}>
                {heading != null ? (
                  <div className={styles.group} role="heading" aria-level={3}>
                    {heading}
                  </div>
                ) : null}
                <div
                 
                  className={cn(
                    styles.row,
                    styles.codeRow,
                    r.strong && styles.strong,
                    r.faint && styles.faint,
                    r.changed ? styles.changed : r.informedDiffers ? styles.mismatch : undefined,
                    !r.sourcesAgree && styles.differs
                  )}
                >
                  <span className={styles.lead}>
                    {r.code}
                  </span>
                  <span className={styles.name}>
                    {r.concept}
                  </span>
                  {/* Wrapped only: the row's one value and which sources state it. */}
                  <span className={cn(styles.num, styles.one, r.changed && styles.bad)} title={r.estimated ? labels.estimated : undefined}>
                    <span className="visually-hidden">{stated.join(", ")}: </span>
                    {approx}
                    {cell(r.draft ?? r.filed ?? r.informed)}
                  </span>
                  <span className={styles.marks} title={stated.join(" · ")} aria-hidden>
                    <i className={cn(styles.mark, r.filed != null && styles.markFiled)} />
                    {withInformed ? <i className={cn(styles.mark, r.informed != null && styles.markInformed)} /> : null}
                    <i className={cn(styles.mark, r.draft != null && styles.markDraft)} />
                  </span>
                  <span className={styles.values}>
                    {value(labels.filed, r.filed)}
                    {withInformed ? value(labels.informed, r.informed, r.informedDiffers ? styles.warn : repeat) : null}
                    <span
                   
                      className={cn(styles.num, r.draft == null && styles.empty, repeat)}
                      title={r.estimated ? labels.estimated : undefined}
                    >
                      <span className={styles.label}>{labels.draft}</span>
                      {approx}
                      {cell(r.draft)}
                    </span>
                    <span className={cn(styles.num, styles.bad, r.difference == null && styles.empty)}>
                      {r.difference != null ? (
                        <>
                          <span className={styles.label}>{labels.difference}</span>
                          {money(r.difference)}
                        </>
                      ) : null}
                    </span>
                  </span>
                </div>
              </Fragment>
            );
          })}
        </div>
        {view === "flagged" && shown.length === 0 && !loading ? <p className={styles.listNote}>{t("taxReturn.list.noneFlagged")}</p> : null}
        {note}
      </div>
    </>
  );
}
