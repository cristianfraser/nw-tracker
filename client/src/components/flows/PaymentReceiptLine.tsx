import type { PaymentReceipt } from "../../types/flows";

/** An event's day(s) and time as ISO: «2026-09-12 18:00», «2025-07-11 → 2025-07-13». */
function eventWhen(e: NonNullable<PaymentReceipt["event"]>): string {
  const start = e.starts_at ? `${e.starts_on} ${e.starts_at}` : e.starts_on;
  return e.ends_on && e.ends_on !== e.starts_on ? `${start} → ${e.ends_on}` : start;
}

/** The full receipt, one fact per line (processor, ride, event, concept, RUT, e-mail, order, when, basis). */
export function paymentReceiptDetailLines(r: PaymentReceipt): string[] {
  return [
    r.payee === r.processor_name ? r.payee : `${r.payee} (${r.processor_name})`,
    r.trip ? `${r.trip.started_at_chile ?? ""} ${r.trip.from}`.trim() : null,
    r.trip ? `${r.trip.ended_at_chile ?? ""} ${r.trip.to}`.trim() : null,
    r.event?.name ?? null,
    r.event ? eventWhen(r.event) : null,
    r.event?.venue ?? null,
    r.concept ? `«${r.concept}»` : null,
    r.payee_rut ? `RUT ${r.payee_rut}` : null,
    r.payee_email,
    r.order_ref ? `#${r.order_ref}` : null,
    r.charge ? `${r.charge.position}/${r.charge.of}` : null,
    r.paid_at_chile,
    r.basis,
  ].filter((x): x is string => Boolean(x));
}

/**
 * Who a processor charge («PAGOS.FLOW.CL», «PAGO FACIL») actually paid, under its description:
 * «→ payee «concept»», like a transfer's counterparty; an inferred one (a subscription's cycle, a
 * monthly run) reads «≈ payee». A ride adds «from → to». The full receipt (processor, order, RUT, e-mail, when it was paid,
 * what the link rests on) is in the tooltip. Data only, nothing to translate.
 */
export function PaymentReceiptLine({ receipt }: { receipt: PaymentReceipt | undefined }) {
  if (!receipt) return null;
  const r = receipt;
  const detail = paymentReceiptDetailLines(r).join("\n");
  return (
    <div className="muted" style={{ fontSize: "0.85em" }} title={detail}>
      {r.guess ? "≈" : "→"} {r.payee}
      {r.charge ? ` · ${r.charge.position}/${r.charge.of}` : null}
      {r.trip_label ? ` · ${r.trip_label}` : null}
      {r.concept ? <span style={{ marginLeft: "0.35rem", fontStyle: "italic" }}>«{r.concept}»</span> : null}
    </div>
  );
}
