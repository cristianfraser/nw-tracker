/**
 * What Fintual's goals API stated each tracked goal held at the latest poll (`fintual_goal_navs`,
 * migration 378): the goals-NAV display choice (`accountPosition.ts`) and the poll reconcile
 * checks (`fintualCertV2Reconcile.ts`, which the Risky Norris proxy gate asks) read it here, from
 * the database — never from the sync state file, whose signature is scheduling state only. A
 * database with no row (a fresh one, the demo, which never runs the source) reads no goals NAV,
 * so every account is valued as cuotas × valor cuota.
 */
import { db } from "./db.js";
import { dbStateMemo } from "./dbStateMemo.js";

export type FintualGoalNav = Readonly<{
  goal_id: string;
  account_id: number;
  /** The goals API balance in `currency`, to the cent. */
  nav_amount: number;
  currency: string;
  /** Chile day the poll is attributed to (the state's `fintualLastCheckYmd`). */
  polled_ymd: string;
}>;

const stmtAll = db.prepare(
  `SELECT goal_id, account_id, nav_amount, currency, polled_ymd FROM fintual_goal_navs ORDER BY goal_id`
);
const stmtUpsert = db.prepare(
  `INSERT INTO fintual_goal_navs (goal_id, account_id, nav_amount, currency, polled_ymd) VALUES (?, ?, ?, ?, ?)
   ON CONFLICT(goal_id) DO UPDATE SET account_id = excluded.account_id, nav_amount = excluded.nav_amount,
     currency = excluded.currency, polled_ymd = excluded.polled_ymd`
);
const stmtDelete = db.prepare(`DELETE FROM fintual_goal_navs WHERE goal_id = ?`);

/** Every stored goals NAV, by goal id. */
export function fintualGoalNavs(): ReadonlyMap<string, FintualGoalNav> {
  return dbStateMemo("fintual_goal_navs", 0, () => {
    const rows = stmtAll.all() as FintualGoalNav[];
    return new Map(rows.map((r) => [r.goal_id, r]));
  });
}

/** The goal's stored goals NAV in pesos (rounded to the peso), or null when the last poll stated none. */
export function fintualGoalNavClp(goalId: string): number | null {
  const row = fintualGoalNavs().get(goalId);
  if (row == null) return null;
  if (row.currency !== "clp") { // convention-ok: Fintual goals are peso funds; the API states pesos
    throw new Error(`fintual_goal_navs: goal ${goalId} is stated in ${row.currency}, not pesos`);
  }
  return Math.round(row.nav_amount);
}

/**
 * Replaces the stored goals NAV with one poll's: one row per goal the poll stated (pesos, to the
 * cent), every other row removed. An unchanged poll writes nothing the change log sees.
 */
export function writeFintualGoalNavs(
  polledYmd: string,
  goals: readonly { goalId: string; accountId: number; navClp: number }[]
): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(polledYmd)) throw new Error(`fintual_goal_navs: poll day «${polledYmd}» is not YYYY-MM-DD`);
  db.transaction(() => {
    const seen = new Set<string>();
    for (const g of goals) {
      if (seen.has(g.goalId)) throw new Error(`fintual_goal_navs: goal ${g.goalId} stated twice in one poll`);
      seen.add(g.goalId);
      if (!Number.isFinite(g.navClp) || g.navClp < 0) {
        throw new Error(`fintual_goal_navs: goal ${g.goalId} balance ${g.navClp} is not a non-negative amount`);
      }
      stmtUpsert.run(g.goalId, g.accountId, Math.round(g.navClp * 100) / 100, "clp", polledYmd); // convention-ok: Fintual goals are peso funds
    }
    for (const id of (stmtAll.all() as FintualGoalNav[]).map((r) => r.goal_id)) {
      if (!seen.has(id)) stmtDelete.run(id);
    }
  })();
}
