import fs from "node:fs";
import path from "node:path";
import {
  cardStatementKind,
  type CardStatementLine,
  type CardStatementOutcome,
  type CardStatementPayload,
} from "nw-tracker-contracts";

/**
 * Santander's facturación JSON (the «estado de cuenta» the card-statements step stages) → one
 * `card.statement` per facturación.
 *
 * Field mapping was established by diffing this feed against the same statement already imported
 * from its PDF (2026-07-23, card ·0901), not by reading field names — several of them mislead.
 * The server's cross-check (every PDF-owned close is diffed against the JSON) remains the
 * regression check when changing this.
 */

/** `AS_TIB_WM02_…` national (CLP) statement row. */
export type SantanderNationalRow = {
  Pan: string;
  NombreComercio: string;
  FechaTxs: string;
  MontoTxs: string;
  NumeroCuotas: string;
  TotalCuotas: string;
  MontoCuota: string;
  TipoCuota: string;
  TasaCompraCuotas: string;
  CodTxs: string;
  Ciudad: string | null;
  Microfilm: string | null;
  GlosaRubroCom: string | null;
};

/** `AS_TIB_WM03_…` international (USD) statement row. */
export type SantanderInternationalRow = {
  Pan: string;
  NombreComercio: string;
  FechaTxs: string;
  FechaProceso: string | null;
  MontoOrigen: string;
  MontoTransaccion: string;
  CodPais: string | null;
  CiudadComercio: string | null;
  NumeroReferencia: string | null;
  CodTxs: string;
};

/**
 * Transaction codes seen on the national statement. National amounts arrive unsigned, so each
 * code's sign is mapped here, and an unknown code is refused rather than guessed.
 */
export const NATIONAL_COD_TXS = {
  PURCHASE: "000",
  PURCHASE_INTERNET: "005",
  INSTALLMENT_CUOTA: "205",
  /** The previous facturación's payment; the PDF parser drops its row (the amount lives in the header). */
  PAYMENT: "067",
  INSURANCE: "002",
  STAMP_TAX: "203",
  /** SERVICIO USO INTERNACIONAL and its IVA — the bank's charge for using the card abroad, both
   * positive: on the 24/09/2026 close TotalCargos 16.060 = 9.882 (071) + 1.878 (701) + two stamp
   * taxes 79 + 4.221, and DeudaTotalFact = compras + cargos aut + cargos exact. */
  INTERNATIONAL_USE_FEE: "071",
  INTERNATIONAL_USE_FEE_VAT: "701",
  /** NOTA DE CREDITO — a refund/reversal the bank nets NEGATIVE into DeudaTotalFact (its amount
   * rides in TotalCargos with a trailing '-'; verified on the 25/08/2026 close: compras + cargos aut
   * − 2.140 nota = facturado exact). */
  CREDIT_NOTE: "510",
} as const;

const KNOWN_NATIONAL_COD_TXS = new Set<string>(Object.values(NATIONAL_COD_TXS));

/**
 * Read a zero-padded fixed-point amount.
 *
 * Two conventions coexist and confusing them is a silent factor-of-100 error: national amounts are
 * integer pesos (`"0000023270"` = 23.270) while international amounts carry two implied decimals and
 * an optional TRAILING sign (`"00000001414+"` = 14.14, `"00000025813-"` = −258.13).
 */
export function parseSantanderFixed(raw: string, decimals: 0 | 2): number {
  const text = String(raw ?? "").trim();
  const m = /^(\d+)([+-]?)$/.exec(text);
  if (!m) throw new Error(`Unexpected Santander fixed-point amount "${raw}"`);
  const magnitude = Number(m[1]) / 10 ** decimals;
  if (!Number.isFinite(magnitude)) throw new Error(`Unparseable Santander amount "${raw}"`);
  return m[2] === "-" ? -magnitude : magnitude;
}

/** `YYYY-MM-DD` as is; the null sentinel `0001-01-01` (and blank) → null. */
export function santanderIsoDate(iso: string | null | undefined): string | null {
  const text = String(iso ?? "").trim();
  if (!text || text.startsWith("0001-01-01")) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error(`Unexpected Santander date "${iso}" (want YYYY-MM-DD)`);
  return text;
}

