import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfigRouteTag } from "../auth/accounts.js";
import { logger } from "../util/logger.js";
import { redactBody, redactUrl } from "../util/redact.js";
function readPackageJson() {
    try {
        const dir = path.dirname(fileURLToPath(import.meta.url));
        const pkgPath = path.resolve(dir, "..", "..", "package.json");
        return JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    }
    catch {
        return {};
    }
}
const pkg = readPackageJson();
const CHANNEL_VERSION = pkg.version ?? "unknown";
/** iLink-App-Id: 直接读取 package.json 顶层 ilink_appid 字段。 */
const ILINK_APP_ID = pkg.ilink_appid ?? "";
/**
 * iLink-App-ClientVersion: uint32 encoded as 0x00MMNNPP
 * High 8 bits fixed to 0; remaining bits: major<<16 | minor<<8 | patch.
 * e.g. "1.0.11" -> 0x0001000B = 65547
 */
function buildClientVersion(version) {
    const parts = version.split(".").map((p) => parseInt(p, 10));
    const major = parts[0] ?? 0;
    const minor = parts[1] ?? 0;
    const patch = parts[2] ?? 0;
    return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}
const ILINK_APP_CLIENT_VERSION = buildClientVersion(pkg.version ?? "0.0.0");
/** Build the `base_info` payload included in every API request. */
export function buildBaseInfo() {
    return { channel_version: CHANNEL_VERSION };
}
/** Default timeout for long-poll getUpdates requests. */
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
/** Default timeout for regular API requests (sendMessage, getUploadUrl). */
const DEFAULT_API_TIMEOUT_MS = 15_000;
/** Default timeout for lightweight API requests (getConfig, sendTyping). */
const DEFAULT_CONFIG_TIMEOUT_MS = 10_000;
function ensureTrailingSlash(url) {
    return url.endsWith("/") ? url : `${url}/`;
}
/** X-WECHAT-UIN header: random uint32 -> decimal string -> base64. */
function randomWechatUin() {
    const uint32 = crypto.randomBytes(4).readUInt32BE(0);
    return Buffer.from(String(uint32), "utf-8").toString("base64");
}
/** Build headers shared by both GET and POST requests. */
function buildCommonHeaders() {
    const headers = {
        "iLink-App-Id": ILINK_APP_ID,
        "iLink-App-ClientVersion": String(ILINK_APP_CLIENT_VERSION),
    };
    const routeTag = loadConfigRouteTag();
    if (routeTag) {
        headers.SKRouteTag = routeTag;
    }
    return headers;
}
function buildHeaders(opts) {
    const headers = {
        "Content-Type": "application/json",
        AuthorizationType: "ilink_bot_token",
        "Content-Length": String(Buffer.byteLength(opts.body, "utf-8")),
        "X-WECHAT-UIN": randomWechatUin(),
        ...buildCommonHeaders(),
    };
    if (opts.token?.trim()) {
        headers.Authorization = `Bearer ${opts.token.trim()}`;
    }
    logger.debug(`requestHeaders: ${JSON.stringify({ ...headers, Authorization: headers.Authorization ? "Bearer ***" : undefined })}`);
    return headers;
}
/**
 * GET fetch wrapper: send a GET request to a Weixin API endpoint.
 * When `timeoutMs` is set, the request is aborted after that many milliseconds.
 * Query parameters should already be encoded in `endpoint`.
 * Returns the raw response text on success; throws on HTTP error or (if used) timeout abort.
 */
export async function apiGetFetch(params) {
    const base = ensureTrailingSlash(params.baseUrl);
    const url = new URL(params.endpoint, base);
    const hdrs = buildCommonHeaders();
    logger.debug(`GET ${redactUrl(url.toString())}`);
    const timeoutMs = params.timeoutMs;
    const controller = timeoutMs != null && timeoutMs > 0 ? new AbortController() : undefined;
    const t = controller != null && timeoutMs != null
        ? setTimeout(() => controller.abort(), timeoutMs)
        : undefined;
    try {
        const res = await fetch(url.toString(), {
            method: "GET",
            headers: hdrs,
            ...(controller ? { signal: controller.signal } : {}),
        });
        if (t !== undefined)
            clearTimeout(t);
        const rawText = await res.text();
        logger.debug(`${params.label} status=${res.status} raw=${redactBody(rawText)}`);
        if (!res.ok) {
            throw new Error(`${params.label} ${res.status}: ${rawText}`);
        }
        return rawText;
    }
    catch (err) {
        if (t !== undefined)
            clearTimeout(t);
        throw err;
    }
}
function createAbortError(message) {
    const err = new Error(message);
    err.name = "AbortError";
    return err;
}
/**
 * POST JSON via Node core http/https (not global `fetch`).
 *
 * Some peers respond with headers that fail undici's strict validation:
 * `InvalidArgumentError: invalid content-length header` (UND_ERR_INVALID_ARG).
 */
