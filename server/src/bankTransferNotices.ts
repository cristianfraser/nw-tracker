/**
 * Transfer notices the bank mailed (`bank_account.transfer_notices`) and the bank movements they
 * describe. A notice states who a transfer went to or came from — name, RUT, bank, account,
 * e-mail, comment — which no cartola prints, so pairing it with its bank row lets the expenses
 * and income pages say who each transfer was with.
 *
 * Pairing (`matchTransferNotices`, pure): a notice pairs with a bank row on the account it names,
 * of its amount (signed by direction), posted from the mail's day up to `WINDOW_DAYS` later. A
 * transfer between two of the client's tracked accounts pairs with that transfer (both sides) or
 * with a row on each side; a transfer to or from anyone else never pairs with a transfer between
 * two tracked checking accounts. Notices are paired in the order they were sent, each bank row at
 * most once: a second mail about the same transfer (the recipient's notice of a transfer between
 * own accounts, the notice that a scheduled transfer was set up) finds nothing left to pair with.
 * Among rows on the same day the matcher prefers, in order: a transfer to or from the account the
 * counterparty is (`transfer_counterparty_accounts`, by RUT or account number), a single-leg row,
 * a transfer to some other account. Rows left tied that differ only by id are twins and pair in
 * order; any other tie is left unpaired and reported.
 */
import { createHash } from "node:crypto";
import type { BankAccountTransferNoticesApplyDetails, BankAccountTransferNoticesPayload, TransferNotice } from "nw-tracker-contracts";
import { clearCheckingBalanceCache } from "./checkingCartolaBalances.js";
import { chileCalendarAddDays, chileCalendarTodayYmd } from "./chileDate.js";
import { db } from "./db.js";
import { listOverdueTransferNoticeCredits } from "./transferNoticeCredits.js";

const WINDOW_DAYS = 6;

/** One account side of a bank movement on a tracked checking account. */
export type TransferCandidateLeg = {
  movement_id: number;
  account_id: number;
  /** The transfer's other account; null for a single-leg row. */
  other_account_id: number | null;
  /** The day the bank filed it on this account. */
  day: string;
  /** Signed for this account: + money in, − money out. */
  amount: number;
};

export type TransferNoticePair = { message_id: string; movement_id: number; account_id: number };

/** Which app accounts a counterparty is: by RUT (digits + check digit) or by account number (digits). */
export type CounterpartyAccounts = { byRut: ReadonlyMap<string, ReadonlySet<number>>; byNumber: ReadonlyMap<string, ReadonlySet<number>> };

export const normalizeRut = (rut: string | null) => (rut ?? "").replace(/[^0-9kK]/g, "").toUpperCase().replace(/^0+/, "");

/** Why a notice paired with nothing (the keys of `unpaired`). */
export const NO_BANK_ROW_YET = "no bank row (yet)";

export type TransferNoticeMatch = {
  pairs: TransferNoticePair[];
  unpaired: Record<string, number>;
  /** Every unpaired notice with its reason. */
  unpaired_notices: { message_id: string; reason: string }[];
  ambiguous: string[];
};

const digits = (s: string | null) => (s ?? "").replace(/\D/g, "").replace(/^0+/, "");

