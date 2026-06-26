import { getRequestTarget, getRequestAccountId } from "../request-context.js";
const CHANNEL_ID = "openclaw-weixin";
/** 当前 to 是否已是「具体收件人」（非空、非 all 通配）。 */
function hasConcreteTo(to) {
    if (typeof to !== "string")
        return false;
    const t = to.trim().toLowerCase();
    return t !== "" && t !== "all" && !t.endsWith(":all");
}
/**
 * 修复 / 合成一个 announce delivery：
 *   - delivery 完全缺失（小模型只给 payload，不给 delivery）→ 用请求级上下文
 *     合成 `{mode:announce, channel:本渠道, to:当前会话地址, accountId}`。
 *   - delivery 存在但缺 channel/to → 补全。
 *   - delivery 指向别的渠道、或为非 announce 模式 → 不碰（返回 null）。
 *   - delivery 已完整（channel=本渠道且 to 具体）→ 无需修改（返回 null）。
 * 用请求级上下文（当前会话的用户地址 + 账户）补全。
 */
function repairDelivery(delivery, to, accountId) {
    const base = delivery && typeof delivery === "object" ? delivery : {};
    const mode = typeof base.mode === "string" ? base.mode : "announce";
    if (mode !== "announce")
        return null; // 非 announce（如 silent）不接管
    const channel = base.channel;
    // 指向别的渠道 → 不碰；缺失 或 本渠道 → 接管
    if (typeof channel === "string" && channel !== "" && channel !== CHANNEL_ID)
        return null;
    const needChannel = channel !== CHANNEL_ID;
    const needTo = !hasConcreteTo(base.to);
    if (!needChannel && !needTo)
        return null; // 已完整
    const next = { ...base, mode, channel: CHANNEL_ID };
    if (needTo)
        next.to = to;
    if (accountId && !base.accountId)
        next.accountId = accountId;
    return next;
}
/**
 * 注册 before_tool_call 钩子：拦截框架 `cron` 工具的 add 调用。
 *
 * 背景：小模型常直接调 `cron`（不走 weixin_remind 工具），要么把 delivery 写成
 * `{channel:"openclaw-weixin"}` 但漏掉 `to`，要么**整个 delivery 都不给**（只给
 * payload + session_target）→ 触发时 delivery_status=not-requested，提醒发不出去。
 * 本钩子在工具执行前、于本插件的请求级上下文作用域内运行，确定性地补全 / 合成投递，
 * 无论模型是否正确填写。
 */
export function registerCronDeliveryRepairHook(api) {
    if (typeof api.on !== "function")
        return;
    api.on("before_tool_call", (event) => {
        if (event.toolName !== "cron")
            return;
        const params = event.params;
        if (!params || typeof params !== "object" || params.action !== "add")
            return;
        const job = params.job;
        if (!job || typeof job !== "object")
            return;
        const jobObj = job;
        const to = getRequestTarget();
        if (!to)
            return; // 不在本渠道会话上下文中，跳过
        const accountId = getRequestAccountId();
        // jobObj.delivery 可能不存在 → repairDelivery 会据请求上下文合成
        const repaired = repairDelivery(jobObj.delivery, to, accountId);
        if (!repaired)
            return;
        console.log(`[weixin-remind] before_tool_call: injected cron delivery to=${to}`);
        return { params: { ...params, job: { ...jobObj, delivery: repaired } } };
    });
    console.log("[weixin-remind] Registered cron delivery-repair hook");
}
//# sourceMappingURL=cron-delivery-repair.js.map