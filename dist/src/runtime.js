import { logger } from "./util/logger.js";
let pluginRuntime = null;
/**
 * Sets the global Weixin runtime (called from plugin register).
 */
export function setWeixinRuntime(next) {
    pluginRuntime = next;
    logger.info(`[runtime] setWeixinRuntime called, runtime set successfully`);
}
/**
 * Gets the global Weixin runtime (throws if not initialized).
 */
export function getWeixinRuntime() {
    if (!pluginRuntime) {
        throw new Error("Weixin runtime not initialized");
    }
    return pluginRuntime;
}
/**
 * Resolves `PluginRuntime["channel"]` for the long-poll monitor.
 *
 * Prefer `ChannelGatewayContext.channelRuntime` from the gateway (required for production).
 * Fall back to `register()`'s global only for narrow/test setups without full gateway wiring.
 */
export async function resolveWeixinChannelRuntime(params) {
    if (params.channelRuntime) {
        logger.debug("[runtime] channelRuntime from gateway context");
        return params.channelRuntime;
    }
    if (pluginRuntime) {
        logger.debug("[runtime] channelRuntime from register() global");
        return pluginRuntime.channel;
    }
    throw new Error("openclaw-weixin: missing channel runtime — gateway must inject ctx.channelRuntime when starting this external channel " +
        "(ensure OpenClaw createChannelManager.resolveChannelRuntime is configured)");
}
//# sourceMappingURL=runtime.js.map