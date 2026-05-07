import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  SESSION_EXPIRED_ERRCODE,
  pauseSession,
  resumeSession,
  isSessionPaused,
  getRemainingPauseMs,
  assertSessionActive,
  _resetForTest,
} from "./session-guard.js";

vi.mock("../util/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

describe("session-guard", () => {
  let stateTmp = "";

  beforeEach(() => {
    stateTmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-weixin-session-guard-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateTmp);
    _resetForTest(["acc1", "acc2", "ghost"]);
    vi.useFakeTimers({ now: new Date("2026-05-07T12:00:00Z") });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    fs.rmSync(stateTmp, { recursive: true, force: true });
  });

  it("resumeSession clears pause for linked raw vs normalized Weixin ids", () => {
    pauseSession("hex-im-bot");
    expect(isSessionPaused("hex-im-bot")).toBe(true);
    resumeSession("hex@im.bot");
    expect(isSessionPaused("hex-im-bot")).toBe(false);
    expect(getRemainingPauseMs("hex@im.bot")).toBe(0);
  });

  it("exports SESSION_EXPIRED_ERRCODE as -14", () => {
    expect(SESSION_EXPIRED_ERRCODE).toBe(-14);
  });

  it("isSessionPaused returns false when no pause set", () => {
    expect(isSessionPaused("acc1")).toBe(false);
  });

  it("getRemainingPauseMs returns 0 when no pause set", () => {
    expect(getRemainingPauseMs("acc1")).toBe(0);
  });

  it("resumeSession clears pause immediately", () => {
    pauseSession("acc1");
    expect(isSessionPaused("acc1")).toBe(true);
    resumeSession("acc1");
    expect(isSessionPaused("acc1")).toBe(false);
    expect(getRemainingPauseMs("acc1")).toBe(0);
  });

  it("resumeSession on non-paused account is harmless", () => {
    expect(() => resumeSession("ghost")).not.toThrow();
    expect(isSessionPaused("ghost")).toBe(false);
  });

  it("pauseSession activates a 1-hour pause", () => {
    pauseSession("acc1");
    expect(isSessionPaused("acc1")).toBe(true);

    const remaining = getRemainingPauseMs("acc1");
    expect(remaining).toBeGreaterThan(59 * 60 * 1000);
    expect(remaining).toBeLessThanOrEqual(60 * 60 * 1000);
  });

  it("pause expires after 1 hour", () => {
    pauseSession("acc1");
    expect(isSessionPaused("acc1")).toBe(true);

    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(isSessionPaused("acc1")).toBe(false);
    expect(getRemainingPauseMs("acc1")).toBe(0);
  });

  it("pause is still active at 59 minutes", () => {
    pauseSession("acc1");
    vi.advanceTimersByTime(59 * 60 * 1000);
    expect(isSessionPaused("acc1")).toBe(true);
    expect(getRemainingPauseMs("acc1")).toBeGreaterThan(0);
  });

  it("pauses are per-account", () => {
    pauseSession("acc1");
    expect(isSessionPaused("acc1")).toBe(true);
    expect(isSessionPaused("acc2")).toBe(false);
  });

  it("assertSessionActive does not throw when not paused", () => {
    expect(() => assertSessionActive("acc1")).not.toThrow();
  });

  it("assertSessionActive throws when paused", () => {
    pauseSession("acc1");
    expect(() => assertSessionActive("acc1")).toThrow(/session paused/);
    expect(() => assertSessionActive("acc1")).toThrow(String(SESSION_EXPIRED_ERRCODE));
  });

  it("assertSessionActive stops throwing after pause expires", () => {
    pauseSession("acc1");
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(() => assertSessionActive("acc1")).not.toThrow();
  });

  it("re-pause resets the timer", () => {
    pauseSession("acc1");
    vi.advanceTimersByTime(50 * 60 * 1000);
    expect(isSessionPaused("acc1")).toBe(true);

    pauseSession("acc1");
    vi.advanceTimersByTime(50 * 60 * 1000);
    expect(isSessionPaused("acc1")).toBe(true);

    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(isSessionPaused("acc1")).toBe(false);
  });
});
