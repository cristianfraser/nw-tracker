import { useRef, useState, type ReactNode } from "react";
import { cn } from "../../cn";
import { AnchoredPopover } from "./AnchoredPopover";
import { Pill } from "./Pill";
import styles from "./PillPicker.module.css";

export type PillPickerOption = {
  key: string;
  label: string;
  /** Pill background; omitted = the neutral pill. */
  color?: string;
};

function hoverColor(hex: string): string {
  return `color-mix(in srgb, ${hex} 78%, black)`;
}

/**
 * A value shown as a pill that opens a popover of option pills. A set value shows a floating ×
 * on hover that clears it (touch screens clear from the popover's own clear entry); an unset
 * value shows `emptyLabel` as a muted pill. `readOnly` draws the pill alone, never clickable.
 */
export function PillPicker({
  value,
  emptyLabel,
  options,
  onSelect,
  onClear,
  clearLabel,
  ariaLabel,
  pending = false,
  readOnly = false,
  footer,
}: {
  value: PillPickerOption | null;
  emptyLabel: string;
  options: readonly PillPickerOption[];
  onSelect: (key: string) => void;
  onClear: () => void;
  clearLabel: string;
  ariaLabel: string;
  pending?: boolean;
  readOnly?: boolean;
  /** Extra controls under the options (a «one-off» checkbox, a «new group» action). */
  footer?: ReactNode;
}) {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const shown = value ?? { key: "", label: emptyLabel };
  const color = value?.color;

  if (readOnly) {
    return (
      <Pill size="small" uppercase={false} label={shown.label} backgroundColor={color} className={styles.pill} />
    );
  }

  return (
    <span ref={triggerRef} className={cn(styles.wrap, pending && styles.pending)}>
      <Pill
        size="small"
        uppercase={false}
        label={shown.label}
        backgroundColor={color}
        hoverBackgroundColor={color ? hoverColor(color) : undefined}
        className={cn(styles.pill, !value && styles.empty)}
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-busy={pending || undefined}
        onClick={() => {
          if (!pending) setOpen(true);
        }}
      />
      {value ? (
        <button
          type="button"
          className={styles.clear}
          aria-label={clearLabel}
          disabled={pending}
          onClick={(e) => {
            e.stopPropagation();
            onClear();
          }}
        >
          ×
        </button>
      ) : null}
      <AnchoredPopover
        triggerRef={triggerRef}
        isOpen={open}
        onOpenChange={setOpen}
        ariaLabel={ariaLabel}
        className={styles.popover}
      >
        <div className={styles.options} role="listbox" aria-label={ariaLabel}>
          {options.map((o) => (
            <Pill
              key={o.key}
              size="small"
              uppercase={false}
              role="option"
              aria-selected={o.key === value?.key}
              label={o.label}
              backgroundColor={o.color}
              hoverBackgroundColor={o.color ? hoverColor(o.color) : undefined}
              className={cn(styles.option, o.key === value?.key && styles.optionActive)}
              onClick={() => {
                setOpen(false);
                if (o.key !== value?.key) onSelect(o.key);
              }}
            />
          ))}
        </div>
        {value || footer ? (
          <div className={styles.footer}>
            {value ? (
              <button
                type="button"
                className={styles.clearEntry}
                onClick={() => {
                  setOpen(false);
                  onClear();
                }}
              >
                × {clearLabel}
              </button>
            ) : null}
            {footer}
          </div>
        ) : null}
      </AnchoredPopover>
    </span>
  );
}
