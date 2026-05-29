import { useTranslation } from "react-i18next";
import type { CSSProperties } from "react";
import {
  BROKERAGE_FLOW_KINDS,
  brokerageFlowKindNeedsClp,
  brokerageFlowKindShowsUnits,
  brokerageFlowKindNeedsUsd,
  type BrokerageFlowKind,
} from "../../panelAccounts/brokerageFlowKinds";
import {
  appendMovementRow,
  removeMovementRow,
  updateMovementRow,
  type InitialMovementDraft,
} from "../../panelAccounts/stockAccountFormTypes";

export function brokerageMovementFieldLabelStyle(): CSSProperties {
  return { display: "block", fontSize: "0.85rem", marginBottom: "0.25rem" };
}

export function brokerageMovementFieldRowStyle(): CSSProperties {
  return { marginBottom: "0.75rem" };
}

export function BrokerageMovementRowFields({
  row,
  onChange,
  onRemove,
  canRemove,
}: {
  row: InitialMovementDraft;
  onChange: (next: InitialMovementDraft) => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  const { t } = useTranslation();
  const showClp = brokerageFlowKindNeedsClp(row.flowKind);
  const showUsd = brokerageFlowKindNeedsUsd(row.flowKind);
  const showUnits = brokerageFlowKindShowsUnits(row.flowKind);

  return (
    <div
      className="panel-account-movement-row"
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
        <span style={brokerageMovementFieldLabelStyle()}>
          {t("panelAccounts.addAccount.movementDate")}
        </span>
        <input
          type="date"
          value={row.occurredOn}
          onChange={(e) => onChange({ ...row, occurredOn: e.target.value })}
        />
      </label>
      <label style={brokerageMovementFieldRowStyle()}>
        <span style={brokerageMovementFieldLabelStyle()}>
          {t("panelAccounts.addAccount.movementType")}
        </span>
        <select
          value={row.flowKind}
          onChange={(e) =>
            onChange({ ...row, flowKind: e.target.value as BrokerageFlowKind })
          }
        >
          {BROKERAGE_FLOW_KINDS.map((k) => (
            <option key={k} value={k}>
              {t(`panelAccounts.flowKinds.${k}`)}
            </option>
          ))}
        </select>
      </label>
      {showClp ? (
        <label style={brokerageMovementFieldRowStyle()}>
          <span style={brokerageMovementFieldLabelStyle()}>
            {t("panelAccounts.addAccount.amountClp")}
          </span>
          <input
            type="text"
            inputMode="decimal"
            value={row.amountClp}
            placeholder={row.flowKind === "deposit_clp" ? "3000000" : ""}
            onChange={(e) => onChange({ ...row, amountClp: e.target.value })}
          />
        </label>
      ) : null}
      {showUsd ? (
        <label style={brokerageMovementFieldRowStyle()}>
          <span style={brokerageMovementFieldLabelStyle()}>
            {t("panelAccounts.addAccount.amountUsd")}
          </span>
          <input
            type="text"
            inputMode="decimal"
            value={row.amountUsd}
            placeholder={row.flowKind === "compra_usd" ? "3353.07" : ""}
            onChange={(e) => onChange({ ...row, amountUsd: e.target.value })}
          />
        </label>
      ) : null}
      {showUnits ? (
        <label style={brokerageMovementFieldRowStyle()}>
          <span style={brokerageMovementFieldLabelStyle()}>
            {t("panelAccounts.addAccount.unitsDelta")}
          </span>
          <input
            type="text"
            inputMode="decimal"
            value={row.unitsDelta}
            placeholder="59.760886574"
            onChange={(e) => onChange({ ...row, unitsDelta: e.target.value })}
          />
        </label>
      ) : null}
      <div
        style={{
          ...brokerageMovementFieldRowStyle(),
          display: "flex",
          alignItems: "flex-end",
        }}
      >
        <button type="button" onClick={onRemove} disabled={!canRemove}>
          {t("panelAccounts.addAccount.removeMovement")}
        </button>
      </div>
    </div>
  );
}

export type BrokerageMovementsSectionLegend = "optional" | "add";

export function BrokerageMovementsSection({
  movements,
  onChange,
  legend = "optional",
  emptyTextKey = "panelAccounts.addAccount.noMovements",
}: {
  movements: InitialMovementDraft[];
  onChange: (next: InitialMovementDraft[]) => void;
  /** `optional` = panel create account; `add` = account detail. */
  legend?: BrokerageMovementsSectionLegend;
  emptyTextKey?: string;
}) {
  const { t } = useTranslation();
  const titleKey =
    legend === "add"
      ? "accountDetail.brokerageMovements.title"
      : "panelAccounts.addAccount.initialMovementsTitle";
  const hintKey =
    legend === "add"
      ? "accountDetail.brokerageMovements.hint"
      : "panelAccounts.addAccount.initialMovementsHint";

  function addMovement(kind?: BrokerageFlowKind) {
    onChange(appendMovementRow(movements, kind));
  }

  return (
    <fieldset style={{ border: "none", padding: 0, margin: "1.5rem 0 0" }}>
      <legend className="flow-section-title" style={{ marginBottom: "0.5rem" }}>
        {t(titleKey)}
      </legend>
      <p className="muted" style={{ fontSize: "0.85rem", marginBottom: "0.75rem" }}>
        {t(hintKey)}
      </p>

      {movements.length === 0 ? (
        <p className="muted" style={{ fontSize: "0.85rem" }}>
          {t(emptyTextKey)}
        </p>
      ) : (
        movements.map((row) => (
          <BrokerageMovementRowFields
            key={row.id}
            row={row}
            onChange={(next) => onChange(updateMovementRow(movements, row.id, next))}
            onRemove={() => onChange(removeMovementRow(movements, row.id))}
            canRemove
          />
        ))
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", marginTop: "0.5rem" }}>
        <button type="button" onClick={() => addMovement()}>
          {t("panelAccounts.addAccount.addMovement")}
        </button>
        <button type="button" onClick={() => addMovement("compra_usd")}>
          {t("panelAccounts.addAccount.addCompraUsd")}
        </button>
      </div>
    </fieldset>
  );
}
