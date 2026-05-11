import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import type { AccountListRow, AssetGroupSlug, AssetTreeResponse } from "../types";

interface Props {
  slug: AssetGroupSlug;
  title: string;
}

export function AssetGroupPage({ slug, title }: Props) {
  const [tree, setTree] = useState<AssetTreeResponse | null>(null);
  const [accounts, setAccounts] = useState<AccountListRow[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [t, acc] = await Promise.all([api.assetTree(), api.accountsByGroup(slug)]);
        if (!cancelled) {
          setTree(t);
          setAccounts(acc.accounts);
        }
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : "Failed to load");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const group = tree?.groups.find((g) => g.slug === slug);

  if (err) {
    return (
      <main className="page">
        <p className="error">{err}</p>
      </main>
    );
  }

  return (
    <main className="page">
      <h1>{title}</h1>
      <p className="muted">
        <Link to="/">← Dashboard</Link>
      </p>

      <h2>Categories (reference)</h2>
      {!group ? (
        <p className="muted">Loading…</p>
      ) : (
        <div className="subnav">
          {group.categories.map((c) => (
            <span key={c.id} className="pill" title={`category_id=${c.id}`}>
              {c.label} <span className="mono">#{c.id}</span>
            </span>
          ))}
        </div>
      )}

      <h2>Accounts in this class</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Category</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {accounts.length === 0 ? (
              <tr>
                <td colSpan={3} className="muted">
                  No accounts in this class yet. Create one with{" "}
                  <span className="mono">POST /api/accounts</span> using a{" "}
                  <span className="mono">category_id</span> from above.
                </td>
              </tr>
            ) : (
              accounts.map((a) => (
                <tr key={a.id}>
                  <td>
                    <Link to={`/account/${a.id}`}>{a.name}</Link>
                  </td>
                  <td>{a.category_label}</td>
                  <td className="muted">{a.notes ?? "—"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}
