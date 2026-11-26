import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OpenRow, OpenRows } from "./OpenRows";

describe("OpenRows", () => {
  it("keeps a row's action outside the button that opens it", () => {
    const html = renderToStaticMarkup(
      createElement(
        OpenRows,
        null,
        createElement(OpenRow, { title: "Synthetic job", action: createElement("button", { type: "button" }, "Cancel") }, "detail")
      )
    );
    const toggle = html.slice(html.indexOf("<button"), html.indexOf("</button>"));
    expect(toggle).toContain("aria-expanded");
    expect(toggle).toContain("Synthetic job");
    expect(toggle).not.toContain("Cancel");
    expect(html).toContain("Cancel");
    // Closed: the detail is not rendered.
    expect(html).not.toContain("detail");
  });

  it("renders a row with nothing to open as plain text, with no toggle", () => {
    const html = renderToStaticMarkup(createElement(OpenRows, null, createElement(OpenRow, { title: "Synthetic name" })));
    expect(html).toContain("Synthetic name");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("aria-expanded");
  });

  it("shows the empty copy in place of the rows", () => {
    const html = renderToStaticMarkup(
      createElement(OpenRows, { empty: "Nothing yet", children: createElement(OpenRow, { title: "Synthetic name" }) })
    );
    expect(html).toContain("Nothing yet");
    expect(html).not.toContain("Synthetic name");
  });
});
