import { Suspense, type ComponentProps, type ComponentType, type CSSProperties, type ReactNode } from "react";
import { lazyChunk, lazyComponent } from "../../lazyChunks";
import { loadableClass } from "../ui/Loadable";
import { ChartEmptyState } from "./ChartEmptyState";
import { ChartPanelTitleRow } from "./ChartPanelTitleRow";

/**
 * The charts the eager pages render, loaded from one lazy chunk (`chartsBundle.ts`: recharts and
 * the chart layer) so a page paints its layout before the chart engine arrives. Until it does,
 * each chart shows its own frame: the heading and controls (live — a Período/Rango change is a
 * new request) above a pending box at chart size, dimmed like a loading chart. The bundle is
 * the first chunk of the idle prefetch (`lazyChunks.ts`); a chart mounted after it arrived
 * renders at once, without the frame.
 */

type ChartsBundle = typeof import("./chartsBundle");
type ChartName = keyof ChartsBundle;
type ChartPropsByName = { [N in ChartName]: ComponentProps<ChartsBundle[N]> };

const chartsBundle = lazyChunk(() => import("./chartsBundle"), { first: true });

/** The bundle's `name` chart behind a Suspense showing `frame` (its props) until the chunk arrives. */
function lazyChart<N extends ChartName>(
  name: N,
  frame: (props: ChartPropsByName[N]) => ReactNode
): ComponentType<ChartPropsByName[N]> {
  return lazyChartWithProps<ChartPropsByName[N]>(name, frame);
}

// Plain type parameter for the body: JSX cannot spread props typed by the unresolved
// `ComponentProps<…[N]>` conditional.
function lazyChartWithProps<P extends object>(name: ChartName, frame: (props: P) => ReactNode) {
  const Chart = lazyComponent(chartsBundle, (m) => m[name] as unknown as ComponentType<P>);
  function LazyChart(props: P) {
    return (
      <Suspense fallback={frame(props)}>
        <Chart {...props} />
      </Suspense>
    );
  }
  LazyChart.displayName = `Lazy(${name})`;
  return LazyChart;
}

/**
 * One chart panel (a `chart-grid__col`) while the chart engine loads. A plain function, not a
 * component: this module's only components are the lazy charts (fast refresh).
 */
function panelFrame({
  title,
  titleAs,
  controls,
}: {
  title: string;
  titleAs?: "h2" | "h3";
  controls?: ReactNode;
}): ReactNode {
  return (
    <div className={loadableClass(true, "chart-grid__col")}>
      {title ? <ChartPanelTitleRow title={title} titleAs={titleAs} controls={controls} /> : null}
      <ChartEmptyState loading message="" />
    </div>
  );
}

/** CcInstallmentHistoryChart's box: no heading of its own, a fixed 280 px plot. */
const CC_HISTORIAL_BOX_STYLE: CSSProperties = { height: 280, marginTop: "0.35rem" };

export const LineChartPanel = lazyChart("LineChartPanel", panelFrame);

/** Same grid as ValuationLineCharts: its two LineChartPanels side by side or stacked. */
export const ValuationLineCharts = lazyChart("ValuationLineCharts", (p) => (
  <div
    className={
      p.chartLayout === "fullWidthStack" ? "chart-grid chart-grid--full-width-stack" : "chart-grid"
    }
  >
    {panelFrame({ title: p.primaryTitle, controls: p.primaryControls })}
    {panelFrame({ title: p.secondaryTitle, controls: p.secondaryControls })}
  </div>
));

export const MonthlyPerformanceComboChart = lazyChart("MonthlyPerformanceComboChart", panelFrame);

export const ProportionalAreaChart = lazyChart("ProportionalAreaChart", panelFrame);

export const CoverageLineChart = lazyChart("CoverageLineChart", panelFrame);

export const CcInstallmentHistoryChart = lazyChart("CcInstallmentHistoryChart", () => (
  <div className={loadableClass(true)}>
    <ChartEmptyState loading message="" boxStyle={CC_HISTORIAL_BOX_STYLE} />
  </div>
));
