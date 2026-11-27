import type { ImportSyncDocumentPreviewKind } from "../../types";

/** The parts of a click on a document link that decide where it opens. */
export type DocumentLinkClick = {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
};

/**
 * Whether a click on a matrix cell's document link opens the in-app viewer instead of following
 * the link. A modified or non-primary click keeps the browser's own behaviour (a new tab or
 * window, a download); a PDF on the narrow layout follows the link too — the width is a proxy for
 * browsers that do not show a PDF in an iframe (mobile ones). A workbook has no browser rendering,
 * so it always opens the viewer.
 */
export function documentClickOpensViewer(
  kind: ImportSyncDocumentPreviewKind,
  narrowViewport: boolean,
  click: DocumentLinkClick
): boolean {
  if (click.button !== 0 || click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) return false;
  return plainClickOpensViewer(kind, narrowViewport);
}

/** Whether a plain click opens the viewer (the link then says it opens a dialog). */
export function plainClickOpensViewer(kind: ImportSyncDocumentPreviewKind, narrowViewport: boolean): boolean {
  return kind === "sheet" || !narrowViewport;
}
