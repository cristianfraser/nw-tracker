import { describe, expect, it } from "vitest";
import { accountBucketKindSlug } from "./accountBucket.js";
import { buildAccountDetailBundle } from "./accountDetailBundle.js";
import { accountPeriodMetricsFromMonthlyRows } from "./accountPeriodMetrics.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { buildDashboardAccountRows } from "./dashboardAccounts.js";
import type { TsUnit } from "./valuationTimeseries.js";

/**
 * An account's page («Detalle por mes», Rentabilidad) and its dashboard card read one monthly
 * series (`monthlyPerfForAccountId` / `monthlyPerfRowsForAccount`), so the card's month, year
 * and lifetime deposits and P/L equal the page table's rows summed. Until 2026-10-28 the page
 * read the valuation series for every account, so ledger cash (USD / CLP cash, checking, the
 * cuenta de ahorro) showed another series than its card. Credit cards are left out here; the
 * mortgage's deposits are the depto ledger's payments, so only its P/L is compared.
 */
describe("account page monthly table vs dashboard card", () => {
  for (const unit of ["clp", "usd"] as const satisfies readonly TsUnit[]) {
    it(`every account's card equals its page table summed (${unit})`, async () => {
      const today = chileCalendarTodayYmd();
      const rows = await buildDashboardAccountRows(unit);
      const tol = unit === "usd" ? 0.011 : 1.01;
      const mismatches: string[] = [];
      const close = (label: string, card: number | null | undefined, page: number | null) => {
        const a = card ?? null;
        const same = a == null || page == null ? a === page : Math.abs(a - page) < tol;
        if (!same) mismatches.push(`${label}: card ${a ?? "null"} vs page ${page ?? "null"}`);
      };

      let compared = 0;
      for (const r of rows) {
        const kind = accountBucketKindSlug(r.bucket_slug);
        if (kind === "credit_card") continue;
        const card = { m: r.delta_month, y: r.delta_year, t: r.delta_total };
        if (card.m == null && card.y == null && card.t == null) continue;

        const bundle = await buildAccountDetailBundle(r.account_id, unit, "monthly");
        const monthly = bundle?.monthly_performance?.monthly ?? [];
        const page = accountPeriodMetricsFromMonthlyRows(monthly, today);
        const label = `${r.account_id} ${r.name}`;
        close(`${label} month pl`, card.m, page.delta_month);
        close(`${label} year pl`, card.y, page.delta_year);
        close(`${label} total pl`, card.t, page.delta_total);

        if (kind !== "mortgage" && r.deposits_month !== undefined) {
          const dep = { m: r.deposits_month, y: r.deposits_year, t: r.deposits };
          close(`${label} month dep`, dep.m, page.deposits_month);
          close(`${label} year dep`, dep.y, page.deposits_year);
          close(`${label} total dep`, dep.t, page.deposits_total);
        }
        compared += 1;
      }
      expect(compared).toBeGreaterThan(0);
      expect(mismatches).toEqual([]);
    }, 600_000);
  }
});
