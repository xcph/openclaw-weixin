import { CDN_BASE_URL, DEFAULT_BASE_URL } from "../auth/accounts.js";
/**
 * JSON Schema for `channels.openclaw-weixin` (runtime validation via host).
 * Kept free of `zod` so the packaged extension loads without `node_modules/zod`
 * when OpenClaw installs only compiled `dist/` + `index.js`.
 *
 * Zod mirror for unit tests: {@link ./config-schema.ts}
 */
const accountProperties = {
    name: { type: "string" },
    enabled: { type: "boolean" },
    baseUrl: { type: "string", default: DEFAULT_BASE_URL },
    cdnBaseUrl: { type: "string", default: CDN_BASE_URL },
    routeTag: { type: "number" },
    showThinking: { type: "boolean" },
    showReasoning: { type: "boolean" },
    showTools: { type: "boolean" },
};
export const weixinChannelConfigJsonSchema = {
    type: "object",
    additionalProperties: true,
    properties: {
        name: accountProperties.name,
        enabled: accountProperties.enabled,
        baseUrl: accountProperties.baseUrl,
        cdnBaseUrl: accountProperties.cdnBaseUrl,
        routeTag: accountProperties.routeTag,
        showThinking: accountProperties.showThinking,
        showReasoning: accountProperties.showReasoning,
        showTools: accountProperties.showTools,
        verboseLogFile: { type: "string" },
        accounts: {
            type: "object",
            additionalProperties: {
                type: "object",
                additionalProperties: true,
                properties: { ...accountProperties },
            },
        },
        channelConfigUpdatedAt: { type: "string" },
    },
};
//# sourceMappingURL=weixin-channel-json-schema.js.map