/** Masked PAN (`"250905#420050781"`) → the card's last 4 digits. */
export function originCardLast4FromPan(pan: string | null | undefined): string | null {
  const digits = String(pan ?? "").replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : null;
}

function blankToNull(value: string | null | undefined): string | null {
  return String(value ?? "").trim() || null;
}

/**
 * One national (CLP) row as a canonical line.
 *
 * The installment trap: `MontoCuota` is the **total purchase** and `MontoTxs` is the **monthly
 * cuota** — the reverse of what the names suggest (CK ECOMMERCE: total 1xx.xxx, cuota 3x.xxx for
 * cuota 1 of 3, matching JSON `MontoCuota` 0000100474 / `MontoTxs` 0000033491).
 */
export function nationalRowToLine(row: SantanderNationalRow): CardStatementLine {
  const code = String(row.CodTxs ?? "").trim();
  const merchant = String(row.NombreComercio ?? "").trim();
  if (!KNOWN_NATIONAL_COD_TXS.has(code)) {
    throw new Error(`unknown national CodTxs "${code}" (${merchant} ${row.MontoTxs}) — map its sign convention before importing`);
  }
  const transaction_date = santanderIsoDate(row.FechaTxs);
  if (!transaction_date) throw new Error(`National statement row has no FechaTxs (${merchant})`);
  const cuotasTotal = Number(row.TotalCuotas ?? "00");
  const isInstallment = Number.isFinite(cuotasTotal) && cuotasTotal > 0;
  const billed = parseSantanderFixed(row.MontoTxs, 0);
  const isPayment = code === NATIONAL_COD_TXS.PAYMENT;
  const isCreditNote = code === NATIONAL_COD_TXS.CREDIT_NOTE;
  if (isInstallment && (isPayment || isCreditNote)) {
    throw new Error(`National CodTxs ${code} row carries cuotas (${merchant}) — not a shape this decoder knows`);
  }
  const kind: CardStatementLine["kind"] = isPayment
    ? "payment"
    : isCreditNote
      ? "credit_note"
      : isInstallment
        ? "installment"
        : code === NATIONAL_COD_TXS.INSURANCE ||
            code === NATIONAL_COD_TXS.STAMP_TAX ||
            code === NATIONAL_COD_TXS.INTERNATIONAL_USE_FEE ||
            code === NATIONAL_COD_TXS.INTERNATIONAL_USE_FEE_VAT
          ? "charge"
          : "purchase";
  return {
    kind,
    transaction_date,
    posting_date: null, // the national feed carries only one date
    merchant,
    // Payments and notas de crédito are the known-negative codes.
    amount: isPayment || isCreditNote ? -Math.abs(billed) : billed,
    origin_amount: null,
    country: null,
    place: blankToNull(row.Ciudad),
    card_last4: originCardLast4FromPan(row.Pan),
    authorization_code: blankToNull(row.Microfilm),
    installment: isInstallment
      ? { number: Number(row.NumeroCuotas), count: cuotasTotal, cuota_amount: billed, total_amount: parseSantanderFixed(row.MontoCuota, 0) }
      : null,
    raw_text: [row.FechaTxs, row.NombreComercio, row.MontoTxs].filter(Boolean).join(" "),
  };
}

/**
 * One international (USD) row as a canonical line.
 *
 * `MontoTransaccion` is the billed USD and carries the direction in its trailing sign (an ABONO DE
 * DIVISAS is negative). `MontoOrigen` is what the merchant charged — dollars, or the pesos of a
 * merchant billing in Chile; the feed does not say which.
 */
export function internationalRowToLine(row: SantanderInternationalRow): CardStatementLine {
  const merchant = String(row.NombreComercio ?? "").trim();
  const transaction_date = santanderIsoDate(row.FechaTxs);
  if (!transaction_date) throw new Error(`International row has no FechaTxs (${merchant})`);
  const usd = parseSantanderFixed(row.MontoTransaccion, 2);
  return {
    kind: usd < 0 ? "credit" : "purchase",
    transaction_date,
    posting_date: santanderIsoDate(row.FechaProceso),
    merchant,
    amount: usd,
    origin_amount: parseSantanderFixed(row.MontoOrigen, 2),
    country: blankToNull(row.CodPais),
    place: blankToNull(row.CiudadComercio),
    card_last4: originCardLast4FromPan(row.Pan),
    authorization_code: blankToNull(row.NumeroReferencia),
    installment: null,
    raw_text: [row.FechaTxs, row.NombreComercio, row.MontoTransaccion].filter(Boolean).join(" "),
  };
}

