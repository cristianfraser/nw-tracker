import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api";
import { queryKeys } from "../../queries/keys";
import { listLeafPortfolioGroupBuckets } from "../../panelAccounts/portfolioNavBuckets";
import {
  PANEL_ACCOUNT_TYPES,
  buildPanelAccountCreatePreview,
  defaultPanelAccountFormDraft,
  isEquityPanelAccountType,
  isOptionPanelAccountType,
  type OptionRight,
  type PanelAccountFormDraft,
  type PanelAccountType,
} from "../../panelAccounts/panelAccountFormTypes";
import type { NavTreeNodeDto } from "../../types";
import { Button, Field, Input } from "@crfrsr/ui";

const ACCOUNT_TYPE_LABEL_KEYS: Record<PanelAccountType, string> = {
  equity: "panelAccounts.addAccount.accountType.equity",
  crypto: "panelAccounts.addAccount.accountType.crypto",
  clp_cash: "panelAccounts.addAccount.accountType.clpCash",
  usd_cash: "panelAccounts.addAccount.accountType.usdCash",
  option: "options.addAccount.accountType",
};

type Props = {
  netWorthRoot: NavTreeNodeDto | null;
};

export function AddAccountForm({ netWorthRoot }: Props) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<PanelAccountFormDraft>(() =>
    defaultPanelAccountFormDraft("equity")
  );
  const [formError, setFormError] = useState<string | null>(null);
  const [createdAccountId, setCreatedAccountId] = useState<number | null>(null);

  // Any non-liability leaf bucket in the net-worth tree is a valid home for a new account.
  const leafBuckets = useMemo(
    () => listLeafPortfolioGroupBuckets(netWorthRoot),
    [netWorthRoot]
  );

  const createMutation = useMutation({
    mutationFn: async (payload: NonNullable<ReturnType<typeof buildPanelAccountCreatePreview>>) =>
      api.createAccount(payload),
    onSuccess: async (result) => {
      setCreatedAccountId(result.account_id);
      setFormError(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.accountsAll() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.panelNetWorthTree() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.sidebarNav() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.dashboard("clp") }),
        queryClient.invalidateQueries({ queryKey: queryKeys.dashboard("usd") }),
      ]);
    },
    onError: (err: Error) => {
      setFormError(err.message);
      setCreatedAccountId(null);
    },
  });

  function updateDraft(patch: Partial<PanelAccountFormDraft>) {
    setDraft((prev) => ({ ...prev, ...patch }));
    setFormError(null);
    setCreatedAccountId(null);
  }

  function onAccountTypeChange(type: PanelAccountType) {
    setDraft(defaultPanelAccountFormDraft(type));
    setFormError(null);
    setCreatedAccountId(null);
  }

  function onTickerChange(ticker: string) {
    updateDraft({ tickerSymbol: ticker.toUpperCase() });
  }

  function resetForm() {
    setDraft(defaultPanelAccountFormDraft(draft.accountType));
    setFormError(null);
    setCreatedAccountId(null);
    createMutation.reset();
  }

  function onCreateSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setCreatedAccountId(null);
    const payload = buildPanelAccountCreatePreview(draft);
    if (!payload) {
      setFormError(t("panelAccounts.addAccount.previewInvalid"));
      return;
    }
    createMutation.mutate(payload);
  }

  const isEquity = isEquityPanelAccountType(draft.accountType);
  const isOption = isOptionPanelAccountType(draft.accountType);
  const displayNamePlaceholder = isOption
    ? t("options.addAccount.namePlaceholder")
    : isEquity
      ? t("panelAccounts.addAccount.displayNamePlaceholder")
      : t("panelAccounts.addUsdAccount.displayNamePlaceholder");

  return (
    <form onSubmit={onCreateSubmit}>
      <Field label={t("panelAccounts.addAccount.accountType")}>
        <select
          value={draft.accountType}
          onChange={(e) => onAccountTypeChange(e.target.value as PanelAccountType)}
        >
          {PANEL_ACCOUNT_TYPES.map((type) => (
            <option key={type} value={type}>
              {t(ACCOUNT_TYPE_LABEL_KEYS[type])}
            </option>
          ))}
        </select>
      </Field>

      <Field label={t("panelAccounts.addAccount.displayName")}>
        <Input
          type="text"
          value={draft.displayName}
          onChange={(e) => updateDraft({ displayName: e.target.value })}
          placeholder={displayNamePlaceholder}
          required={!isOption}
        />
      </Field>

      {isOption ? (
        <>
          <Field label={t("options.addAccount.underlying")}>
            <Input
              type="text"
              value={draft.optionUnderlying}
              onChange={(e) => updateDraft({ optionUnderlying: e.target.value.toUpperCase() })}
              placeholder="SPY"
              required
            />
          </Field>
          <Field label={t("options.addAccount.right")}>
            <select
              value={draft.optionRight}
              onChange={(e) => updateDraft({ optionRight: e.target.value as OptionRight })}
            >
              <option value="C">{t("options.terms.call")}</option>
              <option value="P">{t("options.terms.put")}</option>
            </select>
          </Field>
          <Field label={t("options.addAccount.strike")}>
            <Input
              type="text"
              inputMode="decimal"
              value={draft.optionStrike}
              onChange={(e) => updateDraft({ optionStrike: e.target.value })}
              placeholder="600"
              required
            />
          </Field>
          <Field label={t("options.addAccount.expiry")}>
            <Input
              type="date"
              value={draft.optionExpiry}
              onChange={(e) => updateDraft({ optionExpiry: e.target.value })}
              required
            />
          </Field>
          <p className="muted" style={{ margin: 0 }}>
            {t("options.addAccount.bucketNote")}
          </p>
        </>
      ) : null}

      {isEquity ? (
        <Field label={t("panelAccounts.addAccount.tickerSymbol")}>
          <Input
            type="text"
            value={draft.tickerSymbol}
            onChange={(e) => onTickerChange(e.target.value)}
            placeholder="QQQ"
            required
          />
        </Field>
      ) : null}

      {isOption ? null : (
        <Field label={t("panelAccounts.addAccount.bucket")}>
          <select
            value={draft.bucketSlug}
            onChange={(e) => updateDraft({ bucketSlug: e.target.value })}
          >
            {leafBuckets.map((b) => (
              <option key={b.slug} value={b.slug}>
                {b.label} ({b.slug})
              </option>
            ))}
          </select>
        </Field>
      )}

      <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input
          type="checkbox"
          checked={draft.excludeFromGroupTotals}
          onChange={(e) => updateDraft({ excludeFromGroupTotals: e.target.checked })}
        />
        <span>{t("panelAccounts.addAccount.excludeFromTotals")}</span>
      </label>

      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
        <Button type="submit" disabled={createMutation.isPending}>
          {createMutation.isPending
            ? t("common.loading")
            : t("panelAccounts.addAccount.createBtn")}
        </Button>
        <Button onClick={resetForm} disabled={createMutation.isPending}>
          {t("panelAccounts.addAccount.resetBtn")}
        </Button>
      </div>

      {formError ? (
        <p className="error" style={{ margin: 0 }}>
          {formError}
        </p>
      ) : null}
      {createdAccountId != null ? (
        <p style={{ margin: 0 }}>
          {t("panelAccounts.addAccount.createSuccess", { id: createdAccountId })}
        </p>
      ) : null}
    </form>
  );
}
