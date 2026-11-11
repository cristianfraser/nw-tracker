/**
 * MetLife Hipotecario's «Centro de pago» as its own API states it, turned into a
 * `mortgage.lender_statement` payload. The portal page asks `latam.apis.metlife.com` for three
 * answers, and the reader takes them as the page received them (it never calls the API itself):
 *
 *   - `…/tenants/api/credits?poliza=<credit>` → `creditInformation`: the balance and original
 *     debt in UF, the cuota count, the last cuota paid (number, ISO day, pesos);
 *   - `…/tenants/api/payments/pending?mortgage=true…` → `item[0]`: the credit (`idProduct`) and
 *     the cuota(s) it asks for now (`availablePayments`: period YYYYMM, ISO due day, fee, minimum
 *     and maximum in pesos and UF, amortization / interest / charges in pesos);
 *   - `…/tenants/api/payments/history` (POST) → `items`: the cuotas of the last months, days as
 *     dd-mm-yyyy, status PAGADO / PENDIENTE / VENCIDO, the parts in pesos and the insurance in UF
 *     and pesos.
 *
 * Every field is checked as it is read: a missing or mistyped one, an unknown status, a date that
 * is not a day, a second credit, or a history that does not hold every row it counts throws — the
 * reader never guesses. The contract (`mortgageLenderStatementKind`) then checks the sums.
 */
import { mortgageLenderStatementKind, parseDdMmYyToIso, type MortgageLenderStatementPayload } from "nw-tracker-contracts";

export type MetlifeApiName = "credits" | "pending" | "history";

/** One answer of the portal's API as recorded (the capture Recorder's file shape). */
export type MetlifeApiCall = {
  url: string;
  status: number;
  requestBody: unknown;
  responseBody: unknown;
  receivedAt: string;
};

export const METLIFE_API_HOST = "latam.apis.metlife.com";

/** Which of the three answers a URL is, or null for any other call. */
export function metlifeApiName(url: string): MetlifeApiName | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.hostname !== METLIFE_API_HOST) return null;
  if (/\/tenants\/api\/credits$/.test(u.pathname)) return "credits";
  if (/\/tenants\/api\/payments\/pending$/.test(u.pathname) && u.searchParams.get("mortgage") === "true") return "pending";
  if (/\/tenants\/api\/payments\/history$/.test(u.pathname)) return "history";
  return null;
}

type Obj = Record<string, unknown>;

function obj(v: unknown, where: string): Obj {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error(`MetLife ${where}: expected an object`);
  return v as Obj;
}

function arr(v: unknown, where: string): unknown[] {
  if (!Array.isArray(v)) throw new Error(`MetLife ${where}: expected a list`);
  return v;
}

function num(o: Obj, key: string, where: string): number {
  const v = o[key];
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`MetLife ${where}.${key}: expected a number, got ${v === undefined ? "nothing" : JSON.stringify(v)}`);
  return v;
}

function numOrNull(o: Obj, key: string, where: string): number | null {
  if (o[key] === null) return null;
  return num(o, key, where);
}

function str(o: Obj, key: string, where: string): string {
  const v = o[key];
  if (typeof v !== "string" || v.trim() === "") throw new Error(`MetLife ${where}.${key}: expected text, got ${v === undefined ? "nothing" : JSON.stringify(v)}`);
  return v.trim();
}

function realDay(iso: string): boolean {
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso;
}

/** An ISO day as the API prints it (YYYY-MM-DD). */
function isoDay(o: Obj, key: string, where: string): string {
  const v = str(o, key, where);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || !realDay(v)) throw new Error(`MetLife ${where}.${key}: expected YYYY-MM-DD, got ${JSON.stringify(v)}`);
  return v;
}

/** A dd-mm-yyyy day (the history's format) as ISO. */
function ddMmYyyyDay(o: Obj, key: string, where: string): string {
  const v = str(o, key, where);
  const iso = /^\d{2}-\d{2}-\d{4}$/.test(v) ? parseDdMmYyToIso(v.replace(/-/g, "/")) : null;
  if (iso == null || !realDay(iso)) throw new Error(`MetLife ${where}.${key}: expected dd-mm-yyyy, got ${JSON.stringify(v)}`);
  return iso;
}

const HISTORY_STATUS = { PAGADO: "paid", PENDIENTE: "pending", VENCIDO: "overdue" } as const;
/** The only cuota status `availablePayments` has been seen to print («por vencer», not yet due). */
const PENDING_STATUSES = new Set(["por vencer"]);

function body(call: MetlifeApiCall, name: MetlifeApiName): Obj {
  if (call.status !== 200) throw new Error(`MetLife ${name}: the portal's API answered ${call.status}`);
  return obj(call.responseBody, `${name} answer`);
}

