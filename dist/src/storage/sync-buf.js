import fs from "node:fs";
import path from "node:path";
import { deriveRawAccountId } from "../auth/accounts.js";
import { resolveStateDir } from "./state-dir.js";
function resolveAccountsDir() {
    return path.join(resolveStateDir(), "openclaw-weixin", "accounts");
}
/**
 * Path to the persistent get_updates_buf file for an account.
 * Stored alongside account data: ~/.openclaw/openclaw-weixin/accounts/{accountId}.sync.json
 */
export function getSyncBufFilePath(accountId) {
    return path.join(resolveAccountsDir(), `${accountId}.sync.json`);
}
/** Legacy single-account syncbuf (pre multi-account): `.openclaw-weixin-sync/default.json`. */
export function getLegacySyncBufDefaultJsonPath() {
    return path.join(resolveStateDir(), "agents", "default", "sessions", ".openclaw-weixin-sync", "default.json");
}
/** Paths where sync cursor might live for this logical account (primary, compat raw-id, legacy). */
export function listSyncBufCandidatePaths(accountId) {
    const id = accountId.trim();
    const paths = [getSyncBufFilePath(id)];
    const rawId = deriveRawAccountId(id);
    if (rawId) {
        paths.push(path.join(resolveAccountsDir(), `${rawId}.sync.json`));
    }
    paths.push(getLegacySyncBufDefaultJsonPath());
    return paths;
}
/** Best-effort mtime from persisted credential JSON(s) — bumps on QR login / token save. */
export function getWeixinAccountCredentialRevisionMs(accountId) {
    const id = accountId.trim();
    if (!id)
        return 0;
    let max = 0;
    const candidates = [path.join(resolveAccountsDir(), `${id}.json`)];
    const rawId = deriveRawAccountId(id);
    if (rawId) {
        candidates.push(path.join(resolveAccountsDir(), `${rawId}.json`));
    }
    for (const filePath of candidates) {
        try {
            if (!fs.existsSync(filePath))
                continue;
            max = Math.max(max, fs.statSync(filePath).mtimeMs);
            const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
            const savedMs = parsed.savedAt ? Date.parse(parsed.savedAt) : Number.NaN;
            if (!Number.isNaN(savedMs)) {
                max = Math.max(max, savedMs);
            }
        }
        catch {
            // ignore
        }
    }
    return max;
}
/** Latest mtime among primary + compat sync cursor files (not legacy singleton — avoids cross-account skew). */
function getPerAccountSyncCursorMaxMtimeMs(accountId) {
    let max = 0;
    const id = accountId.trim();
    const paths = [getSyncBufFilePath(id)];
    const rawId = deriveRawAccountId(id);
    if (rawId) {
        paths.push(path.join(resolveAccountsDir(), `${rawId}.sync.json`));
    }
    for (const fp of paths) {
        try {
            if (fs.existsSync(fp)) {
                max = Math.max(max, fs.statSync(fp).mtimeMs);
            }
        }
        catch {
            // ignore
        }
    }
    return max;
}
/** Max mtime among per-account sync files plus legacy singleton (same ordering as load fallback). */
export function getEffectiveSyncCursorMaxMtimeMs(accountId) {
    let legacyMs = 0;
    try {
        const lp = getLegacySyncBufDefaultJsonPath();
        if (fs.existsSync(lp)) {
            legacyMs = fs.statSync(lp).mtimeMs;
        }
    }
    catch {
        // ignore
    }
    return Math.max(getPerAccountSyncCursorMaxMtimeMs(accountId.trim()), legacyMs);
}
/**
 * When credentials were saved/relogged after sync cursor files were last touched,
 * continuing long-poll with that cursor yields errcode -14 against the new token.
 */
export function shouldDiscardPersistedSyncBufForStaleCredentials(accountId) {
    const credRev = getWeixinAccountCredentialRevisionMs(accountId.trim());
    if (credRev <= 0) {
        return false;
    }
    const syncRev = getEffectiveSyncCursorMaxMtimeMs(accountId);
    return credRev > syncRev;
}
function readSyncBufFile(filePath) {
    try {
        const raw = fs.readFileSync(filePath, "utf-8");
        const data = JSON.parse(raw);
        if (typeof data.get_updates_buf === "string") {
            return data.get_updates_buf;
        }
    }
    catch {
        // file not found or invalid
    }
    return undefined;
}
/**
 * Load persisted get_updates_buf.
 * Falls back in order:
 *   1. Primary path (normalized accountId, new installs)
 *   2. Compat path (raw accountId derived from pattern, old installs)
 *   3. Legacy single-account path (very old installs without multi-account support)
 */
export function loadGetUpdatesBuf(filePath) {
    const value = readSyncBufFile(filePath);
    if (value !== undefined)
        return value;
    // Compat: if given path uses a normalized accountId (e.g. "b0f5860fdecb-im-bot.sync.json"),
    // also try the old raw-ID filename (e.g. "b0f5860fdecb@im.bot.sync.json").
    const accountId = path.basename(filePath, ".sync.json");
    const rawId = deriveRawAccountId(accountId);
    if (rawId) {
        const compatPath = path.join(resolveAccountsDir(), `${rawId}.sync.json`);
        const compatValue = readSyncBufFile(compatPath);
        if (compatValue !== undefined)
            return compatValue;
    }
    // Legacy fallback: old single-account installs stored syncbuf without accountId.
    return readSyncBufFile(getLegacySyncBufDefaultJsonPath());
}
/**
 * Persist get_updates_buf. Creates parent dir if needed.
 */
export function saveGetUpdatesBuf(filePath, getUpdatesBuf) {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ get_updates_buf: getUpdatesBuf }, null, 0), "utf-8");
}
/**
 * Drop persisted long-poll cursor for this account so the next monitor uses an empty
 * `get_updates_buf`. Call after re-login / token refresh — stale buf + new token often yields errcode -14.
 */
export function clearPersistedGetUpdatesBufForAccount(accountId) {
    const id = accountId.trim();
    if (!id) {
        return;
    }
    const paths = listSyncBufCandidatePaths(id);
    for (const fp of paths) {
        try {
            fs.unlinkSync(fp);
        }
        catch {
            // ENOENT or permission — ignore
        }
    }
}
//# sourceMappingURL=sync-buf.js.map