import {
  Children,
  Fragment,
  cloneElement,
  isValidElement,
  useCallback,
  useMemo,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
} from "react";

export type TableSortDirection = "asc" | "desc";

export type TableSortState = {
  key: string;
  direction: TableSortDirection;
} | null;

type SortColumnMeta = {
  key: string;
  type: "string" | "number" | "date";
};

function collectTrNodes(children: ReactNode): ReactElement[] {
  const acc: ReactElement[] = [];
  Children.forEach(children, (node) => {
    if (node == null || node === false) return;
    if (Array.isArray(node)) {
      for (const x of node) acc.push(...collectTrNodes(x));
      return;
    }
    if (!isValidElement(node)) return;
    if (node.type === Fragment) {
      acc.push(...collectTrNodes((node.props as { children?: ReactNode }).children));
      return;
    }
    if (typeof node.type === "string" && node.type === "tr") {
      acc.push(node as ReactElement);
    }
  });
  return acc;
}

function parseSortableColumns(header: ReactNode): SortColumnMeta[] {
  const cols: SortColumnMeta[] = [];
  const visit = (node: ReactNode): void => {
    Children.forEach(node, (child) => {
      if (child == null || child === false) return;
      if (Array.isArray(child)) {
        for (const x of child) visit(x);
        return;
      }
      if (!isValidElement(child)) return;
      if (child.type === Fragment) {
        visit((child.props as { children?: ReactNode }).children);
        return;
      }
      if (child.type === "thead") {
        visit((child.props as { children?: ReactNode }).children);
        return;
      }
      if (child.type === "tr") {
        Children.forEach((child.props as { children?: ReactNode }).children, (cell) => {
          if (!isValidElement(cell) || cell.type !== "th") return;
          const props = cell.props as {
            "data-sort-key"?: string;
            "data-sort-type"?: string;
          };
          const key = props["data-sort-key"]?.trim();
          if (!key) return;
          const rawType = props["data-sort-type"];
          const type: SortColumnMeta["type"] =
            rawType === "number" ? "number" : rawType === "date" ? "date" : "string";
          cols.push({ key, type });
        });
        return;
      }
      visit((child.props as { children?: ReactNode }).children);
    });
  };
  visit(header);
  return cols;
}

function getTrSortValue(tr: ReactElement, key: string): string | number | null | undefined {
  return (tr.props as Record<string, unknown>)[`data-sort-${key}`] as
    | string
    | number
    | null
    | undefined;
}

function compareSortValues(
  a: string | number | null | undefined,
  b: string | number | null | undefined,
  type: SortColumnMeta["type"]
): number {
  if (type === "number") {
    const na = typeof a === "number" ? a : Number(a);
    const nb = typeof b === "number" ? b : Number(b);
    const va = Number.isFinite(na) ? na : 0;
    const vb = Number.isFinite(nb) ? nb : 0;
    return va - vb;
  }
  return String(a ?? "").localeCompare(String(b ?? ""), undefined, { numeric: true });
}

function compareRows(
  a: ReactElement,
  b: ReactElement,
  key: string,
  type: SortColumnMeta["type"],
  direction: TableSortDirection
): number {
  const cmp = compareSortValues(getTrSortValue(a, key), getTrSortValue(b, key), type);
  return direction === "asc" ? cmp : -cmp;
}

function enhanceHeader(
  header: ReactNode,
  sort: TableSortState,
  onToggleSort: (key: string) => void
): ReactNode {
  const mapTr = (tr: ReactElement): ReactElement => {
    const cells = Children.map((tr.props as { children?: ReactNode }).children, (cell) => {
      if (!isValidElement(cell) || cell.type !== "th") return cell;
      const props = cell.props as {
        "data-sort-key"?: string;
        className?: string;
        children?: ReactNode;
      };
      const key = props["data-sort-key"]?.trim();
      if (!key) return cell;

      const active = sort?.key === key;
      const direction = active ? sort.direction : null;
      const className = [props.className, active ? `table-th--sort-${direction}` : ""]
        .filter(Boolean)
        .join(" ");

      return cloneElement(cell, {
        ...cell.props,
        className: className || undefined,
        onClick: () => onToggleSort(key),
        "aria-sort": active
          ? direction === "asc"
            ? "ascending"
            : "descending"
          : "none",
        children: (
          <>
            {props.children}
            {active ? (
              <span className="table-sort-indicator" aria-hidden>
                {direction === "asc" ? " ▲" : " ▼"}
              </span>
            ) : null}
          </>
        ),
      } as HTMLAttributes<HTMLTableCellElement>);
    });
    return cloneElement(tr, {}, cells);
  };

  const mapNode = (node: ReactNode): ReactNode => {
    if (node == null || node === false) return node;
    if (Array.isArray(node)) return node.map(mapNode);
    if (!isValidElement(node)) return node;
    if (node.type === Fragment) {
      return cloneElement(
        node,
        {},
        Children.map((node.props as { children?: ReactNode }).children, mapNode)
      );
    }
    if (node.type === "tr") return mapTr(node);
    if (node.type === "thead") {
      return cloneElement(
        node,
        {},
        Children.map((node.props as { children?: ReactNode }).children, mapNode)
      );
    }
    const childProps = node.props as { children?: ReactNode };
    if (childProps.children == null) return node;
    return cloneElement(node, {}, Children.map(childProps.children, mapNode));
  };

  return mapNode(header);
}

