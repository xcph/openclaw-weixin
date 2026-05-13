import type {
  OpenClawPluginApi,
  OpenClawPluginConfigSchema,
} from "openclaw/plugin-sdk/plugin-entry";

import { weixinPlugin } from "./src/channel.js";
import { assertHostCompatibility } from "./src/compat.js";
import { weixinChannelConfigJsonSchema } from "./src/config/weixin-channel-json-schema.js";
import { setWeixinRuntime } from "./src/runtime.js";

/** Plugin-level config slice (not channel runtime validation — host handles merge). */
const weixinPluginConfigSchema: OpenClawPluginConfigSchema = {
  jsonSchema: weixinChannelConfigJsonSchema as OpenClawPluginConfigSchema["jsonSchema"],
  safeParse(value: unknown) {
    if (value === undefined) {
      return { success: true, data: undefined };
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return {
        success: false,
        error: {
          issues: [{ path: [], message: "expected channels.openclaw-weixin config object" }],
        },
      };
    }
    return { success: true, data: value };
  },
};

export default {
  id: "openclaw-weixin",
  name: "Weixin",
  description:
    "Weixin channel (getUpdates long-poll; text + image/video/file outbound via CDN upload)",
  configSchema: weixinPluginConfigSchema,
  register(api: OpenClawPluginApi) {
    // Fail-fast: reject incompatible host versions before any side-effects.
    assertHostCompatibility(api.runtime?.version);

    if (api.runtime) {
      setWeixinRuntime(api.runtime);
    }

    api.registerChannel({ plugin: weixinPlugin });
  },
};
