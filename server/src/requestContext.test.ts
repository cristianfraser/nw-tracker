import { describe, expect, it } from "vitest";
import { requestDropsResponseCaches, requestKind } from "./requestContext.js";

describe("requestKind", () => {
  it.each([
    ["GET", "/api/health", "health"],
    ["POST", "/api/usage/page-view", "beacon"],
    ["POST", "/api/ingest/card.unbilled_movements", "machine"],
    ["POST", "/api/ingest/runs/12/complete", "machine"],
    ["POST", "/api/jobs/7/heartbeat", "machine"],
    ["GET", "/api/jobs/claim", "machine"],
    ["POST", "/api/jobs", "machine"],
    ["GET", "/api/ingest", "machine"],
    ["GET", "/api/usage/report", "api-read"],
    ["GET", "/api/dashboard/page-bundle", "api-read"],
    ["HEAD", "/api/accounts", "api-read"],
    ["OPTIONS", "/api/accounts", "api-read"],
    ["POST", "/api/flows/expenses/manual", "api-write"],
    ["PATCH", "/api", "api-write"],
    ["DELETE", "/api/messages/3", "api-write"],
    ["GET", "/", "other"],
    ["GET", "/assets/index.js", "other"],
    ["GET", "/apix", "other"],
  ] as const)("%s %s → %s", (method, path, kind) => {
    expect(requestKind(method, path)).toBe(kind);
  });
});

describe("requestDropsResponseCaches", () => {
  it.each([
    ["POST", "/api/flows/expenses/manual", true],
    ["PATCH", "/api/messages/3/read", true],
    ["POST", "/api/ingest/utility.bill", true],
    ["POST", "/api/ingest/tasks/cc_payment_mirrors", true],
    ["POST", "/api/ingest/runs/12/complete", false],
    ["POST", "/api/jobs/7/heartbeat", false],
    ["POST", "/api/jobs/claim", false],
    ["POST", "/api/jobs/7/complete", false],
    ["POST", "/api/jobs", false],
    ["POST", "/api/usage/page-view", false],
    ["GET", "/api/dashboard/page-bundle", false],
    ["GET", "/api/ingest/kinds", false],
  ] as const)("%s %s → %s", (method, path, drops) => {
    expect(requestDropsResponseCaches(method, path)).toBe(drops);
  });
});
