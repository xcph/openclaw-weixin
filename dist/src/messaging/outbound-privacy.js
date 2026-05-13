/** Remove well-formed `<thinking>...</thinking>` (and synonyms) spans; stray tags stripped after. */
const THINKING_WRAPPED_BLOCK_RE = /<\s*(?:think(?:ing)?|thought|antthinking)\s*>[\s\S]*?<\s*\/\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi;
const THINKING_TAGS_RE = /<\s*\/?\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi;
/**
 * Mirrors host `formatReasoningMessage`: `Reasoning:` plus italic Markdown lines `_..._`.
 * Remove anywhere in the string so streamed/final payloads stay clean when `showThinking` is off.
 */
const REASONING_MD_BLOCK_RE = /\n?Reasoning:\n(?:_[^\r\n]*_\r?\n?)+/gi;
/**
 * Remove visible reasoning envelopes from outbound assistant text when the channel disables thinking mirrors.
 */
export function sanitizeAssistantOutboundForChannel(text, flags) {
    if (!text || flags.showThinking) {
        return text;
    }
    let out = text.replace(THINKING_WRAPPED_BLOCK_RE, "");
    out = out.replace(THINKING_TAGS_RE, "");
    out = out.replace(REASONING_MD_BLOCK_RE, "\n");
    out = stripLeadingWeixinThinkingBubbleBody(out);
    return out.replace(/\n{3,}/g, "\n\n").trim();
}
/**
 * Drop `💭……` lines and, for our `💭思考` header (see {@link reasoning-broadcast}), the following
 * paragraph until a blank line — matches throttled reasoning sends without removing unrelated `💭` emoji in user quotes.
 */
function stripLeadingWeixinThinkingBubbleBody(text) {
    const lines = text.split(/\r?\n/);
    const out = [];
    let skipReasoningParagraph = false;
    for (const line of lines) {
        if (skipReasoningParagraph) {
            if (!line.trim()) {
                skipReasoningParagraph = false;
            }
            continue;
        }
        const lead = line.trimStart();
        if (lead.startsWith("💭思考")) {
            skipReasoningParagraph = true;
            continue;
        }
        if (lead.startsWith("💭")) {
            continue;
        }
        out.push(line);
    }
    return out.join("\n");
}
//# sourceMappingURL=outbound-privacy.js.map