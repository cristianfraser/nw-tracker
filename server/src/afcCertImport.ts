/**
 * AFC (Fondo de Cesantía, Cuenta Individual) documents → the account's cuota ledger.
 *
 * Two documents from the AFC sucursal virtual, both `pdftotext -layout` text:
 *
 * 1. **Certificado de cotizaciones previsionales acreditadas** — every cotización with período,
 *    empleador, renta imponible, monto and the exact **fecha de pago**, two legs per período
 *    (Cotiz. Trabajador 0,6 % + Cotiz. Empleador 1,6 %), closed by a `TOTAL` line. No cuotas are
 *    printed anywhere, and none are needed: the cuatrimestral cartola proves the AFC values the
 *    CIC at the Superintendencia's valor cuota (`afc_cic`) and credits each cotización at the
 *    valor cuota of its pay date (2026-09-22 calibration: 35 pesos off the cartola's printed
 *    comisiones over Jan–Apr 2026). So cuotas = monto ÷ valor cuota(fecha de pago), and the two
 *    legs of a período collapse into ONE movement dated the pay date.
 *
 * 2. **Estado cuatrimestral** (cartola) — saldo inicial / final with their dates, the period's
 *    cotizaciones (by MES DE PAGO), ganancia, comisiones and the printed identity
 *    `final = inicial + ingresos − egresos`. The AFC deducts its commission in cuotas, which the
 *    SP series does not carry, so each printed saldo is evidence of the cuota count on that day:
 *    a **true-up** movement per boundary (`cash_fee` when the ledger is above the saldo — the
 *    commission — `savings_earnings` when below) lands the ledger exactly on it. Both flow kinds
 *    are P/L to every deposit reader, never personal capital.
 *
 * Identity is the note key (`AFC cotización — período YYYY-MM (pago YYYY-MM-DD)`,
 * `AFC ajuste cartola — saldo inicial|final YYYY-MM-DD`), the same convention the bank importers
 * use; re-imports are idempotent and a changed printed amount is reported as a mismatch, never
 * overwritten. Report-first: `planAfcCertImport` / `planAfcCartolaTrueUps` compute, `apply…`
 * write.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { db } from "./db.js";
import { AFC_CIC_SERIES_KEY } from "./afcCicSeries.js";
import { afpCuotasCumulativeThroughDate } from "./afpUnoValuation.js";
import { fundUnitClpOnOrBefore } from "./fundUnitDaily.js";

const SPANISH_MONTHS: Record<string, number> = {
  enero: 1,
  febrero: 2,
  marzo: 3,
  abril: 4,
  mayo: 5,
  junio: 6,
  julio: 7,
  agosto: 8,
  septiembre: 9,
  setiembre: 9,
  octubre: 10,
  noviembre: 11,
  diciembre: 12,
};

function normalizeWord(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

/** `Septiembre` → 9, or null when the word is not a Spanish month name. */
export function spanishMonthNumber(word: string): number | null {
  return SPANISH_MONTHS[normalizeWord(word)] ?? null;
}

function parseClpInteger(raw: string): number {
  const s = raw.trim().replace(/^\$/, "").replace(/\./g, "");
  if (!/^-?\d+$/.test(s)) throw new Error(`afc: unparsable CLP amount «${raw}»`);
  return Number(s);
}

