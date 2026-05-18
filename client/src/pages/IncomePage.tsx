import { useEffect, useState } from "react";
import { api } from "../api";
import { Table } from "../components/Table";
import { formatClp } from "../format";

interface IncomeRow {
  id: number;
  amount_clp: number;
  received_on: string;
  source: string | null;
  note: string | null;
}

export function IncomePage() {
  const [rows, setRows] = useState<IncomeRow[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const d = await api.income();
        if (!cancelled) setRows((d.income as IncomeRow[]) ?? []);
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
      <h2 className="flow-section-title">Income</h2>
      <p className="muted">Log salary, bonuses, etc. via API for now.</p>

      <Table
        header={
          <thead>
            <tr>
              <th>Date</th>
              <th>Amount</th>
              <th>Source</th>
              <th>Note</th>
            </tr>
          </thead>
        }
      >
        {rows.length === 0 ? (
          <tr>
            <td colSpan={4} className="muted">
              No entries. <span className="mono">POST /api/income</span>
            </td>
          </tr>
        ) : (
          rows.map((r) => (
            <tr key={r.id}>
              <td>{r.received_on}</td>
              <td className="mono">{formatClp(r.amount_clp)}</td>
              <td>{r.source ?? "—"}</td>
              <td className="muted">{r.note ?? "—"}</td>
            </tr>
          ))
        )}
      </Table>
    </>
  );
}
