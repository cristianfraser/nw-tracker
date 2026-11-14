import type { ReactNode } from "react";
import { cn } from "../../cn";
import i18n, { useTranslation } from "../../i18n";
import type { ExpenseLinePaymentName, FlowCcExpenseLineRow } from "../../types";
import { HoverPopover } from "../ui/HoverPopover";
import { InfoIcon } from "../icons/InfoIcon";
import { MoreIcon } from "../icons/MoreIcon";
import { paymentReceiptDetailLines } from "../flows/PaymentReceiptLine";
import { transferCounterpartyDetailLines } from "../flows/TransferCounterpartyLine";
import styles from "./ExpenseVendorLabel.module.css";

/**
 * What a vendor label reads: the bank's merchant, the names the server derived from it and the
 * links behind it. An expense line carries all of it; a card plan the fields its lines carry.
 */
export type ExpenseVendorSource = {
  merchant: string | null;
} & Partial<
  Pick<
    FlowCcExpenseLineRow,
    | "display_merchant"
    | "payment_name"
    | "merchant_processor"
    | "link_label"
    | "payment_receipt"
    | "transfer_counterparty"
    | "expense_deposit_links"
    | "line_role"
    | "nro_cuota_total"
    | "annulled"
    | "annulment"
  >
>;

export type ExpenseVendorLinkLabel = { parts: string[]; inline: boolean };

export function Sep() {
  return (
    <span className={styles.sep} aria-hidden>
      ·
    </span>
  );
}

/** Text parts with a separator between each («Lisboa», «3 nights» → Lisboa · 3 nights). */
export function Joined({ parts }: { parts: readonly string[] }) {
  return (
    <>
      {parts.map((part, i) => (
        <span key={i}>
          {i > 0 ? <Sep /> : null}
          {part}
        </span>
      ))}
    </>
  );
}

function InfoBlock({ lines }: { lines: readonly string[] }) {
  return (
    <div className={styles.infoBlock}>
      {lines.map((text, i) => (
        <div key={i} className={i === 0 ? undefined : "muted"}>
          {text}
        </div>
      ))}
    </div>
  );
}

/**
 * The ⓘ card: the merchant as the bank prints it (when the row shows another name), a plan's
 * cuota count on its full-price row, and what the source is linked to (transfer counterparty,
 * payment receipt, deposit), in full.
 */
export function useExpenseVendorInfo(source: ExpenseVendorSource): ReactNode[] {
  const { t } = useTranslation();
  const blocks: ReactNode[] = [];
  if ((source.display_merchant != null || source.payment_name != null) && source.merchant) {
    // A payment's name replaces the merchant: the store's name and the bank's text go here.
    const bank =
      source.payment_name != null && source.display_merchant != null && source.display_merchant !== source.merchant
        ? [source.display_merchant, source.merchant]
        : [source.merchant];
    if (source.merchant_processor) {
      bank.push(t("expenses.creditCard.lineRow.viaProcessor", { processor: source.merchant_processor }));
    }
    blocks.push(<InfoBlock key="bank" lines={bank} />);
  }
  if (source.line_role === "installment_purchase_total") {
    blocks.push(
      <InfoBlock
        key="cuotas"
        lines={[t("expenses.creditCard.installmentPurchaseTotalLabel", { count: source.nro_cuota_total ?? 0 })]}
      />
    );
  }
  if (source.annulled) {
    blocks.push(
      <InfoBlock
        key="annulled"
        lines={[
          t("expenses.creditCard.lineRow.annulled.decided", {
            date: source.annulled.annulled_on,
            basis: t(`expenses.creditCard.lineRow.annulled.basis.${source.annulled.basis}`),
          }),
        ]}
      />
    );
  }
  if (source.annulment) {
    blocks.push(
      <InfoBlock
        key="annulment"
        lines={[t("expenses.creditCard.lineRow.annulled.annulmentOf", { date: source.annulment.purchase_date })]}
      />
    );
  }
  const c = source.transfer_counterparty;
  if (c) blocks.push(<InfoBlock key="counterparty" lines={transferCounterpartyDetailLines(c)} />);
  const r = source.payment_receipt;
  if (r) {
    const lines = paymentReceiptDetailLines(r);
    lines[0] = `${r.guess ? "≈" : "→"} ${lines[0]}`;
    blocks.push(<InfoBlock key="receipt" lines={lines} />);
  }
  const mortgageLink = source.expense_deposit_links?.find((l) => l.depto_cuota != null);
  if (mortgageLink) {
    blocks.push(
      <InfoBlock
        key="deposit"
        lines={[t("expenses.creditCard.mortgageDepositLinkCuota", { cuota: mortgageLink.depto_cuota })]}
      />
    );
  } else if ((source.expense_deposit_links?.length ?? 0) > 0) {
    blocks.push(<InfoBlock key="deposit" lines={[t("expenses.creditCard.investmentDepositLink")]} />);
  }
  return blocks;
}

