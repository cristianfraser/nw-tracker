import { loadMergedDepositInflowEvents, totalDepositsClpForAccount } from "./accountDeposits.js";
import {
  accountUsesEquityMtm,
  computeEquityMtmClp,
  equityTickerForAccount,
  expandSnapshotDatesForEquityMtm,
} from "./brokerageEquityMtm.js";
import { NOTE_STOCKS_LEGACY } from "./brokerageAcciones.js";
import { monthEndUtcYmd, monthKeyFromYmd } from "./calendarMonth.js";
import { resolveCfraserCsvDir } from "./cfraserPaths.js";
import { loadDeptoDividendosSheetLedger, type DeptoMortgageSheetRow } from "./deptoDividendosLedger.js";
import { db } from "./db.js";
import { fxRowOnOrBefore, ufRowOnOrBefore } from "./fxRates.js";

export type TsUnit = "clp" | "usd" | "uf";

export type TimeseriesGranularity = "monthly" | "daily";

export function convertTs(clp: number, asOf: string, unit: TsUnit): number {
  if (unit === "usd") {
    const fx = fxRowOnOrBefore(asOf);
    return fx && fx.clp_per_usd > 0 ? clp / fx.clp_per_usd : clp;
  }
  if (unit === "uf") {
    const u = ufRowOnOrBefore(asOf);
    return u && u.clp_per_uf > 0 ? clp / u.clp_per_uf : clp;
  }
  return clp;
}

type AccountLine = {
  account_id: number;
  name: string;
  dataKey: string;
  depositDataKey?: string;
  /** Legend label for the cumulative deposit line (client default: "aportes acum."). */
  deposit_series_name?: string;
};

/** Class-tab valuation block; optional `lines` for synthetic series (e.g. Liabilities “Available”). */
type GroupTabValuationBlock = {
  accounts: AccountLine[];
  points: Record<string, string | number | null>[];
  lines?: { dataKey: string; name: string }[];
};

const GROUP_TAB_VAL_TOTAL = "__group_val_total";
const GROUP_TAB_DEP_TOTAL = "__group_dep_total";

/** Liability categories: balance is debt, not equity — no cumulative “aportes” line on charts. */
const CATEGORY_NO_CHART_DEPOSIT_LINE = new Set(["credit_card", "mortgage", "other_debt"]);

/** Per-row sum of all class-tab valuation lines and of all cumulative deposit lines. */
function appendGroupTabTotals(block: GroupTabValuationBlock): GroupTabValuationBlock {
  const src = block.accounts;
  if (src.length === 0 || block.points.length === 0) return block;
  // One account (or one merged series): "Total (clase)" / "Total aportes acum." would duplicate that line.
  if (src.length === 1) return block;

  const anyChildDep = src.some((a) => Boolean(a.depositDataKey));

  const points = block.points.map((row) => {
    let vSum = 0;
    let vAny = false;
    let dSum = 0;
    let dAny = false;
    for (const a of src) {
      const v = row[a.dataKey];
      if (typeof v === "number" && Number.isFinite(v)) {
        vSum += v;
        vAny = true;
      }
      if (a.depositDataKey) {
        const d = row[a.depositDataKey];
        if (typeof d === "number" && Number.isFinite(d)) {
          dSum += d;
          dAny = true;
        }
      }
    }
    const out: Record<string, string | number | null> = {
      ...row,
      [GROUP_TAB_VAL_TOTAL]: vAny ? vSum : null,
    };
    if (anyChildDep) {
      out[GROUP_TAB_DEP_TOTAL] = dAny ? dSum : null;
    }
    return out;
  });

  const totalLine: AccountLine = anyChildDep
    ? {
        account_id: -1,
        name: "Total (clase)",
        dataKey: GROUP_TAB_VAL_TOTAL,
        depositDataKey: GROUP_TAB_DEP_TOTAL,
        deposit_series_name: "Total aportes acum.",
      }
    : {
        account_id: -1,
        name: "Total (clase)",
        dataKey: GROUP_TAB_VAL_TOTAL,
      };

  const accounts: AccountLine[] = [totalLine, ...src];
  return { accounts, points, ...(block.lines?.length ? { lines: block.lines } : {}) };
}

type MovDep = { occurred_on: string; amt: number };

/** UF per CLP at the payment date, rounded (matches “UF con 5 decimales” ledger style). */
const DEPOSIT_CROSS_RATE_DECIMALS = 5;

/** CLP → UF at `paymentDate`’s UF table row; rounded — do not re-divide cumulative CLP by later month-end UF. */
function clpToUfAtPaymentRounded(clp: number, paymentDate: string): number | null {
  if (!Number.isFinite(clp) || clp === 0) return 0;
  const u = ufRowOnOrBefore(paymentDate);
  if (!u || u.clp_per_uf <= 0) return null;
  const uf = clp / u.clp_per_uf;
  const f = 10 ** DEPOSIT_CROSS_RATE_DECIMALS;
  return Math.round(uf * f) / f;
}