/** The national RESPUESTA header (the international one is all nulls but the Cuenta). */
export type SantanderStatementHeader = {
  account: string;
  /** Titular plastic per the header PAN. */
  card_last4: string | null;
  close: string | null;
  pay_by: string | null;
  /** Next close (FechaProxFact) — the statement PDF's printed next-period end. */
  next_close: string | null;
  /** TotalPagos — the previous facturación's payments, integer pesos. */
  total_pagos: number | null;
  /** DeudaTotalFact — the facturado (= TotalCompras + TotalCargosAut + TotalCargos). */
  deuda_total: number | null;
};

export function nationalHeader(respuesta: Record<string, unknown>): SantanderStatementHeader {
  const num = (key: string): number | null => {
    const raw = respuesta[key];
    if (raw == null || String(raw).trim() === "") return null;
    return parseSantanderFixed(String(raw), 0);
  };
  return {
    account: String(respuesta.Cuenta ?? "").trim(),
    card_last4: originCardLast4FromPan(String(respuesta.Pan ?? "")),
    close: santanderIsoDate(String(respuesta.FechaFactActual ?? "")),
    pay_by: santanderIsoDate(String(respuesta.FechaVenc ?? "")),
    next_close: santanderIsoDate(String(respuesta.FechaProxFact ?? "")),
    total_pagos: num("TotalPagos"),
    deuda_total: num("DeudaTotalFact"),
  };
}

export type ParsedSantanderStatement = {
  file: string;
  currency: "clp" | "usd";
  /** The statement number (NumExtracto) the request asked for; both currencies of a facturación share it. */
  extracto: string;
  header: SantanderStatementHeader;
  lines: CardStatementLine[];
};

/** `<Cuenta>-extracto-<NumExtracto>-estadoCuenta….json` — how the card-statements step names a staged statement. */
const STAGED_FILE_IDENTITY = /^(\d+)-extracto-(\d+)-/;

/**
 * The account and statement number a file's request asked for. A `--capture` record carries the
 * request itself (`requestBody.INPUT`); a staged file carries both in its name. A statement whose
 * request had no NumExtracto is staged as `extracto-0`, which is no identity.
 */
function statementRequestIdentity(file: string, body: Record<string, unknown>): { account: string | null; extracto: string } {
  const request = body.requestBody;
  const input =
    typeof request === "object" && request !== null ? ((request as Record<string, unknown>).INPUT as Record<string, unknown> | undefined) : undefined;
  const requested = String(input?.NumExtracto ?? "").trim();
  if (requested) {
    if (!/^\d+$/.test(requested)) throw new Error(`${path.basename(file)}: unexpected NumExtracto "${requested}" in the request`);
    return { account: String(input?.Cuenta ?? "").trim() || null, extracto: requested };
  }
  const staged = STAGED_FILE_IDENTITY.exec(path.basename(file));
  if (staged && staged[2] !== "0") return { account: staged[1]!, extracto: staged[2]! };
  throw new Error(
    `${path.basename(file)}: no statement number — neither requestBody.INPUT.NumExtracto (a --capture ` +
      `record) nor a staged "<Cuenta>-extracto-<NumExtracto>-" name. A facturación's two currencies ` +
      `pair on it; the international file carries no close of its own to pair on instead.`
  );
}

/**
 * Parse one fetched statement body, national or international. Null when the body is not a
 * statement response (no envelope or no OUTPUT — the bank's error answer, for one). The envelope's
 * name says which currency the file holds; the row containers differ (`Matriz` vs `MATRIZDATOS`).
 */
