import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type CSSProperties, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api";
import { queryKeys } from "../../queries/keys";
import type { StockPriceSource } from "../../panelAccounts/stockAccountFormTypes";
import {
  buildStockAccountCreatePreview,
  categorySlugFromTicker,
  defaultStockAccountFormDraft,
  type StockAccountFormDraft,
} from "../../panelAccounts/stockAccountFormTypes";
import { listLeafPortfolioGroupBuckets } from "../../panelAccounts/portfolioNavBuckets";
import type { NavTreeNodeDto } from "../../types";
import { BrokerageMovementsSection } from "./BrokerageMovementsSection";

const PRICE_SOURCES: { value: StockPriceSource; labelKey: string }[] = [
  { value: "stocks_nyse", labelKey: "panelAccounts.addAccount.priceSource.stocksNyse" },
  { value: "crypto_eod", labelKey: "panelAccounts.addAccount.priceSource.cryptoEod" },
];

const STOCK_PANEL_BUCKETS = new Set(["brokerage_acciones", "brokerage_crypto"]);

type Props = {
  netWorthRoot: NavTreeNodeDto | null;
};

function fieldLabelStyle(): CSSProperties {
  return { display: "block", fontSize: "0.85rem", marginBottom: "0.25rem" };
}

function fieldRowStyle(): CSSProperties {
  return { marginBottom: "0.75rem" };
}

export function AddStockAccountForm({ netWorthRoot }: Props) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const leafBuckets = useMemo(
    () => listLeafPortfolioGroupBuckets(netWorthRoot).filter((b) => STOCK_PANEL_BUCKETS.has(b.slug)),
    [netWorthRoot]
  );
  const defaultBucket =
    leafBuckets.find((b) => b.slug === "brokerage_acciones")?.slug ??
    leafBuckets[0]?.slug ??
    "brokerage_acciones";

  const [draft, setDraft] = useState<StockAccountFormDraft>(() =>
    defaultStockAccountFormDraft(defaultBucket)
  );
  const [formError, setFormError] = useState<string | null>(null);
  const [createdAccountId, setCreatedAccountId] = useState<number | null>(null);

  const createMutation = useMutation({
    mutationFn: (payload: NonNullable<ReturnType<typeof buildStockAccountCreatePreview>>) =>
      api.createStockAccount(payload),
    onSuccess: async (result) => {
      setCreatedAccountId(result.account_id);
      setFormError(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.accountsAll() }),
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

  function updateDraft(patch: Partial<StockAccountFormDraft>) {
    setDraft((prev) => ({ ...prev, ...patch }));
    setFormError(null);
    setCreatedAccountId(null);
  }

  function onTickerChange(ticker: string) {
    const upper = ticker.toUpperCase();
    const suggested = categorySlugFromTicker(upper);
    setDraft((prev) => ({
      ...prev,
      tickerSymbol: upper,
      categorySlug: prev.categorySlug && prev.categorySlug !== categorySlugFromTicker(prev.tickerSymbol)
        ? prev.categorySlug
        : suggested,
    }));
    setFormError(null);
    setCreatedAccountId(null);
  }

  function resetForm() {
    setDraft(defaultStockAccountFormDraft(defaultBucket));
    setFormError(null);
    setCreatedAccountId(null);
    createMutation.reset();
  }

  function onCreateSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setCreatedAccountId(null);
    const payload = buildStockAccountCreatePreview(draft);
    if (!payload) {
      setFormError(t("panelAccounts.addAccount.previewInvalid"));
      return;
    }
    createMutation.mutate(payload);
  }

  return (
    <form onSubmit={onCreateSubmit} style={{ maxWidth: "52rem" }}>

      <fieldset style={{ border: "none", padding: 0, margin: 0 }}>
        <legend className="flow-section-title" style={{ marginBottom: "0.75rem" }}>
          {t("panelAccounts.addAccount.stockSection")}
        </legend>

        <label style={fieldRowStyle()}>
          <span style={fieldLabelStyle()}>{t("panelAccounts.addAccount.displayName")}</span>
          <input
            type="text"
            value={draft.displayName}
            onChange={(e) => updateDraft({ displayName: e.target.value })}
            placeholder={t("panelAccounts.addAccount.displayNamePlaceholder")}
            required
          />
        </label>

        <label style={fieldRowStyle()}>
          <span style={fieldLabelStyle()}>{t("panelAccounts.addAccount.tickerSymbol")}</span>
          <input
            type="text"
            className="mono"
            value={draft.tickerSymbol}
            onChange={(e) => onTickerChange(e.target.value)}
            placeholder="QQQ"
            required
          />
        </label>

        <label style={fieldRowStyle()}>
          <span style={fieldLabelStyle()}>{t("panelAccounts.addAccount.categorySlug")}</span>
          <input
            type="text"
            className="mono"
            value={draft.categorySlug}
            onChange={(e) => updateDraft({ categorySlug: e.target.value.toLowerCase() })}
            placeholder={categorySlugFromTicker(draft.tickerSymbol) || "qqq"}
            required
          />
        </label>

        <label style={fieldRowStyle()}>
          <span style={fieldLabelStyle()}>{t("panelAccounts.addAccount.bucket")}</span>
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

        <label style={fieldRowStyle()}>
          <span style={fieldLabelStyle()}>{t("panelAccounts.addAccount.priceSource")}</span>
          <select
            value={draft.priceSource}
            onChange={(e) => {
              const priceSource = e.target.value as StockPriceSource;
              const bucketSlug =
                priceSource === "crypto_eod" ? "brokerage_crypto" : "brokerage_acciones";
              updateDraft({ priceSource, bucketSlug });
            }}
          >
            {PRICE_SOURCES.map((s) => (
              <option key={s.value} value={s.value}>
                {t(s.labelKey)}
              </option>
            ))}
          </select>
        </label>

        <label style={{ ...fieldRowStyle(), display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            checked={draft.excludeFromGroupTotals}
            onChange={(e) => updateDraft({ excludeFromGroupTotals: e.target.checked })}
          />
          <span>{t("panelAccounts.addAccount.excludeFromTotals")}</span>
        </label>
      </fieldset>

      <BrokerageMovementsSection
        movements={draft.initialMovements}
        onChange={(initialMovements) => {
          setDraft((prev) => ({ ...prev, initialMovements }));
          setFormError(null);
          setCreatedAccountId(null);
        }}
        legend="optional"
      />

      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", marginTop: "1.25rem" }}>
        <button type="submit" disabled={createMutation.isPending}>
          {createMutation.isPending
            ? t("common.loading")
            : t("panelAccounts.addAccount.createBtn")}
        </button>
        <button type="button" onClick={resetForm} disabled={createMutation.isPending}>
          {t("panelAccounts.addAccount.resetBtn")}
        </button>
      </div>

      {formError ? (
        <p className="error" style={{ marginTop: "1rem" }}>
          {formError}
        </p>
      ) : null}
      {createdAccountId != null ? (
        <p style={{ marginTop: "1rem" }}>
          {t("panelAccounts.addAccount.createSuccess", { id: createdAccountId })}
        </p>
      ) : null}
    </form>
  );
}
