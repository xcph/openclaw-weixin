import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/infra-runtime";

/**
 * Plugin logger — writes JSON lines to the main openclaw log file:
 *   <tmpDir>/openclaw-YYYY-MM-DD.log
 * Same file and format used by all other channels.
 */

const MAIN_LOG_DIR = resolvePreferredOpenClawTmpDir();
const SUBSYSTEM = "gateway/channels/openclaw-weixin";
const RUNTIME = "node";
const RUNTIME_VERSION = process.versions.node;
const HOSTNAME = os.hostname() || "unknown";
const PARENT_NAMES = ["openclaw"];

/** tslog-compatible level IDs (higher = more severe). */
const LEVEL_IDS: Record<string, number> = {
  TRACE: 1,
  DEBUG: 2,
  INFO: 3,
  WARN: 4,
  ERROR: 5,
  FATAL: 6,
};

const DEFAULT_LOG_LEVEL = "INFO";

/** Env: absolute path or `~/…` — mirror every weixin plugin log line here (all levels, plaintext). */
const ENV_VERBOSE_LOG = process.env.OPENCLAW_WEIXIN_LOG_FILE?.trim();

function resolveMinLevel(): number {
  const env = process.env.OPENCLAW_LOG_LEVEL?.toUpperCase();
  if (env && env in LEVEL_IDS) return LEVEL_IDS[env];
  return LEVEL_IDS[DEFAULT_LOG_LEVEL];
}

let minLevelId = resolveMinLevel();

let verboseMirrorPath: string | undefined = ENV_VERBOSE_LOG
  ? expandUserPath(ENV_VERBOSE_LOG)
  : undefined;

function expandUserPath(p: string): string {
  const t = p.trim();
  if (t.startsWith("~/") || t === "~") {
    return path.join(os.homedir(), t === "~" ? "" : t.slice(2));
  }
  return t;
}

/**
 * Optional dedicated plaintext log for the weixin channel (all levels, regardless of
 * `OPENCLAW_LOG_LEVEL`). Use `OPENCLAW_WEIXIN_LOG_FILE` or `channels.openclaw-weixin.verboseLogFile`.
 */
export function setWeixinVerboseLogFilePath(filePath: string | undefined): void {
  verboseMirrorPath = filePath?.trim() ? expandUserPath(filePath) : undefined;
}

/** Read `verboseLogFile` from config and apply; call when the monitor starts or config reloads. */
export function configureWeixinChannelLoggingFromConfig(
  cfg: { channels?: Record<string, unknown> } | undefined,
): void {
  const fromEnv = ENV_VERBOSE_LOG ? expandUserPath(ENV_VERBOSE_LOG) : undefined;
  if (fromEnv) {
    verboseMirrorPath = fromEnv;
    return;
  }
  const section = cfg?.channels?.["openclaw-weixin"];
  if (!section || typeof section !== "object") {
    verboseMirrorPath = undefined;
    return;
  }
  const raw = (section as { verboseLogFile?: unknown }).verboseLogFile;
  if (typeof raw === "string" && raw.trim()) {
    verboseMirrorPath = expandUserPath(raw);
  } else {
    verboseMirrorPath = undefined;
  }
}

/** Dynamically change the minimum log level at runtime. */
export function setLogLevel(level: string): void {
  const upper = level.toUpperCase();
  if (!(upper in LEVEL_IDS)) {
    throw new Error(`Invalid log level: ${level}. Valid levels: ${Object.keys(LEVEL_IDS).join(", ")}`);
  }
  minLevelId = LEVEL_IDS[upper];
}

/** Shift a Date into local time so toISOString() renders local clock digits. */
function toLocalISO(now: Date): string {
  const offsetMs = -now.getTimezoneOffset() * 60_000;
  const sign = offsetMs >= 0 ? "+" : "-";
  const abs = Math.abs(now.getTimezoneOffset());
  const offStr = `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  return new Date(now.getTime() + offsetMs).toISOString().replace("Z", offStr);
}

function localDateKey(now: Date): string {
  return toLocalISO(now).slice(0, 10);
}

function resolveMainLogPath(): string {
  const dateKey = localDateKey(new Date());
  return path.join(MAIN_LOG_DIR, `openclaw-${dateKey}.log`);
}

let logDirEnsured = false;

export type Logger = {
  info(message: string): void;
  debug(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  /** Returns a child logger whose messages are prefixed with `[accountId]`. */
  withAccount(accountId: string): Logger;
  /** Returns the current main log file path. */
  getLogFilePath(): string;
  close(): void;
};

function buildLoggerName(accountId?: string): string {
  return accountId ? `${SUBSYSTEM}/${accountId}` : SUBSYSTEM;
}

function writeLog(level: string, message: string, accountId?: string): void {
  const levelId = LEVEL_IDS[level] ?? LEVEL_IDS.INFO;
  const now = new Date();
  const loggerName = buildLoggerName(accountId);
  const prefixedMessage = accountId ? `[${accountId}] ${message}` : message;

  const mirrorRaw = verboseMirrorPath?.trim();
  if (mirrorRaw) {
    const line =
      `${toLocalISO(now)}\t${level}\t${loggerName}\t${prefixedMessage.replace(/\r?\n/g, "\\n ")}\n`;
    try {
      fs.mkdirSync(path.dirname(mirrorRaw), { recursive: true });
      fs.appendFileSync(mirrorRaw, line, "utf-8");
    } catch {
      /* best-effort mirror */
    }
  }

  if (levelId < minLevelId) return;

  const entry = JSON.stringify({
    "0": loggerName,
    "1": prefixedMessage,
    _meta: {
      runtime: RUNTIME,
      runtimeVersion: RUNTIME_VERSION,
      hostname: HOSTNAME,
      name: loggerName,
      parentNames: PARENT_NAMES,
      date: now.toISOString(),
      logLevelId: LEVEL_IDS[level] ?? LEVEL_IDS.INFO,
      logLevelName: level,
    },
    time: toLocalISO(now),
  });
  try {
    if (!logDirEnsured) {
      fs.mkdirSync(MAIN_LOG_DIR, { recursive: true });
      logDirEnsured = true;
    }
    fs.appendFileSync(resolveMainLogPath(), `${entry}\n`, "utf-8");
  } catch {
    // Best-effort; never block on logging failures.
  }
}

/** Creates a logger instance, optionally bound to a specific account. */
function createLogger(accountId?: string): Logger {
  return {
    info(message: string): void {
      writeLog("INFO", message, accountId);
    },
    debug(message: string): void {
      writeLog("DEBUG", message, accountId);
    },
    warn(message: string): void {
      writeLog("WARN", message, accountId);
    },
    error(message: string): void {
      writeLog("ERROR", message, accountId);
    },
    withAccount(id: string): Logger {
      return createLogger(id);
    },
    getLogFilePath(): string {
      return resolveMainLogPath();
    },
    close(): void {
      // No-op: appendFileSync has no persistent handle to close.
    },
  };
}

export const logger: Logger = createLogger();
