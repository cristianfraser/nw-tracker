/**
 * Fintual "certificado de transacciones" import (standalone).
 *
 * The certificado CSV (mailed from Fintual, installed into `cfraser/` by the inbox importer)
 * is the only source of the exact cuota amounts per flow. This module owns the v2 cert
 * accounts (`import:fintual|cert|key=…`) and rebuilds their movement rows from the CSV:
 * a scoped delete of prior `import:fintual|cert|movement` rows followed by a re-insert, so
 * manually entered movements on the same accounts are preserved and the import is idempotent.
 *
 * Deposit classification (personal vs APV-A state bonus) is resolved here at import time and
 * written to the `movements.flow_kind` column — never parsed from the note at runtime.
 */
import { chileCalendarTodayYmd } from "./chileDate.js";
import { db } from "./db.js";
import { resolveCfraserCsvDir } from "./cfraserPaths.js";
import { reseedAllAccountSyncSources } from "./accountSyncSources.js";
import { seedNavTree } from "./seedNavTree.js";
import { DEPOSIT_FLOW_KIND_PERSONAL } from "./depositFlowKind.js";
import {
  aggregateFintualCertificado,
  resolveFintualCertificadoCsvPath,
  type FintualCertificadoAggregateScan,
} from "./fintualCertificadoTransacciones.js";
import {
  FINTUAL_CERT_MOVEMENT_NOTE_PREFIX,
  FINTUAL_CERT_V2_ACCOUNT_NAMES,
  FINTUAL_CERT_V2_CATEGORY_SLUG,
  assetGroupIdForFintualCertV2Notes,
  fintualCertV2SeriesKeyFromImportNotes,
  matchFintualCertGoalV2,
} from "./fintualCertV2.js";
import { backfillFintualCertValorCuotaFromScan } from "./fintualFundUnitDaily.js";

function excludeFromGroupTotalsForCategory(categorySlug: string): number {
  return categorySlug === "cuenta_corriente" || categorySlug === "cuenta_vista" ? 1 : 0;
}