/** CLP → USD at payment date’s FX row, same rounding policy as UF leg. */
function clpToUsdAtPaymentRounded(clp: number, paymentDate: string): number | null {
  if (!Number.isFinite(clp) || clp === 0) return 0;
  const fx = fxRowOnOrBefore(paymentDate);
  if (!fx || fx.clp_per_usd <= 0) return null;
  const usd = clp / fx.clp_per_usd;
  const f = 10 ** DEPOSIT_CROSS_RATE_DECIMALS;
  return Math.round(usd * f) / f;
}

/** Flows through snapshot date `d` (month-end `YYYY-MM-DD`, or legacy `YYYY-MM-01` converted to month-end). */
function depositCutoffForSnapshotRow(asOfLabel: string): string {
  const m = /^(\d{4})-(\d{2})-01$/.exec(asOfLabel);
  if (!m) return asOfLabel;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (!Number.isFinite(y) || mo < 1 || mo > 12) return asOfLabel;
  return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
}

function sortMovsChronological(movs: MovDep[]): MovDep[] {
  return [...movs].sort((a, b) => a.occurred_on.localeCompare(b.occurred_on));
}

function cumulativeDepClpByDate(datesAsc: string[], movs: MovDep[]): Map<string, number> {
  const sorted = sortMovsChronological(movs);
  const out = new Map<string, number>();
  let i = 0;
  let cum = 0;
  for (const d of datesAsc) {
    const cut = depositCutoffForSnapshotRow(d);
    while (i < sorted.length && sorted[i].occurred_on <= cut) {
      cum += sorted[i].amt;
      i++;
    }
    out.set(d, cum);
  }
  return out;
}

/** Cumulative sum of each flow’s UF at its own payment date (no “cumulative CLP ÷ month-end UF”). */
function cumulativeDepUfByDate(datesAsc: string[], movs: MovDep[]): Map<string, number> {
  const sorted = sortMovsChronological(movs);
  const out = new Map<string, number>();
  let i = 0;
  let cum = 0;
  for (const d of datesAsc) {
    const cut = depositCutoffForSnapshotRow(d);
    while (i < sorted.length && sorted[i].occurred_on <= cut) {
      const m = sorted[i];
      const part = clpToUfAtPaymentRounded(m.amt, m.occurred_on);
      if (part != null) cum += part;
      i++;
    }
    out.set(d, cum);
  }
  return out;
}

function cumulativeDepUsdByDate(datesAsc: string[], movs: MovDep[]): Map<string, number> {
  const sorted = sortMovsChronological(movs);
  const out = new Map<string, number>();
  let i = 0;
  let cum = 0;
  for (const d of datesAsc) {
    const cut = depositCutoffForSnapshotRow(d);
    while (i < sorted.length && sorted[i].occurred_on <= cut) {
      const m = sorted[i];
      const part = clpToUsdAtPaymentRounded(m.amt, m.occurred_on);
      if (part != null) cum += part;
      i++;
    }
    out.set(d, cum);
  }
  return out;
}

type MergePairOpts = {
  btcId?: number;
  ethId?: number;
  spyId?: number;
  veaId?: number;
};

