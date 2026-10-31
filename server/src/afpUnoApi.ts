/**
 * AFP UNO's own valor cuota history, the API its website's «valor cuota» page reads:
 *
 *   POST https://www.uno.cl/api/valor-cuota-buscar/historico
 *   {"fechaInicio":"YYYY-MM-DD","fechaFin":"YYYY-MM-DD"}
 *
 * Answers `{"codigo":"0","data":[{"FECHA":"2026-10-28T00:00:00-03:00","FONDO_A":"99346,22",…}, …]}`
 * newest first, one row per calendar day (weekends carry the previous value), Chilean decimal
 * comma; its history starts 2019-10-01 and fits one request. Any other `codigo` is an error (a
 * dd/mm body answers «150»).
 *
 * The hosted demo's source for UNO fund A (`afpUnoOfficialSource`): the Superintendencia's site,
 * the personal instance's source, refuses connections from the demo's host. Checked against the
 * SP on 2026-10-31: the same value on the same date to the cent, except 15 days of March 2020
 * (≤ 0,27 % apart), and published one business day after the SP.
 */
import { parseChileanNumber } from "./chileanNumber.js";
import { fetchOut } from "./httpOut.js";
import type { SpAfpFundUnitRow } from "./spAfpFundUnits.js";

export const UNO_API_HISTORY_URL = "https://www.uno.cl/api/valor-cuota-buscar/historico";
/** The first day UNO's API answers (the AFP started in October 2019). */
export const UNO_API_FIRST_DAY = "2019-10-01";

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Fund A rows of one API answer, ascending, as `pension_fund_unit_official` rows of `uno`.
 * Throws on a non-"0" `codigo`, a row without a date or a fund A value, a value that is not a
 * positive Chilean number, a day printed twice, or rows that are not newest first.
 */
export function parseUnoValorCuotaHistorico(body: unknown): SpAfpFundUnitRow[] {
  if (body == null || typeof body !== "object") throw new Error("uno_api: answer is not an object");
  const { codigo, data } = body as { codigo?: unknown; data?: unknown };
  if (codigo !== "0") throw new Error(`uno_api: answered codigo ${JSON.stringify(codigo)}`);
  if (!Array.isArray(data)) throw new Error("uno_api: answer carries no data array");
  const rows: SpAfpFundUnitRow[] = [];
  let prev: string | null = null;
  for (const item of data) {
    const fecha = (item as { FECHA?: unknown } | null)?.FECHA;
    const raw = (item as { FONDO_A?: unknown } | null)?.FONDO_A;
    if (typeof fecha !== "string" || !ISO_DAY.test(fecha.slice(0, 10))) {
      throw new Error(`uno_api: unexpected FECHA ${JSON.stringify(fecha)}`);
    }
    // The date is printed at Chile midnight with its offset: the calendar day is its first 10 chars.
    const day = fecha.slice(0, 10);
    if (typeof raw !== "string") throw new Error(`uno_api: ${day} carries no FONDO_A`);
    const v = parseChileanNumber(raw);
    if (!(v > 0)) throw new Error(`uno_api: non-positive FONDO_A on ${day}`);
    if (prev != null && day >= prev) throw new Error(`uno_api: rows not newest first at ${day} (after ${prev})`);
    prev = day;
    rows.push({ afp: "uno", fund: "A", day, unit_value_clp: v, provisional: false });
  }
  return rows.reverse();
}

export async function fetchUnoFundAHistory(
  fromDay: string,
  toDay: string,
  opts?: { signal?: AbortSignal }
): Promise<SpAfpFundUnitRow[]> {
  for (const d of [fromDay, toDay]) {
    if (!ISO_DAY.test(d)) throw new Error(`uno_api: invalid date ${d}`);
  }
  if (fromDay > toDay) throw new Error(`uno_api: ${fromDay} is after ${toDay}`);
  const res = await fetchOut(`uno_api:A:${fromDay}..${toDay}`, UNO_API_HISTORY_URL, {
    method: "POST",
    signal: opts?.signal,
    headers: { "content-type": "application/json", "user-agent": "Mozilla/5.0" },
    body: JSON.stringify({ fechaInicio: fromDay, fechaFin: toDay }),
  });
  if (!res.ok) throw new Error(`uno_api: HTTP ${res.status}`);
  const rows = parseUnoValorCuotaHistorico(await res.json());
  const bad = rows.find((r) => r.day < fromDay || r.day > toDay);
  if (bad) throw new Error(`uno_api: ${fromDay}..${toDay} answer carries a row dated ${bad.day}`);
  return rows;
}
