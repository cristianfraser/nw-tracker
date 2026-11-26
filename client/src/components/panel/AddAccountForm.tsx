import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api";
import { invalidateResources, resources } from "../../queries/resources";
import { listLeafPortfolioGroupBuckets } from "../../panelAccounts/portfolioNavBuckets";
import {
  PANEL_ACCOUNT_TYPES,
  buildPanelAccountCreatePreview,
  defaultPanelAccountFormDraft,
  isAmbiguousOptionStrike,
  isEquityPanelAccountType,
  isOptionPanelAccountType,
  type OptionRight,
  type PanelAccountFormDraft,
  type PanelAccountType,
} from "../../panelAccounts/panelAccountFormTypes";
import type { NavTreeNodeDto } from "../../types";
import { Button } from "@crfrsr/ui";
import { cn } from "../../cn";
import { formatNumberInput } from "../../format";
import styles from "./PanelForm.module.css";

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
      await invalidateResources(queryClient, resources.panelAccounts());
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
    if (isOptionPanelAccountType(draft.accountType) && isAmbiguousOptionStrike(draft.optionStrike)) {
      setFormError(t("panelAccounts.addAccount.strikeAmbiguous", { strike: draft.optionStrike.trim() }));
      return;
    }
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
    <form className={styles.form} onSubmit={onCreateSubmit}>
      <label className={styles.field}>
        <span className="muted">{t("panelAccounts.addAccount.accountType")}</span>
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
      </label>

      <label className={cn(styles.field, styles.fieldWide)}>
        <span className="muted">{t("panelAccounts.addAccount.displayName")}</span>
        <input
          type="text"
          value={draft.displayName}
          onChange={(e) => updateDraft({ displayName: e.target.value })}
          placeholder={displayNamePlaceholder}
          required={!isOption}
        />
      </label>

      {isOption ? (
        <>
          <label className={cn(styles.field, styles.fieldNarrow)}>
            <span className="muted">{t("options.addAccount.underlying")}</span>
            <input
              type="text"
              value={draft.optionUnderlying}
              onChange={(e) => updateDraft({ optionUnderlying: e.target.value.toUpperCase() })}
              placeholder="SPY"
              required
            />
          </label>
          <label className={cn(styles.field, styles.fieldNarrow)}>
            <span className="muted">{t("options.addAccount.right")}</span>
            <select
              value={draft.optionRight}
              onChange={(e) => updateDraft({ optionRight: e.target.value as OptionRight })}
            >
              <option value="C">{t("options.terms.call")}</option>
              <option value="P">{t("options.terms.put")}</option>
            </select>
          </label>
          <label className={cn(styles.field, styles.fieldNarrow)}>
            <span className="muted">{t("options.addAccount.strike")}</span>
            <input
              type="text"
              inputMode="decimal"
              value={draft.optionStrike}
              onChange={(e) => updateDraft({ optionStrike: e.target.value })}
              placeholder={formatNumberInput(600)}
              required
            />
          </label>
          <label className={styles.field}>
            <span className="muted">{t("options.addAccount.expiry")}</span>
            <input
              type="date"
              value={draft.optionExpiry}
              onChange={(e) => updateDraft({ optionExpiry: e.target.value })}
              required
            />
          </label>
          <p className={cn("muted", styles.line)}>{t("options.addAccount.bucketNote")}</p>
        </>
      ) : null}

      {isEquity ? (
        <label className={cn(styles.field, styles.fieldNarrow)}>
          <span className="muted">{t("panelAccounts.addAccount.tickerSymbol")}</span>
          <input
            type="text"
            value={draft.tickerSymbol}
            onChange={(e) => onTickerChange(e.target.value)}
            placeholder="QQQ"
            required
          />
        </label>
      ) : null}

      {isOption ? null : (
        <label className={styles.field}>
          <span className="muted">{t("panelAccounts.addAccount.bucket")}</span>
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
        </label>
      )}

      <div className={styles.line}>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={draft.excludeFromGroupTotals}
            onChange={(e) => updateDraft({ excludeFromGroupTotals: e.target.checked })}
          />
          <span>{t("panelAccounts.addAccount.excludeFromTotals")}</span>
        </label>
      </div>

      <div className={styles.actions}>
        <Button type="submit" disabled={createMutation.isPending}>
          {createMutation.isPending
            ? t("common.loading")
            : t("panelAccounts.addAccount.createBtn")}
        </Button>
        <Button onClick={resetForm} disabled={createMutation.isPending}>
          {t("panelAccounts.addAccount.resetBtn")}
        </Button>
      </div>

      {formError ? <p className={cn("error", styles.line)}>{formError}</p> : null}
      {createdAccountId != null ? (
        <p className={styles.line}>
          {t("panelAccounts.addAccount.createSuccess", { id: createdAccountId })}
        </p>
      ) : null}
    </form>
  );
}
