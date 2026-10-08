/**
 * Squarified treemap layout (Bruls, Huizing, van Wijk) with nested frames. Pure geometry: the
 * caller owns what a node is and how it is drawn. Frames reserve a header strip when they have
 * room for one and lay their children out in what is left; the root's children fill the root
 * rectangle (the page's own node is the container, not a drawn frame).
 */
export type Rect = { x: number; y: number; w: number; h: number };

export type LayoutAccessors<T> = {
  value: (n: T) => number;
  /** Frame children; `undefined` for a tile. */
  children: (n: T) => readonly T[] | undefined;
};

export type LayoutOptions = {
  headerHeight: number;
  /** A frame gets a header only when its rect is at least this wide AND tall (header + body). */
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

function placeChildren<T>(
  kids: readonly T[],
  inner: Rect,
  depth: number,
  acc: LayoutAccessors<T>,
  opts: LayoutOptions
): Placed<T>[] {
  const rects = squarify(kids.map(acc.value), inner);
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
    return { node, rect, depth, header, children: placeChildren(sub, body, depth + 1, acc, opts) };
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
  return placeChildren(kids, rect, 0, acc, opts);
}
