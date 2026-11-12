import { Button } from "@crfrsr/ui";
import { HeadingLink } from "../ui/HeadingLink";
import { useTranslation } from "../../i18n";
import { useLatestMovements } from "../../queries/hooks";
import type { CcExpenseBigGroupDto, CcExpenseCategoryDto, LatestCardPayment, LatestIncomeMovement, LatestMovementsResponse } from "../../types";
import { hasSchemaVersion, persistedPayload, usePersistedPayload } from "../../queries/persistedPayloadCache";
import { PageGridTile } from "../layout/PageGridTile";
import { dashboardTileOrder } from "../../dashboardLayout";
import {
  CreditCardExpenseLinesTable,
  ExpenseListStaticRow,
  expenseListVendorClassName,
  type ExpenseListItem,
} from "../credit-card/CreditCardExpenseLinesTable";
import { ExpenseOriginIcon } from "../credit-card/ExpenseOriginIcon";
import { ExpenseVendorLabel } from "../credit-card/ExpenseVendorLabel";
import { PillPicker } from "../ui/PillPicker";
import { formatLineAmount } from "../../format";
import { useDisplayPreferences } from "../../context/DisplayPreferencesContext";
import { queryLoadError } from "../../queries/pageShapeReady";

const LATEST_MOVEMENTS_LIMIT = 15;

/** A stored «Últimos movimientos» entry the panel can draw. */
function isLatestMovements(v: unknown): v is LatestMovementsResponse {
  if (v == null || typeof v !== "object") return false;
  const { rows, categories, big_groups } = v as Record<string, unknown>;
  return (
    Array.isArray(rows) &&
    Array.isArray(categories) &&
    Array.isArray(big_groups) &&
    rows.every((r) => {
      if (r == null || typeof r !== "object" || typeof r.on !== "string") return false;
      if (r.kind === "expense") {
        return r.line != null && typeof r.line.purchase_key === "string" && r.line.amount != null && Number.isFinite(r.line.amount.value) && r.line.values != null;
      }
      if (r.kind === "income") {
        return r.income != null && typeof r.income.key === "string" && r.income.amount != null && Number.isFinite(r.income.amount.value) && r.income.values != null;
      }
      if (r.kind === "card_payment") {
        return r.payment != null && typeof r.payment.key === "string" && r.payment.amount != null && Number.isFinite(r.payment.amount.value) && Array.isArray(r.payment.lines);
      }
      return false;
    })
  );
}

const LATEST_MOVEMENTS = persistedPayload(
  "latest_movements",
  (v): v is LatestMovementsResponse => hasSchemaVersion(v, "latest_movements") && isLatestMovements(v)
);

/** An income credit drawn in the expense rows' grid: origin, date, its kind as a pill, the payer, the pesos. */
function IncomeMovementRow({ on, income }: { on: string; income: LatestIncomeMovement }) {
  const { t } = useTranslation();
  const { displayUnit } = useDisplayPreferences();
  const counterparty = income.transfer_counterparty;
  return (
    <ExpenseListStaticRow
      origin={
        <ExpenseOriginIcon
          origin={{
            kind: income.source === "checking" ? "checking" : "manual",
            account_name: income.account_label,
            card_last4: null,
            additional: false,
          }}
        />
      }
      date={on}
      pills={
        <PillPicker
          readOnly
          value={income.income_kind ? { key: income.income_kind, label: t(`income.chart.${income.income_kind}`) } : null}
          emptyLabel={t("income.chart.other")}
          options={[]}
          onSelect={() => undefined}
          onClear={() => undefined}
          clearLabel=""
          ariaLabel=""
        />
      }
      vendor={
        <ExpenseVendorLabel
          // The payer the bank's mail names, the bank's description in the ⓘ card.
          source={{
            merchant: income.description,
            display_merchant: counterparty?.name ?? undefined,
            transfer_counterparty: counterparty,
          }}
          note={null}
          className={expenseListVendorClassName}
        />
      }
      amount={formatLineAmount(income, displayUnit)}
    />
  );
}

/**
 * A card payment, once: «Pago Lider ·0101 · desde Santander ·0781» / «… · desde Cuenta corriente»,
 * its amount in its own currency, and in its ⋯ panel the evidence lines (the PAGO on the card paid,
 * the paying charge or plan) with their own category and note controls.
 */
