import type { HTMLAttributes, ReactNode } from "react";
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
  /** The card's label for this cell; defaults to the header when it is a string. */
  label?: string;
  /** The card's title: this column's cell, or what the card shows instead (one column per table). */
  title?: true | ((row: R) => ReactNode);
  /** Left off the card (shown on the desktop row only). */
  desktopOnly?: true;
  /** A sortable column (`Table`'s `data-sort-*` protocol): the row's sort value. */
  sort?: { type: "string" | "number" | "date"; value: (row: R) => string | number | null };
};

export type ColumnTableProps<R> = Omit<TableProps, "header" | "children"> & {
  rows: readonly R[];
  columns: readonly TableColumn<R>[];
  rowKey: (row: R) => string | number;
  /** Shown as one row when there are no rows (and nothing is loading). */
  emptyLabel?: ReactNode;
  loading?: boolean;
  /** On the card, before its cells (under the title). */
  cardLead?: (row: R) => ReactNode;
  /** On the card, after its cells. */
  cardTail?: (row: R) => ReactNode;
  /** Extra attributes on a row (a class, a style). */
  rowProps?: (row: R) => HTMLAttributes<HTMLTableRowElement>;
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
  tableClassName,
  ...tableProps
}: ColumnTableProps<R>) {
  const titleColumn = columns.find((c) => c.title);
  if (!titleColumn) throw new Error("ColumnTable: one column must be the card's title");
  const header = (
    <thead>
      <tr>
        {columns.map((c) => (
          <th
            key={c.key}
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
        rows.map((row) => {
          const sortAttrs: Record<string, string | number | null> = {};
          for (const c of columns) if (c.sort) sortAttrs[`data-sort-${c.key}`] = c.sort.value(row);
          return (
            <tr key={rowKey(row)} {...rowProps?.(row)} {...sortAttrs}>
              {columns.map((c) => (
                <td key={c.key} className={cn("desktop-only", c.className)}>
                  {c.cell(row)}
                </td>
              ))}
              <td className="mobile-only">
                <TableMobileCard
                  title={titleColumn.title === true ? titleColumn.cell(row) : titleColumn.title!(row)}
                >
                  {cardLead?.(row)}
                  <TableMobileCardSection>
                    {columns
                      .filter((c) => !c.title && !c.desktopOnly)
                      .map((c) => (
                        <TableMobileCardRow
                          key={c.key}
                          label={c.label ?? (typeof c.header === "string" ? c.header : c.key)}
                          value={c.cell(row)}
                        />
                      ))}
                  </TableMobileCardSection>
                  {cardTail?.(row)}
                </TableMobileCard>
              </td>
            </tr>
          );
        })
      )}
    </Table>
  );
}
