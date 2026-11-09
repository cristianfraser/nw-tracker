/**
 * Which database snapshots to keep (user decision 2026-11-09): one per calendar day for the last
 * `dailyDays` days, one per calendar month before that, whatever the label (`auto-daily`, the deploy
 * agent's `before-deploy-<sha>`, a hand-made `db:snapshot`). Within a day or a month the newest stays.
 * A file whose name does not open with the snapshot stamp (`YYYYMMDD-HHMMSS-`) is not a snapshot and
 * is left alone. Pure: the callers list and delete.
 */
export type SnapshotRetentionPlan = { keep: string[]; prune: string[] };

const STAMP_RE = /^(\d{4})(\d{2})(\d{2})-(\d{6})-/;

export function planSnapshotRetention(names: readonly string[], todayYmd: string, dailyDays: number): SnapshotRetentionPlan {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(todayYmd)) throw new Error(`snapshot retention: today must be YYYY-MM-DD, got ${todayYmd}`);
  if (!Number.isInteger(dailyDays) || dailyDays < 1) throw new Error(`snapshot retention: dailyDays must be a positive integer, got ${dailyDays}`);
  const today = Date.UTC(Number(todayYmd.slice(0, 4)), Number(todayYmd.slice(5, 7)) - 1, Number(todayYmd.slice(8, 10)));
  const cutoff = today - (dailyDays - 1) * 86_400_000;
  const newestByGroup = new Map<string, string>();
  const stamped: string[] = [];
  for (const name of names) {
    const m = STAMP_RE.exec(name);
    if (!m) continue;
    stamped.push(name);
    const day = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    const group = day >= cutoff ? `day:${m[1]}${m[2]}${m[3]}` : `month:${m[1]}${m[2]}`;
    const current = newestByGroup.get(group);
    // The stamp sorts chronologically as text; the newest of the group stays.
    if (current == null || name > current) newestByGroup.set(group, name);
  }
  const keepSet = new Set(newestByGroup.values());
  return {
    keep: stamped.filter((n) => keepSet.has(n)).sort(),
    prune: stamped.filter((n) => !keepSet.has(n)).sort(),
  };
}