/** Find-or-create a v2 cert account by its `import:fintual|cert|key=…` note; refresh its metadata. */
export function ensureFintualCertV2Account(importNotes: string): number {
  const categorySlug = FINTUAL_CERT_V2_CATEGORY_SLUG[importNotes];
  const displayName = FINTUAL_CERT_V2_ACCOUNT_NAMES[importNotes];
  if (!categorySlug || !displayName) {
    throw new Error(`Unknown Fintual cert v2 notes: ${importNotes}`);
  }
  const exclude = excludeFromGroupTotalsForCategory(categorySlug);
  const fundSeriesKey = fintualCertV2SeriesKeyFromImportNotes(importNotes);
  const bucketId = assetGroupIdForFintualCertV2Notes(importNotes);
  const row = db.prepare("SELECT id FROM accounts WHERE import_key = ?").get(importNotes) as
    | { id: number }
    | undefined;
  if (row) {
    db.prepare("UPDATE accounts SET name = ?, asset_group_id = ?, exclude_from_group_totals = ? WHERE id = ?").run(
      displayName,
      bucketId,
      exclude,
      row.id
    );
    if (fundSeriesKey) db.prepare("UPDATE accounts SET fund_series_key = ? WHERE id = ?").run(fundSeriesKey, row.id);
    return row.id;
  }
  const r = db
    .prepare(
      "INSERT INTO accounts (asset_group_id, name, notes, import_key, exclude_from_group_totals, equity_ticker, fund_series_key) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .run(bucketId, displayName, importNotes, importNotes, exclude, null, fundSeriesKey);
  return Number(r.lastInsertRowid);
}

function ensureAllFintualCertV2Accounts(): Record<string, number> {
  const byNote: Record<string, number> = {};
  for (const importNotes of Object.keys(FINTUAL_CERT_V2_ACCOUNT_NAMES)) {
    byNote[importNotes] = ensureFintualCertV2Account(importNotes);
  }
  return byNote;
}

type CertPlanRow = {
  importNote: string;
  ymd: string;
  amountClp: number;
  cuotasNet: number;
  /** Non-default deposit classification (state bonus / traspaso); NULL for a plain personal deposit. */
  flowKind: string | null;
  note: string;
};

/** Movements the certificado would produce, one per CSV flow row (no DB access). */
function certPlanRows(scan: FintualCertificadoAggregateScan): CertPlanRow[] {
  const out: CertPlanRow[] = [];
  for (const a of scan.sortedAggregates) {
    const importNote = matchFintualCertGoalV2(a.goalId, a.name);
    if (!importNote) continue;

    let impliedClp = a.clpNet;
    if (impliedClp === 0 && a.cuotasNet !== 0 && a.valorCuotaHint != null) {
      impliedClp = Math.round(a.cuotasNet * a.valorCuotaHint);
    }
    if (impliedClp === 0) continue;

    const medio = [...a.medios].sort().join("; ");
    // A plain personal deposit stays NULL in flow_kind — the sign of amount distinguishes deposit
    // vs withdrawal. Only the non-default kinds (state bonus / traspaso) are stored. The note is
    // human provenance only (goal / day / medio).
    const flowKind = a.flowKind === DEPOSIT_FLOW_KIND_PERSONAL ? null : a.flowKind;
    const note = `${FINTUAL_CERT_MOVEMENT_NOTE_PREFIX}|goal=${a.goalId}|day=${a.ymd}${medio ? `|medio=${medio}` : ""}`;
    out.push({ importNote, ymd: a.ymd, amountClp: impliedClp, cuotasNet: a.cuotasNet, flowKind, note });
  }
  return out;
}

/** Days of skew tolerated between a DB flow date and the cert settlement date. Manual entries and
 * mirror-merge transfers are dated the checking-outflow day (or when the user recorded them), while
 * the certificado uses the fund settlement day — typically 0–3 business days apart, either way. */
const CERT_MATCH_WINDOW_DAYS = 5;

type ExistingFlow = {
  movementId: number;
  accountId: number;
  ymd: string;
  /** Signed from the fund account's perspective: deposits +, withdrawals −. */
  signedClp: number;
  kind: "cert" | "single" | "transfer";
};

function dayDistance(a: string, b: string): number {
  return Math.abs(Math.round((Date.parse(a) - Date.parse(b)) / 86_400_000));
}

/** All curated flows touching the account: single-leg rows plus signed transfer legs. */
function loadExistingFlows(accountIds: number[]): ExistingFlow[] {
  if (accountIds.length === 0) return [];
  const ph = accountIds.map(() => "?").join(",");
  const out: ExistingFlow[] = [];
  const singles = db
    .prepare(
      `SELECT id, account_id, occurred_on, amount_clp, note FROM movements
       WHERE account_id IN (${ph})`
    )
    .all(...accountIds) as { id: number; account_id: number; occurred_on: string; amount_clp: number; note: string | null }[];
  for (const r of singles) {
    out.push({
      movementId: r.id,
      accountId: r.account_id,
      ymd: r.occurred_on,
      signedClp: r.amount_clp,
      kind: r.note?.startsWith(FINTUAL_CERT_MOVEMENT_NOTE_PREFIX) ? "cert" : "single",
    });
  }
  const transfers = db
    .prepare(
      `SELECT id, from_account_id, to_account_id, occurred_on, amount_clp FROM movements
       WHERE account_id IS NULL AND (from_account_id IN (${ph}) OR to_account_id IN (${ph}))`
    )
    .all(...accountIds, ...accountIds) as {
    id: number;
    from_account_id: number | null;
    to_account_id: number | null;
    occurred_on: string;
    amount_clp: number;
  }[];
  const idSet = new Set(accountIds);
  for (const r of transfers) {
    if (r.to_account_id != null && idSet.has(r.to_account_id)) {
      out.push({ movementId: r.id, accountId: r.to_account_id, ymd: r.occurred_on, signedClp: Math.abs(r.amount_clp), kind: "transfer" });
    }
    if (r.from_account_id != null && idSet.has(r.from_account_id)) {
      out.push({ movementId: r.id, accountId: r.from_account_id, ymd: r.occurred_on, signedClp: -Math.abs(r.amount_clp), kind: "transfer" });
    }
  }
  return out;
}

export type FintualCertImportResult = {
  csvPath: string;
  applied: boolean;
  accountsEnsured: number;
  /** Certificado rows covered by an existing flow (single-leg, transfer leg, or cert row). */
  matched: number;
  /** Certificado rows with no matching flow in the DB — added when applied, listed otherwise. */
  missing: { importNote: string; ymd: string; amountClp: number }[];
  /** DB flows on the cert accounts that no certificado row matches (manual edits, older certs) — never modified. */
  dbOnly: { importNote: string; ymd: string; amountClp: number; kind: string }[];
  fundUnitRows: number;
};

/**
 * Reconcile the v2 Fintual cert accounts against the installed certificado CSV.
 *
 * Non-destructive by design: existing curated movements are the source of truth and are never
 * deleted or modified. A certificado row counts as present when ANY existing flow on the account
 * matches it — a cert-note row, a plain single-leg row, or a transfer leg (mirror-merge / manual
 * entry; signed by direction) — with the exact amount within a ±CERT_MATCH_WINDOW_DAYS window
 * (transfer legs are dated the checking-outflow day, the cert the settlement day). Multiplicity
 * aware: each existing flow covers at most one cert row, nearest date first. Only cert rows no
 * flow covers are reported and — when `apply` is set — added. DB flows the certificado does not
 * cover are reported for manual review.
 *
 * Throws if the CSV is absent (fail fast — run `npm run import:cfraser-inbox` to install it).
 */
export function importFintualCertificado(opts?: {
  maxMonth?: string;
  apply?: boolean;
}): FintualCertImportResult {
  const apply = opts?.apply ?? false;
  const cfraserDir = resolveCfraserCsvDir();
  const csvPath = resolveFintualCertificadoCsvPath(cfraserDir);
  if (!csvPath) {
    throw new Error(
      "Fintual certificado CSV not found. Install it with `npm run import:cfraser-inbox` " +
        "(drop certificado_de_transacciones.csv in cfraser/inbox/)."
    );
  }
  const maxMonth = opts?.maxMonth ?? chileCalendarTodayYmd().slice(0, 7);

  const scan = aggregateFintualCertificado(csvPath, maxMonth, matchFintualCertGoalV2);
  if (!scan) {
    throw new Error(`Fintual certificado CSV could not be parsed: ${csvPath}`);
  }
  const plan = certPlanRows(scan);

  const reconcile = db.transaction(() => {
    const accountIdByNote = ensureAllFintualCertV2Accounts();
    const ids = Object.values(accountIdByNote);
    const noteByAccount = new Map<number, string>();
    for (const [note, id] of Object.entries(accountIdByNote)) noteByAccount.set(id, note);

    const flows = loadExistingFlows(ids);
    const usedFlow = new Set<number>(); // index into flows

    // Greedy nearest-date matching, exact signed amount, multiplicity aware.
    const matchFlowFor = (accountId: number, ymd: string, signedClp: number): number | null => {
      let best: number | null = null;
      let bestDist = Number.POSITIVE_INFINITY;
      for (let i = 0; i < flows.length; i++) {
        if (usedFlow.has(i)) continue;
        const f = flows[i];
        if (f.accountId !== accountId || f.signedClp !== signedClp) continue;
        const d = dayDistance(f.ymd, ymd);
        if (d > CERT_MATCH_WINDOW_DAYS) continue;
        if (d < bestDist) {
          best = i;
          bestDist = d;
          if (d === 0) break;
        }
      }
      return best;
    };

    const insMov = db.prepare(
      `INSERT INTO movements (account_id, amount_clp, occurred_on, note, units_delta, flow_kind)
       VALUES (?, ?, ?, ?, ?, ?)`
    );

    let matched = 0;
    const missing: FintualCertImportResult["missing"] = [];
    // Sort plan by date so greedy matching consumes flows chronologically.
    const sortedPlan = [...plan].sort((a, b) => a.ymd.localeCompare(b.ymd));
    for (const p of sortedPlan) {
      const accountId = accountIdByNote[p.importNote];
      if (accountId == null) continue;
      const hit = matchFlowFor(accountId, p.ymd, p.amountClp);
      if (hit != null) {
        usedFlow.add(hit);
        matched += 1;
        continue;
      }
      missing.push({ importNote: p.importNote, ymd: p.ymd, amountClp: p.amountClp });
      if (apply) {
        const ud = p.cuotasNet !== 0 ? p.cuotasNet : null;
        insMov.run(accountId, p.amountClp, p.ymd, p.note, ud, p.flowKind);
      }
    }

    const dbOnly: FintualCertImportResult["dbOnly"] = [];
    for (let i = 0; i < flows.length; i++) {
      if (usedFlow.has(i)) continue;
      const f = flows[i];
      dbOnly.push({
        importNote: noteByAccount.get(f.accountId) ?? String(f.accountId),
        ymd: f.ymd,
        amountClp: f.signedClp,
        kind: f.kind,
      });
    }

    // Valor-cuota hints and nav/sync reseed are additive/idempotent — only on apply.
    let fundUnitRows = 0;
    if (apply) {
      fundUnitRows = backfillFintualCertValorCuotaFromScan(scan, matchFintualCertGoalV2, false);
      seedNavTree();
      reseedAllAccountSyncSources();
    }

    return {
      accountsEnsured: ids.length,
      matched,
      missing,
      dbOnly,
      fundUnitRows,
    };
  });

  if (!apply) {
    // Report-only: roll back the ensureAccounts side effect so a report never writes.
    let preview: Omit<FintualCertImportResult, "csvPath" | "applied"> = {
      accountsEnsured: 0,
      matched: 0,
      missing: [],
      dbOnly: [],
      fundUnitRows: 0,
    };
    const rollback = db.transaction(() => {
      preview = reconcile();
      throw new ROLLBACK_SENTINEL();
    });
    try {
      rollback();
    } catch (e) {
      if (!(e instanceof ROLLBACK_SENTINEL)) throw e;
    }
    return { csvPath, applied: false, ...preview };
  }

  const res = reconcile();
  return { csvPath, applied: true, ...res };
}

/** Internal marker to roll back the dry-run transaction without surfacing an error. */
class ROLLBACK_SENTINEL extends Error {}
