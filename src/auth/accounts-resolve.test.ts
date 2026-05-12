import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";

import { resolveWeixinAccount } from "./accounts.js";

function cfg(section: Record<string, unknown>): OpenClawConfig {
  return {
    channels: { "openclaw-weixin": section },
  } as OpenClawConfig;
}

describe("resolveWeixinAccount streaming toggles", () => {
  it("defaults showTools true and thinking off", () => {
    const r = resolveWeixinAccount(cfg({}), "acc1");
    expect(r.showTools).toBe(true);
    expect(r.showThinking).toBe(false);
    expect(r.showReasoning).toBe(false);
  });

  it("showThinking overrides showReasoning on the same account", () => {
    const r = resolveWeixinAccount(
      cfg({
        showReasoning: true,
        showThinking: false,
        accounts: {
          acc1: { showReasoning: true, showThinking: false },
        },
      }),
      "acc1",
    );
    expect(r.showThinking).toBe(false);
    expect(r.showReasoning).toBe(false);
  });

  it("inherits section showReasoning when account omits thinking keys", () => {
    const r = resolveWeixinAccount(cfg({ showReasoning: true, accounts: { acc1: {} } }), "acc1");
    expect(r.showThinking).toBe(true);
  });

  it("respects showTools: false at section and account levels", () => {
    expect(resolveWeixinAccount(cfg({ showTools: false }), "acc1").showTools).toBe(false);
    expect(
      resolveWeixinAccount(cfg({ showTools: true, accounts: { acc1: { showTools: false } } }), "acc1")
        .showTools,
    ).toBe(false);
  });
});
