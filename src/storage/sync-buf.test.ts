import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("../util/logger.js", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-buf-test-"));
  process.env.OPENCLAW_STATE_DIR = tmpDir;
});

afterEach(() => {
  delete process.env.OPENCLAW_STATE_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadModule() {
  vi.resetModules();
  return await import("./sync-buf.js");
}

describe("getSyncBufFilePath", () => {
  it("returns path under accounts dir", async () => {
    const { getSyncBufFilePath } = await loadModule();
    const result = getSyncBufFilePath("myacc");
    expect(result).toBe(path.join(tmpDir, "openclaw-weixin", "accounts", "myacc.sync.json"));
  });
});

describe("loadGetUpdatesBuf", () => {
  it("returns undefined when file does not exist", async () => {
    const { loadGetUpdatesBuf, getSyncBufFilePath } = await loadModule();
    const fp = getSyncBufFilePath("nonexistent");
    expect(loadGetUpdatesBuf(fp)).toBeUndefined();
  });

  it("reads get_updates_buf from file", async () => {
    const { loadGetUpdatesBuf, getSyncBufFilePath } = await loadModule();
    const fp = getSyncBufFilePath("acc1");
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, JSON.stringify({ get_updates_buf: "buf-data" }));
    expect(loadGetUpdatesBuf(fp)).toBe("buf-data");
  });

  it("falls back to compat path for -im-bot suffix", async () => {
    const { loadGetUpdatesBuf, getSyncBufFilePath } = await loadModule();
    const fp = getSyncBufFilePath("abc-im-bot");
    // Write at old raw-ID filename
    const dir = path.join(tmpDir, "openclaw-weixin", "accounts");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "abc@im.bot.sync.json"), JSON.stringify({ get_updates_buf: "compat-buf" }));
    expect(loadGetUpdatesBuf(fp)).toBe("compat-buf");
  });

  it("falls back to legacy sync buf path", async () => {
    const { loadGetUpdatesBuf, getSyncBufFilePath } = await loadModule();
    const fp = getSyncBufFilePath("someacc");
    // Write at legacy path
    const legacyDir = path.join(tmpDir, "agents", "default", "sessions", ".openclaw-weixin-sync");
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, "default.json"), JSON.stringify({ get_updates_buf: "legacy-buf" }));
    expect(loadGetUpdatesBuf(fp)).toBe("legacy-buf");
  });

  it("returns undefined on corrupted file", async () => {
    const { loadGetUpdatesBuf, getSyncBufFilePath } = await loadModule();
    const fp = getSyncBufFilePath("bad");
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, "not json");
    expect(loadGetUpdatesBuf(fp)).toBeUndefined();
  });
});

describe("saveGetUpdatesBuf", () => {
  it("persists get_updates_buf to file", async () => {
    const { saveGetUpdatesBuf, loadGetUpdatesBuf, getSyncBufFilePath } = await loadModule();
    const fp = getSyncBufFilePath("acc-save");
    saveGetUpdatesBuf(fp, "saved-buf");
    expect(loadGetUpdatesBuf(fp)).toBe("saved-buf");
  });

  it("creates parent directory if needed", async () => {
    const { saveGetUpdatesBuf, getSyncBufFilePath } = await loadModule();
    const fp = getSyncBufFilePath("new-acc");
    expect(fs.existsSync(path.dirname(fp))).toBe(false);
    saveGetUpdatesBuf(fp, "buf");
    expect(fs.existsSync(path.dirname(fp))).toBe(true);
  });
});

describe("clearPersistedGetUpdatesBufForAccount", () => {
  it("removes primary and compat sync files", async () => {
    const {
      clearPersistedGetUpdatesBufForAccount,
      getSyncBufFilePath,
      loadGetUpdatesBuf,
    } = await loadModule();
    const dir = path.join(tmpDir, "openclaw-weixin", "accounts");
    fs.mkdirSync(dir, { recursive: true });
    const primary = getSyncBufFilePath("abc-im-bot");
    fs.writeFileSync(primary, JSON.stringify({ get_updates_buf: "x" }));
    const compat = path.join(dir, "abc@im.bot.sync.json");
    fs.writeFileSync(compat, JSON.stringify({ get_updates_buf: "y" }));

    clearPersistedGetUpdatesBufForAccount("abc-im-bot");

    expect(fs.existsSync(primary)).toBe(false);
    expect(fs.existsSync(compat)).toBe(false);
    expect(loadGetUpdatesBuf(primary)).toBeUndefined();
  });

  it("no-op when accountId empty", async () => {
    const { clearPersistedGetUpdatesBufForAccount } = await loadModule();
    expect(() => clearPersistedGetUpdatesBufForAccount("  ")).not.toThrow();
  });

  it("removes legacy singleton sync file", async () => {
    const { clearPersistedGetUpdatesBufForAccount, getLegacySyncBufDefaultJsonPath } =
      await loadModule();
    const legacyDir = path.join(tmpDir, "agents", "default", "sessions", ".openclaw-weixin-sync");
    fs.mkdirSync(legacyDir, { recursive: true });
    const legacyPath = getLegacySyncBufDefaultJsonPath();
    fs.writeFileSync(legacyPath, JSON.stringify({ get_updates_buf: "legacy" }));
    clearPersistedGetUpdatesBufForAccount("abc-im-bot");
    expect(fs.existsSync(legacyPath)).toBe(false);
  });
});

describe("shouldDiscardPersistedSyncBufForStaleCredentials", () => {
  it("returns true when savedAt is newer than sync cursor mtimes", async () => {
    const {
      shouldDiscardPersistedSyncBufForStaleCredentials,
      getSyncBufFilePath,
      saveGetUpdatesBuf,
    } = await loadModule();
    const accountsDir = path.join(tmpDir, "openclaw-weixin", "accounts");
    fs.mkdirSync(accountsDir, { recursive: true });
    fs.writeFileSync(
      path.join(accountsDir, "acc-im-bot.json"),
      JSON.stringify({
        token: "t",
        savedAt: new Date("2035-06-01T12:00:00Z").toISOString(),
      }),
      "utf-8",
    );
    const syncFp = getSyncBufFilePath("acc-im-bot");
    saveGetUpdatesBuf(syncFp, "oldbuf");
    const stale = new Date("2020-01-01T00:00:00Z");
    fs.utimesSync(syncFp, stale, stale);

    expect(shouldDiscardPersistedSyncBufForStaleCredentials("acc-im-bot")).toBe(true);
  });

  it("returns false when sync file was touched after credential savedAt", async () => {
    const {
      shouldDiscardPersistedSyncBufForStaleCredentials,
      getSyncBufFilePath,
      saveGetUpdatesBuf,
    } = await loadModule();
    const accountsDir = path.join(tmpDir, "openclaw-weixin", "accounts");
    fs.mkdirSync(accountsDir, { recursive: true });
    fs.writeFileSync(
      path.join(accountsDir, "acc-im-bot.json"),
      JSON.stringify({
        token: "t",
        savedAt: new Date("2020-06-01T12:00:00Z").toISOString(),
      }),
      "utf-8",
    );
    const syncFp = getSyncBufFilePath("acc-im-bot");
    saveGetUpdatesBuf(syncFp, "freshbuf");
    const newer = new Date("2035-01-01T00:00:00Z");
    fs.utimesSync(syncFp, newer, newer);

    expect(shouldDiscardPersistedSyncBufForStaleCredentials("acc-im-bot")).toBe(false);
  });
});
