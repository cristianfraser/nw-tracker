import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
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
    return (
      <main className="page">
        <p className="error">{err}</p>
      </main>
    );
  }

  return (
    <main className="page">
      <p className="muted">
        <Link to="/">← Dashboard</Link>
      </p>
      <h1>Expenses</h1>
      <p className="muted">
        Optional tracker. Later: upload bank statements to{" "}
        <span className="mono">POST /api/imports/bank-statement</span> (stored as pending batches).
      </p>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Amount</th>
              <th>Category</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
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
          </tbody>
        </table>
      </div>
    </main>
  );
}
