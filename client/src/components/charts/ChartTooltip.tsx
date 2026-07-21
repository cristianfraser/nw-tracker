import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Tooltip } from "recharts";
import type { TooltipProps } from "recharts";
import { DIM_LEGEND_OPACITY } from "./chartLayout";

export type ChartTooltipEntry = NonNullable<TooltipProps<number, string>["payload"]>[number];

export const TOOLTIP_VIEWPORT_INSET_PX = 10;

/** Recharts tooltip color comes from `stroke`; hit underlays use `transparent`, which would make label text invisible. */
export function tooltipColorIsVisible(color: unknown): boolean {
  if (color == null || color === "") return false;
  const s = String(color).trim().toLowerCase();
  if (s === "transparent") return false;
  if (s === "rgba(0, 0, 0, 0)" || s === "rgba(0,0,0,0)") return false;
  if (s === "#0000" || s === "#00000000") return false;
  return true;
}

/**
 * Two `<Line>`s can share each `dataKey` (hit + visible). Recharts `payloadUniqBy={true}` keeps the first and drops
 * the visible line — leaving `color: transparent` on every row. Prefer the entry with a real stroke color per `dataKey`.
 */
export function dedupeTooltipPayloadPreferVisibleStroke(
  payload: ChartTooltipEntry[]
): ChartTooltipEntry[] {
  const out: ChartTooltipEntry[] = [];
  const indexByDataKey = new Map<string, number>();
  for (const entry of payload) {
    const key = String(entry.dataKey ?? "");
    const i = indexByDataKey.get(key);
    if (i === undefined) {
      indexByDataKey.set(key, out.length);
      out.push(entry);
      continue;
    }
    const cur = out[i]!;
    if (tooltipColorIsVisible(entry.color) && !tooltipColorIsVisible(cur.color)) {
      out[i] = entry;
    }
  }
  return out;
}

export type TooltipEdgeRect = { left: number; right: number; top: number; bottom: number };

export type ChartGuideViewBox = { x?: number; y?: number; width?: number; height?: number };

export type HorizontalGuideRect = { left: number; top: number; width: number };

/**
 * The horizontal crosshair at the hovered mouse y (recharts `coordinate.y` for horizontal-layout charts),
 * spanning the plot width. Returns null when y is unknown or outside the plot band, so the guide shows and
 * hides in lockstep with the tooltip. `viewBox` is the plot area rect (SVG pixel space, same as the dock).
 */
export function horizontalGuideRect(
  y: number | undefined,
  viewBox: ChartGuideViewBox
): HorizontalGuideRect | null {
  if (y == null || !Number.isFinite(y)) return null;
  const vx = viewBox.x ?? 0;
  const vy = viewBox.y ?? 0;
  const vw = viewBox.width ?? 0;
  const vh = viewBox.height ?? 0;
  if (y < vy || y > vy + vh) return null;
  return { left: vx, top: y, width: vw };
}

export type TooltipDockPlacement = "below" | "above";

export type TooltipDockFit = { x: number; y: number; placement: TooltipDockPlacement };

/**
 * Placement + translate offset keeping the tooltip visible: horizontal bounds are chart panel ∩ viewport;
 * a bottom collision flips the tooltip **above the plot** instead of sliding it over the lines.
 *
 * `tipBelow` must be the rect at the UN-nudged below-plot anchor; `flipRise` is how far the tooltip moves up
 * when flipped (plot height + both gaps + tooltip height). The y nudge survives only as a last resort when the
 * flipped position would overflow the viewport top too (viewport shorter than plot + tooltip).
 */
export function computeTooltipPlacement(
  tipBelow: TooltipEdgeRect,
  flipRise: number,
  panel: TooltipEdgeRect | null,
  viewport: { width: number; height: number },
  inset: number = TOOLTIP_VIEWPORT_INSET_PX
): TooltipDockFit {
  const minLeft = Math.max(inset, (panel?.left ?? 0) + inset);
  const maxRight = Math.min(viewport.width - inset, (panel?.right ?? viewport.width) - inset);
  let x = 0;
  if (tipBelow.left < minLeft) x = minLeft - tipBelow.left;
  else if (tipBelow.right > maxRight) x = maxRight - tipBelow.right;
  // Vertical handling only while the anchor context (chart panel, else the tooltip itself) is on-screen:
  // a still-mounted tooltip whose chart scrolled out of view must not be dragged back into the viewport.
  const context = panel ?? tipBelow;
  const contextVisible = context.bottom > inset && context.top < viewport.height - inset;
  if (!contextVisible) return { x, y: 0, placement: "below" };
  if (tipBelow.bottom <= viewport.height - inset) {
    // Fits below; keep it inside the top edge for the rare visible-panel-near-the-top case.
    const y = tipBelow.top < inset ? inset - tipBelow.top : 0;
    return { x, y, placement: "below" };
  }
  const aboveTop = tipBelow.top - flipRise;
  const y = aboveTop < inset ? inset - aboveTop : 0;
  return { x, y, placement: "above" };
}

