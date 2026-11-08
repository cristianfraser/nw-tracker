/**
 * A line's pieces (`flow_parts`, migration 283), read by the line they break down: a card line or
 * a checking movement, through its flow. The old `(source, line_id, seq)` shape is what the pieces
 * readers and the re-key mover speak; F20 makes the pieces the flow's parts.
 */
export const FLOW_PARTS_BY_LINE_SQL = `(
  SELECT 'cc' AS source, l.id AS line_id, p.flow_id, p.seq, p.category_id, p.amount_clp, p.note, p.spent_on
  FROM flow_parts p JOIN cc_statement_lines l ON l.flow_id = p.flow_id
  UNION ALL
  SELECT 'checking' AS source, m.id AS line_id, p.flow_id, p.seq, p.category_id, p.amount_clp, p.note, p.spent_on
  FROM flow_parts p JOIN movements m ON m.flow_id = p.flow_id
)`;

/** The row table of a piece source. */
export function pieceSourceTable(source: "cc" | "checking"): "cc_statement_lines" | "movements" {
  return source === "cc" ? "cc_statement_lines" : "movements";
}

/** SQL for the flow of a line (one parameter: the line id). */
export function lineFlowSql(source: "cc" | "checking"): string {
  return `(SELECT flow_id FROM ${pieceSourceTable(source)} WHERE id = ?)`;
}
