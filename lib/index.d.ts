/**
 * dsh-usage-ledger: per-session token usage and cost aggregation with dynamic
 * DeepSeek official pricing (peak/off-peak aware) and budget control.
 *
 * Host half:
 * - folds `session/event` logs into a durable ledger (per session, per Beijing
 *   day, and lifetime totals), pricing each call with the official DeepSeek
 *   price sheet refreshed from https://api-docs.deepseek.com;
 * - enforces daily/total/per-session budgets through an `llm/stream` gate;
 * - exposes a `usage_report` tool and an HTTP dashboard (`/usage-ledger`);
 * - warns the model through a dynamic system-prompt section.
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const name = "dsh-usage-ledger";
export declare const inject: string[];
/** Deployment-varying choices; every field is cordis.yml-configurable. */
export interface Config {
    /** Ledger file path; empty means `$DSH_HOME/usage-ledger.json` (or `~/.dsh`). */
    ledgerPath: string;
    /** Debounce window for ledger persistence, in milliseconds. */
    saveIntervalMs: number;
    /** Wall-clock budget for one pricing-page fetch, in milliseconds. */
    pricingTimeoutMs: number;
}
/** Schemastery validator for {@link Config}. */
export declare const Config: z<Config>;
/** User settings of the `usage-ledger` namespace. */
export interface UsageLedgerSettings {
    /** Daily cost budget (CNY); 0 disables. */
    dailyBudget: number;
    /** Lifetime cost budget (CNY); 0 disables. */
    totalBudget: number;
    /** Per-session cost budget (CNY); 0 disables. */
    sessionBudget: number;
    /** Ratio (0-1) at which budgets enter the warning state. */
    warnRatio: number;
    /** Block model calls once any budget is exceeded. */
    enforceBudget: boolean;
    /** Official pricing page to refresh from. */
    pricingUrl: string;
    /** Pricing refresh interval in minutes. */
    refreshIntervalMin: number;
    /**
     * User price overrides/entries, keyed by model id (longest-prefix match).
     * Example: `{ "glm-4.6": { "inputCacheHit": 1, "inputMiss": 5, "output": 5 } }`.
     * Prices are CNY per 1M tokens and take priority over built-in/live values.
     */
    customPrices: Record<string, {
        inputCacheHit: number;
        inputMiss: number;
        output: number;
    }>;
}
/** Schemastery schema of the `usage-ledger` namespace section. */
export declare const UsageLedgerSchema: z<UsageLedgerSettings>;
export declare const USAGE_LEDGER_NAMESPACE: import("@deepseek-ai/dsh-settings").SettingsNamespace;
/**
 * Mount the plugin: ledger, pricing service, session fold, budget gate,
 * report tool, dashboard route, and prompt warning.
 * @param ctx - the plugin context.
 * @param config - schemastery-resolved {@link Config}.
 */
export declare function apply(ctx: Context, config: Config): void;