/**
 * Measure the rendered dock and compute its placement. The currently applied fit is undone first so the math
 * always runs against the un-nudged below-plot rect (re-measuring an already-moved element would otherwise
 * walk the tooltip out of position again).
 */
function placementToStayInViewport(
  el: HTMLElement,
  anchors: { top: number; flipTop: number },
  applied: TooltipDockFit
): TooltipDockFit {
  const r = el.getBoundingClientRect();
  const height = r.bottom - r.top;
  const flipRise = anchors.top - (anchors.flipTop - height);
  const renderedLocalTop = (applied.placement === "above" ? anchors.flipTop - height : anchors.top) + applied.y;
  const dy = anchors.top - renderedLocalTop;
  const tipBelow = {
    left: r.left - applied.x,
    right: r.right - applied.x,
    top: r.top + dy,
    bottom: r.bottom + dy,
  };
  const panel = el.closest(".chart-box, .rates-chart-card__plot")?.getBoundingClientRect() ?? null;
  return computeTooltipPlacement(tipBelow, flipRise, panel, {
    width: window.innerWidth,
    height: window.innerHeight,
  });
}

/**
 * Tooltip container fixed just under the plot so it does not cover the lines (Recharts default follows the
 * cursor), clamped horizontally inside the chart panel / viewport and flipped above the plot when it would
 * overflow the viewport bottom.
 */
export function ChartTooltipDock({
  cx,
  top,
  flipTop,
  plotWidth,
  anchorLabel,
  children,
}: {
  /** X pixel of the hovered point (recharts `coordinate.x`); the dock centers on it. */
  cx: number;
  /** Y pixel of the dock top (plot bottom + gap). */
  top: number;
  /** Y pixel of the dock BOTTOM when flipped above the plot (plot top − gap). */
  flipTop: number;
  /** Plot-area width; clamps the dock `maxWidth`. */
  plotWidth: number;
  /** Salt for the anchor key so a label change re-measures (e.g. recharts tooltip label). */
  anchorLabel?: string;
  children: ReactNode;
}) {
  const dockRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<TooltipDockFit & { anchor: string }>({
    anchor: "",
    x: 0,
    y: 0,
    placement: "below",
  });
  const anchorKey = `${cx}|${top}|${anchorLabel ?? ""}`;
  const applied: TooltipDockFit =
    fit.anchor === anchorKey ? fit : { x: 0, y: 0, placement: "below" };

  // No dep array: content changes (focus dim, unit toggle) can change the dock size, so re-measure
  // every render; the epsilon guard stops the loop once the applied fit matches the measurement.
  useLayoutEffect(() => {
    const el = dockRef.current;
    if (!el) return;
    const next = placementToStayInViewport(el, { top, flipTop }, applied);
    if (
      fit.anchor !== anchorKey ||
      next.placement !== applied.placement ||
      Math.abs(next.x - applied.x) > 0.5 ||
      Math.abs(next.y - applied.y) > 0.5
    ) {
      setFit({ anchor: anchorKey, ...next });
    }
  });

  const baseTransform =
    applied.placement === "above"
      ? `translate(${cx}px, ${flipTop}px) translateX(-50%) translateY(-100%)`
      : `translate(${cx}px, ${top}px) translateX(-50%)`;
  return (
    <div
      ref={dockRef}
      className="line-chart-tooltip-dock"
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        transform:
          applied.x === 0 && applied.y === 0
            ? baseTransform
            : `${baseTransform} translate(${applied.x}px, ${applied.y}px)`,
        pointerEvents: "none",
        zIndex: 20,
        maxWidth: Math.min(360, plotWidth),
      }}
    >
      <div
        className="line-chart-tooltip-content"
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          padding: "10px 12px",
          boxShadow: "0 6px 20px rgba(0,0,0,0.35)",
        }}
      >
        {children}
      </div>
    </div>
  );
}

export type ChartTooltipRow = {
  key: string;
  name: string;
  value: string;
  /** Dimmer companion after the value (e.g. merged aportes acum.: `TOTAL (acumulado)`). */
  subValue?: string;
  swatchColor: string;
  /** Fade the row (another series is focused). */
  dim?: boolean;
  /** Highlight the row (this series is focused). */
  emphasized?: boolean;
};

/** Default dock content: heading + swatch/name/value list. */
export function ChartTooltipRows({
  title,
  rows,
  footer,
}: {
  title: string;
  rows: ChartTooltipRow[];
  footer?: ReactNode;
}) {
  return (
    <>
      <p style={{ margin: "0 0 6px", color: "#f1f5f9", fontSize: 13, fontWeight: 600 }}>{title}</p>
      <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
        {rows.map((r) => (
          <li
            key={r.key}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginTop: 4,
              fontSize: 13,
              opacity: r.dim ? DIM_LEGEND_OPACITY : 1,
              transition: "opacity 0.12s ease-out",
            }}
          >
            <span
              aria-hidden
              style={{ width: 10, height: 10, borderRadius: 2, background: r.swatchColor, flexShrink: 0 }}
            />
            <span style={{ color: r.emphasized ? "#f1f5f9" : "#94a3b8" }}>{r.name}</span>
            <span style={{ color: r.emphasized ? "#f1f5f9" : "#94a3b8" }}>:</span>
            <span style={{ color: r.emphasized ? "#f1f5f9" : "#e2e8f0", fontWeight: r.emphasized ? 600 : 400 }}>
              {r.value}
            </span>
            {r.subValue ? (
              <span style={{ color: "#64748b", fontWeight: 400 }}>{r.subValue}</span>
            ) : null}
          </li>
        ))}
      </ul>
      {footer ?? null}
    </>
  );
}

