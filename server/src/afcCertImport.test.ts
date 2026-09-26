import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { AFC_CIC_SERIES_KEY } from "./afcCicSeries.js";
import {
  afcCartolaTrueUpNoteKey,
  afcContributionNoteKey,
  applyAfcCartolaTrueUps,
  applyAfcCertImport,
  applyAfcWithdrawalUnits,
  groupAfcContributions,
  parseAfcCartola,
  parseAfcCotizacionesCertificate,
  planAfcCartolaTrueUps,
  planAfcCertImport,
  planAfcWithdrawalUnits,
} from "./afcCertImport.js";
import { afpCuotasCumulativeThroughDate } from "./afpUnoValuation.js";
import { leafAssetGroupIdForKindSlug } from "./assetGroupTree.js";

// Synthetic layout text (pdftotext -layout shapes: inline «Mes YYYY», the month/year split around
// a data line, an employer name wrapped onto its own lines). Amounts are made up.
const CERT_TEXT = [
  "                                                                    N° de folio TEST-0000",
  "Certificado de cotizaciones previsionales acreditadas de Cuenta Individual por Cesantía",
  "AFC CHILE S.A. certifica que la Cuenta Individual de Cesantía, perteneciente al afiliado(a) VITEST PERSON,",
  "RUT 11.111.111-1, registra en el periodo comprendido entre OCTUBRE/2002 - SEPTIEMBRE/2099, las siguientes cotizaciones pagadas",
  "a:",
  "                    RUT                                          Renta           Monto          Fecha de",
  "   Período                             Razón Social",
  "                  Empleador                                    Imponible        Cotizado          pago",
  "   Enero 2099     11.111.111-1   EMPRESA UNO SPA                  $1.000.000          $6.000   10/02/2099",
  "   Enero 2099     11.111.111-1   EMPRESA UNO SPA                  $1.000.000         $16.000   10/02/2099",
  "  Septiembre",
  "                  22.222.222-2   EMPRESA DOS LIMITADA             $2.000.000         $12.000   10/10/2099",
  "     2099",
  "  Septiembre",
  "                  22.222.222-2   EMPRESA DOS LIMITADA             $2.000.000         $32.000   10/10/2099",
  "     2099",
  "  Noviembre     44.444.444-4   EMPRESA CUATRO SA                  $300.000           $1.000   09/12/2099",
  "     2099",
  "                                   EMPRESA TRES",
  "  Octubre 2099    33.333.333-3                                    $500.000           $3.000   12/11/2099",
  "                                         LIMITADA",
  "                                                                         TOTAL                $70.000",
  "Se extiende el presente certificado a petición del interesado(a), para los fines que estime conveniente.",
  "",
].join("\n");

const CARTOLA_TEXT = [
  "  Estado cuatrimestral",
  "  de su Cuenta Individual por Cesantía.",
  "  período del 1 de Septiembre al 31 de Diciembre de 2099",
  "SR(A): VITEST PERSON",
  "    1. Saldo inicial",
  " Al 31-08-2099                                                                 (1) $100.000",
  "    2. Ingresos",
  "  Total de cotizaciones                 Otros ingresos        Ganancia          Total ingresos (2)",
  " $48.000                               $0                    $0                $48.000",
  "    3. Egresos",
  "  Total comisiones                      Otros egresos         Uso de la Cuenta Individual   Total egresos (3)",
  " $500                                  $0                    $60.000                       $60.500",
  "    Saldo final",
  " Al 31-12-2099                                                                 (1+2-3) $87.500",
  "    Detalle de cotizaciones",
  " Razón social empleador                            Mes de pago                    Cotización mensual",
  " EMPRESA DOS LIMITADA                              Octubre-2099                          $44.000",
  " EMPRESA TRES LIMITADA                             Noviembre-2099                         $3.000",
  " EMPRESA CUATRO SA                                 Diciembre-2099                         $1.000",
  "                                                                       Total                  $48.000",
  "                                                                     Beneficios del Fondo de Cesantía",
  "",
].join("\n");

