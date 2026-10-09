import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../cn";

/**
 * The one loading state. A surface (page body, section, chart, table) always renders its frame
 * and whatever values it has — zero placeholders, held prior data, an empty table — and this
 * wrapper dims it (`.is-loading`: opacity .55, inert) while `loading` is true. No view is ever
 * replaced by a «Cargando…» screen, and nothing shows loading text: a first-ever visit paints
 * blank shapes (PlaceholderCardsStrip, an empty title block) and a chart slot its own frame while
 * its chunk loads (lazyCharts.tsx). Nested markers never compound (base.css), so a page body and
 * a chart inside it can each carry one.
 */
export function Loadable({
  loading,
  className,
  children,
  ...rest
}: {
  loading: boolean;
  className?: string;
  children?: ReactNode;
} & Omit<HTMLAttributes<HTMLDivElement>, "className" | "children">) {
  return (
    <div className={loadableClass(loading, className)} aria-busy={loading || undefined} {...rest}>
      {children}
    </div>
  );
}

/** The same marker as a class string, for a component that already owns its root element. */
export function loadableClass(loading: boolean | undefined, ...classes: (string | false | null | undefined)[]): string {
  return cn("loadable", loading && "is-loading", ...classes);
}
