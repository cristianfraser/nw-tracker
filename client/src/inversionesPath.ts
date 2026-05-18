export type InversionesResolved = {
  apiGroup: "inversiones" | "retirement" | "brokerage";
  apiSubgroup: string | undefined;
  pageTitle: string;
  /** Which subtree the bottom nav table should emphasize */
  navScope: "root" | "retiro" | "brokerage";
};

/** Back link on group tab pages: parent group in the title hierarchy, or Dashboard only at the Inversiones root. */
export function inversionesGroupParentBackLink(r: InversionesResolved): { to: string; label: string } {
  if (r.apiGroup === "inversiones") {
    return { to: "/", label: "Dashboard" };
  }
  if (r.apiGroup === "retirement") {
    if (r.apiSubgroup == null) {
      return { to: "/inversiones", label: "Inversiones" };
    }
    if (r.apiSubgroup === "apv_a" || r.apiSubgroup === "apv_a_principal" || r.apiSubgroup === "apv_b") {
      return { to: "/inversiones/retiro/apv", label: "APV" };
    }
    return { to: "/inversiones/retiro", label: "Retiro" };
  }
  if (r.apiGroup === "brokerage") {
    if (r.apiSubgroup == null) {
      return { to: "/inversiones", label: "Inversiones" };
    }
    return { to: "/inversiones/brokerage", label: "Brokerage" };
  }
  return { to: "/", label: "Dashboard" };
}

/**
 * Maps `useParams()['*']` under `/inversiones/*` to API `group` + `subgroup` query params.
 */
export function parseInversionesSplat(splat: string | undefined): InversionesResolved | null {
  const segs = (splat ?? "").split("/").filter(Boolean);
  if (segs.length === 0) {
    return { apiGroup: "inversiones", apiSubgroup: undefined, pageTitle: "Inversiones", navScope: "root" };
  }
  const [a, b, c] = [segs[0], segs[1], segs[2]];
  if (a === "retiro") {
    if (!b) {
      return { apiGroup: "retirement", apiSubgroup: undefined, pageTitle: "Inversiones — Retiro", navScope: "retiro" };
    }
    if (b === "afp-afc" && segs.length === 2) {
      return {
        apiGroup: "retirement",
        apiSubgroup: "afp_afc",
        pageTitle: "Inversiones — Retiro — AFP + AFC",
        navScope: "retiro",
      };
    }
    if (b === "afp" && segs.length === 2) {
      return { apiGroup: "retirement", apiSubgroup: "afp", pageTitle: "Inversiones — Retiro — AFP", navScope: "retiro" };
    }
    if (b === "afc" && segs.length === 2) {
      return { apiGroup: "retirement", apiSubgroup: "afc", pageTitle: "Inversiones — Retiro — AFC", navScope: "retiro" };
    }
    if (b === "apv") {
      if (segs.length === 2) {
        return { apiGroup: "retirement", apiSubgroup: "apv", pageTitle: "Inversiones — Retiro — APV", navScope: "retiro" };
      }
      if (segs.length === 3) {
        if (c === "apv-a") {
          return {
            apiGroup: "retirement",
            apiSubgroup: "apv_a",
            pageTitle: "Inversiones — Retiro — APV régimen A",
            navScope: "retiro",
          };
        }
        if (c === "apv-a-principal") {
          return {
            apiGroup: "retirement",
            apiSubgroup: "apv_a_principal",
            pageTitle: "Inversiones — Retiro — APV régimen A — principal (pre-Fintual)",
            navScope: "retiro",
          };
        }
        if (c === "apv-b") {
          return {
            apiGroup: "retirement",
            apiSubgroup: "apv_b",
            pageTitle: "Inversiones — Retiro — APV régimen B",
            navScope: "retiro",
          };
        }
      }
    }
    return null;
  }
  if (a === "brokerage") {
    if (!b) {
      return {
        apiGroup: "brokerage",
        apiSubgroup: undefined,
        pageTitle: "Inversiones — Brokerage",
        navScope: "brokerage",
      };
    }
    const map: Record<string, string> = {
      "fondos-mutuos": "fondos_mutuos",
      acciones: "acciones",
      crypto: "crypto",
    };
    const sub = map[b ?? ""];
    if (sub && segs.length === 2) {
      const pageTitle =
        sub === "acciones"
          ? "Inversiones — Brokerage — Acciones"
          : sub === "fondos_mutuos"
            ? "Inversiones — Brokerage — Fondos mutuos"
            : "Inversiones — Brokerage — Cripto";
      return { apiGroup: "brokerage", apiSubgroup: sub, pageTitle, navScope: "brokerage" };
    }
    return null;
  }
  return null;
}
