import { useEffect, useRef, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { useTranslation } from "../i18n";

type Props = {
  children: ReactNode;
};

/**
 * Mobile off-canvas nav: hidden checkbox toggles drawer + overlay (CSS).
 * Closes on route change so nav links dismiss the panel.
 */
export function MobileNavDrawer({ children }: Props) {
  const { t } = useTranslation();
  const location = useLocation();
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (inputRef.current) inputRef.current.checked = false;
  }, [location.pathname]);

  return (
    <>
      <input
        ref={inputRef}
        id="nav-drawer"
        type="checkbox"
        className="nav-drawer-toggle"
        aria-hidden
        tabIndex={-1}
      />
      <label htmlFor="nav-drawer" className="nav-drawer-tab" aria-label={t("sidebar.openMenu")}>
        <span className="nav-drawer-tab__glyph" aria-hidden>
          ›
        </span>
      </label>
      <label
        htmlFor="nav-drawer"
        className="nav-drawer-overlay"
        aria-label={t("sidebar.closeMenu")}
      />
      {children}
    </>
  );
}
