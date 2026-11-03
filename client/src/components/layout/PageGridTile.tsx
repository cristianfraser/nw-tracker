import type { CSSProperties, HTMLAttributes, ReactNode } from "react";
import { cn } from "../../cn";

/**
 * One section of a page on the column grid (styles/page-grid.css, docs/layout-grid-plan.md).
 * The heading lives inside the tile, so the grid's row gap is the only space between sections.
 * `id` is the tile's stable name (`data-tile`). `order` is the tile's place in the one-stack
 * reading order (the dashboard reads it from its layout table, `dashboardLayout.ts`): on the
 * big-desktop tier the dashboard's tiles sit in two stacks (main and rail) by DOM membership,
 * and below it the stacks flatten into the page grid, where `order` restores the reading order.
 * `wide` places a tile below that band on the big desktop: its own order and span there.
 * `smallSpan` is its column span on the small desktop when it shares a row (half the width).
 */
export function PageGridTile({
  id,
  order,
  wide,
  smallSpan,
  className,
  style,
  children,
  ...rest
}: {
  id: string;
  order?: number;
  /** Big desktop, below the dashboard's band: the tile's order and column span there. */
  wide?: { order: number; span: number };
  /** Small desktop: the tile's column span when it shares a row. */
  smallSpan?: number;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
} & Omit<HTMLAttributes<HTMLElement>, "className" | "children" | "id" | "style">) {
  const vars = {
    ...style,
    ...(order == null ? null : { "--tile-order": order }),
    ...(wide ? { "--tile-order-l": wide.order, "--tile-span-l": wide.span } : null),
    ...(smallSpan == null ? null : { "--tile-span-s": smallSpan }),
  } as CSSProperties;
  return (
    <section data-tile={id} className={cn("page-tile", wide && "page-tile--wide", smallSpan != null && "page-tile--small-span", className)} style={vars} {...rest}>
      {children}
    </section>
  );
}
