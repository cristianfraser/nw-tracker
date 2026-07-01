import { useAccountsAll } from "../../queries/hooks";

/** Cash / checking accounts that money typically flows to/from (bucket cash + checking hubs). */
const CASH_COUNTERPART_KINDS = new Set(["cuenta_corriente", "cuenta_vista", "usd", "clp"]);

const USD_CASH_KIND = "usd";

/** Behaviour kind = `asset_groups.slug` suffix after `__` (e.g. `brokerage_cash__usd` → `usd`). */
function kindFromBucketSlug(slug: string | undefined): string | null {
  if (!slug) return null;
  const i = slug.indexOf("__");
  return i >= 0 ? slug.slice(i + 2) : slug;
}

type Props = {
  value: number | "";
  onChange: (accountId: number | "") => void;
  excludeAccountId?: number;
  label: string;
  /** Limit options to cash / checking accounts (the usual aporte/retiro counterparts). */
  cashAndCheckingOnly?: boolean;
  /** Limit options to equity stock accounts (e.g. the paying stock on a dividend payout). */
  equityBrokerageOnly?: boolean;
  /** Limit options to the USD cash account (stock buy/sell settlement account). */
  usdCashOnly?: boolean;
};

export function CounterpartAccountSelect({
  value,
  onChange,
  excludeAccountId,
  label,
  cashAndCheckingOnly,
  equityBrokerageOnly,
  usdCashOnly,
}: Props) {
  const { data } = useAccountsAll();
  const accounts = (data?.accounts ?? []).filter((a) => {
    if (a.id === excludeAccountId) return false;
    if (cashAndCheckingOnly) {
      const kind = kindFromBucketSlug(a.bucket_slug);
      if (!kind || !CASH_COUNTERPART_KINDS.has(kind)) return false;
    }
    if (equityBrokerageOnly && !a.bucket_slug?.startsWith("brokerage_acciones")) return false;
    if (usdCashOnly && kindFromBucketSlug(a.bucket_slug) !== USD_CASH_KIND) return false;
    return true;
  });

  return (
    <label style={{ display: "block", marginBottom: "0.75rem" }}>
      <span style={{ display: "block", fontSize: "0.85rem", marginBottom: "0.25rem" }}>{label}</span>
      <select
        value={value === "" ? "" : String(value)}
        onChange={(e) => {
          const v = e.target.value;
          onChange(v ? Number(v) : "");
        }}
      >
        <option value="">—</option>
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name} (#{a.id})
          </option>
        ))}
      </select>
    </label>
  );
}
