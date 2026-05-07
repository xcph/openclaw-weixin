import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockSendMessageWeixin = vi.hoisted(() => vi.fn().mockResolvedValue({ messageId: "m1" }));
const mockSendWeixinMediaFile = vi.hoisted(() => vi.fn().mockResolvedValue({ messageId: "m2" }));
const mockStart = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    qrcodeUrl: "https://qr.example/img.png",
    sessionKey: "sess",
    message: "ok",
  }),
);
const mockWait = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    connected: true,
    botToken: "tok",
    accountId: "bot@im.bot",
    baseUrl: "https://ilinkai.weixin.qq.com",
    userId: "user@im.wechat",
    message: "done",
  }),
);
const mockAllowFrom = vi.hoisted(() => vi.fn());
const mockLoadAccount = vi.hoisted(() => vi.fn());

vi.mock("./send.js", () => ({ sendMessageWeixin: mockSendMessageWeixin }));
vi.mock("./send-media.js", () => ({ sendWeixinMediaFile: mockSendWeixinMediaFile }));
vi.mock("../auth/login-qr.js", () => ({
  DEFAULT_ILINK_BOT_TYPE: "3",
  startWeixinLoginWithQr: mockStart,
  waitForWeixinLogin: mockWait,
}));
vi.mock("../auth/pairing.js", () => ({
  readFrameworkAllowFromList: mockAllowFrom,
}));
vi.mock("../auth/accounts.js", () => ({
  DEFAULT_BASE_URL: "https://ilinkai.weixin.qq.com",
  loadWeixinAccount: mockLoadAccount,
  clearStaleAccountsForUserId: vi.fn(),
  registerWeixinAccountId: vi.fn(),
  saveWeixinAccount: vi.fn(),
}));

vi.mock("../cdn/upload.js", () => ({
  downloadRemoteImageToTemp: vi.fn().mockResolvedValue("/tmp/qr.png"),
}));

