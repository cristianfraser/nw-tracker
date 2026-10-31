import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "../../cn";
import { AnchoredPopover } from "./AnchoredPopover";
import styles from "./HoverPopover.module.css";

const OPEN_DELAY_MS = 120;
const CLOSE_DELAY_MS = 180;

/**
 * A small trigger (an icon) whose detail card opens on hover — and on tap, since touch screens
 * have no hover. The card stays open while the pointer is over it, so its text can be selected.
 */
export function HoverPopover({
  trigger,
  ariaLabel,
  children,
  className,
}: {
  trigger: ReactNode;
  ariaLabel: string;
  children: ReactNode;
  className?: string;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const schedule = useCallback((next: boolean) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(next), next ? OPEN_DELAY_MS : CLOSE_DELAY_MS);
  }, []);
  const cancel = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  useEffect(() => cancel, [cancel]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={cn(styles.trigger, className)}
        aria-label={ariaLabel}
        aria-expanded={open}
        onMouseEnter={() => schedule(true)}
        onMouseLeave={() => schedule(false)}
        onFocus={() => schedule(true)}
        onBlur={() => schedule(false)}
        onClick={() => {
          cancel();
          setOpen((o) => !o);
        }}
      >
        {trigger}
      </button>
      <AnchoredPopover
        triggerRef={triggerRef}
        isOpen={open}
        onOpenChange={setOpen}
        ariaLabel={ariaLabel}
        interactive={false}
        placement="bottom"
        onMouseEnter={cancel}
        onMouseLeave={() => schedule(false)}
      >
        {children}
      </AnchoredPopover>
    </>
  );
}
