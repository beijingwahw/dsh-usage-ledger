/**
 * 通用官方定价页抓取解析：从任意厂商定价页 HTML 中自动发现模型与价格，
 * 使新模型上线官方定价页后无需改代码即可被自动导入。
 *
 * 支持两种常见表格布局：
 *  1. 行布局：每行一个模型，表头标注 输入/输出/缓存 列（智谱/通义/豆包等常见）
 *  2. 列布局：表头为模型名，行为价格类型（DeepSeek 风格）
 *
 * 单位自动归一化为 元/百万tokens（千tokens 价格 ×1000）；"免费"记为 0；
 * 美元价格跳过（回退内置目录），阶梯计价页取每个模型首次出现的档位。
 */
import { prefixesOf } from './catalog.js';
/** Strip tags and decode the few entities pricing pages use. */
function cellText(raw) {
    return raw
        .replace(/<[^>]*>/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}
/** Extract every table as rows of raw cells (keeping span attributes). */
export function parseRawTables(html) {
    const tables = [];
    for (const tableHtml of html.match(/<table[\s\S]*?<\/table>/gi) ?? []) {
        const rows = [];
        for (const rowHtml of tableHtml.match(/<tr[\s\S]*?<\/tr>/gi) ?? []) {
            const cells = [];
            const cellRe = /<t[dh]([^>]*)>([\s\S]*?)<\/t[dh]>/gi;
            let match;
            while ((match = cellRe.exec(rowHtml)) !== null) {
                const attrs = match[1] ?? '';
                const rowspan = Number(attrs.match(/rowspan=["']?(\d+)/)?.[1] ?? 1);
                const colspan = Number(attrs.match(/colspan=["']?(\d+)/)?.[1] ?? 1);
                cells.push({
                    text: cellText(match[2] ?? ''),
                    rowspan: Number.isFinite(rowspan) && rowspan > 0 ? rowspan : 1,
                    colspan: Number.isFinite(colspan) && colspan > 0 ? colspan : 1,
                });
            }
            if (cells.length > 0)
                rows.push(cells);
        }
        if (rows.length > 0)
            tables.push(rows);
    }
    return tables;
}
/** Expand rowspan/colspan into a rectangular text grid. */
export function toGrid(rows) {
    const grid = [];
    const carry = new Map();
    for (const row of rows) {
        const out = [];
        let col = 0;
        let index = 0;
        while (index < row.length || carry.has(col)) {
            const carried = carry.get(col);
            if (carried !== undefined) {
                out.push(carried.text);
                carried.left -= 1;
                if (carried.left <= 0)
                    carry.delete(col);
                col += 1;
                continue;
            }
            if (index >= row.length)
                break;
            const cell = row[index];
            if (cell === undefined)
                break;
            out.push(cell.text);
            if (cell.rowspan > 1)
                carry.set(col, { text: cell.text, left: cell.rowspan - 1 });
            col += 1;
            for (let filler = 1; filler < cell.colspan; filler += 1) {
                out.push('');
                col += 1;
            }
            index += 1;
        }
        grid.push(out);
    }
    return grid;
}
/**
 * Parse one price cell into CNY per 1M tokens.
 * "免费" → 0; USD cells → undefined (unsupported, caller falls back).
 */
export function parsePriceCell(text) {
    const t = text.replace(/,/g, '');
    if (/免费|free/i.test(t))
        return 0;
    if (/[$＄]|usd|美元/i.test(t))
        return undefined;
    const match = t.match(/(\d+(?:\.\d+)?)/);
    if (match === null || match[1] === undefined)
        return undefined;
    let value = Number(match[1]);
    if (!Number.isFinite(value))
        return undefined;
    if (/每千|\/千|千\s*tokens|\/1k|per 1k/i.test(t))
        value *= 1000;
    return value;
}
/** Classify one header/label text into a price kind. */
function kindOf(text) {
    const t = text.toLowerCase();
    const miss = t.includes('未命中') || /miss/.test(t);
    if ((t.includes('缓存命中') || t.includes('命中缓存') || t.includes('cache hit')) && !miss)
        return 'inputCacheHit';
    if (t.includes('输入') || t.includes('input'))
        return 'inputMiss';
    if (t.includes('输出') || t.includes('output'))
        return 'output';
    return undefined;
}
/** Whether a header cell looks like a price column (has a price keyword). */
function isPriceHeader(text) {
    return /单价|价格|元|¥|\$|price|\/百万|per\s*m|每百万/i.test(text);
}
/** Row layout: one model per row under a header naming the price columns. */
function parseRowLayout(grid, idRe, table) {
    for (let h = 0; h < Math.min(grid.length, 4); h += 1) {
        const header = grid[h];
        if (header === undefined)
            continue;
        const kindCols = new Map();
        header.forEach((text, col) => {
            // A price column must both name a price kind and carry a price keyword,
            // so size columns like "单次请求的输入 Token 数" are not mistaken for prices.
            if (!isPriceHeader(text))
                return;
            const kind = kindOf(text);
            if (kind !== undefined && !kindCols.has(col))
                kindCols.set(col, kind);
        });
        const kinds = [...kindCols.values()];
        if (!kinds.includes('inputMiss') || !kinds.includes('output'))
            continue;
        let modelCol = header.findIndex(text => /模型|model/i.test(text));
        if (modelCol < 0)
            modelCol = 0;
        for (const row of grid.slice(h + 1)) {
            const match = (row[modelCol] ?? '').match(idRe);
            if (match === null || match[1] === undefined)
                continue;
            const model = match[1].toLowerCase();
            if (table[model] !== undefined)
                continue; // keep the first (lowest) tier
            let inputMiss;
            let output;
            let cacheHit;
            for (const [col, kind] of kindCols) {
                const value = parsePriceCell(row[col] ?? '');
                if (value === undefined)
                    continue;
                if (kind === 'inputMiss')
                    inputMiss ??= value;
                else if (kind === 'output')
                    output ??= value;
                else
                    cacheHit ??= value;
            }
            if (inputMiss === undefined || output === undefined)
                continue;
            table[model] = { inputCacheHit: cacheHit ?? 0, inputMiss, output };
        }
    }
}
/** Column layout: model ids in the header row, price kinds as label rows. */
function parseColumnLayout(grid, idRe, table) {
    const header = grid[0];
    if (header === undefined)
        return;
    const modelCols = [];
    header.forEach((text, col) => {
        const match = text.match(idRe);
        if (match !== null && match[1] !== undefined)
            modelCols.push([col, match[1].toLowerCase()]);
    });
    if (modelCols.length === 0)
        return;
    for (const row of grid.slice(1)) {
        const kind = kindOf(row[0] ?? '');
        if (kind === undefined)
            continue;
        for (const [col, model] of modelCols) {
            const value = parsePriceCell(row[col] ?? '');
            if (value === undefined)
                continue;
            const existing = table[model] ?? { inputCacheHit: 0, inputMiss: 0, output: 0 };
            if (existing[kind] === 0)
                existing[kind] = value;
            table[model] = existing;
        }
    }
}
/**
 * Auto-discover every priced model of one vendor from its official pricing
 * page HTML. Returns an empty table when nothing is recognizable (e.g. the
 * page is JS-rendered); the caller then keeps its previous prices.
 */
export function parseVendorSheet(html, vendorId) {
    const prefixes = prefixesOf(vendorId);
    if (prefixes.length === 0)
        return {};
    const idRe = new RegExp(`((?:${prefixes.join('|')})[\\w.-]*)`, 'i');
    const table = {};
    for (const grid of parseRawTables(html).map(toGrid)) {
        parseRowLayout(grid, idRe, table);
        parseColumnLayout(grid, idRe, table);
    }
    return table;
}
/** Browser UA for sites that reject or mis-serve non-browser clients. */
export const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
/**
 * Baidu ERNIE (千帆) pricing. cloud.baidu.com resets TLS for non-browser
 * clients, but the Gatsby CDN mirror of the same doc serves the rendered
 * markdown HTML inside a page-data JSON envelope. Tables look like
 * [模型名称, 版本名称, 服务内容, 子项, 在线推理, 批量推理, 单位] with rows such as
 * [ERNIE 5.1, ERNIE-5.1, 推理服务, 输入（输入<=32k）, 0.004, -, 元/千tokens].
 * Tiered rows appear lowest tier first; the first tier per model+kind wins.
 */
export function parseErnieSheet(html) {
    const table = {};
    for (const grid of parseRawTables(html).map(toGrid)) {
        const header = grid[0];
        if (header === undefined)
            continue;
        const find = (re) => header.findIndex(text => re.test(text));
        const modelCol = find(/版本名称/);
        const kindCol = find(/子项/);
        const priceCol = find(/在线推理/);
        const unitCol = find(/单位/);
        if (modelCol < 0 || kindCol < 0 || priceCol < 0)
            continue;
        for (const row of grid.slice(1)) {
            const unit = unitCol >= 0 ? (row[unitCol] ?? '') : '';
            if (!/tokens/i.test(unit))
                continue; // skip per-image/per-second/GB rows
            const scale = /千/.test(unit) ? 1000 : 1;
            const kindText = row[kindCol] ?? '';
            let kind;
            // 官方表格中缓存价写作"缓存命中"或"命中缓存"两种词序，都要识别。
            if (kindText.includes('缓存命中') || kindText.includes('命中缓存'))
                kind = 'inputCacheHit';
            else if (kindText.includes('输出'))
                kind = 'output';
            else if (kindText.includes('输入'))
                kind = 'inputMiss';
            if (kind === undefined)
                continue;
            const value = parsePriceCell(row[priceCol] ?? '');
            if (value === undefined)
                continue;
            // One row may list several version names sharing the same price.
            for (const rawId of (row[modelCol] ?? '').split(/\s+/)) {
                const model = rawId.trim().toLowerCase();
                if (!/^ernie[\w.-]*$/.test(model))
                    continue;
                const existing = table[model] ?? { inputCacheHit: 0, inputMiss: 0, output: 0 };
                if (existing[kind] === 0)
                    existing[kind] = value * scale;
                table[model] = existing;
            }
        }
    }
    return table;
}
/**
 * Zhipu GLM current flagship pricing. open.bigmodel.cn/pricing is a Vue SPA
 * shell (3.7KB, no data); the live prices are embedded in its app.*.js i18n
 * bundle as
 * `newModel:{...modelList:[{name:"GLM-5.2",...,inPrice:["8元"],outPrice:["28元"],hit:["2元"]}]}`.
 * Tiered models repeat as entries with name:""; only named rows are read, so
 * the first (lowest) tier wins. "免费" entries become 0.
 */
export function parseZhipuBundleSheet(js) {
    const table = {};
    const start = js.indexOf('newModel:{');
    if (start < 0)
        return table;
    const region = js.slice(start, start + 200_000);
    const entryRe = /\{name:"([^"]*)"[^{}]*?inPrice:\["(?:(\d+(?:\.\d+)?)元|免费)"\][^{}]*?outPrice:\["(?:(\d+(?:\.\d+)?)元|免费)"\][^{}]*?\}/g;
    let match;
    while ((match = entryRe.exec(region)) !== null) {
        const model = (match[1] ?? '').trim().toLowerCase();
        if (!/^glm[\w.-]*$/.test(model))
            continue;
        if (table[model] !== undefined)
            continue; // keep the first (lowest) tier
        const hitMatch = match[0].match(/hit:\["(?:(\d+(?:\.\d+)?)元|免费)"\]/);
        table[model] = {
            inputCacheHit: Number(hitMatch?.[1] ?? 0),
            inputMiss: Number(match[2] ?? 0),
            output: Number(match[3] ?? 0),
        };
    }
    return table;
}
/**
 * Zhipu legacy models (GLM-4 generation and earlier) from the public
 * /api/biz/operation/query endpoint (no auth). Slots 1122/1123 carry a
 * stringified JSON `content` where fieldList maps random row-key codes to
 * column labels. 单价 is a single per-token rate billed equally for input and
 * output; only "元 / 百万Tokens"/"免费" cells are accepted so per-image or
 * per-call categories are excluded.
 */
export function parseZhipuLegacySheet(jsonText) {
    const table = {};
    let slots = [];
    try {
        slots = JSON.parse(jsonText).data ?? [];
    }
    catch {
        return table;
    }
    for (const slot of slots) {
        if (slot.operationId !== '1122' && slot.operationId !== '1123')
            continue;
        let content;
        try {
            content = JSON.parse(slot.content ?? '{}');
        }
        catch {
            continue;
        }
        for (const cat of content.list ?? []) {
            const fields = cat.fieldList ?? [];
            const modelCode = fields.find(f => (f.label ?? '').includes('模型'))?.code;
            const priceCode = fields.find(f => (f.label ?? '').includes('单价'))?.code;
            if (modelCode === undefined || priceCode === undefined)
                continue;
            for (const row of cat.modelList ?? []) {
                const model = (row[modelCode] ?? '').trim().toLowerCase();
                if (!/^glm[\w.-]*$/.test(model))
                    continue;
                const cell = row[priceCode] ?? '';
                if (!/免费|百万\s*tokens/i.test(cell))
                    continue; // skip 元/张、元/万字符 etc.
                const value = parsePriceCell(cell);
                if (value === undefined || table[model] !== undefined)
                    continue;
                // Cells like "输入：16元/百万 tokens…；输出：不计费" bill output at 0.
                const output = /输出[：:]\s*不计费/.test(cell) ? 0 : value;
                table[model] = { inputCacheHit: 0, inputMiss: value, output };
            }
        }
    }
    return table;
}
/**
 * ByteDance Doubao (火山方舟) pricing. The doc page is client-rendered Quill
 * rich text, but the doc-center API serves the same content as server-side
 * Markdown (Result.MDContent). Text-model tables sit under the `# 大语言模型`
 * H1 while video/image models (doubao-seedance-*) live under other H1s, so
 * section filtering alone excludes them reliably. Merged tier rows have an
 * empty model cell (higher tiers) and are skipped — the lowest tier wins.
 */
export function parseDoubaoSheet(markdown) {
    const table = {};
    const clean = (t) => t.replace(/<br\s*\/?>/gi, ' ').replace(/\\/g, '').replace(/\s+/g, ' ').trim();
    const splitRow = (row) => row.replace(/^\|/, '').replace(/\|$/, '').split('|').map(clean);
    let inLlmSection = false;
    const lines = markdown.split('\n');
    let i = 0;
    while (i < lines.length) {
        const line = lines[i] ?? '';
        const h1 = line.match(/^#\s+([^#].*)$/);
        if (h1 !== null) {
            inLlmSection = (h1[1] ?? '').includes('大语言模型');
            i += 1;
            continue;
        }
        if (!inLlmSection || !line.startsWith('|')) {
            i += 1;
            continue;
        }
        const block = [];
        while (i < lines.length && (lines[i] ?? '').startsWith('|')) {
            block.push(lines[i] ?? '');
            i += 1;
        }
        const header = splitRow(block[0] ?? '');
        const modelCol = header.findIndex(h => /模型名称|^模型$/.test(h));
        const inputCol = header.findIndex(h => h.includes('输入') && h.includes('非音频'));
        const outputCol = header.findIndex(h => h.includes('输出') && !h.includes('输入'));
        const hitCol = header.findIndex(h => h.includes('缓存命中') && h.includes('非音频'));
        if (modelCol < 0 || inputCol < 0 || outputCol < 0)
            continue;
        for (const rowText of block.slice(2)) { // skip header + separator rows
            const row = splitRow(rowText);
            const model = (row[modelCol] ?? '').toLowerCase();
            // Empty cell = continuation tier of the previous model; seedance is the
            // video family (excluded by the section filter already, double-guarded).
            if (!model.startsWith('doubao') || model.includes('seedance'))
                continue;
            if (table[model] !== undefined)
                continue;
            const inputMiss = parsePriceCell(row[inputCol] ?? '');
            const output = parsePriceCell(row[outputCol] ?? '');
            if (inputMiss === undefined || output === undefined)
                continue;
            const hit = hitCol >= 0 ? parsePriceCell(row[hitCol] ?? '') : undefined;
            table[model] = { inputCacheHit: hit ?? 0, inputMiss, output };
        }
    }
    return table;
}
/**
 * Kimi pricing. The docs site is client-rendered Next.js; the price tables
 * live in the RSC flight payload as
 * `columns:[{title:`输入价格（缓存命中）`...}],rows:[[`kimi-k2.6`,`1M tokens`,`¥1.10`,...]]`.
 * Column meanings come from the titles, so added/removed columns survive.
 */
export function parseKimiSheet(rscText) {
    const table = {};
    const blockRe = /columns:\[([\s\S]*?)\],rows:\[\[([\s\S]*?)\]\]/g;
    let match;
    while ((match = blockRe.exec(rscText)) !== null) {
        const titles = [...(match[1] ?? '').matchAll(/title:`([^`]*)`/g)].map(m => m[1] ?? '');
        const kindByCol = new Map();
        titles.forEach((title, col) => {
            if (title.includes('缓存命中'))
                kindByCol.set(col, 'inputCacheHit');
            else if (title.includes('缓存未命中') || (title.includes('输入') && !title.includes('缓存')))
                kindByCol.set(col, 'inputMiss');
            else if (title.includes('输出'))
                kindByCol.set(col, 'output');
        });
        const kinds = [...kindByCol.values()];
        if (!kinds.includes('inputMiss') || !kinds.includes('output'))
            continue;
        for (const rowText of (match[2] ?? '').split('],[')) {
            const cells = [...rowText.matchAll(/`([^`]*)`/g)].map(m => m[1] ?? '');
            const model = (cells[0] ?? '').trim().toLowerCase();
            if (!/^(kimi|moonshot)[\w.-]*$/.test(model))
                continue;
            const price = { inputCacheHit: 0, inputMiss: 0, output: 0 };
            let priced = false;
            for (const [col, kind] of kindByCol) {
                const value = parsePriceCell(cells[col] ?? '');
                if (value !== undefined) {
                    price[kind] = value;
                    priced = true;
                }
            }
            if (priced && (price.inputMiss > 0 || price.output > 0))
                table[model] = price;
        }
    }
    return table;
}
