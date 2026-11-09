import { describe, expect, it } from "vitest";
import { nestCardBreakdownLines } from "./dashboardCardBreakdown";
import { buildNavCardBreakdown } from "./navCardBreakdown";
import type { DashboardAccountRow, NavTreeNodeDto } from "./types";
import { navNodeFixture } from "./test/navNodeFixture";
import { navCardMetricsFixture } from "./test/navCardMetricsFixture";

function leafAccount(id: number, slug: string): NavTreeNodeDto {
  return navNodeFixture({
    slug,
    label: slug,
    route_path: `/account/${id}`,
    account_id: id,
    children: [],
  });
}

function groupNode(
  slug: string,
  children: NavTreeNodeDto[] = [],
  route = `/g/${slug}`,
  label = slug
): NavTreeNodeDto {
  return navNodeFixture({
    slug,
    label,
    route_path: route,
    portfolio_group_id: 1,
    api_group: "retirement",
    children,
  });
}

function dashRow(
  id: number,
  clp: number,
  bucketSlug: string,
  name = `Account ${id}`
): DashboardAccountRow {
  const kind = bucketSlug.includes("__") ? bucketSlug.slice(bucketSlug.lastIndexOf("__") + 2) : bucketSlug;
  return {
    account_id: id,
    name,
    nav_label: name,
    category_slug: kind,
    category_label: kind,
    group_slug: "retirement",
    group_label: "Retiro",
    dashboard_bucket_slug: "retirement",
    bucket_slug: bucketSlug,
    current_value_clp: clp,
    current_value_usd: null,
    deposits_clp: 0,
    exclude_from_group_totals: 0,
  } as DashboardAccountRow;
}

/** Mirrors `DashboardCardBreakdown` single-account collapse. */
type LabelTree = { label: string; children: LabelTree[] };

function breakdownLabelTree(lines: ReturnType<typeof buildNavCardBreakdown>): LabelTree[] {
  const toTree = (node: ReturnType<typeof nestCardBreakdownLines>[number]): LabelTree => ({
    label: node.label,
    children: node.children.map(toTree),
  });
  return lines ? nestCardBreakdownLines(lines).map(toTree) : [];
}

