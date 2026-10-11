/**
 * Squarified treemap layout (Bruls, Huizing, van Wijk) with nested frames. Pure geometry: the
 * caller owns what a node is and how it is drawn. Frames reserve a header strip and lay their
 * children out in what is left; a frame squarified smaller than the header plus a body is grown
 * at its siblings' expense until it fits (sizes stay proportional everywhere else). The root's
 * children fill the root rectangle (the page's own node is the container, not a drawn frame).
 */
export type Rect = { x: number; y: number; w: number; h: number };

export type LayoutAccessors<T> = {
  value: (n: T) => number;
  /** Frame children; `undefined` for a tile. */
  children: (n: T) => readonly T[] | undefined;
};

export type LayoutOptions = {
  headerHeight: number;
  /**
   * A frame's minimum size (header + a body): a smaller one is grown at its siblings' expense.
   * A frame that still cannot reach it (its container is smaller) is drawn without a header.
   */
  minHeaderWidth: number;
  minHeaderHeight: number;
  /** Inset between a frame's edge and its children. */
  framePadding: number;
};

export type Placed<T> = {
  node: T;
  rect: Rect;
  depth: number;
  /** Header strip height inside `rect` (0 = none). */
  header: number;
  children: Placed<T>[];
};

function worstRatio(areas: readonly number[], side: number): number {
  let sum = 0;
  let max = -Infinity;
  let min = Infinity;
  for (const a of areas) {
    sum += a;
    if (a > max) max = a;
    if (a < min) min = a;
  }
  const s2 = side * side;
  const sum2 = sum * sum;
  return Math.max((s2 * max) / sum2, sum2 / (s2 * min));
}

/** Rectangles for `values` (positive, any order) tiling `rect`; result index = input index. */
export function squarify(values: readonly number[], rect: Rect): Rect[] {
  const out: Rect[] = new Array(values.length);
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v);
  const total = order.reduce((s, o) => s + o.v, 0);
  if (!(total > 0) || rect.w <= 0 || rect.h <= 0) {
    for (let i = 0; i < values.length; i++) out[i] = { x: rect.x, y: rect.y, w: 0, h: 0 };
    return out;
  }
  const scale = (rect.w * rect.h) / total;
  const areas = order.map((o) => o.v * scale);
  let rem = { ...rect };
  let i = 0;
  while (i < order.length) {
    const side = Math.min(rem.w, rem.h);
    let end = i + 1;
    let row = [areas[i]!];
    while (end < order.length) {
      const next = [...row, areas[end]!];
      if (worstRatio(next, side) <= worstRatio(row, side)) {
        row = next;
        end++;
      } else break;
    }
    const rowArea = row.reduce((s, a) => s + a, 0);
    const thickness = side > 0 ? rowArea / side : 0;
    const isLast = end >= order.length;
    if (rem.w >= rem.h) {
      // Column at the left, items stacked top to bottom.
      const colW = isLast ? rem.w : thickness;
      let y = rem.y;
      for (let k = 0; k < row.length; k++) {
        const h = k === row.length - 1 ? rem.y + rem.h - y : (row[k]! / rowArea) * rem.h;
        out[order[i + k]!.i] = { x: rem.x, y, w: colW, h };
        y += h;
      }
      rem = { x: rem.x + colW, y: rem.y, w: rem.w - colW, h: rem.h };
    } else {
      const rowH = isLast ? rem.h : thickness;
      let x = rem.x;
      for (let k = 0; k < row.length; k++) {
        const w = k === row.length - 1 ? rem.x + rem.w - x : (row[k]! / rowArea) * rem.w;
        out[order[i + k]!.i] = { x, y: rem.y, w, h: rowH };
        x += w;
      }
      rem = { x: rem.x, y: rem.y + rowH, w: rem.w, h: rem.h - rowH };
    }
    i = end;
  }
  return out;
}

/** Most rounds of growing too-small frames before taking the layout as it is. */
const FRAME_GROW_ROUNDS = 12;

/**
 * The smallest rect a node can be drawn in with every frame keeping its header: a tile needs
 * nothing; a frame needs the configured minimum, and — when it holds frames — its header and
 * padding around the largest minimum among them (so a short parent grows first, then its child
 * frames fit inside it).
 */
function minFrameSize<T>(node: T, acc: LayoutAccessors<T>, opts: LayoutOptions): { w: number; h: number } {
  const kids = acc.children(node);
  if (!kids) return { w: 0, h: 0 };
  let w = opts.minHeaderWidth;
  let h = opts.minHeaderHeight;
  for (const k of kids) {
    const m = minFrameSize(k, acc, opts);
    if (m.w === 0 && m.h === 0) continue;
    w = Math.max(w, m.w + 2 * opts.framePadding);
    h = Math.max(h, m.h + opts.headerHeight + 2 * opts.framePadding);
  }
  return { w, h };
}

