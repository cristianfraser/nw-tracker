/**
 * Backfill `fund_unit_daily` for Fintual certificado v2 accounts from Fintual `real_assets` API.
 *
 *   npm run fintual:backfill-cert-fund-units -w nw-tracker-server
 *   npm run fintual:backfill-cert-fund-units -w nw-tracker-server -- --dry-run
 */
import { db } from "../src/db.js";
import { fundSeriesKeyFromImportNotes } from "../src/fintualFundUnitDaily.js";
import { matchFintualCertGoalV2 } from "../src/fintualCertV2.js";
import { upsertFundUnitSpotPreservingHistory } from "../src/fundUnitDaily.js";
import {
  fetchFintualGoalsRaw,
  getValidFintualSession,
  parseGoalsFromResponse,
} from "./fintualApiLib.js";
import { fetchRealAssetNavHistoryByDate } from "./fintualRealAssetNav.js";

const dryRun = process.argv.includes("--dry-run");
const PAGE_DELAY_MS = 1250;
const BETWEEN_ASSETS_DELAY_MS = 1750;
const BETWEEN_GOALS_DELAY_MS = 2500;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function candidateAssetIds(
  investments: { weight: number; asset_id: number }[] | undefined
): number[] {
  if (!investments?.length) return [];
  const sorted = [...investments].sort((a, b) => b.weight - a.weight);
  const uniq: number[] = [];
  const seen = new Set<number>();
  for (const inv of sorted) {
    if (!Number.isFinite(inv.asset_id)) continue;
    if (seen.has(inv.asset_id)) continue;
    seen.add(inv.asset_id);
    uniq.push(inv.asset_id);
  }
  return uniq;
}

async function bestAssetHistoryByDate(
  email: string,
  token: string,
  goalLabel: string,
  investments: { weight: number; asset_id: number }[] | undefined
): Promise<{ assetId: number; byDate: Map<string, number> } | null> {
  const ids = candidateAssetIds(investments);
  if (!ids.length) return null;
  let best: { assetId: number; byDate: Map<string, number> } | null = null;
  for (let i = 0; i < ids.length; i++) {
    const assetId = ids[i]!;
    console.log(`[backfill] goal=${goalLabel} candidate_asset=${assetId} (${i + 1}/${ids.length})`);
    const byDate = await fetchRealAssetNavHistoryByDate(email, token, assetId, {
      pageDelayMs: PAGE_DELAY_MS,
      onRequestLog: (msg) => console.log(`[backfill] ${msg}`),
    });
    console.log(`[backfill] goal=${goalLabel} asset=${assetId} history_days=${byDate.size}`);
    if (!best || byDate.size > best.byDate.size) best = { assetId, byDate };
    if (byDate.size > 0 && ids.length > 1) {
      // Keep scanning in case a lower-weight asset has a longer history.
      // no-op
    }
    if (i < ids.length - 1) {
      console.log(`[backfill] sleep ${BETWEEN_ASSETS_DELAY_MS}ms before next candidate asset`);
      await sleep(BETWEEN_ASSETS_DELAY_MS);
    }
  }
  return best;
}

async function main(): Promise<void> {
  const { email, token } = await getValidFintualSession();
  const goals = parseGoalsFromResponse(await fetchFintualGoalsRaw(email, token));
  const accStmt = db.prepare(`SELECT id FROM accounts WHERE import_key = ?`);

  let seriesDays = 0;
  for (let gi = 0; gi < goals.length; gi++) {
    const g = goals[gi]!;
    console.log(`[backfill] goal ${gi + 1}/${goals.length} id=${g.id} name="${g.name}"`);
    const v2Notes = matchFintualCertGoalV2(g.id, g.name);
    const notesTargets = [v2Notes].filter((n): n is string => Boolean(n));
    if (notesTargets.length === 0) {
      console.log(`[backfill] skip goal ${g.id} (${g.name}): no mapped notes target`);
      continue;
    }
    console.log(`[backfill] goal ${g.id} mapped targets: ${notesTargets.join(", ")}`);
    const best = await bestAssetHistoryByDate(email, token, `${g.id}|${g.name}`, g.investments);
    if (best == null) {
      console.warn(`skip goal ${g.id}: no asset_id`);
      continue;
    }
    const { byDate } = best;
    for (const importNotes of notesTargets) {
      const seriesKey = fundSeriesKeyFromImportNotes(importNotes);
      const acc = accStmt.get(importNotes) as { id: number } | undefined;
      if (!seriesKey || !acc) {
        console.warn(`skip goal ${g.id} (${g.name}): no account or series for ${importNotes}`);
        continue;
      }
      let n = 0;
      for (const [day, unitClp] of byDate) {
        if (!dryRun) {
          upsertFundUnitSpotPreservingHistory({
            seriesKey,
            observationDay: day,
            unitValueClp: Math.round(unitClp * 10000) / 10000,
            note: `fintual:backfill|${importNotes}`,
            carryNote: "fintual:cert-carry-forward",
            dryRun: false,
          });
        }
        n += 1;
      }
      seriesDays += n;
      console.log(`${g.name} → ${importNotes}: ${n} day(s) (${seriesKey})`);
    }
    if (gi < goals.length - 1) {
      console.log(`[backfill] sleep ${BETWEEN_GOALS_DELAY_MS}ms before next goal`);
      await sleep(BETWEEN_GOALS_DELAY_MS);
    }
  }
  console.log(
    dryRun
      ? `[dry-run] would upsert ${seriesDays} fund_unit_daily row(s) for v2 cert accounts`
      : `Upserted ${seriesDays} fund_unit_daily row(s) for v2 cert accounts`
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
