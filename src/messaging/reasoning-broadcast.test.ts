import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { createWeixinReasoningBroadcast } from "./reasoning-broadcast.js";

describe("createWeixinReasoningBroadcast", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("flushes once buffer reaches minFlushChars", async () => {
    const sends: string[] = [];
    const r = createWeixinReasoningBroadcast({
      sendText: async (t) => {
        sends.push(t);
      },
      log: { info: vi.fn() },
      minFlushChars: 100,
      maxCharsPerMessage: 500,
      debounceMs: 1000,
    });
    await r.onReasoningStream({ text: "x".repeat(100) });
    expect(sends).toHaveLength(1);
    expect(sends[0]?.startsWith("💭思考")).toBe(true);
    r.dispose();
  });

  it("flushes tail on reasoning end", async () => {
    const sends: string[] = [];
    const r = createWeixinReasoningBroadcast({
      sendText: async (t) => {
        sends.push(t);
      },
      log: { info: vi.fn() },
      minFlushChars: 500,
      debounceMs: 9999,
    });
    await r.onReasoningStream({ text: "short" });
    expect(sends).toHaveLength(0);
    await r.onReasoningEnd();
    expect(sends).toHaveLength(1);
    expect(sends[0]).toContain("short");
    r.dispose();
  });

  it("debounces small buffers", async () => {
    const sends: string[] = [];
    const r = createWeixinReasoningBroadcast({
      sendText: async (t) => {
        sends.push(t);
      },
      log: { info: vi.fn() },
      minFlushChars: 200,
      debounceMs: 500,
    });
    await r.onReasoningStream({ text: "a".repeat(50) });
    expect(sends).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(sends).toHaveLength(1);
    r.dispose();
  });
});
