/**
 * Loads monthly history from cfraser.xlsx (Apple Numbers → Excel export) into SQLite.
 *
 * - Removes prior imports (notes matching import:excel% or import:cfraser%).
 * - Rebuilds accounts + valuations (and optional FX from variables sheet).
 *
 * Run from repo: `cd server && npm run import:excel`
 * Override path: `EXCEL_PATH=/path/to/file.xlsx npm run import:excel`
 *
 * Optional: `IMPORT_MAX_MONTH=2026-05` — skip months after this (YYYY-MM), e.g. to drop Numbers projections.
 * Default: skip months after the **current** calendar month (UTC).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";
import { db, initSchema, runMigrations } from "../src/db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type MonthKey = string;
type Row = (string | number | Date | null | undefined)[];

function monthKey(d: Date): MonthKey {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  return `${y}-${String(m).padStart(2, "0")}`;
}

function asOfDate(mk: MonthKey): string {
  return `${mk}-01`;
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const t = v.replace(/[$\s]/g, "").replace(/\./g, "").replace(/,/g, ".");
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function readSheetRows(wb: XLSX.WorkBook, sheetName: string): Row[] {
  const sh = wb.Sheets[sheetName];
  if (!sh) {
    console.warn(`missing sheet: ${sheetName}`);
    return [];
  }
  return XLSX.utils.sheet_to_json<Row>(sh, { header: 1, defval: null, raw: true }) as Row[];
}

function eachDateRow(rows: Row[], fn: (date: Date, row: Row) => void) {
  for (const row of rows) {
    const d = row[0];
    if (!(d instanceof Date) || Number.isNaN(d.getTime())) continue;
    fn(d, row);
  }
}

function main() {
  const excelPath = process.env.EXCEL_PATH
    ? path.resolve(process.env.EXCEL_PATH)
    : path.resolve(__dirname, "..", "..", "cfraser.xlsx");

  if (!fs.existsSync(excelPath)) {
    console.error(`Excel not found: ${excelPath}`);
    process.exit(1);
  }

  initSchema();
  runMigrations();

  const wipe = db.transaction(() => {
    db.exec(`
      DELETE FROM valuations WHERE account_id IN (
        SELECT id FROM accounts WHERE notes LIKE 'import:excel%' OR notes LIKE 'import:cfraser%'
      );
      DELETE FROM movements WHERE account_id IN (
        SELECT id FROM accounts WHERE notes LIKE 'import:excel%' OR notes LIKE 'import:cfraser%'
      );
      DELETE FROM accounts WHERE notes LIKE 'import:excel%' OR notes LIKE 'import:cfraser%';
      DELETE FROM fx_daily;
    `);
  });
  wipe();

  const catStmt = db.prepare("SELECT id FROM categories WHERE slug = ?");
  const catId = (slug: string) => (catStmt.get(slug) as { id: number }).id;

  const insAcc = db.prepare(
    "INSERT INTO accounts (category_id, name, notes) VALUES (?, ?, ?)"
  );

  function ensureAccount(slug: string, name: string, key: string): number {
    const note = `import:excel|key=${key}`;
    const row = db.prepare("SELECT id FROM accounts WHERE notes = ?").get(note) as { id: number } | undefined;
    if (row) return row.id;
    const r = insAcc.run(catId(slug), name, note);
    return Number(r.lastInsertRowid);
  }

  const accounts = {
    afp: ensureAccount("afp", "AFP", "afp"),
    apv_a: ensureAccount("apv", "APV régimen A", "apv_a"),
    apv_b: ensureAccount("apv", "APV régimen B", "apv_b"),
    afc: ensureAccount("afc", "AFC", "afc"),
    fintual_rn: ensureAccount("fintual_risky_norris", "Fintual — Risky Norris", "fintual_rn"),
    stocks: ensureAccount("individual_stocks", "Acciones (USD)", "stocks"),
    fondo_reserva: ensureAccount("fondo_reserva", "Reserva (Fintual / sheet)", "fondo_reserva"),
    cuenta_corriente: ensureAccount("cuenta_corriente", "Cuenta corriente", "cuenta_corriente"),
    bitcoin: ensureAccount("bitcoin", "Bitcoin", "bitcoin"),
    eth: ensureAccount("eth", "Ether", "eth"),
    property: ensureAccount("property", "Inmuebles (total hoja)", "property"),
    mortgage: ensureAccount("mortgage", "Pasivos (total hoja)", "mortgage"),
  };

  const upsertVal = db.prepare(`
    INSERT INTO valuations (account_id, as_of_date, value_clp)
    VALUES (@account_id, @as_of_date, @value_clp)
    ON CONFLICT(account_id, as_of_date) DO UPDATE SET value_clp = excluded.value_clp
  `);

  const upsertFx = db.prepare(`
    INSERT INTO fx_daily (date, clp_per_usd) VALUES (@date, @clp_per_usd)
    ON CONFLICT(date) DO UPDATE SET clp_per_usd = excluded.clp_per_usd
  `);

  type Bucket = {
    fintual_direct?: number | null;
    stocks?: number | null;
    brokerage_total?: number | null;
    reserva?: number | null;
    afp?: number | null;
    apv_a?: number | null;
    apv_b?: number | null;
    afc?: number | null;
    cuenta?: number | null;
    btc?: number | null;
    eth?: number | null;
    property?: number | null;
    liabilities?: number | null;
    fx?: number | null;
  };

  const byMonth = new Map<MonthKey, Bucket>();

  const maxMonth: MonthKey =
    (process.env.IMPORT_MAX_MONTH as MonthKey | undefined) ??
    monthKey(new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)));

  function bump(mk: MonthKey, patch: Partial<Bucket>) {
    if (mk > maxMonth) return;
    const cur = byMonth.get(mk) ?? {};
    Object.assign(cur, patch);
    byMonth.set(mk, cur);
  }

  const buf = fs.readFileSync(excelPath);
  const wb = XLSX.read(buf, { type: "buffer", cellDates: true });

  const t13 = readSheetRows(wb, "net worth - Table 1-3");
  eachDateRow(t13, (d, row) => {
    const mk = monthKey(d);
    bump(mk, {
      fintual_direct: num(row[11]),
      stocks: num(row[18]),
      brokerage_total: num(row[4]),
      reserva: num(row[25]),
      afp: num(row[43]),
      apv_a: num(row[50]),
      apv_b: num(row[57]),
      afc: num(row[35]),
    });
  });

  const t121 = readSheetRows(wb, "net worth - Table 1-2-1");
  eachDateRow(t121, (d, row) => {
    bump(monthKey(d), { cuenta: num(row[2]) });
  });

  const t11 = readSheetRows(wb, "net worth - Table 1-1");
  eachDateRow(t11, (d, row) => {
    bump(monthKey(d), {
      property: num(row[6]),
      liabilities: num(row[11]),
    });
  });

  const cripto = readSheetRows(wb, "net worth - criptomonedas");
  eachDateRow(cripto, (d, row) => {
    bump(monthKey(d), { btc: num(row[3]), eth: num(row[4]) });
  });

  const fxRows = readSheetRows(wb, "variables - Table 1-1");
  eachDateRow(fxRows, (d, row) => {
    const rate = num(row[1]);
    bump(monthKey(d), { fx: rate });
  });

  /** Derive Fintual balance when column 11 missing */
  for (const [, b] of byMonth) {
    if (b.fintual_direct != null) {
      (b as Bucket & { fintual?: number }).fintual = b.fintual_direct;
    } else if (b.brokerage_total != null) {
      if (b.stocks != null) {
        (b as Bucket & { fintual?: number }).fintual = b.brokerage_total - b.stocks;
      } else {
        (b as Bucket & { fintual?: number }).fintual = b.brokerage_total;
      }
    }
  }

  const tx = db.transaction(() => {
    let valCount = 0;
    for (const [mk, b] of [...byMonth.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const asOf = asOfDate(mk);
      const put = (accountId: number, v: number | null | undefined, allowNonPositive = false) => {
        if (v == null || !Number.isFinite(v)) return;
        if (!allowNonPositive && v <= 0) return;
        upsertVal.run({ account_id: accountId, as_of_date: asOf, value_clp: v });
        valCount += 1;
      };

      const fint = (b as Bucket & { fintual?: number }).fintual;
      if (fint != null && fint > 0) put(accounts.fintual_rn, fint);
      put(accounts.stocks, b.stocks);
      put(accounts.fondo_reserva, b.reserva);
      put(accounts.afp, b.afp);
      put(accounts.apv_a, b.apv_a);
      put(accounts.apv_b, b.apv_b);
      put(accounts.afc, b.afc);
      put(accounts.cuenta_corriente, b.cuenta);
      put(accounts.bitcoin, b.btc);
      put(accounts.eth, b.eth);
      put(accounts.property, b.property);
      put(accounts.mortgage, b.liabilities, true);

      if (b.fx != null && b.fx > 50 && b.fx < 50000) {
        upsertFx.run({ date: asOf, clp_per_usd: b.fx });
      }
    }
    console.log(`import:excel valuations upserted (rows touched): ${valCount}`);
  });
  tx();

  console.log(`Done. Source: ${excelPath}`);
}

main();
