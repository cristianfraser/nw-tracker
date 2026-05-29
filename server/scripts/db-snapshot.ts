/**
 * Backup `server/data/nw-tracker.db` into `server/data/snapshots/` (gitignored).
 *
 *   npm run db:snapshot -w nw-tracker-server
 *   npm run db:snapshot -w nw-tracker-server -- --label=before-cc-usd-import
 *   npm run db:snapshot -w nw-tracker-server -- --list
 */
import { createDbSnapshot, listDbSnapshots } from "../src/dbSnapshot.js";

function arg(name: string): string | undefined {
  const p = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(p));
  return hit ? hit.slice(p.length) : undefined;
}

if (process.argv.includes("--list")) {
  const snaps = listDbSnapshots();
  if (snaps.length === 0) {
    console.log("No snapshots in server/data/snapshots/");
  } else {
    for (const s of snaps) {
      console.log(`${s.path}\t${(s.bytes / 1024 / 1024).toFixed(2)} MiB`);
    }
  }
  process.exit(0);
}

const label = arg("label");
const result = await createDbSnapshot(label ? { label } : undefined);
console.log(`Snapshot written: ${result.path} (${(result.bytes / 1024 / 1024).toFixed(2)} MiB)`);
