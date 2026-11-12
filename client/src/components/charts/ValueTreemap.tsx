import type { DisplayUnit } from "../../queries/keys";
import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import i18n from "../../i18n";
import { formatCurrency, formatPct } from "../../format";
import type { SurfacePeriod } from "../../surfaceDisplayPrefs";
import type { NavValueMapColorBounds, NavValueMapNodeDto } from "../../types";
import { ChartPanelTitleRow } from "./ChartPanelTitleRow";
import { loadableClass } from "../ui/Loadable";
import { layoutTreemap, type Placed } from "./treemapLayout";
import { useChartStyle } from "./chartStyle";
import { HATCH_TUNING } from "./hatchTuning";
import { RoughRect, roughPenFor, tileHatchAngle } from "./roughShapes";

/** The display unit the map's values are in (the payload's). */
type Unit = DisplayUnit;

/** The map's node in the display unit: values picked, tiles without a value dropped. */
type MapNode = {
  dto: NavValueMapNodeDto;
  value: number;
  children?: MapNode[];
};

function unitValue(n: NavValueMapNodeDto): number | null {
  const v = n.value;
  return v != null && Number.isFinite(v) ? v : null;
}

/**
 * `depth` is relative to the page root: the root (a leaf group's own page) and its first-level
 * children (depth 1) always show what is inside — a leaf group opens into its accounts
 * (`leaf_accounts`) even with one; deeper, a leaf group opens when it holds two or more, and a
 * single account stays the group's own tile.
 */
function toMapNode(dto: NavValueMapNodeDto, unit: Unit, depth = 0): MapNode | null {
  const leafAccounts = dto.leaf_accounts ?? [];
  const opensLeaf = leafAccounts.length >= (depth <= 1 ? 1 : 2);
  const inner = dto.children ?? (opensLeaf ? leafAccounts : null);
  if (inner) {
    const children = inner.flatMap((c) => {
      const m = toMapNode(c, unit, depth + 1);
      return m ? [m] : [];
    });
    const value = children.reduce((s, c) => s + c.value, 0);
    return value > 0 ? { dto, value, children } : null;
  }
  const value = unitValue(dto);
  return value != null && value > 0 ? { dto, value } : null;
}

/**
 * Keys the server puts on value-map nodes (`navValueMap.ts`), listed so the i18n dead-key check
 * sees them: «Otros», a proxied fund's non-ETF sleeve.
 */
export const SERVER_VALUE_MAP_LABEL_KEYS = ["valueMap.otherSleeve"] as const;

function nodeLabel(n: NavValueMapNodeDto): string {
  return n.label_i18n_key ? i18n.t(n.label_i18n_key) : n.label;
}

/** Signed colour intensity in [-1, 1] against the period's fixed bound. */
export function treemapIntensity(pct: number | null | undefined, bound: number): number {
  if (pct == null || !Number.isFinite(pct) || !(bound > 0)) return 0;
  return Math.max(-1, Math.min(1, pct / bound));
}

function colorStyle(t: number): { className: string; style: CSSProperties } {
  const mix = `${Math.round(Math.abs(t) * 100)}%`;
  return {
    className: t > 0 ? "value-treemap__c--up" : t < 0 ? "value-treemap__c--down" : "value-treemap__c--flat",
    style: { ["--treemap-mix" as string]: mix },
  };
}

/**
 * The hand-drawn styles draw the map with the chart's pen (an SVG layer under the tiles, which
 * keep their labels and clicks but lose their own fill and border). SVG needs concrete
 * colours, so the treemap tokens are resolved from the element and blended here exactly as the
 * CSS `color-mix` blends them for the plain tiles.
 */
