import { afterEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  getMovementDividendDetail,
  upsertMovementDividendDetail,
} from "./movementDividendDetails.js";

/**
 * The writer is the one choke point for the tax record: it must refuse a breakdown that does
 * not describe the movement it is attached to, refuse two documents that disagree, and let a
 * richer document replace a poorer one without ever letting the poorer one overwrite it.
 */
describe("movementDividendDetails", () => {
  const created: number[] = [];

  afterEach(() => {
    for (const id of created.splice(0)) db.prepare(`DELETE FROM movements WHERE id = ?`).run(id);
  });

  function twoAccounts(): { from: number; to: number } {
    const rows = db.prepare(`SELECT id FROM accounts ORDER BY id LIMIT 2`).all() as { id: number }[];
    if (rows.length < 2) throw new Error("need two accounts in the test DB");
    return { from: rows[0]!.id, to: rows[1]!.id };
  }

  function seedDividend(amount: number, flowKind: string | null = "dividend_payout"): number {
    const { from, to } = twoAccounts();
    const id = Number(
      db
        .prepare(
          `INSERT INTO movements (from_account_id, to_account_id, amount, currency, occurred_on, note, flow_kind)
           VALUES (?, ?, ?, 'usd', '2026-09-18', 'vitest-dividend-detail', ?)`
        )
        .run(from, to, amount, flowKind).lastInsertRowid
    );
    created.push(id);
    return id;
  }

  it("records gross and withholding against the movement's net and reports the outcome", () => {
    const id = seedDividend(2.34);
    const first = upsertMovementDividendDetail({
      movement_id: id,
      gross_amount: 2.75,
      withholding_amount: 0.41,
      currency: "usd",
      withholding_jurisdiction: "US",
      broker_event_id: "vitest-div-1",
      source: "racional_api",
      source_ref: "dividends-vitest.json",
    });
    expect(first.outcome).toBe("inserted");
    expect(getMovementDividendDetail(id)).toMatchObject({
      gross_amount: 2.75,
      withholding_amount: 0.41,
      withholding_jurisdiction: "US",
      withholding_rate_pct: null,
      source: "racional_api",
    });

    const again = upsertMovementDividendDetail({
      movement_id: id,
      gross_amount: 2.75,
      withholding_amount: 0.41,
      currency: "usd",
      withholding_jurisdiction: "US",
      broker_event_id: "vitest-div-1",
      source: "racional_api",
      source_ref: "dividends-vitest.json",
    });
    expect(again.outcome).toBe("unchanged");
  });

  it("refuses a breakdown whose gross − withholding is not what the movement credited", () => {
    // The 2026-09-22 bug in reverse: a movement booked GROSS must not get a net breakdown
    // stapled on as if it were right.
    const id = seedDividend(2.75);
    expect(() =>
      upsertMovementDividendDetail({
        movement_id: id,
        gross_amount: 2.75,
        withholding_amount: 0.41,
        currency: "usd",
        source: "racional_api",
      })
    ).toThrow(/credited 2\.75 usd but the document's gross 2\.75 − withholding 0\.41 = 2\.34/);
  });

  it("tolerates per-column cent rounding but not a different dividend", () => {
    const id = seedDividend(1.7);
    // Fintual's certificado prints 1,99 / 0,29 / 1,70 with each column rounded on its own.
    expect(
      upsertMovementDividendDetail({ movement_id: id, gross_amount: 1.99, withholding_amount: 0.3, currency: "usd", source: "fintual_certificado" })
        .outcome
    ).toBe("inserted");
    // Same net, different gross and tax: another document describing the same movement
    // differently is a disagreement, not an enrichment.
    expect(() =>
      upsertMovementDividendDetail({ movement_id: id, gross_amount: 2.1, withholding_amount: 0.4, currency: "usd", source: "fintual_cartola" })
    ).toThrow(/two documents disagree/);
    // A different net is caught earlier, against the movement itself.
    expect(() =>
      upsertMovementDividendDetail({ movement_id: id, gross_amount: 2.04, withholding_amount: 0.3, currency: "usd", source: "fintual_cartola" })
    ).toThrow(/credited 1\.70 usd/);
  });

  it("only accepts dividend_payout transfers in the document's currency", () => {
    const notDividend = seedDividend(2.34, "stock_buy");
    expect(() =>
      upsertMovementDividendDetail({ movement_id: notDividend, gross_amount: 2.75, withholding_amount: 0.41, currency: "usd", source: "manual" })
    ).toThrow(/not a dividend_payout transfer/);
    const dividend = seedDividend(2.34);
    expect(() =>
      upsertMovementDividendDetail({ movement_id: dividend, gross_amount: 2.75, withholding_amount: 0.41, currency: "clp", source: "manual" })
    ).toThrow(/is in usd, the document says clp/);
    expect(() =>
      upsertMovementDividendDetail({ movement_id: 0, gross_amount: 1, withholding_amount: 0, currency: "usd", source: "manual" })
    ).toThrow(/does not exist/);
  });

  it("lets a richer document replace a poorer one, and a poorer one only fill what is missing", () => {
    const id = seedDividend(1.67);
    const cert = upsertMovementDividendDetail({
      movement_id: id,
      gross_amount: 1.96,
      withholding_amount: 0.29,
      currency: "usd",
      pay_date: "2026-07-31",
      source: "fintual_certificado",
      source_ref: "certificado.pdf",
    });
    expect(cert.outcome).toBe("inserted");

    // The Alpaca cartola outranks the certificado: it carries the rate, the position and the
    // record date, so it takes the row over.
    const cartola = upsertMovementDividendDetail({
      movement_id: id,
      gross_amount: 1.96,
      withholding_amount: 0.29,
      currency: "usd",
      withholding_rate_pct: 15,
      withholding_jurisdiction: "US",
      tax_residency_country: "CHL",
      per_share_amount: 1.903516,
      position_qty: 1.027327209,
      record_date: "2026-06-18",
      pay_date: "2026-07-31",
      source: "fintual_cartola",
      source_ref: "cartola_mensual_julio.pdf",
    });
    expect(cartola.outcome).toBe("replaced");
    expect(getMovementDividendDetail(id)).toMatchObject({
      source: "fintual_cartola",
      withholding_rate_pct: 15,
      per_share_amount: 1.903516,
      record_date: "2026-06-18",
    });

    // Re-importing the certificado afterwards changes nothing: the cartola's fields stand.
    const certAgain = upsertMovementDividendDetail({
      movement_id: id,
      gross_amount: 1.96,
      withholding_amount: 0.29,
      currency: "usd",
      pay_date: "2026-07-31",
      source: "fintual_certificado",
      source_ref: "certificado.pdf",
    });
    expect(certAgain.outcome).toBe("unchanged");
    expect(getMovementDividendDetail(id)!.source).toBe("fintual_cartola");

    // The same document class from another file (a later cartola re-listing the row, a second
    // certificado) is provenance only — no rewrite, so the nightly re-read cannot churn.
    const otherFile = upsertMovementDividendDetail({
      movement_id: id,
      gross_amount: 1.96,
      withholding_amount: 0.29,
      currency: "usd",
      withholding_rate_pct: 15,
      withholding_jurisdiction: "US",
      tax_residency_country: "CHL",
      per_share_amount: 1.903516,
      position_qty: 1.027327209,
      record_date: "2026-06-18",
      pay_date: "2026-07-31",
      source: "fintual_cartola",
      source_ref: "cartola_mensual_agosto.pdf",
    });
    expect(otherFile.outcome).toBe("unchanged");
    expect(getMovementDividendDetail(id)!.source_ref).toBe("cartola_mensual_julio.pdf");

    // A poorer document that knows something the richer one left null may fill it.
    const manualFill = upsertMovementDividendDetail({
      movement_id: id,
      gross_amount: 1.96,
      withholding_amount: 0.29,
      currency: "usd",
      broker_event_id: "vitest-event-xyz",
      source: "manual",
    });
    expect(manualFill.outcome).toBe("enriched");
    expect(getMovementDividendDetail(id)).toMatchObject({ source: "fintual_cartola", broker_event_id: "vitest-event-xyz" });
  });

  it("cascades away with its movement", () => {
    const id = seedDividend(2.34);
    upsertMovementDividendDetail({ movement_id: id, gross_amount: 2.75, withholding_amount: 0.41, currency: "usd", source: "manual" });
    db.prepare(`DELETE FROM movements WHERE id = ?`).run(id);
    created.splice(created.indexOf(id), 1);
    expect(getMovementDividendDetail(id)).toBeNull();
  });
});
