import { useAccountsAll } from "../../queries/hooks";

/** Cash / checking accounts that money typically flows to/from (bucket cash + checking hubs). */
const CASH_COUNTERPART_KINDS = new Set(["cuenta_corriente", "cuenta_vista", "usd", "clp"]);

/**
 * Behaviour kind = last `__` segment of the leaf `asset_groups.slug` (mirrors the server's
 * `accountBucketKindSlug`), e.g. `cash_eqs__cash_savings__racional_usd__usd` → `usd`,
 * `brokerage_cash__caja_portafolio_ipsa__clp` → `clp`.
 */
function kindFromBucketSlug(slug: string | undefined): string | null {
  if (!slug) return null;
  const i = slug.lastIndexOf("__");
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
  /**
   * Limit options to cash ledger accounts in any currency (what a trade, a dividend or an option
   * premium settles against); each option names the currency the account holds.
   */
  cashLedgerOnly?: boolean;
  /**
   * Limit options to money ledgers whose own movements are in this currency (the accounts list's
   * `ledger_currency`: checking and cash ledgers); each option names its currency.
   */
  ledgerCurrency?: string;
};

export function CounterpartAccountSelect({
  value,
  onChange,
  excludeAccountId,
  label,
  cashAndCheckingOnly,
  equityBrokerageOnly,
  cashLedgerOnly,
  ledgerCurrency,
}: Props) {
  const { data } = useAccountsAll();
  const accounts = (data?.accounts ?? []).filter((a) => {
    if (a.id === excludeAccountId) return false;
    if (cashAndCheckingOnly) {
      const kind = kindFromBucketSlug(a.bucket_slug);
      if (!kind || !CASH_COUNTERPART_KINDS.has(kind)) return false;
    }
    if (equityBrokerageOnly && !a.bucket_slug?.startsWith("brokerage_acciones")) return false;
    if (cashLedgerOnly && a.cash_currency == null) return false;
    if (ledgerCurrency != null && a.ledger_currency !== ledgerCurrency) return false;
    return true;
  });
  // The currency named beside an option: the one the filter in force reads.
  const optionCurrency = (a: (typeof accounts)[number]): string | null =>
    ledgerCurrency != null ? (a.ledger_currency ?? null) : cashLedgerOnly ? (a.cash_currency ?? null) : null;

  return (
    <label style={{ display: "block" }}>
      <span style={{ display: "block", fontSize: "var(--font-size-prose)" }}>{label}</span>
      <select
        value={value === "" ? "" : String(value)}
        onChange={(e) => {
          const v = e.target.value;
          onChange(v ? Number(v) : "");
        }}
      >
        <option value="">—</option>
        {accounts.map((a) => {
          const currency = optionCurrency(a);
          return (
            <option key={a.id} value={a.id}>
              {currency != null ? `${a.name} · ${currency.toUpperCase()}` : a.name} (#{a.id})
            </option>
          );
        })}
      </select>
    </label>
  );
}
