/**
 * Maps model reasoning deltas (onReasoningStream / onReasoningEnd) into Weixin text messages
 * with throttling, plus gateway log lines (caller supplies logger).
 */
const DEFAULT_DEBOUNCE_MS = 1200;
const DEFAULT_MIN_FLUSH = 380;
const DEFAULT_MAX_CHARS = 3500;
/** Prefix for chat-visible reasoning bubbles (plain text; Weixin has no native reasoning UI). */
const REASONING_HEADER = "💭思考";
export function createWeixinReasoningBroadcast(opts) {
    const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    const minFlushChars = opts.minFlushChars ?? DEFAULT_MIN_FLUSH;
    const maxCharsPerMessage = opts.maxCharsPerMessage ?? DEFAULT_MAX_CHARS;
    let buffer = "";
    let flushedOffset = 0;
    let timer = null;
    let sendChain = Promise.resolve();
    const dispose = () => {
        if (timer != null) {
            clearTimeout(timer);
            timer = null;
        }
    };
    const enqueueSend = (fn) => {
        sendChain = sendChain.then(fn).catch((err) => {
            opts.log.info(`reasoning send failed: ${String(err)}`);
        });
        return sendChain;
    };
    const pendingSlice = () => buffer.slice(flushedOffset);
    const flushInternal = async (mode) => {
        const drainAll = mode === "finalize";
        while (true) {
            const pending = pendingSlice();
            if (!pending.trim()) {
                break;
            }
            const bypassMin = mode === "debounced-tick" || mode === "finalize";
            if (!bypassMin && pending.length < minFlushChars) {
                break;
            }
            const chunk = pending.slice(0, maxCharsPerMessage);
            const body = chunk.trimEnd();
            flushedOffset += chunk.length;
            const message = body.length > 0 ? `${REASONING_HEADER}\n${body}` : "";
            if (message) {
                opts.log.info(`reasoning outbound: len=${body.length} preview=${previewForLog(body)}`);
                await opts.sendText(message);
            }
            if (!drainAll || pendingSlice().trim().length === 0) {
                break;
            }
        }
    };
    const flush = async (mode) => {
        await enqueueSend(async () => {
            await flushInternal(mode);
        });
    };
    const scheduleDebouncedFlush = () => {
        if (timer != null) {
            clearTimeout(timer);
        }
        timer = setTimeout(() => {
            timer = null;
            void flush("debounced-tick");
        }, debounceMs);
    };
    return {
        onReasoningStream: async (payload) => {
            const delta = payload.text ?? "";
            if (!delta) {
                return;
            }
            buffer += delta;
            while (pendingSlice().length >= minFlushChars) {
                dispose();
                await flush("stream-tick");
            }
            if (pendingSlice().trim().length > 0) {
                scheduleDebouncedFlush();
            }
        },
        onReasoningEnd: async () => {
            dispose();
            await flush("finalize");
            buffer = "";
            flushedOffset = 0;
        },
        dispose,
    };
}
function previewForLog(text, max = 160) {
    const compact = text.replace(/\s+/g, " ").trim();
    if (compact.length <= max) {
        return compact;
    }
    return `${compact.slice(0, max)}…`;
}
//# sourceMappingURL=reasoning-broadcast.js.map