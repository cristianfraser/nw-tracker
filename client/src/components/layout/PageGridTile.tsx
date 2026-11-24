import { useContext, type CSSProperties, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "../../cn";
import { BelowFoldHiddenContext } from "../../dashboardFold";

/**
 * One section of a page on the column grid (styles/page-grid.css, docs/layout-grid-plan.md).
 * The heading lives inside the tile, so the grid's row gap is the only space between sections.
 * `id` is the tile's stable name (`data-tile`). Tiles are drawn in DOM order at every width
 * (nothing reorders them). `wideSpan` is a dashboard tile's column span below its big-desktop
 * band (`dashboardLayout.ts`); `smallSpan` its column span on the small desktop when it shares a
 * row (half the width).
 */
export function PageGridTile({
  id,
  wideSpan,
  smallSpan,
  className,
  style,
  children,
  ...rest
}: {
  id: string;
  /** Big desktop, below the dashboard's band: the tile's column span there. */
  wideSpan?: number;
  /** Small desktop: the tile's column span when it shares a row. */
  smallSpan?: number;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
} & Omit<HTMLAttributes<HTMLElement>, "className" | "children" | "id" | "style">) {
  const vars = {
    ...style,
    ...(wideSpan == null ? null : { "--tile-span-l": wideSpan }),
    ...(smallSpan == null ? null : { "--tile-span-s": smallSpan }),
  } as CSSProperties;
  // Rendered below the fold but not shown yet (dashboardFold.ts): laid out, not painted, inert.
  const hidden = useContext(BelowFoldHiddenContext);
  const hiddenAttrs = hidden ? ({ inert: "", "aria-hidden": true } as unknown as HTMLAttributes<HTMLElement>) : null;
  return (
    <section
      data-tile={id}
      className={cn(
        "page-tile",
        wideSpan != null && "page-tile--wide",
        smallSpan != null && "page-tile--small-span",
        hidden && "page-tile--fold-hidden",
        className
      )}
      style={vars}
      {...rest}
      {...hiddenAttrs}
    >
      {children}
    </section>
  );
}