/**
 * The short label of what the source is linked to, as parts the row separates — «Streat Burger
 * (Isidora)», «Lisboa» + «3 nights», «DAME» + «2026-09-12», «← Ana Perez» — or the deposit it pairs with; null when it has none.
 */
export function useExpenseVendorLinkLabel(source: ExpenseVendorSource): ExpenseVendorLinkLabel | null {
  const { t } = useTranslation();
  const l = source.link_label;
  if (l) {
    // «→» (paid to) is what a link on an expense means; only the other directions are shown.
    const parts = [l.arrow === "→" ? l.text : `${l.arrow} ${l.text}`];
    if (l.nights != null) {
      parts.push(
        t(l.nights === 1 ? "expenses.creditCard.lineRow.nightsOne" : "expenses.creditCard.lineRow.nightsMany", {
          count: l.nights,
        })
      );
    }
    if (l.event_on) parts.push(l.event_on);
    return { parts, inline: l.inline };
  }
  const mortgageLink = source.expense_deposit_links?.find((d) => d.depto_cuota != null);
  if (mortgageLink) {
    return { parts: [t("expenses.creditCard.mortgageDepositLinkCuota", { cuota: mortgageLink.depto_cuota })], inline: true };
  }
  if ((source.expense_deposit_links?.length ?? 0) > 0) {
    return { parts: [t("expenses.creditCard.investmentDepositLink")], inline: true };
  }
  return null;
}

/** A card payment's name («Pago Lider ·0101», «Pago con tarjeta Santander ·0781», «Pago desde …»). */
export function expensePaymentName(p: ExpenseLinePaymentName): string {
  switch (p.kind) {
    case "pays_card":
      return i18n.t("expenses.creditCard.paymentName.paysCard", { brand: p.card_brand, last4: p.card_last4 });
    case "paid_by_card":
      return i18n.t("expenses.creditCard.paymentName.paidByCard", { brand: p.card_brand, last4: p.card_last4 });
    case "paid_from_account":
      return i18n.t("expenses.creditCard.paymentName.paidFromAccount", { account: p.account_name });
  }
}

/** The name a row shows for its source: a card payment's name, else the server's display name, else the bank's. */
export function expenseVendorName(source: ExpenseVendorSource): string {
  if (source.payment_name) return expensePaymentName(source.payment_name);
  return source.display_merchant ?? source.merchant ?? "—";
}

/** `merchant · note · link ⓘ` — the vendor cell of an expense row and of a card plan. */
export function ExpenseVendorLabel({
  source,
  note,
  className,
  inline = false,
}: {
  source: ExpenseVendorSource;
  note: string | null | undefined;
  className?: string;
  /** Inside a line of text (the cuotas-por-facturación detail) rather than a block of its own. */
  inline?: boolean;
}) {
  const { t } = useTranslation();
  const info = useExpenseVendorInfo(source);
  const linkLabel = useExpenseVendorLinkLabel(source);
  const trimmedNote = note?.trim() ?? "";
  const Root = inline ? "span" : "div";
  return (
    <Root className={cn(styles.vendor, inline && styles.inline, className)}>
      <span className={styles.merchant}>{expenseVendorName(source)}</span>
      {trimmedNote ? (
        <>
          <Sep />
          <span className={styles.note}>{trimmedNote}</span>
        </>
      ) : null}
      {linkLabel?.inline ? (
        <>
          <Sep />
          <span className={styles.linkLabel}>
            <Joined parts={linkLabel.parts} />
          </span>
        </>
      ) : null}
      {info.length > 0 ? (
        <HoverPopover
          className={styles.infoTrigger}
          ariaLabel={t("expenses.creditCard.lineRow.infoAria")}
          trigger={<InfoIcon size={14} />}
        >
          {info}
        </HoverPopover>
      ) : null}
    </Root>
  );
}

/** The link label in full, the first line of a row's ⋯ panel. */
export function ExpenseVendorPanelLink({ linkLabel }: { linkLabel: ExpenseVendorLinkLabel }) {
  return (
    <div className={styles.panelLink}>
      <Joined parts={linkLabel.parts} />
    </div>
  );
}

/** The ⋯ button that opens a row's extras, with a red corner dot when the row waits on the user. */
export function ExpenseRowMoreButton({
  expanded,
  needsAction,
  ariaLabel,
  needsActionTitle,
  onClick,
}: {
  expanded: boolean;
  needsAction?: boolean;
  ariaLabel: string;
  needsActionTitle?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(styles.moreButton, expanded && styles.moreButtonOpen)}
      aria-expanded={expanded}
      aria-label={ariaLabel}
      title={needsAction ? needsActionTitle : undefined}
      onClick={onClick}
    >
      <MoreIcon size={16} />
      {needsAction ? <span className={styles.needsActionBadge} aria-hidden /> : null}
    </button>
  );
}
