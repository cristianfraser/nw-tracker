import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api";
import { queryKeys, type DisplayUnit } from "../../queries/keys";
import {
  brokerageMovementFieldLabelStyle,
  brokerageMovementFieldRowStyle,
} from "../panel/BrokerageMovementsSection";
import { CounterpartAccountSelect } from "./CounterpartAccountSelect";

type BookMovementDraft = {
  id: string;
  occurredOn: string;
  amountClp: string;
  note: string;
  counterpartAccountId: number | "";
};

function newRowId(): string {
  return `bm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function emptyRow(): BookMovementDraft {
  return { id: newRowId(), occurredOn: "", amountClp: "", note: "", counterpartAccountId: "" };
}

function parseSignedClp(raw: string): number | null {
  const normalized = raw.trim().replace(/\./g, "").replace(",", ".");
  if (!normalized) return null;
  const n = Number(normalized);
  return Number.isFinite(n) && n !== 0 ? n : null;
}

function buildPostBody(row: BookMovementDraft): Record<string, unknown> | null {
  const amount_clp = parseSignedClp(row.amountClp);
  if (amount_clp == null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.occurredOn.trim())) return null;
  const note = row.note.trim();
  return {
    amount_clp,
    occurred_on: row.occurredOn.trim(),
    ...(note ? { note } : {}),
    ...(row.counterpartAccountId !== ""
      ? { counterpart_account_id: row.counterpartAccountId, counterpart_role: "to" as const }
      : {}),
  };
}

type Props = {
  accountId: number;
  displayUnit: DisplayUnit;
  extraCcOffsetsKey: string;
};

export function AccountBookMovementsForm({ accountId, displayUnit, extraCcOffsetsKey }: Props) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [movements, setMovements] = useState<BookMovementDraft[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [lastSavedCount, setLastSavedCount] = useState<number | null>(null);

  const saveMutation = useMutation({
    mutationFn: async (rows: BookMovementDraft[]) => {
      const bodies = rows.map(buildPostBody).filter((b): b is Record<string, unknown> => b != null);
      if (bodies.length === 0 || bodies.length !== rows.length) {
        throw new Error(t("accountDetail.bookLedger.movementInvalid"));
      }
      for (const body of bodies) {
        await api.createAccountMovement(accountId, body);
      }
      return bodies.length;
    },
    onSuccess: async (count) => {
      setMovements([]);
      setFormError(null);
      setLastSavedCount(count);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.accountDetail(String(accountId), displayUnit, "monthly", extraCcOffsetsKey),
        }),
        queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(displayUnit) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.dashboardNav(displayUnit) }),
      ]);
    },
    onError: (err: Error) => {
      setFormError(err.message);
      setLastSavedCount(null);
    },
  });

  return (
    <fieldset style={{ border: "none", padding: 0, margin: 0 }}>
      <legend className="flow-section-title" style={{ marginBottom: "0.5rem" }}>
        {t("accountDetail.bookLedger.movementTitle")}
      </legend>
      <p className="muted" style={{ fontSize: "0.85rem", marginBottom: "0.75rem" }}>
        {t("accountDetail.bookLedger.movementHint")}
      </p>

      {movements.length === 0 ? (
        <p className="muted" style={{ fontSize: "0.85rem" }}>
          {t("accountDetail.bookLedger.movementEmptyDraft")}
        </p>
      ) : (
        movements.map((row) => (
          <div
            key={row.id}
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(9rem, 1fr))",
              gap: "0.5rem 0.75rem",
              alignItems: "end",
              padding: "0.65rem 0.75rem",
              marginBottom: "0.5rem",
              border: "1px solid var(--border-subtle, #333)",
              borderRadius: 6,
            }}
          >
            <label style={brokerageMovementFieldRowStyle()}>
              <span style={brokerageMovementFieldLabelStyle()}>{t("accountDetail.bookLedger.dateLabel")}</span>
              <input
                type="date"
                value={row.occurredOn}
                onChange={(e) =>
                  setMovements((prev) =>
                    prev.map((r) => (r.id === row.id ? { ...r, occurredOn: e.target.value } : r))
                  )
                }
              />
            </label>
            <label style={brokerageMovementFieldRowStyle()}>
              <span style={brokerageMovementFieldLabelStyle()}>{t("accountDetail.bookLedger.amountClpLabel")}</span>
              <input
                type="text"
                inputMode="decimal"
                value={row.amountClp}
                placeholder="-1325724"
                onChange={(e) =>
                  setMovements((prev) =>
                    prev.map((r) => (r.id === row.id ? { ...r, amountClp: e.target.value } : r))
                  )
                }
              />
            </label>
            <label style={brokerageMovementFieldRowStyle()}>
              <span style={brokerageMovementFieldLabelStyle()}>{t("accountDetail.bookLedger.noteLabel")}</span>
              <input
                type="text"
                value={row.note}
                onChange={(e) =>
                  setMovements((prev) =>
                    prev.map((r) => (r.id === row.id ? { ...r, note: e.target.value } : r))
                  )
                }
              />
            </label>
            <div style={{ gridColumn: "1 / -1" }}>
              <CounterpartAccountSelect
                label={t("accountDetail.movements.counterpartAccount")}
                value={row.counterpartAccountId}
                excludeAccountId={accountId}
                onChange={(counterpartAccountId) =>
                  setMovements((prev) =>
                    prev.map((r) => (r.id === row.id ? { ...r, counterpartAccountId } : r))
                  )
                }
              />
            </div>
            <div style={{ ...brokerageMovementFieldRowStyle(), display: "flex", alignItems: "flex-end" }}>
              <button
                type="button"
                onClick={() => setMovements((prev) => prev.filter((r) => r.id !== row.id))}
              >
                {t("accountDetail.bookLedger.removeRow")}
              </button>
            </div>
          </div>
        ))
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", marginTop: "0.5rem" }}>
        <button
          type="button"
          onClick={() => {
            setMovements((prev) => [...prev, emptyRow()]);
            setFormError(null);
            setLastSavedCount(null);
          }}
        >
          {t("accountDetail.bookLedger.addMovementRow")}
        </button>
      </div>

      {movements.length > 0 ? (
        <div style={{ marginTop: "0.75rem" }}>
          <button
            type="button"
            disabled={saveMutation.isPending}
            onClick={() => saveMutation.mutate(movements)}
          >
            {saveMutation.isPending
              ? t("common.loading")
              : t("accountDetail.bookLedger.movementSaveBtn")}
          </button>
        </div>
      ) : null}

      {formError ? <p className="error" style={{ marginTop: "0.75rem" }}>{formError}</p> : null}
      {lastSavedCount != null ? (
        <p className="muted" style={{ marginTop: "0.75rem", fontSize: "0.85rem" }}>
          {t("accountDetail.bookLedger.movementSaved", { count: lastSavedCount })}
        </p>
      ) : null}
    </fieldset>
  );
}
