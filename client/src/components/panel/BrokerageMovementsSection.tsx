import { useTranslation } from "react-i18next";
import type { CSSProperties } from "react";
import {
  BROKERAGE_FLOW_KINDS,
  brokerageFlowKindCounterpartIsCash,
  brokerageFlowKindCounterpartIsEquity,
  brokerageFlowKindShowsCounterpart,
  brokerageFlowKindShowsUnits,
  isOptionFlowKind,
  type BrokerageFlowKind,
  type BrokerageFormContext,
} from "../../panelAccounts/brokerageFlowKinds";

/** The currency a cash ledger form's account holds: a code of `/api/currencies` (the server's `movement_create.cash_currency`). */
export type CashFormCurrency = string;
import {
  cashFormAllowsTransferCounterpart,
  cashFormCounterpartCurrency,
  cashFormRowFields,
} from "../../panelAccounts/cashAccountFormTypes";
import {
  appendMovementRow,
  cashCurrencyByAccountId,
  defaultMovementRowKind,
  draftSettlementCurrency,
  removeMovementRow,
  stockFormKindSettlesInCash,
  stockFormRowFields,
  updateMovementRow,
  type InitialMovementDraft,
} from "../../panelAccounts/stockAccountFormTypes";
import { useAccountsAll } from "../../queries/hooks";
import { CounterpartAccountSelect } from "../account/CounterpartAccountSelect";
import { formatNumberInput } from "../../format";
import { Button, Field, Input } from "@crfrsr/ui";

export function brokerageMovementFieldLabelStyle(): CSSProperties {
  return { display: "block", fontSize: "var(--font-size-prose)", marginBottom: "0.25rem" };
}

export function brokerageMovementFieldRowStyle(): CSSProperties {
  return { marginBottom: "0.75rem" };
}

