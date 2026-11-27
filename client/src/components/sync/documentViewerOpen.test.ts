import { describe, expect, it } from "vitest";
import { documentClickOpensViewer, type DocumentLinkClick } from "./documentViewerOpen";

const plain: DocumentLinkClick = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };

describe("documentClickOpensViewer", () => {
  it("opens the viewer on a plain click", () => {
    expect(documentClickOpensViewer(plain)).toBe(true);
  });

  it("leaves a modified or non-primary click to the browser", () => {
    for (const click of [
      { ...plain, metaKey: true },
      { ...plain, ctrlKey: true },
      { ...plain, shiftKey: true },
      { ...plain, altKey: true },
      { ...plain, button: 1 },
    ]) {
      expect(documentClickOpensViewer(click)).toBe(false);
    }
  });
});
