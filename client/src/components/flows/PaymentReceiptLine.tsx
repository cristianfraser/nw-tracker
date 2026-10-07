import type { PaymentReceipt } from "../../types/flows";

/**
 * Who a processor charge («PAGOS.FLOW.CL», «PAGO FACIL») actually paid, under its description:
 * «→ payee «concept»», like a transfer's counterparty; an inferred one (a subscription's cycle, a
 * monthly run) reads «≈ payee». The full receipt (processor, order, RUT, e-mail, when it was paid,
 * what the link rests on) is in the tooltip. Data only, nothing to translate.
 */
export function PaymentReceiptLine({ receipt }: { receipt: PaymentReceipt | undefined }) {
  if (!receipt) return null;
  const r = receipt;
  const detail = [
    `${r.payee} (${r.processor_name})`,
    r.concept ? `«${r.concept}»` : null,
    r.payee_rut ? `RUT ${r.payee_rut}` : null,
    r.payee_email,
    r.order_ref ? `#${r.order_ref}` : null,
    r.charge ? `${r.charge.position}/${r.charge.of}` : null,
    r.paid_at_chile,
    r.basis,
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <div className="muted" style={{ fontSize: "0.85em" }} title={detail}>
      {r.guess ? "≈" : "→"} {r.payee}
      {r.charge ? ` · ${r.charge.position}/${r.charge.of}` : null}
      {r.concept ? <span style={{ marginLeft: "0.35rem", fontStyle: "italic" }}>«{r.concept}»</span> : null}
    </div>
  );
}
