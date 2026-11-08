/**
 * The one spelling of every expense purchase key (`purchase_key` in the assignment tables:
 * categories, «Único» rows, notes, big groups, deposit links, real-estate links). Every key is
 * built with {@link buildExpenseKey} and read with {@link parseExpenseKey}; nothing else tests a
 * key's prefix or slices it. Leaf module: no imports, so any reader can use it without a cycle.
 *
 * Families, newest identity first:
 * - `installment-h:<account>:<purchase day>:<cuotas>[:<total pesos>]:<merchant key>` — a card plan by
 *   its identity; the total disambiguates same-identity plans and is absent when the ledger has none.
 * - `installment-pr:<parser row>` — a cuota line whose plan identity is unknown.
 * - `line-pr:<parser row>` — a one-shot card line.
 * - `line-fallback:<account>:<merchant key>:<purchase day or empty>` — a card line with no parser row.
 * - `line-fallback:missing:<line id>` — a line id that no longer exists (never matches a line).
 * - `checking-cartola:<account>:<period>:<day>:<pesos>:<cartola index>[:deposit]` — a cartola row.
 * - `checking-mv:<movement>[:deposit]` — any other checking movement (daily listing, mail-built rows).
 * - `synthetic-checking-gap-mirror:<mirror id>` — the line a checking gap mirror renders as.
 * - `manual:<expense entry id>`, `payslip:<payslip line id>`.
 * - `installment:<plan id>`, `line:<line id>` — retired forms; still parsed so movers can recognise them.
 * - `<any key>#split:<seq>` — a piece of a line.
 */

export type CheckingPortion = "gastos" | "deposit";

export type ExpenseKey =
  | {
      kind: "installment_h";
      accountId: number;
      purchaseIso: string;
      cuotasTotal: number;
      /** Rounded plan total in pesos; null on the identity-only form. */
      totalClp: number | null;
      merchantKey: string;
    }
  | { kind: "installment_pr"; parserRowId: string }
  | { kind: "installment"; purchaseId: number }
  | { kind: "line_pr"; parserRowId: string }
  | { kind: "line"; lineId: number }
  | { kind: "line_fallback"; accountId: number; merchantKey: string; purchaseIso: string }
  | { kind: "line_fallback_missing"; lineId: number }
  | {
      kind: "checking_cartola";
      accountId: number;
      periodMonth: string;
      occurredOn: string;
      amountClp: string;
      cartolaIndex: number;
      portion: CheckingPortion;
    }
  | { kind: "checking_mv"; movementId: number; portion: CheckingPortion }
  | { kind: "gap_mirror"; mirrorId: number }
  | { kind: "manual"; entryId: number }
  | { kind: "payslip"; lineId: number }
  | { kind: "split"; base: ExpenseKey; seq: number };

export type ExpenseKeyKind = ExpenseKey["kind"];

/**
 * Each family's leading text, for SQL that must filter stored keys by family (`substr(purchase_key,
 * 1, length(prefix)) = prefix`). Code outside SQL parses with {@link parseExpenseKey}.
 */
export const EXPENSE_KEY_PREFIXES = {
  installment_h: "installment-h:",
  installment_pr: "installment-pr:",
  installment: "installment:",
  line_pr: "line-pr:",
  line: "line:",
  line_fallback: "line-fallback:",
  checking_cartola: "checking-cartola:",
  checking_mv: "checking-mv:",
  gap_mirror: "synthetic-checking-gap-mirror:",
  manual: "manual:",
  payslip: "payslip:",
} as const;

const PREFIX = EXPENSE_KEY_PREFIXES;

const SPLIT_MARK = "#split:";
const DEPOSIT_SUFFIX = ":deposit";
const MISSING_SEGMENT = "missing:";

function depositSuffix(portion: CheckingPortion): string {
  return portion === "deposit" ? DEPOSIT_SUFFIX : "";
}

