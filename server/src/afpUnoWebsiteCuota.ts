/**
 * Live UNO AFP Fondo A “valor cuota” from the public homepage ([uno.cl](https://www.uno.cl/)).
 * Historical series stay on ¿Qué tal mi AFP?; the site refreshes around midnight Chile time.
 */

const UNO_HOMEPAGE = "https://www.uno.cl/";

const ES_MONTH_TO_MM: Record<string, string> = {
  enero: "01",
  febrero: "02",
  marzo: "03",
  abril: "04",
  mayo: "05",
  junio: "06",
  julio: "07",
  agosto: "08",
  septiembre: "09",
  octubre: "10",
  noviembre: "11",
  diciembre: "12",
};

/** Chile CLP display: `95.817,30` → 95817.3 */
export function parseChileLocaleMoneyToNumber(fragment: string): number | null {
  const m = fragment.match(/(\d{1,3}(?:\.\d{3})*,\d{2})/);
  if (!m) return null;
  const normalized = m[1]!.replace(/\./g, "").replace(",", ".");
  const v = Number(normalized);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * First multifondos “Actualizados al D de mes de YYYY” after `html[start:]`.
 * UNO lists multifondos before UF/dólar; the first match in the slice is the cuota stamp.
 */
export function parseUnoMultifondosActualizadoYmd(html: string, start: number): string | null {
  const slice = html.slice(start, start + 20000);
  const m = /Actualizados al (\d{1,2}) de ([a-záéíóúñ]+) de (\d{4})/i.exec(slice);
  if (!m) return null;
  const dd = String(Number.parseInt(m[1]!, 10)).padStart(2, "0");
  const mon = ES_MONTH_TO_MM[m[2]!.toLowerCase()];
  const yyyy = m[3]!;
  if (!mon) return null;
  return `${yyyy}-${mon}-${dd}`;
}

export type UnoClFondoACuotaParse = {
  unit_value_clp: number;
  /** Calendar `YYYY-MM-DD` from “Actualizados al …” when parsed; else null. */
  quote_day_ymd: string | null;
  raw_price_fragment: string;
};

/**
 * Parses server-rendered HTML: Fondo A is `Fondo <!-- -->A` (React comment nodes).
 */
export function parseUnoClHomepageFondoAValorCuota(html: string): UnoClFondoACuotaParse | null {
  const anchor = html.indexOf("valores cuota de nuestros multifondos");
  if (anchor < 0) return null;
  const slice = html.slice(anchor, anchor + 25000);
  const m = /Fondo <!-- -->A[\s\S]{0,2000}?\$\s*(\d{1,3}(?:\.\d{3})*,\d{2})/.exec(slice);
  if (!m) return null;
  const raw = m[0]!.slice(Math.max(0, m[0]!.indexOf("$")));
  const rawNum = parseChileLocaleMoneyToNumber(m[1]!);
  if (rawNum == null) return null;
  const unit_value_clp = Math.round(rawNum * 100) / 100;
  const quote_day_ymd = parseUnoMultifondosActualizadoYmd(html, anchor);
  return { unit_value_clp, quote_day_ymd, raw_price_fragment: raw };
}

export async function fetchUnoClHomepageHtml(opts?: { signal?: AbortSignal }): Promise<string> {
  const res = await fetch(UNO_HOMEPAGE, {
    redirect: "follow",
    signal: opts?.signal,
    headers: {
      Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
      "User-Agent": "nw-tracker-afp-uno-website/1.0 (+local)",
    },
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`uno.cl HTTP ${res.status}: ${t.slice(0, 400)}`);
  }
  return res.text();
}

export async function fetchUnoClFondoAValorCuota(opts?: {
  signal?: AbortSignal;
}): Promise<UnoClFondoACuotaParse> {
  const html = await fetchUnoClHomepageHtml(opts);
  const parsed = parseUnoClHomepageFondoAValorCuota(html);
  if (!parsed) {
    throw new Error(
      "Could not parse Fondo A valor cuota from uno.cl (layout may have changed). " +
        "Look for block after “valores cuota de nuestros multifondos” and `Fondo <!-- -->A`."
    );
  }
  return parsed;
}
