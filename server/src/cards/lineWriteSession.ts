/**
 * The session every card-line write runs in (docs/untangle-plan.md F11): one per account and
 * outermost write. The write's steps run inside one transaction, framed by the payment-evidence
 * guard; whatever they add or remove notes the earliest dated evidence it touched; when the
 * outermost write ends, the account's billing balances and valuations are re-synced ONCE from that
 * date (`cards/lineWrites.ts` owns the sequence). A write nested inside another on the same account
 * joins it: it adds its steps and its evidence, and finishes nothing.
 *
 * A leaf with no imports on purpose: the merge and the dedupe steps live in the card ledger's import
 * cycle and open sessions too, so the frame (guard, finish) is registered here by
 * `cards/lineWrites.ts` instead of imported. A session that ends with no frame registered throws.
 */

/** What the funnel runs around a session: the guard inside its transaction, the finish after it. */
export type CardLineWriteFrame = {
  /** Runs `body` in one transaction, guarded; returns its result. */
  transaction<T>(accountId: number, what: string, body: () => T): T;
  /**
   * After the transaction: one balance recompute and one valuation re-sync from `evidenceFromYmd`,
   * then the follow-ups the write asked for.
   */
  finish(accountId: number, evidenceFromYmd: string | null, followUps: { financingLinks: boolean }): void;
};

type Session = { what: string; evidenceFromYmd: string | null; financingLinks: boolean; written: boolean };

const sessions = new Map<number, Session>();
let frame: CardLineWriteFrame | null = null;

/** Called once, by `cards/lineWrites.ts` at load. */
export function registerCardLineWriteFrame(f: CardLineWriteFrame): void {
  frame = f;
}

function requireFrame(): CardLineWriteFrame {
  if (!frame) {
    throw new Error("card line write: the funnel is not loaded — import a writer from cards/lineWrites.ts");
  }
  return frame;
}

/** Whether a card-line write is open on the account. */
export function cardLineSessionOpen(accountId: number): boolean {
  return sessions.has(accountId);
}

/** Throws unless a card-line write is open on the account (a raw step called outside the funnel). */
export function requireCardLineSession(accountId: number, step: string): void {
  if (!sessions.has(accountId)) {
    throw new Error(`card line write: ${step} on account ${accountId} ran outside a card-line write (cards/lineWrites.ts)`);
  }
}

/**
 * The write changed the card (lines, plans, closes) without dated evidence to name: it still ends
 * with the re-sync. A write that changed nothing finishes nothing.
 */
export function noteCardLineWritten(accountId: number): void {
  const s = sessions.get(accountId);
  if (!s) throw new Error(`card line write: a change noted on account ${accountId} outside a card-line write`);
  s.written = true;
}

/** The write added or removed evidence dated `ymd` (an ISO day); null names no date. */
export function noteCardLineEvidence(accountId: number, ymd: string | null | undefined): void {
  const s = sessions.get(accountId);
  if (!s) throw new Error(`card line write: evidence noted on account ${accountId} outside a card-line write`);
  s.written = true;
  if (!ymd) return;
  if (s.evidenceFromYmd == null || ymd < s.evidenceFromYmd) s.evidenceFromYmd = ymd;
}

/**
 * The write landed or changed a plan or a statement: once it ends, look for the facturados other
 * cards' cuota purchases paid (`ccFacturadoFinancingAuto.ts`).
 */
export function noteCardLineFinancingLinks(accountId: number): void {
  const s = sessions.get(accountId);
  if (!s) throw new Error(`card line write: financing follow-up noted on account ${accountId} outside a card-line write`);
  s.written = true;
  s.financingLinks = true;
}

/**
 * Runs `body` as a card-line write on the account: as the outermost write (transaction, guard,
 * finish once) or joined to the one already open.
 */
export function withCardLineSession<T>(accountId: number, what: string, body: () => T): T {
  if (sessions.has(accountId)) return body();
  const f = requireFrame();
  const session: Session = { what, evidenceFromYmd: null, financingLinks: false, written: false };
  sessions.set(accountId, session);
  let result: T;
  try {
    result = f.transaction(accountId, what, body);
  } finally {
    sessions.delete(accountId);
  }
  if (session.written) f.finish(accountId, session.evidenceFromYmd, { financingLinks: session.financingLinks });
  return result;
}

/**
 * What a planner (dedupe, mirror, planted, recurring, reconcile) hands the funnel: the lines to
 * delete, and for each line another one that replaces it, whose expense assignments (category, big
 * group, note, pieces, a merchant rule) follow it (`carryCcExpenseAssignments`). A planner reads;
 * it never deletes or carries itself.
 */
export type CardLinePlan = {
  deleteLineIds: readonly number[];
  carry: readonly { fromLineId: number; toLineId: number }[];
};

export const EMPTY_CARD_LINE_PLAN: CardLinePlan = { deleteLineIds: [], carry: [] };
