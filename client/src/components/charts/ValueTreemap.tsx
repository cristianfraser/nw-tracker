import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import i18n from "../../i18n";
import { formatCurrency, formatPct } from "../../format";
import type { SurfacePeriod } from "../../surfaceDisplayPrefs";
import type { NavValueMapColorBounds, NavValueMapNodeDto } from "../../types";
import { ChartPanelTitleRow } from "./ChartPanelTitleRow";
import { layoutTreemap, type Placed } from "./treemapLayout";

type Unit = "clp" | "usd";

/** The map's node in the display unit: values picked, tiles without a value dropped. */
type MapNode = {
  dto: NavValueMapNodeDto;
  value: number;
  children?: MapNode[];
};

function unitValue(n: NavValueMapNodeDto, unit: Unit): number | null {
  const v = unit === "usd" ? n.value_usd : n.value_clp;
  return v != null && Number.isFinite(v) ? v : null;
}

/**
 * `depth` is relative to the page root: its first-level children (depth 1) always show what is
 * inside — a leaf group opens into its accounts (`leaf_accounts`); deeper leaves stay one tile.
 */
function toMapNode(dto: NavValueMapNodeDto, unit: Unit, depth = 0): MapNode | null {
  const inner = dto.children ?? (depth === 1 && dto.leaf_accounts?.length ? dto.leaf_accounts : null);
  if (inner) {
    const children = inner.flatMap((c) => {
      const m = toMapNode(c, unit, depth + 1);
      return m ? [m] : [];
    });
    const value = children.reduce((s, c) => s + c.value, 0);
    return value > 0 ? { dto, value, children } : null;
  }
  const value = unitValue(dto, unit);
  return value != null && value > 0 ? { dto, value } : null;
}

/** True when the payload can draw the map in `unit` (a CLP payload shown in USD cannot). */
export function valueMapReadyForUnit(root: NavValueMapNodeDto | undefined, unit: Unit): boolean {
  return root != null && unitValue(root, unit) != null;
}

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

const LAYOUT_OPTS = { headerHeight: 20, minHeaderWidth: 72, minHeaderHeight: 56, framePadding: 3 };
/** Labels: name over % when the tile fits two lines, one row (name truncates) when it fits one. */
const MIN_LABEL_W = 56;
const MIN_LABEL_H = 22;
const MIN_STACKED_LABEL_H = 36;

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
}: {
  title: string;
  titleAs?: "h2" | "h3";
  controls?: ReactNode;
  /** null while the first payload loads: the panel and its box render empty. */
  root: NavValueMapNodeDto | null;
  bounds: NavValueMapColorBounds | null;
  period: SurfacePeriod;
  unit: Unit;
}) {
  const navigate = useNavigate();
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<Hover | null>(null);

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
  const pctOf = (n: NavValueMapNodeDto) => n.pct[period][unit];

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

  if (root && !mapRoot) {
    return (
      <div className="chart-grid__col">
        <ChartPanelTitleRow title={title} titleAs={titleAs} controls={controls} />
        <p className="empty muted">{i18n.t("valueMap.empty")}</p>
      </div>
    );
  }

  const tooltipNode = hover?.node ?? null;
  const tooltipValue = tooltipNode ? unitValue(tooltipNode, unit) : null;

  return (
    <div className="chart-grid__col">
      <ChartPanelTitleRow title={title} titleAs={titleAs} controls={controls} />
      <div
        ref={boxRef}
        className="value-treemap"
        role="group"
        aria-label={i18n.t("valueMap.ariaLabel")}
        onMouseLeave={() => setHover(null)}
      >
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
                    <span className="value-treemap__pct">{pctText}</span>
                  </div>
                ) : null}
              </div>
            );
          }
          const showLabel = p.rect.w >= MIN_LABEL_W && p.rect.h >= MIN_LABEL_H;
          const rowLabel = p.rect.h < MIN_STACKED_LABEL_H;
          return (
            <div
              key={`t:${dto.slug}`}
              className={`value-treemap__tile ${rowLabel ? "value-treemap__tile--row" : ""} ${className}`}
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
              {tooltipNode.pl[period][unit] == null
                ? "—"
                : formatCurrency(tooltipNode.pl[period][unit]!, unit)}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
