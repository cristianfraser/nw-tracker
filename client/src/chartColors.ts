import type { AssetGroupSlug, TimeseriesAccountLine } from "./types";

export function parseRgbTriplet(raw: string | null | undefined): [number, number, number] | null {
  if (!raw?.trim()) return null;
  const parts = raw.split(",").map((s) => parseInt(s.trim(), 10));
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return null;
  return [parts[0]!, parts[1]!, parts[2]!];
}

export function rgbTripletToCss(raw: string | null | undefined, fallback = "#94a3b8"): string {
  const p = parseRgbTriplet(raw);
  if (!p) return fallback;
  return `rgb(${p[0]},${p[1]},${p[2]})`;
}

function strokeFromAccountColorRgb(colorRgb: string | undefined): string | undefined {
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
/** Dashboard primary: fondo reserva / “Reserva” line — light bluish grey (not cash purple ramp). */
const DASHBOARD_RESERVA_STROKE = "#b4c8d4";
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

export function allocationBucketColor(groupSlug: string): string {
  return BUCKET_STROKE[groupSlug] ?? shadesForGroupSlug(groupSlug)[3] ?? "#94a3b8";
}

export function overviewLineColor(dataKey: string): string {
  if (dataKey === "liabilities") return REAL_ESTATE[2];
  return BUCKET_STROKE[dataKey] ?? "#94a3b8";
}

export type ChartColorPlan =
  | { kind: "default" }
  | {
    kind: "dashboard-primary";
    dataKeyToGroup: Record<string, string>;
    /** Account line colors keyed by chart `colorIndex` (from timeseries `color_rgb`). */
    colorRgbByColorIndex?: Map<number, string>;
  }
  | { kind: "dashboard-overview" }
  | { kind: "dashboard-patrimonio-usd" }
  | {
    kind: "group-tab";
    groupSlug: AssetGroupSlug;
    /** Brokerage tab: when `crypto`, BTC/ETH lines use the crypto palette (same as `/brokerage/crypto`). */
    brokerageSubgroup?: "acciones" | "mutual_funds" | "crypto";
    accounts: TimeseriesAccountLine[];
  };

export type LineSeriesColorInput = {
  dataKey: string;
  name: string;
  colorIndex: number;
  isDeposit?: boolean;
  /** Personal-only cumulative deposits (dashed in chart). */
  isDisplayDeposit?: boolean;
  /** Dashed overlay (e.g. USD milestone lines on patrimonio chart). */
  isReferenceOverlay?: boolean;
};

export type ResolvedLineSeriesItem = LineSeriesColorInput & { stroke: string };

/**
 * Dashboard primary chart: first four retirement greens go to APV-A, AFP, APV-B, AFC (semantic order 0–3).
 * We assign them **reversed** (AFC gets the darkest that was APV-A’s, etc.). Other retirement lines use palette indices ≥ 4.
 */
function dashboardRetirementQuartetRankFromName(name: string): number | null {
  const n = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
  // Merged dashboard primary lines (must precede single-leg "afc" / "afp" checks).
  if (n.includes("afp") && n.includes("afc")) return 1;
  if (n === "apv") return 0;
  if (n.includes("afc")) return 3;
  if (n.includes("apv") && (n.includes("principal") || n.includes("pre-fintual"))) return 0;
  if (n.includes("apv") && (n.includes("regimen b") || n.includes("apv-b") || n.includes("apv b"))) return 2;
  if (n.includes("apv") && (n.includes("regimen a") || n.includes("apv-a") || n.includes("apv a"))) return 0;
  if (n.includes("afp")) return 1;
  return null;
}

function isFintualRnBrokerageAccountName(name: string): boolean {
  const n = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
  if (n.includes("risky") && n.includes("norris")) return true;
  if (!n.includes("fintual") || n.includes("reserva")) return false;
  return n.includes("risky") || n.includes("norris") || /\brn\b/.test(n);
}

function isDashboardReservaCashLine(name: string): boolean {
  const n = name.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
  if (n === "reserva") return true;
  return n.includes("fondo reserva") || (n.includes("reserva") && n.includes("fintual"));
}

/** Dashboard primary merged mutual-funds line (matches brokerage subgroup series name). */
function isDashboardMutualFundsBrokerageLine(name: string): boolean {
  const n = name.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
  return (
    n === "mutual funds" ||
    n === "fondos mutuos" ||
    (n.includes("fondos") && n.includes("mutuos"))
  );
}

export function resolveLineSeriesColors(
  series: LineSeriesColorInput[],
  plan: ChartColorPlan | undefined
): ResolvedLineSeriesItem[] {
  if (!plan || plan.kind === "default") {
    const valueStrokeByColorIndex = new Map<number, string>();
    return series.map((s) => {
      if (!s.isDeposit) {
        const stroke = DEFAULT_LINE_COLORS[s.colorIndex % DEFAULT_LINE_COLORS.length];
        valueStrokeByColorIndex.set(s.colorIndex, stroke);
        return { ...s, stroke };
      }
      const base =
        valueStrokeByColorIndex.get(s.colorIndex) ??
        DEFAULT_LINE_COLORS[s.colorIndex % DEFAULT_LINE_COLORS.length];
      return { ...s, stroke: lightenStrokeForAccumulated(base) };
    });
  }

  if (plan.kind === "dashboard-overview") {
    return series.map((s) => ({
      ...s,
      stroke: overviewLineColor(s.dataKey),
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
    const nextByGroup = new Map<string, number>();
    const strokeByColorIndex = new Map<number, string>();
    const colorRgbByColorIndex = plan.colorRgbByColorIndex;
    let retirementOtherIndex = 0;
    return series.map((s) => {
      if (s.isDeposit) {
        const base =
          strokeByColorIndex.get(s.colorIndex) ?? DEFAULT_LINE_COLORS[s.colorIndex % DEFAULT_LINE_COLORS.length];
        return {
          ...s,
          stroke: lightenStrokeForAccumulated(base),
        };
      }
      const fromDb = colorRgbByColorIndex?.get(s.colorIndex);
      if (fromDb) {
        const stroke = rgbTripletToCss(fromDb);
        strokeByColorIndex.set(s.colorIndex, stroke);
        return { ...s, stroke };
      }
      const g = plan.dataKeyToGroup[s.dataKey] ?? "other";
      const palette = shadesForGroupSlug(g);

      let stroke: string;
      if (g === "retirement") {
        const rank = dashboardRetirementQuartetRankFromName(s.name);
        if (rank != null) {
          stroke = palette[3 - rank]!;
        } else {
          const start = 4;
          if (start < palette.length) {
            const span = palette.length - start;
            stroke = palette[start + (retirementOtherIndex++ % span)]!;
          } else {
            stroke = palette[retirementOtherIndex++ % palette.length]!;
          }
        }
      } else if (g === "cash_eqs" && isDashboardReservaCashLine(s.name)) {
        const idx = nextByGroup.get(g) ?? 0;
        nextByGroup.set(g, idx + 1);
        stroke = DASHBOARD_RESERVA_STROKE;
      } else if (
        g === "brokerage" &&
        (isFintualRnBrokerageAccountName(s.name) || isDashboardMutualFundsBrokerageLine(s.name))
      ) {
        const idx = nextByGroup.get(g) ?? 0;
        nextByGroup.set(g, idx + 1);
        stroke = FINTUAL_RN_BROKER_STROKE;
      } else {
        const idx = nextByGroup.get(g) ?? 0;
        nextByGroup.set(g, idx + 1);
        stroke = palette[idx % palette.length]!;
      }

      strokeByColorIndex.set(s.colorIndex, stroke);
      return { ...s, stroke };
    });
  }

  if (plan.kind === "group-tab") {
    const colorSlug =
      plan.groupSlug === "brokerage" && plan.brokerageSubgroup === "crypto" ? "crypto" : plan.groupSlug;
    const { byDataKey } = buildGroupTabColorMaps(colorSlug, plan.accounts);
    return series.map((s) => {
      if (plan.groupSlug === "liabilities" && (s.dataKey === "available" || s.dataKey === "all_available")) {
        const stroke = BUCKET_STROKE[s.dataKey] ?? "#2dd4bf";
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

/** Same hue as dashboard primary `crypto_total` (first `crypto` bucket shade). */
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
  accounts: ChartSeriesColorKey[]
): { byDataKey: Map<string, string>; byAccountId: Map<number, string> } {
  const byDataKey = new Map<string, string>();
  const byAccountId = new Map<number, string>();
  let hueIndex = 0;
  for (const a of accounts) {
    const fromDb = strokeFromAccountColorRgb("color_rgb" in a ? a.color_rgb : undefined);
    let stroke: string;
    if (fromDb) {
      stroke = fromDb;
      hueIndex += 1;
    } else if (a.account_id === -1) stroke = "#cbd5e1";
    else if (a.account_id === -4) stroke = "#fb7185";
    /** Brokerage “Todas” + grouped: synthetic rows from `aggregateBrokerageAllViewValuationBlock`. */
    else if (groupSlug === "brokerage" && a.account_id === -201) stroke = FINTUAL_RN_BROKER_STROKE;
    else if (groupSlug === "brokerage" && a.account_id === -202) stroke = "#34d399";
    else if (groupSlug === "brokerage" && a.account_id === -203) stroke = CRYPTO[3]!;
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
