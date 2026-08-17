import type { BudgetStatus, SessionUsage } from './types.js';
import type { ModelPrice } from './types.js';
/** Minimal logger shape (structurally compatible with the cordis logger). */
export interface LedgerLogger {
    warn(...args: unknown[]): void;
    info(...args: unknown[]): void;
}
/** Budget configuration the ledger evaluates against. */
export interface BudgetConfig {
    /** Daily cost budget (CNY); 0 disables. */
    dailyBudget: number;
    /** Total cost budget (CNY); 0 disables. */
    totalBudget: number;
    /** Per-session cost budget (CNY); 0 disables. */
    sessionBudget: number;
    /** Ratio (0-1) at which a budget enters the warning state. */
    warnRatio: number;
}
/** One recorded model call. */
export interface UsageSample {
    time: number;
    usage: {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
        reasoningTokens?: number;
    };
    model?: string;
    provider?: string;
    cost: number;
}
/** Resolve the ledger file path: configured path, else `$DSH_HOME`/`~/.dsh`. */
export declare function resolveLedgerPath(configured: string): string;
/**
 * Durable per-session usage ledger. All mutation goes through `record()` and
 * `setTitle()`; persistence is debounced and flushed on `dispose()`.
 */
export declare class UsageLedger {
    readonly path: string;
    private budgets;
    private readonly log;
    private readonly saveIntervalMs;
    private file;
    private dirty;
    private saveTimer;
    private disposed;
    constructor(path: string, budgets: BudgetConfig, log: LedgerLogger, saveIntervalMs: number);
    /** Replace the budget configuration (live settings update). */
    setBudgets(budgets: BudgetConfig): void;
    /** Load the durable file; a corrupt file is archived aside, never fatal. */
    private load;
    /** The last folded session-log seq, for resume double-count protection. */
    lastSeq(sessionId: string): number;
    /** Session display title, when one was logged. */
    title(sessionId: string): string | undefined;
    /** Remember the session title (latest-wins). */
    setTitle(sessionId: string, title: string, time: number): void;
    /** Record one priced model call into session, daily, and total buckets. */
    record(sessionId: string, sample: UsageSample): void;
    /** Advance the folded-seq watermark after events were consumed. */
    advanceSeq(sessionId: string, seq: number): void;
    private sessionRow;
    /** One session's aggregate, when recorded. */
    session(sessionId: string): SessionUsage | undefined;
    /** All session rows, newest activity first. */
    sessions(): Array<[string, SessionUsage]>;
    /** One day's bucket (Beijing date). */
    daily(day: string): {
        calls: number;
        tokens: number;
        cost: number;
    };
    /** Lifetime totals. */
    total(): {
        calls: number;
        tokens: number;
        cost: number;
    };
    private budgetState;
    /** Evaluate daily, total, and (optionally) session budgets. */
    budgetStatus(atMs: number, sessionId?: string): BudgetStatus;
    /** Whether any configured budget is already exceeded. */
    isExceeded(atMs: number, sessionId?: string): boolean;
    /** Whether any configured budget reached the warning threshold. */
    isWarn(atMs: number, sessionId?: string): boolean;
    /** Whether at least one budget is configured. */
    get hasBudget(): boolean;
    /** The resolved price table description for reports. */
    private markDirty;
    /** Write the ledger to disk (atomic rename). */
    flush(): void;
    /** Stop timers and persist the final state. */
    dispose(): void;
}
/** Format one CNY amount with sensible precision. */
export declare function formatCny(value: number): string;
/** Format one token count with thousands separators. */
export declare function formatTokens(value: number): string;
/** Describe one price row for reports. */
export declare function formatPrice(price: ModelPrice): string;
