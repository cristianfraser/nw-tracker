import type { CSSProperties, HTMLAttributes, ReactNode } from "react";
import { cn } from "../../cn";

/**
 * One section of a page on the column grid (styles/page-grid.css, docs/layout-grid-plan.md).
 * The heading lives inside the tile, so the grid's row gap is the only space between sections.
 * `id` is the tile's stable name (`data-tile`). `order` is the tile's place in the one-stack
 * reading order (the dashboard reads it from its layout table, `dashboardLayout.ts`): on the
 * big-desktop tier the dashboard's tiles sit in two stacks (main and rail) by DOM membership,
 * and below it the stacks flatten into the page grid, where `order` restores the reading order.
 */
export function PageGridTile({
  id,
  order,
  className,
  style,
  children,
  ...rest
}: {
  id: string;
  order?: number;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
} & Omit<HTMLAttributes<HTMLElement>, "className" | "children" | "id" | "style">) {
  const vars = order == null ? style : ({ ...style, "--tile-order": order } as CSSProperties);
  return (
    <section data-tile={id} className={cn("page-tile", className)} style={vars} {...rest}>
      {children}
    </section>
  );
}