function ymd(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function pdfTextLayout(filePath: string): string {
  const abs = filePath.trim();
  if (!abs || !fs.existsSync(abs)) throw new Error(`afc: file not found: ${filePath}`);
  return execFileSync("pdftotext", ["-layout", abs, "-"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}

// ---------------------------------------------------------------------------------------------
// Certificado de cotizaciones
// ---------------------------------------------------------------------------------------------

export type AfcCotizacionLeg = {
  /** `YYYY-MM` período the cotización belongs to. */
  period_ym: string;
  employer_rut: string;
  /** May be empty when the layout wrapped the name onto its own lines. */
  employer: string;
  renta_imponible_clp: number;
  amount_clp: number;
  /** Fecha de pago — the day the AFC credits the cuotas. */
  pay_ymd: string;
};

export type AfcCotizacionesCertificate = {
  legs: AfcCotizacionLeg[];
  total_clp: number;
};

const RUT_RE = /\d{1,3}(?:\.\d{3})*-[\dkK]/;
const DATA_LINE_RE = new RegExp(
  `^\\s*(?:([A-Za-zÁÉÍÓÚáéíóúñÑ]+)(?:\\s+(\\d{4}))?)?\\s*(${RUT_RE.source})\\s+(.*?)\\s*\\$([\\d.]+)\\s+\\$([\\d.]+)\\s+(\\d{2})/(\\d{2})/(\\d{4})\\s*$`
);
const BARE_MONTH_RE = /^\s*([A-Za-zÁÉÍÓÚáéíóúñÑ]+)\s*$/;
const BARE_YEAR_RE = /^\s*(\d{4})\s*$/;
const TOTAL_RE = /^\s*TOTAL\s+\$([\d.]+)\s*$/;

/**
 * Parse the certificate text. Fail-fast: every line that carries a RUT + amounts + date must
 * parse with a período (its own «Mes YYYY» prefix, or the month/year the layout printed on the
 * surrounding lines), the `TOTAL` line must exist and equal Σ montos, and every leg must be a
 * positive amount. A layout change surfaces as a thrown error, never as a skipped cotización.
 */
export function parseAfcCotizacionesCertificate(text: string): AfcCotizacionesCertificate {
  const lines = text.split(/\r?\n/);
  const legs: AfcCotizacionLeg[] = [];
  let total: number | null = null;
  let pendingMonth: number | null = null;
  let pendingPeriod: string | null = null;
  let awaitingYear: AfcCotizacionLeg[] = [];
  let inTable = false;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) continue;
    if (/Fecha de\s*$/.test(line) || /^\s*Período\b/.test(line)) {
      inTable = true;
      continue;
    }
    const total_m = TOTAL_RE.exec(line);
    if (total_m) {
      total = parseClpInteger(total_m[1]!);
      inTable = false;
      continue;
    }
    if (!inTable) continue;
    const dm = DATA_LINE_RE.exec(line);
    if (dm) {
      const [, monthWord, yearStr, rut, employer, renta, monto, dd, mm, yyyy] = dm;
      const leg: AfcCotizacionLeg = {
        period_ym: "",
        employer_rut: rut!,
        employer: (employer ?? "").trim(),
        renta_imponible_clp: parseClpInteger(renta!),
        amount_clp: parseClpInteger(monto!),
        pay_ymd: ymd(Number(yyyy), Number(mm), Number(dd)),
      };
      if (leg.amount_clp <= 0) throw new Error(`afc: non-positive cotización «${line.trim()}»`);
      if (monthWord && yearStr) {
        const mo = spanishMonthNumber(monthWord);
        if (mo == null) throw new Error(`afc: unknown month «${monthWord}» in «${line.trim()}»`);
        leg.period_ym = `${yearStr}-${String(mo).padStart(2, "0")}`;
        pendingMonth = null;
        pendingPeriod = null;
      } else if (monthWord) {
        // «Septiembre <data…>» with the year printed on the next line.
        const mo = spanishMonthNumber(monthWord);
        if (mo == null) throw new Error(`afc: unknown month «${monthWord}» in «${line.trim()}»`);
        if (awaitingYear.length > 0) throw new Error(`afc: month «${monthWord}» before the previous período's year`);
        pendingMonth = mo;
        pendingPeriod = null;
        awaitingYear.push(leg);
      } else if (pendingPeriod) {
        leg.period_ym = pendingPeriod;
      } else if (pendingMonth != null) {
        awaitingYear.push(leg);
      } else {
        throw new Error(`afc: cotización line without a período «${line.trim()}»`);
      }
      legs.push(leg);
      continue;
    }
    const ym_ = BARE_YEAR_RE.exec(line);
    if (ym_) {
      if (pendingMonth == null) throw new Error(`afc: stray year line «${line.trim()}»`);
      const period = `${ym_[1]}-${String(pendingMonth).padStart(2, "0")}`;
      if (awaitingYear.length > 0) {
        for (const l of awaitingYear) l.period_ym = period;
        awaitingYear = [];
        pendingMonth = null;
      } else {
        pendingPeriod = period;
      }
      continue;
    }
    const bm = BARE_MONTH_RE.exec(line);
    if (bm) {
      const mo = spanishMonthNumber(bm[1]!);
      if (mo != null) {
        if (awaitingYear.length > 0) throw new Error(`afc: month «${bm[1]}» before the previous período's year`);
        pendingMonth = mo;
        pendingPeriod = null;
      }
      // Any other bare word is an employer-name fragment the layout wrapped — ignored.
      continue;
    }
    // Employer fragments with several words / punctuation — ignored likewise.
  }
  if (awaitingYear.length > 0) throw new Error("afc: certificate ended with cotizaciones awaiting their year");
  if (legs.length === 0) throw new Error("afc: no cotizaciones parsed — layout changed?");
  if (total == null) throw new Error("afc: TOTAL line missing");
  const sum = legs.reduce((a, l) => a + l.amount_clp, 0);
  if (sum !== total) throw new Error(`afc: Σ cotizaciones ${sum} ≠ printed TOTAL ${total}`);
  for (const l of legs) if (!/^\d{4}-\d{2}$/.test(l.period_ym)) throw new Error("afc: leg without período");
  return { legs, total_clp: total };
}

export type AfcContribution = {
  period_ym: string;
  pay_ymd: string;
  amount_clp: number;
  employer: string;
  legs: AfcCotizacionLeg[];
};

/** One contribution per (período, fecha de pago): the trabajador + empleador legs collapse. */
export function groupAfcContributions(legs: readonly AfcCotizacionLeg[]): AfcContribution[] {
  const byKey = new Map<string, AfcContribution>();
  for (const l of legs) {
    const key = `${l.period_ym}|${l.pay_ymd}`;
    let c = byKey.get(key);
    if (!c) {
      c = { period_ym: l.period_ym, pay_ymd: l.pay_ymd, amount_clp: 0, employer: "", legs: [] };
      byKey.set(key, c);
    }
    c.amount_clp += l.amount_clp;
    c.legs.push(l);
    if (!c.employer && l.employer) c.employer = l.employer;
  }
  return [...byKey.values()].sort((a, b) => a.pay_ymd.localeCompare(b.pay_ymd) || a.period_ym.localeCompare(b.period_ym));
}

export function afcContributionNoteKey(period_ym: string, pay_ymd: string): string {
  return `AFC cotización — período ${period_ym} (pago ${pay_ymd})`;
}

function afcContributionNote(c: AfcContribution): string {
  const legs = c.legs.map((l) => `${l.amount_clp}`).join(" + ");
  const employer = c.employer ? ` · ${c.employer}` : "";
  return `${afcContributionNoteKey(c.period_ym, c.pay_ymd)}${employer} · legs ${legs}`;
}

const EXCEL_AFC_FLOW_NOTE_PREFIX = "import:excel|afc-flow";

export type AfcMovementRow = {
  id: number;
  occurred_on: string;
  amount: number;
  currency: string;
  units_delta: number | null;
  flow_kind: string | null;
  note: string | null;
  account_id: number | null;
  from_account_id: number | null;
  to_account_id: number | null;
};

function listAccountMovements(accountId: number): AfcMovementRow[] {
  return db
    .prepare(
      `SELECT id, occurred_on, amount, currency, units_delta, flow_kind, note, account_id, from_account_id, to_account_id
       FROM movements
       WHERE account_id = ? OR from_account_id = ? OR to_account_id = ?
       ORDER BY date(occurred_on), id`
    )
    .all(accountId, accountId, accountId) as AfcMovementRow[];
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function requirePx(seriesKey: string, dayYmd: string): number {
  const px = fundUnitClpOnOrBefore(seriesKey, dayYmd);
  if (px == null) throw new Error(`afc: no ${seriesKey} valor cuota on or before ${dayYmd} — run backfill:afc-cic`);
  return px;
}

export type AfcCertPlanItem = {
  contribution: AfcContribution;
  px: number;
  units: number;
  status: "insert" | "unchanged" | "update_units" | "mismatch";
  existing_id: number | null;
  detail?: string;
};

export type AfcCertPlan = {
  account_id: number;
  series_key: string;
  items: AfcCertPlanItem[];
  /** Excel-era contribution rows (`import:excel|afc-flow`, amount > 0) the certificate supersedes. */
  excel_contribution_rows: AfcMovementRow[];
  /** Other excel-era rows (withdrawals / corrections) — kept unless explicitly dropped. */
  excel_other_rows: AfcMovementRow[];
};

export function planAfcCertImport(accountId: number, cert: AfcCotizacionesCertificate): AfcCertPlan {
  const seriesKey = requireAfcSeriesKey(accountId);
  const existing = listAccountMovements(accountId);
  const singleLeg = existing.filter((m) => m.account_id === accountId);
  const items: AfcCertPlanItem[] = [];
  for (const c of groupAfcContributions(cert.legs)) {
    const px = requirePx(seriesKey, c.pay_ymd);
    const units = round4(c.amount_clp / px);
    const key = afcContributionNoteKey(c.period_ym, c.pay_ymd);
    const match = singleLeg.filter((m) => (m.note ?? "").startsWith(key));
    if (match.length > 1) throw new Error(`afc: ${match.length} movements carry the key «${key}»`);
    const m = match[0];
    if (!m) {
      items.push({ contribution: c, px, units, status: "insert", existing_id: null });
    } else if (Math.round(m.amount) !== c.amount_clp || m.currency !== "clp" || m.occurred_on !== c.pay_ymd) {
      items.push({
        contribution: c,
        px,
        units,
        status: "mismatch",
        existing_id: m.id,
        detail: `stored ${m.amount} ${m.currency} on ${m.occurred_on}`,
      });
    } else if (m.units_delta == null || Math.abs(m.units_delta - units) > 0.00005) {
      items.push({ contribution: c, px, units, status: "update_units", existing_id: m.id, detail: `stored units ${m.units_delta ?? "—"}` });
    } else {
      items.push({ contribution: c, px, units, status: "unchanged", existing_id: m.id });
    }
  }
  const excelRows = singleLeg.filter((m) => (m.note ?? "").startsWith(EXCEL_AFC_FLOW_NOTE_PREFIX));
  return {
    account_id: accountId,
    series_key: seriesKey,
    items,
    excel_contribution_rows: excelRows.filter((m) => m.amount > 0),
    excel_other_rows: excelRows.filter((m) => m.amount <= 0),
  };
}

function requireAfcSeriesKey(accountId: number): string {
  const row = db.prepare(`SELECT fund_series_key FROM accounts WHERE id = ?`).get(accountId) as
    | { fund_series_key: string | null }
    | undefined;
  if (!row) throw new Error(`afc: unknown account ${accountId}`);
  if (row.fund_series_key !== AFC_CIC_SERIES_KEY) {
    throw new Error(`afc: account ${accountId} has fund_series_key=${row.fund_series_key ?? "NULL"}, expected ${AFC_CIC_SERIES_KEY}`);
  }
  return AFC_CIC_SERIES_KEY;
}

const stmtInsertContribution = db.prepare(
  `INSERT INTO movements (account_id, amount, currency, occurred_on, note, units_delta)
   VALUES (?, ?, 'clp', ?, ?, ?)`
);
const stmtUpdateUnits = db.prepare(`UPDATE movements SET units_delta = ? WHERE id = ?`);
const stmtDeleteMovement = db.prepare(`DELETE FROM movements WHERE id = ?`);

export type AfcCertApplyResult = { inserted: number; units_updated: number; deleted: number; mismatches: number };

/**
 * Write the plan: insert / update-units the certificate contributions, delete the superseded
 * excel contribution rows when asked, plus any explicitly listed extra ids. Mismatches are never
 * written. One transaction.
 */
export function applyAfcCertImport(
  plan: AfcCertPlan,
  opts: { replaceExcelContributions: boolean; dropIds?: readonly number[] }
): AfcCertApplyResult {
  const out: AfcCertApplyResult = { inserted: 0, units_updated: 0, deleted: 0, mismatches: 0 };
  const dropIds = new Set(opts.dropIds ?? []);
  for (const id of dropIds) {
    const known = plan.excel_other_rows.some((m) => m.id === id) || plan.excel_contribution_rows.some((m) => m.id === id);
    if (!known) throw new Error(`afc: --drop-ids ${id} is not an excel-era row of account ${plan.account_id}`);
  }
  db.transaction(() => {
    if (opts.replaceExcelContributions) {
      for (const m of plan.excel_contribution_rows) {
        stmtDeleteMovement.run(m.id);
        out.deleted += 1;
      }
    }
    for (const id of dropIds) {
      if (opts.replaceExcelContributions && plan.excel_contribution_rows.some((m) => m.id === id)) continue;
      stmtDeleteMovement.run(id);
      out.deleted += 1;
    }
    for (const it of plan.items) {
      if (it.status === "insert") {
        stmtInsertContribution.run(plan.account_id, it.contribution.amount_clp, it.contribution.pay_ymd, afcContributionNote(it.contribution), it.units);
        out.inserted += 1;
      } else if (it.status === "update_units") {
        stmtUpdateUnits.run(it.units, it.existing_id);
        out.units_updated += 1;
      } else if (it.status === "mismatch") {
        out.mismatches += 1;
      }
    }
  })();
  return out;
}

// ---------------------------------------------------------------------------------------------
// Withdrawals (retiros) — units from the pay-date valor cuota, or the closing −Σ
// ---------------------------------------------------------------------------------------------

export type AfcWithdrawalPlanItem = {
  movement: AfcMovementRow;
  px: number;
  /** Magnitude to store (transfer legs store the magnitude; single-leg rows store it negative). */
  units_abs: number;
  closes_position: boolean;
  status: "set" | "unchanged";
};

function storedValuationOnOrAfter(accountId: number, dayYmd: string): { as_of_date: string; value: number } | null {
  return (
    (db
      .prepare(`SELECT as_of_date, value FROM valuations WHERE account_id = ? AND as_of_date >= ? ORDER BY as_of_date LIMIT 1`)
      .get(accountId, dayYmd) as { as_of_date: string; value: number } | undefined) ?? null
  );
}

/**
 * Units for every outflow (single-leg negative row without a P/L flow kind, or a transfer leaving
 * the account), walking the ledger in date order: a withdrawal after which the account's own
 * stored valuation reads 0 closes the position and takes exactly the cuotas held; any other one
 * is priced at the valor cuota of its date. Mutates nothing; `applyAfcWithdrawalUnits` writes.
 */
export function planAfcWithdrawalUnits(accountId: number): AfcWithdrawalPlanItem[] {
  const seriesKey = requireAfcSeriesKey(accountId);
  const rows = listAccountMovements(accountId);
  const items: AfcWithdrawalPlanItem[] = [];
  let running = 0;
  for (const m of rows) {
    const isTransfer = m.account_id == null;
    const outflow = isTransfer ? m.from_account_id === accountId : m.amount < 0;
    const plFlow = m.flow_kind === "cash_fee" || m.flow_kind === "savings_earnings";
    if (!outflow || plFlow) {
      const u = m.units_delta ?? 0;
      running = round4(running + (isTransfer ? (m.to_account_id === accountId ? Math.abs(u) : -Math.abs(u)) : u));
      continue;
    }
    if (m.currency !== "clp") throw new Error(`afc: withdrawal ${m.id} is ${m.currency}`);
    const px = requirePx(seriesKey, m.occurred_on);
    // Closing = the account's own next stored valuation reads 0 and nothing else moves the
    // ledger before it (a later row would mean this withdrawal did not empty the account).
    const nextStored = storedValuationOnOrAfter(accountId, m.occurred_on);
    const closes =
      nextStored?.value === 0 &&
      !rows.some((r) => r.id !== m.id && r.occurred_on > m.occurred_on && r.occurred_on <= nextStored.as_of_date);
    const unitsAbs = closes ? round4(running) : round4(Math.abs(m.amount) / px);
    const current = m.units_delta == null ? null : Math.abs(m.units_delta);
    const status: AfcWithdrawalPlanItem["status"] =
      current != null && Math.abs(current - unitsAbs) <= 0.00005 ? "unchanged" : "set";
    items.push({ movement: m, px, units_abs: unitsAbs, closes_position: closes, status });
    running = round4(running - unitsAbs);
  }
  return items;
}

export function applyAfcWithdrawalUnits(items: readonly AfcWithdrawalPlanItem[]): number {
  let n = 0;
  db.transaction(() => {
    for (const it of items) {
      if (it.status !== "set") continue;
      const isTransfer = it.movement.account_id == null;
      stmtUpdateUnits.run(isTransfer ? it.units_abs : -it.units_abs, it.movement.id);
      n += 1;
    }
  })();
  return n;
}

// ---------------------------------------------------------------------------------------------
// Estado cuatrimestral (cartola) — commission true-ups at the printed saldos
// ---------------------------------------------------------------------------------------------

export type AfcCartola = {
  period_from_ymd: string;
  period_to_ymd: string;
  saldo_inicial_ymd: string;
  saldo_inicial_clp: number;
  cotizaciones_clp: number;
  otros_ingresos_clp: number;
  ganancia_clp: number;
  total_ingresos_clp: number;
  comisiones_clp: number;
  otros_egresos_clp: number;
  uso_cuenta_clp: number;
  total_egresos_clp: number;
  saldo_final_ymd: string;
  saldo_final_clp: number;
  detalle: { employer: string; pay_month_ym: string; amount_clp: number }[];
};

const PERIOD_RE = /per[ií]odo del (\d{1,2}) de ([A-Za-zÁÉÍÓÚáéíóúñÑ]+) al (\d{1,2}) de ([A-Za-zÁÉÍÓÚáéíóúñÑ]+) de (\d{4})/i;
const SALDO_INICIAL_RE = /Al (\d{2})-(\d{2})-(\d{4})\s+\(1\)\s+\$([\d.]+)/;
const SALDO_FINAL_RE = /Al (\d{2})-(\d{2})-(\d{4})\s+\(1\+2-3\)\s+\$([\d.]+)/;
const AMOUNTS_RE = /\$-?[\d.]+/g;
const DETALLE_ROW_RE = /^\s*(.+?)\s{2,}([A-Za-zÁÉÍÓÚáéíóúñÑ]+)-(\d{4})\s+\$([\d.]+)\s*$/;

function monthOrThrow(word: string): number {
  const mo = spanishMonthNumber(word);
  if (mo == null) throw new Error(`afc cartola: unknown month «${word}»`);
  return mo;
}

/** Parse the cuatrimestral cartola; every printed identity is checked, a mismatch throws. */
export function parseAfcCartola(text: string): AfcCartola {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+$/, ""));
  const joined = lines.join("\n");
  const pm = PERIOD_RE.exec(joined);
  if (!pm) throw new Error("afc cartola: período line not found");
  const year = Number(pm[5]);
  const period_from_ymd = ymd(year, monthOrThrow(pm[2]!), Number(pm[1]));
  const period_to_ymd = ymd(year, monthOrThrow(pm[4]!), Number(pm[3]));
  const si = SALDO_INICIAL_RE.exec(joined);
  const sf = SALDO_FINAL_RE.exec(joined);
  if (!si) throw new Error("afc cartola: saldo inicial not found");
  if (!sf) throw new Error("afc cartola: saldo final not found");
  const saldo_inicial_ymd = ymd(Number(si[3]), Number(si[2]), Number(si[1]));
  const saldo_final_ymd = ymd(Number(sf[3]), Number(sf[2]), Number(sf[1]));
  const saldo_inicial_clp = parseClpInteger(si[4]!);
  const saldo_final_clp = parseClpInteger(sf[4]!);

  const amountsAfter = (headerRe: RegExp, count: number, what: string): number[] => {
    const idx = lines.findIndex((l) => headerRe.test(l));
    if (idx < 0) throw new Error(`afc cartola: «${what}» header not found`);
    for (let i = idx + 1; i < Math.min(lines.length, idx + 4); i++) {
      const found = lines[i]!.match(AMOUNTS_RE);
      if (found && found.length >= count) return found.slice(0, count).map(parseClpInteger);
    }
    throw new Error(`afc cartola: ${count} amounts under «${what}» not found`);
  };
  const [cotizaciones_clp, otros_ingresos_clp, ganancia_clp, total_ingresos_clp] = amountsAfter(
    /Total de cotizaciones/,
    4,
    "Total de cotizaciones"
  ) as [number, number, number, number];
  const [comisiones_clp, otros_egresos_clp, uso_cuenta_clp, total_egresos_clp] = amountsAfter(
    /Total comisiones/,
    4,
    "Total comisiones"
  ) as [number, number, number, number];

  const detalle: AfcCartola["detalle"] = [];
  const dStart = lines.findIndex((l) => /Detalle de cotizaciones/.test(l));
  if (dStart < 0) throw new Error("afc cartola: «Detalle de cotizaciones» not found");
  for (let i = dStart + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (/^\s*Total\s+\$/.test(l) || /Beneficios del Fondo/.test(l)) break;
    const dm = DETALLE_ROW_RE.exec(l);
    if (!dm) continue;
    detalle.push({
      employer: dm[1]!.trim(),
      pay_month_ym: `${dm[3]}-${String(monthOrThrow(dm[2]!)).padStart(2, "0")}`,
      amount_clp: parseClpInteger(dm[4]!),
    });
  }

  if (cotizaciones_clp + otros_ingresos_clp + ganancia_clp !== total_ingresos_clp) {
    throw new Error("afc cartola: ingresos do not add up to the printed total");
  }
  if (comisiones_clp + otros_egresos_clp + uso_cuenta_clp !== total_egresos_clp) {
    throw new Error("afc cartola: egresos do not add up to the printed total");
  }
  if (saldo_inicial_clp + total_ingresos_clp - total_egresos_clp !== saldo_final_clp) {
    throw new Error("afc cartola: saldo final ≠ inicial + ingresos − egresos");
  }
  const detalleSum = detalle.reduce((a, d) => a + d.amount_clp, 0);
  if (detalleSum !== cotizaciones_clp) {
    throw new Error(`afc cartola: Σ detalle ${detalleSum} ≠ Total de cotizaciones ${cotizaciones_clp}`);
  }
  return {
    period_from_ymd,
    period_to_ymd,
    saldo_inicial_ymd,
    saldo_inicial_clp,
    cotizaciones_clp,
    otros_ingresos_clp,
    ganancia_clp,
    total_ingresos_clp,
    comisiones_clp,
    otros_egresos_clp,
    uso_cuenta_clp,
    total_egresos_clp,
    saldo_final_ymd,
    saldo_final_clp,
    detalle,
  };
}

