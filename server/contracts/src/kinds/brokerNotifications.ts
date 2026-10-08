import { z } from "zod";
import { defineIngestKind } from "../defineKind.js";
import type { IncomingWireBookingReport } from "./bankAccountIncomingWires.js";

/**
 * One broker notification about money that moved, as the notification states it. Each field
 * is filled only when the notification prints it; the server decides whether what is stated
 * is enough to book a movement (a notification without its amount is a nudge: proof of
 * activity, not a movement).
 */
export const brokerNotificationSchema = z
  .object({
    /** The notification's own identity (an e-mail's Message-ID). Unique within a payload. */
    message_id: z.string().min(1).max(512),
    /** When the notification was sent; the server books the movement on its Chile day. */
    occurred_at: z.iso.datetime({ offset: true }),
    /** The notification's title, kept as the movement's human note. Never parsed by the server. */
    subject: z.string().min(1).max(512),
    kind: z.enum([
      "dividend",
      "buy",
      "deposit",
      "withdrawal_paid",
      "cash_returned",
      "wallet_funded",
      "portfolio_buy",
      // A withdrawal the broker confirmed and will wire (Fintual's «Retiro en dólares
      // confirmado»): not money moving yet. The server keeps it until the wire's own mail
      // arrives (`bank_account.incoming_wires`) and books both together.
      "withdrawal_requested",
    ]),
    ticker: z.string().regex(/^[A-Z][A-Z0-9.]{0,9}$/).nullable(),
    /** The fund a buy names when it names no ticker («… acciones de <fund name>»). */
    fund_name: z.string().min(1).max(200).nullable(),
    /** The goal a withdrawal was paid from («Pagamos tu retiro de <goal>»). */
    goal_name: z.string().min(1).max(200).nullable(),
    /** What the broker moved (credited, paid, bought). Null when the notification states only a gross figure. */
    amount: z.number().positive().nullable(),
    /** A gross figure the broker never credits in full (a dividend before withholding). Never booked. */
    gross_amount: z.number().positive().nullable(),
    currency: z.enum(["clp", "usd"]).nullable(),
    /** Shares or cuotas, as a decimal string (counts run to 9 decimals). */
    units: z.string().regex(/^\d+(?:\.\d+)?$/).nullable(),
    price: z.number().positive().nullable(),
    /** The pesos a dollar amount was bought with, when stated. */
    clp_amount: z.number().positive().nullable(),
    /** Where a withdrawal's pesos went: a bank account, or the broker's own cash balance. */
    paid_to: z.enum(["bank", "broker_balance"]).nullable(),
    /** The account number a requested withdrawal is to be wired to, as printed. */
    destination_account: z.string().regex(/^\d+$/).nullable().optional(),
    /** The day the broker says it will pay a requested withdrawal. */
    due_on: z.iso.date().nullable().optional(),
  })
  .strict();

export type BrokerNotification = z.infer<typeof brokerNotificationSchema>;

/**
 * Every money notification a broker has sent that the feeder still holds — the whole set each
 * time, not only new ones: the server books what is complete and not yet in the ledger, so a
 * notification that could not be booked yet (its bank leg not imported, an unknown fund) is
 * retried simply by being sent again. `apply: false` plans and reports without writing.
 */
export const brokerNotificationsKind = defineIngestKind({
  kind: "broker.notifications",
  schema_version: 1,
  description: "A broker's money notifications (every one the feeder holds).",
  payload: z
    .object({
      broker: z.enum(["fintual", "racional"]),
      apply: z.boolean(),
      notifications: z.array(brokerNotificationSchema),
    })
    .strict()
    .refine((p) => new Set(p.notifications.map((n) => n.message_id)).size === p.notifications.length, {
      message: "message_id must be unique within a payload",
    }),
});

export type BrokerNotificationsPayload = z.infer<typeof brokerNotificationsKind.payload>;

/** One planned movement, as the feeder prints it. */
export type BrokerNotificationPlanRow = {
  occurred_on: string;
  kind: BrokerNotification["kind"];
  amount: number;
  currency: "clp" | "usd";
  /** `from → to` account ids, or null for a single-leg row. */
  legs: string | null;
  units: string | null;
  /** new | synthesized | promoted | creates_account | duplicate | manual */
  state: string;
  detail: string | null;
};

/** `details` of an applied `broker.notifications`. */
export type BrokerNotificationsApplyDetails = {
  broker: "fintual" | "racional";
  applied: boolean;
  planned: BrokerNotificationPlanRow[];
  written: number;
  /** Notifications the server cannot book (no amount stated) and no crawl answers. */
  incomplete: { occurred_at: string; kind: string; subject: string }[];
  /** Racional only: whether a browser crawl must answer a notification. */
  fetch: { needed: boolean; reasons: string[]; nudges: number; answered: number } | null;
  /** Fintual only: retiros synthesized from a mail whose bank credit never appeared. */
  overdue_synthetic_retiros: { movement_id: number; paid_on: string; amount_clp: number; deadline: string | null }[];
  /** Fintual only: requested dollar withdrawals and the wires that paid them. */
  usd_withdrawals: IncomingWireBookingReport | null;
};