/** The payload a reading sends, checked against the contract. */
export function metlifeStatementPayload(calls: Record<MetlifeApiName, MetlifeApiCall>, readAt: string): MortgageLenderStatementPayload {
  const c = obj(body(calls.credits, "credits").creditInformation, "credits.creditInformation");
  const items = arr(body(calls.pending, "pending").item, "pending.item");
  if (items.length !== 1) throw new Error(`MetLife pending: expected one credit, the portal lists ${items.length}`);
  const product = obj(items[0], "pending.item[0]");
  const creditNumber = str(product, "idProduct", "pending.item[0]");

  // The three answers must be about the same credit.
  const poliza = new URL(calls.credits.url).searchParams.get("poliza");
  if (poliza != null && poliza !== creditNumber) throw new Error("MetLife: the credits answer is about another credit than the pending one");
  const historyRequest = calls.history.requestBody;
  if (historyRequest != null && typeof historyRequest === "object") {
    const products = (historyRequest as Obj).products;
    if (products !== undefined && !(Array.isArray(products) && products.length === 1 && products[0] === creditNumber)) {
      throw new Error("MetLife: the history answer was asked for another credit than the pending one");
    }
  }

  const pending = arr(product.availablePayments, "pending.item[0].availablePayments").map((raw, i) => {
    const where = `pending.availablePayments[${i}]`;
    const a = obj(raw, where);
    const status = str(a, "status", where);
    if (!PENDING_STATUSES.has(status.toLowerCase())) throw new Error(`MetLife ${where}.status: unknown status ${JSON.stringify(status)}`);
    const parts = obj(a.mortgageInformation, `${where}.mortgageInformation`);
    return {
      cuota: num(a, "mortgageNumber", where),
      period: str(a, "period", where),
      due_on: isoDay(a, "dueDate", where),
      fee_uf: num(a, "feeUf", where),
      fee_pesos: num(a, "feePesos", where),
      min_uf: num(a, "minimunFeeUf", where),
      min_pesos: num(a, "minimunFeePesos", where),
      max_uf: num(a, "maximumFeeUf", where),
      max_pesos: num(a, "maximumFeePesos", where),
      amortization_pesos: num(parts, "amortization", `${where}.mortgageInformation`),
      interest_pesos: num(parts, "paidInterest", `${where}.mortgageInformation`),
      default_interest_pesos: num(parts, "defaultInterest", `${where}.mortgageInformation`),
      collection_fee_pesos: num(parts, "collectionFee", `${where}.mortgageInformation`),
    };
  });

  const historyBody = body(calls.history, "history");
  const rows = arr(historyBody.items, "history.items");
  if (historyBody.metadata != null) {
    const total = obj(historyBody.metadata, "history.metadata").totalCount;
    if (typeof total === "number" && total !== rows.length) throw new Error(`MetLife history: the answer holds ${rows.length} of ${total} cuotas (paged)`);
  }
  const history = rows.map((raw, i) => {
    const where = `history.items[${i}]`;
    const h = obj(raw, where);
    const printed = str(h, "status", where);
    const status = HISTORY_STATUS[printed.toUpperCase() as keyof typeof HISTORY_STATUS];
    if (!status) throw new Error(`MetLife ${where}.status: unknown status ${JSON.stringify(printed)}`);
    const ins = obj(h.insurances, `${where}.insurances`);
    const iw = `${where}.insurances`;
    return {
      cuota: num(h, "mortgageNumber", where),
      due_on: ddMmYyyyDay(h, "dueDate", where),
      status,
      paid_on: h.paymentDate === null ? null : ddMmYyyyDay(h, "paymentDate", where),
      amortization_pesos: numOrNull(h, "amortizationPesos", where),
      extra_amortization_pesos: numOrNull(h, "extAmortizationPesos", where),
      interest_pesos: numOrNull(h, "interestPesos", where),
      default_interest_pesos: numOrNull(h, "faultInterestPesos", where),
      collection_fee_pesos: numOrNull(h, "collectionExpenses", where),
      total_pesos: numOrNull(h, "totalMortgageAmmountPesos", where),
      insurance: {
        fire_uf: numOrNull(ins, "fireInsuranceUf", iw),
        life_uf: numOrNull(ins, "lifeInsuranceUf", iw),
        other_uf: numOrNull(ins, "otherInsuranceUf", iw),
        fire_pesos: numOrNull(ins, "fireInsurancePesos", iw),
        life_pesos: numOrNull(ins, "lifeInsurancePesos", iw),
        other_pesos: numOrNull(ins, "otherInsurancePesos", iw),
      },
    };
  });

  const payload = {
    lender: "metlife",
    credit_number: creditNumber,
    read_at: readAt,
    credit: {
      balance_uf: num(c, "outstandingBalanceUf", "credits"),
      original_debt_uf: numOrNull(c, "originalDebtUf", "credits"),
      total_cuotas: numOrNull(c, "totalMortgageNumber", "credits"),
      last_paid_cuota: numOrNull(c, "lastPaidMortgageNumber", "credits"),
      last_paid_on: c.lastPaymentDate === null ? null : isoDay(c, "lastPaymentDate", "credits"),
      last_paid_pesos: numOrNull(c, "lastPaidMortgageValuePesos", "credits"),
    },
    pending,
    history,
  };
  const checked = mortgageLenderStatementKind.payload.safeParse(payload);
  if (!checked.success) {
    throw new Error(`MetLife: the portal's answers do not make a lender statement — ${checked.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return checked.data;
}

/** The reading's moment: the latest of the three answers. */
export function metlifeReadAt(calls: Record<MetlifeApiName, MetlifeApiCall>): string {
  const times = Object.values(calls).map((c) => {
    const t = Date.parse(c.receivedAt);
    if (Number.isNaN(t)) throw new Error(`MetLife: a recorded answer has no receivedAt time`);
    return t;
  });
  return new Date(Math.max(...times)).toISOString();
}
