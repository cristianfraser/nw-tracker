import type { ReactNode, RefObject } from "react";
import { Dialog, Popover, type PopoverProps } from "react-aria-components";
import { cn } from "../../cn";
import styles from "./AnchoredPopover.module.css";

/**
 * A react-aria popover anchored to `triggerRef`, rendered inside the trigger's enclosing native
 * `<dialog>` when there is one: `Modal` opens with `showModal()`, which puts the dialog in the top
 * layer, so a popover portaled to `<body>` would sit underneath it.
 *
 * `interactive` (default) wraps the content in a react-aria `Dialog` (focus moves in, Escape and
 * an outside press close it); `interactive={false}` is a non-modal hover card (tooltips).
 */
export function AnchoredPopover({
  triggerRef,
  isOpen,
  onOpenChange,
  ariaLabel,
  interactive = true,
  placement,
  className,
  children,
  onMouseEnter,
  onMouseLeave,
}: {
  triggerRef: RefObject<HTMLElement | null>;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  ariaLabel: string;
  interactive?: boolean;
  /** Default: below the trigger, aligned to its start or end, whichever side has room. */
  placement?: PopoverProps["placement"];
  className?: string;
  children: ReactNode;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}) {
  if (!isOpen) return null;
  // Inside a dialog the popover also stays within it: the dialog clips what overflows it.
  const container = triggerRef.current?.closest("dialog") ?? undefined;
  const resolvedPlacement = placement ?? roomyBottomPlacement(triggerRef.current, container);
  return (
    <Popover
      triggerRef={triggerRef}
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isNonModal={!interactive}
      placement={resolvedPlacement}
      offset={6}
      className={cn(styles.popover, className)}
      UNSTABLE_portalContainer={container}
      boundaryElement={container}
    >
      <div onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
        {interactive ? (
          <Dialog aria-label={ariaLabel} className={styles.dialog}>
            {children}
          </Dialog>
        ) : (
          <div role="tooltip" aria-label={ariaLabel} className={styles.dialog}>
            {children}
          </div>
        )}
      </div>
    </Popover>
  );
}

/**
 * «bottom start» when the trigger sits in the left half of its container (the dialog, else the
 * viewport), «bottom end» in the right half — so the card opens toward the free side. react-aria's
 * own shift does not keep a popover inside a dialog boundary.
 */
function roomyBottomPlacement(
  trigger: HTMLElement | null,
  container: Element | undefined
): PopoverProps["placement"] {
  if (!trigger) return "bottom start";
  const t = trigger.getBoundingClientRect();
  const c = container?.getBoundingClientRect() ?? { left: 0, right: window.innerWidth };
  return t.left + t.width / 2 > (c.left + c.right) / 2 ? "bottom end" : "bottom start";
}
