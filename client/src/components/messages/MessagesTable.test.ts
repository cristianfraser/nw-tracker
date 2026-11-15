import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessagesTable } from "./MessagesTable";

const labels = {
  showReadAt: false,
  emptyLabel: "None",
  showMoreLabel: "More",
  showLessLabel: "Less",
  colDate: "Date",
  colTitle: "Title",
  colDetail: "Detail",
  colRead: "Read",
};

describe("MessagesTable", () => {
  it("shows a title as stored (migration 346 removed the legacy timestamp suffix from the rows)", () => {
    const html = renderToStaticMarkup(
      createElement(MessagesTable, {
        ...labels,
        rows: [
          { id: 1, kind: "log", created_at: "2031-02-03 04:05:06", read_at: null, title: "Synthetic sync finished", body: "ok" },
          { id: 2, kind: "log", created_at: "2031-02-03 04:06:07", read_at: null, title: "Synthetic run at 21:30 UTC", body: "ok" },
        ],
      })
    );
    expect(html).toContain(">Synthetic sync finished</td>");
    expect(html).toContain(">Synthetic run at 21:30 UTC</td>");
  });

  it("shows the empty label when there are no rows", () => {
    const html = renderToStaticMarkup(createElement(MessagesTable, { ...labels, rows: [] }));
    expect(html).toContain("None");
  });
});
