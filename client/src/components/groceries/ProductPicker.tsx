import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ComboBox, Input, ListBox, ListBoxItem, Popover } from "react-aria-components";
import type { GroceryProductRow } from "../../types/groceries";
import { useIsNarrowViewport } from "../../useIsNarrowViewport";
import styles from "./ProductPicker.module.css";

const CREATE_KEY = "__create__";
/** Options listed at once: the list is a filter, so a long tail is reached by typing. */
const MAX_OPTIONS = 40;

/** Accents and case dropped, so «limon» finds «Limón». */
function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
}

/** The product whose name is exactly the typed text (accents and case aside), if any. */
export function productNamed(products: readonly GroceryProductRow[], text: string): GroceryProductRow | null {
  const wanted = fold(text);
  if (wanted === "") return null;
  return products.find((p) => fold(p.name) === wanted) ?? null;
}

/**
 * Pick-or-name a product: a text field that filters the catalog as you type. A typed name that
 * is no product's is a new product's name, offered as the last option. The field's text is the
 * whole value ({@link productNamed} reads it); the popover is as wide as the field.
 */
export function ProductPicker({
  products,
  value,
  onChange,
  disabled = false,
}: {
  products: readonly GroceryProductRow[];
  value: string;
  onChange: (text: string) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  // On a phone the options open above the field: below it is the on-screen keyboard.
  const narrow = useIsNarrowViewport();
  const typed = value.trim();
  const options = useMemo(() => {
    const wanted = fold(value);
    const matches = wanted === "" ? products : products.filter((p) => fold(p.name).includes(wanted));
    return matches.slice(0, MAX_OPTIONS);
  }, [products, value]);
  const offersCreate = typed !== "" && productNamed(products, typed) === null;

  return (
    <ComboBox
      className={styles.picker}
      aria-label={t("groceries.cleaning.pickerPlaceholder")}
      inputValue={value}
      onInputChange={onChange}
      onSelectionChange={(key) => {
        if (key == null || key === CREATE_KEY) return;
        const picked = products.find((p) => String(p.id) === String(key));
        if (picked) onChange(picked.name);
      }}
      selectedKey={null}
      allowsCustomValue
      allowsEmptyCollection
      menuTrigger="focus"
      isDisabled={disabled}
    >
      <Input className={`crfrsr-input crfrsr-input--md ${styles.input}`} placeholder={t("groceries.cleaning.pickerPlaceholder")} />
      <Popover className={styles.popover} offset={4} placement={narrow ? "top start" : "bottom start"}>
        <ListBox className={styles.list}>
          {options.map((p) => (
            <ListBoxItem key={p.id} id={String(p.id)} textValue={p.name} className={styles.option}>
              {p.name}
            </ListBoxItem>
          ))}
          {offersCreate ? (
            <ListBoxItem id={CREATE_KEY} textValue={typed} className={`${styles.option} ${styles.create}`}>
              {t("groceries.cleaning.createOption", { name: typed })}
            </ListBoxItem>
          ) : null}
        </ListBox>
      </Popover>
    </ComboBox>
  );
}
