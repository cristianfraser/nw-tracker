import { afterEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { checkingAccountId } from "./checkingCartolaImport.js";
import { applyPaymentReceipt, parsePaymentReceipt } from "./santanderCcPaymentReceipts.js";
import { prunePartialMovementsSupersededByCartola } from "./checkingCartolaPartialReconcile.js";

/** Synthetic bodies mirroring the two real receipt templates (2026-08); synthetic amounts/card. */
const CLP_RECEIPT_TEXT =
  "Comprobante pago deuda Nacional de Tarjeta de Credito Tu pago de Tarjeta de Credito ha sido " +
  "realizado con exito. Estimado (a) VITEST PERSONA: Te enviamos el detalle del pago realizado " +
  "con fecha 07/08/2026 Monto del pago: 111.222 ORIGEN Tipo de cuenta: Nº de Cuenta: " +
  "0-000-00-00000-0 DESTINO Tarjeta: W. LIMITED VISA Nº de Tarjeta: **** **** **** 9999 " +
  "Tipo de pago: facturado";

const USD_RECEIPT_TEXT =
  "Santander Comprobante Pago de la deuda facturada en dólares Estimado (a) VITEST PERSONA: Te " +
  "enviamos el detalle de la operación de compra de dólares para abonar o pagar tu Tarjeta de " +
  "Crédito en dólares con fecha 07-08-2026 a las 15:54:18 hrs. Monto pagado (abono) USD 123,45 " +
  "Origen Tipo de cuenta Cuenta Corriente N° de cuenta 0-000-00-00000-0 Destino Tarjeta " +
  "W. LIMITED VISA N° de tarjeta *9999 Datos del pago Cantidad de Dólares USD 123,45 " +
  "Equivalente en pesos $ 115.733 Tipo de cambio $ 937,45 Folio de la operación 000000000001";

function staged(text: string) {
  return { message_id: "<vitest@test>", subject: "vitest", date: "2026-08-07T19:54:52Z", text };
}

describe("santanderCcPaymentReceipts", () => {
  const created: number[] = [];
  afterEach(() => {
    for (const id of created.splice(0)) db.prepare(`DELETE FROM movements WHERE id = ?`).run(id);
  });

  function insertCheckingDebit(occurredOn: string, amount: number): number {
    db.prepare(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note)
       VALUES (?, ?, 'clp', ?, ?)`
    ).run(
      checkingAccountId(),
      amount,
      occurredOn,
      `import:cartola-partial|${occurredOn}|${amount}|VITEST PAGO TARJETA`
    );
    const id = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
    created.push(id);
    return id;
  }

  it("parses the CLP receipt template", () => {
    expect(parsePaymentReceipt(staged(CLP_RECEIPT_TEXT))).toEqual({
      kind: "clp",
      paid_on: "2026-08-07",
      amount_clp: 111222,
      amount_usd: null,
      card_last4: "9999",
    });
  });

  it("parses the USD receipt template (peso equivalent is the checking leg)", () => {
    expect(parsePaymentReceipt(staged(USD_RECEIPT_TEXT))).toEqual({
      kind: "usd",
      paid_on: "2026-08-07",
      amount_clp: 115733,
      amount_usd: 123.45,
      card_last4: "9999",
    });
  });

  it("throws on a receipt with no recognisable amount", () => {
    expect(() =>
      parsePaymentReceipt(staged("Te enviamos el detalle del pago realizado con fecha 07/08/2026"))
    ).toThrow(/amount/);
  });

  it("re-dates the next-workday debit to the receipt's payment date", () => {
    // Paid Friday 2026-08-07 after cutoff; the bank feed posts it Monday 2026-08-10.
    const id = insertCheckingDebit("2026-08-10", -111222);
    const result = applyPaymentReceipt(parsePaymentReceipt(staged(CLP_RECEIPT_TEXT)));
    expect(result.status).toBe("redated");
    expect(result.movement_id).toBe(id);
    const row = db.prepare(`SELECT occurred_on, note FROM movements WHERE id = ?`).get(id) as {
      occurred_on: string;
      note: string;
    };
    expect(row.occurred_on).toBe("2026-08-07");
    // The note keeps the bank date — it is the dedupe identity against the bank's own listings.
    expect(row.note).toContain("|2026-08-10|");
  });

  it("is idempotent and refuses ambiguity", () => {
    insertCheckingDebit("2026-08-10", -111222);
    const receipt = parsePaymentReceipt(staged(CLP_RECEIPT_TEXT));
    expect(applyPaymentReceipt(receipt).status).toBe("redated");
    expect(applyPaymentReceipt(receipt).status).toBe("already_dated");

    // Two same-amount debits in the window → neither is touched.
    const a = insertCheckingDebit("2026-08-10", -333444);
    const b = insertCheckingDebit("2026-08-10", -333444);
    const twin = parsePaymentReceipt(
      staged(CLP_RECEIPT_TEXT.replace("111.222", "333.444"))
    );
    expect(applyPaymentReceipt(twin).status).toBe("ambiguous");
    for (const id of [a, b]) {
      expect(
        (db.prepare(`SELECT occurred_on FROM movements WHERE id = ?`).get(id) as { occurred_on: string })
          .occurred_on
      ).toBe("2026-08-10");
    }
  });

  it("keeps the bank date across a month boundary", () => {
    // Paid Monday 2026-08-31, posted Tuesday 2026-09-01 — pulling it into August would place it
    // in a cartola period whose saldo_final excludes it (checking anchor).
    insertCheckingDebit("2026-09-01", -111222);
    const receipt = parsePaymentReceipt(
      staged(CLP_RECEIPT_TEXT.replace("07/08/2026", "31/08/2026"))
    );
    const result = applyPaymentReceipt(receipt);
    expect(result.status).toBe("month_straddle_keeps_bank_date");
  });

  it("cartola prune carries a receipt re-date onto the official row", () => {
    const checkingId = checkingAccountId();
    // A re-dated partial: row date 07, note keeps the bank date 10.
    db.prepare(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note)
       VALUES (?, -111222, 'clp', '2026-08-07', 'import:cartola-partial|2026-08-10|-111222|VITEST PAGO TARJETA')`
    ).run(checkingId);
    created.push((db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id);
    // The official cartola row, inserted by the cartola import at the bank date.
    db.prepare(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note)
       VALUES (?, -111222, 'clp', '2026-08-10', 'import:cartola|2026-08|401|VITEST PAGO TARJETA|on:2026-08-10')`
    ).run(checkingId);
    const officialId = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
    created.push(officialId);

    const pruned = prunePartialMovementsSupersededByCartola(checkingId, [
      { occurred_on: "2026-08-10", amount_clp: -111222, description: "VITEST PAGO TARJETA", document_no: "" },
    ] as never);
    expect(pruned.removed).toBe(1);
    const official = db
      .prepare(`SELECT occurred_on FROM movements WHERE id = ?`)
      .get(officialId) as { occurred_on: string };
    expect(official.occurred_on).toBe("2026-08-07");
  });
});
