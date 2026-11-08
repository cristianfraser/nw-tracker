import { afterEach, describe, expect, it } from "vitest";
import { db } from "../db.js";
import {
  debtEventLines,
  effectivePurchases,
  findLines,
  lineForPayment,
  planRows,
} from "./purchases.js";

/** Synthetic lines and a plan on the vitest card master, removed after each test. */
describe("purchases views on a card's lines and plans", () => {
  const statementIds: number[] = [];
  const planIds: number[] = [];

  afterEach(() => {
    if (planIds.length > 0) {
      const ph = planIds.map(() => "?").join(",");
      db.prepare(`DELETE FROM cc_installment_payments WHERE purchase_id IN (${ph})`).run(...planIds);
      db.prepare(`DELETE FROM cc_installment_purchases WHERE id IN (${ph})`).run(...planIds);
      planIds.length = 0;
    }
    if (statementIds.length > 0) {
      db.prepare(`DELETE FROM cc_statements WHERE id IN (${statementIds.map(() => "?").join(",")})`).run(...statementIds);
      statementIds.length = 0;
    }
  });

  function master(): number | null {
    const row = db
      .prepare(`SELECT id FROM accounts WHERE notes = 'credit_card_master|santander|vitest-fixture' LIMIT 1`)
      .get() as { id: number } | undefined;
    return row?.id ?? null;
  }

  function statement(accountId: number, close: string): number {
    db.prepare(
      `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, period_from, period_to, currency)
       VALUES (?, 'A', ?, ?, ?, ?, 'clp')`
    ).run(accountId, `vitest-views-${close.replace(/\//g, "")}.pdf`, close, close, close);
    const id = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
    statementIds.push(id);
    return id;
  }

  function line(statementId: number, date: string, merchant: string, amount: number, parserRowId: string | null = null): number {
    db.prepare(
      `INSERT INTO cc_statement_lines (statement_id, transaction_date, merchant, amount_clp, installment_flag, dedupe_key, parser_row_id)
       VALUES (?, ?, ?, ?, 0, ?, ?)`
    ).run(statementId, date, merchant, amount, `vitest-views|${merchant}|${date}|${amount}`, parserRowId);
    return (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
  }

  function plan(accountId: number, purchaseDate: string, merchant: string, total: number, cuotas: number): number {
    db.prepare(
      `INSERT INTO cc_installment_purchases (account_id, card_group, canonical_row_id, purchase_date, total_amount_clp,
         cuotas_totales, merchant, description_merged, source)
       VALUES (?, 'A', ?, ?, ?, ?, ?, ?, 'pdf')`
    ).run(accountId, `vitest-views-${merchant}`, purchaseDate, total, cuotas, merchant, merchant);
    const id = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
    planIds.push(id);
    return id;
  }

  it("counts a line that has a plan once, through the plan", () => {
    const m = master();
    if (!m) return;
    const st = statement(m, "20/03/2031");
    const plain = line(st, "05/03/2031", "VITEST VIEWS SHOP", 12_340);
    const bought = line(st, "06/03/2031", "VITEST VIEWS TV", 300_000);
    const p = plan(m, "2031-03-06", "VITEST VIEWS TV", 300_000, 3);
    const lonely = plan(m, "2031-03-07", "VITEST VIEWS SOFA", 90_000, 3);

    const debt = debtEventLines(m).map((l) => l.id);
    expect(debt).toContain(plain);
    expect(debt).not.toContain(bought);

    const shapes = effectivePurchases(m).filter(
      (e) => (e.shape !== "plan" && [plain, bought].includes(e.line.statement_line_id)) || (e.shape === "plan" && e.plan.id === lonely)
    );
    expect(shapes.map((e) => e.shape).sort()).toEqual(["line", "line_with_plan", "plan"]);
    expect(shapes.find((e) => e.shape === "line_with_plan")).toMatchObject({ plan: { id: p } });
    expect(planRows([m]).map((r) => r.id)).toEqual(expect.arrayContaining([p, lonely]));
  });

  it("takes a backdated posting at its statement's close", () => {
    const m = master();
    if (!m) return;
    const st = statement(m, "20/06/2031");
    const nota = line(st, "22/02/2031", "VITEST VIEWS NOTA", -40_000);
    expect(debtEventLines(m).find((l) => l.id === nota)?.iso).toBe("2031-06-20");
  });

  it("finds lines by card, amount and merchant prefix", () => {
    const m = master();
    if (!m) return;
    const st = statement(m, "20/04/2031");
    const a = line(st, "10/04/2031", "VITEST VIEWS FIND", 4_321);
    expect(findLines({ accountId: m, amountClp: 4_321 }).map((l) => l.line_id)).toEqual([a]);
    expect(findLines({ merchantPrefixes: ["vitest views find"] }).map((l) => l.line_id)).toContain(a);
    expect(findLines({ accountId: m, amountClp: 4_321, excludeLineIds: new Set([a]) })).toEqual([]);
  });

  it("returns the line behind a stored cuota through the parser's row id", () => {
    const m = master();
    if (!m) return;
    const st = statement(m, "20/05/2031");
    const cuotaLine = line(st, "06/03/2031", "VITEST VIEWS CUOTA", 100_000, "vitest-views-row-1");
    const p = plan(m, "2031-03-06", "VITEST VIEWS CUOTA", 300_000, 3);
    db.prepare(
      `INSERT INTO cc_installment_payments (purchase_id, pay_by_date, statement_date, amount_clp, cuota_current, cuota_total, parser_row_id)
       VALUES (?, '2031-06-05', '20/05/2031', 100000, 1, 3, 'vitest-views-row-1')`
    ).run(p);
    const paymentId = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
    expect(lineForPayment(paymentId)?.line_id).toBe(cuotaLine);
  });
});
