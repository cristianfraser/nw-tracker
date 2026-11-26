/**
 * The folder holding the background syncs' own state files (the global sync state, the Fintual
 * session and goals snapshot, Banco Central's rate gate): `server/data/`. Tests point it at a
 * temporary folder with `NW_TRACKER_SYNC_FILES_DIR` (read on every call), so a test run never
 * reads or writes the files of the checkout it runs in, and parallel forks never share them.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function syncFilesDir(): string {
  return process.env.NW_TRACKER_SYNC_FILES_DIR?.trim() || path.join(__dirname, "..", "data");
}
