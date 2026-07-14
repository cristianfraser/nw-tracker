import { describe, expect, it } from "vitest";

import { applyBackgroundJobsEnvDefaults, backgroundJobsDisabled } from "./backgroundJobsEnv.js";

describe("backgroundJobsDisabled", () => {
  it("is off by default (unset / affirmative values)", () => {
    expect(backgroundJobsDisabled({})).toBe(false);
    expect(backgroundJobsDisabled({ BACKGROUND_JOBS_ENABLED: "1" })).toBe(false);
    expect(backgroundJobsDisabled({ BACKGROUND_JOBS_ENABLED: "true" })).toBe(false);
  });

  it("recognizes 0/false/no", () => {
    expect(backgroundJobsDisabled({ BACKGROUND_JOBS_ENABLED: "0" })).toBe(true);
    expect(backgroundJobsDisabled({ BACKGROUND_JOBS_ENABLED: "false" })).toBe(true);
    expect(backgroundJobsDisabled({ BACKGROUND_JOBS_ENABLED: " NO " })).toBe(true);
  });
});

describe("applyBackgroundJobsEnvDefaults", () => {
  it("leaves env untouched when the umbrella flag is not set", () => {
    const env: NodeJS.ProcessEnv = {};
    applyBackgroundJobsEnvDefaults(env);
    expect(env).toEqual({});
  });

  it("defaults all scheduler flags to 0 when disabled", () => {
    const env: NodeJS.ProcessEnv = { BACKGROUND_JOBS_ENABLED: "0" };
    applyBackgroundJobsEnvDefaults(env);
    expect(env.GLOBAL_SYNC_ENABLED).toBe("0");
    expect(env.LIVE_QUOTES_SYNC_ENABLED).toBe("0");
    expect(env.DB_BACKUP_ENABLED).toBe("0");
    expect(env.CACHE_WARM_ENABLED).toBe("0");
  });

  it("never overrides an explicitly set per-job flag", () => {
    const env: NodeJS.ProcessEnv = {
      BACKGROUND_JOBS_ENABLED: "0",
      GLOBAL_SYNC_ENABLED: "1",
    };
    applyBackgroundJobsEnvDefaults(env);
    expect(env.GLOBAL_SYNC_ENABLED).toBe("1");
    expect(env.LIVE_QUOTES_SYNC_ENABLED).toBe("0");
  });
});
