import { db } from "../src/db.js";
export function applyFintualGoalsSnapshotToDb(snap, dryRun) {
    const accStmt = db.prepare("SELECT id FROM accounts WHERE notes = ?");
    const upsert = db.prepare(`
    INSERT INTO valuations (account_id, as_of_date, value_clp)
    VALUES (@account_id, @as_of_date, @value_clp)
    ON CONFLICT(account_id, as_of_date) DO UPDATE SET
      value_clp = excluded.value_clp
  `);
    let applied = 0;
    let skipped = 0;
    for (const g of snap.goals) {
        if (!g.matchedNotes) {
            skipped += 1;
            continue;
        }
        const row = accStmt.get(g.matchedNotes);
        if (!row) {
            console.warn(`No account with notes=${g.matchedNotes} (goal "${g.name}" id=${g.id})`);
            skipped += 1;
            continue;
        }
        const value_clp = Math.round(g.navClp * 100) / 100;
        if (dryRun) {
            console.log(`[dry-run] account_id=${row.id} as_of=${snap.asOfDate} value_clp=${value_clp} ← goal "${g.name}"`);
        }
        else {
            upsert.run({
                account_id: row.id,
                as_of_date: snap.asOfDate,
                value_clp,
            });
        }
        applied += 1;
    }
    return { applied, skipped };
}
/** True when every mapped goal matches `valuations` for `snap.asOfDate` within 1 CLP. */
export function fintualSnapshotMatchesDb(snap) {
    const accStmt = db.prepare("SELECT id FROM accounts WHERE notes = ?");
    const valStmt = db.prepare(`SELECT value_clp FROM valuations WHERE account_id = ? AND as_of_date = ?`);
    let checked = 0;
    for (const g of snap.goals) {
        if (!g.matchedNotes)
            continue;
        const row = accStmt.get(g.matchedNotes);
        if (!row)
            return false;
        const v = valStmt.get(row.id, snap.asOfDate);
        if (!v)
            return false;
        if (Math.abs(v.value_clp - g.navClp) > 1)
            return false;
        checked++;
    }
    return checked > 0;
}
export function fintualMappedNavSignature(snap) {
    const parts = snap.goals
        .filter((g) => g.matchedNotes)
        .map((g) => `${g.id}:${Math.round(g.navClp * 100) / 100}`)
        .sort();
    return parts.join("|");
}
