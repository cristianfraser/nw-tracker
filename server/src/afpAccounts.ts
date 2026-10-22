/**
 * The AFP fund accounts: every account whose asset-group leaf kind is `afp`, each on its own
 * display series (`accounts.fund_series_key`, `afp_<afp>_cuota_<fund>`). «The live UNO account»
 * — the one the nightly certificate read and the official sync write — is found by its series,
 * never by an import key (docs/afp-fund-accounts-plan.md, decision 6).
 */
import { accountBucketKindSlug } from "./accountBucket.js";
import { AFP_UNO_CUOTA_SERIES_KEY } from "./afpUnoSeries.js";
import { db } from "./db.js";

export type AfpFundAccountRow = {
  id: number;
  name: string;
  fund_series_key: string | null;
  import_key: string | null;
};

/** Every `afp`-kind account, by id. */
export function listAfpFundAccounts(): AfpFundAccountRow[] {
  const rows = db
    .prepare(
      `SELECT a.id, a.name, a.fund_series_key, a.import_key, g.slug AS bucket_slug
       FROM accounts a
       INNER JOIN asset_groups g ON g.id = a.asset_group_id
       ORDER BY a.id`
    )
    .all() as (AfpFundAccountRow & { bucket_slug: string })[];
  return rows
    .filter((r) => accountBucketKindSlug(r.bucket_slug) === "afp")
    .map(({ bucket_slug: _slug, ...r }) => ({ ...r, fund_series_key: r.fund_series_key?.trim() || null }));
}

/** The `afp` accounts declared on the live UNO Fondo A series (`AFP_UNO_CUOTA_SERIES_KEY`). */
export function afpUnoAccountIds(): number[] {
  return listAfpFundAccounts()
    .filter((r) => r.fund_series_key === AFP_UNO_CUOTA_SERIES_KEY)
    .map((r) => r.id);
}

/** The single `afp` account on `AFP_UNO_CUOTA_SERIES_KEY`; throws when none or several. */
export function liveAfpUnoAccountId(): number {
  const ids = afpUnoAccountIds();
  if (ids.length === 1) return ids[0]!;
  if (ids.length === 0) throw new Error(`AFP: no afp account declares fund_series_key = ${AFP_UNO_CUOTA_SERIES_KEY}`);
  throw new Error(`AFP: ${ids.length} afp accounts declare fund_series_key = ${AFP_UNO_CUOTA_SERIES_KEY} (ids ${ids.join(", ")})`);
}
