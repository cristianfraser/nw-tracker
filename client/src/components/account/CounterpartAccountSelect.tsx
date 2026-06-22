import { useAccountsAll } from "../../queries/hooks";

type Props = {
  value: number | "";
  onChange: (accountId: number | "") => void;
  excludeAccountId?: number;
  label: string;
};

export function CounterpartAccountSelect({ value, onChange, excludeAccountId, label }: Props) {
  const { data } = useAccountsAll();
  const accounts = (data?.accounts ?? []).filter((a) => a.id !== excludeAccountId);

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