/**
 * `squarify` by value, then grow each frame whose rect is under its minimum size (its weight
 * times the shortfall, a little over) and lay out again, until every frame fits or the rounds
 * run out (a container smaller than its frames' minimum).
 */
function squarifyWithFrameMinimum<T>(
  kids: readonly T[],
  inner: Rect,
  acc: LayoutAccessors<T>,
  opts: LayoutOptions,
  sizing: Sizing<T> | null
): Rect[] {
  const weights = kids.map((k) =>
    sizing ? acc.value(k) * sizing.pxPerValue + (sizing.overhead.get(k) ?? 0) : acc.value(k)
  );
  const mins = kids.map((k) => minFrameSize(k, acc, opts));
  let rects = squarify(weights, inner);
  for (let round = 0; round < FRAME_GROW_ROUNDS; round++) {
    let grew = false;
    for (let i = 0; i < kids.length; i++) {
      const r = rects[i]!;
      const m = mins[i]!;
      if (m.h === 0 || (r.w >= m.w && r.h >= m.h)) continue;
      const short = Math.max(m.w / Math.max(r.w, 1), m.h / Math.max(r.h, 1));
      weights[i] = weights[i]! * Math.min(short * 1.1, 4);
      grew = true;
    }
    if (!grew) break;
    rects = squarify(weights, inner);
  }
  return rects;
}

/**
 * Area accounting for frames: each node's area is its value at one global px-per-value plus the
 * area its own and its descendants' headers and padding take (`overhead`, measured on the
 * previous pass), so a tile inside a frame gets the same area per value as one outside it.
 */
type Sizing<T> = { pxPerValue: number; overhead: Map<T, number> };

/** Rounds of re-measuring frame overhead (it depends on the frame's own shape). */
const OVERHEAD_ROUNDS = 3;

function placeChildren<T>(
  kids: readonly T[],
  inner: Rect,
  depth: number,
  acc: LayoutAccessors<T>,
  opts: LayoutOptions,
  sizing: Sizing<T> | null
): Placed<T>[] {
  const rects = squarifyWithFrameMinimum(kids, inner, acc, opts, sizing);
  return kids.map((node, i) => {
    const rect = rects[i]!;
    const sub = acc.children(node);
    if (!sub) return { node, rect, depth, header: 0, children: [] };
    const hasHeader = rect.w >= opts.minHeaderWidth && rect.h >= opts.minHeaderHeight;
    const header = hasHeader ? opts.headerHeight : 0;
    const pad = Math.min(opts.framePadding, rect.w / 4, rect.h / 4);
    const body: Rect = {
      x: rect.x + pad,
      y: rect.y + header + pad,
      w: Math.max(0, rect.w - 2 * pad),
      h: Math.max(0, rect.h - header - 2 * pad),
    };
    return {
      node,
      rect,
      depth,
      header,
      children: placeChildren(sub, body, depth + 1, acc, opts, sizing),
    };
  });
}

/** Lay out `root`'s children inside `rect`. */
export function layoutTreemap<T>(
  root: T,
  rect: Rect,
  acc: LayoutAccessors<T>,
  opts: LayoutOptions
): Placed<T>[] {
  const kids = acc.children(root);
  if (!kids || kids.length === 0) return [];
  let placed = placeChildren(kids, rect, 0, acc, opts, null);
  const totalValue = kids.reduce((s, k) => s + acc.value(k), 0);
  if (!(totalValue > 0)) return placed;
  for (let round = 0; round < OVERHEAD_ROUNDS; round++) {
    const overhead = new Map<T, number>();
    const measure = (p: Placed<T>): number => {
      if (p.children.length === 0 && !acc.children(p.node)) return 0;
      const pad = Math.min(opts.framePadding, p.rect.w / 4, p.rect.h / 4);
      const bodyArea = Math.max(0, p.rect.w - 2 * pad) * Math.max(0, p.rect.h - p.header - 2 * pad);
      const own = p.rect.w * p.rect.h - bodyArea;
      const total = own + p.children.reduce((s, c) => s + measure(c), 0);
      overhead.set(p.node, total);
      return total;
    };
    const rootOverhead = placed.reduce((s, p) => s + measure(p), 0);
    const pxPerValue = Math.max(0, rect.w * rect.h - rootOverhead) / totalValue;
    if (!(pxPerValue > 0)) break;
    placed = placeChildren(kids, rect, 0, acc, opts, { pxPerValue, overhead });
  }
  return placed;
}
