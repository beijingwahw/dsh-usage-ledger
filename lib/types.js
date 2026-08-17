/**
 * Shared types for dsh-usage-ledger: per-model prices, price sheets, and the
 * persisted ledger file shape.
 */
/** Sum the disjoint provider usage buckets (reasoning is an output subset). */
export function usageTotalTokens(usage) {
    return usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) + usage.outputTokens;
}
/** Beijing (UTC+8) calendar date string for one Unix-ms instant. */
export function beijingDate(ms) {
    return new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);
}
