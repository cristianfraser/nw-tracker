# Import-sync document viewer — plan

Branch `claude/doc-viewer` (worktree `.claude/worktrees/doc-viewer`).

## Problem

The import-sync coverage matrix links each month's document with a `file:///…` URL built from
an absolute path on the server's disk (`cell.file_path`). The files now live on the home
server, so the links are dead in every browser that is not on that machine.

## Goal

Click a cell → see the document in-app, with a Download button. PDFs (card statements,
cartolas) and XLSX (older checking cartolas) both preview.

## Contract (done first, `server/contracts/src/dto/sync.ts`)

- `ImportSyncDocumentCell.file_path` is replaced by `document: ImportSyncDocumentRef | null`:
  `{ file_name, preview_kind: "pdf" | "sheet", view_href, download_href, sheet_href }`.
  The server builds the links; the client only picks. Absolute paths no longer leave the server.
- `ImportSyncSheetPreviewResponse`: `{ file_name, sheets: [{ name, rows: string[][] }] }`.

## Wave 1 — server

- New module `server/src/importSyncDocumentFile.ts`:
  - find the matrix column for `(accountId, slot)` among the coverage's own columns;
  - resolve the month's file with `buildImportSyncDocumentPathsByMonth` (the client never
    sends a path or a file name);
  - `preview_kind` from the extension (`.pdf` → `pdf`, `.xlsx` → `sheet`; anything else throws);
  - build the `ImportSyncDocumentRef` for a cell;
  - read a workbook into displayed text with SheetJS (already a server dependency).
- Routes in `server/src/routes/sync.ts`:
  - `GET /api/import-sync/documents/:accountId/:month/file[?slot=clp|usd][&download=1]` —
    `res.sendFile` (range requests), `Content-Disposition` inline or attachment with the file
    name (RFC 5987 for non-ASCII), `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`.
  - `GET /api/import-sync/documents/:accountId/:month/sheet[?slot=…]` → sheet preview; 400 for a PDF.
  - Unknown column or month without a file → 404; malformed params → 400.
- `buildImportSyncDocumentCoveragePayload` emits `document` instead of `file_path`.
- Tests with synthetic fixtures (temp folders through the `CFRASER_*` env overrides, a prefixed
  account, cleaned up).
- AGENTS.md «Import sources vs runtime»: the documents route is the one runtime reader of
  those files, and only to hand the file itself to the page.

## Wave 2 — client

- `DocumentViewerModal` (`client/src/components/sync/`), on the shared `Modal`:
  - `pdf` → `<iframe src={view_href}>` (the browser's viewer);
  - `sheet` → fetch `sheet_href`, render a scrollable table with a sticky first row and sheet
    tabs when the workbook has more than one sheet;
  - header actions: Download (`download_href`) and Open in new tab (`view_href`, PDFs only).
- The matrix cell stays an `<a href={view_href} target="_blank">` (cmd/middle-click open a tab);
  a plain click opens the modal. On narrow screens a PDF cell keeps the plain link (mobile
  browsers do not render PDFs inside an iframe); a sheet opens the modal everywhere.
- i18n keys in `master.json` (+ generate); `localFileUrl.ts` goes when unused.

## After each wave

A review agent reads the wave's diff cold; findings are fixed before the next step.
Final: `npm run test` in `server/` and `client/`, `npm run check:conventions`, and a pass in
the browser against a copy of the home database.