function positiveInt(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

export function buildExpenseKey(key: ExpenseKey): string {
  switch (key.kind) {
    case "installment_h": {
      const total = key.totalClp == null ? "" : `${key.totalClp}:`;
      return `${PREFIX.installment_h}${key.accountId}:${key.purchaseIso}:${key.cuotasTotal}:${total}${key.merchantKey}`;
    }
    case "installment_pr":
      return `${PREFIX.installment_pr}${key.parserRowId}`;
    case "installment":
      return `${PREFIX.installment}${key.purchaseId}`;
    case "line_pr":
      return `${PREFIX.line_pr}${key.parserRowId}`;
    case "line":
      return `${PREFIX.line}${key.lineId}`;
    case "line_fallback":
      return `${PREFIX.line_fallback}${key.accountId}:${key.merchantKey}:${key.purchaseIso}`;
    case "line_fallback_missing":
      return `${PREFIX.line_fallback}${MISSING_SEGMENT}${key.lineId}`;
    case "checking_cartola":
      return (
        `${PREFIX.checking_cartola}${key.accountId}:${key.periodMonth}:${key.occurredOn}:` +
        `${key.amountClp}:${key.cartolaIndex}${depositSuffix(key.portion)}`
      );
    case "checking_mv":
      return `${PREFIX.checking_mv}${key.movementId}${depositSuffix(key.portion)}`;
    case "gap_mirror":
      return `${PREFIX.gap_mirror}${key.mirrorId}`;
    case "manual":
      return `${PREFIX.manual}${key.entryId}`;
    case "payslip":
      return `${PREFIX.payslip}${key.lineId}`;
    case "split":
      if (key.base.kind === "split") throw new Error("a piece key cannot split a piece");
      return `${buildExpenseKey(key.base)}${SPLIT_MARK}${key.seq}`;
  }
}

/** The key a piece of `base` carries (`<base>#split:<seq>`). */
export function expensePieceKey(base: string, seq: number): string {
  return `${base}${expensePieceKeySuffix(seq)}`;
}

/** The suffix a piece appends to its line's key. */
export function expensePieceKeySuffix(seq: number): string {
  return `${SPLIT_MARK}${seq}`;
}

function parseInstallmentH(rest: string): ExpenseKey | null {
  const parts = rest.split(":");
  if (parts.length < 4) return null;
  const accountId = positiveInt(parts[0]!);
  const purchaseIso = parts[1] ?? "";
  const cuotasTotal = positiveInt(parts[2]!);
  const hasTotal = parts.length >= 5 && /^\d+$/.test(parts[3] ?? "");
  const totalClp = hasTotal ? Number(parts[3]) : null;
  const merchantKey = (hasTotal ? parts.slice(4) : parts.slice(3)).join(":");
  if (accountId == null || !purchaseIso || cuotasTotal == null || !merchantKey) return null;
  return { kind: "installment_h", accountId, purchaseIso, cuotasTotal, totalClp, merchantKey };
}

function parseLineFallback(rest: string): ExpenseKey | null {
  if (rest.startsWith(MISSING_SEGMENT)) {
    const lineId = positiveInt(rest.slice(MISSING_SEGMENT.length));
    return lineId == null ? null : { kind: "line_fallback_missing", lineId };
  }
  const first = rest.indexOf(":");
  const last = rest.lastIndexOf(":");
  if (first < 0 || last === first) return null;
  const accountId = positiveInt(rest.slice(0, first));
  const purchaseIso = rest.slice(last + 1);
  if (accountId == null || (purchaseIso !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(purchaseIso))) return null;
  return { kind: "line_fallback", accountId, merchantKey: rest.slice(first + 1, last), purchaseIso };
}

function splitPortion(rest: string): { body: string; portion: CheckingPortion } {
  return rest.endsWith(DEPOSIT_SUFFIX)
    ? { body: rest.slice(0, -DEPOSIT_SUFFIX.length), portion: "deposit" }
    : { body: rest, portion: "gastos" };
}

function parseCheckingCartola(rest: string): ExpenseKey | null {
  const { body, portion } = splitPortion(rest);
  const m = /^(\d+):([^:]+):(\d{4}-\d{2}-\d{2}):(-?\d+(?:\.\d+)?):(\d+)$/.exec(body);
  if (!m) return null;
  return {
    kind: "checking_cartola",
    accountId: Number(m[1]),
    periodMonth: m[2]!,
    occurredOn: m[3]!,
    amountClp: m[4]!,
    cartolaIndex: Number(m[5]),
    portion,
  };
}

function parseIdKey<K extends "installment" | "line" | "gap_mirror" | "manual" | "payslip">(
  kind: K,
  rest: string
): ExpenseKey | null {
  const id = positiveInt(rest);
  if (id == null) return null;
  switch (kind) {
    case "installment":
      return { kind, purchaseId: id };
    case "line":
      return { kind, lineId: id };
    case "gap_mirror":
      return { kind, mirrorId: id };
    case "manual":
      return { kind, entryId: id };
    case "payslip":
      return { kind, lineId: id };
  }
  return null;
}

function parseBaseExpenseKey(text: string): ExpenseKey | null {
  // Longer prefixes first: `installment-h:` and `installment-pr:` both start with `installment`.
  if (text.startsWith(PREFIX.installment_h)) return parseInstallmentH(text.slice(PREFIX.installment_h.length));
  if (text.startsWith(PREFIX.installment_pr)) {
    const parserRowId = text.slice(PREFIX.installment_pr.length);
    return parserRowId ? { kind: "installment_pr", parserRowId } : null;
  }
  if (text.startsWith(PREFIX.installment)) return parseIdKey("installment", text.slice(PREFIX.installment.length));
  if (text.startsWith(PREFIX.line_pr)) {
    const parserRowId = text.slice(PREFIX.line_pr.length);
    return parserRowId ? { kind: "line_pr", parserRowId } : null;
  }
  if (text.startsWith(PREFIX.line_fallback)) return parseLineFallback(text.slice(PREFIX.line_fallback.length));
  if (text.startsWith(PREFIX.line)) return parseIdKey("line", text.slice(PREFIX.line.length));
  if (text.startsWith(PREFIX.checking_cartola)) return parseCheckingCartola(text.slice(PREFIX.checking_cartola.length));
  if (text.startsWith(PREFIX.checking_mv)) {
    const { body, portion } = splitPortion(text.slice(PREFIX.checking_mv.length));
    const movementId = positiveInt(body);
    return movementId == null ? null : { kind: "checking_mv", movementId, portion };
  }
  if (text.startsWith(PREFIX.gap_mirror)) return parseIdKey("gap_mirror", text.slice(PREFIX.gap_mirror.length));
  if (text.startsWith(PREFIX.manual)) return parseIdKey("manual", text.slice(PREFIX.manual.length));
  if (text.startsWith(PREFIX.payslip)) return parseIdKey("payslip", text.slice(PREFIX.payslip.length));
  return null;
}

/**
 * Reads a stored or built key. Null when the text is not a key of any family (or malformed);
 * `buildExpenseKey(parseExpenseKey(k)!) === k` for every key this module builds.
 */
export function parseExpenseKey(text: string): ExpenseKey | null {
  const splitAt = text.lastIndexOf(SPLIT_MARK);
  if (splitAt >= 0) {
    const seq = positiveInt(text.slice(splitAt + SPLIT_MARK.length));
    const base = parseBaseExpenseKey(text.slice(0, splitAt));
    return seq == null || base == null ? null : { kind: "split", base, seq };
  }
  return parseBaseExpenseKey(text);
}

/** {@link parseExpenseKey}, throwing on text that is not a key. */
export function requireExpenseKey(text: string): ExpenseKey {
  const key = parseExpenseKey(text);
  if (key == null) throw new Error(`not an expense purchase key: «${text}»`);
  return key;
}

/** The key's family, or null when the text is not a key. */
export function expenseKeyKind(text: string): ExpenseKeyKind | null {
  return parseExpenseKey(text)?.kind ?? null;
}

/** A plan's key family (identity, cuota line, retired plan id). */
export function isInstallmentContractKind(kind: ExpenseKeyKind | null): boolean {
  return kind === "installment_h" || kind === "installment_pr" || kind === "installment";
}

/** The plan-identity key without its total; null unless `text` is an `installment-h:` key carrying one. */
export function installmentHKeyWithoutTotal(text: string): string | null {
  const key = parseExpenseKey(text);
  if (key?.kind !== "installment_h" || key.totalClp == null) return null;
  return buildExpenseKey({ ...key, totalClp: null });
}

/**
 * Natural receipt identity, `<chain>|<receipt_number>|<YYYY-MM-DD>` — the formula
 * migration 178 backfilled (`groceryReceiptKey178.ts` keeps its own frozen copy).
 */
export function groceryReceiptKey(chain: string, receiptNumber: string, purchasedAt: string): string {
  const day = purchasedAt.slice(0, 10);
  if (!chain || !receiptNumber || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new Error(
      `grocery receipt key needs chain, receipt number and a 'YYYY-MM-DD …' purchase datetime, got ${JSON.stringify({ chain, receiptNumber, purchasedAt })}`
    );
  }
  return `${chain}|${receiptNumber}|${day}`;
}
