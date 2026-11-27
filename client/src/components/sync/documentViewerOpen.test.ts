import { describe, expect, it } from "vitest";
import { documentClickOpensViewer, type DocumentLinkClick } from "./documentViewerOpen";

const plain: DocumentLinkClick = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };

describe("documentClickOpensViewer", () => {
  it("opens the viewer on a plain click, except a PDF on the narrow layout", () => {
    expect(documentClickOpensViewer("pdf", false, plain)).toBe(true);
    expect(documentClickOpensViewer("sheet", false, plain)).toBe(true);
    expect(documentClickOpensViewer("sheet", true, plain)).toBe(true);
    expect(documentClickOpensViewer("pdf", true, plain)).toBe(false);
  });

  it("leaves a modified or non-primary click to the browser", () => {
    for (const click of [
      { ...plain, metaKey: true },
      { ...plain, ctrlKey: true },
      { ...plain, shiftKey: true },
      { ...plain, altKey: true },
      { ...plain, button: 1 },
    ]) {
      expect(documentClickOpensViewer("pdf", false, click)).toBe(false);
      expect(documentClickOpensViewer("sheet", true, click)).toBe(false);
    }
  });
});
