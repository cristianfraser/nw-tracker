import { Fragment, useId, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "../../i18n";
import { cn } from "../../cn";
import { ChevronIcon } from "../ui/ChevronIcon";
import styles from "./TaxRows.module.css";

/**
 * One detail section of a return, folded until asked for: its heading says what it holds (a line
 * count, its headline figure, a problem in red). The body is rendered only while open.
 */
export function TaxSection({ id, title, summary, children }: { id: string; title: string; summary?: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  return (
    <section className={cn(styles.section, open && styles.sectionOpen)} data-section={id}>
      <h2 className={styles.sectionHeading}>
        <button type="button" className={styles.sectionHead} aria-expanded={open} aria-controls={open ? bodyId : undefined} onClick={() => setOpen(!open)}>
          <ChevronIcon className={styles.chevron} />
          <span className={styles.sectionTitle}>{title}</span>
          {summary != null ? <span className={styles.sectionSummary}>{summary}</span> : null}
        </button>
      </h2>
      {open ? (
        <div id={bodyId} className={styles.sectionBody}>
          {children}
        </div>
      ) : null}
    </section>
  );
}

export type TaxDetailColumn<R> = {
  key: string;
  header: string;
  cell: (row: R) => ReactNode;
  /** Text (a date, a box, a treatment) instead of a right-aligned figure. */
  text?: boolean;
  /** A sentence: the column shares the row's free width with the name and wraps, instead of taking its text's full length. */
  wrap?: boolean;
};

const PAGE = 15;

/**
 * A section's rows. Wide: columns under a header — (lead,) name, the other figures, the headline
 * figure last. Wrapped: (lead,) name and the headline on one line, the other figures named on
 * wrapped lines under it; the header keeps only the headline's name. Shows 15 rows, then more on
 * request.
 */
export function TaxDetailList<R>({
  rows,
  rowKey,
  lead,
  name,
  columns,
  headline,
  rowClassName,
}: {
  rows: readonly R[];
  rowKey: (row: R, index: number) => string | number;
  /** A date or a line number, in mono. */
  lead?: { header: string; cell: (row: R) => ReactNode };
  name: { header: string; cell: (row: R) => ReactNode };
  columns: TaxDetailColumn<R>[];
  headline: TaxDetailColumn<R>;
  rowClassName?: (row: R) => string | undefined;
}) {
  const { t } = useTranslation();
  const [shown, setShown] = useState(PAGE);
  const visible = rows.slice(0, shown);
  const template = [
    ...(lead ? ["max-content"] : []),
    "minmax(6rem, 1fr)",
    ...columns.map((c) => (c.wrap ? "minmax(8rem, 2fr)" : "max-content")),
    "max-content",
  ].join(" ");
  const frame = columns.length <= 1 ? styles.detailFrameFew : columns.length <= 4 ? styles.detailFrameSome : styles.detailFrameMany;
  const cellClass = (c: TaxDetailColumn<R>) => (c.text ? styles.text : styles.num);
  return (
    <div className={cn(styles.frame, frame)}>
      <div className={cn(styles.list, styles.detail, !lead && styles.noLead)} style={{ "--detail-cols": template } as CSSProperties}>
        <div className={cn(styles.row, styles.head, styles.detailHead)}>
          {lead ? <span>{lead.header}</span> : null}
          <span>{name.header}</span>
          {columns.map((c) => (
            <span key={c.key} className={c.text ? undefined : styles.num}>
              {c.header}
            </span>
          ))}
          <span className={headline.text ? undefined : styles.num}>
            {headline.header}
          </span>
        </div>
        {visible.map((row, i) => (
          <div key={rowKey(row, i)} className={cn(styles.row, rowClassName?.(row))}>
            {lead ? (
              <span className={styles.lead}>
                {lead.cell(row)}
              </span>
            ) : null}
            <span className={styles.name}>
              {name.cell(row)}
            </span>
            {columns.length > 0 ? (
              <span className={styles.parts}>
                {columns.map((c) => (
                  <span key={c.key} className={cellClass(c)}>
                    <span className={styles.label}>{c.header}</span>
                    {c.cell(row)}
                  </span>
                ))}
              </span>
            ) : null}
            <span className={cn(cellClass(headline), styles.strong, styles.headline)}>
              <span className="visually-hidden">{headline.header} </span>
              {headline.cell(row)}
            </span>
          </div>
        ))}
      </div>
      {rows.length > shown ? (
        <p className={styles.more}>
          <button type="button" className={styles.linkButton} onClick={() => setShown(shown + PAGE)}>
            {t("taxReturn.list.showMore", { count: Math.min(PAGE, rows.length - shown) })}
          </button>
          <button type="button" className={styles.linkButton} onClick={() => setShown(rows.length)}>
            {t("taxReturn.list.showAll", { count: rows.length })}
          </button>
          <span className="muted">{t("taxReturn.list.shown", { shown, total: rows.length })}</span>
        </p>
      ) : null}
    </div>
  );
}

/** Label and amount pairs under a heading line (a W-2's boxes). */
export function TaxPairs({ head, pairs }: { head: ReactNode; pairs: { key: string; label: string; value: string }[] }) {
  return (
    <>
      <p className={styles.pairsHead}>{head}</p>
      <dl className={styles.pairs}>
        {pairs.map((p) => (
          <Fragment key={p.key}>
            <dt>{p.label}</dt>
            <dd className={styles.num}>{p.value}</dd>
          </Fragment>
        ))}
      </dl>
    </>
  );
}
