import type { TransferCounterparty } from "../../types/flows";

const ARROW: Record<TransferCounterparty["direction"], string> = { out: "→", in: "←", own: "⇄" };

/**
 * A bank transfer's counterparty under its description: «→ name · bank account». The full detail
 * (RUT, e-mail, comment, when the bank mailed it) is in the tooltip. Data only, nothing to translate.
 */
export function TransferCounterpartyLine({ counterparty }: { counterparty: TransferCounterparty | undefined }) {
  if (!counterparty) return null;
  const c = counterparty;
  const account = [c.bank, c.account_type, c.account_number].filter(Boolean).join(" ");
  const summary = [c.name, account].filter(Boolean).join(" · ");
  const detail = [
    c.name,
    c.rut ? `RUT ${c.rut}` : null,
    account || null,
    c.email,
    c.comment ? `«${c.comment}»` : null,
    c.sent_at_chile,
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <div className="muted" style={{ fontSize: "0.85em" }} title={detail}>
      {ARROW[c.direction]} {summary || "—"}
      {c.comment ? <span style={{ marginLeft: "0.35rem", fontStyle: "italic" }}>«{c.comment}»</span> : null}
    </div>
  );
}