vi.mock("../util/logger.js", () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("./inbound.js", () => ({
  clearContextTokensForAccount: vi.fn(),
}));

vi.mock("../storage/sync-buf.js", () => ({
  clearPersistedGetUpdatesBufForAccount: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/account-id", () => ({
  normalizeAccountId: (id: string) => id.replace(/[@.]/g, "-"),
}));

import {
  scheduleWeixinChatLogin,
  resetWeixinChatLoginStateForTest,
  parseWeixinLoginIntent,
} from "./weixin-login-slash.js";

describe("parseWeixinLoginIntent", () => {
  it("returns renew for empty or unknown first token", () => {
    expect(parseWeixinLoginIntent("")).toBe("renew");
    expect(parseWeixinLoginIntent("  ")).toBe("renew");
    expect(parseWeixinLoginIntent("foo")).toBe("renew");
  });

  it("returns bind-new when first token is new, bind, or add", () => {
    expect(parseWeixinLoginIntent("new")).toBe("bind-new");
    expect(parseWeixinLoginIntent("NEW")).toBe("bind-new");
    expect(parseWeixinLoginIntent("bind")).toBe("bind-new");
    expect(parseWeixinLoginIntent("add")).toBe("bind-new");
    expect(parseWeixinLoginIntent("new extra")).toBe("bind-new");
  });
});

describe("scheduleWeixinChatLogin", () => {
  const ctx = {
    to: "user@im.wechat",
    contextToken: "ct",
    baseUrl: "https://api",
    token: "bot-tok",
    accountId: "acc1",
    cdnBaseUrl: "https://cdn",
    log: vi.fn(),
    errLog: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    resetWeixinChatLoginStateForTest();
    mockAllowFrom.mockReturnValue(["user@im.wechat"]);
    mockLoadAccount.mockReturnValue(null);
    mockStart.mockResolvedValue({
      qrcodeUrl: "https://qr.example/img.png",
      sessionKey: "sess",
      message: "ok",
    });
    mockWait.mockResolvedValue({
      connected: true,
      botToken: "tok",
      accountId: "bot@im.bot",
      baseUrl: "https://ilinkai.weixin.qq.com",
      userId: "user@im.wechat",
      message: "done",
    });
  });

  afterEach(() => {
    resetWeixinChatLoginStateForTest();
  });

  it("rejects when allowFrom empty and no legacy userId", async () => {
    mockAllowFrom.mockReturnValue([]);
    mockLoadAccount.mockReturnValue(null);
    await scheduleWeixinChatLogin(ctx);
    expect(mockSendMessageWeixin).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("尚未配置配对用户"),
      }),
    );
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("uses legacy userId when allowFrom file is empty", async () => {
    mockAllowFrom.mockReturnValue([]);
    mockLoadAccount.mockReturnValue({ userId: "user@im.wechat", token: "x" });
    await scheduleWeixinChatLogin(ctx);
    await vi.waitFor(() => expect(mockWait).toHaveBeenCalled());
    expect(mockStart).toHaveBeenCalled();
  });

  it("rejects when sender not in allow list", async () => {
    mockAllowFrom.mockReturnValue(["other@im.wechat"]);
    await scheduleWeixinChatLogin(ctx);
    expect(mockSendMessageWeixin).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("无权限") }),
    );
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("runs background login for allowed user", async () => {
    await scheduleWeixinChatLogin(ctx);
    await vi.waitFor(() => expect(mockWait).toHaveBeenCalled());
    expect(mockStart).toHaveBeenCalled();
    expect(mockSendWeixinMediaFile).toHaveBeenCalled();
    expect(mockStart.mock.calls[0][0]).toMatchObject({ accountId: "acc1" });
  });

  it("bind-new omits accountId when starting QR session", async () => {
    await scheduleWeixinChatLogin(ctx, "bind-new");
    await vi.waitFor(() => expect(mockWait).toHaveBeenCalled());
    expect(mockStart.mock.calls[0][0].accountId).toBeUndefined();
  });

  it("bind-new success message mentions new account binding", async () => {
    await scheduleWeixinChatLogin(ctx, "bind-new");
    await vi.waitFor(() =>
      expect(mockSendMessageWeixin.mock.calls.some((c) => String(c[0].text).includes("新账号已绑定"))).toBe(
        true,
      ),
    );
  });

  it("notifies when QR start fails", async () => {
    mockStart.mockResolvedValueOnce({ sessionKey: "s", message: "boom" });
    await scheduleWeixinChatLogin(ctx);
    await vi.waitFor(() =>
      expect(
        mockSendMessageWeixin.mock.calls.some((c) => String(c[0].text).includes("无法获取登录二维码")),
      ).toBe(true),
    );
    expect(mockWait).not.toHaveBeenCalled();
  });

  it("blocks concurrent login for same accountId", async () => {
    let resolveWait!: () => void;
    const waitGate = new Promise<void>((r) => {
      resolveWait = r;
    });
    mockWait.mockReset();
    mockWait.mockImplementationOnce(async () => {
      await waitGate;
      return {
        connected: true,
        botToken: "tok",
        accountId: "bot@im.bot",
        baseUrl: "https://ilinkai.weixin.qq.com",
        userId: "user@im.wechat",
        message: "done",
      };
    });

    await scheduleWeixinChatLogin(ctx);
    await vi.waitFor(() => expect(mockStart).toHaveBeenCalled());

    await scheduleWeixinChatLogin(ctx);
    const busy = mockSendMessageWeixin.mock.calls.map((c) => c[0].text).find((t: string) =>
      t.includes("已有进行中的扫码登录"),
    );
    expect(busy).toBeTruthy();

    resolveWait();
    await vi.waitFor(() =>
      expect(mockSendMessageWeixin.mock.calls.some((c) => String(c[0].text).includes("登录成功"))).toBe(true),
    );
  });
});
