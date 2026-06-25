import fs from "node:fs";
import path from "node:path";
import { getUpdates } from "../api/api.js";
import { WeixinConfigManager } from "../api/config-cache.js";
import { SESSION_EXPIRED_ERRCODE, pauseSession, resumeSession, getRemainingPauseMs, isSessionPaused, } from "../api/session-guard.js";
import { loadWeixinAccount, resolveWeixinAccount } from "../auth/accounts.js";
import { processOneMessage } from "../messaging/process-message.js";
import { resolveWeixinChannelRuntime } from "../runtime.js";
import { clearPersistedGetUpdatesBufForAccount, getSyncBufFilePath, loadGetUpdatesBuf, saveGetUpdatesBuf, shouldDiscardPersistedSyncBufForStaleCredentials, } from "../storage/sync-buf.js";
import { resolveStateDir } from "../storage/state-dir.js";
import { formatFetchRelatedError } from "../util/fetch-error.js";
import { logger } from "../util/logger.js";
import { redactBody } from "../util/redact.js";
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;
/** While session cooldown is active, wake periodically so gateway health sees liveness and re-login can shorten wait. */
const SESSION_PAUSE_HEARTBEAT_MS = 10_000;
/**
 * Most `-14` responses recover after clearing `get_updates_buf` + disk sync (new token + stale cursor).
 * Only enter the long pause after several failures — avoids useless “60 min” stalls after QR login.
 */
const SESSION_EXPIRY_RECOVERY_ATTEMPTS_BEFORE_PAUSE = 8;
const SESSION_EXPIRY_RETRY_MS = 1_500;
function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => {
            clearTimeout(t);
            reject(new Error("aborted"));
        }, { once: true });
    });
}
function normalizeApiErrCode(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === "string" && value.trim() !== "") {
        const n = Number(value.trim());
        return Number.isFinite(n) ? n : undefined;
    }
    return undefined;
}
function resolveWeixinAccountCredentialPath(accountId) {
    return path.join(resolveStateDir(), "openclaw-weixin", "accounts", `${accountId.trim()}.json`);
}
/** Brief pause when credentials were just written — avoids reading stale JSON over slow mounts. */
async function maybeDelayAfterFreshCredentialWrite(accountId, abortSignal) {
    try {
        const p = resolveWeixinAccountCredentialPath(accountId);
        if (!fs.existsSync(p))
            return;
        const ageMs = Date.now() - fs.statSync(p).mtimeMs;
        if (ageMs >= 0 && ageMs < 5000) {
            await sleep(900, abortSignal);
        }
    }
    catch {
        /* ignore */
    }
}
/** Merge disk credentials the same way as gateway `resolveAccount` (channel plugin contract). */
function resolveLiveWeixinApiCredentials(cfg, accountId, fallback) {
    try {
        const resolved = resolveWeixinAccount(cfg, accountId);
        return {
            baseUrl: resolved.baseUrl?.trim() || fallback.baseUrl,
            token: resolved.token?.trim() || fallback.token,
        };
    }
    catch (err) {
        logger.warn(`resolveLiveWeixinApiCredentials: resolveWeixinAccount failed id=${accountId} err=${String(err)}`);
        const live = loadWeixinAccount(accountId);
        return {
            baseUrl: live?.baseUrl?.trim() || fallback.baseUrl,
            token: live?.token?.trim() || fallback.token,
        };
    }
}
/**
 * Long-poll loop: getUpdates -> normalize -> recordInboundSession -> dispatchReplyFromConfig.
 * Runs until abort.
 */
