/**
 * First-paint shape of a page's card strip before the nav tree has ever arrived (a first-ever
 * visit: no cached tree, no cached snapshot). Only the paint — `PlaceholderCardsStrip` draws this
 * many nameless cards until the real strip replaces it. The nav tree is DB data the client
 * cannot derive, so the numbers are a guess at what the tree will show; they carry no meaning
 * once it is in (and never go through the nav-card-metrics lookup).
 */
export type ColdStripShape = {
  /** Row-1 summary cards (the page's own, then spread hubs). */
  summary: number;
  /** Detailed group cards from row 2 on. */
  detail: number;
};

/** Home: Net worth + Inversiones summary cards, then the four bucket cards. */
export const DASHBOARD_COLD_STRIP: ColdStripShape = { summary: 2, detail: 4 };

/** Group and Pasivos pages: the page's own summary card. */
export const GROUP_COLD_STRIP: ColdStripShape = { summary: 1, detail: 0 };