export type TableProps = {
  /** `<thead>…</thead>` */
  header: ReactNode;
  /**
   * `<tbody>` content: `<tr>…</tr>` nodes (arrays and fragments of rows are flattened when collapsing).
   * Sortable columns: set `data-sort-key` on `<th>` and matching `data-sort-{key}` on each `<tr>`.
   */
  children: ReactNode;
  /**
   * When set to a positive number, the table starts collapsed to that many rows.
   * When omitted or not positive, every row is shown and no expand control is rendered.
   */
  collapsedVisibleRows?: number;
  showMoreLabel?: string;
  showLessLabel?: string;
  tableStyle?: CSSProperties;
  /** Extra class on `<table>` (e.g. `mortgage-sheet`, `hierarchy-nav-table`). */
  tableClassName?: string;
  wrapClassName?: string;
  wrapStyle?: CSSProperties;
};

/**
 * `table-wrap` + `<table>` with optional row collapse. Expand/collapse control appears only when
 * some rows are actually hidden (`collapsedVisibleRows` &lt; number of `<tr>` children).
 *
 * Column sort (optional): `data-sort-key` on `<th>`, `data-sort-type` (`string` | `number` | `date`),
 * and `data-sort-{key}` on `<tr>`. Click cycles desc → asc → default (children order).
 */
export function Table({
  header,
  children,
  collapsedVisibleRows,
  showMoreLabel = "Mostrar más…",
  showLessLabel = "Mostrar menos…",
  tableStyle,
  tableClassName,
  wrapClassName,
  wrapStyle,
}: TableProps) {
  const [expanded, setExpanded] = useState(false);
  const [sort, setSort] = useState<TableSortState>(null);

  const sortableColumns = useMemo(() => parseSortableColumns(header), [header]);
  const sortTypeByKey = useMemo(
    () => new Map(sortableColumns.map((c) => [c.key, c.type])),
    [sortableColumns]
  );
  const hasSortableColumns = sortableColumns.length > 0;
  const limit =
    typeof collapsedVisibleRows === "number" && collapsedVisibleRows > 0
      ? collapsedVisibleRows
      : null;
  /** Sort/collapse need flattened `<tr>` nodes; otherwise render `children` (e.g. recursive row components). */
  const needsRowFlattening = hasSortableColumns || limit != null;

  const onToggleSort = useCallback((key: string) => {
    setSort((prev) => {
      if (prev?.key !== key) return { key, direction: "desc" };
      if (prev.direction === "desc") return { key, direction: "asc" };
      return null;
    });
  }, []);

  const indexedRows = useMemo(
    () =>
      needsRowFlattening
        ? collectTrNodes(children).map((row, index) => ({ row, index }))
        : [],
    [children, needsRowFlattening]
  );

  const sortedRows = useMemo(() => {
    if (!needsRowFlattening) return [];
    if (!sort) return indexedRows.map((x) => x.row);
    const type = sortTypeByKey.get(sort.key) ?? "string";
    return [...indexedRows]
      .sort((a, b) => {
        const cmp = compareRows(a.row, b.row, sort.key, type, sort.direction);
        return cmp !== 0 ? cmp : a.index - b.index;
      })
      .map((x) => x.row);
  }, [indexedRows, needsRowFlattening, sort, sortTypeByKey]);

  const hasHiddenRows = needsRowFlattening && limit != null && sortedRows.length > limit;
  const bodyRows =
    needsRowFlattening && limit != null && hasHiddenRows && !expanded
      ? sortedRows.slice(0, limit)
      : sortedRows;

  const renderedHeader = hasSortableColumns
    ? enhanceHeader(header, sort, onToggleSort)
    : header;

  return (
    <div className={wrapClassName} style={wrapStyle}>
      <div
        className="table-wrap"
        style={{
          marginBottom: hasHiddenRows && !expanded ? "0.35rem" : undefined,
        }}
      >
        <table className={tableClassName} style={tableStyle}>
          {renderedHeader}
          <tbody>{needsRowFlattening ? bodyRows : children}</tbody>
        </table>
      </div>
      {hasHiddenRows ? (
        <button
          type="button"
          className="muted"
          onClick={() => setExpanded((e) => !e)}
          style={{
            margin: 0,
            padding: "0.15rem 0",
            border: "none",
            background: "none",
            cursor: "pointer",
            font: "inherit",
            fontSize: "0.82rem",
            textDecoration: "underline",
            textUnderlineOffset: "2px",
          }}
        >
          {expanded ? showLessLabel : showMoreLabel}
        </button>
      ) : null}
    </div>
  );
}
