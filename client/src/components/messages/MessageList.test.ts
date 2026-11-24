import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AppMessageRow } from "../../api";
import { MessageList } from "./MessageList";

const labels = {
  showReadAt: false,
  emptyLabel: "None",
  showMoreLabel: "More",
  showLessLabel: "Less",
};

function row(id: number, title: string, body: string): AppMessageRow {
  return { id, kind: "log", created_at: "2031-02-03 04:05:06", read_at: null, title, body };
}

describe("MessageList", () => {
  it("shows each message as one closed line: title and the detail's first line only", () => {
    const html = renderToStaticMarkup(
      createElement(MessageList, {
        ...labels,
        rows: [row(1, "Synthetic run", "2 steps, all ok.\nok    step one\nok    step two")],
      })
    );
    expect(html).toContain(">Synthetic run</span>");
    expect(html).toContain(">2 steps, all ok.</span>");
    expect(html).not.toContain("step one");
    expect(html).toContain('aria-expanded="false"');
  });

  it("shows five messages and a show-more control when there are more", () => {
    const rows = Array.from({ length: 7 }, (_, i) => row(i + 1, `Synthetic ${i + 1}`, "ok"));
    const html = renderToStaticMarkup(createElement(MessageList, { ...labels, rows }));
    expect(html).toContain("Synthetic 5");
    expect(html).not.toContain("Synthetic 6");
    expect(html).toContain("More");
  });

  it("shows the empty label when there are no rows", () => {
    const html = renderToStaticMarkup(createElement(MessageList, { ...labels, rows: [] }));
    expect(html).toContain("None");
  });
});