function CardPaymentRow({
  on,
  payment,
  categories,
  bigGroups,
}: {
  on: string;
  payment: LatestCardPayment;
  categories: readonly CcExpenseCategoryDto[];
  bigGroups: readonly CcExpenseBigGroupDto[];
}) {
  const { t } = useTranslation();
  const { displayUnit } = useDisplayPreferences();
  const from =
    payment.from.kind === "card"
      ? t("dashboard.latestMovements.fromCard", { brand: payment.from.card_brand, last4: payment.from.card_last4 })
      : payment.from.account_name;
  const name = t("dashboard.latestMovements.cardPayment", {
    brand: payment.to.card_brand,
    last4: payment.to.card_last4,
    from,
  });
  return (
    <ExpenseListStaticRow
      origin={
        <ExpenseOriginIcon
          origin={{
            kind: payment.from.kind === "card" ? "card" : "checking",
            account_name: payment.from.kind === "account" ? payment.from.account_name : null,
            card_last4: payment.from.kind === "card" ? payment.from.card_last4 : null,
            additional: false,
          }}
        />
      }
      date={on}
      pills={
        <PillPicker
          readOnly
          value={{ key: "card_payment", label: t("dashboard.latestMovements.cardPaymentPill") }}
          emptyLabel=""
          options={[]}
          onSelect={() => undefined}
          onClear={() => undefined}
          clearLabel=""
          ariaLabel=""
        />
      }
      vendor={<ExpenseVendorLabel source={{ merchant: name }} note={null} className={expenseListVendorClassName} />}
      amount={formatLineAmount(payment, displayUnit)}
      moreAriaLabel={t("expenses.creditCard.lineRow.moreAria", { merchant: name })}
      panel={
        payment.lines.length > 0 ? (
          <CreditCardExpenseLinesTable
            lines={payment.lines}
            categories={categories}
            bigGroups={bigGroups}
            showBigGroupControls
            enableCheckingNotes
            hideHeader
            emptyLabel=""
          />
        ) : null
      }
    />
  );
}

/**
 * Home «Últimos movimientos»: the newest expense lines across every source (card, checking,
 * manual, payroll) and the income credits, interleaved by the day they happened, as the server
 * lists them (`GET /api/dashboard/latest-movements`). Expense rows are the Expenses page's own row
 * (`CreditCardExpenseLinesTable`: category and big-group pills, note, linked details) dated by the
 * movement's day; income rows share its grid.
 */
export function LatestMovementsTable() {
  const { t } = useTranslation();
  const query = useLatestMovements(LATEST_MOVEMENTS_LIMIT);
  // Until live data is here, the last stored one.
  const { value: data } = usePersistedPayload(LATEST_MOVEMENTS, [], query.data);
  const loadError = queryLoadError(query);

  const items: ExpenseListItem[] = (data?.rows ?? []).map((r) => {
    if (r.kind === "expense") return { kind: "expense", on: r.on, line: r.line };
    if (r.kind === "income") return { kind: "custom", key: r.income.key, node: <IncomeMovementRow on={r.on} income={r.income} /> };
    return {
      kind: "custom",
      key: r.payment.key,
      node: (
        <CardPaymentRow on={r.on} payment={r.payment} categories={data?.categories ?? []} bigGroups={data?.big_groups ?? []} />
      ),
    };
  });

  return (
    <PageGridTile id="latest-movements" order={dashboardTileOrder("latest-movements")}>
      <h2>
        <HeadingLink to="/flows/expenses">{t("dashboard.latestMovements.title")}</HeadingLink>
      </h2>
      {loadError ? (
        <p className="error">
          {loadError instanceof Error ? loadError.message : t("common.loadFailedTables")}
        </p>
      ) : (
        <>
          <CreditCardExpenseLinesTable
            items={items}
            categories={data?.categories ?? []}
            bigGroups={data?.big_groups ?? []}
            showBigGroupControls
            enableCheckingNotes
            hideHeader
            emptyLabel={t("dashboard.latestMovements.empty")}
            loading={data == null}
          />
          {/* Not wired yet: a longer list comes later. */}
          <Button variant="ghost" onClick={() => undefined}>
            {t("dashboard.latestMovements.showMore")}
          </Button>
        </>
      )}
    </PageGridTile>
  );
}
