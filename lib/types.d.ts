/**
 * Shared types for dsh-usage-ledger: per-model prices, price sheets, and the
 * persisted ledger file shape.
 */
/** Per-million-token prices for one model (CNY by default). */
export interface ModelPrice {
    /** Price per 1M input tokens that hit the prefix cache. */
    inputCacheHit: number;
    /** Price per 1M input tokens that miss the cache. */
    inputMiss: number;
    /** Price per 1M output tokens. */
    output: number;
}
/** Model prices keyed by model id (e.g. `deepseek-v4-pro`). */
export type PriceTable = Record<string, ModelPrice>;
/** Peak/off-peak schedule introduced by DeepSeek's time-of-day pricing. */
export interface ScheduledPricing {
    /** Beijing-calendar date (YYYY-MM-DD) from which the schedule applies. */
    effective: string;
    /** Beijing-hour windows [start, end) billed at peak prices. */
    peakWindows?: ReadonlyArray<readonly [number, number]>;
    /** Prices during off-peak hours. */
    offPeak: PriceTable;
    /** Prices during peak hours. */
    peak: PriceTable;
}
/** One resolved pricing snapshot, live-fetched or built-in fallback. */
export interface PriceSheet {
    source: 'live' | 'builtin';
    /** Unix ms of the successful fetch; absent for the built-in sheet. */
    fetchedAt?: number;
    /** Source URL when fetched live. */
    sourceUrl?: string;
    /** Flat prices used before any schedule takes effect. */
    current: PriceTable;
    /** Optional upcoming/active peak/off-peak schedule. */
    scheduled?: ScheduledPricing;
}
/** Token and cost counters shared by session, daily, and total aggregates. */
export interface UsageCounters {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    cost: number;
}
/** Per-session aggregate row in the ledger. */
export interface SessionUsage extends UsageCounters {
    title: string;
    provider?: string;
    model?: string;
    createdAt: number;
    updatedAt: number;
    /** Last folded session-log seq; guards against double-counting on resume. */
    lastSeq: number;
}
/** One calendar-day (Beijing) bucket. */
export interface DailyUsage {
    calls: number;
    tokens: number;
    cost: number;
}
/** The persisted ledger document. */
export interface LedgerFile {
    version: 1;
    sessions: Record<string, SessionUsage>;
    daily: Record<string, DailyUsage>;
    total: {
        calls: number;
        tokens: number;
        cost: number;
    };
}
/** Budget evaluation for one scope. */
export interface BudgetState {
    /** Accumulated cost in scope. */
    cost: number;
    /** Configured budget; 0 means no budget. */
    budget: number;
    /** cost / budget when a budget is set; otherwise 0. */
    ratio: number;
    /** Ratio reached the configured warning threshold. */
    warn: boolean;
    /** Cost reached or exceeded the budget. */
    exceeded: boolean;
}
/** Complete budget snapshot used by the prompt, tool, and gate. */
export interface BudgetStatus {
    /** Beijing calendar date of the observation. */
    day: string;
    daily: BudgetState;
    total: BudgetState;
    session?: BudgetState;
}
/** Sum the disjoint provider usage buckets (reasoning is an output subset). */
export declare function usageTotalTokens(usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
}): number;
/** Beijing (UTC+8) calendar date string for one Unix-ms instant. */
export declare function beijingDate(ms: number): string;