/** Per-chart customization of the docked tooltip; consumed by the App* chart wrappers. */
export type AppTooltipSpec = {
  formatValue: (value: number, entry: ChartTooltipEntry) => string;
  /** Row label; default `entry.name` (falls back to `dataKey`). */
  formatName?: (entry: ChartTooltipEntry) => string;
  /** Heading; default `String(label)`. */
  formatLabel?: (label: string | number | undefined) => string;
  /** Reshape/filter entries before rendering (dedupe, stripe merge, hidden series). */
  mapPayload?: (payload: ChartTooltipEntry[]) => ChartTooltipEntry[];
  /** Extra content under the rows (e.g. a hint line). */
  footer?: ReactNode;
  /** Replace the default heading + rows entirely (dock and collision handling still apply). */
  renderContent?: (p: { label: string | number | undefined; payload: ChartTooltipEntry[] }) => ReactNode;
  /** Recharts Tooltip `cursor`; default thin slate line. Pass `false` to hide. */
  cursor?: TooltipProps<number, string>["cursor"];
  /** Horizontal crosshair at the hovered mouse y, spanning the plot. Default on; pass `false` to hide. */
  horizontalGuide?: boolean;
};

export const DEFAULT_TOOLTIP_CURSOR = { stroke: "rgba(148, 163, 184, 0.45)", strokeWidth: 1 } as const;

function coerceRowValue(raw: unknown): number {
  if (typeof raw === "number") return raw;
  if (raw == null) return Number.NaN;
  const n = Number(raw);
  return n;
}

/** The `content` renderer the App* wrappers pass to recharts `<Tooltip>`. */
export function AppChartTooltipContent(props: TooltipProps<number, string> & { spec: AppTooltipSpec }) {
  const { active, payload, label, coordinate, viewBox, spec } = props;
  const mapped = payload?.length ? (spec.mapPayload ? spec.mapPayload(payload) : payload) : [];
  const cx = coordinate?.x;
  if (!active || !viewBox || cx == null || mapped.length === 0) return null;
  const guide = spec.horizontalGuide === false ? null : horizontalGuideRect(coordinate?.y, viewBox);
  const vy = viewBox.y ?? 0;
  const vw = viewBox.width ?? 0;
  const vh = viewBox.height ?? 0;
  const top = vy + vh + 4;
  const flipTop = vy - 4;

  const content = spec.renderContent ? (
    spec.renderContent({ label, payload: mapped })
  ) : (
    <ChartTooltipRows
      title={spec.formatLabel ? spec.formatLabel(label) : String(label ?? "")}
      rows={mapped.map((entry) => {
        const dataKey = String(entry.dataKey ?? entry.name ?? "");
        const v = coerceRowValue(entry.value);
        return {
          key: dataKey,
          name: spec.formatName ? spec.formatName(entry) : String(entry.name ?? dataKey),
          value: Number.isFinite(v) ? spec.formatValue(v, entry) : "—",
          swatchColor: tooltipColorIsVisible(entry.color) ? String(entry.color) : "#94a3b8",
        };
      })}
      footer={spec.footer}
    />
  );
  if (content == null) return null;

  return (
    <>
      {guide ? (
        <div
          aria-hidden
          className="line-chart-horizontal-guide"
          style={{
            position: "absolute",
            left: guide.left,
            top: guide.top,
            width: guide.width,
            height: 0,
            borderTop: `1px solid ${DEFAULT_TOOLTIP_CURSOR.stroke}`,
            pointerEvents: "none",
            zIndex: 19,
          }}
        />
      ) : null}
      <ChartTooltipDock cx={cx} top={top} flipTop={flipTop} plotWidth={vw} anchorLabel={String(label)}>
        {content}
      </ChartTooltipDock>
    </>
  );
}

/**
 * The recharts `<Tooltip>` element the App* chart wrappers render. Must stay a direct child of the chart root —
 * recharts locates Tooltip by element type, so wrapping it in another component would make it invisible.
 */
export function appTooltipElement(spec: AppTooltipSpec) {
  return (
    <Tooltip
      wrapperStyle={{ transform: "none", width: "100%", height: "100%" }}
      cursor={spec.cursor ?? DEFAULT_TOOLTIP_CURSOR}
      content={(props) => (
        <AppChartTooltipContent {...(props as TooltipProps<number, string>)} spec={spec} />
      )}
    />
  );
}
