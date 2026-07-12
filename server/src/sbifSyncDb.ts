import { db } from "./db.js";

const upsertUf = db.prepare(`
  INSERT INTO uf_daily (date, clp_per_uf) VALUES (?, ?)
  ON CONFLICT(date) DO UPDATE SET clp_per_uf = excluded.clp_per_uf
`);

const upsertUtm = db.prepare(`
  INSERT INTO utm_daily (date, utm_clp) VALUES (?, ?)
  ON CONFLICT(date) DO UPDATE SET utm_clp = excluded.utm_clp
`);

const upsertIpc = db.prepare(`
  INSERT INTO ipc_daily (date, ipc_index) VALUES (?, ?)
  ON CONFLICT(date) DO UPDATE SET ipc_index = excluded.ipc_index
`);

const upsertFx = db.prepare(`
  INSERT INTO fx_daily (date, clp_per_usd) VALUES (?, ?)
  ON CONFLICT(date) DO UPDATE SET clp_per_usd = excluded.clp_per_usd
`);

const upsertFxBcentral = db.prepare(`
  INSERT INTO fx_daily_bcentral (date, clp_per_usd) VALUES (?, ?)
  ON CONFLICT(date) DO UPDATE SET clp_per_usd = excluded.clp_per_usd
`);

const upsertEur = db.prepare(`
  INSERT INTO eur_daily (date, clp_per_eur) VALUES (?, ?)
  ON CONFLICT(date) DO UPDATE SET clp_per_eur = excluded.clp_per_eur
`);

export function upsertUfRows(rows: { date: string; clpPerUf: number }[], dryRun: boolean): number {
  if (dryRun) return rows.length;
  let n = 0;
  for (const r of rows) {
    upsertUf.run(r.date, r.clpPerUf);
    n++;
  }
  return n;
}

export function upsertUtmRows(rows: { date: string; utmClp: number }[], dryRun: boolean): number {
  if (dryRun) return rows.length;
  let n = 0;
  for (const r of rows) {
    upsertUtm.run(r.date, r.utmClp);
    n++;
  }
  return n;
}

export function upsertIpcRows(rows: { date: string; ipcIndex: number }[], dryRun: boolean): number {
  if (dryRun) return rows.length;
  let n = 0;
  for (const r of rows) {
    upsertIpc.run(r.date, r.ipcIndex);
    n++;
  }
  return n;
}

export function upsertFxRows(rows: { date: string; clpPerUsd: number }[], dryRun: boolean): number {
  if (dryRun) return rows.length;
  let n = 0;
  for (const r of rows) {
    upsertFx.run(r.date, r.clpPerUsd);
    n++;
  }
  return n;
}

export function upsertFxBcentralRows(rows: { date: string; clpPerUsd: number }[], dryRun: boolean): number {
  if (dryRun) return rows.length;
  let n = 0;
  for (const r of rows) {
    upsertFxBcentral.run(r.date, r.clpPerUsd);
    n++;
  }
  return n;
}

export function upsertEurRows(rows: { date: string; clpPerEur: number }[], dryRun: boolean): number {
  if (dryRun) return rows.length;
  let n = 0;
  for (const r of rows) {
    upsertEur.run(r.date, r.clpPerEur);
    n++;
  }
  return n;
}

export function maxFxDate(): string | null {
  const r = db.prepare(`SELECT MAX(date) AS d FROM fx_daily`).get() as { d: string | null };
  return r?.d ?? null;
}

export function maxEurDate(): string | null {
  const r = db.prepare(`SELECT MAX(date) AS d FROM eur_daily`).get() as { d: string | null };
  return r?.d ?? null;
}

/** Latest Yahoo CLP=X EOD row on or before `asOfYmd`. */
export function maxFxDateOnOrBefore(asOfYmd: string): string | null {
  const r = db
    .prepare(`SELECT MAX(date) AS d FROM fx_daily WHERE date <= ?`)
    .get(asOfYmd) as { d: string | null };
  return r?.d ?? null;
}

/** Latest BCentral dólar observado row on or before `asOfYmd`. */
export function maxFxBcentralDateOnOrBefore(asOfYmd: string): string | null {
  const r = db
    .prepare(`SELECT MAX(date) AS d FROM fx_daily_bcentral WHERE date <= ?`)
    .get(asOfYmd) as { d: string | null };
  return r?.d ?? null;
}

/** Latest BCentral dólar observado value row on or before `asOfYmd`. */
export function fxBcentralRowOnOrBefore(
  asOfYmd: string
): { date: string; clp_per_usd: number } | null {
  const r = db
    .prepare(
      `SELECT date, clp_per_usd FROM fx_daily_bcentral WHERE date <= ? ORDER BY date DESC LIMIT 1`
    )
    .get(asOfYmd) as { date: string; clp_per_usd: number } | undefined;
  return r ?? null;
}

export function maxEurDateOnOrBefore(asOfYmd: string): string | null {
  const r = db
    .prepare(`SELECT MAX(date) AS d FROM eur_daily WHERE date <= ?`)
    .get(asOfYmd) as { d: string | null };
  return r?.d ?? null;
}

export function maxUfDate(): string | null {
  const r = db.prepare(`SELECT MAX(date) AS d FROM uf_daily`).get() as { d: string | null };
  return r?.d ?? null;
}

export function maxUtmMonthParts(): { y: number; m: number } | null {
  const r = db.prepare(`SELECT MAX(date) AS d FROM utm_daily`).get() as { d: string | null };
  if (!r?.d) return null;
  const [y, mo] = r.d.split("-").map((x) => parseInt(x, 10));
  if (!Number.isFinite(y) || !Number.isFinite(mo)) return null;
  return { y, m: mo };
}

export function maxIpcMonthParts(): { y: number; m: number } | null {
  const r = db.prepare(`SELECT MAX(date) AS d FROM ipc_daily`).get() as { d: string | null };
  if (!r?.d) return null;
  const [y, mo] = r.d.split("-").map((x) => parseInt(x, 10));
  if (!Number.isFinite(y) || !Number.isFinite(mo)) return null;
  return { y, m: mo };
}

/** Table may not exist before migration — treat as empty. */
export function safeMaxUtmMonthParts(): { y: number; m: number } | null {
  try {
    return maxUtmMonthParts();
  } catch {
    return null;
  }
}

export function safeMaxIpcMonthParts(): { y: number; m: number } | null {
  try {
    return maxIpcMonthParts();
  } catch {
    return null;
  }
}
