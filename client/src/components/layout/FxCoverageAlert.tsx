import { useLocation } from "react-router-dom";
import { useDisplayPreferences } from "../../context/DisplayPreferencesContext";
import { useDashboardBundle, useFxCoverage } from "../../queries/hooks";
import { FxCoverageBanner } from "./FxCoverageBanner";

/** Global USD FX coverage warning (missing rates / sparse history). */
export function FxCoverageAlert() {
  const { displayUnit } = useDisplayPreferences();
  const { pathname } = useLocation();
  const onHome = pathname === "/";
  const { data: coverage } = useFxCoverage(displayUnit === "usd");
  const { data: bundle } = useDashboardBundle(displayUnit, displayUnit === "usd" && onHome);
  if (displayUnit !== "usd") return null;
  return (
    <FxCoverageBanner
      coverage={coverage ?? null}
      conversionError={bundle?.dash.fx_conversion_error}
    />
  );
}
