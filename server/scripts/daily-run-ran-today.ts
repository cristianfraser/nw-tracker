/**
 * Exit 0 when a daily run was already recorded today (Chile), 1 otherwise.
 *
 * Used by `daily-run.sh --scheduled` so a manual trigger earlier in the day makes the 22:00
 * LaunchAgent skip. Deliberately a separate tiny script: the shell needs an exit code, not JSON.
 */
import { dailyRunAlreadyRanToday, lastDailyRunAt } from "../src/dailyRunLog.js";

if (dailyRunAlreadyRanToday()) {
  console.log(`already ran today (last: ${lastDailyRunAt()})`);
  process.exit(0);
}
console.log("no run recorded today");
process.exit(1);
