import {
  Children,
  Fragment,
  isValidElement,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from "react";

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

export type TableProps = {
  /** `<thead>…</thead>` */
  header: ReactNode;
  /**
   * `<tbody>` content: `<tr>…</tr>` nodes (arrays and fragments of rows are flattened when collapsing).
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
  const rows = collectTrNodes(children);
  const limit =
    typeof collapsedVisibleRows === "number" && collapsedVisibleRows > 0
      ? collapsedVisibleRows
      : null;
  const hasHiddenRows = limit != null && rows.length > limit;
  const visibleRows =
    limit != null && hasHiddenRows && !expanded ? rows.slice(0, limit) : null;

  return (
    <div className={wrapClassName} style={wrapStyle}>
      <div
        className="table-wrap"
        style={{
          overflowX: "auto",
          marginBottom: hasHiddenRows && !expanded ? "0.35rem" : undefined,
        }}
      >
        <table className={tableClassName} style={tableStyle}>
          {header}
          <tbody>{visibleRows != null ? visibleRows : children}</tbody>
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
