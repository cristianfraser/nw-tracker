import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ColumnTable, type TableColumn } from "./ColumnTable";

type Row = { id: number; name: string; amount: number };
const columns: TableColumn<Row>[] = [
  { key: "name", header: "Name", cell: (r) => r.name, title: true },
  { key: "amount", header: "Amount", className: "mono", cell: (r) => String(r.amount) },
  { key: "note", header: "Note", cell: () => "desk", desktopOnly: true },
];

describe("ColumnTable", () => {
  it("draws the desktop row and the mobile card from one column list", () => {
    const html = renderToStaticMarkup(
      createElement(ColumnTable<Row>, { rows: [{ id: 1, name: "Alpha", amount: 42 }], columns, rowKey: (r) => r.id })
    );
    expect(html).toContain('<td class="desktop-only mono">42</td>');
    expect(html).toContain('table-mobile-card__title">Alpha</div>');
    expect(html).toContain('table-mobile-card__label">Amount</span>');
    // A desktop-only column is left off the card.
    expect(html).not.toContain('table-mobile-card__label">Note</span>');
  });

  it("shows the empty label as one row", () => {
    const html = renderToStaticMarkup(
      createElement(ColumnTable<Row>, { rows: [], columns, rowKey: (r) => r.id, emptyLabel: "Nothing" })
    );
    expect(html).toContain('<td colSpan="4" class="muted">Nothing</td>');
  });

  it("groups card cells by section, takes a card-only value, leaves out null cells, or draws them flat", () => {
    const cols: TableColumn<Row>[] = [
      { key: "name", header: "Name", cell: (r) => r.name, title: true },
      { key: "a", header: "A", cell: () => "desk-a", card: () => "card-a" },
      { key: "b", header: "B", cell: () => "b", section: 1 },
      { key: "c", header: "C", cell: () => "c", card: () => null },
    ];
    const rows = [{ id: 1, name: "Alpha", amount: 1 }];
    const html = renderToStaticMarkup(createElement(ColumnTable<Row>, { rows, columns: cols, rowKey: (r) => r.id }));
    expect(html.match(/table-mobile-card__section/g)).toHaveLength(2);
    expect(html).toContain("card-a");
    expect(html).toContain('<td class="desktop-only">desk-a</td>');
    expect(html).not.toContain('table-mobile-card__label">C</span>');
    const flat = renderToStaticMarkup(
      createElement(ColumnTable<Row>, { rows, columns: cols, rowKey: (r) => r.id, cardLayout: "flat" })
    );
    expect(flat).not.toContain("table-mobile-card__section");
  });
});