export function afcCartolaTrueUpNoteKey(which: "inicial" | "final", dayYmd: string): string {
  return `AFC ajuste cartola — saldo ${which} ${dayYmd}`;
}

export type AfcCartolaTrueUp = {
  which: "inicial" | "final";
  day_ymd: string;
  saldo_clp: number;
  px: number;
  target_units: number;
  /** Ledger cuotas through the day, excluding this boundary's own true-up row. */
  ledger_units: number;
  /** Units the true-up row carries (negative = commission). */
  units: number;
  amount_clp: number;
  flow_kind: "cash_fee" | "savings_earnings" | null;
  existing_id: number | null;
  status: "insert" | "update" | "unchanged" | "none" | "delete";
};

export type AfcCartolaPlan = {
  account_id: number;
  cartola: AfcCartola;
  /** Certificate-imported contributions paid inside the period, checked against the cartola. */
  ledger_cotizaciones_clp: number;
  trueups: AfcCartolaTrueUp[];
};

function trueUpRowFor(accountId: number, key: string): AfcMovementRow | null {
  const rows = db
    .prepare(`SELECT id, occurred_on, amount, currency, units_delta, flow_kind, note, account_id, from_account_id, to_account_id
              FROM movements WHERE account_id = ? AND note LIKE ? ORDER BY id`)
    .all(accountId, `${key}%`) as AfcMovementRow[];
  if (rows.length > 1) throw new Error(`afc: ${rows.length} true-up rows carry «${key}»`);
  return rows[0] ?? null;
}

