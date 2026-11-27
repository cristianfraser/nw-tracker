import { describe, expect, it } from "vitest";
import { pdfErrorKind } from "./pdfViewerErrors";

/** A stand-in for a pdf.js exception: what crosses from its worker is a name and fields. */
const pdfjsError = (name: string, fields: Record<string, unknown> = {}) => Object.assign(new Error("raw"), { name, ...fields });

describe("pdfErrorKind", () => {
  it("tells a missing file and a broken one from everything else", () => {
    expect(pdfErrorKind(pdfjsError("ResponseException", { status: 404, missing: true }))).toBe("missing");
    expect(pdfErrorKind(pdfjsError("ResponseException", { status: 500 }))).toBe("other");
    expect(pdfErrorKind(pdfjsError("InvalidPDFException"))).toBe("invalid");
    expect(pdfErrorKind(new TypeError("Failed to fetch dynamically imported module"))).toBe("other");
    expect(pdfErrorKind("boom")).toBe("other");
  });
});
