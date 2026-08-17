import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { settingsNamespace } from '@deepseek-ai/dsh-settings';
import { costOf, OFFICIAL_PRICING_URL, PriceService } from './pricing.js';
import { formatCny, formatPrice, formatTokens, resolveLedgerPath, UsageLedger } from './ledger.js';
import { beijingDate } from './types.js';
export const name = 'dsh-usage-ledger';
export const inject = ['sessions', 'tools', 'systemPrompt', 'settings'];
/** Schemastery validator for {@link Config}. */
export const Config = z.object({
    ledgerPath: z.string().default(''),
    saveIntervalMs: z.number().default(5000),
    pricingTimeoutMs: z.number().default(10000),
});
/** Schemastery schema of the `usage-ledger` namespace section. */
export const UsageLedgerSchema = z.object({
    dailyBudget: z.number().default(0),
    totalBudget: z.number().default(0),
    sessionBudget: z.number().default(0),
    warnRatio: z.number().default(0.8),
    enforceBudget: z.boolean().default(true),
    pricingUrl: z.string().default(OFFICIAL_PRICING_URL),
    refreshIntervalMin: z.number().default(60),
    customPrices: z.dict(z.object({
        inputCacheHit: z.number().default(0),
        inputMiss: z.number().required(),
        output: z.number().required(),
    })).default({}),
});
export const USAGE_LEDGER_NAMESPACE = settingsNamespace('usage-ledger');
/**
 * Mount the plugin: ledger, pricing service, session fold, budget gate,
 * report tool, dashboard route, and prompt warning.
 * @param ctx - the plugin context.
 * @param config - schemastery-resolved {@link Config}.
 */
