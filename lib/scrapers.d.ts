import type { PriceTable } from './types.js';
interface RawCell {
    text: string;
    rowspan: number;
    colspan: number;
}
/** Extract every table as rows of raw cells (keeping span attributes). */
export declare function parseRawTables(html: string): RawCell[][][];
/** Expand rowspan/colspan into a rectangular text grid. */
export declare function toGrid(rows: RawCell[][]): string[][];
/**
 * Parse one price cell into CNY per 1M tokens.
 * "免费" → 0; USD cells → undefined (unsupported, caller falls back).
 */
export declare function parsePriceCell(text: string): number | undefined;
/**
 * Auto-discover every priced model of one vendor from its official pricing
 * page HTML. Returns an empty table when nothing is recognizable (e.g. the
 * page is JS-rendered); the caller then keeps its previous prices.
 */
export declare function parseVendorSheet(html: string, vendorId: string): PriceTable;
/** Browser UA for sites that reject or mis-serve non-browser clients. */
export declare const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
/**
 * Baidu ERNIE (千帆) pricing. cloud.baidu.com resets TLS for non-browser
 * clients, but the Gatsby CDN mirror of the same doc serves the rendered
 * markdown HTML inside a page-data JSON envelope. Tables look like
 * [模型名称, 版本名称, 服务内容, 子项, 在线推理, 批量推理, 单位] with rows such as
 * [ERNIE 5.1, ERNIE-5.1, 推理服务, 输入（输入<=32k）, 0.004, -, 元/千tokens].
 * Tiered rows appear lowest tier first; the first tier per model+kind wins.
 */
export declare function parseErnieSheet(html: string): PriceTable;
/**
 * Zhipu GLM current flagship pricing. open.bigmodel.cn/pricing is a Vue SPA
 * shell (3.7KB, no data); the live prices are embedded in its app.*.js i18n
 * bundle as
 * `newModel:{...modelList:[{name:"GLM-5.2",...,inPrice:["8元"],outPrice:["28元"],hit:["2元"]}]}`.
 * Tiered models repeat as entries with name:""; only named rows are read, so
 * the first (lowest) tier wins. "免费" entries become 0.
 */
export declare function parseZhipuBundleSheet(js: string): PriceTable;
/**
 * Zhipu legacy models (GLM-4 generation and earlier) from the public
 * /api/biz/operation/query endpoint (no auth). Slots 1122/1123 carry a
 * stringified JSON `content` where fieldList maps random row-key codes to
 * column labels. 单价 is a single per-token rate billed equally for input and
 * output; only "元 / 百万Tokens"/"免费" cells are accepted so per-image or
 * per-call categories are excluded.
 */
export declare function parseZhipuLegacySheet(jsonText: string): PriceTable;
/**
 * ByteDance Doubao (火山方舟) pricing. The doc page is client-rendered Quill
 * rich text, but the doc-center API serves the same content as server-side
 * Markdown (Result.MDContent). Text-model tables sit under the `# 大语言模型`
 * H1 while video/image models (doubao-seedance-*) live under other H1s, so
 * section filtering alone excludes them reliably. Merged tier rows have an
 * empty model cell (higher tiers) and are skipped — the lowest tier wins.
 */
export declare function parseDoubaoSheet(markdown: string): PriceTable;
/**
 * Kimi pricing. The docs site is client-rendered Next.js; the price tables
 * live in the RSC flight payload as
 * `columns:[{title:`输入价格（缓存命中）`...}],rows:[[`kimi-k2.6`,`1M tokens`,`¥1.10`,...]]`.
 * Column meanings come from the titles, so added/removed columns survive.
 */
export declare function parseKimiSheet(rscText: string): PriceTable;
export {};
