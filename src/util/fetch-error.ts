/**
 * Node's undici/fetch often surfaces failures as `TypeError: fetch failed` while the real reason is on `.cause`.
 */
export function formatFetchRelatedError(err: unknown): string {
  const segments: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; depth < 8 && cur != null; depth += 1) {
    if (cur instanceof AggregateError && Array.isArray(cur.errors)) {
      segments.push(
        `AggregateError(${cur.errors.map((e) => formatFetchRelatedError(e)).join("; ")})`,
      );
      break;
    }
    if (cur instanceof Error) {
      const extra =
        typeof (cur as NodeJS.ErrnoException).code === "string"
          ? ` code=${(cur as NodeJS.ErrnoException).code}`
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