describe("AFC certificado de cotizaciones — parser", () => {
  it("parses every leg with its período and pay date, checks the printed TOTAL", () => {
    const cert = parseAfcCotizacionesCertificate(CERT_TEXT);
    expect(cert.total_clp).toBe(70000);
    expect(cert.legs.map((l) => [l.period_ym, l.pay_ymd, l.amount_clp, l.employer])).toEqual([
      ["2099-01", "2099-02-10", 6000, "EMPRESA UNO SPA"],
      ["2099-01", "2099-02-10", 16000, "EMPRESA UNO SPA"],
      ["2099-09", "2099-10-10", 12000, "EMPRESA DOS LIMITADA"],
      ["2099-09", "2099-10-10", 32000, "EMPRESA DOS LIMITADA"],
      ["2099-11", "2099-12-09", 1000, "EMPRESA CUATRO SA"],
      ["2099-10", "2099-11-12", 3000, ""],
    ]);
    expect(cert.legs[0]!.renta_imponible_clp).toBe(1000000);
    expect(cert.legs[0]!.employer_rut).toBe("11.111.111-1");
  });

  it("collapses the two legs of a período into one contribution per pay date", () => {
    const groups = groupAfcContributions(parseAfcCotizacionesCertificate(CERT_TEXT).legs);
    expect(groups.map((g) => [g.period_ym, g.pay_ymd, g.amount_clp, g.legs.length])).toEqual([
      ["2099-01", "2099-02-10", 22000, 2],
      ["2099-09", "2099-10-10", 44000, 2],
      ["2099-10", "2099-11-12", 3000, 1],
      ["2099-11", "2099-12-09", 1000, 1],
    ]);
  });

  it("fails fast on a TOTAL that does not match, or a cotización without a período", () => {
    expect(() => parseAfcCotizacionesCertificate(CERT_TEXT.replace("$70.000", "$70.001"))).toThrow(/TOTAL/);
    const orphan = CERT_TEXT.replace("  Septiembre\n                  22.222.222-2   EMPRESA DOS LIMITADA             $2.000.000         $12.000", "                  22.222.222-2   EMPRESA DOS LIMITADA             $2.000.000         $12.000");
    expect(() => parseAfcCotizacionesCertificate(orphan)).toThrow(/without a período/);
  });
});

describe("AFC estado cuatrimestral — parser", () => {
  it("reads the period, both saldos, the totals and the detalle, and checks the printed identities", () => {
    const c = parseAfcCartola(CARTOLA_TEXT);
    expect(c.period_from_ymd).toBe("2099-09-01");
    expect(c.period_to_ymd).toBe("2099-12-31");
    expect(c.saldo_inicial_ymd).toBe("2099-08-31");
    expect(c.saldo_inicial_clp).toBe(100000);
    expect(c.saldo_final_ymd).toBe("2099-12-31");
    expect(c.saldo_final_clp).toBe(87500);
    expect(c.cotizaciones_clp).toBe(48000);
    expect(c.comisiones_clp).toBe(500);
    expect(c.uso_cuenta_clp).toBe(60000);
    expect(c.detalle).toEqual([
      { employer: "EMPRESA DOS LIMITADA", pay_month_ym: "2099-10", amount_clp: 44000 },
      { employer: "EMPRESA TRES LIMITADA", pay_month_ym: "2099-11", amount_clp: 3000 },
      { employer: "EMPRESA CUATRO SA", pay_month_ym: "2099-12", amount_clp: 1000 },
    ]);
  });

  it("throws when the saldo identity or the detalle sum is broken", () => {
    expect(() => parseAfcCartola(CARTOLA_TEXT.replace("(1+2-3) $87.500", "(1+2-3) $87.400"))).toThrow(/saldo final/);
    expect(() => parseAfcCartola(CARTOLA_TEXT.replace("$3.000\n", "$3.001\n"))).toThrow(/detalle/);
  });
});

