/**
 * Whether tonight's session should open the card statements («facturado» tabs). A facturación's
 * statement only exists once its close has passed, and every national statement announces the
 * next close (`FechaProxFact`) — so the step is due, per card account, from that announced close
 * until a newer statement of the account is staged, which announces the following one.
 *
 * A card that stops billing announces a close no statement ever follows (the retired ·0161
 * master's last one, 2025-12-22): after `GIVE_UP_DAYS` past the announced close the account no
 * longer makes the step due. With no national statement staged at all the step is always due —
 * nothing announces a close yet. `--force`, `--capture` and `--only=card-statements` fetch anyway.
 */
import { chileWallClock } from "./catchUp.js";
import { listSantanderStatementFiles, parseSantanderStatementFile } from "./statementJson.js";

/** Days past an announced close the step keeps trying before reading the card as dormant. */
export const GIVE_UP_DAYS = 10;

export type AnnouncedClose = { account: string; extracto: string; next_close: string | null };

export type StatementsDue = { due: boolean; reason: string };

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The latest national statement per account (highest extracto) and the close it announces. */
export function announcedCloses(dir: string): AnnouncedClose[] {
  const latest = new Map<string, AnnouncedClose>();
  for (const file of listSantanderStatementFiles(dir)) {
    const parsed = parseSantanderStatementFile(file);
    if (!parsed || parsed.currency !== "clp") continue;
    const prev = latest.get(parsed.header.account);
    if (prev && Number(prev.extracto) >= Number(parsed.extracto)) continue;
    latest.set(parsed.header.account, {
      account: parsed.header.account,
      extracto: parsed.extracto,
      next_close: parsed.header.next_close,
    });
  }
  return [...latest.values()];
}

export function statementsDue(closes: readonly AnnouncedClose[], todayIso: string): StatementsDue {
  if (closes.length === 0) return { due: true, reason: "no statement staged yet" };
  const waiting: string[] = [];
  for (const c of closes) {
    const tail = `…${c.account.slice(-4)}`;
    if (!c.next_close) return { due: true, reason: `${tail} extracto ${c.extracto} announces no next close` };
    if (todayIso < c.next_close) {
      waiting.push(`${tail} closes ${c.next_close}`);
      continue;
    }
    if (todayIso <= addDays(c.next_close, GIVE_UP_DAYS)) {
      return { due: true, reason: `${tail} closed ${c.next_close} and its statement is not staged yet` };
    }
  }
  return {
    due: false,
    reason: waiting.length > 0 ? `no statement due: ${waiting.join(", ")}` : "no statement due: every card is dormant",
  };
}

/** Tonight's decision for the staged statement directory. */
export function statementsDueToday(dir: string, now = new Date()): StatementsDue {
  return statementsDue(announcedCloses(dir), chileWallClock(now).slice(0, 10));
}
