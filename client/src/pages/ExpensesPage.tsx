import { useEffect, useState } from "react";
import { api } from "../api";
import { Table } from "../components/Table";
import { formatClp } from "../format";

interface ExpenseRow {
  id: number;
  amount_clp: number;
  spent_on: string;
  category: string | null;
  note: string | null;
  import_batch_id: number | null;
}

export function ExpensesPage() {
  const [rows, setRows] = useState<ExpenseRow[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const d = await api.expenses();
        if (!cancelled) setRows((d.expenses as ExpenseRow[]) ?? []);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : "Failed to load");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (err) {
    return <p className="error">{err}</p>;
  }

  return (
    <>
      <h2 className="flow-section-title">Expenses</h2>
      <p className="muted">
        Optional tracker. Later: upload bank statements to{" "}
        <span className="mono">POST /api/imports/bank-statement</span> (stored as pending batches).
      </p>

      <Table
        header={
          <thead>
            <tr>
              <th>Date</th>
              <th>Amount</th>
              <th>Category</th>
              <th>Note</th>
            </tr>
          </thead>
        }
      >
        {rows.length === 0 ? (
          <tr>
            <td colSpan={4} className="muted">
              No entries. <span className="mono">POST /api/expenses</span>
            </td>
          </tr>
        ) : (
          rows.map((r) => (
            <tr key={r.id}>
              <td>{r.spent_on}</td>
              <td className="mono">{formatClp(r.amount_clp)}</td>
              <td>{r.category ?? "—"}</td>
              <td className="muted">{r.note ?? "—"}</td>
            </tr>
          ))
        )}
      </Table>
    </>
  );
}
