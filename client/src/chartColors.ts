import { GROUP_TAB_DEP_TOTAL, GROUP_TAB_VAL_TOTAL } from "./groupTabAggregation";
import type { AssetGroupSlug, TimeseriesAccountLine } from "./types";

export function parseRgbTriplet(raw: string | null | undefined): [number, number, number] | null {
  if (!raw?.trim()) return null;
  const parts = raw.split(",").map((s) => parseInt(s.trim(), 10));
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return null;
  return [parts[0]!, parts[1]!, parts[2]!];
}

function rgbTripletToCss(raw: string | null | undefined, fallback = "#94a3b8"): string {
  const p = parseRgbTriplet(raw);
  if (!p) return fallback;
  return `rgb(${p[0]},${p[1]},${p[2]})`;
}

export function rgbTripletToHex(raw: string | null | undefined, fallback = "#94a3b8"): string {
  const p = parseRgbTriplet(raw);
  if (!p) return fallback;
  return `#${p.map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

export function chartStrokeFromRgbTriplet(
  colorRgb: string | null | undefined,
  fallback = DEFAULT_LINE_COLORS[0]!
): string {
  return strokeFromAccountColorRgb(colorRgb) ?? fallback;
}

function strokeFromAccountColorRgb(colorRgb: string | null | undefined): string | undefined {
  if (!colorRgb) return undefined;
  return rgbTripletToCss(colorRgb);
}

/** RGB average of `r,g,b` triplets (group lines from child accounts). */
export function averageRgbTriplets(triplets: (string | null | undefined)[]): string | undefined {
  const parsed = triplets.map(parseRgbTriplet).filter((p): p is [number, number, number] => p != null);
  if (parsed.length === 0) return undefined;
  let r = 0;
  let g = 0;
  let b = 0;
  for (const [pr, pg, pb] of parsed) {
    r += pr;
    g += pg;
    b += pb;
  }
  const n = parsed.length;
  return `${Math.round(r / n)},${Math.round(g / n)},${Math.round(b / n)}`;
}

/** Mix stroke toward white so “aportes acum.” reads as the same hue as valorización, one step lighter. */
export function lightenStrokeForAccumulated(baseStroke: string, mixTowardWhite = 0.42): string {
  const s = baseStroke.trim();
  const hex6 = /^#?([0-9a-f]{6})$/i.exec(s);
  if (!hex6) return baseStroke;
  const h = hex6[1]!;
  const r0 = parseInt(h.slice(0, 2), 16);
  const g0 = parseInt(h.slice(2, 4), 16);
  const b0 = parseInt(h.slice(4, 6), 16);
  const w = Math.min(1, Math.max(0, mixTowardWhite));
  const r = Math.round(r0 + (255 - r0) * w);
  const g = Math.round(g0 + (255 - g0) * w);
  const b = Math.round(b0 + (255 - b0) * w);
  return `rgb(${r},${g},${b})`;
}

const RETIREMENT = ["#14532d", "#166534", "#15803d", "#16a34a", "#22c55e", "#4ade80", "#86efac"];
const BROKERAGE = ["#1e3a8a", "#1e40af", "#2563eb", "#3b82f6", "#60a5fa", "#93c5fd", "#bfdbfe"];
/** Same blue as dashboard “Brokerage (consolidado)” / allocation brokerage slice (`BROKERAGE[3]`). */
const FINTUAL_RN_BROKER_STROKE = BROKERAGE[3];
const CRYPTO = ["#c9a227", "#a16207", "#ca8a04", "#eab308", "#facc15", "#fde047", "#fef08a"];
const CASH = ["#4c1d95", "#5b21b6", "#6d28d9", "#7c3aed", "#8b5cf6", "#a78bfa", "#c4b5fd"];
const REAL_ESTATE = ["#831843", "#9d174d", "#be185d", "#db2777", "#ec4899", "#f472b6", "#fbcfe8"];
const LIABILITIES = ["#0f172a", "#1e293b", "#334155", "#475569", "#64748b", "#94a3b8"];
/** Liabilities class-tab debt lines: burgundy / red-wine (distinct from dashboard overview slate `liabilities`). */
const LIABILITIES_TAB_WINE_STROKES = ["#4a1620", "#8f3a47"] as const;
const OTHER = ["#0c4a6e", "#0369a1", "#0ea5e9", "#38bdf8", "#7dd3fc"];

/** Fallback when `ChartColorPlan` is omitted (e.g. single-account detail). */
export const DEFAULT_LINE_COLORS = [
  "#3b82f6",
  "#22c55e",
  "#a78bfa",
  "#eab308",
  "#ec4899",
  "#64748b",
  "#38bdf8",
  "#94a3b8",
];

/**
 * Asset **class** tabs only (not the main dashboard): each account gets a clearly different hue.
 * Order follows `accounts_in_group` rows; the same map keys lines (dataKey) and pie slices (account_id).
 */
const GROUP_TAB_ACCOUNT_COLORS = [
  "#60a5fa",
  "#34d399",
  "#fbbf24",
  "#f472b6",
  "#a78bfa",
  "#38bdf8",
  "#4ade80",
  "#fb923c",
  "#2dd4bf",
  "#e879f9",
  "#818cf8",
  "#fcd34d",
  "#f87171",
  "#c084fc",
  "#5eead4",
  "#f9a8d4",
  "#93c5fd",
  "#86efac",
  "#fde047",
  "#fda4af",
];

export function shadesForGroupSlug(slug: string): string[] {
  switch (slug) {
    case "inversiones":
      return [...RETIREMENT.slice(0, 4), ...BROKERAGE.slice(0, 4)];
    case "retirement":
      return RETIREMENT;
    case "brokerage":
      return BROKERAGE;
    case "crypto":
      return CRYPTO;
    case "cash_eqs":
      return CASH;
    case "real_estate":
      return REAL_ESTATE;
    case "liabilities":
      return LIABILITIES;
    default:
      return OTHER;
  }
}

/**
 * Dashboard allocation pie + overview consolidated lines share these hues
 * (same bucket = same color family as primary-chart greens/blues/yellows).
 */
const BUCKET_STROKE: Record<string, string> = {
  real_estate: REAL_ESTATE[4],
  retirement: RETIREMENT[4],
  brokerage: BROKERAGE[3],
  inversiones: "#94a3b8",
  cash_eqs: CASH[4],
  crypto: CRYPTO[3],
  liabilities: LIABILITIES[4],
  /** Overview line keys (not always same string as allocation slug). */
  cash: CASH[4],
  total_nw: "#e2e8f0",
  /** Dashboard overview derived lines (see `getDashboardValuationTimeseries`). */
  invested: "#f59e0b",
  /** Liabilities-tab synthetic lines */
  all_available: "#2dd4bf",
  available: "#5eead4",
};

export function allocationBucketColor(groupSlug: string, colorRgb?: string | null): string {
  const fromDb = strokeFromAccountColorRgb(colorRgb ?? undefined);
  if (fromDb) return fromDb;
  return BUCKET_STROKE[groupSlug] ?? shadesForGroupSlug(groupSlug)[3] ?? "#94a3b8";
}

/** Stroke for synthetic group Total (`__group_val_total`, perf Δ total) from nav `color_rgb`. */
export function groupTabTotalStroke(
  groupTotalColorRgb: string | null | undefined,
  fallbackSlug: string
): string {
  return chartStrokeFromRgbTriplet(
    groupTotalColorRgb,
    allocationBucketColor(fallbackSlug, groupTotalColorRgb)
  );
}

export function overviewLineColor(dataKey: string): string {
  return BUCKET_STROKE[dataKey] ?? shadesForGroupSlug(dataKey === "cash" ? "cash_eqs" : dataKey)[3] ?? "#94a3b8";
}

export type ChartColorPlan =
  | { kind: "default" }
  | { kind: "dashboard-primary" }
  | { kind: "dashboard-overview" }
  | { kind: "dashboard-patrimonio-usd" }
  | {
    kind: "group-tab";
    groupSlug: AssetGroupSlug;
    /** Brokerage tab: when `crypto`, BTC/ETH lines use the crypto palette (same as `/brokerage/crypto`). */
    brokerageSubgroup?: "acciones" | "mutual_funds" | "crypto";
    accounts: TimeseriesAccountLine[];
    /** Nav / portfolio group color for synthetic Total line (`__group_val_total`). */
    groupTotalColorRgb?: string | null;
  };

export type LineSeriesColorInput = {
  dataKey: string;
  name: string;
  colorIndex: number;
  /** Server `portfolio_groups` color (`r,g,b`) when provided. */
  color_rgb?: string;
  isDeposit?: boolean;
  /** Personal-only cumulative deposits (dashed in chart). */
  isDisplayDeposit?: boolean;
  /** Dashed overlay (e.g. USD milestone lines on patrimonio chart). */
  isReferenceOverlay?: boolean;
};

export type ResolvedLineSeriesItem = LineSeriesColorInput & { stroke: string };

function isFintualRnBrokerageAccountName(name: string): boolean {
  const n = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
  if (n.includes("risky") && n.includes("norris")) return true;
  if (!n.includes("fintual") || n.includes("reserva")) return false;
  return n.includes("risky") || n.includes("norris") || /\brn\b/.test(n);
}

export function resolveLineSeriesColors(
  series: LineSeriesColorInput[],
  plan: ChartColorPlan | undefined
): ResolvedLineSeriesItem[] {
  if (!plan || plan.kind === "default") {
    const valueStrokeByColorIndex = new Map<number, string>();
    return series.map((s) => {
      const fallback = DEFAULT_LINE_COLORS[s.colorIndex % DEFAULT_LINE_COLORS.length]!;
      if (!s.isDeposit) {
        const stroke = strokeFromAccountColorRgb(s.color_rgb) ?? fallback;
        valueStrokeByColorIndex.set(s.colorIndex, stroke);
        return { ...s, stroke };
      }
      const base =
        valueStrokeByColorIndex.get(s.colorIndex) ?? strokeFromAccountColorRgb(s.color_rgb) ?? fallback;
      return { ...s, stroke: lightenStrokeForAccumulated(base) };
    });
  }

  if (plan.kind === "dashboard-overview") {
    return series.map((s) => ({
      ...s,
      stroke: strokeFromAccountColorRgb(s.color_rgb) ?? overviewLineColor(s.dataKey),
    }));
  }

  if (plan.kind === "dashboard-patrimonio-usd") {
    const milestoneStrokes = ["#94a3b8", "#78716c", "#a8a29e", "#71717a", "#64748b"];
    let mi = 0;
    return series.map((s) => {
      if (s.dataKey === "total_nw") return { ...s, stroke: BUCKET_STROKE.total_nw };
      if (s.dataKey === "invested") return { ...s, stroke: BUCKET_STROKE.invested };
      const stroke = milestoneStrokes[mi % milestoneStrokes.length]!;
      mi += 1;
      return { ...s, stroke, isReferenceOverlay: true };
    });
  }

  if (plan.kind === "dashboard-primary") {
    const strokeByColorIndex = new Map<number, string>();
    const missingColor = "#f43f5e";
    return series.map((s) => {
      if (s.isDeposit) {
        const base =
          strokeByColorIndex.get(s.colorIndex) ?? DEFAULT_LINE_COLORS[s.colorIndex % DEFAULT_LINE_COLORS.length];
        return {
          ...s,
          stroke: lightenStrokeForAccumulated(base),
        };
      }
      const stroke = strokeFromAccountColorRgb(s.color_rgb) ?? missingColor;
      strokeByColorIndex.set(s.colorIndex, stroke);
      return { ...s, stroke };
    });
  }

  if (plan.kind === "group-tab") {
    const colorSlug =
      plan.groupSlug === "brokerage" && plan.brokerageSubgroup === "crypto" ? "crypto" : plan.groupSlug;
    const { byDataKey } = buildGroupTabColorMaps(colorSlug, plan.accounts, plan.groupTotalColorRgb);
    const totalStroke = groupTabTotalStroke(plan.groupTotalColorRgb, colorSlug);
    return series.map((s) => {
      if (
        plan.groupSlug === "liabilities" &&
        (s.dataKey === "available" ||
          s.dataKey === "all_available" ||
          s.dataKey.startsWith("ref:"))
      ) {
        const stroke =
          strokeFromAccountColorRgb(s.color_rgb) ??
          BUCKET_STROKE[s.dataKey] ??
          (s.dataKey.includes("disponible_total") ? "#2dd4bf" : "#5eead4");
        return { ...s, stroke: s.isDeposit ? lightenStrokeForAccumulated(stroke) : stroke };
      }
      if (s.dataKey === GROUP_TAB_VAL_TOTAL || s.dataKey === GROUP_TAB_DEP_TOTAL) {
        const stroke = totalStroke;
        return { ...s, stroke: s.isDeposit ? lightenStrokeForAccumulated(stroke) : stroke };
      }
      const base = byDataKey.get(s.dataKey) ?? DEFAULT_LINE_COLORS[s.colorIndex % DEFAULT_LINE_COLORS.length];
      return { ...s, stroke: s.isDeposit ? lightenStrokeForAccumulated(base) : base };
    });
  }

  return series.map((s, i) => ({
    ...s,
    stroke: DEFAULT_LINE_COLORS[i % DEFAULT_LINE_COLORS.length],
  }));
}

/** BTC line on brokerage crypto tab. */
const CRYPTO_TAB_BTC_MUSTARD = CRYPTO[0];
const CRYPTO_TAB_ETH_GREY_BLUE = "#4f7fb8";

function normAccountLabel(name: string): string {
  return name.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
}

function isCryptoTabBtcAccountName(name: string): boolean {
  const n = normAccountLabel(name);
  return n.includes("bitcoin") || /\bbtc\b/.test(n);
}

function isCryptoTabEthAccountName(name: string): boolean {
  const n = normAccountLabel(name);
  if (n.includes("bitcoin") || /\bbtc\b/.test(n)) return false;
  if (n.includes("tether")) return false;
  if (n.includes("ethereum")) return true;
  if (n.includes("ether")) return true;
  return /\beth\b/.test(n) || n.trim() === "eth";
}

/** Liabilities tab: mortgage (Suecia) — deeper red-wine; “Tarjeta” uses the lighter companion. */
function isLiabilitiesMortgageAccountName(name: string): boolean {
  const n = normAccountLabel(name);
  return (
    n === "suecia" ||
    n.includes("total hoja") ||
    (n.includes("pasivos") && n.includes("total"))
  );
}

/**
 * Negative `account_id` on grouped charts → portfolio group slug (mirrors server
 * `SYNTHETIC_ACCOUNT_PORTFOLIO_GROUP_SLUG`).
 */
const SYNTHETIC_ACCOUNT_PORTFOLIO_GROUP_SLUG: Readonly<Record<number, string>> = {
  [-600]: "real_estate",
  [-201]: "brokerage_mutual_funds",
  [-202]: "brokerage_acciones",
  [-203]: "brokerage_crypto",
  [-601]: "brokerage",
  [-602]: "retirement",
  [-611]: "brokerage_mutual_funds",
  [-612]: "brokerage_acciones",
  [-613]: "brokerage_crypto",
  [-614]: "retirement_afp_afc",
  [-615]: "retirement_apv",
  [-701]: "retirement_afp_afc",
  [-702]: "retirement_apv",
  [-703]: "retirement_apv_a",
  [-704]: "retirement_apv_b",
  [-9101]: "retirement_afp_afc",
  [-9102]: "retirement_apv",
  [-9201]: "cash_eqs",
};

/** Fallback stroke when `color_rgb` is not on the series (matches legend families). */
function syntheticPortfolioGroupStroke(portfolioGroupSlug: string): string {
  switch (portfolioGroupSlug) {
    case "brokerage_mutual_funds":
      return FINTUAL_RN_BROKER_STROKE;
    case "brokerage_acciones":
      return "#34d399";
    case "brokerage_crypto":
      return CRYPTO[3]!;
    case "brokerage":
      return BROKERAGE[3]!;
    case "retirement":
      return RETIREMENT[4]!;
    case "retirement_afp_afc":
      return RETIREMENT[3]!;
    case "retirement_apv":
      return RETIREMENT[0]!;
    case "retirement_apv_a":
      return RETIREMENT[0]!;
    case "retirement_apv_b":
      return RETIREMENT[2]!;
    case "cash_eqs":
      return CASH[4]!;
    default:
      return allocationBucketColor(portfolioGroupSlug as AssetGroupSlug);
  }
}

function isLiabilitiesCreditCardAccountName(name: string): boolean {
  const n = normAccountLabel(name);
  return (
    n.includes("tarjeta") ||
    n.includes("credit card") ||
    n.includes("worldmember") ||
    n.includes("santander")
  );
}

/** Minimal series identity for color maps (perf bars, legends — not necessarily valuation lines). */
export type ChartSeriesColorKey = Pick<
  TimeseriesAccountLine,
  "account_id" | "name" | "dataKey" | "depositDataKey" | "displayDepositDataKey" | "color_rgb"
>;

/** Line chart (dataKey) + pie (account_id) use the same map on class tabs. */
export function buildGroupTabColorMaps(
  groupSlug: AssetGroupSlug | "crypto",
  accounts: ChartSeriesColorKey[],
  groupTotalColorRgb?: string | null
): { byDataKey: Map<string, string>; byAccountId: Map<number, string> } {
  const totalStroke = groupTabTotalStroke(groupTotalColorRgb, groupSlug);
  const byDataKey = new Map<string, string>();
  const byAccountId = new Map<number, string>();
  let hueIndex = 0;
  for (const a of accounts) {
    const fromDb = strokeFromAccountColorRgb("color_rgb" in a ? a.color_rgb : undefined);
    let stroke: string;
    const portfolioGroupSlug = SYNTHETIC_ACCOUNT_PORTFOLIO_GROUP_SLUG[a.account_id];
    if (fromDb) {
      stroke = fromDb;
      hueIndex += 1;
    } else if (portfolioGroupSlug) {
      stroke = syntheticPortfolioGroupStroke(portfolioGroupSlug);
      hueIndex += 1;
    } else if (a.account_id === -1) stroke = totalStroke;
    else if (a.account_id === -4) stroke = "#fb7185";
    else if (groupSlug === "brokerage" && isFintualRnBrokerageAccountName(a.name)) {
      stroke = FINTUAL_RN_BROKER_STROKE;
      hueIndex += 1;
    } else if (groupSlug === "crypto" && isCryptoTabBtcAccountName(a.name)) {
      stroke = CRYPTO_TAB_BTC_MUSTARD;
      hueIndex += 1;
    } else if (groupSlug === "crypto" && isCryptoTabEthAccountName(a.name)) {
      stroke = CRYPTO_TAB_ETH_GREY_BLUE;
      hueIndex += 1;
    } else if (groupSlug === "liabilities" && isLiabilitiesMortgageAccountName(a.name)) {
      stroke = LIABILITIES_TAB_WINE_STROKES[0];
      hueIndex += 1;
    } else if (groupSlug === "liabilities" && isLiabilitiesCreditCardAccountName(a.name)) {
      stroke = LIABILITIES_TAB_WINE_STROKES[1];
      hueIndex += 1;
    } else {
      stroke = GROUP_TAB_ACCOUNT_COLORS[hueIndex % GROUP_TAB_ACCOUNT_COLORS.length]!;
      hueIndex += 1;
    }
    byDataKey.set(a.dataKey, stroke);
    if (a.depositDataKey) byDataKey.set(a.depositDataKey, stroke);
    byAccountId.set(a.account_id, stroke);
  }
  return { byDataKey, byAccountId };
}

export function groupTabPieSliceFill(
  groupSlug: AssetGroupSlug | "crypto",
  maps: { byAccountId: Map<number, string> },
  accountId: number | undefined,
  opts?: { allocationBucketSlug?: AssetGroupSlug | "crypto" }
): string {
  if (accountId == null) return DEFAULT_LINE_COLORS[0];
  const hit = maps.byAccountId.get(accountId);
  if (hit) return hit;
  return allocationBucketColor(opts?.allocationBucketSlug ?? groupSlug);
}