export function BrokerageMovementRowFields({
  row,
  onChange,
  onRemove,
  canRemove,
  currentAccountId,
  flowKinds = BROKERAGE_FLOW_KINDS,
  cashCurrency,
}: {
  row: InitialMovementDraft;
  onChange: (next: InitialMovementDraft) => void;
  onRemove: () => void;
  canRemove: boolean;
  currentAccountId?: number;
  flowKinds?: readonly BrokerageFlowKind[];
  cashCurrency?: CashFormCurrency;
}) {
  const { t } = useTranslation();
  const { data: accountsData } = useAccountsAll();
  // Cash ledger forms pass `cashCurrency`; the stock account form does not. dividend_payout
  // counterpart semantics flip with this: cash form picks the paying stock, stock form picks
  // the receiving cash account.
  const formContext: BrokerageFormContext = cashCurrency != null ? "cash" : "stock";
  const counterpartIsEquity = brokerageFlowKindCounterpartIsEquity(row.flowKind, formContext);
  // The stock form's trades, dividends and premiums settle against a cash account in any
  // currency, and their amount is in that account's currency.
  const settlesInCash = formContext === "stock" && stockFormKindSettlesInCash(row.flowKind);
  // A cash form shows the pesos field and/or its own currency's field (`cashFormRowFields`); the
  // stock form shows pesos for its own capital rows, or the chosen cash account's currency.
  const cashFields = cashCurrency != null ? cashFormRowFields(row.flowKind, cashCurrency) : null;
  const stockFields = stockFormRowFields(row.flowKind);
  const showClp = cashFields != null ? cashFields.pesos : stockFields.pesos;
  const showCash = cashFields != null ? cashFields.own : stockFields.cash;
  // The currency the cash field is typed in: the cash form's own, or the chosen settlement
  // account's (unknown until one is chosen).
  const cashFieldCurrency =
    cashCurrency ?? draftSettlementCurrency(row, cashCurrencyByAccountId(accountsData?.accounts ?? []));
  const showUnits = brokerageFlowKindShowsUnits(row.flowKind);
  const clpTransferCounterpart = cashCurrency != null && cashFormAllowsTransferCounterpart(row.flowKind, cashCurrency);

  return (
    <div
      className="panel-account-movement-row"
      style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(9rem, 1fr))", gap: "0.5rem 0.75rem", alignItems: "end" }}
    >
      <Field label={t("panelAccounts.addAccount.movementDate")}>
        <Input
          type="date"
          value={row.occurredOn}
          onChange={(e) => onChange({ ...row, occurredOn: e.target.value })}
        />
      </Field>
      <Field label={t("panelAccounts.addAccount.movementType")}>
        <select
          value={row.flowKind}
          onChange={(e) =>
            onChange({ ...row, flowKind: e.target.value as BrokerageFlowKind })
          }
        >
          {flowKinds.map((k) => (
            <option key={k} value={k}>
              {t(`panelAccounts.flowKinds.${k}`)}
            </option>
          ))}
        </select>
      </Field>
      {showClp ? (
        <Field label={t("panelAccounts.addAccount.amountClp")}>
          <Input
            type="text"
            inputMode="decimal"
            value={row.amountClp}
            placeholder={row.flowKind === "deposit" ? "3000000" : ""}
            onChange={(e) => onChange({ ...row, amountClp: e.target.value })}
          />
        </Field>
      ) : null}
      {showCash ? (
        <Field
          label={
            cashFieldCurrency != null
              ? t("panelAccounts.addAccount.amountInCurrency", { currency: cashFieldCurrency.toUpperCase() })
              : t("panelAccounts.addAccount.amount")
          }
        >
          <Input
            type="text"
            inputMode="decimal"
            value={row.amountCash}
            placeholder={row.flowKind === "fx_exchange" ? formatNumberInput(3353.07) : ""}
            onChange={(e) => onChange({ ...row, amountCash: e.target.value })}
          />
        </Field>
      ) : null}
      {showUnits ? (
        <Field
          label={
            isOptionFlowKind(row.flowKind)
              ? t("panelAccounts.addAccount.contractsCount")
              : t("panelAccounts.addAccount.sharesCount")
          }
        >
          <Input
            type="text"
            inputMode="decimal"
            value={row.unitsDelta}
            placeholder={formatNumberInput(59.760886574)}
            onChange={(e) => onChange({ ...row, unitsDelta: e.target.value })}
          />
        </Field>
      ) : null}
      {brokerageFlowKindShowsCounterpart(row.flowKind) || clpTransferCounterpart ? (
        <div style={{ gridColumn: "1 / -1" }}>
          <CounterpartAccountSelect
            label={
              counterpartIsEquity
                ? t("accountDetail.movements.dividendOriginAccount")
                : row.flowKind === "dividend_payout"
                  ? t("accountDetail.movements.dividendCashAccount")
                  : brokerageFlowKindCounterpartIsCash(row.flowKind)
                    ? t("accountDetail.movements.compraSourceAccount")
                    : settlesInCash
                      ? t("accountDetail.movements.settlementCashAccount")
                      : t("accountDetail.movements.counterpartAccount")
            }
            value={row.counterpartAccountId}
            excludeAccountId={currentAccountId}
            equityBrokerageOnly={counterpartIsEquity}
            ledgerCurrency={
              cashCurrency != null ? (cashFormCounterpartCurrency(row.flowKind, cashCurrency) ?? undefined) : undefined
            }
            cashLedgerOnly={settlesInCash}
            onChange={(counterpartAccountId) => onChange({ ...row, counterpartAccountId })}
          />
        </div>
      ) : null}
      <div
        style={{
          ...brokerageMovementFieldRowStyle(),
          display: "flex",
          alignItems: "flex-end",
        }}
      >
        <Button variant="danger" onClick={onRemove} disabled={!canRemove}>
          {t("panelAccounts.addAccount.removeMovement")}
        </Button>
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
  titleKey,
  hintKey,
  currentAccountId,
  flowKinds,
  cashCurrency,
}: {
  movements: InitialMovementDraft[];
  onChange: (next: InitialMovementDraft[]) => void;
  /** `optional` = panel create account; `add` = account detail. */
  legend?: BrokerageMovementsSectionLegend;
  emptyTextKey?: string;
  titleKey?: string;
  /** `null` = no hint. */
  hintKey?: string | null;
  currentAccountId?: number;
  flowKinds?: readonly BrokerageFlowKind[];
  cashCurrency?: CashFormCurrency;
}) {
  const { t } = useTranslation();
  const resolvedTitleKey =
    titleKey ??
    (legend === "add"
      ? "accountDetail.brokerageMovements.title"
      : "panelAccounts.addAccount.initialMovementsTitle");
  const resolvedHintKey =
    hintKey === undefined
      ? legend === "add"
        ? "accountDetail.brokerageMovements.hint"
        : null
      : hintKey;

  const offeredKinds = flowKinds ?? BROKERAGE_FLOW_KINDS;

  function addMovement() {
    onChange(appendMovementRow(movements, defaultMovementRowKind(offeredKinds)));
  }

  return (
    <fieldset style={{ border: "none", padding: 0, margin: 0 }}>
      <legend className="flow-section-title">
        {t(resolvedTitleKey)}
      </legend>
      {resolvedHintKey ? (
        <p className="muted" style={{ fontSize: "var(--font-size-prose)", margin: 0 }}>
          {t(resolvedHintKey)}
        </p>
      ) : null}

      {movements.length === 0 ? (
        <p className="muted" style={{ fontSize: "var(--font-size-prose)" }}>
          {/* The copy may list the kinds this form offers (`{{kinds}}`), as the type menu names them. */}
          {t(emptyTextKey, { kinds: offeredKinds.map((k) => t(`panelAccounts.flowKinds.${k}`)).join(", ") })}
        </p>
      ) : (
        movements.map((row) => (
          <BrokerageMovementRowFields
            key={row.id}
            row={row}
            onChange={(next) => onChange(updateMovementRow(movements, row.id, next))}
            onRemove={() => onChange(removeMovementRow(movements, row.id))}
            canRemove
            currentAccountId={currentAccountId}
            flowKinds={flowKinds}
            cashCurrency={cashCurrency}
          />
        ))
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
        <Button variant="secondary" onClick={() => addMovement()}>
          {t("panelAccounts.addAccount.addMovement")}
        </Button>
      </div>
    </fieldset>
  );
}
