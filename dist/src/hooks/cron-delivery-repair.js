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
 * 修复一个 announce delivery 对象：当它指向本渠道、但缺少具体收件人时，
 * 用请求级上下文（当前会话的用户地址 + 账户）补全 to / accountId。
 * 返回修复后的新对象，或 null 表示无需修改。
 */
function repairDelivery(delivery, to, accountId) {
    const mode = typeof delivery.mode === "string" ? delivery.mode : "announce";
    if (mode !== "announce")
        return null;
    if (delivery.channel !== CHANNEL_ID)
        return null;
    if (hasConcreteTo(delivery.to))
        return null;
    const next = { ...delivery, to };
    if (accountId && !delivery.accountId)
        next.accountId = accountId;
    return next;
}
/**
 * 注册 before_tool_call 钩子：拦截框架 `cron` 工具的 add 调用。
 *
 * 背景：小模型常直接调 `cron`（不走 weixin_remind 工具），把 delivery 写成
 * `{channel:"openclaw-weixin"}` 但漏掉 `to` → 触发时报 "requires target"。
 * 本钩子在工具执行前、于本插件的请求级上下文作用域内运行，确定性地把当前会话的
 * 收件人地址与账户注入进去，无论模型是否正确填写。
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
        const delivery = jobObj.delivery;
        if (!delivery || typeof delivery !== "object")
            return;
        const to = getRequestTarget();
        if (!to)
            return; // 不在本渠道会话上下文中，跳过
        const accountId = getRequestAccountId();
        const repaired = repairDelivery(delivery, to, accountId);
        if (!repaired)
            return;
        console.log(`[weixin-remind] before_tool_call: injected cron delivery to=${to}`);
        return { params: { ...params, job: { ...jobObj, delivery: repaired } } };
    });
    console.log("[weixin-remind] Registered cron delivery-repair hook");
}
//# sourceMappingURL=cron-delivery-repair.js.map