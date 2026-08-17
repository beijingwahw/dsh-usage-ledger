import type { ModelPrice, PriceSheet, PriceTable } from './types.js';
/** Official DeepSeek API pricing page (zh-CN). */
export declare const OFFICIAL_PRICING_URL = "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/";
/** Minimal logger shape (structurally compatible with the cordis logger). */
export interface MinimalLogger {
    warn(...args: unknown[]): void;
    info(...args: unknown[]): void;
    error(...args: unknown[]): void;
}
/**
 * Built-in fallback sheet (CNY per 1M tokens), mirroring the official page on
 * 2026-08-14: flat prices now, peak/off-peak schedule from 2026-08-17.
 */
export declare const BUILTIN_SHEET: PriceSheet;
/** Default Beijing-time peak windows [startHour, endHour), per DeepSeek. */
export declare const DEFAULT_PEAK_WINDOWS: ReadonlyArray<readonly [number, number]>;
/** Token usage shape accepted by the cost function. */
export interface UsageLike {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
}
/**
 * Cost of one call in CNY. Cache reads bill at the cache-hit price; cache
 * writes bill at the uncached input price (DeepSeek folds them into ordinary
 * input); unknown prices cost 0 (tokens are still counted).
 */
export declare function costOf(price: ModelPrice | undefined, usage: UsageLike): number;
/** Whether one Beijing-time instant falls inside any peak window. */
export declare function isPeakTime(atMs: number, windows?: ReadonlyArray<readonly [number, number]>): boolean;
/** Resolve the model price in force at one instant under one sheet. */
export declare function resolvePrice(sheet: PriceSheet, model: string, atMs: number): ModelPrice | undefined;
/** Fetch one URL as text with a timeout. */
export declare function fetchText(url: string, timeoutMs: number, headers?: Record<string, string>): Promise<string>;
/**
 * Parse the DeepSeek pricing page HTML into a sheet. Throws when no
 * recognizable price table exists (the caller keeps its last good sheet).
 */
export declare function parsePriceSheet(html: string, url: string): PriceSheet;
/** One vendor's resolved pricing block for reports and the dashboard. */
export interface VendorPricing {
    id: string;
    label: string;
    pricingUrl: string;
    /** Catalog prices are lowest-tier snapshots of tiered official pricing. */
    tiered: boolean;
    /** Where the numbers came from. */
    source: 'live' | 'builtin' | 'override';
    fetchedAt?: number;
    models: PriceTable;
}
/** Owns the live price sheet with refresh and fallback behavior. */
export declare class PriceService {
    private pricingUrl;
    private readonly timeoutMs;
    private readonly log;
    private sheet;
    private changedAt;
    private overrides;
    /** Per-vendor tables scraped live from official pages (new models land here). */
    private vendorLive;
    constructor(pricingUrl: string, timeoutMs: number, log: MinimalLogger);
    /** Point the refresh at a different pricing page (live settings update). */
    setUrl(url: string): void;
    /** Replace the user-supplied price overrides (live settings update). */
    setOverrides(overrides: PriceTable): void;
    /** The sheet currently in force. */
    get currentSheet(): PriceSheet;
    /** When the official page last delivered different prices (undefined = never). */
    get lastChangedAt(): number | undefined;
    /**
     * Price for one model at one instant. Priority: user overrides > DeepSeek
     * live/builtin sheet > vendor live tables (auto-imported new models) >
     * built-in catalog exact > longest-prefix match (covers dated snapshots
     * such as `glm-4.6-250414`). Undefined keeps tokens unpriced.
     */
    resolve(model: string, atMs: number): ModelPrice | undefined;
    /** All known pricing grouped by vendor, for the dashboard and reports. */
    vendorPricing(atMs: number): VendorPricing[];
    /**
     * Fetch and parse the official page; keep the last good sheet on failure.
     * Detects official price changes and logs them loudly, so a published price
     * update is picked up automatically on the next poll.
     */
    refresh(): Promise<void>;
    /**
     * Scrape one vendor's official pricing data and auto-import every priced
     * model it lists. New models and price changes are logged explicitly.
     * Failures (network, JS-only pages) keep the previous table untouched.
     *
     * Dispatches by fetchKind:
     *  - kimi-rsc: Kimi's client-rendered docs; prices live in RSC payloads of
     *    the /pricing/chat* subpages, discovered from the index page.
     *  - ernie-cdn: Baidu's CDN page-data JSON (cloud.baidu.com resets TLS).
     *  - zhipu-bundle: Zhipu's SPA shell; flagship prices are embedded in its
     *    app.*.js bundle, legacy models in the public operation/query API.
     *  - doubao-md: Volcano doc-center API returning server-side Markdown.
     *  - html (default): generic table parsing on the pricing page HTML.
     */
    refreshVendor(vendorId: string): Promise<void>;
    /**
     * Fetch and parse one vendor's pricing data according to its fetchKind.
     */
    private fetchVendorTable;
    /** Refresh DeepSeek plus every other vendor's official pricing page. */
    refreshAll(): Promise<void>;
}
