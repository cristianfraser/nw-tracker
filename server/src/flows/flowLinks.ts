/**
 * What a flow points at (`flow_links`, migrations 284–286; F20 «Links»): the plans that financed a
 * facturado, the purchase that funded a deposit, the bill a purchase paid. During the transition
 * the readers still see the rows under the key their line carries and the movement or entry they
 * name; this module is the one place that reads them back in that shape.
 */
import { expenseKeySql } from "../expenseKeys.js";

/**
 * The deposit links as `expense_deposit_links` held them (migration 285): the purchase's key, the
 * deposit movement (the movement on the counterpart flow), the figures and the source, plus
 * `link_order` (insertion order — the old table's row order; read with `ORDER BY link_order`).
 */
export const EXPENSE_DEPOSIT_LINKS_SQL = `(
  SELECT l.rowid AS link_order, l.account_id,
         ${expenseKeySql("f.legacy_key", "l.portion", "NULLIF(l.piece_seq, -1)")} AS purchase_key,
         (SELECT MIN(m.id) FROM movements m WHERE m.flow_id = l.counterpart_flow_id) AS deposit_movement_id,
         l.payment_clp, l.amortization_clp, l.depto_cuota, l.depto_occurred_on, l.link_source, l.created_at
  FROM flow_links l JOIN flows f ON f.id = l.flow_id
  WHERE l.kind = 'funded_deposit'
)`;
