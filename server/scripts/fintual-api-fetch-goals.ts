/**
 * Fetches Fintual goals:
 * 1. `POST /api/access_tokens` (email/password from `.env`, or reuse saved session)
 * 2. `GET /api/goals` with `X-User-Email` + `X-User-Token` and optional `Cookie` (`FINTUAL_COOKIE` in `.env`)
 *
 * Writes `server/data/.fintual-goals-latest.json`. Session: `server/data/.fintual-api-session.json`.
 * Optional goal map: `server/data/fintual-goal-map.json` (see `fintual-goal-map.example.json`).
 *
 * Usage (repo root):
 *   npm run fintual:fetch-goals -w nw-tracker-server
 */
import { chileWallClockNow } from "../src/chileDate.js";
import {
  buildGoalsSnapshot,
  fetchFintualGoalsRaw,
  fintualGoalsSnapshotPath,
  getValidFintualSession,
  loadGoalIdOverrides,
  parseGoalsFromResponse,
  writeGoalsSnapshot,
} from "./fintualApiLib.js";

async function main(): Promise<void> {
  const { email, token } = await getValidFintualSession();
  const raw = await fetchFintualGoalsRaw(email, token);
  const cl = chileWallClockNow();
  const rows = parseGoalsFromResponse(raw);
  const byGoalId = loadGoalIdOverrides();
  const snap = buildGoalsSnapshot(rows, byGoalId, cl);
  writeGoalsSnapshot(snap);

  console.log(`Wrote ${rows.length} goal(s) → ${fintualGoalsSnapshotPath()}`);
  console.log(`as_of_date: ${snap.asOfDate}\n`);

  for (const g of snap.goals) {
    const tag = g.matchedNotes ? `→ ${g.matchedNotes}` : "(no auto-map — add to fintual-goal-map.json)";
    console.log(`  [${g.id}] ${g.name}: ${g.navClp.toLocaleString("es-CL")} CLP ${tag}`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
