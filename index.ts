import type {
  OpenClawPluginApi,
  OpenClawPluginConfigSchema,
} from "openclaw/plugin-sdk/plugin-entry";

import { weixinPlugin } from "./src/channel.js";
import { assertHostCompatibility } from "./src/compat.js";
import { weixinChannelConfigJsonSchema } from "./src/config/weixin-channel-json-schema.js";
import { setWeixinRuntime } from "./src/runtime.js";
import { registerRemindTool } from "./src/tools/remind.js";
import { registerCronDeliveryRepairHook } from "./src/hooks/cron-delivery-repair.js";

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

    // 定时提醒工具：从请求级上下文自动注入投递地址/账户，模型无需也无法填错 to。
    registerRemindTool(api);

    // 确定性兜底：拦截模型直接调用的 cron.add，补全本渠道缺失的 delivery.to/accountId。
    registerCronDeliveryRepairHook(api);
  },
};
