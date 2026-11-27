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
 * the link: a plain primary click does, on every layout. A modified or non-primary click keeps the
 * browser's own behaviour (a new tab or window, a download).
 */
export function documentClickOpensViewer(click: DocumentLinkClick): boolean {
  return click.button === 0 && !click.metaKey && !click.ctrlKey && !click.shiftKey && !click.altKey;
}
