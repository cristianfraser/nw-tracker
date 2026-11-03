import { createContext, useContext, type CSSProperties, type ReactNode } from "react";
import { useDisplayPreferences } from "../../context/DisplayPreferencesContext";
import type { ChartStyle } from "../../chartStylePreference";

/**
 * The chart style a subtree renders in. Two layers, which must agree:
 * - CSS keys on the nearest `[data-chart-style]` ancestor (the `<html>` attribute the
 *   preferences provider writes, or a {@link ChartStyleScope}) — the chalk themes and the
 *   wobble filter are pure CSS (`styles/chart-sketch.css`).
 * - Components ask {@link useChartStyle} — the rough.js shapes are React (the chart wrappers
 *   inject them when the style is `rough`).
 *
 * A scope sets both: the attribute on its own element and the context for its children. With
 * no scope the hook reads the global preference.
 */
const ChartStyleScopeContext = createContext<ChartStyle | null>(null);

export function useChartStyle(): ChartStyle {
  const scoped = useContext(ChartStyleScopeContext);
  const { chartStyle } = useDisplayPreferences();
  return scoped ?? chartStyle;
}

/** Renders its children in `style`, whatever the global preference (the lab page's four columns). */
export function ChartStyleScope({
  style,
  className,
  cssStyle,
  children,
}: {
  style: ChartStyle;
  className?: string;
  cssStyle?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <ChartStyleScopeContext.Provider value={style}>
      <div data-chart-style={style} className={className} style={cssStyle}>
        {children}
      </div>
    </ChartStyleScopeContext.Provider>
  );
}
