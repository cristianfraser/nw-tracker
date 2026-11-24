import { Fragment, type HTMLAttributes, type ReactNode, type ThHTMLAttributes } from "react";
import { cn } from "../../cn";
import { Table, type TableProps } from "./Table";
import { TableMobileCard, TableMobileCardRow, TableMobileCardSection } from "./TableMobileCard";

/**
 * One column of a {@link ColumnTable}: its header, its cell, and how the card shows it. The
 * desktop row and the mobile card are both drawn from this one list, so they cannot drift
 * (GUIDELINES «Parallel renderings change together»).
 */
export type TableColumn<R> = {
  key: string;
  header: ReactNode;
  cell: (row: R) => ReactNode;
  /** Classes on the desktop cell (`mono`, `num`, …). */
  className?: string;
  /** Classes on the header cell. */
  headerClassName?: string;
  /** Extra attributes on the header cell (a tooltip). */
  headerProps?: ThHTMLAttributes<HTMLTableCellElement>;
  /** The card's label for this cell; defaults to the header when it is a string. */
  label?: string;
  /** The card's title: this column's cell, or what the card shows instead (one column per table). */
  title?: true | ((row: R) => ReactNode);
  /** Left off the card (shown on the desktop row only). */
  desktopOnly?: true;
  /** What the card shows for this cell when it differs from the desktop cell; null leaves the row out. */
  card?: (row: R) => ReactNode | null;
  /** Classes the card's value is wrapped in (`mono`, `muted`): the card has no cell to carry them. */
  cardClassName?: string;
  /** The card section this cell is drawn in (cells of one number share a section; default 0). */
  section?: number;
  /** Extra attributes on the desktop cell (a tooltip, a style). */
  cellProps?: (row: R) => HTMLAttributes<HTMLTableCellElement>;
  /** A sortable column (`Table`'s `data-sort-*` protocol): the row's sort value. */
  sort?: { type: "string" | "number" | "date"; value: (row: R) => string | number | null };
};

export type ColumnTableProps<R> = Omit<TableProps, "header" | "children"> & {
  rows: readonly R[];
  columns: readonly TableColumn<R>[];
  rowKey: (row: R, index: number) => string | number;
  /** Shown as one row when there are no rows (and nothing is loading). */
  emptyLabel?: ReactNode;
  loading?: boolean;
  /** On the card, before its cells (under the title). */
  cardLead?: (row: R) => ReactNode;
  /** On the card, after its cells. */
  cardTail?: (row: R) => ReactNode;
  /** Extra attributes on a row (a class, a style). */
  rowProps?: (row: R) => HTMLAttributes<HTMLTableRowElement>;
  /**
   * An open row's detail; null while closed. Desktop: a row of its own under the row, across
   * every column. Card: after its cells (and `cardTail`). With `collapsedVisibleRows` or a
   * sortable column the detail row counts and sorts as a row, so use it with neither.
   */
  rowExpansion?: (row: R) => ReactNode | null;
  /** `flat`: the card's cells sit directly under its title, with no section around them. */
  cardLayout?: "sections" | "flat";
  /**
   * The row's whole card, in place of the title + label/value card (a compact row of the
   * table's own). The columns then describe the desktop row only, so the two renderings are
   * hand-paired: keep this beside the column list and change them together.
   */
  card?: (row: R) => ReactNode;
};

/** A table drawn from one column list: desktop cells and the mobile card alike. */
export function ColumnTable<R>({
  rows,
  columns,
  rowKey,
  emptyLabel,
  loading = false,
  cardLead,
  cardTail,
  rowProps,
  rowExpansion,
  cardLayout = "sections",
  card,
  tableClassName,
  ...tableProps
}: ColumnTableProps<R>) {
  const titleColumn = columns.find((c) => c.title);
  if (!titleColumn && !card) throw new Error("ColumnTable: one column must be the card's title");
  const cardColumns = columns.filter((c) => !c.title && !c.desktopOnly);
  const sections = [...new Set(cardColumns.map((c) => c.section ?? 0))].sort((a, b) => a - b);
  const cardRows = (row: R, cols: readonly TableColumn<R>[]) =>
    cols.map((c) => {
      const value = c.card ? c.card(row) : c.cell(row);
      if (value === null) return null;
      const shown = c.cardClassName ? <span className={c.cardClassName}>{value}</span> : value;
      return (
        <TableMobileCardRow
          key={c.key}
          label={c.label ?? (typeof c.header === "string" ? c.header : c.key)}
          value={shown}
        />
      );
    });
  const cardBody = (row: R) =>
    cardLayout === "flat"
      ? cardRows(row, cardColumns)
      : sections.map((n) => (
          <TableMobileCardSection key={n}>
            {cardRows(
              row,
              cardColumns.filter((c) => (c.section ?? 0) === n)
            )}
          </TableMobileCardSection>
        ));
  const header = (
    <thead>
      <tr>
        {columns.map((c) => (
          <th
            key={c.key}
            {...c.headerProps}
            className={cn("desktop-only", c.headerClassName)}
            {...(c.sort ? { "data-sort-key": c.key, "data-sort-type": c.sort.type } : {})}
          >
            {c.header}
          </th>
        ))}
        <th className="mobile-only" aria-hidden="true" />
      </tr>
    </thead>
  );
  return (
    <Table {...tableProps} tableClassName={cn("table--parallel-mobile", tableClassName)} header={header}>
      {rows.length === 0 && !loading && emptyLabel != null ? (
        <tr>
          <td colSpan={columns.length + 1} className="muted">
            {emptyLabel}
          </td>
        </tr>
      ) : (
        rows.map((row, index) => {
          const sortAttrs: Record<string, string | number | null> = {};
          for (const c of columns) if (c.sort) sortAttrs[`data-sort-${c.key}`] = c.sort.value(row);
          const expansion = rowExpansion?.(row) ?? null;
          const key = rowKey(row, index);
          const tr = (
            <tr key={key} {...rowProps?.(row)} {...sortAttrs}>
              {columns.map((c) => (
                <td key={c.key} {...c.cellProps?.(row)} className={cn("desktop-only", c.className)}>
                  {c.cell(row)}
                </td>
              ))}
              <td className="mobile-only">
                {card ? (
                  <>
                    {card(row)}
                    {expansion === null ? null : <div>{expansion}</div>}
                  </>
                ) : (
                  <TableMobileCard
                    title={titleColumn!.title === true ? titleColumn!.cell(row) : titleColumn!.title!(row)}
                  >
                    {cardLead?.(row)}
                    {cardBody(row)}
                    {cardTail?.(row)}
                    {expansion === null ? null : <div>{expansion}</div>}
                  </TableMobileCard>
                )}
              </td>
            </tr>
          );
          if (expansion === null) return tr;
          return (
            <Fragment key={key}>
              {tr}
              <tr className="desktop-only">
                <td colSpan={columns.length}>{expansion}</td>
              </tr>
            </Fragment>
          );
        })
      )}
    </Table>
  );
}
