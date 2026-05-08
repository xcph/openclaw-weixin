/**
 * 聊天内发起微信扫码登录（与 CLI `channels login` 同源 QR 流程）。
 * - renew（默认）：当前运行的网关账号换票 / 重新登录
 * - bind-new：`/weixin-login new`，扫码绑定额外账号（与 CLI 多次登录新增条目一致）
 *
 * 仅允许与 DM 命令授权一致的配对列表（allowFrom.json）；若无列表则回退到账号保存的 userId。
 */
import path from "node:path";
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/infra-runtime";
import { DEFAULT_BASE_URL, clearStaleAccountsForUserId, loadWeixinAccount, registerWeixinAccountId, saveWeixinAccount, } from "../auth/accounts.js";
import { DEFAULT_ILINK_BOT_TYPE, startWeixinLoginWithQr, waitForWeixinLogin, } from "../auth/login-qr.js";
import { readFrameworkAllowFromList } from "../auth/pairing.js";
import { downloadRemoteImageToTemp } from "../cdn/upload.js";
import { resumeSession } from "../api/session-guard.js";
import { logger } from "../util/logger.js";
import { clearPersistedGetUpdatesBufForAccount } from "../storage/sync-buf.js";
import { clearContextTokensForAccount } from "./inbound.js";
import { sendWeixinMediaFile } from "./send-media.js";
import { sendMessageWeixin } from "./send.js";
const LOGIN_TIMEOUT_MS = 480_000;
const QR_DOWNLOAD_TEMP_DIR = path.join(resolvePreferredOpenClawTmpDir(), "weixin/media/outbound-temp");
/** 同一 bot 账号同时只允许一条聊天登录流程，避免并发打乱 sessionKey / activeLogins */
const chatLoginInFlight = new Map();
/** @internal 单元测试之间清空并发状态 */
export function resetWeixinChatLoginStateForTest() {
    chatLoginInFlight.clear();
}
/** 解析 `/weixin-login` 后的参数，例如 `new`、`bind` */
export function parseWeixinLoginIntent(args) {
    const head = args.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    if (head === "new" || head === "bind" || head === "add") {
        return "bind-new";
    }
    return "renew";
}
function resolveEffectiveAllowFrom(accountId) {
    const fromStore = readFrameworkAllowFromList(accountId);
    if (fromStore.length > 0)
        return fromStore;
    const uid = loadWeixinAccount(accountId)?.userId?.trim();
    return uid ? [uid] : [];
}
function effectiveApiBase(accountId) {
    return loadWeixinAccount(accountId)?.baseUrl?.trim() || DEFAULT_BASE_URL;
}
async function sendReply(ctx, text) {
    await sendMessageWeixin({
        to: ctx.to,
        text,
        opts: {
            baseUrl: ctx.baseUrl,
            token: ctx.token,
            contextToken: ctx.contextToken,
        },
    });
}
async function persistLoginSuccess(result) {
    if (!result.connected || !result.botToken || !result.accountId) {
        return;
    }
    try {
        const normalizedId = normalizeAccountId(result.accountId);
        saveWeixinAccount(normalizedId, {
            token: result.botToken,
            baseUrl: result.baseUrl,
            userId: result.userId,
        });
        registerWeixinAccountId(normalizedId);
        if (result.userId) {
            clearStaleAccountsForUserId(normalizedId, result.userId, clearContextTokensForAccount);
        }
        clearPersistedGetUpdatesBufForAccount(normalizedId);
        resumeSession(normalizedId);
        logger.info(`weixin-login-slash: saved accountId=${normalizedId}`);
    }
    catch (err) {
        logger.error(`weixin-login-slash: failed to save account err=${String(err)}`);
        throw err;
    }
}
async function runBackgroundWeixinLogin(ctx, apiBaseUrl, intent) {
    try {
        const bindNew = intent === "bind-new";
        const start = await startWeixinLoginWithQr({
            ...(bindNew ? {} : { accountId: ctx.accountId }),
            apiBaseUrl,
            botType: DEFAULT_ILINK_BOT_TYPE,
            force: true,
            verbose: false,
        });
        if (!start.qrcodeUrl) {
            await sendReply(ctx, `无法获取登录二维码：${start.message}`);
            return;
        }
        const intro = bindNew
            ? "正在绑定新的微信机器人账号。请使用微信扫描下方二维码（若图片未显示可点击链接扫码）："
            : "请使用微信扫描下方二维码完成当前账号登录（若图片未显示可点击链接扫码）：";
        await sendReply(ctx, [intro, start.qrcodeUrl].join("\n"));
        try {
            const filePath = await downloadRemoteImageToTemp(start.qrcodeUrl, QR_DOWNLOAD_TEMP_DIR);
            await sendWeixinMediaFile({
                filePath,
                to: ctx.to,
                text: bindNew ? "新账号绑定二维码" : "登录二维码",
                opts: { baseUrl: ctx.baseUrl, token: ctx.token, contextToken: ctx.contextToken },
                cdnBaseUrl: ctx.cdnBaseUrl,
            });
        }
        catch (imgErr) {
            logger.warn(`weixin-login-slash: QR image send failed, URL already sent err=${String(imgErr)}`);
        }
        await sendReply(ctx, bindNew
            ? "等待扫码确认中…（若超时请重新发送 /weixin-login new）"
            : "等待扫码确认中…（若超时请重新发送 /weixin-login）");
        const waitResult = await waitForWeixinLogin({
            sessionKey: start.sessionKey,
            apiBaseUrl,
            timeoutMs: LOGIN_TIMEOUT_MS,
            verbose: false,
            botType: DEFAULT_ILINK_BOT_TYPE,
        });
        if (waitResult.connected && waitResult.botToken && waitResult.accountId) {
            await persistLoginSuccess(waitResult);
            const normalizedId = normalizeAccountId(waitResult.accountId);
            await sendReply(ctx, bindNew
                ? `✅ 新账号已绑定并写入本地（AccountId: ${normalizedId}）。gateway 会加载账号列表，必要时请重启 gateway。`
                : "✅ 微信登录成功，凭证已更新。如会话异常可重启 gateway。");
        }
        else {
            await sendReply(ctx, `登录未完成：${waitResult.message}`);
        }
    }
    catch (err) {
        logger.error(`weixin-login-slash: flow error err=${String(err)}`);
        try {
            await sendReply(ctx, `❌ 登录流程异常：${String(err).slice(0, 300)}`);
        }
        catch {
            // ignore
        }
    }
}
/**
 * 校验配对权限后启动后台扫码登录，尽快返回，避免阻塞 monitor 的消息循环。
 */
export async function scheduleWeixinChatLogin(ctx, intent = "renew") {
    const senderId = ctx.to.trim();
    const allowed = resolveEffectiveAllowFrom(ctx.accountId);
    if (allowed.length === 0) {
        await sendReply(ctx, "当前账号尚未配置配对用户（allowFrom），无法校验权限。请先在 OpenClaw 中完成配对后再使用 /weixin-login。");
        return;
    }
    if (!allowed.includes(senderId)) {
        await sendReply(ctx, "无权限：仅配对列表中的微信用户可使用 /weixin-login。");
        return;
    }
    if (chatLoginInFlight.has(ctx.accountId)) {
        await sendReply(ctx, "该机器人账号已有进行中的扫码登录，请等待结束后再试。");
        return;
    }
    const apiBaseUrl = effectiveApiBase(ctx.accountId);
    const task = runBackgroundWeixinLogin(ctx, apiBaseUrl, intent).finally(() => {
        chatLoginInFlight.delete(ctx.accountId);
    });
    chatLoginInFlight.set(ctx.accountId, task);
    void task.catch((err) => {
        logger.error(`weixin-login-slash: background task err=${String(err)}`);
    });
}
//# sourceMappingURL=weixin-login-slash.js.map