/**
 * True-ups at both printed saldos. The inicial boundary is planned first and its units are
 * folded into the ledger before the final boundary is measured (both computed against the
 * current DB plus the planned inicial row). The period's contributions in the ledger must equal
 * the cartola's «Total de cotizaciones» — otherwise the certificate import is incomplete and the
 * true-up would silently absorb missing cotizaciones as «commission».
 */
export function planAfcCartolaTrueUps(accountId: number, cartola: AfcCartola): AfcCartolaPlan {
  const seriesKey = requireAfcSeriesKey(accountId);
  const rows = listAccountMovements(accountId).filter((m) => m.account_id === accountId);
  const inPeriod = rows.filter(
    (m) =>
      m.occurred_on > cartola.saldo_inicial_ymd &&
      m.occurred_on <= cartola.saldo_final_ymd &&
      (m.note ?? "").startsWith("AFC cotización — período")
  );
  const ledger_cotizaciones_clp = inPeriod.reduce((a, m) => a + Math.round(m.amount), 0);
  if (ledger_cotizaciones_clp !== cartola.cotizaciones_clp) {
    throw new Error(
      `afc cartola: ledger cotizaciones ${ledger_cotizaciones_clp} in (${cartola.saldo_inicial_ymd}, ${cartola.saldo_final_ymd}] ≠ printed ${cartola.cotizaciones_clp} — import the certificate first`
    );
  }
  const trueups: AfcCartolaTrueUp[] = [];
  let carriedInicialUnits = 0;
  for (const which of ["inicial", "final"] as const) {
    const day = which === "inicial" ? cartola.saldo_inicial_ymd : cartola.saldo_final_ymd;
    const saldo = which === "inicial" ? cartola.saldo_inicial_clp : cartola.saldo_final_clp;
    const px = requirePx(seriesKey, day);
    const target = round4(saldo / px);
    const existing = trueUpRowFor(accountId, afcCartolaTrueUpNoteKey(which, day));
    const existingUnits = existing?.units_delta ?? 0;
    // Ledger through the day, minus this boundary's own row, plus the inicial row as planned.
    const ledger = round4(afpCuotasCumulativeThroughDate(accountId, day) - existingUnits + (which === "final" ? carriedInicialUnits : 0));
    const units = round4(target - ledger);
    const amount = Math.round(units * px);
    const flow_kind: AfcCartolaTrueUp["flow_kind"] = amount === 0 ? null : amount < 0 ? "cash_fee" : "savings_earnings";
    let status: AfcCartolaTrueUp["status"];
    if (Math.abs(amount) < 1) status = existing ? "delete" : "none";
    else if (!existing) status = "insert";
    else if (Math.abs((existing.units_delta ?? 0) - units) > 0.00005 || Math.round(existing.amount) !== amount) status = "update";
    else status = "unchanged";
    if (which === "inicial") {
      // What the final boundary will see: the planned inicial units replace the stored ones.
      carriedInicialUnits = round4(units - existingUnits);
    }
    trueups.push({ which, day_ymd: day, saldo_clp: saldo, px, target_units: target, ledger_units: ledger, units, amount_clp: amount, flow_kind, existing_id: existing?.id ?? null, status });
  }
  return { account_id: accountId, cartola, ledger_cotizaciones_clp, trueups };
}