type Rgb = [number, number, number];
function cssColorToRgb(value: string): Rgb | null {
  if (typeof document === "undefined") return null;
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#000";
  ctx.fillStyle = value.trim();
  const hex = String(ctx.fillStyle);
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (m) {
    const h = m[1]!;
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  const r = /rgba?\(([^)]+)\)/.exec(hex);
  if (!r) return null;
  const [a, b, c] = r[1]!.split(",").map((x) => parseFloat(x));
  return [a!, b!, c!];
}
function mixRgb(a: Rgb, b: Rgb, t: number): string {
  const c = a.map((v, i) => Math.round(v * t + b[i]! * (1 - t)));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
type SketchPalette = { up: Rgb; down: Rgb; neutral: Rgb; outline: string; accent: string };
function sketchTileColor(pal: SketchPalette, t: number): string {
  if (t === 0) return mixRgb(pal.neutral, pal.neutral, 1);
  return mixRgb(t > 0 ? pal.up : pal.down, pal.neutral, Math.abs(t));
}
/** A node's colour as numbers (the same mix as {@link sketchTileColor}). */
function sketchTileRgb(pal: SketchPalette, t: number): Rgb {
  const a = t > 0 ? pal.up : t < 0 ? pal.down : pal.neutral;
  const k = Math.abs(t);
  return a.map((v, i) => v * k + pal.neutral[i]! * (1 - k)) as unknown as Rgb;
}
/** A near-white tinted by the node's colour: its hand-drawn border. */
const BORDER_WHITE: Rgb = [241, 245, 249];
const BORDER_TINT = 0.28;
function sketchBorderColor(pal: SketchPalette, t: number): string {
  return mixRgb(sketchTileRgb(pal, t), BORDER_WHITE, BORDER_TINT);
}
/** FNV-1a of a slug: each tile keeps its sketch across re-renders. */
function slugSeed(slug: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < slug.length; i++) {
    h ^= slug.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 2147483647 || 1;
}

/** The map is read by its colours: tiles are hatched about twice as densely as a chart bar. */
const MAP_FILL_STRENGTH = 1.9;
/** The hatch stops this far inside each outline, so the outline reads clean over the dark ground. */
const MAP_FILL_INSET = 1.6;

const LAYOUT_OPTS = { headerHeight: 20, minHeaderWidth: 72, minHeaderHeight: 46, framePadding: 3 };
/**
 * Labels: name over % when the tile fits two lines, one row when it fits one — and only when
 * the text fits whole (measured), otherwise none. A frame's header drops its % first, then
 * shortens the name.
 */
const MIN_LABEL_H = 22;
const MIN_STACKED_LABEL_H = 36;
/** Horizontal room a label loses to padding, border and the gap between name and %, in px. */
const TILE_LABEL_INSET = 8;
const TILE_ROW_GAP = 6;
const HEADER_INSET = 16;
const HEADER_GAP = 7;

type LabelKind = "tile-name" | "tile-pct" | "header";

type Hover = { node: NavValueMapNodeDto; x: number; y: number };

/**
 * Finviz-style value map of the server-built tree: tile area = current value in the display
 * unit, colour = the period's flow-adjusted return against fixed per-period bounds (the server
 * emits both; nothing is aggregated here). Frames are groups with group children and carry a
 * header strip when there is room; a click goes to the group's or account's page.
 */
export function ValueTreemap({
  title,
  titleAs = "h2",
  controls,
  root,
  bounds,
  period,
  unit,
  loading,
}: {
  title: string;
  titleAs?: "h2" | "h3";
  controls?: ReactNode;
  /** null while the first payload loads: the panel and its box render empty. */
  root: NavValueMapNodeDto | null;
  bounds: NavValueMapColorBounds | null;
  period: SurfacePeriod;
  unit: Unit;
  /** The map is not in yet or is held prior data: the panel dims; the empty box shows no message. */
  loading?: boolean;
}) {
  const navigate = useNavigate();
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<Hover | null>(null);
  const chartStyle = useChartStyle();
  const sketchPen = roughPenFor(chartStyle);
  const [palette, setPalette] = useState<SketchPalette | null>(null);
  const [focusSlug, setFocusSlug] = useState<string | null>(null);

  // Resolve the treemap tokens once the box is in the DOM (they may differ per theme).
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el || !sketchPen) return;
    const cs = getComputedStyle(el);
    const up = cssColorToRgb(cs.getPropertyValue("--treemap-up"));
    const down = cssColorToRgb(cs.getPropertyValue("--treemap-down"));
    const neutral = cssColorToRgb(cs.getPropertyValue("--treemap-neutral"));
    const outline = cs.getPropertyValue("--treemap-label").trim() || "#f8fafc";
    const accent = cs.getPropertyValue("--accent").trim() || "#3d9cf9";
    if (up && down && neutral) setPalette({ up, down, neutral, outline, accent });
  }, [sketchPen]);

  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const mapRoot = useMemo(() => (root ? toMapNode(root, unit) : null), [root, unit]);

  const placed = useMemo(() => {
    if (!mapRoot || size.w <= 0 || size.h <= 0) return [];
    return layoutTreemap<MapNode>(
      mapRoot,
      { x: 0, y: 0, w: size.w, h: size.h },
      { value: (n) => n.value, children: (n) => n.children },
      LAYOUT_OPTS
    );
  }, [mapRoot, size.w, size.h]);

  const bound = bounds?.[period] ?? 0;
  const pctOf = (n: NavValueMapNodeDto) => n.pct[period];

  const flat = useMemo(() => {
    const out: Placed<MapNode>[] = [];
    const walk = (p: Placed<MapNode>) => {
      out.push(p);
      p.children.forEach(walk);
    };
    placed.forEach(walk);
    return out;
  }, [placed]);

  const go = (n: NavValueMapNodeDto) => navigate(n.route_path);

  // Text widths, measured on hidden spans styled like the labels (null before the first paint).
  const probeRefs = useRef<Partial<Record<LabelKind, HTMLSpanElement | null>>>({});
  const textWidth = (text: string, kind: LabelKind): number | null => {
    const probe = probeRefs.current[kind];
    if (!probe) return null;
    probe.textContent = text;
    return probe.getBoundingClientRect().width;
  };
  const tileLabelMode = (w: number, h: number, name: string, pct: string): "stacked" | "row" | null => {
    if (h < MIN_LABEL_H) return null;
    const nameW = textWidth(name, "tile-name");
    const pctW = textWidth(pct, "tile-pct");
    if (nameW == null || pctW == null) return null;
    const room = w - TILE_LABEL_INSET;
    if (h >= MIN_STACKED_LABEL_H) return Math.max(nameW, pctW) <= room ? "stacked" : null;
    return nameW + TILE_ROW_GAP + pctW <= room ? "row" : null;
  };
  const headerShowsPct = (w: number, name: string, pct: string): boolean => {
    const nameW = textWidth(name, "header");
    const pctW = textWidth(pct, "header");
    return nameW != null && pctW != null && nameW + HEADER_GAP + pctW <= w - HEADER_INSET;
  };

  // A payload with no tile in this unit is a real absence only once loaded; while loading the
  // empty box below stands in.
  if (root && !mapRoot && !loading) {
    return (
      <div className="chart-grid__col">
        <ChartPanelTitleRow title={title} titleAs={titleAs} controls={controls} />
        <p className="empty muted">{i18n.t("valueMap.empty")}</p>
      </div>
    );
  }

  const tooltipNode = hover?.node ?? null;
  const tooltipValue = tooltipNode ? unitValue(tooltipNode) : null;

  return (
    <div className={loadableClass(loading, "chart-grid__col")}>
      <ChartPanelTitleRow title={title} titleAs={titleAs} controls={controls} />
      {/* Same container as the composition chart it replaces (`.chart-box`). */}
      <div className="chart-box">
        <div
          ref={boxRef}
          className={`value-treemap${sketchPen && palette ? " value-treemap--sketch" : ""}`}
          role="group"
          aria-label={i18n.t("valueMap.ariaLabel")}
          onMouseLeave={() => setHover(null)}
        >
          {sketchPen && palette ? (
            <svg className="value-treemap__sketch" width={size.w} height={size.h} aria-hidden="true">
              {flat.map((p) => {
                const dto = p.node.dto;
                const t = treemapIntensity(pctOf(dto), bound);
                const color = sketchTileColor(palette, t);
                const border = sketchBorderColor(palette, t);
                const seed = slugSeed(dto.slug);
                // The hatch leans with the move as shown: rising «/» for up or flat, falling «\» for down,
                // each tile somewhere within the series spread (its tilt on top when drawn).
                const shownPct = pctOf(dto);
                const falling = shownPct != null && Math.round(shownPct * 10000) < 0;
                const hatchAngle = tileHatchAngle(falling, seed, HATCH_TUNING.range);
                const inset = 1.5;
                if (p.node.children != null) {
                  return (
                    <g key={`sf:${dto.slug}`}>
                      {/* The header strip first, so the frame's border is drawn over it. */}
                      {p.header > 0 ? (
                        <RoughRect x={p.rect.x + inset} y={p.rect.y + inset} width={p.rect.w - 2 * inset} height={p.header - inset} fill={color} stroke={color} pen={sketchPen} seed={seed + 1} fillStrength={MAP_FILL_STRENGTH} fillInset={MAP_FILL_INSET} hatchAngle={hatchAngle} />
                      ) : null}
                      <RoughRect x={p.rect.x + inset} y={p.rect.y + inset} width={p.rect.w - 2 * inset} height={p.rect.h - 2 * inset} fill={null} stroke={border} pen={sketchPen} seed={seed} />
                    </g>
                  );
                }
                return (
                  <RoughRect key={`st:${dto.slug}`} x={p.rect.x + inset} y={p.rect.y + inset} width={p.rect.w - 2 * inset} height={p.rect.h - 2 * inset} fill={color} stroke={border} pen={sketchPen} seed={seed} fillStrength={MAP_FILL_STRENGTH} fillInset={MAP_FILL_INSET} hatchAngle={hatchAngle} />
                );
              })}
              {(() => {
                // The hover / keyboard-focus outline, hand-drawn in the accent colour (the CSS
                // outline is off in this mode). A frame highlights its header strip.
                const slug = focusSlug ?? hover?.node.slug ?? null;
                const p = slug ? flat.find((q) => q.node.dto.slug === slug) : null;
                if (!p) return null;
                const h = p.node.children != null && p.header > 0 ? p.header : p.rect.h;
                return (
                  <RoughRect
                    key={`sh:${slug}`}
                    x={p.rect.x + 1}
                    y={p.rect.y + 1}
                    width={p.rect.w - 2}
                    height={h - 2}
                    fill={null}
                    stroke={palette.accent}
                    pen={sketchPen}
                    seed={slugSeed(String(slug)) + 77}
                    loose
                  />
                );
              })()}
            </svg>
          ) : null}
          {flat.map((p) => {
            const dto = p.node.dto;
            const pct = pctOf(dto);
            const { className, style } = colorStyle(treemapIntensity(pct, bound));
            const isFrame = p.node.children != null;
            const name = nodeLabel(dto);
            const pctText = formatPct(pct == null ? null : pct * 100);
            const box: CSSProperties = {
              left: p.rect.x,
              top: p.rect.y,
              width: p.rect.w,
              height: p.rect.h,
            };
            const onMove = (e: React.MouseEvent) => {
              const r = boxRef.current?.getBoundingClientRect();
              if (!r) return;
              setHover({ node: dto, x: e.clientX - r.left, y: e.clientY - r.top });
            };
            const interaction = {
              role: "link" as const,
              tabIndex: 0,
              "aria-label": `${name} ${pctText}`,
              onClick: () => go(dto),
              onKeyDown: (e: React.KeyboardEvent) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  go(dto);
                }
              },
              onMouseMove: onMove,
              onFocus: () => setFocusSlug(dto.slug),
              onBlur: () => setFocusSlug(null),
            };
            if (isFrame) {
              return (
                <div key={`f:${dto.slug}`} className="value-treemap__frame" style={box}>
                  {p.header > 0 ? (
                    <div
                      className={`value-treemap__header ${className}`}
                      style={{ ...style, height: p.header }}
                      {...interaction}
                    >
                      <span className="value-treemap__name">{name}</span>
                      {headerShowsPct(p.rect.w, name, pctText) ? (
                        <span className="value-treemap__pct">{pctText}</span>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            }
            const labelMode = tileLabelMode(p.rect.w, p.rect.h, name, pctText);
            const showLabel = labelMode != null;
            const rowLabel = labelMode === "row";
            return (
              <div
                key={`t:${dto.slug}`}
                className={`value-treemap__tile ${showLabel ? (rowLabel ? "value-treemap__tile--row" : "") : "value-treemap__tile--bare"} ${className}`}
                style={{ ...style, ...box }}
                {...interaction}
              >
                {showLabel ? (
                  <>
                    <span className="value-treemap__name">{name}</span>
                    <span className="value-treemap__pct">{pctText}</span>
                  </>
                ) : null}
              </div>
            );
          })}
          <span
            ref={(el) => (probeRefs.current["tile-name"] = el)}
            className="value-treemap__probe value-treemap__probe--tile value-treemap__name"
            aria-hidden="true"
          />
          <span
            ref={(el) => (probeRefs.current["tile-pct"] = el)}
            className="value-treemap__probe value-treemap__probe--tile value-treemap__pct"
            aria-hidden="true"
          />
          <span
            ref={(el) => (probeRefs.current.header = el)}
            className="value-treemap__probe value-treemap__probe--header"
            aria-hidden="true"
          />
          {hover && tooltipNode && tooltipValue != null ? (
            <div
              className="value-treemap__tooltip"
              style={{
                left: hover.x > size.w - 230 ? hover.x - 220 : hover.x + 14,
                top: Math.min(Math.max(hover.y - 8, 0), Math.max(size.h - 96, 0)),
              }}
            >
              <div className="value-treemap__tooltip-title">{nodeLabel(tooltipNode)}</div>
              <div>
                <span className="muted">{i18n.t("valueMap.tooltip.value")}</span>{" "}
                {formatCurrency(tooltipValue, unit)}
              </div>
              <div>
                <span className="muted">{i18n.t("valueMap.tooltip.return")}</span>{" "}
                {formatPct(pctOf(tooltipNode) == null ? null : pctOf(tooltipNode)! * 100)}
              </div>
              <div>
                <span className="muted">{i18n.t("valueMap.tooltip.pl")}</span>{" "}
                {tooltipNode.pl[period] == null
                  ? "—"
                  : formatCurrency(tooltipNode.pl[period]!, unit)}
              </div>
              {tooltipNode.holding ? (
                <>
                  <div>
                    <span className="muted">{i18n.t("valueMap.tooltip.contribution")}</span>{" "}
                    {formatPct(
                      tooltipNode.holding.contribution_pct[period] == null
                        ? null
                        : tooltipNode.holding.contribution_pct[period]! * 100
                    )}
                  </div>
                  <div>
                    <span className="muted">{i18n.t("valueMap.tooltip.daysHeld")}</span>{" "}
                    {i18n.t("valueMap.tooltip.daysHeldValue", {
                      held: tooltipNode.holding.days_held[period].held,
                      total: tooltipNode.holding.days_held[period].total,
                    })}
                  </div>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
