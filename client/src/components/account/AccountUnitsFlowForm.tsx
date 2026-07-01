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
import { FlowDirectionToggle, type FlowDirection } from "./FlowDirectionToggle";

type UnitsFlowDraft = {
  id: string;
  occurredOn: string;
  direction: FlowDirection;
  amountClp: string;
  unitsDelta: string;
  note: string;
  counterpartAccountId: number | "";
};

function newRowId(): string {
  return `uf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function emptyRow(): UnitsFlowDraft {
  return {
    id: newRowId(),
    occurredOn: "",
    direction: "in",
    amountClp: "",
    unitsDelta: "",
    note: "",
    counterpartAccountId: "",
  };
}

/** Positive magnitude — thousands dots and Chilean decimals accepted; sign comes from In/Out. */
function parseAbs(raw: string): number | null {
  const t = raw.trim();
  if (!t) return null;
  let normalized: string;
  if (t.includes(",") && t.includes(".")) {
    normalized = t.replace(/\./g, "").replace(",", ".");
  } else if (t.includes(",")) {
    normalized = t.replace(",", ".");
  } else if ((t.match(/\./g) ?? []).length > 1) {
    normalized = t.replace(/\./g, "");
  } else {
    normalized = t;
  }
  const n = Math.abs(Number(normalized));
  return Number.isFinite(n) && n !== 0 ? n : null;
}

function buildPostBody(row: UnitsFlowDraft): Record<string, unknown> | null {
  const amount_clp = parseAbs(row.amountClp);
  const units_delta = parseAbs(row.unitsDelta);
  if (amount_clp == null || units_delta == null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.occurredOn.trim())) return null;
  if (row.counterpartAccountId === "") return null;
  const note = row.note.trim();
  return {
    occurred_on: row.occurredOn.trim(),
    amount_clp,
    units_delta,
    counterpart_account_id: row.counterpartAccountId,
    counterpart_role: row.direction === "in" ? "from" : "to",
    ...(note ? { note } : {}),
  };
}

type Props = {
  accountId: number;
  /** Unit label from `movement_create.unit_label` (cuotas / BTC / ETH). */
  unitLabel: string;
  displayUnit: DisplayUnit;
  extraCcOffsetsKey: string;
};

export function AccountUnitsFlowForm({ accountId, unitLabel, displayUnit, extraCcOffsetsKey }: Props) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [movements, setMovements] = useState<UnitsFlowDraft[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [lastSavedCount, setLastSavedCount] = useState<number | null>(null);

  const saveMutation = useMutation({
    mutationFn: async (rows: UnitsFlowDraft[]) => {
      const bodies = rows.map(buildPostBody).filter((b): b is Record<string, unknown> => b != null);
      if (bodies.length === 0 || bodies.length !== rows.length) {
        throw new Error(t("accountDetail.unitsFlow.invalid"));
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

  function patchRow(id: string, patch: Partial<UnitsFlowDraft>) {
    setMovements((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    setFormError(null);
    setLastSavedCount(null);
  }

  return (
    <fieldset style={{ border: "none", padding: 0, margin: "1.5rem 0 0" }}>
      <legend className="flow-section-title" style={{ marginBottom: "0.5rem" }}>
        {t("accountDetail.unitsFlow.title")}
      </legend>
      <p className="muted" style={{ fontSize: "0.85rem", marginBottom: "0.75rem" }}>
        {t("accountDetail.unitsFlow.hint", { unit: unitLabel })}
      </p>

      {movements.length === 0 ? (
        <p className="muted" style={{ fontSize: "0.85rem" }}>
          {t("accountDetail.unitsFlow.emptyDraft")}
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
                onChange={(e) => patchRow(row.id, { occurredOn: e.target.value })}
              />
            </label>
            <div style={brokerageMovementFieldRowStyle()}>
              <span style={brokerageMovementFieldLabelStyle()}>{t("accountDetail.flowDirection.label")}</span>
              <FlowDirectionToggle
                value={row.direction}
                onChange={(direction) => patchRow(row.id, { direction })}
              />
            </div>
            <label style={brokerageMovementFieldRowStyle()}>
              <span style={brokerageMovementFieldLabelStyle()}>{t("accountDetail.bookLedger.amountClpLabel")}</span>
              <input
                type="text"
                inputMode="decimal"
                value={row.amountClp}
                placeholder="3000000"
                onChange={(e) => patchRow(row.id, { amountClp: e.target.value })}
              />
            </label>
            <label style={brokerageMovementFieldRowStyle()}>
              <span style={brokerageMovementFieldLabelStyle()}>{unitLabel}</span>
              <input
                type="text"
                inputMode="decimal"
                value={row.unitsDelta}
                placeholder="59.760886574"
                onChange={(e) => patchRow(row.id, { unitsDelta: e.target.value })}
              />
            </label>
            <div style={{ gridColumn: "1 / -1" }}>
              <CounterpartAccountSelect
                label={t("accountDetail.movements.counterpartAccount")}
                value={row.counterpartAccountId}
                excludeAccountId={accountId}
                onChange={(counterpartAccountId) => patchRow(row.id, { counterpartAccountId })}
              />
            </div>
            <div style={{ ...brokerageMovementFieldRowStyle(), gridColumn: "1 / -1" }}>
              <label style={brokerageMovementFieldLabelStyle()}>{t("accountDetail.bookLedger.noteLabel")}</label>
              <input
                type="text"
                value={row.note}
                onChange={(e) => patchRow(row.id, { note: e.target.value })}
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
          {t("accountDetail.unitsFlow.addRow")}
        </button>
      </div>

      {movements.length > 0 ? (
        <div style={{ marginTop: "0.75rem" }}>
          <button
            type="button"
            disabled={saveMutation.isPending}
            onClick={() => saveMutation.mutate(movements)}
          >
            {saveMutation.isPending ? t("common.loading") : t("accountDetail.unitsFlow.saveBtn")}
          </button>
        </div>
      ) : null}

      {formError ? <p className="error" style={{ marginTop: "0.75rem" }}>{formError}</p> : null}
      {lastSavedCount != null ? (
        <p className="muted" style={{ marginTop: "0.75rem", fontSize: "0.85rem" }}>
          {t("accountDetail.unitsFlow.saved", { count: lastSavedCount })}
        </p>
      ) : null}
    </fieldset>
  );
}
