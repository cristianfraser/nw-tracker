/**
 * CLI entry for `npm run sync:all`. Implementation lives in `src/globalSyncAll.ts`.
 */
import { runGlobalSyncAll } from "../src/globalSyncAll.js";

void runGlobalSyncAll().then((code) => process.exit(code));
