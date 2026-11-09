/**
 * The rents of a year for the F22, by place (`expense_accounts`), from the credits the user marked
 * as rent (`flow_income_overrides.income_kind = 'rent'`, which names the place):
 *
 * - A DFL-2 place's rent (the place's `dfl2` flag) is not declared: DFL N° 2 de 1959 art. 15 frees
 *   it of the income taxes for a natural person with up to two «viviendas económicas» (Suplemento
 *   Tributario AT2026, línea 9, 9.3 g): «rentas … liberadas de los impuestos de la LIR»). Shown, no
 *   code. A third DFL-2 place with rent in the year throws: the law exempts the two acquired first,
 *   and the app does not know acquisition order.
 * - Any other place's rent is taxable: art. 20 N°1 letra b) LIR, renta efectiva determined by the
 *   contract, exempt from first category for a natural person (art. 39 N°3) — F22 línea 5 letra a),
 *   code 1849, summed into 955 (Suplemento AT2026, línea 5, 5.2 a)). Its contribuciones paid in the
 *   year are the IGC credit of art. 56 N°5 (línea 39, code 1637), capped at the IGC on that rent
 *   (`f22PropertyTaxCreditCap`); no refund, no carry.
 *
 * Both amounts are reajustados to December by the SII's one-decimal IPC (from the month before the
 * credit or the payment), as art. 54's last paragraph does for the IGC base and as the credit's
 * «impuesto territorial efectivamente pagado» is read here — the line-39 instruction does not say it
 * in words; reajusting it is this module's reading (the old code 365 instruction reajusted it).
 *
 * Contribuciones are the place's `contribuciones` bill rows whose month falls in the year (a bill
 * row exists only when a purchase backs it, so it is what was paid).
 */
import { db } from "./db.js";
import { DFL2_MAX_EXEMPT_RENTALS } from "./legalParameters.js";
import { loadRentCreditsForYear } from "./flowsCheckingIncomeOverrides.js";
import { ipcReajuste, monthBeforeYmd } from "./siiOfficialIpc.js";

export type F22RentalPlace = {
  slug: string;
  label: string;
  dfl2: boolean;
  credits: number;
  /** The year's rent reajustada to December. */
  rentClp: number;
  /** The contribuciones paid in the year, reajustadas (only a taxable place's count toward 1637). */
  propertyTaxPaidClp: number;
};

export type F22Rentals = {
  places: F22RentalPlace[];
  /** 1849: the taxable places' rent. */
  taxableRentClp: number;
  /** DFL-2 rent: not declared. */
  exemptRentClp: number;
  /** Contribuciones paid on the taxable places — the credit before its cap. */
  propertyTaxPaidClp: number;
  /** The December reajuste uses the latest published month (open income year). */
  provisional: boolean;
};

type PlaceRow = { id: number; slug: string; label: string; dfl2: number };

export function rentalsForYear(incomeYear: number): F22Rentals {
  const credits = loadRentCreditsForYear(incomeYear);
  const empty: F22Rentals = { places: [], taxableRentClp: 0, exemptRentClp: 0, propertyTaxPaidClp: 0, provisional: false };
  if (credits.length === 0) return empty;
  const ipc = ipcReajuste({ round: true, floorAtZero: true });
  const { toMonth, provisional } = ipc.december(incomeYear);
  const reajustado = (amount: number, ymd: string) => amount * (1 + ipc.pct(monthBeforeYmd(ymd), toMonth) / 100);

  const placeIds = [...new Set(credits.map((c) => c.placeId))];
  const placeStmt = db.prepare(`SELECT id, slug, label, dfl2 FROM expense_accounts WHERE id = ?`);
  const taxStmt = db.prepare(
    `SELECT spent_on, amount_clp FROM expense_entries
      WHERE expense_account_id = ? AND category = 'contribuciones' AND spent_on LIKE ?`
  );
  const places: F22RentalPlace[] = placeIds.map((id) => {
    const p = placeStmt.get(id) as PlaceRow | undefined;
    if (!p) throw new Error(`rent names place ${id}, which does not exist`);
    const mine = credits.filter((c) => c.placeId === id);
    const taxRows = taxStmt.all(id, `${incomeYear}-%`) as { spent_on: string; amount_clp: number }[];
    return {
      slug: p.slug,
      label: p.label,
      dfl2: p.dfl2 === 1,
      credits: mine.length,
      rentClp: Math.round(mine.reduce((s, c) => s + reajustado(c.amountClp, c.receivedOn), 0)),
      propertyTaxPaidClp: Math.round(taxRows.reduce((s, r) => s + reajustado(r.amount_clp, r.spent_on), 0)),
    };
  });
  const exempt = places.filter((p) => p.dfl2);
  if (exempt.length > DFL2_MAX_EXEMPT_RENTALS) {
    throw new Error(
      `F22 ${incomeYear}: rent from ${exempt.length} DFL-2 places (${exempt.map((p) => p.slug).join(", ")}); art. 15 exempts at most ${DFL2_MAX_EXEMPT_RENTALS}, the first acquired`
    );
  }
  const taxable = places.filter((p) => !p.dfl2);
  return {
    places,
    taxableRentClp: taxable.reduce((s, p) => s + p.rentClp, 0),
    exemptRentClp: exempt.reduce((s, p) => s + p.rentClp, 0),
    propertyTaxPaidClp: taxable.reduce((s, p) => s + p.propertyTaxPaidClp, 0),
    provisional,
  };
}