describe("AFC ledger rebuild (test DB)", () => {
  const PX = 4000;
  const PX_DAYS = ["2099-02-10", "2099-08-31", "2099-10-10", "2099-11-12", "2099-12-09", "2099-12-15", "2099-12-31", "2100-01-15"];
  let accountId = 0;
  let otherAccountId = 0;

  beforeAll(() => {
    const groupId = leafAssetGroupIdForKindSlug("afc");
    accountId = Number(
      db
        .prepare(
          `INSERT INTO accounts (asset_group_id, name, notes, fund_series_key, exclude_from_group_totals)
           VALUES (?, 'AFC rebuild vitest', 'vitest:afc-rebuild', ?, 0)`
        )
        .run(groupId, AFC_CIC_SERIES_KEY).lastInsertRowid
    );
    otherAccountId = Number(
      db
        .prepare(
          `INSERT INTO accounts (asset_group_id, name, notes, exclude_from_group_totals)
           VALUES (?, 'AFC rebuild vitest counterpart', 'vitest:afc-rebuild-counterpart', 0)`
        )
        .run(groupId).lastInsertRowid
    );
    const ins = db.prepare(
      `INSERT INTO fund_unit_daily (series_key, day, unit_value_clp, note) VALUES (?, ?, ?, 'vitest:px')
       ON CONFLICT(series_key, day) DO UPDATE SET unit_value_clp = excluded.unit_value_clp, note = excluded.note`
    );
    for (const d of PX_DAYS) ins.run(AFC_CIC_SERIES_KEY, d, PX);
    // Excel-era rows: a contribution the certificate supersedes, and a non-contribution row.
    db.prepare(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note) VALUES (?, 22000, 'clp', '2099-02-28', 'import:excel|afc-flow|vitest')`
    ).run(accountId);
    db.prepare(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note) VALUES (?, -60000, 'clp', '2099-12-15', 'import:excel|afc-flow|vitest retiro')`
    ).run(accountId);
  });

  afterAll(() => {
    for (const id of [accountId, otherAccountId]) {
      if (!id) continue;
      db.prepare(`DELETE FROM movements WHERE account_id = ? OR from_account_id = ? OR to_account_id = ?`).run(id, id, id);
      db.prepare(`DELETE FROM valuations WHERE account_id = ?`).run(id);
      db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
    }
    db.prepare(`DELETE FROM fund_unit_daily WHERE series_key = ? AND note = 'vitest:px'`).run(AFC_CIC_SERIES_KEY);
  });

  it("imports the certificate at pay-date valor cuota, replacing the excel contributions; re-runs are idempotent", () => {
    const cert = parseAfcCotizacionesCertificate(CERT_TEXT);
    const plan = planAfcCertImport(accountId, cert);
    expect(plan.items.map((i) => [i.status, i.units])).toEqual([
      ["insert", 5.5],
      ["insert", 11],
      ["insert", 0.75],
      ["insert", 0.25],
    ]);
    expect(plan.excel_contribution_rows.map((m) => m.amount)).toEqual([22000]);
    expect(plan.excel_other_rows.map((m) => m.amount)).toEqual([-60000]);

    const r = applyAfcCertImport(plan, { replaceExcelContributions: true });
    expect(r).toEqual({ inserted: 4, units_updated: 0, deleted: 1, mismatches: 0 });
    const rows = db
      .prepare(`SELECT occurred_on, amount, units_delta, note FROM movements WHERE account_id = ? AND amount > 0 ORDER BY occurred_on`)
      .all(accountId) as { occurred_on: string; amount: number; units_delta: number; note: string }[];
    expect(rows.map((m) => [m.occurred_on, m.amount, m.units_delta])).toEqual([
      ["2099-02-10", 22000, 5.5],
      ["2099-10-10", 44000, 11],
      ["2099-11-12", 3000, 0.75],
      ["2099-12-09", 1000, 0.25],
    ]);
    expect(rows[0]!.note.startsWith(afcContributionNoteKey("2099-01", "2099-02-10"))).toBe(true);

    const again = planAfcCertImport(accountId, cert);
    expect(again.items.every((i) => i.status === "unchanged")).toBe(true);
    expect(again.excel_contribution_rows).toEqual([]);

    // A changed printed amount is a mismatch, never an overwrite.
    const changed = parseAfcCotizacionesCertificate(CERT_TEXT.replace("$16.000", "$16.001").replace("$70.000", "$70.001"));
    const mismatch = planAfcCertImport(accountId, changed);
    expect(mismatch.items[0]!.status).toBe("mismatch");
    expect(applyAfcCertImport(mismatch, { replaceExcelContributions: false }).mismatches).toBe(1);
  });

  it("prices withdrawals at the valor cuota of their date, then lands the cartola's saldos with true-ups", () => {
    const w = planAfcWithdrawalUnits(accountId);
    expect(w.map((x) => [x.movement.amount, x.units_abs, x.closes_position, x.status])).toEqual([[-60000, 15, false, "set"]]);
    expect(applyAfcWithdrawalUnits(w)).toBe(1);
    expect(afpCuotasCumulativeThroughDate(accountId, "2099-12-31")).toBe(2.5);

    const cartola = parseAfcCartola(CARTOLA_TEXT);
    const plan = planAfcCartolaTrueUps(accountId, cartola);
    expect(plan.ledger_cotizaciones_clp).toBe(48000);
    // Inicial: saldo 100.000 ÷ 4000 = 25 cuotas vs the 5,5 in the ledger → +19,5 (7x.xxx, yield-like).
    // Final: 8x.xxx ÷ 4000 = 21,875 vs 5,5 + 19,5 + 11 + 0,75 + 0,25 − 15 = 22 → −0,125 (−500 = the printed commission).
    expect(plan.trueups.map((t) => [t.which, t.units, t.amount_clp, t.flow_kind, t.status])).toEqual([
      ["inicial", 19.5, 78000, "savings_earnings", "insert"],
      ["final", -0.125, -500, "cash_fee", "insert"],
    ]);
    expect(applyAfcCartolaTrueUps(plan)).toEqual({ inserted: 2, updated: 0, deleted: 0 });
    expect(afpCuotasCumulativeThroughDate(accountId, "2099-12-31")).toBe(21.875);

    const again = planAfcCartolaTrueUps(accountId, cartola);
    expect(again.trueups.map((t) => t.status)).toEqual(["unchanged", "unchanged"]);
    const finalRow = db
      .prepare(`SELECT amount, flow_kind FROM movements WHERE account_id = ? AND note LIKE ?`)
      .get(accountId, `${afcCartolaTrueUpNoteKey("final", "2099-12-31")}%`) as { amount: number; flow_kind: string };
    expect(finalRow).toEqual({ amount: -500, flow_kind: "cash_fee" });
  });

  it("refuses a cartola whose cotizaciones are not all in the ledger", () => {
    const cartola = parseAfcCartola(
      CARTOLA_TEXT.replaceAll("$48.000", "$49.000").replace("$3.000\n", "$4.000\n").replace("(1+2-3) $87.500", "(1+2-3) $88.500")
    );
    expect(() => planAfcCartolaTrueUps(accountId, cartola)).toThrow(/import the certificate first/);
  });

  it("a withdrawal after which the stored valuation reads 0 closes the position with exactly the cuotas held", () => {
    db.prepare(`INSERT INTO valuations (account_id, as_of_date, value) VALUES (?, '2100-01-31', 0)`).run(accountId);
    db.prepare(
      `INSERT INTO movements (from_account_id, to_account_id, amount, currency, occurred_on, note) VALUES (?, ?, 80000, 'clp', '2100-01-15', 'vitest retiro final')`
    ).run(accountId, otherAccountId);
    const w = planAfcWithdrawalUnits(accountId);
    const closing = w.find((x) => x.movement.occurred_on === "2100-01-15")!;
    expect(closing.closes_position).toBe(true);
    expect(closing.units_abs).toBe(21.875);
    expect(applyAfcWithdrawalUnits(w)).toBe(1);
    expect(afpCuotasCumulativeThroughDate(accountId, "2100-01-31")).toBe(0);
  });
});