function categorySlugByAccountId(accountIds: number[]): Map<number, string> {
  const uniq = [...new Set(accountIds.filter((id) => id > 0))];
  const m = new Map<number, string>();
  if (uniq.length === 0) return m;
  const ph = uniq.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT a.id AS id, c.slug AS slug FROM accounts a JOIN categories c ON c.id = a.category_id WHERE a.id IN (${ph})`
    )
    .all(...uniq) as { id: number; slug: string }[];
  for (const r of rows) m.set(r.id, r.slug);
  return m;
}

function attachDepositSeriesKeys(
  top: AccountLine[],
  depMovs: Map<number, { occurred_on: string; amt: number }[]>,
  merge: MergePairOpts | undefined,
  slugById: Map<number, string>
): AccountLine[] {
  return top.map((t) => {
    if (t.dataKey === "crypto_total") {
      const { btcId, ethId } = merge ?? {};
      const has =
        (btcId != null && (depMovs.get(btcId)?.length ?? 0) > 0) ||
        (ethId != null && (depMovs.get(ethId)?.length ?? 0) > 0);
      return has ? { ...t, depositDataKey: "crypto_total__dep" } : { ...t };
    }
    if (t.dataKey === "stocks_total") {
      const { spyId, veaId } = merge ?? {};
      const has =
        (spyId != null && (depMovs.get(spyId)?.length ?? 0) > 0) ||
        (veaId != null && (depMovs.get(veaId)?.length ?? 0) > 0);
      return has ? { ...t, depositDataKey: "stocks_total__dep" } : { ...t };
    }
    if (t.account_id > 0) {
      if (slugById.get(t.account_id) === "cuenta_corriente") return { ...t };
      const slug = slugById.get(t.account_id);
      if (slug && CATEGORY_NO_CHART_DEPOSIT_LINE.has(slug)) return { ...t };
      const depLen = (depMovs.get(t.account_id) ?? []).length;
      const propertyWithCapital =
        slug === "property" && Math.abs(totalDepositsClpForAccount(t.account_id)) > 0.5;
      if (depLen > 0 || propertyWithCapital) {
        return { ...t, depositDataKey: `${t.dataKey}__dep` };
      }
    }
    return { ...t };
  });
}

function valuationRawClpForAccount(accountId: number, asOf: string, byDate: Map<string, Map<number, number>>): number | null {
  if (accountUsesEquityMtm(accountId)) {
    return computeEquityMtmClp(accountId, asOf);
  }
  return byDate.get(asOf)?.get(accountId) ?? null;
}

/**
 * Month-end CLP series from `depto-dividendos.csv` (same as Numbers: **valor neto** + **pago acumulado**),
 * forward-filled along `dateStrsAsc`. Keeps the two chart lines on the same amortization timeline as the sheet.
 */
function propertyDeptoClpSeriesBySnapshotDate(
  dateStrsAsc: string[],
  ledger: DeptoMortgageSheetRow[]
): {
  valorNetoByDate: Map<string, number>;
  pagoAcumuladoByDate: Map<string, number>;
  /** Mortgage remaining balance in CLP from sheet column “restante CLP”, forward-filled to each snapshot date. */
  restanteClpByDate: Map<string, number>;
} {
  const valorNetoByDate = new Map<string, number>();
  const pagoAcumuladoByDate = new Map<string, number>();
  const restanteClpByDate = new Map<string, number>();
  if (dateStrsAsc.length === 0 || ledger.length === 0) {
    return { valorNetoByDate, pagoAcumuladoByDate, restanteClpByDate };
  }
  const sorted = [...ledger].sort((a, b) => {
    const c = a.occurred_on.localeCompare(b.occurred_on);
    return c !== 0 ? c : a.cuota.localeCompare(b.cuota);
  });
  let j = 0;
  let lastValor: number | null = null;
  let lastPagoAcum: number | null = null;
  let lastRestanteClp: number | null = null;
  for (const d of dateStrsAsc) {
    const cut = depositCutoffForSnapshotRow(d);
    while (j < sorted.length && sorted[j].occurred_on <= cut) {
      const row = sorted[j];
      const vn = row.valor_neto_clp;
      if (vn != null && Number.isFinite(vn)) lastValor = vn;
      const pa = row.pago_acumulado_clp;
      if (pa != null && Number.isFinite(pa)) lastPagoAcum = pa;
      const rc = row.restante_clp;
      if (rc != null && Number.isFinite(rc)) lastRestanteClp = rc;
      j++;
    }
    if (lastValor != null) valorNetoByDate.set(d, lastValor);
    if (lastPagoAcum != null) pagoAcumuladoByDate.set(d, lastPagoAcum);
    if (lastRestanteClp != null) restanteClpByDate.set(d, lastRestanteClp);
  }
  return { valorNetoByDate, pagoAcumuladoByDate, restanteClpByDate };
}

function buildPointsForAccounts(top: AccountLine[], extraIds: number[], unit: TsUnit, merge?: MergePairOpts) {
  const mergeIds = [merge?.btcId, merge?.ethId, merge?.spyId, merge?.veaId].filter((x): x is number => x != null);
  const allIds = [...new Set([...top.map((t) => t.account_id).filter((id) => id > 0), ...extraIds, ...mergeIds])];
  if (allIds.length === 0) {
    return { accounts: top, points: [] as Record<string, string | number | null>[] };
  }
  const ph = allIds.map(() => "?").join(",");
  const dates = db
    .prepare(
      `SELECT DISTINCT v.as_of_date AS d
       FROM valuations v
       WHERE v.account_id IN (${ph})
       ORDER BY v.as_of_date`
    )
    .all(...allIds) as { d: string }[];
  let dateStrs = expandSnapshotDatesForEquityMtm(
    dates.map((x) => x.d),
    allIds,
    merge
  );
  const depMovs = loadMergedDepositInflowEvents(allIds);
  if (dateStrs.length > 0) {
    const minD = dateStrs[0]!;
    const maxD = dateStrs[dateStrs.length - 1]!;
    const aug = new Set(dateStrs);
    for (const id of allIds) {
      for (const ev of depMovs.get(id) ?? []) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(ev.occurred_on)) continue;
        const me = monthEndUtcYmd(monthKeyFromYmd(ev.occurred_on));
        if (me >= minD && me <= maxD) aug.add(me);
      }
    }
    dateStrs = [...aug].sort();
  }
  const slugById = categorySlugByAccountId(allIds);
  const propertyAccountIds = allIds.filter((id) => slugById.get(id) === "property");
  const propertyDeptoSheets =
    propertyAccountIds.length === 1
      ? propertyDeptoClpSeriesBySnapshotDate(dateStrs, loadDeptoDividendosSheetLedger(resolveCfraserCsvDir()))
      : {
          valorNetoByDate: new Map<string, number>(),
          pagoAcumuladoByDate: new Map<string, number>(),
          restanteClpByDate: new Map<string, number>(),
        };
  const { valorNetoByDate: propertyDeptoValorByDate, pagoAcumuladoByDate: propertyDeptoPagoAcumByDate } =
    propertyDeptoSheets;
  const topOut = attachDepositSeriesKeys(top, depMovs, merge, slugById);
  const depClpByAccAndDate = new Map<number, Map<string, number>>();
  const depUfByAccAndDate = new Map<number, Map<string, number>>();
  const depUsdByAccAndDate = new Map<number, Map<string, number>>();
  for (const id of allIds) {
    const movs = depMovs.get(id) ?? [];
    depClpByAccAndDate.set(id, cumulativeDepClpByDate(dateStrs, movs));
    if (unit === "uf") depUfByAccAndDate.set(id, cumulativeDepUfByDate(dateStrs, movs));
    if (unit === "usd") depUsdByAccAndDate.set(id, cumulativeDepUsdByDate(dateStrs, movs));
  }

  const vals = db
    .prepare(
      `SELECT account_id, as_of_date, value_clp
       FROM valuations
       WHERE account_id IN (${ph})
       ORDER BY as_of_date, account_id`
    )
    .all(...allIds) as { account_id: number; as_of_date: string; value_clp: number }[];
  const byDate = new Map<string, Map<number, number>>();
  for (const v of vals) {
    let m = byDate.get(v.as_of_date);
    if (!m) {
      m = new Map();
      byDate.set(v.as_of_date, m);
    }
    m.set(v.account_id, v.value_clp);
  }
  const last = new Map<number, number>();
  let lastBtc: number | null = null;
  let lastEth: number | null = null;
  let lastSpy: number | null = null;
  let lastVea: number | null = null;
  const btcId = merge?.btcId;
  const ethId = merge?.ethId;
  const spyId = merge?.spyId;
  const veaId = merge?.veaId;

  const needsCrypto = topOut.some((t) => t.dataKey === "crypto_total");
  const needsStocks = topOut.some((t) => t.dataKey === "stocks_total");
  /** Avoid drawing merged deposit lines at 0 from the first chart date before any inflows exist. */
  let cryptoMergedDepSeen = false;
  let stocksMergedDepSeen = false;
  const singleAccountDepSeen = new Map<number, boolean>();

  const points = dateStrs.map((d) => {
    const row: Record<string, string | number | null> = { as_of_date: d };
    for (const t of topOut) {
      if (t.dataKey === "crypto_total" || t.dataKey === "stocks_total") continue;
      const aid = t.account_id;
      let raw = valuationRawClpForAccount(aid, d, byDate);
      if (propertyAccountIds.length === 1 && slugById.get(aid) === "property") {
        const fromDepto = propertyDeptoValorByDate.get(d);
        if (fromDepto != null && Number.isFinite(fromDepto)) raw = fromDepto;
      }
      if (raw != null) last.set(aid, raw);
      const v = last.get(aid);
      row[t.dataKey] = v === undefined ? null : convertTs(v, d, unit);
    }
    if (needsCrypto && merge) {
      if (btcId != null) {
        const rb = valuationRawClpForAccount(btcId, d, byDate);
        if (rb != null) lastBtc = rb;
      }
      if (ethId != null) {
        const re = valuationRawClpForAccount(ethId, d, byDate);
        if (re != null) lastEth = re;
      }
      if (lastBtc != null || lastEth != null) {
        row.crypto_total = convertTs((lastBtc ?? 0) + (lastEth ?? 0), d, unit);
      } else {
        row.crypto_total = null;
      }
    }
    if (needsStocks && merge) {
      if (spyId != null) {
        const rs = valuationRawClpForAccount(spyId, d, byDate);
        if (rs != null) lastSpy = rs;
      }
      if (veaId != null) {
        const rv = valuationRawClpForAccount(veaId, d, byDate);
        if (rv != null) lastVea = rv;
      }
      if (lastSpy != null || lastVea != null) {
        row.stocks_total = convertTs((lastSpy ?? 0) + (lastVea ?? 0), d, unit);
      } else {
        row.stocks_total = null;
      }
    }
    for (const t of topOut) {
      if (!t.depositDataKey) continue;
      if (t.dataKey === "crypto_total") {
        const btcC = btcId != null ? (depClpByAccAndDate.get(btcId)?.get(d) ?? 0) : 0;
        const ethC = ethId != null ? (depClpByAccAndDate.get(ethId)?.get(d) ?? 0) : 0;
        const sumClp = btcC + ethC;
        let depPlot: number;
        if (unit === "uf") {
          const btcU = btcId != null ? (depUfByAccAndDate.get(btcId)?.get(d) ?? 0) : 0;
          const ethU = ethId != null ? (depUfByAccAndDate.get(ethId)?.get(d) ?? 0) : 0;
          depPlot = btcU + ethU;
        } else if (unit === "usd") {
          const btcU = btcId != null ? (depUsdByAccAndDate.get(btcId)?.get(d) ?? 0) : 0;
          const ethU = ethId != null ? (depUsdByAccAndDate.get(ethId)?.get(d) ?? 0) : 0;
          depPlot = btcU + ethU;
        } else {
          depPlot = sumClp;
        }
        if (!cryptoMergedDepSeen) {
          if (depPlot === 0) {
            row[t.depositDataKey] = null;
          } else {
            cryptoMergedDepSeen = true;
            row[t.depositDataKey] = depPlot;
          }
        } else {
          row[t.depositDataKey] = depPlot;
        }
      } else if (t.dataKey === "stocks_total") {
        const spyC = spyId != null ? (depClpByAccAndDate.get(spyId)?.get(d) ?? 0) : 0;
        const veaC = veaId != null ? (depClpByAccAndDate.get(veaId)?.get(d) ?? 0) : 0;
        const sumClp = spyC + veaC;
        let depPlot: number;
        if (unit === "uf") {
          const spyU = spyId != null ? (depUfByAccAndDate.get(spyId)?.get(d) ?? 0) : 0;
          const veaU = veaId != null ? (depUfByAccAndDate.get(veaId)?.get(d) ?? 0) : 0;
          depPlot = spyU + veaU;
        } else if (unit === "usd") {
          const spyU = spyId != null ? (depUsdByAccAndDate.get(spyId)?.get(d) ?? 0) : 0;
          const veaU = veaId != null ? (depUsdByAccAndDate.get(veaId)?.get(d) ?? 0) : 0;
          depPlot = spyU + veaU;
        } else {
          depPlot = sumClp;
        }
        if (!stocksMergedDepSeen) {
          if (depPlot === 0) {
            row[t.depositDataKey] = null;
          } else {
            stocksMergedDepSeen = true;
            row[t.depositDataKey] = depPlot;
          }
        } else {
          row[t.depositDataKey] = depPlot;
        }
      } else {
        const aid = t.account_id;
        const dk = t.depositDataKey;
        let depPlot =
          unit === "uf"
            ? (depUfByAccAndDate.get(aid)?.get(d) ?? 0)
            : unit === "usd"
              ? (depUsdByAccAndDate.get(aid)?.get(d) ?? 0)
              : (depClpByAccAndDate.get(aid)?.get(d) ?? 0);
        if (
          unit === "clp" &&
          propertyAccountIds.length === 1 &&
          slugById.get(aid) === "property"
        ) {
          const fromSheet = propertyDeptoPagoAcumByDate.get(d);
          if (fromSheet != null && Number.isFinite(fromSheet)) depPlot = fromSheet;
        }
        if (!singleAccountDepSeen.get(aid)) {
          if (depPlot === 0) {
            row[dk] = null;
          } else {
            singleAccountDepSeen.set(aid, true);
            row[dk] = depPlot;
          }
        } else {
          row[dk] = depPlot;
        }
      }
    }
    return row;
  });
  return { accounts: topOut, points };
}

function latestAllocationPieForAccounts(
  accounts: AccountLine[],
  unit: TsUnit
): { name: string; account_id: number; value: number }[] {
  const out: { name: string; account_id: number; value: number }[] = [];
  const stmtV = db.prepare(
    `SELECT value_clp, as_of_date FROM valuations WHERE account_id = ? ORDER BY as_of_date DESC LIMIT 1`
  );
  const stmtMd = db.prepare(`SELECT max(trade_date) AS md FROM equity_daily WHERE ticker = ?`);
  for (const a of accounts) {
    if (a.account_id <= 0) continue;
    let clp: number | undefined;
    let asOf: string | undefined;
    if (accountUsesEquityMtm(a.account_id)) {
      const t = equityTickerForAccount(a.account_id);
      if (t) {
        const md = stmtMd.get(t) as { md: string | null } | undefined;
        if (md?.md) {
          const c = computeEquityMtmClp(a.account_id, md.md);
          if (c != null) {
            clp = c;
            asOf = md.md;
          }
        }
      }
    } else {
      const vrow = stmtV.get(a.account_id) as { value_clp: number; as_of_date: string } | undefined;
      clp = vrow?.value_clp;
      asOf = vrow?.as_of_date;
    }
    if (clp != null && clp > 0 && asOf) {
      out.push({ name: a.name, account_id: a.account_id, value: convertTs(clp, asOf, unit) });
    }
  }
  return out;
}

const FIXED_IMPORT_NOTES = [
  "import:excel|key=apv_a",
  "import:excel|key=afp",
  "import:excel|key=fondo_reserva",
  "import:excel|key=apv_b",
  "import:excel|key=fintual_rn",
  "import:excel|key=afc",
] as const;

/** Short labels for the dashboard primary chart only (accounts table names unchanged). */
const DASHBOARD_PRIMARY_LINE_LABEL: Record<(typeof FIXED_IMPORT_NOTES)[number], string> = {
  "import:excel|key=apv_a": "APV-a",
  "import:excel|key=afp": "AFP",
  "import:excel|key=fondo_reserva": "Reserva",
  "import:excel|key=apv_b": "APV-b",
  "import:excel|key=fintual_rn": "Risky Norris",
  "import:excel|key=afc": "AFC",
};

type GlobalBucketOvRow = {
  d: string;
  brokerage: number;
  crypto: number;
};

/**
 * Liabilities-tab synthetic lines (same snapshot dates as the class chart):
 * - **All available**: brokerage (incl. SPY/VEA MTM) + crypto + Reserva + 85 % (APV-a + APV-b).
 * - **Available**: brokerage (incl. MTM) + Reserva only (no crypto, no APV haircut terms).
 */
function getLiabilitiesLiquidityExtraSeries(unit: TsUnit): {
  allAvailableByDate: Map<string, number>;
  availableByDate: Map<string, number>;
} {
  const accByNote = db.prepare("SELECT id AS account_id, name FROM accounts WHERE notes = ?");
  const spyRow = accByNote.get("import:excel|key=spy") as { account_id: number } | undefined;
  const veaRow = accByNote.get("import:excel|key=vea") as { account_id: number } | undefined;
  const spyId = spyRow?.account_id;
  const veaId = veaRow?.account_id;

  const ovRows = db
    .prepare(
      `
      SELECT v.as_of_date AS d,
        COALESCE(SUM(CASE WHEN g.slug = 'brokerage' THEN v.value_clp ELSE 0 END), 0) AS brokerage,
        COALESCE(SUM(CASE WHEN g.slug = 'crypto' THEN v.value_clp ELSE 0 END), 0) AS crypto
      FROM valuations v
      JOIN accounts a ON a.id = v.account_id
      JOIN categories c ON c.id = a.category_id
      JOIN asset_groups g ON g.id = c.group_id
      GROUP BY v.as_of_date
      ORDER BY v.as_of_date
    `
    )
    .all() as GlobalBucketOvRow[];

  const valStmt = db.prepare(
    `SELECT as_of_date, value_clp FROM valuations WHERE account_id = ? ORDER BY as_of_date`
  );
  const valuationsByDateForAccount = (accountId: number | undefined): Map<string, number> => {
    if (accountId == null) return new Map();
    const rows = valStmt.all(accountId) as { as_of_date: string; value_clp: number }[];
    return new Map(rows.map((x) => [x.as_of_date, x.value_clp]));
  };

  const apvAId = (accByNote.get("import:excel|key=apv_a") as { account_id: number } | undefined)?.account_id;
  const apvBId = (accByNote.get("import:excel|key=apv_b") as { account_id: number } | undefined)?.account_id;
  const reservaId = (accByNote.get("import:excel|key=fondo_reserva") as { account_id: number } | undefined)
    ?.account_id;
  const apvAMap = valuationsByDateForAccount(apvAId);
  const apvBMap = valuationsByDateForAccount(apvBId);
  const reservaMap = valuationsByDateForAccount(reservaId);

  let carryApvA = 0;
  let carryApvB = 0;
  let carryReserva = 0;
  const allAvailableByDate = new Map<string, number>();
  const availableByDate = new Map<string, number>();
  for (const r of ovRows) {
    let mtmAdd = 0;
    if (spyId != null) mtmAdd += computeEquityMtmClp(spyId, r.d) ?? 0;
    if (veaId != null) mtmAdd += computeEquityMtmClp(veaId, r.d) ?? 0;
    const brokerageClp = r.brokerage + mtmAdd;

    if (apvAMap.has(r.d)) carryApvA = apvAMap.get(r.d)!;
    if (apvBMap.has(r.d)) carryApvB = apvBMap.get(r.d)!;
    if (reservaMap.has(r.d)) carryReserva = reservaMap.get(r.d)!;

    const allAvailableClp = brokerageClp + r.crypto + carryReserva + 0.85 * (carryApvA + carryApvB);
    allAvailableByDate.set(r.d, convertTs(allAvailableClp, r.d, unit));

    const narrowClp = brokerageClp + carryReserva;
    availableByDate.set(r.d, convertTs(narrowClp, r.d, unit));
  }
  return { allAvailableByDate, availableByDate };
}

export function getDashboardValuationTimeseries(unit: TsUnit) {
  const accByNote = db.prepare("SELECT id AS account_id, name FROM accounts WHERE notes = ?");

  const top: AccountLine[] = [];
  for (const note of FIXED_IMPORT_NOTES) {
    const r = accByNote.get(note) as { account_id: number; name: string } | undefined;
    if (r)
      top.push({
        account_id: r.account_id,
        name: DASHBOARD_PRIMARY_LINE_LABEL[note],
        dataKey: String(r.account_id),
      });
  }

  const spyRow = accByNote.get("import:excel|key=spy") as { account_id: number } | undefined;
  const veaRow = accByNote.get("import:excel|key=vea") as { account_id: number } | undefined;
  const spyId = spyRow?.account_id;
  const veaId = veaRow?.account_id;
  if (spyId != null || veaId != null) {
    top.push({ account_id: 0, name: "Acciones", dataKey: "stocks_total" });
  }

  const btcRow = accByNote.get("import:excel|key=bitcoin") as { account_id: number } | undefined;
  const ethRow = accByNote.get("import:excel|key=eth") as { account_id: number } | undefined;
  const btcId = btcRow?.account_id;
  const ethId = ethRow?.account_id;

  top.push({ account_id: 0, name: "Cripto", dataKey: "crypto_total" });

  const extra = [btcId, ethId].filter((x): x is number => x != null);
  const accountsExProperty = buildPointsForAccounts(top, extra, unit, { btcId, ethId, spyId, veaId });

  type OvRow = {
    d: string;
    real_estate: number;
    retirement: number;
    brokerage: number;
    cash: number;
    crypto: number;
    liabilities: number;
    assets_ex_liab: number;
  };
  const ovRows = db
    .prepare(
      `
      SELECT v.as_of_date AS d,
        COALESCE(SUM(CASE WHEN g.slug = 'real_estate' THEN v.value_clp ELSE 0 END), 0) AS real_estate,
        COALESCE(SUM(CASE WHEN g.slug = 'retirement' THEN v.value_clp ELSE 0 END), 0) AS retirement,
        COALESCE(SUM(CASE WHEN g.slug = 'brokerage' THEN v.value_clp ELSE 0 END), 0) AS brokerage,
        COALESCE(SUM(CASE WHEN g.slug = 'cash_eqs' THEN v.value_clp ELSE 0 END), 0) AS cash,
        COALESCE(SUM(CASE WHEN g.slug = 'crypto' THEN v.value_clp ELSE 0 END), 0) AS crypto,
        COALESCE(SUM(CASE WHEN g.slug = 'liabilities' THEN v.value_clp ELSE 0 END), 0) AS liabilities,
        COALESCE(SUM(CASE WHEN g.slug != 'liabilities' THEN v.value_clp ELSE 0 END), 0) AS assets_ex_liab
      FROM valuations v
      JOIN accounts a ON a.id = v.account_id
      JOIN categories c ON c.id = a.category_id
      JOIN asset_groups g ON g.id = c.group_id
      GROUP BY v.as_of_date
      ORDER BY v.as_of_date
    `
    )
    .all() as OvRow[];

  const overviewLines = [
    { dataKey: "real_estate", name: "Inmuebles" },
    { dataKey: "retirement", name: "Retiro" },
    { dataKey: "brokerage", name: "Brokerage" },
    { dataKey: "invested", name: "Invested" },
    { dataKey: "cash", name: "Cash" },
    { dataKey: "liabilities", name: "Pasivos" },
    { dataKey: "total_nw", name: "Patrimonio neto" },
  ];

  /** SQL uses COALESCE(SUM,0): dates with only other buckets still get 0 here — omit line until first real row. */
  let ovRealEstateStarted = false;
  let ovLiabilitiesStarted = false;
  const overviewPoints = ovRows.map((r) => {
    let mtmAdd = 0;
    if (spyId != null) mtmAdd += computeEquityMtmClp(spyId, r.d) ?? 0;
    if (veaId != null) mtmAdd += computeEquityMtmClp(veaId, r.d) ?? 0;
    const brokerageClp = r.brokerage + mtmAdd;
    const assetsClp = r.assets_ex_liab + mtmAdd;
    const totalNwClp = assetsClp;
    const row: Record<string, string | number | null> = { as_of_date: r.d };
    const reClp = r.real_estate;
    const liabClp = r.liabilities;
    if (!ovRealEstateStarted && Math.abs(reClp) < 0.5) row.real_estate = null;
    else {
      ovRealEstateStarted = true;
      row.real_estate = convertTs(reClp, r.d, unit);
    }
    if (!ovLiabilitiesStarted && Math.abs(liabClp) < 0.5) row.liabilities = null;
    else {
      ovLiabilitiesStarted = true;
      row.liabilities = convertTs(liabClp, r.d, unit);
    }
    row.retirement = convertTs(r.retirement, r.d, unit);
    row.brokerage = convertTs(brokerageClp, r.d, unit);
    row.cash = convertTs(r.cash, r.d, unit);
    row.total_nw = convertTs(totalNwClp, r.d, unit);

    /** Retiro (bucket) + brokerage (incl. SPY/VEA MTM) + crypto bucket. */
    const investedClp = r.retirement + brokerageClp + r.crypto;
    row.invested = convertTs(investedClp, r.d, unit);

    return row;
  });

  return {
    unit,
    accounts_ex_property: accountsExProperty,
    overview: { lines: overviewLines, points: overviewPoints },
  };
}

/** Same membership as the class-tab valuation chart (brokerage excludes legacy `individual_stocks`). */
export type GroupTabAccountRow = {
  account_id: number;
  name: string;
  category_slug: string;
  category_label: string;
  cso: number;
};

export function listAccountsForGroupTab(groupSlug: string): GroupTabAccountRow[] {
  return db
    .prepare(
      `
      SELECT a.id AS account_id, a.name, c.slug AS category_slug, c.label AS category_label, c.sort_order AS cso
      FROM accounts a
      JOIN categories c ON c.id = a.category_id
      JOIN asset_groups g ON g.id = c.group_id
      WHERE g.slug = ?
        AND (a.notes IS NULL OR a.notes != ?)
        AND (g.slug != 'brokerage' OR c.slug != 'individual_stocks')
      ORDER BY c.sort_order, c.id, a.name
    `
    )
    .all(groupSlug, NOTE_STOCKS_LEGACY) as GroupTabAccountRow[];
}

export function getGroupValuationTimeseries(groupSlug: string, unit: TsUnit) {
  const rows = listAccountsForGroupTab(groupSlug);

  const pieTop: AccountLine[] = rows.map((r) => ({
    account_id: r.account_id,
    name: r.name,
    dataKey: String(r.account_id),
  }));

  /** Line chart uses every account in the group (SPY, VEA, Fintual RN, …) — no merged "Acciones" series. */
  const chartTop: AccountLine[] = pieTop;
  const merge: MergePairOpts | undefined = undefined;

  let accounts_in_group = appendGroupTabTotals(buildPointsForAccounts(chartTop, [], unit, merge));
  if (groupSlug === "liabilities" && accounts_in_group.points.length > 0) {
    const { allAvailableByDate, availableByDate } = getLiabilitiesLiquidityExtraSeries(unit);
    accounts_in_group = {
      ...accounts_in_group,
      lines: [
        { dataKey: "all_available", name: "All available" },
        { dataKey: "available", name: "Available" },
      ],
      points: accounts_in_group.points.map((row) => {
        const d = String(row.as_of_date);
        const allV = allAvailableByDate.get(d);
        const narrowV = availableByDate.get(d);
        return {
          ...row,
          all_available: allV !== undefined && Number.isFinite(allV) ? allV : null,
          available: narrowV !== undefined && Number.isFinite(narrowV) ? narrowV : null,
        };
      }),
    };
  }
  if (groupSlug === "real_estate") {
    const propertyRows = rows.filter((x) => x.category_slug === "property");
    if (propertyRows.length === 1 && accounts_in_group.points.length > 0) {
      const ledger = loadDeptoDividendosSheetLedger(resolveCfraserCsvDir());
      if (ledger.length > 0) {
        const dateStrsAsc = accounts_in_group.points.map((p) => String(p.as_of_date));
        const { restanteClpByDate } = propertyDeptoClpSeriesBySnapshotDate(dateStrsAsc, ledger);
        const dk = "depto_hipoteca_saldo_clp";
        accounts_in_group = {
          accounts: [...accounts_in_group.accounts, { account_id: -4, name: "Hipoteca (saldo CLP)", dataKey: dk }],
          points: accounts_in_group.points.map((row) => {
            const d = String(row.as_of_date);
            const raw = restanteClpByDate.get(d);
            return {
              ...row,
              [dk]: raw != null && Number.isFinite(raw) ? convertTs(raw, d, unit) : null,
            };
          }),
        };
      }
    }
  }
  const group_allocation_pie = latestAllocationPieForAccounts(pieTop, unit);

  return {
    unit,
    group_slug: groupSlug,
    accounts_in_group,
    group_allocation_pie,
  };
}

function buildDailyEquityPointsForAccount(
  accountId: number,
  name: string,
  unit: TsUnit
): { accounts: AccountLine[]; points: Record<string, string | number | null>[] } | null {
  if (!accountUsesEquityMtm(accountId)) return null;
  const ticker = equityTickerForAccount(accountId);
  if (!ticker) return null;
  const rows = db
    .prepare(`SELECT trade_date, close_usd FROM equity_daily WHERE ticker = ? ORDER BY trade_date`)
    .all(ticker) as { trade_date: string; close_usd: number }[];
  const dk = String(accountId);
  const top: AccountLine[] = [{ account_id: accountId, name, dataKey: dk }];
  const points: Record<string, string | number | null>[] = [];
  for (const r of rows) {
    const clp = computeEquityMtmClp(accountId, r.trade_date);
    if (clp == null) continue;
    points.push({
      as_of_date: r.trade_date,
      [dk]: convertTs(clp, r.trade_date, unit),
    });
  }
  return { accounts: top, points };
}

export function getAccountValuationTimeseries(
  accountId: number,
  unit: TsUnit,
  opts?: { granularity?: TimeseriesGranularity }
) {
  const row = db
    .prepare(`SELECT id AS account_id, name FROM accounts WHERE id = ?`)
    .get(accountId) as { account_id: number; name: string } | undefined;
  if (!row) return null;

  if (opts?.granularity === "daily") {
    const daily = buildDailyEquityPointsForAccount(row.account_id, row.name, unit);
    if (daily && daily.points.length > 0) {
      const allocation_pie = latestAllocationPieForAccounts(daily.accounts, unit);
      return {
        unit,
        account_id: row.account_id,
        name: row.name,
        accounts: { accounts: daily.accounts, points: daily.points },
        allocation_pie,
        granularity: "daily" as const,
      };
    }
  }

  const top: AccountLine[] = [
    { account_id: row.account_id, name: row.name, dataKey: String(row.account_id) },
  ];
  let accounts = buildPointsForAccounts(top, [], unit, undefined);

  const cat = db
    .prepare(
      `SELECT c.slug AS category_slug FROM accounts a JOIN categories c ON c.id = a.category_id WHERE a.id = ?`
    )
    .get(accountId) as { category_slug: string } | undefined;
  if (cat?.category_slug === "property" && accounts.points.length > 0) {
    const ledger = loadDeptoDividendosSheetLedger(resolveCfraserCsvDir());
    if (ledger.length > 0) {
      const dateStrsAsc = accounts.points.map((p) => String(p.as_of_date));
      const { restanteClpByDate } = propertyDeptoClpSeriesBySnapshotDate(dateStrsAsc, ledger);
      const dk = "depto_hipoteca_saldo_clp";
      accounts = {
        accounts: [...accounts.accounts, { account_id: -4, name: "Hipoteca (saldo CLP)", dataKey: dk }],
        points: accounts.points.map((row) => {
          const d = String(row.as_of_date);
          const raw = restanteClpByDate.get(d);
          return {
            ...row,
            [dk]: raw != null && Number.isFinite(raw) ? convertTs(raw, d, unit) : null,
          };
        }),
      };
    }
  }

  const allocation_pie = latestAllocationPieForAccounts(top, unit);
  return {
    unit,
    account_id: row.account_id,
    name: row.name,
    accounts,
    allocation_pie,
    granularity: "monthly" as const,
  };
}