export async function monitorWeixinProvider(opts) {
    const { baseUrl, cdnBaseUrl, token, accountId, config, abortSignal, longPollTimeoutMs, setStatus, } = opts;
    const log = opts.runtime?.log ?? (() => { });
    const errLog = opts.runtime?.error ?? ((m) => log(m));
    const aLog = logger.withAccount(accountId);
    aLog.info(`resolving Weixin channel runtime (gateway-injected preferred)...`);
    let channelRuntime;
    try {
        channelRuntime = await resolveWeixinChannelRuntime({
            channelRuntime: opts.channelRuntime,
        });
        aLog.info(`Weixin channel runtime acquired, channelRuntime type: ${typeof channelRuntime}`);
    }
    catch (err) {
        aLog.error(`resolveWeixinChannelRuntime() failed: ${String(err)}`);
        throw err;
    }
    const bootApi = resolveLiveWeixinApiCredentials(config, accountId, { baseUrl, token });
    log(`weixin monitor started (${bootApi.baseUrl}, account=${accountId})`);
    aLog.info(`Monitor started: baseUrl=${bootApi.baseUrl} timeoutMs=${longPollTimeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS}`);
    const syncFilePath = getSyncBufFilePath(accountId);
    aLog.debug(`syncFilePath: ${syncFilePath}`);
    const previousGetUpdatesBuf = loadGetUpdatesBuf(syncFilePath);
    let getUpdatesBuf = previousGetUpdatesBuf ?? "";
    if (shouldDiscardPersistedSyncBufForStaleCredentials(accountId)) {
        getUpdatesBuf = "";
        clearPersistedGetUpdatesBufForAccount(accountId);
        log(`[weixin] credential newer than sync cursor — cleared stale get_updates_buf`);
        aLog.info(`discarded persisted sync buf (credential newer than cursor; avoids errcode -14)`);
    }
    else if (previousGetUpdatesBuf) {
        log(`[weixin] resuming from previous sync buf (${getUpdatesBuf.length} bytes)`);
        aLog.debug(`Using previous get_updates_buf (${getUpdatesBuf.length} bytes)`);
    }
    else {
        log(`[weixin] no previous sync buf, starting fresh`);
        aLog.info(`No previous get_updates_buf found, starting fresh`);
    }
    const configManager = new WeixinConfigManager(() => resolveLiveWeixinApiCredentials(config, accountId, { baseUrl, token }), log);
    let nextTimeoutMs = longPollTimeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
    let consecutiveFailures = 0;
    /** Detect token/baseUrl refresh from disk (e.g. CLI QR login) — stale cursor + new token yields errcode -14. */
    let credentialFingerprint = "";
    /** Counts `-14` streak without a successful poll — cleared on success or credential change. */
    let sessionExpiryRecoveryAttempts = 0;
    /**
     * Per-message-id dedup. The -14 recovery path clears get_updates_buf and the
     * next long-poll replays any messages the server still considers unread, so
     * the same message can land in processOneMessage twice and each replay would
     * otherwise create a fresh session + reply. We remember recent message keys
     * for a short TTL to short-circuit replays without resorting to disk state.
     */
    const seenMessageKeys = new Map();
    const SEEN_MESSAGE_TTL_MS = 10 * 60_000;
    const SEEN_MESSAGE_MAX_ENTRIES = 1000;
    const resolveSeenMessageKey = (full) => {
        if (typeof full.message_id === "number" && Number.isFinite(full.message_id)) {
            return `id:${full.message_id}`;
        }
        if (typeof full.seq === "number" && Number.isFinite(full.seq)) {
            return `seq:${full.seq}`;
        }
        if (full.from_user_id && typeof full.create_time_ms === "number") {
            return `t:${full.from_user_id}:${full.create_time_ms}`;
        }
        return undefined;
    };
    const recordSeenMessageKey = (key, now) => {
        if (seenMessageKeys.size >= SEEN_MESSAGE_MAX_ENTRIES) {
            const oldestKey = seenMessageKeys.keys().next().value;
            if (oldestKey !== undefined) {
                seenMessageKeys.delete(oldestKey);
            }
        }
        seenMessageKeys.set(key, now);
    };
    const pruneSeenMessageKeys = (now) => {
        for (const [k, ts] of seenMessageKeys) {
            if (now - ts > SEEN_MESSAGE_TTL_MS) {
                seenMessageKeys.delete(k);
            }
            else {
                break;
            }
        }
    };
    /** First iteration only — settle credentials file visibility after QR login + channels.start. */
    let appliedFreshCredentialDelay = false;
    while (!abortSignal?.aborted) {
        try {
            if (!appliedFreshCredentialDelay) {
                appliedFreshCredentialDelay = true;
                await maybeDelayAfterFreshCredentialWrite(accountId, abortSignal);
            }
            const api = resolveLiveWeixinApiCredentials(config, accountId, { baseUrl, token });
            const fp = `${api.baseUrl}\0${api.token ?? ""}`;
            if (credentialFingerprint !== "" && fp !== credentialFingerprint) {
                getUpdatesBuf = "";
                clearPersistedGetUpdatesBufForAccount(accountId);
                sessionExpiryRecoveryAttempts = 0;
                aLog.info(`credentials changed on disk for accountId=${accountId}, cleared get_updates_buf (avoid -14 after re-login)`);
            }
            credentialFingerprint = fp;
            if (!api.token?.trim()) {
                aLog.warn(`getUpdates: missing bot token on disk/config for accountId=${accountId} — expect errcode -14`);
            }
            aLog.debug(`getUpdates: get_updates_buf=${getUpdatesBuf.substring(0, 50)}..., timeoutMs=${nextTimeoutMs}`);
            const resp = await getUpdates({
                baseUrl: api.baseUrl,
                token: api.token,
                get_updates_buf: getUpdatesBuf,
                timeoutMs: nextTimeoutMs,
                abortSignal,
            });
            aLog.debug(`getUpdates response: ret=${resp.ret}, msgs=${resp.msgs?.length ?? 0}, get_updates_buf_length=${resp.get_updates_buf?.length ?? 0}`);
            if (resp.longpolling_timeout_ms != null && resp.longpolling_timeout_ms > 0) {
                nextTimeoutMs = resp.longpolling_timeout_ms;
                aLog.debug(`Updated next poll timeout: ${nextTimeoutMs}ms`);
            }
            const retNum = normalizeApiErrCode(resp.ret);
            const errNum = normalizeApiErrCode(resp.errcode);
            const isApiError = (retNum !== undefined && retNum !== 0) || (errNum !== undefined && errNum !== 0);
            if (isApiError) {
                const isSessionExpired = errNum === SESSION_EXPIRED_ERRCODE || retNum === SESSION_EXPIRED_ERRCODE;
                if (isSessionExpired) {
                    resumeSession(accountId);
                    getUpdatesBuf = "";
                    clearPersistedGetUpdatesBufForAccount(accountId);
                    sessionExpiryRecoveryAttempts += 1;
                    if (sessionExpiryRecoveryAttempts <= SESSION_EXPIRY_RECOVERY_ATTEMPTS_BEFORE_PAUSE) {
                        errLog(`weixin getUpdates: accountId=${accountId} errcode -14 base=${api.baseUrl} tokenLen=${api.token?.length ?? 0} errmsg=${resp.errmsg ?? ""} — cleared sync cursor, retry ${sessionExpiryRecoveryAttempts}/${SESSION_EXPIRY_RECOVERY_ATTEMPTS_BEFORE_PAUSE} (${SESSION_EXPIRY_RETRY_MS}ms)`);
                        aLog.warn(`getUpdates: session/expiry mismatch base=${api.baseUrl} errmsg=${resp.errmsg ?? ""} (errcode=${String(resp.errcode)} ret=${String(resp.ret)}); cleared cursor`);
                        consecutiveFailures = 0;
                        await sleep(SESSION_EXPIRY_RETRY_MS, abortSignal);
                        continue;
                    }
                    sessionExpiryRecoveryAttempts = 0;
                    pauseSession(accountId);
                    const pauseMs = getRemainingPauseMs(accountId);
                    errLog(`weixin getUpdates: accountId=${accountId} errcode -14 persists after ${SESSION_EXPIRY_RECOVERY_ATTEMPTS_BEFORE_PAUSE} cursor resets base=${api.baseUrl} tokenLen=${api.token?.length ?? 0} errmsg=${resp.errmsg ?? ""} — backing off ~${Math.ceil(pauseMs / 60_000)} min (run: openclaw channels login --channel openclaw-weixin; ensure OPENCLAW_STATE_DIR matches gateway)`);
                    aLog.error(`getUpdates: persistent -14 base=${api.baseUrl} errmsg=${resp.errmsg ?? ""} (errcode=${resp.errcode} ret=${resp.ret})`);
                    consecutiveFailures = 0;
                    await sleepWhileSessionPaused({
                        accountId,
                        abortSignal,
                        setStatus,
                        aLog,
                    });
                    continue;
                }
                consecutiveFailures += 1;
                errLog(`weixin getUpdates failed: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ""} (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`);
                aLog.error(`getUpdates failed: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg} response=${redactBody(JSON.stringify(resp))}`);
                if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                    errLog(`weixin getUpdates: ${MAX_CONSECUTIVE_FAILURES} consecutive failures, backing off 30s`);
                    aLog.error(`getUpdates: ${MAX_CONSECUTIVE_FAILURES} consecutive failures, backing off 30s`);
                    consecutiveFailures = 0;
                    await sleep(BACKOFF_DELAY_MS, abortSignal);
                }
                else {
                    await sleep(RETRY_DELAY_MS, abortSignal);
                }
                continue;
            }
            consecutiveFailures = 0;
            sessionExpiryRecoveryAttempts = 0;
            setStatus?.({ accountId, lastEventAt: Date.now() });
            if (resp.get_updates_buf != null && resp.get_updates_buf !== "") {
                saveGetUpdatesBuf(syncFilePath, resp.get_updates_buf);
                getUpdatesBuf = resp.get_updates_buf;
                aLog.debug(`Saved new get_updates_buf (${getUpdatesBuf.length} bytes)`);
            }
            const list = resp.msgs ?? [];
            for (const full of list) {
                aLog.info(`inbound message: from=${full.from_user_id} types=${full.item_list?.map((i) => i.type).join(",") ?? "none"}`);
                const now = Date.now();
                setStatus?.({ accountId, lastEventAt: now, lastInboundAt: now });
                pruneSeenMessageKeys(now);
                const seenKey = resolveSeenMessageKey(full);
                if (seenKey !== undefined && seenMessageKeys.has(seenKey)) {
                    aLog.warn(`skipping duplicate inbound message (key=${seenKey}) — likely -14 cursor replay`);
                    continue;
                }
                if (seenKey !== undefined) {
                    recordSeenMessageKey(seenKey, now);
                }
                // allowFrom filtering is delegated to processOneMessage via the framework
                // authorization pipeline (resolveSenderCommandAuthorizationWithRuntime).
                const fromUserId = full.from_user_id ?? "";
                const cachedConfig = await configManager.getForUser(fromUserId, full.context_token);
                await processOneMessage(full, {
                    accountId,
                    config,
                    channelRuntime,
                    baseUrl: api.baseUrl,
                    cdnBaseUrl,
                    token: api.token,
                    typingTicket: cachedConfig.typingTicket,
                    log: opts.runtime?.log ?? (() => { }),
                    errLog,
                });
            }
        }
        catch (err) {
            if (abortSignal?.aborted) {
                aLog.info(`Monitor stopped (aborted)`);
                return;
            }
            consecutiveFailures += 1;
            const detail = formatFetchRelatedError(err);
            errLog(`weixin getUpdates error (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${detail}`);
            aLog.error(`getUpdates error: ${detail}, stack=${err.stack}`);
            if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                errLog(`weixin getUpdates: ${MAX_CONSECUTIVE_FAILURES} consecutive failures, backing off 30s`);
                aLog.error(`getUpdates: ${MAX_CONSECUTIVE_FAILURES} consecutive failures, backing off 30s`);
                consecutiveFailures = 0;
                await sleep(30_000, abortSignal);
            }
            else {
                await sleep(2000, abortSignal);
            }
        }
    }
    aLog.info(`Monitor ended`);
}
async function sleepWhileSessionPaused(params) {
    const { accountId, abortSignal, setStatus, aLog } = params;
    while (isSessionPaused(accountId)) {
        setStatus?.({ accountId, lastEventAt: Date.now() });
        const remaining = getRemainingPauseMs(accountId);
        if (remaining <= 0) {
            break;
        }
        const slice = Math.min(SESSION_PAUSE_HEARTBEAT_MS, remaining);
        try {
            await sleep(slice, abortSignal);
        }
        catch {
            return;
        }
    }
    if (!isSessionPaused(accountId)) {
        aLog.info(`session pause cleared or expired, resuming getUpdates for accountId=${accountId}`);
    }
}
//# sourceMappingURL=monitor.js.map