describe("buildNavCardBreakdown retirement", () => {
  it("lists flat AFP and AFC accounts under AFP+AFC bucket", () => {
    const retirement: NavTreeNodeDto = navNodeFixture({
      slug: "retirement",
      label: "Retiro",
      route_path: "/inversiones/retiro",
      portfolio_group_id: 1,
      api_group: "retirement",
      children: [
        navNodeFixture({
          slug: "retirement_afp_afc",
          label: "AFP + AFC",
          route_path: "/inversiones/retiro/afp-afc",
          portfolio_group_id: 2,
          api_group: "retirement",
          children: [leafAccount(1, "afp"), leafAccount(2, "afc")],
        }),
        navNodeFixture({
          slug: "retirement_apv",
          label: "APV",
          route_path: "/inversiones/retiro/apv",
          portfolio_group_id: 3,
          api_group: "retirement",
          children: [],
        }),
      ],
    });

    const lines = buildNavCardBreakdown(retirement, {
      accounts: [
        dashRow(1, 20_000_000, "retirement_afp_afc__afp", "AFP UNO"),
        dashRow(2, 8_000_000, "retirement_afp_afc__afc", "AFC Banco"),
      ],
      card_metrics_by_slug: navCardMetricsFixture({ retirement_afp_afc: 28_000_000 }),
    });

    expect(lines).not.toBeNull();
    // The group line is the server's balance, never a Σ of the rows here.
    expect(lines!.find((l) => l.label === "AFP + AFC")?.clp).toBe(28_000_000);
    const afpLine = lines!.find((l) => l.label === "AFP UNO" && l.depth === 1);
    const afcLine = lines!.find((l) => l.label === "AFC Banco" && l.depth === 1);
    expect(afpLine?.clp).toBe(20_000_000);
    expect(afcLine?.clp).toBe(8_000_000);
  });

  it("nests the APV and AFP+AFC bucket rows over their accounts, largest first", () => {
    const retirement = groupNode("retirement", [
      groupNode(
        "retirement_afp_afc",
        [
          groupNode("retirement_afp_afc__afp", [leafAccount(1, "afp")], "/afp-afc/afp", "afp"),
          groupNode("retirement_afp_afc__afc", [leafAccount(2, "afc")], "/afp-afc/afc", "afc"),
        ],
        "/afp-afc",
        "AFP + AFC"
      ),
      groupNode(
        "retirement_apv",
        [
          groupNode("retirement_apv_a", [leafAccount(3, "apv-a")], "/apv/apv-a", "apv-a"),
          groupNode("retirement_apv_b", [leafAccount(4, "apv-b")], "/apv/apv-b", "apv-b"),
        ],
        "/apv",
        "APV"
      ),
    ], "/retiro", "Retiro");

    const lines = buildNavCardBreakdown(retirement, {
      accounts: [
        dashRow(1, 20_000_000, "retirement_afp_afc__afp", "AFP UNO"),
        dashRow(2, 8_000_000, "retirement_afp_afc__afc", "AFC Banco"),
        dashRow(3, 45_000_000, "retirement_apv_a__apv", "apv-a"),
        dashRow(4, 20_000_000, "retirement_apv_b__apv", "apv-b"),
      ],
      card_metrics_by_slug: navCardMetricsFixture({
        retirement_afp_afc: 28_000_000,
        retirement_afp_afc__afp: 20_000_000,
        retirement_afp_afc__afc: 8_000_000,
        retirement_apv: 65_000_000,
        retirement_apv_a: 45_000_000,
        retirement_apv_b: 20_000_000,
      }),
    });

    const leaf = (label: string): LabelTree => ({ label, children: [] });
    const group = (label: string, children: LabelTree[]): LabelTree => ({ label, children });
    expect(breakdownLabelTree(lines)).toEqual([
      group("APV", [group("apv-a", [leaf("apv-a")]), group("apv-b", [leaf("apv-b")])]),
      group("AFP + AFC", [group("afp", [leaf("AFP UNO")]), group("afc", [leaf("AFC Banco")])]),
    ]);
  });

  it("marks only stale account lines and all-stale groups", () => {
    const retirement = groupNode("retirement", [
      groupNode(
        "retirement_apv",
        [
          groupNode("retirement_apv_a", [leafAccount(3, "apv-a")], "/apv/apv-a", "apv-a"),
          groupNode("retirement_apv_b", [leafAccount(4, "apv-b")], "/apv/apv-b", "apv-b"),
        ],
        "/apv",
        "APV"
      ),
      groupNode(
        "retirement_afp_afc",
        [leafAccount(1, "afp")],
        "/afp-afc",
        "AFP + AFC"
      ),
    ], "/retiro", "Retiro");

    const lines = buildNavCardBreakdown(retirement, {
      accounts: [
        { ...dashRow(1, 20_000_000, "retirement_afp_afc__afp", "AFP UNO"), sync_stale: false },
        { ...dashRow(3, 45_000_000, "retirement_apv_a__apv", "apv-a"), sync_stale: true },
        { ...dashRow(4, 20_000_000, "retirement_apv_b__apv", "apv-b"), sync_stale: false },
      ],
      card_metrics_by_slug: navCardMetricsFixture({
        retirement_afp_afc: 20_000_000,
        retirement_apv: 65_000_000,
        retirement_apv_a: 45_000_000,
        retirement_apv_b: 20_000_000,
      }),
    });

    const apvGroup = lines!.find((l) => l.label === "APV" && l.depth === 0);
    const apvA = lines!.find((l) => l.label === "apv-a");
    const apvB = lines!.find((l) => l.label === "apv-b");
    const afpLine = lines!.find((l) => l.label === "AFP UNO");

    expect(apvGroup?.sync_stale).toBe(false);
    expect(apvA?.sync_stale).toBe(true);
    expect(apvB?.sync_stale).toBe(false);
    expect(afpLine?.sync_stale).toBe(false);
  });
});
