/**
 * Exit 0 when a daily run finished within the repeat window (default 60 min), 1 otherwise.
 *
 * Used by `daily-run.sh --scheduled` so the 22:00 LaunchAgent does not log in to the banks again
 * right behind a manual run. A run earlier in the day does not count (see
 * `dailyRunFinishedWithin`). Deliberately a separate tiny script: the shell needs an exit code.
 */
import { DAILY_RUN_REPEAT_WINDOW_MINUTES, dailyRunFinishedWithin, lastDailyRunAt } from "../src/dailyRunLog.js";

if (dailyRunFinishedWithin()) {
  console.log(`a run finished less than ${DAILY_RUN_REPEAT_WINDOW_MINUTES} min ago (${lastDailyRunAt()} UTC)`);
  process.exit(0);
}
console.log(`no run in the last ${DAILY_RUN_REPEAT_WINDOW_MINUTES} min`);
process.exit(1);