export function parseSantanderStatementBody(file: string, body: Record<string, unknown>): ParsedSantanderStatement | null {
  // Staged files are the response body itself; a `--capture` run writes request/response records.
  const response = (body.responseBody ?? body) as Record<string, unknown>;
  const data = (response.DATA ?? response) as Record<string, unknown>;
  const [envelopeName, envelope] = Object.entries(data)[0] ?? [];
  if (!envelopeName || typeof envelope !== "object" || envelope === null) return null;
  const output = (envelope as Record<string, unknown>).OUTPUT as Record<string, unknown> | undefined;
  if (!output) return null;

  const respuesta = (output.RESPUESTA ?? {}) as Record<string, unknown>;
  const international = /Internacional/i.test(envelopeName);
  const parsedHeader = nationalHeader(respuesta);
  const header = international ? { ...parsedHeader, close: null } : parsedHeader;
  if (!header.account) {
    throw new Error(`${path.basename(file)}: the statement header carries no Cuenta — it cannot be paired or resolved`);
  }
  const identity = statementRequestIdentity(file, body);
  if (identity.account != null && identity.account !== header.account) {
    throw new Error(`${path.basename(file)}: requested for account ${identity.account}, but the statement is account ${header.account}`);
  }
  const rows = international ? output.MATRIZDATOS : output.Matriz;
  const list = Array.isArray(rows) ? rows : [];
  try {
    return {
      file: path.basename(file),
      currency: international ? "usd" : "clp",
      extracto: identity.extracto,
      header,
      lines: list.map((r) => (international ? internationalRowToLine(r as SantanderInternationalRow) : nationalRowToLine(r as SantanderNationalRow))),
    };
  } catch (err) {
    throw new Error(`${path.basename(file)}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function parseSantanderStatementFile(file: string): ParsedSantanderStatement | null {
  return parseSantanderStatementBody(file, JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>);
}

/** One facturación as fetched: the national and international statements of an (account, extracto). */
export type SantanderStatementGroup = {
  /** `${account}|${extracto}` */
  key: string;
  account: string;
  extracto: string;
  national: ParsedSantanderStatement | null;
  /** Null when no USD side was fetched; with no `national` the group is undatable. */
  international: ParsedSantanderStatement | null;
  /** The national close (ISO), which dates the international twin too. */
  close: string | null;
  /** Every file behind the group, identical copies included — what archiving moves. */
  files: string[];
};

export type SantanderStatementBatch = {
  /** One group per (account, extracto), by account, then extracto (oldest first). */
  groups: SantanderStatementGroup[];
  /** Identical copies of a statement already in the batch (a retried fetch in a capture dir). */
  duplicates: { file: string; copy_of: string }[];
};

function collapseStatementCopies(
  copies: readonly ParsedSantanderStatement[],
  duplicates: SantanderStatementBatch["duplicates"]
): ParsedSantanderStatement | null {
  const [first, ...rest] = copies;
  if (!first) return null;
  const content = (s: ParsedSantanderStatement) => JSON.stringify({ header: s.header, lines: s.lines });
  for (const copy of rest) {
    if (copy.header.close !== first.header.close) {
      throw new Error(
        `Two national closes for account ${first.header.account} extracto ${first.extracto} ` +
          `(${first.header.close} in ${first.file} vs ${copy.header.close} in ${copy.file}) — the international twin cannot be dated`
      );
    }
    if (content(copy) !== content(first)) {
      throw new Error(
        `Two different ${first.currency} statements for account ${first.header.account} extracto ${first.extracto} ` +
          `(${first.file}, ${copy.file}) — refusing to pick one`
      );
    }
    duplicates.push({ file: copy.file, copy_of: first.file });
  }
  return first;
}

/**
 * Pair a batch of parsed statements into facturaciones by (account, extracto).
 *
 * The international response has no dates, so it is dated from the national statement of the SAME
 * extracto — never from whatever national the account happens to have in the batch: the staging dir
 * keeps every facturación until it is archived, and a dormant card's international endpoint serves
 * an older extracto than its national one (USD 100 beside CLP 105 on the retired card). An
 * international without its twin comes back as a group with no `national`. Throws only when a
 * pairing is ambiguous: two different copies of one statement, or two extractos claiming one close.
 */
export function assembleSantanderStatementBatch(statements: readonly ParsedSantanderStatement[]): SantanderStatementBatch {
  type Entry = { account: string; extracto: string; clp: ParsedSantanderStatement[]; usd: ParsedSantanderStatement[] };
  const byKey = new Map<string, Entry>();
  for (const statement of statements) {
    const key = `${statement.header.account}|${statement.extracto}`;
    const entry = byKey.get(key) ?? { account: statement.header.account, extracto: statement.extracto, clp: [], usd: [] };
    entry[statement.currency].push(statement);
    byKey.set(key, entry);
  }
  const duplicates: SantanderStatementBatch["duplicates"] = [];
  const groups: SantanderStatementGroup[] = [];
  for (const [key, entry] of byKey) {
    const national = collapseStatementCopies(entry.clp, duplicates);
    groups.push({
      key,
      account: entry.account,
      extracto: entry.extracto,
      national,
      international: collapseStatementCopies(entry.usd, duplicates),
      close: national?.header.close ?? null,
      files: [...entry.clp, ...entry.usd].map((s) => s.file).sort(),
    });
  }
  groups.sort((a, b) => (a.account !== b.account ? (a.account < b.account ? -1 : 1) : Number(a.extracto) - Number(b.extracto)));

  // The server writes per (account, close): two statement numbers for one close would write the
  // same facturación twice, each copy overwriting the other.
  const extractoByClose = new Map<string, string>();
  for (const group of groups) {
    if (!group.close) continue;
    const closeKey = `${group.account}|${group.close}`;
    const other = extractoByClose.get(closeKey);
    if (other != null) {
      throw new Error(`Account ${group.account}: extractos ${other} and ${group.extracto} both close ${group.close} — which one is the facturación is ambiguous`);
    }
    extractoByClose.set(closeKey, group.extracto);
  }
  return { groups, duplicates };
}

/** One facturación as the payload the server takes; null for an international with no national twin. */
export function statementGroupPayload(group: SantanderStatementGroup, apply: boolean): CardStatementPayload | null {
  const national = group.national;
  if (!national || !national.header.close) return null;
  const statements = [national, group.international]
    .filter((s): s is ParsedSantanderStatement => s != null)
    .map((s) => ({
      currency: s.currency,
      document: s.file,
      // The international header carries no figures.
      billed_total: s.currency === "clp" ? s.header.deuda_total : null,
      payments_total: s.currency === "clp" ? s.header.total_pagos : null,
      lines: s.lines,
    }));
  return cardStatementKind.payload.parse({
    account: { issuer: "santander", number: group.account },
    statement_number: group.extracto,
    close: national.header.close,
    pay_by: national.header.pay_by,
    next_close: national.header.next_close,
    titular_last4: national.header.card_last4,
    apply,
    statements,
  });
}

export type SantanderStatementGroupOutcomes = Partial<Record<"clp" | "usd", CardStatementOutcome>>;

/**
 * Which superseded facturaciones can leave the staging dir.
 *
 * A group is superseded when a newer extracto of its account is in the batch — the newest one is
 * what the card-statements step re-fetches (and overwrites) every night, so it always stays. A
 * superseded group is archived only when every statement it holds is verified (`clean` or
 * `written`) or `empty`, and at least one is verified; anything else — a dirty diff, an unwritten
 * candidate, an outcome never recorded — keeps it in place. An international-only group is never
 * archived: it cannot be dated, so it is never verified.
 */
export function selectSantanderStatementGroupsToArchive(
  groups: readonly SantanderStatementGroup[],
  outcomes: ReadonlyMap<string, SantanderStatementGroupOutcomes>
): { archive: SantanderStatementGroup[]; keep: SantanderStatementGroup[] } {
  const newestByAccount = new Map<string, number>();
  for (const group of groups) newestByAccount.set(group.account, Math.max(newestByAccount.get(group.account) ?? -1, Number(group.extracto)));
  const archive: SantanderStatementGroup[] = [];
  const keep: SantanderStatementGroup[] = [];
  for (const group of groups) {
    if (Number(group.extracto) === newestByAccount.get(group.account) || !group.national) continue;
    const recorded = outcomes.get(group.key) ?? {};
    const statuses = group.international ? [recorded.clp, recorded.usd] : [recorded.clp];
    const verified = (s: CardStatementOutcome | undefined) => s === "clean" || s === "written";
    const archivable = statuses.every((s) => verified(s) || s === "empty") && statuses.some(verified);
    (archivable ? archive : keep).push(group);
  }
  return { archive, keep };
}

/** Every staged statement file, oldest first. Top level only: `archive/` is never re-read. */
export function listSantanderStatementFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => /estadoCuenta(Nacional|Internacional)\.json$/i.test(name) || /^\d+-extracto-/.test(name))
    .sort()
    .map((name) => path.join(dir, name));
}
