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
  const row = db.prepare("SELECT id FROM accounts WHERE notes = ?").get(importNotes) as
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
      "INSERT INTO accounts (asset_group_id, name, notes, exclude_from_group_totals, equity_ticker, fund_series_key) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(bucketId, displayName, importNotes, exclude, null, fundSeriesKey);
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

export type FintualCertImportResult = {
  csvPath: string;
  applied: boolean;
  accountsEnsured: number;
  /** Certificado rows already present in the DB (matched on account + date + amount) — left untouched. */
  matched: number;
  /** Certificado rows missing from the DB — added when applied, listed for review when not. */
  missing: { importNote: string; ymd: string; amountClp: number }[];
  /** DB cert-movement rows that no certificado row matches (manual / divergent) — never modified. */
  divergent: { importNote: string; ymd: string; amountClp: number }[];
  fundUnitRows: number;
};

/**
 * Reconcile the v2 Fintual cert accounts against the installed certificado CSV.
 *
 * Non-destructive by design: existing curated movements are the source of truth and are never
 * deleted or modified. Certificado rows already present (matched on account + date + amount) are
 * left untouched; only rows missing from the DB are reported and — when `apply` is set — added.
 * DB cert-movement rows that no certificado row matches are reported as divergent for manual review.
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
    const ph = ids.map(() => "?").join(",");

    // Existing curated cert movements — the source of truth. Key on (account, date, amount).
    const existing = db
      .prepare(
        `SELECT id, account_id, occurred_on, amount_clp FROM movements
         WHERE account_id IN (${ph}) AND note LIKE '${FINTUAL_CERT_MOVEMENT_NOTE_PREFIX}%'`
      )
      .all(...ids) as { id: number; account_id: number; occurred_on: string; amount_clp: number }[];
    const key = (accountId: number, ymd: string, amount: number) => `${accountId}\t${ymd}\t${amount}`;
    const existingKeys = new Map<string, number>();
    for (const r of existing) existingKeys.set(key(r.account_id, r.occurred_on, r.amount_clp), r.id);

    const insMov = db.prepare(
      `INSERT INTO movements (account_id, amount_clp, occurred_on, note, units_delta, flow_kind)
       VALUES (?, ?, ?, ?, ?, ?)`
    );

    const matchedKeys = new Set<string>();
    const missing: FintualCertImportResult["missing"] = [];
    for (const p of plan) {
      const accountId = accountIdByNote[p.importNote];
      if (accountId == null) continue;
      const k = key(accountId, p.ymd, p.amountClp);
      if (existingKeys.has(k)) {
        matchedKeys.add(k);
        continue;
      }
      missing.push({ importNote: p.importNote, ymd: p.ymd, amountClp: p.amountClp });
      if (apply) {
        const ud = p.cuotasNet !== 0 ? p.cuotasNet : null;
        insMov.run(accountId, p.amountClp, p.ymd, p.note, ud, p.flowKind);
      }
    }

    const divergent: FintualCertImportResult["divergent"] = [];
    const noteByAccount = new Map<number, string>();
    for (const [note, id] of Object.entries(accountIdByNote)) noteByAccount.set(id, note);
    for (const r of existing) {
      if (!matchedKeys.has(key(r.account_id, r.occurred_on, r.amount_clp))) {
        divergent.push({
          importNote: noteByAccount.get(r.account_id) ?? String(r.account_id),
          ymd: r.occurred_on,
          amountClp: r.amount_clp,
        });
      }
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
      matched: matchedKeys.size,
      missing,
      divergent,
      fundUnitRows,
    };
  });

  if (!apply) {
    // Report-only: roll back the ensureAccounts side effect so a report never writes.
    let preview: Omit<FintualCertImportResult, "csvPath" | "applied"> = {
      accountsEnsured: 0,
      matched: 0,
      missing: [],
      divergent: [],
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
