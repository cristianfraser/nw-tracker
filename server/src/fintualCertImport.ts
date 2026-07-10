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

function insertCertMovements(
  scan: FintualCertificadoAggregateScan,
  accountIdByNote: Record<string, number>
): number {
  const insMov = db.prepare(
    `INSERT INTO movements (account_id, amount_clp, occurred_on, note, units_delta, flow_kind)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  let inserted = 0;
  for (const a of scan.sortedAggregates) {
    const importNote = matchFintualCertGoalV2(a.goalId, a.name);
    if (!importNote) continue;
    const accountId = accountIdByNote[importNote];
    if (accountId == null) continue;

    let impliedClp = a.clpNet;
    if (impliedClp === 0 && a.cuotasNet !== 0 && a.valorCuotaHint != null) {
      impliedClp = Math.round(a.cuotasNet * a.valorCuotaHint);
    }
    if (impliedClp === 0) continue;

    const medio = [...a.medios].sort().join("; ");
    // Deposit classification lives in the flow_kind column, but only for the non-default kinds
    // (state bonus / traspaso). A plain personal deposit stays NULL — the sign of amount_clp
    // distinguishes deposit vs withdrawal, matching every other cash movement. The note is human
    // provenance only (goal / day / medio).
    const flowKind = a.flowKind === DEPOSIT_FLOW_KIND_PERSONAL ? null : a.flowKind;
    const note = `${FINTUAL_CERT_MOVEMENT_NOTE_PREFIX}|goal=${a.goalId}|day=${a.ymd}${medio ? `|medio=${medio}` : ""}`;
    const ud = a.cuotasNet !== 0 ? a.cuotasNet : null;
    insMov.run(accountId, impliedClp, a.ymd, note, ud, flowKind);
    inserted += 1;
  }
  return inserted;
}

export type FintualCertImportResult = {
  csvPath: string;
  accounts: number;
  movementsDeleted: number;
  movementsInserted: number;
  fundUnitRows: number;
  /** Rows whose external state-bonus/traspaso classification was carried over the rebuild. */
  classificationsPreserved: number;
  dryRun: boolean;
};

/**
 * Rebuild the v2 Fintual cert accounts' movements from the installed certificado CSV.
 * Throws if the CSV is absent (fail fast — run `npm run import:cfraser-inbox` to install it).
 */
export function importFintualCertificado(opts?: {
  maxMonth?: string;
  dryRun?: boolean;
}): FintualCertImportResult {
  const dryRun = opts?.dryRun ?? false;
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

  const run = db.transaction(() => {
    const accountIdByNote = ensureAllFintualCertV2Accounts();
    const ids = Object.values(accountIdByNote);
    const ph = ids.map(() => "?").join(",");

    // The APV-A "aporte estatal" state match is indistinguishable from a personal deposit in the
    // certificate (both arrive as medio "Transferencia electronica") — its flow_kind is external
    // knowledge set once (historically from a net-worth CSV, going forward manually). Preserve any
    // non-default deposit classification across the delete+rebuild so it is not silently lost.
    const preserved = new Map<string, string>();
    const priorClassified = db
      .prepare(
        `SELECT account_id, occurred_on, amount_clp, flow_kind FROM movements
         WHERE account_id IN (${ph}) AND note LIKE '${FINTUAL_CERT_MOVEMENT_NOTE_PREFIX}%'
           AND flow_kind IS NOT NULL`
      )
      .all(...ids) as { account_id: number; occurred_on: string; amount_clp: number; flow_kind: string }[];
    for (const r of priorClassified) {
      preserved.set(`${r.account_id}\t${r.occurred_on}\t${r.amount_clp}`, r.flow_kind);
    }

    const del = db
      .prepare(
        `DELETE FROM movements WHERE account_id IN (${ph}) AND note LIKE '${FINTUAL_CERT_MOVEMENT_NOTE_PREFIX}%'`
      )
      .run(...ids);
    const movementsInserted = insertCertMovements(scan, accountIdByNote);

    let classificationsPreserved = 0;
    if (preserved.size > 0) {
      const rebuilt = db
        .prepare(
          `SELECT id, account_id, occurred_on, amount_clp FROM movements
           WHERE account_id IN (${ph}) AND note LIKE '${FINTUAL_CERT_MOVEMENT_NOTE_PREFIX}%'
             AND flow_kind IS NULL`
        )
        .all(...ids) as { id: number; account_id: number; occurred_on: string; amount_clp: number }[];
      const upd = db.prepare(`UPDATE movements SET flow_kind = ? WHERE id = ?`);
      for (const r of rebuilt) {
        const fk = preserved.get(`${r.account_id}\t${r.occurred_on}\t${r.amount_clp}`);
        if (fk) {
          upd.run(fk, r.id);
          classificationsPreserved += 1;
        }
      }
    }

    const fundUnitRows = backfillFintualCertValorCuotaFromScan(scan, matchFintualCertGoalV2, false);
    seedNavTree();
    reseedAllAccountSyncSources();
    return {
      accounts: ids.length,
      movementsDeleted: del.changes,
      movementsInserted,
      fundUnitRows,
      classificationsPreserved,
    };
  });

  if (dryRun) {
    let preview: Omit<FintualCertImportResult, "csvPath" | "dryRun"> = {
      accounts: 0,
      movementsDeleted: 0,
      movementsInserted: 0,
      fundUnitRows: 0,
      classificationsPreserved: 0,
    };
    const rollback = db.transaction(() => {
      preview = run();
      throw new ROLLBACK_SENTINEL();
    });
    try {
      rollback();
    } catch (e) {
      if (!(e instanceof ROLLBACK_SENTINEL)) throw e;
    }
    return { csvPath, dryRun: true, ...preview };
  }

  const res = run();
  return { csvPath, dryRun: false, ...res };
}

/** Internal marker to roll back the dry-run transaction without surfacing an error. */
class ROLLBACK_SENTINEL extends Error {}
