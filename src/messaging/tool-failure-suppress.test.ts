import { describe, it, expect } from "vitest";
import { isToolFailureWarning } from "./process-message.js";

describe("isToolFailureWarning", () => {
  it("matches the leaked exec tool-failure warning (showTools=false 应抑制)", () => {
    // 实际泄漏到微信的那条(kind=final 的 isError 负载)
    expect(
      isToolFailureWarning({
        text: "⚠️ 🛠️ run python3 ~/.openclaw/skills/ failed: /usr/bin/python3: can't find '__main__' module in '/home/node/.openclaw/skills/'",
      }),
    ).toBe(true);
  });

  it("matches with leading whitespace / no space after emoji", () => {
    expect(isToolFailureWarning({ text: "  ⚠️🛠️ run foo failed" })).toBe(true);
    expect(isToolFailureWarning({ text: "⚠️ 🛠️ some-tool failed: boom" })).toBe(true);
  });

  it("does NOT match normal assistant replies", () => {
    expect(isToolFailureWarning({ text: "如果你想查看更详细的K线图,可以告诉我~ 😊" })).toBe(false);
    expect(isToolFailureWarning({ text: "⚠️ 请注意风险(非工具告警)" })).toBe(false);
    expect(isToolFailureWarning({ text: "🛠️ 工具调用摘要(kind=tool,另有门控)" })).toBe(false);
    expect(isToolFailureWarning({})).toBe(false);
    expect(isToolFailureWarning({ text: "" })).toBe(false);
  });
});
