import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../util/logger.js";

const QRCODE_TERMINAL_CB_MS = 8_000;

type QrRenderOpts =
  | { type: "utf8"; margin?: number }
  | { type: "terminal"; small: boolean };

type QrCodeApi = { toString: (text: string, opts?: unknown) => Promise<string> };

type QrcodeTerminalApi = {
  generate: (
    input: string,
    opts: { small?: boolean } | ((qr: string) => void),
    cb?: (qr: string) => void,
  ) => void;
};

function createEmitQr(
  log: (msg: string) => void,
  writeStdout?: (value: string) => void,
): (block: string) => void {
  return (block: string) => {
    const text = block.endsWith("\n") ? block : `${block}\n`;
    if (writeStdout) {
      writeStdout(text);
    } else {
      log(text);
    }
  };
}

/** Avoid accepting Object.prototype.toString as the QR renderer. */
function isQrCodeApi(api: unknown): api is QrCodeApi {
  if (!api || typeof api !== "object") {
    return false;
  }
  const rec = api as { toString?: unknown; create?: unknown };
  return typeof rec.toString === "function" && typeof rec.create === "function";
}

function coerceQrcodeTerminal(mod: unknown): QrcodeTerminalApi | null {
  if (!mod || typeof mod !== "object") {
    return null;
  }
  const root = mod as { default?: unknown; generate?: unknown };
  const inner = root.default && typeof root.default === "object" ? root.default : root;
  const gen = (inner as { generate?: unknown }).generate;
  return typeof gen === "function" ? (inner as QrcodeTerminalApi) : null;
}

/**
 * When the Weixin plugin lives under ~/.openclaw/npm, `qrcode` may not be hoisted next to the
 * plugin, while the OpenClaw CLI package at /app (or global prefix) always bundles `qrcode`.
 */
function resolveOpenClawHostPackageJson(): string | undefined {
  const entry = process.argv[1];
  const dirs: string[] = [];
  if (typeof entry === "string" && entry.length > 0) {
    try {
      let dir = path.dirname(fs.realpathSync(path.resolve(entry)));
      for (let i = 0; i < 16 && dir !== path.dirname(dir); i++) {
        dirs.push(dir);
        dir = path.dirname(dir);
      }
    } catch {
      dirs.push(path.dirname(path.resolve(entry)));
    }
  }
  dirs.push(process.cwd());

  for (const dir of dirs) {
    const pkgPath = path.join(dir, "package.json");
    if (!fs.existsSync(pkgPath)) {
      continue;
    }
    try {
      const name = (JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { name?: string }).name;
      if (name === "openclaw") {
        return pkgPath;
      }
    } catch {
      continue;
    }
  }

  const cwdPkg = path.join(process.cwd(), "package.json");
  return fs.existsSync(cwdPkg) ? cwdPkg : undefined;
}

async function loadNodeQrcode(): Promise<QrCodeApi | null> {
  const pluginRequireRoot = fileURLToPath(new URL("../../package.json", import.meta.url));
  const hostPkgJson = resolveOpenClawHostPackageJson();

  /** Prefer OpenClaw install first: plugins under ~/.openclaw/npm often lack hoisted `qrcode`. */
  const strategies: Array<{ label: string; load: () => unknown }> = [
    ...(hostPkgJson
      ? [
          {
            label: "require-openclaw-host",
            load: () => {
              try {
                return createRequire(hostPkgJson)("qrcode");
              } catch {
                return null;
              }
            },
          },
        ]
      : []),
    {
      label: "require-plugin-package.json",
      load: () => {
        try {
          return createRequire(pluginRequireRoot)("qrcode");
        } catch {
          return null;
        }
      },
    },
    {
      label: "dynamic-import",
      load: () =>
        import("qrcode").then((mod) => {
          return mod.default ?? mod;
        }),
    },
  ];

  for (const { label, load } of strategies) {
    try {
      const raw = await Promise.resolve(load());
      if (raw && isQrCodeApi(raw)) {
        return raw;
      }
    } catch (err) {
      logger.warn(`printWeixinLoginQrToConsole: load qrcode (${label}) err=${String(err)}`);
    }
  }

  logger.warn("printWeixinLoginQrToConsole: qrcode unavailable after all load strategies");
  return null;
}

