/** Shared SQL fragment: account row with leaf bucket slug/label. */
export const ACCOUNT_WITH_BUCKET_SELECT = `
  SELECT a.id, a.name, a.notes, a.exclude_from_group_totals,
         g.slug AS bucket_slug, g.label AS bucket_label
  FROM accounts a
  INNER JOIN asset_groups g ON g.id = a.asset_group_id`;

export function accountBucketSlugStmt(extraWhere = ""): string {
  return `SELECT g.slug AS bucket_slug FROM accounts a
          INNER JOIN asset_groups g ON g.id = a.asset_group_id
          WHERE a.id = ?${extraWhere ? ` AND (${extraWhere})` : ""}`;
}
