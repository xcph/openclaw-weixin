import { z } from "zod";

import { CDN_BASE_URL, DEFAULT_BASE_URL } from "../auth/accounts.js";

// ---------------------------------------------------------------------------
// Zod config schema
// ---------------------------------------------------------------------------

const weixinAccountSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  baseUrl: z.string().default(DEFAULT_BASE_URL),
  cdnBaseUrl: z.string().default(CDN_BASE_URL),
  routeTag: z.number().optional(),
  /** Mirror model reasoning/thinking stream into Weixin chat (+ gateway logs). Preferred over `showReasoning`. */
  showThinking: z.boolean().optional(),
  /** @deprecated Use `showThinking`; kept for backward compatibility. */
  showReasoning: z.boolean().optional(),
  /** When false, suppress outbound tool-summary messages (`dispatch` kind `tool`). Default true. */
  showTools: z.boolean().optional(),
});

/** Top-level weixin config schema (token is stored in credentials file, not config). */
export const WeixinConfigSchema = weixinAccountSchema.extend({
  accounts: z.record(z.string(), weixinAccountSchema).optional(),
  /** ISO 8601; bumped on each successful login to refresh gateway config from disk. */
  channelConfigUpdatedAt: z.string().optional(),
  /** Default showThinking for all accounts unless overridden per-account. */
  showThinking: z.boolean().optional(),
  /** @deprecated Use `showThinking`; kept for backward compatibility. */
  showReasoning: z.boolean().optional(),
  /** Default showTools for all accounts unless overridden per-account. */
  showTools: z.boolean().optional(),
});