function addDays(ymd: string, n: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function matchTransferNotices(
  notices: readonly TransferNotice[],
  /** Bank account number (digits, no leading zeros) → tracked account id. */
  trackedAccounts: ReadonlyMap<string, number>,
  legs: readonly TransferCandidateLeg[],
  counterparties: CounterpartyAccounts = { byRut: new Map(), byNumber: new Map() }
): TransferNoticeMatch {
  const tracked = new Set(trackedAccounts.values());
  const claimed = new Set<string>();
  const legKey = (l: TransferCandidateLeg) => `${l.movement_id}|${l.account_id}`;
  const byAccountAmount = new Map<string, TransferCandidateLeg[]>();
  const firstDay = new Map<number, string>();
  for (const l of legs) {
    const k = `${l.account_id}|${Math.round(l.amount)}`;
    (byAccountAmount.get(k) ?? byAccountAmount.set(k, []).get(k)!).push(l);
    if (!firstDay.has(l.account_id) || l.day < firstDay.get(l.account_id)!) firstDay.set(l.account_id, l.day);
  }
  const pairs: TransferNoticePair[] = [];
  const unpaired: Record<string, number> = {};
  const unpaired_notices: { message_id: string; reason: string }[] = [];
  const ambiguous: string[] = [];
  let current = "";
  const skip = (reason: string) => {
    unpaired[reason] = (unpaired[reason] ?? 0) + 1;
    unpaired_notices.push({ message_id: current, reason });
  };

  /** The leg a notice describes on `account`, or a reason it has none. */
  function find(
    n: TransferNotice,
    account: number,
    amount: number,
    otherOk: (other: number | null) => boolean,
    counterparty: ReadonlySet<number>
  ): TransferCandidateLeg | "none" | "ambiguous" {
    const day = n.sent_at_chile.slice(0, 10);
    const candidates = (byAccountAmount.get(`${account}|${amount}`) ?? [])
      .filter((l) => !claimed.has(legKey(l)) && l.day >= day && l.day <= addDays(day, WINDOW_DAYS) && otherOk(l.other_account_id))
      .sort((a, b) => a.day.localeCompare(b.day) || a.movement_id - b.movement_id);
    if (candidates.length === 0) return "none";
    const rank = (l: TransferCandidateLeg) =>
      l.other_account_id != null && counterparty.has(l.other_account_id) ? 2 : l.other_account_id == null ? 1 : 0;
    const sameDay = candidates.filter((l) => l.day === candidates[0]!.day);
    const best = Math.max(...sameDay.map(rank));
    const tied = sameDay.filter((l) => rank(l) === best);
    const twins = tied.every((l) => l.other_account_id === tied[0]!.other_account_id);
    if (!twins) {
      ambiguous.push(`${n.sent_at_chile} ${n.kind} ${amount} on account ${account}: movements ${tied.map((l) => l.movement_id).join(", ")}`);
      return "ambiguous";
    }
    return tied[0]!;
  }

  const accountsOf = (p: TransferNotice["to"]): ReadonlySet<number> => {
    const out = new Set<number>();
    for (const a of counterparties.byRut.get(normalizeRut(p.rut)) ?? []) out.add(a);
    for (const a of counterparties.byNumber.get(digits(p.account_number)) ?? []) out.add(a);
    return out;
  };

  const ordered = [...notices].sort((a, b) => a.sent_at_chile.localeCompare(b.sent_at_chile) || a.message_id.localeCompare(b.message_id));
  for (const n of ordered) {
    current = n.message_id;
    if (n.kind === "schedule_created") {
      skip("scheduled-transfer notice (no money moved)");
      continue;
    }
    const fromAcct = trackedAccounts.get(digits(n.from.account_number)) ?? null;
    const toAcct = trackedAccounts.get(digits(n.to.account_number)) ?? null;
    const sides: { account: number; amount: number; other: number | null }[] = [];
    if (n.kind === "incoming") {
      if (toAcct == null) {
        skip("incoming to an account the app does not track (own transfer echoes among them)");
        continue;
      }
      sides.push({ account: toAcct, amount: n.amount, other: null });
    } else {
      if (fromAcct != null) sides.push({ account: fromAcct, amount: -n.amount, other: toAcct });
      if (toAcct != null) sides.push({ account: toAcct, amount: n.amount, other: fromAcct });
      if (sides.length === 0) {
        skip("between accounts the app does not track");
        continue;
      }
    }
    // Before an account's bank history starts there is nothing to pair with.
    const lastPostingDay = addDays(n.sent_at_chile.slice(0, 10), WINDOW_DAYS);
    if (sides.every((s) => lastPostingDay < (firstDay.get(s.account) ?? "9999"))) {
      skip("before the account's bank history");
      continue;
    }
    const chosen: TransferCandidateLeg[] = [];
    let failed: "none" | "ambiguous" | null = null;
    for (const s of sides) {
      // Already claimed as the other side of a transfer chosen for this notice.
      const same = chosen.find((c) => c.other_account_id === s.account);
      if (same) {
        const twin = legs.find((l) => l.movement_id === same.movement_id && l.account_id === s.account);
        if (twin && !claimed.has(legKey(twin))) {
          chosen.push(twin);
          continue;
        }
      }
      const otherOk = (other: number | null) =>
        other == null ? true : s.other != null ? other === s.other : !tracked.has(other);
      const counterparty = accountsOf(s.amount < 0 ? n.to : n.from);
      const leg = find(n, s.account, s.amount, otherOk, counterparty);
      if (typeof leg === "string") {
        failed = leg;
        break;
      }
      chosen.push(leg);
      claimed.add(legKey(leg));
    }
    if (failed) {
      for (const c of chosen) claimed.delete(legKey(c));
      skip(failed === "ambiguous" ? "ambiguous" : NO_BANK_ROW_YET);
      continue;
    }
    for (const c of chosen) {
      claimed.add(legKey(c));
      pairs.push({ message_id: n.message_id, movement_id: c.movement_id, account_id: c.account_id });
    }
  }
  return { pairs, unpaired, unpaired_notices, ambiguous };
}

/** Every bank movement leg on the given accounts (the opening-balance anchor aside), in pesos. */
export function loadTransferCandidateLegs(accountIds: readonly number[]): TransferCandidateLeg[] {
  if (accountIds.length === 0) return [];
  const ids = accountIds.join(",");
  return db
    .prepare(
      `SELECT m.id AS movement_id, m.account_id, NULL AS other_account_id, COALESCE(p.posted_on, m.occurred_on) AS day, m.amount
       FROM movements m LEFT JOIN movement_bank_postings p ON p.movement_id = m.id AND p.account_id = m.account_id
       WHERE m.account_id IN (${ids}) AND m.currency = 'clp' AND COALESCE(m.note, '') NOT LIKE 'import:cartola|anchor|%'
       UNION ALL
       SELECT m.id, m.from_account_id, m.to_account_id, COALESCE(p.posted_on, m.occurred_on), -m.amount
       FROM movements m LEFT JOIN movement_bank_postings p ON p.movement_id = m.id AND p.account_id = m.from_account_id
       WHERE m.from_account_id IN (${ids}) AND m.currency = 'clp'
       UNION ALL
       SELECT m.id, m.to_account_id, m.from_account_id, COALESCE(p.posted_on, m.occurred_on),
              CASE WHEN m.counter_currency = 'clp' THEN m.counter_amount ELSE m.amount END
       FROM movements m LEFT JOIN movement_bank_postings p ON p.movement_id = m.id AND p.account_id = m.to_account_id
       WHERE m.to_account_id IN (${ids}) AND COALESCE(m.counter_currency, m.currency) = 'clp'`
    )
    .all() as TransferCandidateLeg[];
}

function loadCounterpartyAccounts(): CounterpartyAccounts {
  const byRut = new Map<string, Set<number>>();
  const byNumber = new Map<string, Set<number>>();
  for (const r of db.prepare(`SELECT rut, account_number, account_id FROM transfer_counterparty_accounts`).all() as {
    rut: string | null;
    account_number: string | null;
    account_id: number;
  }[]) {
    const [map, key] = r.rut != null ? [byRut, normalizeRut(r.rut)] : [byNumber, digits(r.account_number)];
    (map.get(key) ?? map.set(key, new Set()).get(key)!).add(r.account_id);
  }
  return { byRut, byNumber };
}

/**
 * Every peso account the app knows the number of, whichever bank holds it: a notice is about the
 * account it names, and the bank that mailed it need not hold that account (Banco de Chile mails
 * the recipient of its clients' transfers to a Santander account).
 */
function trackedAccounts(): Map<string, number> {
  const rows = db
    .prepare(`SELECT account_id, number FROM bank_account_numbers WHERE currency = 'clp'`)
    .all() as { account_id: number; number: string }[];
  const out = new Map<string, number>();
  for (const r of rows) {
    const key = digits(r.number);
    if (out.has(key) && out.get(key) !== r.account_id) throw new Error(`bank account number ${r.number} names two accounts`);
    out.set(key, r.account_id);
  }
  return out;
}

/** How old a mail may be and still have its credit written: past this, the bank feed decides. */
export const TRANSFER_NOTICE_CREDIT_MAX_AGE_DAYS = 3;

const MAILER_NOTE_PREFIX: Record<string, string> = {
  santander: "import:santander-mail|",
  bancochile: "import:bancochile-mail|",
};

/**
 * The note of a credit written from a mail, in the mail-rebuilt family
 * (`import:<issuer>-mail|<mail time>|<description>`, see `isMailRebuiltCheckingNote`).
 */
export function transferNoticeCreditNote(issuer: string, n: TransferNotice): string {
  const prefix = MAILER_NOTE_PREFIX[issuer];
  if (!prefix) throw new Error(`no note prefix for transfer mails from "${issuer}"`);
  const who = n.from.name ?? "?";
  const description = `Transf. de ${who}${n.comment ? ` — ${n.comment}` : ""}`.replace(/\|/g, "/");
  return `${prefix}${n.sent_at_chile}|${description}`;
}

const COLUMNS = [
  "message_id", "issuer", "sent_at_chile", "subject", "kind", "notice_date", "amount", "scheduled", "comment",
  "from_name", "from_rut", "from_bank", "from_account_type", "from_account_number", "from_email",
  "to_name", "to_rut", "to_bank", "to_account_type", "to_account_number", "to_email",
] as const;

function noticeRow(issuer: string, n: TransferNotice): Record<(typeof COLUMNS)[number], string | number | null> {
  return {
    message_id: n.message_id, issuer, sent_at_chile: n.sent_at_chile, subject: n.subject, kind: n.kind,
    notice_date: n.date, amount: n.amount, scheduled: n.scheduled ? 1 : 0, comment: n.comment,
    from_name: n.from.name, from_rut: n.from.rut, from_bank: n.from.bank, from_account_type: n.from.account_type,
    from_account_number: n.from.account_number, from_email: n.from.email,
    to_name: n.to.name, to_rut: n.to.rut, to_bank: n.to.bank, to_account_type: n.to.account_type,
    to_account_number: n.to.account_number, to_email: n.to.email,
  };
}

function rowNotice(r: Record<string, unknown>): TransferNotice {
  const party = (p: "from" | "to") => ({
    name: r[`${p}_name`] as string | null, rut: r[`${p}_rut`] as string | null, bank: r[`${p}_bank`] as string | null,
    account_type: r[`${p}_account_type`] as string | null, account_number: r[`${p}_account_number`] as string | null,
    email: r[`${p}_email`] as string | null,
  });
  return {
    message_id: String(r.message_id), sent_at_chile: String(r.sent_at_chile), subject: String(r.subject),
    kind: r.kind as TransferNotice["kind"], date: String(r.notice_date), amount: Number(r.amount),
    from: party("from"), to: party("to"), comment: r.comment as string | null, scheduled: r.scheduled === 1,
  };
}

const hash = (row: Record<string, unknown>) => createHash("sha256").update(JSON.stringify(row)).digest("hex");

/**
 * Stores the notices (a resent notice must state the same; a different one throws) and rebuilds
 * every pairing from all stored notices of the issuer, so a bank row that lands after its mail
 * pairs on the next apply.
 */
/**
 * Incoming transfers mailed in the last few days whose bank row has not arrived: their credit is
 * written from the mail, dated the day it was sent. Never twice for one mail (the record outlives
 * its movement), never for a notice the matcher found ambiguous, never for an older one.
 */
function writeCreditsFromMails(
  stored: readonly { issuer: string; notice: TransferNotice }[],
  match: TransferNoticeMatch,
  tracked: ReadonlyMap<string, number>,
  todayYmd: string
): BankAccountTransferNoticesApplyDetails["synthesized"] {
  const waiting = new Set(match.unpaired_notices.filter((u) => u.reason === NO_BANK_ROW_YET).map((u) => u.message_id));
  const oldest = chileCalendarAddDays(todayYmd, -TRANSFER_NOTICE_CREDIT_MAX_AGE_DAYS);
  const known = db.prepare(`SELECT 1 FROM transfer_notice_credits WHERE message_id = ?`);
  const insMovement = db.prepare(
    `INSERT INTO movements (account_id, amount, currency, occurred_on, note) VALUES (?, ?, 'clp', ?, ?)`
  );
  const insCredit = db.prepare(
    `INSERT INTO transfer_notice_credits (message_id, movement_id, account_id, amount, notice_date) VALUES (?, ?, ?, ?, ?)`
  );
  const out: BankAccountTransferNoticesApplyDetails["synthesized"] = [];
  for (const { issuer, notice: n } of stored) {
    if (n.kind !== "incoming" || !waiting.has(n.message_id)) continue;
    const day = n.sent_at_chile.slice(0, 10);
    if (day < oldest || day > todayYmd || known.get(n.message_id)) continue;
    const account = tracked.get(digits(n.to.account_number));
    if (account == null) continue;
    const movementId = Number(insMovement.run(account, n.amount, day, transferNoticeCreditNote(issuer, n)).lastInsertRowid);
    insCredit.run(n.message_id, movementId, account, n.amount, day);
    clearCheckingBalanceCache(account);
    out.push({ message_id: n.message_id, movement_id: movementId, account_id: account, date: day, amount: n.amount });
  }
  return out;
}

export function applyBankTransferNotices(payload: BankAccountTransferNoticesPayload): BankAccountTransferNoticesApplyDetails {
  const existing = db.prepare(`SELECT * FROM bank_transfer_notices WHERE message_id = ?`);
  const insert = db.prepare(
    `INSERT INTO bank_transfer_notices (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map((c) => `@${c}`).join(", ")})`
  );
  return db.transaction((): BankAccountTransferNoticesApplyDetails => {
    let added = 0;
    for (const n of payload.notices) {
      const row = noticeRow(payload.issuer, n);
      const old = existing.get(n.message_id) as Record<string, unknown> | undefined;
      if (old) {
        const stored = Object.fromEntries(COLUMNS.map((c) => [c, old[c] ?? null]));
        if (hash(stored) !== hash(row)) throw new Error(`transfer notice ${n.message_id} was already stored with other content`);
        continue;
      }
      insert.run(row);
      added++;
    }
    // Every mailer's notices pair together: two mails can describe one bank row.
    const tracked = trackedAccounts();
    const stored = (db.prepare(`SELECT * FROM bank_transfer_notices`).all() as Record<string, unknown>[]).map((r) => ({
      issuer: String(r.issuer),
      notice: rowNotice(r),
    }));
    const notices = stored.map((s) => s.notice);
    const counterparties = loadCounterpartyAccounts();
    const matchAll = () => matchTransferNotices(notices, tracked, loadTransferCandidateLegs([...new Set(tracked.values())]), counterparties);
    let match = matchAll();
    const today = chileCalendarTodayYmd();
    const synthesized = writeCreditsFromMails(stored, match, tracked, today);
    // The credits just written are the bank rows those notices describe.
    if (synthesized.length > 0) match = matchAll();
    db.prepare(`DELETE FROM movement_transfer_notices`).run();
    const pair = db.prepare(`INSERT INTO movement_transfer_notices (movement_id, account_id, message_id) VALUES (?, ?, ?)`);
    for (const p of match.pairs) pair.run(p.movement_id, p.account_id, p.message_id);
    return {
      received: payload.notices.length,
      new_notices: added,
      paired: new Set(match.pairs.map((p) => p.message_id)).size,
      unpaired: match.unpaired,
      ambiguous: match.ambiguous,
      synthesized,
      overdue: listOverdueTransferNoticeCredits(today),
    };
  }).immediate();
}

/** A bank movement's counterparty as its transfer mail states it (expenses and income pages). */
export type TransferCounterpartyDto = {
  /** `out`: the client paid them; `in`: they paid the client; `own`: between the client's accounts. */
  direction: "out" | "in" | "own";
  name: string | null;
  rut: string | null;
  bank: string | null;
  account_type: string | null;
  account_number: string | null;
  email: string | null;
  comment: string | null;
  /** When the mail was sent (Chile clock). */
  sent_at_chile: string;
};

/** `<movement_id>|<account_id>` → the counterparty of every bank movement side a mail describes. */
export function transferCounterpartiesByMovementSide(): Map<string, TransferCounterpartyDto> {
  const rows = db
    .prepare(
      `SELECT t.movement_id, t.account_id, n.kind, n.sent_at_chile, n.comment,
              n.from_name, n.from_rut, n.from_bank, n.from_account_type, n.from_account_number, n.from_email,
              n.to_name, n.to_rut, n.to_bank, n.to_account_type, n.to_account_number, n.to_email
       FROM movement_transfer_notices t JOIN bank_transfer_notices n USING (message_id)`
    )
    .all() as Record<string, string | number | null>[];
  const out = new Map<string, TransferCounterpartyDto>();
  for (const r of rows) {
    const incoming = r.kind === "incoming";
    const side = incoming ? "from" : "to";
    out.set(`${r.movement_id}|${r.account_id}`, {
      direction: r.kind === "between_own_products" ? "own" : incoming ? "in" : "out",
      name: r[`${side}_name`] as string | null,
      rut: r[`${side}_rut`] as string | null,
      bank: r[`${side}_bank`] as string | null,
      account_type: r[`${side}_account_type`] as string | null,
      account_number: r[`${side}_account_number`] as string | null,
      email: r[`${side}_email`] as string | null,
      comment: r.comment as string | null,
      sent_at_chile: String(r.sent_at_chile),
    });
  }
  return out;
}

/** Income-style lines (`movement_id` + `account_id`) with their counterparty attached where a mail names it. */
export function withTransferCounterparties<T extends { movement_id: number; account_id: number }>(
  lines: readonly T[],
  byMovementSide: ReadonlyMap<string, TransferCounterpartyDto> = transferCounterpartiesByMovementSide()
): (T & { transfer_counterparty?: TransferCounterpartyDto })[] {
  return lines.map((l) => {
    const counterparty = byMovementSide.get(`${l.movement_id}|${l.account_id}`);
    return counterparty ? { ...l, transfer_counterparty: counterparty } : l;
  });
}