export function apply(ctx, config) {
    const scope = ctx.settings.register(USAGE_LEDGER_NAMESPACE, UsageLedgerSchema, { applies: 'live' });
    let settings = scope.get();
    const ledger = new UsageLedger(resolveLedgerPath(config.ledgerPath), settings, ctx.logger, config.saveIntervalMs);
    const prices = new PriceService(settings.pricingUrl, config.pricingTimeoutMs, ctx.logger);
    prices.setOverrides(settings.customPrices);
    // Per-session model route and pending step usage (chunk-reported usage is
    // replaced by the assembled assistant message's usage for the same step).
    const routes = new Map();
    const pendingStepUsage = new Map();
    const stepKey = (turn, step) => `${turn}/${step}`;
    /** Price and record one usage sample for a session. */
    const recordUsage = (sessionId, time, usage, turn, step) => {
        const route = routes.get(sessionId);
        const model = route?.model;
        const price = model === undefined ? undefined : prices.resolve(model, time);
        ledger.record(sessionId, {
            time,
            usage,
            model,
            provider: route?.provider,
            cost: costOf(price, usage),
        });
        pendingStepUsage.get(sessionId)?.delete(stepKey(turn, step));
        syncPromptSection();
    };
    /** Fold one session log from the ledger watermark to its current tail. */
    const foldSession = (session) => {
        const sessionId = String(session.id);
        const events = session.events;
        let seq = ledger.lastSeq(sessionId) + 1;
        if (seq >= events.length)
            return;
        while (seq < events.length) {
            const event = events[seq];
            if (event === undefined)
                break;
            foldEvent(sessionId, event);
            seq += 1;
        }
        ledger.advanceSeq(sessionId, events.length - 1);
    };
    /** Fold one event into routes, pending usage, titles, and the ledger. */
    const foldEvent = (sessionId, event) => {
        const type = event.type;
        const data = event.data;
        switch (type) {
            case 'request/header': {
                const headerConfig = data.header?.config;
                if (headerConfig !== undefined) {
                    routes.set(sessionId, { provider: headerConfig.provider, model: headerConfig.model });
                }
                break;
            }
            case 'assistant/chunk': {
                const chunk = data.chunk;
                const turn = data.turn;
                const step = data.step;
                if (chunk?.type === 'usage' && turn !== undefined && step !== undefined) {
                    let pending = pendingStepUsage.get(sessionId);
                    if (pending === undefined) {
                        pending = new Map();
                        pendingStepUsage.set(sessionId, pending);
                    }
                    const route = routes.get(sessionId);
                    const model = route?.model;
                    const price = model === undefined ? undefined : prices.resolve(model, event.time);
                    pending.set(stepKey(turn, step), {
                        time: event.time,
                        usage: chunk.usage,
                        model,
                        provider: route?.provider,
                        cost: costOf(price, chunk.usage),
                    });
                }
                break;
            }
            case 'assistant/message': {
                const turn = data.turn;
                const step = data.step;
                const usage = data.usage;
                if (turn === undefined || step === undefined)
                    break;
                if (usage !== undefined) {
                    recordUsage(sessionId, event.time, usage, turn, step);
                }
                break;
            }
            case 'step/end': {
                // A step that reported usage by chunk but never assembled a message
                // (failed/cancelled call) still consumed tokens: count it now.
                const turn = data.turn;
                const step = data.step;
                if (turn === undefined || step === undefined)
                    break;
                const sample = pendingStepUsage.get(sessionId)?.get(stepKey(turn, step));
                if (sample !== undefined) {
                    ledger.record(sessionId, sample);
                    pendingStepUsage.get(sessionId)?.delete(stepKey(turn, step));
                    syncPromptSection();
                }
                break;
            }
            case 'session/title': {
                const title = data.title;
                if (typeof title === 'string' && title !== '') {
                    ledger.setTitle(sessionId, title, event.time);
                }
                break;
            }
            default:
                break;
        }
    };
    // ---- budget warning prompt section (dynamic toggle) ----
    let sectionDisposer;
    let sectionText;
    const budgetSectionText = () => {
        if (!ledger.hasBudget)
            return undefined;
        const status = ledger.budgetStatus(Date.now());
        const parts = [];
        if (status.daily.exceeded)
            parts.push(`今日费用 ${formatCny(status.daily.cost)} 已超出预算 ${formatCny(status.daily.budget)}`);
        else if (status.daily.warn)
            parts.push(`今日费用 ${formatCny(status.daily.cost)} 已达预算 ${formatCny(status.daily.budget)} 的 ${(status.daily.ratio * 100).toFixed(0)}%`);
        if (status.total.exceeded)
            parts.push(`累计费用 ${formatCny(status.total.cost)} 已超出总预算 ${formatCny(status.total.budget)}`);
        else if (status.total.warn)
            parts.push(`累计费用 ${formatCny(status.total.cost)} 已达总预算 ${formatCny(status.total.budget)} 的 ${(status.total.ratio * 100).toFixed(0)}%`);
        if (parts.length === 0)
            return undefined;
        return [
            '[usage-ledger 成本警告]',
            parts.join('；') + '。',
            '请严格控制成本：减少不必要的模型调用与工具调用，回复保持简洁，避免重复读取大文件；非必要不要展开长任务。',
        ].join('\n');
    };
    const syncPromptSection = () => {
        const next = budgetSectionText();
        if (next === sectionText)
            return;
        sectionDisposer?.();
        sectionDisposer = undefined;
        sectionText = next;
        if (next !== undefined) {
            sectionDisposer = ctx.systemPrompt.section({ name: 'usage-ledger:budget-warning', order: 150, text: next });
        }
    };
    // ---- budget gate on the llm/stream waterfall ----
    ctx.on('llm/stream', (options, next) => {
        if (!settings.enforceBudget || !ledger.isExceeded(Date.now(), options.sessionId === undefined ? undefined : String(options.sessionId))) {
            return next();
        }
        const status = ledger.budgetStatus(Date.now());
        const which = status.daily.exceeded
            ? `今日预算已用尽（${formatCny(status.daily.cost)} / ${formatCny(status.daily.budget)}）`
            : status.total.exceeded
                ? `总预算已用尽（${formatCny(status.total.cost)} / ${formatCny(status.total.budget)}）`
                : `会话预算已用尽`;
        const message = `usage-ledger: ${which}，已阻止本次模型调用。请调整 usage-ledger 设置中的预算（settings 命名空间 "usage-ledger"）后重试。`;
        return (async function* () {
            yield { type: 'finish', reason: { kind: 'error', failure: { message, code: 'BUDGET_EXCEEDED' } } };
        })();
    });
    // ---- session fold wiring ----
    ctx.on('session/created', (session) => {
        foldSession(session);
    });
    ctx.on('session/event', (session) => {
        foldSession(session);
    });
    // Catch up sessions already live in the store (plugin load or HMR reload).
    for (const session of ctx.sessions.list())
        foldSession(session);
    // ---- usage_report tool ----
    const renderReport = (view, limit, currentSessionId) => {
        const now = Date.now();
        const day = beijingDate(now);
        const lines = [];
        const sheet = prices.currentSheet;
        if (view === 'all' || view === 'budget') {
            const status = ledger.budgetStatus(now, currentSessionId);
            lines.push(`# 用量与成本报告（${day}，北京时间）`);
            lines.push('');
            lines.push('## 预算状态');
            const describe = (label, state) => {
                if (state.budget <= 0)
                    return `- ${label}: 未设置预算，已花费 ${formatCny(state.cost)}`;
                const stateText = state.exceeded ? '⛔ 已超出' : state.warn ? '⚠️ 接近上限' : '✅ 正常';
                return `- ${label}: ${formatCny(state.cost)} / ${formatCny(state.budget)}（${(state.ratio * 100).toFixed(1)}%）${stateText}`;
            };
            lines.push(describe('今日', status.daily));
            lines.push(describe('累计', status.total));
            if (status.session !== undefined)
                lines.push(describe('当前会话', status.session));
            lines.push('');
            lines.push('## 定价（国产主流大模型）');
            lines.push(`- 自动刷新: 每 ${settings.refreshIntervalMin} 分钟抓取各厂商官方定价页，新模型与调价自动导入${prices.lastChangedAt !== undefined ? `（最近一次官方价格变更: ${new Date(prices.lastChangedAt).toISOString()}）` : ''}`);
            for (const vendor of prices.vendorPricing(now)) {
                const note = vendor.tiered ? '（阶梯计价，最低档）' : '';
                const src = vendor.source === 'live' ? '官方实时' : vendor.source === 'override' ? '自定义' : '内置快照';
                lines.push(`### ${vendor.label}${note} [${src}]`);
                for (const [model, price] of Object.entries(vendor.models)) {
                    lines.push(`- ${model}: ${formatPrice(price)}`);
                }
            }
            if (sheet.scheduled !== undefined) {
                lines.push(`- DeepSeek 峰谷定价自 ${sheet.scheduled.effective} 生效（北京时间高峰时段按 peak 价计费）`);
            }
            const today = ledger.daily(day);
            const total = ledger.total();
            lines.push('');
            lines.push('## 汇总');
            lines.push(`- 今日: ${today.calls} 次调用, ${formatTokens(today.tokens)} tokens, ${formatCny(today.cost)}`);
            lines.push(`- 累计: ${total.calls} 次调用, ${formatTokens(total.tokens)} tokens, ${formatCny(total.cost)}`);
        }
        if (view === 'all' || view === 'sessions') {
            lines.push('');
            lines.push('## 按对话（会话）消耗');
            const rows = ledger.sessions();
            if (rows.length === 0) {
                lines.push('（暂无记录）');
            }
            else {
                const top = rows.slice(0, Math.max(1, limit));
                lines.push('| 会话 | 模型 | 调用 | 输入tokens | 输出tokens | 缓存读 | 费用 |');
                lines.push('|---|---|---|---|---|---|---|');
                for (const [id, row] of top) {
                    const title = row.title !== '' ? row.title : id.slice(0, 12);
                    const marker = id === currentSessionId ? '（当前）' : '';
                    lines.push(`| ${title}${marker} | ${row.model ?? '-'} | ${row.calls} | ${formatTokens(row.inputTokens)} | ${formatTokens(row.outputTokens)} | ${formatTokens(row.cacheReadTokens)} | ${formatCny(row.cost)} |`);
                }
                if (rows.length > top.length)
                    lines.push(`（另有 ${rows.length - top.length} 个会话未列出）`);
            }
        }
        return lines.join('\n');
    };
    ctx.tools.register(defineTool({
        name: 'usage_report',
        description: 'Report token usage and cost: per-session consumption, daily/total totals, budget status, and the current DeepSeek official pricing. Use when the user asks about token usage, cost, or budget.',
        parameters: {
            view: {
                type: 'string',
                enum: ['all', 'budget', 'sessions'],
                description: 'Report scope: "all" (default) = budget + pricing + totals + per-session table; "budget" = budget/pricing/totals only; "sessions" = per-session table only.',
            },
            limit: {
                type: 'integer',
                description: 'Maximum number of sessions to list (default 15).',
            },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute(args, exec) {
            const agent = exec.agent;
            const currentSessionId = agent?.id;
            return renderReport(args.view ?? 'all', args.limit ?? 15, currentSessionId);
        },
    }));
    // ---- HTTP dashboard (optional: only when a web server is composed) ----
    ctx.inject(['webServer'], (webCtx) => {
        const jsonResponse = (res, body) => {
            const payload = JSON.stringify(body);
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
            res.end(payload);
        };
        webCtx.webServer.register({
            kind: 'exact',
            path: '/api/usage-ledger',
            handler: (_req, res) => {
                const now = Date.now();
                jsonResponse(res, {
                    generatedAt: now,
                    day: beijingDate(now),
                    budgets: ledger.budgetStatus(now),
                    pricing: {
                        source: prices.currentSheet.source,
                        sourceUrl: prices.currentSheet.sourceUrl,
                        fetchedAt: prices.currentSheet.fetchedAt,
                        lastChangedAt: prices.lastChangedAt,
                        current: prices.currentSheet.current,
                        scheduled: prices.currentSheet.scheduled,
                        vendors: prices.vendorPricing(now),
                    },
                    today: ledger.daily(beijingDate(now)),
                    total: ledger.total(),
                    sessions: ledger.sessions().map(([id, row]) => ({ id, ...row })),
                });
            },
        });
        webCtx.webServer.register({
            kind: 'exact',
            path: '/usage-ledger',
            handler: (_req, res) => {
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
                res.end(DASHBOARD_HTML);
            },
        });
        ctx.logger.info('usage-ledger: dashboard at /usage-ledger, JSON API at /api/usage-ledger');
    });
    // ---- pricing refresh loop ----
    let refreshTimer;
    const startRefreshLoop = () => {
        if (refreshTimer !== undefined)
            clearInterval(refreshTimer);
        const intervalMs = Math.max(5, settings.refreshIntervalMin) * 60_000;
        refreshTimer = setInterval(() => {
            // DeepSeek 官方页 + 全部国产厂商官方定价页，新模型自动导入。
            void prices.refreshAll();
        }, intervalMs);
        refreshTimer.unref?.();
    };
    void prices.refreshAll();
    startRefreshLoop();
    // ---- live settings updates ----
    const stopWatch = scope.watch((next) => {
        const prev = settings;
        settings = next;
        ledger.setBudgets(next);
        syncPromptSection();
        if (next.refreshIntervalMin !== prev.refreshIntervalMin)
            startRefreshLoop();
        if (next.pricingUrl !== prev.pricingUrl) {
            prices.setUrl(next.pricingUrl);
            void prices.refresh();
        }
        if (next.customPrices !== prev.customPrices)
            prices.setOverrides(next.customPrices);
    });
    syncPromptSection();
    ctx.effect(() => {
        return () => {
            stopWatch();
            if (refreshTimer !== undefined)
                clearInterval(refreshTimer);
            sectionDisposer?.();
            ledger.dispose();
        };
    }, 'dsh-usage-ledger: lifecycle');
}
/** Self-contained dashboard page (zh-CN). */
const DASHBOARD_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DeepSeek Harness 用量面板</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; margin: 0; padding: 24px; background: #f6f7f9; color: #1f2329; }
  @media (prefers-color-scheme: dark) { body { background: #17181c; color: #e6e8eb; } .card, table { background: #202228 !important; } th { background: #26282f !important; } }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #8a9099; font-size: 12px; margin-bottom: 20px; }
  .cards { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 20px; }
  .card { background: #fff; border-radius: 10px; padding: 14px 18px; min-width: 180px; box-shadow: 0 1px 3px rgba(0,0,0,.06); }
  .card .label { font-size: 12px; color: #8a9099; }
  .card .value { font-size: 22px; font-weight: 600; margin-top: 4px; }
  .card .extra { font-size: 12px; color: #8a9099; margin-top: 2px; }
  .bar { height: 6px; border-radius: 3px; background: #e8eaed; margin-top: 8px; overflow: hidden; }
  .bar > div { height: 100%; border-radius: 3px; background: #3370ff; }
  .bar > div.warn { background: #f5a623; }
  .bar > div.exceed { background: #e5484d; }
  table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 10px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,.06); font-size: 13px; }
  th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid rgba(120,130,140,.12); }
  th { background: #fafbfc; font-weight: 600; color: #8a9099; font-size: 12px; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  h2 { font-size: 15px; margin: 24px 0 10px; }
  .tag { display: inline-block; font-size: 11px; padding: 1px 8px; border-radius: 9px; background: #eef3ff; color: #3370ff; }
</style>
</head>
<body>
<h1>DeepSeek Harness 用量面板</h1>
<div class="sub" id="meta">加载中…</div>
<div class="cards" id="cards"></div>
<h2>按对话消耗</h2>
<table id="sessions">
  <thead><tr><th>会话</th><th>模型</th><th class="num">调用</th><th class="num">输入 tokens</th><th class="num">输出 tokens</th><th class="num">缓存读 tokens</th><th class="num">费用</th><th>最近更新</th></tr></thead>
  <tbody></tbody>
</table>
<h2>当前定价（国产主流大模型）</h2>
<div id="pricing"></div>
<script>
const fmtCny = v => v === 0 ? '¥0' : v < 0.01 ? '¥' + v.toFixed(4) : v < 1 ? '¥' + v.toFixed(3) : '¥' + v.toFixed(2);
const fmtNum = v => v.toLocaleString('en-US');
function budgetCard(label, state) {
  if (!state) return '';
  const pct = state.budget > 0 ? Math.min(100, state.ratio * 100) : 0;
  const cls = state.exceeded ? 'exceed' : state.warn ? 'warn' : '';
  const extra = state.budget > 0
    ? fmtCny(state.cost) + ' / ' + fmtCny(state.budget) + (state.exceeded ? '（已超出）' : '')
    : '未设置预算，已花费 ' + fmtCny(state.cost);
  return '<div class="card"><div class="label">' + label + '</div><div class="value">' + fmtCny(state.cost) + '</div>'
    + '<div class="extra">' + extra + '</div>'
    + (state.budget > 0 ? '<div class="bar"><div class="' + cls + '" style="width:' + pct + '%"></div></div>' : '')
    + '</div>';
}
async function load() {
  const data = await (await fetch('/api/usage-ledger')).json();
  const fmtTime = t => t ? new Date(t).toLocaleString('zh-CN') : '-';
  document.getElementById('meta').textContent = '统计日期 ' + data.day + '（北京时间） · 定价来源 '
    + (data.pricing.source === 'live' ? '官方页面自动抓取' : '内置快照')
    + ' · 定价抓取于 ' + fmtTime(data.pricing.fetchedAt)
    + (data.pricing.lastChangedAt ? ' · 官方价格变更于 ' + fmtTime(data.pricing.lastChangedAt) : '')
    + ' · 数据更新于 ' + fmtTime(data.generatedAt);
  document.getElementById('cards').innerHTML =
    budgetCard('今日花费', data.budgets.daily) + budgetCard('累计花费', data.budgets.total)
    + '<div class="card"><div class="label">今日调用</div><div class="value">' + data.today.calls + '</div><div class="extra">' + fmtNum(data.today.tokens) + ' tokens</div></div>'
    + '<div class="card"><div class="label">累计调用</div><div class="value">' + data.total.calls + '</div><div class="extra">' + fmtNum(data.total.tokens) + ' tokens</div></div>';
  const tbody = document.querySelector('#sessions tbody');
  tbody.innerHTML = data.sessions.length === 0 ? '<tr><td colspan="8">暂无记录</td></tr>' : data.sessions.map(row =>
    '<tr><td>' + (row.title || row.id.slice(0, 12)) + '</td><td>' + (row.model || '-') + '</td>'
    + '<td class="num">' + row.calls + '</td><td class="num">' + fmtNum(row.inputTokens) + '</td>'
    + '<td class="num">' + fmtNum(row.outputTokens) + '</td><td class="num">' + fmtNum(row.cacheReadTokens) + '</td>'
    + '<td class="num">' + fmtCny(row.cost) + '</td><td>' + new Date(row.updatedAt).toLocaleString('zh-CN') + '</td></tr>').join('');
  const pdiv = document.getElementById('pricing');
  const srcTag = v => v.source === 'live' ? '<span class="tag">官方实时</span>' : v.source === 'override' ? '<span class="tag">自定义</span>' : '<span class="tag">内置快照</span>';
  const fetchedTag = v => v.fetchedAt ? ' <span class="tag">抓取于 ' + fmtTime(v.fetchedAt) + '</span>' : '';
  pdiv.innerHTML = (data.pricing.vendors ?? []).map(v =>
    '<h3 style="font-size:13px;margin:16px 0 6px;color:#8a9099">' + v.label + ' ' + srcTag(v) + (v.tiered ? ' <span class="tag">阶梯计价·最低档</span>' : '') + fetchedTag(v) + '</h3>'
    + '<table><thead><tr><th>模型</th><th class="num">输入·缓存命中 (元/M)</th><th class="num">输入·未命中 (元/M)</th><th class="num">输出 (元/M)</th></tr></thead><tbody>'
    + Object.entries(v.models).map(([model, p]) =>
      '<tr><td>' + model + '</td><td class="num">' + p.inputCacheHit + '</td><td class="num">' + p.inputMiss + '</td><td class="num">' + p.output + '</td></tr>').join('')
    + '</tbody></table>').join('');
}
load().catch(e => document.getElementById('meta').textContent = '加载失败: ' + e);
setInterval(() => load().catch(() => {}), 30000);
</script>
</body>
</html>`;
