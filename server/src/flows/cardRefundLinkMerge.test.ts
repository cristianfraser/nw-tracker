import { afterAll, describe, expect, it } from "vitest";
import { db } from "../db.js";
import { mergeFlowInto } from "./flowIdentity.js";

/** Throwaway flows shaped like an existing one (so every constraint holds), removed in afterAll. */
const created: number[] = [];
function newFlow(): number {
  const id = Number(
    db
      .prepare(
        `INSERT INTO flows (kind, from_account_id, to_account_id, from_party_id, to_party_id, occurred_on, amount, currency)
         SELECT kind, from_account_id, to_account_id, from_party_id, to_party_id, occurred_on, amount, currency
         FROM flows ORDER BY id LIMIT 1`
      )
      .run().lastInsertRowid
  );
  created.push(id);
  return id;
}

const linkOf = (refundFlow: number) =>
  (db.prepare(`SELECT purchase_flow_id AS p FROM card_refund_links WHERE flow_id = ?`).get(refundFlow) as { p: number } | undefined)?.p;

afterAll(() => {
  for (const id of created) db.prepare(`DELETE FROM flows WHERE id = ?`).run(id);
});

describe("card refund links follow flow merges", () => {
  it("moves the refund's end and the purchase's end to the surviving flow", () => {
    const refund = newFlow();
    const purchase = newFlow();
    const survivor = newFlow();
    db.prepare(`INSERT INTO card_refund_links (flow_id, purchase_flow_id) VALUES (?, ?)`).run(refund, purchase);

    mergeFlowInto(purchase, survivor, "to");
    expect(linkOf(refund)).toBe(survivor);

    const refundAgain = newFlow();
    mergeFlowInto(refund, refundAgain, "to");
    expect(linkOf(refund)).toBeUndefined();
    expect(linkOf(refundAgain)).toBe(survivor);
  });

  it("drops a link a merge turns onto itself", () => {
    const refund = newFlow();
    const purchase = newFlow();
    db.prepare(`INSERT INTO card_refund_links (flow_id, purchase_flow_id) VALUES (?, ?)`).run(refund, purchase);
    mergeFlowInto(purchase, refund, "to");
    expect(linkOf(refund)).toBeUndefined();
  });
});