const stmtInsertTrueUp = db.prepare(
  `INSERT INTO movements (account_id, amount, currency, occurred_on, note, units_delta, flow_kind)
   VALUES (?, ?, 'clp', ?, ?, ?, ?)`
);
const stmtUpdateTrueUp = db.prepare(
  `UPDATE movements SET amount = ?, units_delta = ?, flow_kind = ?, note = ? WHERE id = ?`
);

function trueUpNote(t: AfcCartolaTrueUp, c: AfcCartola): string {
  return (
    `${afcCartolaTrueUpNoteKey(t.which, t.day_ymd)} · cartola ${c.period_from_ymd}..${c.period_to_ymd}` +
    ` · saldo $${t.saldo_clp} ÷ ${t.px} = ${t.target_units} cuotas vs ledger ${t.ledger_units}` +
    (t.which === "final" ? ` · comisiones impresas $${c.comisiones_clp}` : "")
  );
}

export function applyAfcCartolaTrueUps(plan: AfcCartolaPlan): { inserted: number; updated: number; deleted: number } {
  const out = { inserted: 0, updated: 0, deleted: 0 };
  db.transaction(() => {
    for (const t of plan.trueups) {
      const note = trueUpNote(t, plan.cartola);
      if (t.status === "insert") {
        stmtInsertTrueUp.run(plan.account_id, t.amount_clp, t.day_ymd, note, t.units, t.flow_kind);
        out.inserted += 1;
      } else if (t.status === "update") {
        stmtUpdateTrueUp.run(t.amount_clp, t.units, t.flow_kind, note, t.existing_id);
        out.updated += 1;
      } else if (t.status === "delete") {
        stmtDeleteMovement.run(t.existing_id);
        out.deleted += 1;
      }
    }
  })();
  return out;
}
