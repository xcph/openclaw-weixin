/**
 * Node's undici/fetch often surfaces failures as `TypeError: fetch failed` while the real reason is on `.cause`.
 */
export function formatFetchRelatedError(err) {
    const segments = [];
    let cur = err;
    for (let depth = 0; depth < 8 && cur != null; depth += 1) {
        if (cur instanceof AggregateError && Array.isArray(cur.errors)) {
            segments.push(`AggregateError(${cur.errors.map((e) => formatFetchRelatedError(e)).join("; ")})`);
            break;
        }
        if (cur instanceof Error) {
            const extra = typeof cur.code === "string"
                ? ` code=${cur.code}`
                : "";
            segments.push(`${cur.name}: ${cur.message}${extra}`);
            cur =
                "cause" in cur && cur.cause !== undefined ? cur.cause : undefined;
            continue;
        }
        segments.push(String(cur));
        break;
    }
    return segments.join(" → ");
}
//# sourceMappingURL=fetch-error.js.map