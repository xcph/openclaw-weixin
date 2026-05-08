import fs from "node:fs";
import path from "node:path";
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { resolveStateDir } from "../storage/state-dir.js";
import { logger } from "../util/logger.js";
const SESSION_PAUSE_DURATION_MS = 60 * 60 * 1000;
/** Error code returned by the server when the bot session has expired. */
export const SESSION_EXPIRED_ERRCODE = -14;
function resolveWeixinSessionPausePath(accountId) {
    return path.join(resolveStateDir(), "openclaw-weixin", "accounts", `${accountId.trim()}.session-pause.json`);
}
const IM_BOT_SUFFIX = "-im-bot";
const IM_WECHAT_SUFFIX = "-im-wechat";
/** Same logical bot may appear as `hex-im-bot` (normalized) or `hex@im.bot` (ilink raw) — pause/resume must cover both. */
function linkedPauseAccountIds(accountId) {
    const trimmed = accountId.trim();
    const norm = normalizeAccountId(trimmed);
    const ids = new Set([trimmed, norm]);
    if (norm.endsWith(IM_BOT_SUFFIX)) {
        ids.add(`${norm.slice(0, -IM_BOT_SUFFIX.length)}@im.bot`);
    }
    if (norm.endsWith(IM_WECHAT_SUFFIX)) {
        ids.add(`${norm.slice(0, -IM_WECHAT_SUFFIX.length)}@im.wechat`);
    }
    return [...ids];
}
function readPauseUntilFromDisk(accountId) {
    const filePath = resolveWeixinSessionPausePath(accountId);
    try {
        if (!fs.existsSync(filePath))
            return undefined;
        const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        if (!parsed ||
            typeof parsed !== "object" ||
            !("until" in parsed) ||
            typeof parsed.until !== "number") {
            return undefined;
        }
        const until = parsed.until;
        if (!Number.isFinite(until))
            return undefined;
        return until;
    }
    catch {
        return undefined;
    }
}
function writePauseUntilToDisk(accountId, until) {
    const filePath = resolveWeixinSessionPausePath(accountId);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify({ until }, null, 2)}\n`, "utf-8");
    try {
        fs.chmodSync(filePath, 0o600);
    }
    catch {
        // ignore
    }
}
function unlinkPauseFile(accountId) {
    const filePath = resolveWeixinSessionPausePath(accountId);
    try {
        if (!fs.existsSync(filePath))
            return false;
        fs.unlinkSync(filePath);
        return true;
    }
    catch {
        return false;
    }
}
/** Pause all inbound/outbound API calls for `accountId` for one hour (persisted for cross-process visibility). */
export function pauseSession(accountId) {
    const until = Date.now() + SESSION_PAUSE_DURATION_MS;
    const canonical = normalizeAccountId(accountId);
    writePauseUntilToDisk(canonical, until);
    for (const id of linkedPauseAccountIds(accountId)) {
        if (id === canonical)
            continue;
        unlinkPauseFile(id);
    }
    logger.info(`session-guard: paused accountId=${canonical} until=${new Date(until).toISOString()} (${SESSION_PAUSE_DURATION_MS / 1000}s, persisted)`);
}
/** Clear cooldown after successful re-login / token refresh (CLI or gateway); clears persisted pause file(s). */
export function resumeSession(accountId) {
    let cleared = false;
    for (const id of linkedPauseAccountIds(accountId)) {
        if (unlinkPauseFile(id)) {
            cleared = true;
        }
    }
    if (cleared) {
        logger.info(`session-guard: resumed accountId=${normalizeAccountId(accountId)} (pause file cleared)`);
    }
}
/** Returns `true` when the bot is still within its one-hour cooldown window. */
export function isSessionPaused(accountId) {
    return getRemainingPauseMs(accountId) > 0;
}
/** Milliseconds remaining until the pause expires (0 when not paused). */
export function getRemainingPauseMs(accountId) {
    let maxUntil;
    for (const id of linkedPauseAccountIds(accountId)) {
        const until = readPauseUntilFromDisk(id);
        if (until !== undefined && (maxUntil === undefined || until > maxUntil)) {
            maxUntil = until;
        }
    }
    if (maxUntil === undefined)
        return 0;
    const remaining = maxUntil - Date.now();
    if (remaining <= 0) {
        for (const id of linkedPauseAccountIds(accountId)) {
            unlinkPauseFile(id);
        }
        return 0;
    }
    return remaining;
}
/** Throw if the session is currently paused. Call before any API request. */
export function assertSessionActive(accountId) {
    if (isSessionPaused(accountId)) {
        const remainingMin = Math.ceil(getRemainingPauseMs(accountId) / 60_000);
        throw new Error(`session paused for accountId=${accountId}, ${remainingMin} min remaining (errcode ${SESSION_EXPIRED_ERRCODE})`);
    }
}
/**
 * Reset persisted pause files for test accounts — tests must use OPENCLAW_STATE_DIR temp dirs.
 * @internal
 */
export function _resetForTest(accountIds = ["acc1", "acc2", "ghost"]) {
    for (const id of accountIds) {
        resumeSession(id);
    }
}
//# sourceMappingURL=session-guard.js.map