function postViaNativeHttp(url, headers, bodyUtf8, timeoutMs, abortSignal, label) {
    if (abortSignal?.aborted) {
        return Promise.reject(createAbortError("Aborted"));
    }
    const bodyBuf = Buffer.from(bodyUtf8, "utf-8");
    const isHttps = url.protocol === "https:";
    if (!isHttps && url.protocol !== "http:") {
        return Promise.reject(new Error(`${label}: unsupported URL scheme ${url.protocol}`));
    }
    const lib = isHttps ? https : http;
    const defaultPort = isHttps ? 443 : 80;
    return new Promise((resolve, reject) => {
        let settled = false;
        let timeoutTimer;
        let req;
        const cleanup = () => {
            if (timeoutTimer !== undefined) {
                clearTimeout(timeoutTimer);
                timeoutTimer = undefined;
            }
            abortSignal?.removeEventListener("abort", onAbort);
        };
        const finalizeReject = (err) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            reject(err);
        };
        const finalizeResolve = (v) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            resolve(v);
        };
        const onAbort = () => {
            req?.destroy(createAbortError("Aborted"));
        };
        abortSignal?.addEventListener("abort", onAbort, { once: true });
        req = lib.request({
            hostname: url.hostname,
            port: url.port ? Number(url.port) : defaultPort,
            path: `${url.pathname}${url.search}`,
            method: "POST",
            headers,
        }, (res) => {
            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("error", (e) => finalizeReject(e));
            res.on("end", () => {
                try {
                    const rawText = Buffer.concat(chunks).toString("utf-8");
                    logger.debug(`${label} status=${res.statusCode} raw=${redactBody(rawText)}`);
                    const code = res.statusCode ?? 0;
                    if (code >= 400) {
                        finalizeReject(new Error(`${label} ${code}: ${rawText}`));
                        return;
                    }
                    finalizeResolve(rawText);
                }
                catch (e) {
                    finalizeReject(e);
                }
            });
        });
        req.on("error", (e) => finalizeReject(e));
        timeoutTimer = setTimeout(() => {
            req?.destroy(createAbortError("Request timeout"));
        }, timeoutMs);
        req.write(bodyBuf);
        req.end();
    });
}
/**
 * POST JSON to a Weixin API endpoint with timeout + optional gateway abort.
 */
async function apiPostFetch(params) {
    const base = ensureTrailingSlash(params.baseUrl);
    const url = new URL(params.endpoint, base);
    const hdrs = buildHeaders({ token: params.token, body: params.body });
    logger.debug(`POST ${redactUrl(url.toString())} body=${redactBody(params.body)}`);
    return postViaNativeHttp(url, hdrs, params.body, params.timeoutMs, params.abortSignal, params.label);
}
/**
 * Long-poll getUpdates. Server should hold the request until new messages or timeout.
 *
 * On client-side timeout (no server response within timeoutMs), returns an empty response
 * with ret=0 so the caller can simply retry. This is normal for long-poll.
 */
export async function getUpdates(params) {
    const timeout = params.timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
    try {
        const buf = params.get_updates_buf ?? "";
        const payload = {
            base_info: buildBaseInfo(),
        };
        // First poll after QR bind: many gateways treat omitted cursor differently from "".
        if (buf.length > 0) {
            payload.get_updates_buf = buf;
            payload.sync_buf = buf;
        }
        const rawText = await apiPostFetch({
            baseUrl: params.baseUrl,
            endpoint: "ilink/bot/getupdates",
            body: JSON.stringify(payload),
            token: params.token,
            timeoutMs: timeout,
            label: "getUpdates",
            abortSignal: params.abortSignal,
        });
        const resp = JSON.parse(rawText);
        return resp;
    }
    catch (err) {
        if (params.abortSignal?.aborted) {
            throw err;
        }
        // Long-poll timeout is normal; return empty response so caller can retry
        if (err instanceof Error && err.name === "AbortError") {
            logger.debug(`getUpdates: client-side timeout after ${timeout}ms, returning empty response`);
            return { ret: 0, msgs: [], get_updates_buf: params.get_updates_buf };
        }
        throw err;
    }
}
/** Get a pre-signed CDN upload URL for a file. */
export async function getUploadUrl(params) {
    const rawText = await apiPostFetch({
        baseUrl: params.baseUrl,
        endpoint: "ilink/bot/getuploadurl",
        body: JSON.stringify({
            filekey: params.filekey,
            media_type: params.media_type,
            to_user_id: params.to_user_id,
            rawsize: params.rawsize,
            rawfilemd5: params.rawfilemd5,
            filesize: params.filesize,
            thumb_rawsize: params.thumb_rawsize,
            thumb_rawfilemd5: params.thumb_rawfilemd5,
            thumb_filesize: params.thumb_filesize,
            no_need_thumb: params.no_need_thumb,
            aeskey: params.aeskey,
            base_info: buildBaseInfo(),
        }),
        token: params.token,
        timeoutMs: params.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
        label: "getUploadUrl",
    });
    const resp = JSON.parse(rawText);
    return resp;
}
/** Send a single message downstream. */
export async function sendMessage(params) {
    await apiPostFetch({
        baseUrl: params.baseUrl,
        endpoint: "ilink/bot/sendmessage",
        body: JSON.stringify({ ...params.body, base_info: buildBaseInfo() }),
        token: params.token,
        timeoutMs: params.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
        label: "sendMessage",
    });
}
/** Fetch bot config (includes typing_ticket) for a given user. */
export async function getConfig(params) {
    const rawText = await apiPostFetch({
        baseUrl: params.baseUrl,
        endpoint: "ilink/bot/getconfig",
        body: JSON.stringify({
            ilink_user_id: params.ilinkUserId,
            context_token: params.contextToken,
            base_info: buildBaseInfo(),
        }),
        token: params.token,
        timeoutMs: params.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
        label: "getConfig",
    });
    const resp = JSON.parse(rawText);
    return resp;
}
/** Send a typing indicator to a user. */
export async function sendTyping(params) {
    await apiPostFetch({
        baseUrl: params.baseUrl,
        endpoint: "ilink/bot/sendtyping",
        body: JSON.stringify({ ...params.body, base_info: buildBaseInfo() }),
        token: params.token,
        timeoutMs: params.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
        label: "sendTyping",
    });
}
//# sourceMappingURL=api.js.map