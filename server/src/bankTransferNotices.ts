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
import { db } from "./db.js";

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

export type TransferNoticeMatch = {
  pairs: TransferNoticePair[];
  unpaired: Record<string, number>;
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
  const ambiguous: string[] = [];
  const skip = (reason: string) => (unpaired[reason] = (unpaired[reason] ?? 0) + 1);

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
      skip(failed === "ambiguous" ? "ambiguous" : "no bank row (yet)");
      continue;
    }
    for (const c of chosen) {
      claimed.add(legKey(c));
      pairs.push({ message_id: n.message_id, movement_id: c.movement_id, account_id: c.account_id });
    }
  }
  return { pairs, unpaired, ambiguous };
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

function trackedAccountsFor(issuer: string): Map<string, number> {
  const rows = db
    .prepare(`SELECT account_id, number FROM bank_account_numbers WHERE issuer = ? AND currency = 'clp'`)
    .all(issuer) as { account_id: number; number: string }[];
  return new Map(rows.map((r) => [digits(r.number), r.account_id]));
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
    const tracked = trackedAccountsFor(payload.issuer);
    const notices = (db.prepare(`SELECT * FROM bank_transfer_notices WHERE issuer = ?`).all(payload.issuer) as Record<string, unknown>[]).map(rowNotice);
    const match = matchTransferNotices(notices, tracked, loadTransferCandidateLegs([...new Set(tracked.values())]), loadCounterpartyAccounts());
    db.prepare(
      `DELETE FROM movement_transfer_notices WHERE message_id IN (SELECT message_id FROM bank_transfer_notices WHERE issuer = ?)`
    ).run(payload.issuer);
    const pair = db.prepare(`INSERT INTO movement_transfer_notices (movement_id, account_id, message_id) VALUES (?, ?, ?)`);
    for (const p of match.pairs) pair.run(p.movement_id, p.account_id, p.message_id);
    return {
      received: payload.notices.length,
      new_notices: added,
      paired: new Set(match.pairs.map((p) => p.message_id)).size,
      unpaired: match.unpaired,
      ambiguous: match.ambiguous,
    };
  }).immediate();
}
