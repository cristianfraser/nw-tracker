import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { formatClp } from "../format";

interface Summary {
  account_id: number;
  deposits_clp: number;
  withdrawals_clp: number;
  latest_valuation_clp: number | null;
  latest_valuation_date: string | null;
}

interface Movement {
  id: number;
  kind: string;
  amount_clp: number;
  occurred_on: string;
  note: string | null;
}

export function AccountDetailPage() {
  const { id } = useParams();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [movements, setMovements] = useState<Movement[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      try {
        const [s, m] = await Promise.all([
          fetch(`/api/accounts/${id}/summary`).then((r) => r.json()),
          fetch(`/api/accounts/${id}/movements`).then((r) => r.json()),
        ]);
        if (!cancelled) {
          setSummary(s);
          setMovements(m.movements ?? []);
        }
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : "Failed to load");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (err) {
    return (
      <main className="page">
        <p className="error">{err}</p>
      </main>
    );
  }

  if (!summary) {
    return (
      <main className="page">
        <p className="muted">Loading…</p>
      </main>
    );
  }

  return (
    <main className="page">
      <p className="muted">
        <Link to="/">← Dashboard</Link>
      </p>
      <h1>Account #{summary.account_id}</h1>

      <div className="cards">
        <div className="card">
          <div className="label">Deposits</div>
          <div className="value mono">{formatClp(summary.deposits_clp)}</div>
        </div>
        <div className="card">
          <div className="label">Withdrawals</div>
          <div className="value mono">{formatClp(summary.withdrawals_clp)}</div>
        </div>
        <div className="card">
          <div className="label">Latest valuation</div>
          <div className="value mono">
            {summary.latest_valuation_clp != null
              ? formatClp(summary.latest_valuation_clp)
              : "—"}
          </div>
          <div className="muted" style={{ fontSize: "0.8rem", marginTop: "0.35rem" }}>
            {summary.latest_valuation_date ?? ""}
          </div>
        </div>
      </div>

      <h2>Movements</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Kind</th>
              <th>Amount</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {movements.length === 0 ? (
              <tr>
                <td colSpan={4} className="muted">
                  No movements. Use <span className="mono">POST /api/accounts/{id}/movements</span>
                </td>
              </tr>
            ) : (
              movements.map((m) => (
                <tr key={m.id}>
                  <td>{m.occurred_on}</td>
                  <td>{m.kind}</td>
                  <td className="mono">{formatClp(m.amount_clp)}</td>
                  <td className="muted">{m.note ?? "—"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}
