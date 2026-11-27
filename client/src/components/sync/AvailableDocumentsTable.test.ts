import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import type { ImportSyncDocumentCell, ImportSyncDocumentCoverageResponse, ImportSyncDocumentRef } from "../../types";
import { AvailableDocumentsTable } from "./AvailableDocumentsTable";

/** A synthetic server-built document ref, as the coverage payload carries it. */
const doc = (file_name: string): ImportSyncDocumentRef => ({
  file_name,
  preview_kind: "pdf",
  view_href: `/api/import-sync/documents/synthetic/${file_name}/file`,
  download_href: `/api/import-sync/documents/synthetic/${file_name}/file?download=1`,
  sheet_href: null,
});

const cell = (state: ImportSyncDocumentCell["state"], file_name: string | null = null): ImportSyncDocumentCell => ({
  imported: state === "imported" || state === "imported_no_file",
  document: file_name ? doc(file_name) : null,
  state,
});

/** Two synthetic columns over two years; the second column starts in 2031 and misses a month. */
const coverage: ImportSyncDocumentCoverageResponse = {
  months: ["2031-02", "2031-01", "2030-12"],
  accounts: [
    { account_id: 901, label: "Synthetic checking", document_kind: "checking_cartola" },
    { account_id: 902, label: "Synthetic card", document_kind: "cc_statement" },
  ],
  cells: [
    [cell("imported", "a-2031-02.pdf"), cell("missing")],
    [cell("imported_no_file"), cell("imported", "b-2031-01.pdf")],
    [cell("imported", "a-2030-12.pdf"), cell("before_first")],
  ],
  years: [
    { year: 2031, month_indexes: [0, 1], columns: [{ counted: 2, imported: 2 }, { counted: 2, imported: 1 }], columns_counted: 2, columns_complete: 1, incomplete_columns: [1] },
    { year: 2030, month_indexes: [2], columns: [{ counted: 1, imported: 1 }, null], columns_counted: 1, columns_complete: 1, incomplete_columns: [] },
  ],
};

function render(data: ImportSyncDocumentCoverageResponse | undefined) {
  return renderToStaticMarkup(createElement(StaticRouter, { location: "/" }, createElement(AvailableDocumentsTable, { data })));
}

describe("AvailableDocumentsTable", () => {
  it("shows a line per year naming the incomplete columns, the newest year open on its months", () => {
    const html = render(coverage);
    // 2031: one of two columns complete, the card short by one; open, with the server's file link and the missing month.
    expect(html).toContain("Synthetic card 1/2");
    expect(html).not.toContain("Synthetic checking 2/2");
    expect(html).toContain('href="/api/import-sync/documents/synthetic/a-2031-02.pdf/file"');
    expect(html).toMatch(/aria-label="Synthetic card: [^"]*2031-02[^"]*"/);
    // 2030 is closed: its month's file is not in the markup.
    expect(html).not.toContain("a-2030-12.pdf");
    expect(html.match(/aria-expanded="true"/g)).toHaveLength(1);
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(1);
  });

  it("says so when no account has monthly documents", () => {
    const html = render({ months: [], accounts: [], cells: [], years: [] });
    expect(html).not.toContain("aria-expanded");
    expect(html).toContain("<p");
  });
});