function loadQrcodeTerminal(): QrcodeTerminalApi | null {
  const pluginRequireRoot = fileURLToPath(new URL("../../package.json", import.meta.url));
  const hostPkgJson = resolveOpenClawHostPackageJson();

  const tries: Array<{ label: string; mod: unknown }> = [];
  if (hostPkgJson) {
    try {
      tries.push({ label: "require-host", mod: createRequire(hostPkgJson)("qrcode-terminal") });
    } catch {
      /* skip */
    }
  }
  try {
    tries.push({ label: "require-plugin", mod: createRequire(pluginRequireRoot)("qrcode-terminal") });
  } catch {
    /* skip */
  }

  for (const { label, mod } of tries) {
    const api = coerceQrcodeTerminal(mod);
    if (api) {
      return api;
    }
    logger.warn(`printWeixinLoginQrToConsole: qrcode-terminal (${label}) unexpected shape`);
  }

  return null;
}

/**
 * Print ilink QR login URL to the operator terminal.
 * Uses utf8 block glyphs first (no ANSI — survives Docker/log viewers), then colored terminal raster.
 * Prefer OpenClaw `writeStdout` when provided so output matches other CLI lines (progress-line clearing).
 */
export async function printWeixinLoginQrToConsole(
  qrcodeUrl: string,
  log: (msg: string) => void,
  writeStdout?: (value: string) => void,
): Promise<void> {
  log(`扫码链接（可复制到浏览器打开）：\n${qrcodeUrl}`);
  const emitQr = createEmitQr(log, writeStdout);
  let rendered = false;

  const QRCode = await loadNodeQrcode();
  if (QRCode) {
    const rasterAttempts: QrRenderOpts[] = [
      { type: "utf8", margin: 1 },
      { type: "terminal", small: true },
      { type: "terminal", small: false },
    ];
    for (const opts of rasterAttempts) {
      try {
        const ascii = await QRCode.toString(qrcodeUrl, opts);
        if (typeof ascii === "string" && ascii.trim()) {
          emitQr(ascii);
          rendered = true;
          break;
        }
      } catch (err) {
        const small = opts.type === "terminal" ? opts.small : undefined;
        logger.warn(
          `printWeixinLoginQrToConsole: qrcode ${opts.type}${small === undefined ? "" : ` small=${small}`} err=${String(err)}`,
        );
      }
    }
  }

  if (!rendered) {
    try {
      const termSync = loadQrcodeTerminal();
      if (termSync) {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(() => reject(new Error("qrcode-terminal timed out")), QRCODE_TERMINAL_CB_MS);
          try {
            termSync.generate(qrcodeUrl, { small: false }, (qr: string) => {
              clearTimeout(t);
              if (typeof qr === "string" && qr.trim()) {
                emitQr(qr);
                rendered = true;
              }
              resolve();
            });
          } catch (err) {
            clearTimeout(t);
            reject(err);
          }
        });
      } else {
        const qrcodeterminal = await import("qrcode-terminal");
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(() => reject(new Error("qrcode-terminal timed out")), QRCODE_TERMINAL_CB_MS);
          try {
            qrcodeterminal.default.generate(qrcodeUrl, { small: false }, (qr: string) => {
              clearTimeout(t);
              if (typeof qr === "string" && qr.trim()) {
                emitQr(qr);
                rendered = true;
              }
              resolve();
            });
          } catch (err) {
            clearTimeout(t);
            reject(err);
          }
        });
      }
    } catch (err) {
      logger.warn(`printWeixinLoginQrToConsole: qrcode-terminal failed err=${String(err)}`);
    }
  }

  if (!rendered) {
    try {
      const termSync = loadQrcodeTerminal();
      if (termSync) {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(() => reject(new Error("qrcode-terminal timed out")), QRCODE_TERMINAL_CB_MS);
          try {
            termSync.generate(qrcodeUrl, { small: true }, (qr: string) => {
              clearTimeout(t);
              if (typeof qr === "string" && qr.trim()) {
                emitQr(qr);
                rendered = true;
              }
              resolve();
            });
          } catch (err) {
            clearTimeout(t);
            reject(err);
          }
        });
      } else {
        const qrcodeterminal = await import("qrcode-terminal");
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(() => reject(new Error("qrcode-terminal timed out")), QRCODE_TERMINAL_CB_MS);
          try {
            qrcodeterminal.default.generate(qrcodeUrl, { small: true }, (qr: string) => {
              clearTimeout(t);
              if (typeof qr === "string" && qr.trim()) {
                emitQr(qr);
                rendered = true;
              }
              resolve();
            });
          } catch (err) {
            clearTimeout(t);
            reject(err);
          }
        });
      }
    } catch (err) {
      logger.warn(`printWeixinLoginQrToConsole: qrcode-terminal small fallback failed err=${String(err)}`);
    }
  }

  if (!rendered) {
    log("当前环境无法在终端绘制二维码，请仅使用上方链接完成扫码。");
  }
}
