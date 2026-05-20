import { chileCalendarAddDays } from "../src/chileDate.js";
import { db } from "../src/db.js";
import { buildGoalsSnapshot } from "./fintualApiLib.js";
import { recordFintualGoalFundUnitDaily } from "../src/fintualFundUnitDaily.js";
import { formatSyncClp } from "../src/syncRunLog.js";
/** Mapped Fintual goals whose API NAV differs from the stored valuation on `snap.asOfDate`. */
export function collectFintualGoalValuationChanges(snap) {
    const accStmt = db.prepare("SELECT id FROM accounts WHERE notes = ?");
    const valStmt = db.prepare(`SELECT value_clp FROM valuations WHERE account_id = ? AND as_of_date = ?`);
    const changes = [];
    for (const g of snap.goals) {
        if (!g.matchedNotes)
            continue;
        const row = accStmt.get(g.matchedNotes);
        if (!row)
            continue;
        const nextRounded = Math.round(g.navClp);
        const prev = valStmt.get(row.id, snap.asOfDate);
        const prevRounded = prev?.value_clp != null && Number.isFinite(prev.value_clp)
            ? Math.round(prev.value_clp)
            : null;
        if (prevRounded != null && Math.abs(prevRounded - nextRounded) <= 1)
            continue;
        changes.push({
            group: "fintual",
            label: g.name,
            oldValue: prevRounded != null ? formatSyncClp(prevRounded) : "—",
            newValue: formatSyncClp(nextRounded),
            oldDate: snap.asOfDate,
            newDate: snap.asOfDate,
        });
    }
    return changes;
}
/**
 * Upsert `fund_unit_daily` from evening Fintual poll (publish price and/or NAV), even when valuations are unchanged.
 */
export function syncFintualFundUnitsFromResolutions(resolutions, asOfYmd, dryRun) {
    const accStmt = db.prepare("SELECT id FROM accounts WHERE notes = ?");
    let recorded = 0;
    for (const r of resolutions) {
        if (!r.row.matchedNotes)
            continue;
        const acc = accStmt.get(r.row.matchedNotes);
        if (!acc)
            continue;
        const fu = recordFintualGoalFundUnitDaily({
            accountId: acc.id,
            importNotes: r.row.matchedNotes,
            asOfYmd,
            navClp: r.appliedNavClp,
            fundPriceClp: r.fundPriceClp,
            units: r.units,
            dryRun,
        });
        if (!fu.recorded)
            continue;
        recorded += 1;
        if (!dryRun) {
            const src = r.fundPriceClp != null && r.fundPriceClp > 0 ? "publish" : "inferred";
            console.log(`sync: Fintual — fund_unit_daily ${fu.unitClp} (${asOfYmd}, ${src})` +
                (fu.gapDaysFilled > 0 ? `, carried ${fu.gapDaysFilled} day(s)` : ""));
        }
    }
    return recorded;
}
export function applyFintualGoalsSnapshotToDb(snap, dryRun) {
    const accStmt = db.prepare("SELECT id FROM accounts WHERE notes = ?");
    const upsert = db.prepare(`
    INSERT INTO valuations (account_id, as_of_date, value_clp)
    VALUES (@account_id, @as_of_date, @value_clp)
    ON CONFLICT(account_id, as_of_date) DO UPDATE SET
      value_clp = excluded.value_clp
  `);
    /** Poll-day rows stamped before as_of fix (same NAV, date > snap.asOfDate). */
    const deleteMistakenFutureDup = db.prepare(`DELETE FROM valuations
     WHERE account_id = @account_id AND as_of_date > @as_of_date
       AND ABS(value_clp - @value_clp) <= 1`);
    let applied = 0;
    let skipped = 0;
    const changes = collectFintualGoalValuationChanges(snap);
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
            if (!dryRun) {
                deleteMistakenFutureDup.run({
                    account_id: row.id,
                    as_of_date: snap.asOfDate,
                    value_clp,
                });
            }
        }
        recordFintualGoalFundUnitDaily({
            accountId: row.id,
            importNotes: g.matchedNotes,
            asOfYmd: snap.asOfDate,
            navClp: g.navClp,
            dryRun,
        });
        applied += 1;
    }
    return { applied, skipped, changes };
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
/** Remove valuations dated after `snap.asOfDate` that duplicate the API NAV (legacy poll-day stamps). */
export function cleanupMistakenPollDayFintualValuations(snap, dryRun) {
    const accStmt = db.prepare("SELECT id FROM accounts WHERE notes = ?");
    const deleteMistakenFutureDup = db.prepare(`DELETE FROM valuations
     WHERE account_id = @account_id AND as_of_date > @as_of_date
       AND ABS(value_clp - @value_clp) <= 1`);
    let n = 0;
    for (const g of snap.goals) {
        if (!g.matchedNotes)
            continue;
        const row = accStmt.get(g.matchedNotes);
        if (!row)
            continue;
        const value_clp = Math.round(g.navClp * 100) / 100;
        if (dryRun)
            continue;
        const r = deleteMistakenFutureDup.run({
            account_id: row.id,
            as_of_date: snap.asOfDate,
            value_clp,
        });
        n += r.changes;
    }
    return n;
}
/** Evening sync applies `GET /api/goals` NAV to Chile today (`cl.ymd`). */
export function pickFintualApplySnapshot(rows, byGoalId, cl, _state) {
    return { snap: buildGoalsSnapshot(rows, byGoalId, cl, cl.ymd), mode: "apply" };
}
export function fintualEveningCatchUpComplete(rows, byGoalId, cl) {
    if (cl.hour < 18)
        return true;
    const ymd = cl.ymd;
    const yesterday = chileCalendarAddDays(ymd, -1);
    const snapY = buildGoalsSnapshot(rows, byGoalId, cl, yesterday);
    const snapT = buildGoalsSnapshot(rows, byGoalId, cl, ymd);
    return fintualSnapshotMatchesDb(snapY) && fintualSnapshotMatchesDb(snapT);
}
export function fintualMappedNavSignature(snap) {
    const parts = snap.goals
        .filter((g) => g.matchedNotes)
        .map((g) => `${g.id}:${Math.round(g.navClp * 100) / 100}`)
        .sort();
    return parts.join("|");
}
