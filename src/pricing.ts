/**
 * Dynamic official pricing for all mainstream domestic vendors.
 *
 * DeepSeek: fetches and parses the public pricing page with a built-in
 * fallback snapshot; understands the time-of-day (peak/off-peak, 峰谷)
 * schedule — prices are resolved per call time in Beijing time.
 *
 * Other vendors (智谱/Kimi/通义/豆包/MiniMax/文心): each official pricing
 * page is scraped on the same refresh loop; newly published models are
 * imported automatically, so no code change is needed when a vendor adds a
 * model to its pricing page.
 *
 * Resolution priority: user overrides > DeepSeek live sheet > vendor live
 * tables > built-in catalog exact > longest prefix.
 */
import { CATALOG_TABLE, VENDORS, vendorOf } from './catalog.js'
import { BROWSER_UA, parseDoubaoSheet, parseErnieSheet, parseKimiSheet, parsePriceCell, parseRawTables, parseVendorSheet, parseZhipuBundleSheet, parseZhipuLegacySheet, toGrid } from './scrapers.js'
import { beijingDate } from './types.js'
import type { ModelPrice, PriceSheet, PriceTable, ScheduledPricing } from './types.js'

/** Official DeepSeek API pricing page (zh-CN). */
export const OFFICIAL_PRICING_URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/'

/** Minimal logger shape (structurally compatible with the cordis logger). */
export interface MinimalLogger {
  warn(...args: unknown[]): void
  info(...args: unknown[]): void
  error(...args: unknown[]): void
}

/**
 * Built-in fallback sheet (CNY per 1M tokens), mirroring the official page on
 * 2026-08-14: flat prices now, peak/off-peak schedule from 2026-08-17.
 */
export const BUILTIN_SHEET: PriceSheet = {
  source: 'builtin',
  current: {
    'deepseek-v4-flash': { inputCacheHit: 0.02, inputMiss: 1, output: 2 },
    'deepseek-v4-pro': { inputCacheHit: 0.025, inputMiss: 3, output: 6 },
  },
  scheduled: {
    effective: '2026-08-17',
    peakWindows: [[9, 12], [14, 18]],
    offPeak: {
      'deepseek-v4-flash': { inputCacheHit: 0.05, inputMiss: 1.5, output: 4.5 },
      'deepseek-v4-pro': { inputCacheHit: 0.15, inputMiss: 4.5, output: 13.5 },
    },
    peak: {
      'deepseek-v4-flash': { inputCacheHit: 0.1, inputMiss: 3, output: 9 },
      'deepseek-v4-pro': { inputCacheHit: 0.3, inputMiss: 9, output: 27 },
    },
  },
}

/** Default Beijing-time peak windows [startHour, endHour), per DeepSeek. */
export const DEFAULT_PEAK_WINDOWS: ReadonlyArray<readonly [number, number]> = [[9, 12], [14, 18]]

/** Token usage shape accepted by the cost function. */
export interface UsageLike {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/**
 * Cost of one call in CNY. Cache reads bill at the cache-hit price; cache
 * writes bill at the uncached input price (DeepSeek folds them into ordinary
 * input); unknown prices cost 0 (tokens are still counted).
 */
export function costOf(price: ModelPrice | undefined, usage: UsageLike): number {
  if (price === undefined) return 0
  return (
    usage.inputTokens * price.inputMiss
    + (usage.cacheReadTokens ?? 0) * price.inputCacheHit
    + (usage.cacheWriteTokens ?? 0) * price.inputMiss
    + usage.outputTokens * price.output
  ) / 1_000_000
}

/** Whether one Beijing-time instant falls inside any peak window. */
export function isPeakTime(
  atMs: number,
  windows: ReadonlyArray<readonly [number, number]> = DEFAULT_PEAK_WINDOWS,
): boolean {
  const shifted = new Date(atMs + 8 * 3600_000)
  const hour = shifted.getUTCHours() + shifted.getUTCMinutes() / 60
  return windows.some(([start, end]) => hour >= start && hour < end)
}

/** Resolve the model price in force at one instant under one sheet. */
export function resolvePrice(sheet: PriceSheet, model: string, atMs: number): ModelPrice | undefined {
  let table: PriceTable = sheet.current
  if (sheet.scheduled !== undefined && beijingDate(atMs) >= sheet.scheduled.effective) {
    table = isPeakTime(atMs, sheet.scheduled.peakWindows ?? DEFAULT_PEAK_WINDOWS)
      ? sheet.scheduled.peak
      : sheet.scheduled.offPeak
  }
  return table[model]
}

/** Fetch one URL as text with a timeout. */
export async function fetchText(url: string, timeoutMs: number, headers: Record<string, string> = {}): Promise<string> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'user-agent': 'dsh-usage-ledger/0.1 (pricing fetch)', ...headers },
  })
  if (!response.ok) throw new Error(`pricing fetch failed: HTTP ${response.status}`)
  return response.text()
}

const isModelId = (text: string): boolean => /^deepseek-[\w.-]+$/i.test(text.trim())

/** Parse one "0.05元" / "¥1.5" style cell into a number (DeepSeek page). */
function parseDeepSeekPrice(text: string): number | undefined {
  return parsePriceCell(text)
}

/**
 * Parse the DeepSeek pricing page HTML into a sheet. Throws when no
 * recognizable price table exists (the caller keeps its last good sheet).
 */
export function parsePriceSheet(html: string, url: string): PriceSheet {
  const grids = parseRawTables(html).map(toGrid)

  // Flat "current" table: header row lists model ids as columns; label rows
  // carry the three price kinds.
  let current: PriceTable | undefined
  for (const grid of grids) {
    const header = grid[0]
    if (header === undefined) continue
    const modelCols: Array<[number, string]> = []
    header.forEach((text, col) => {
      if (isModelId(text)) modelCols.push([col, text.trim().toLowerCase()])
    })
    if (modelCols.length < 1) continue
    const table: PriceTable = {}
    for (const row of grid.slice(1)) {
      const label = row.join(' ')
      const pick = (col: number): number | undefined => parseDeepSeekPrice(row[col] ?? '')
      for (const [col, model] of modelCols) {
        const existing = table[model] ?? { inputCacheHit: 0, inputMiss: 0, output: 0 }
        if (label.includes('缓存未命中')) {
          const value = pick(col)
          if (value !== undefined) existing.inputMiss = value
        }
        else if (label.includes('缓存命中')) {
          const value = pick(col)
          if (value !== undefined) existing.inputCacheHit = value
        }
        else if (label.includes('输出')) {
          const value = pick(col)
          if (value !== undefined) existing.output = value
        }
        table[model] = existing
      }
    }
    const priced = Object.values(table).some(p => p.inputMiss > 0 || p.output > 0)
    if (priced) {
      current = table
      break
    }
  }

  // Scheduled peak/off-peak table: header names the three price kinds as
  // columns; rows are [model, 空闲/高峰时段, hit, miss, output].
  let scheduled: ScheduledPricing | undefined
  for (const grid of grids) {
    const header = grid[0]
    if (header === undefined) continue
    if (!header.some(text => text.includes('缓存命中')) || !header.some(text => text.includes('输出'))) continue
    const offPeak: PriceTable = {}
    const peak: PriceTable = {}
    for (const row of grid.slice(1)) {
      const modelCell = row[0] ?? ''
      if (!isModelId(modelCell) || row.length < 5) continue
      const model = modelCell.trim().toLowerCase()
      const price: ModelPrice = {
        inputCacheHit: parseDeepSeekPrice(row[2] ?? '') ?? 0,
        inputMiss: parseDeepSeekPrice(row[3] ?? '') ?? 0,
        output: parseDeepSeekPrice(row[4] ?? '') ?? 0,
      }
      if ((row[1] ?? '').includes('高峰')) peak[model] = price
      else offPeak[model] = price
    }
    if (Object.keys(peak).length > 0 && Object.keys(offPeak).length > 0) {
      scheduled = { effective: '', peakWindows: DEFAULT_PEAK_WINDOWS.slice(), offPeak, peak }
      break
    }
  }

  if (current === undefined && scheduled === undefined) {
    throw new Error('pricing page: no recognizable price table')
  }
  // After a schedule replaces the flat table, bill pre-effective dates at the
  // conservative (peak) rate rather than fail.
  if (current === undefined && scheduled !== undefined) current = scheduled.peak

  // Effective date: "…2026 年 8 月 17 日 00:00 开始生效".
  if (scheduled !== undefined) {
    const effective = html.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日[^<。]{0,40}?开始生效/)
    if (effective !== null && effective[1] !== undefined && effective[2] !== undefined && effective[3] !== undefined) {
      scheduled.effective = `${effective[1]}-${effective[2].padStart(2, '0')}-${effective[3].padStart(2, '0')}`
    }
    // Peak windows: "高峰时段为北京时间 9:00 - 12:00、14:00 - 18:00".
    const windows = html.match(/高峰时段为北京时间\s*(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})\s*[、,，]\s*(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})/)
    if (windows !== null) {
      const nums = windows.slice(1, 9).map(Number) as [number, number, number, number, number, number, number, number]
      scheduled.peakWindows = [
        [nums[0] + nums[1] / 60, nums[2] + nums[3] / 60],
        [nums[4] + nums[5] / 60, nums[6] + nums[7] / 60],
      ]
    }
    // A schedule with no parsed date never activates.
    if (scheduled.effective === '') scheduled = undefined
  }

  return {
    source: 'live',
    fetchedAt: Date.now(),
    sourceUrl: url,
    // current is defined here: the undefined case fell back to scheduled.peak.
    current: current as PriceTable,
    scheduled,
  }
}

/** Canonical (key-sorted) JSON of the priced content of a sheet. */
function canonicalSheet(sheet: PriceSheet): string {
  const norm = (table: PriceTable): unknown => Object.fromEntries(
    Object.entries(table)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([model, p]) => [model, [p.inputCacheHit, p.inputMiss, p.output]]),
  )
  return JSON.stringify({
    current: norm(sheet.current),
    scheduled: sheet.scheduled === undefined
      ? null
      : {
          effective: sheet.scheduled.effective,
          windows: sheet.scheduled.peakWindows,
          offPeak: norm(sheet.scheduled.offPeak),
          peak: norm(sheet.scheduled.peak),
        },
  })
}

/** One-line human summary of a sheet, for change logs. */
function summarizeSheet(sheet: PriceSheet): string {
  const parts = Object.entries(sheet.current)
    .map(([model, p]) => `${model} ¥${p.inputMiss}/¥${p.output}`)
  if (sheet.scheduled !== undefined) parts.push(`峰谷自 ${sheet.scheduled.effective} 生效`)
  return parts.join(', ')
}

/** Longest-prefix match of one model id against one table's keys. */
function matchByPrefix(table: PriceTable, model: string): ModelPrice | undefined {
  const id = model.trim().toLowerCase()
  let best: ModelPrice | undefined
  let bestLen = -1
  for (const key of Object.keys(table)) {
    if (id.startsWith(key) && key.length > bestLen) {
      best = table[key]
      bestLen = key.length
    }
  }
  return best
}

/** One vendor's resolved pricing block for reports and the dashboard. */
export interface VendorPricing {
  id: string
  label: string
  pricingUrl: string
  /** Catalog prices are lowest-tier snapshots of tiered official pricing. */
  tiered: boolean
  /** Where the numbers came from. */
  source: 'live' | 'builtin' | 'override'
  fetchedAt?: number
  models: PriceTable
}

/** Human-readable diff between two tables: new models and price changes. */
function diffTable(prev: PriceTable, next: PriceTable): string[] {
  const notes: string[] = []
  for (const [model, price] of Object.entries(next)) {
    const old = prev[model]
    if (old === undefined) {
      notes.push(`新增模型 ${model}（¥${price.inputMiss}/¥${price.output}）`)
    }
    else if (old.inputMiss !== price.inputMiss || old.output !== price.output || old.inputCacheHit !== price.inputCacheHit) {
      notes.push(`${model} 调价 ¥${old.inputMiss}/¥${old.output} → ¥${price.inputMiss}/¥${price.output}`)
    }
  }
  for (const model of Object.keys(prev)) {
    if (next[model] === undefined) notes.push(`移除模型 ${model}`)
  }
  return notes
}

/** Owns the live price sheet with refresh and fallback behavior. */
export class PriceService {
  private sheet: PriceSheet = BUILTIN_SHEET
  private changedAt: number | undefined
  private overrides: PriceTable = {}
  /** Per-vendor tables scraped live from official pages (new models land here). */
  private vendorLive = new Map<string, { table: PriceTable; fetchedAt: number }>()

  constructor(
    private pricingUrl: string,
    private readonly timeoutMs: number,
    private readonly log: MinimalLogger,
  ) {}

  /** Point the refresh at a different pricing page (live settings update). */
  setUrl(url: string): void {
    this.pricingUrl = url
  }

  /** Replace the user-supplied price overrides (live settings update). */
  setOverrides(overrides: PriceTable): void {
    this.overrides = overrides
  }

  /** The sheet currently in force. */
  get currentSheet(): PriceSheet {
    return this.sheet
  }

  /** When the official page last delivered different prices (undefined = never). */
  get lastChangedAt(): number | undefined {
    return this.changedAt
  }

  /**
   * Price for one model at one instant. Priority: user overrides > DeepSeek
   * live/builtin sheet > vendor live tables (auto-imported new models) >
   * built-in catalog exact > longest-prefix match (covers dated snapshots
   * such as `glm-4.6-250414`). Undefined keeps tokens unpriced.
   */
  resolve(model: string, atMs: number): ModelPrice | undefined {
    const id = model.trim().toLowerCase()
    const override = this.overrides[id] ?? matchByPrefix(this.overrides, id)
    if (override !== undefined) return override
    const deepseek = resolvePrice(this.sheet, id, atMs)
    if (deepseek !== undefined) return deepseek
    const vendor = vendorOf(id)
    if (vendor !== undefined) {
      const live = this.vendorLive.get(vendor)
      if (live !== undefined) {
        const hit = live.table[id] ?? matchByPrefix(live.table, id)
        if (hit !== undefined) return hit
      }
    }
    return CATALOG_TABLE[id] ?? matchByPrefix(CATALOG_TABLE, id)
  }

  /** All known pricing grouped by vendor, for the dashboard and reports. */
  vendorPricing(atMs: number): VendorPricing[] {
    const result: VendorPricing[] = []
    const seen = new Set<string>()
    // DeepSeek first: its numbers are live from the official page.
    const deepseekModels: PriceTable = { ...resolveTable(this.sheet, atMs) }
    for (const key of Object.keys(this.overrides)) {
      if (vendorOf(key) === 'deepseek') deepseekModels[key] = this.overrides[key]!
    }
    result.push({
      id: 'deepseek',
      label: VENDORS.deepseek!.label,
      pricingUrl: this.sheet.sourceUrl ?? VENDORS.deepseek!.pricingUrl,
      tiered: false,
      source: this.sheet.source === 'live' ? 'live' : 'builtin',
      fetchedAt: this.sheet.fetchedAt,
      models: deepseekModels,
    })
    seen.add('deepseek')
    // Other domestic vendors: live scraped table first, catalog as fallback.
    for (const [vendorId, info] of Object.entries(VENDORS)) {
      if (seen.has(vendorId)) continue
      seen.add(vendorId)
      const live = this.vendorLive.get(vendorId)
      const models: PriceTable = {}
      const base = live !== undefined ? live.table : CATALOG_TABLE
      for (const [key, price] of Object.entries(base)) {
        if (vendorOf(key) === vendorId) models[key] = price
      }
      let source: VendorPricing['source'] = live !== undefined ? 'live' : 'builtin'
      for (const [key, price] of Object.entries(this.overrides)) {
        if (vendorOf(key) === vendorId) {
          models[key] = price
          source = 'override'
        }
      }
      if (Object.keys(models).length > 0) {
        result.push({ id: vendorId, label: info.label, pricingUrl: info.pricingUrl, tiered: info.tiered ?? false, source, fetchedAt: live?.fetchedAt, models })
      }
    }
    // Overrides that belong to no known vendor (custom models).
    const rest: PriceTable = {}
    for (const [key, price] of Object.entries(this.overrides)) {
      if (vendorOf(key) === undefined) rest[key] = price
    }
    if (Object.keys(rest).length > 0) {
      result.push({ id: 'custom', label: '自定义模型', pricingUrl: '', tiered: false, source: 'override', models: rest })
    }
    return result
  }

  /**
   * Fetch and parse the official page; keep the last good sheet on failure.
   * Detects official price changes and logs them loudly, so a published price
   * update is picked up automatically on the next poll.
   */
  async refresh(): Promise<void> {
    try {
      const html = await fetchText(this.pricingUrl, this.timeoutMs)
      const next = parsePriceSheet(html, this.pricingUrl)
      if (canonicalSheet(next) !== canonicalSheet(this.sheet)) {
        this.sheet = next
        this.changedAt = next.fetchedAt ?? Date.now()
        this.log.info(`usage-ledger: 官方定价已更新，新价格生效: ${summarizeSheet(next)}`)
      }
      else {
        // Metadata (fetchedAt/source) still advances on an unchanged page.
        this.sheet = next
      }
    }
    catch (error) {
      this.log.warn(`usage-ledger: pricing refresh failed, keeping ${this.sheet.source} sheet: ${String(error)}`)
    }
  }

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
  async refreshVendor(vendorId: string): Promise<void> {
    const info = VENDORS[vendorId]
    if (info === undefined) return
    try {
      const table = await this.fetchVendorTable(vendorId)
      if (Object.keys(table).length === 0) {
        this.log.warn(`usage-ledger: ${info.label} 定价页未解析出价格表（可能是动态渲染页面），沿用现有价格`)
        return
      }
      const prev = this.vendorLive.get(vendorId)?.table ?? {}
      const notes = diffTable(prev, table)
      this.vendorLive.set(vendorId, { table, fetchedAt: Date.now() })
      if (notes.length > 0) {
        this.changedAt = Date.now()
        this.log.info(`usage-ledger: ${info.label} 官方定价已更新: ${notes.join('；')}`)
      }
    }
    catch (error) {
      this.log.warn(`usage-ledger: ${info.label} 定价抓取失败，沿用现有价格: ${String(error)}`)
    }
  }

  /**
   * Fetch and parse one vendor's pricing data according to its fetchKind.
   */
  private async fetchVendorTable(vendorId: string): Promise<PriceTable> {
    const info = VENDORS[vendorId]!
    const kind = info.fetchKind ?? 'html'
    if (kind === 'ernie-cdn') {
      const json = JSON.parse(await fetchText(info.dataSource ?? info.pricingUrl, this.timeoutMs, { 'user-agent': BROWSER_UA })) as {
        result?: { data?: { markdownRemark?: { html?: string } } }
      }
      return parseErnieSheet(json.result?.data?.markdownRemark?.html ?? '')
    }
    if (kind === 'kimi-rsc') {
      const base = info.dataSource ?? info.pricingUrl
      const rscHeaders = { 'user-agent': BROWSER_UA, RSC: '1' }
      // Subpages are listed on the index page as href:`/pricing/xxx`.
      const index = await fetchText(base + 'chat', this.timeoutMs, rscHeaders)
      const pages = [...new Set([...index.matchAll(/href:`(\/pricing\/[\w-]+)`/g)].map(m => m[1] ?? ''))]
        .filter(p => p !== '/pricing/chat')
      const table: PriceTable = {}
      for (const page of pages) {
        const payload = await fetchText('https://platform.kimi.com/docs' + page, this.timeoutMs, rscHeaders)
        Object.assign(table, parseKimiSheet(payload))
      }
      // The index page itself may carry a table too.
      Object.assign(table, parseKimiSheet(index))
      return table
    }
    if (kind === 'zhipu-bundle') {
      const table: PriceTable = {}
      // Current flagship models live inside the SPA's app.*.js bundle. The
      // bundle filename carries a deploy hash, so discover it from the shell.
      try {
        const shell = await fetchText(info.pricingUrl, this.timeoutMs, { 'user-agent': BROWSER_UA })
        const bundleUrl = shell.match(/src="(https:\/\/static\.bigmodel\.cn\/wd-paas-front\/js\/app\.[\w.]+\.js)"/)?.[1]
        if (bundleUrl !== undefined) {
          Object.assign(table, parseZhipuBundleSheet(await fetchText(bundleUrl, this.timeoutMs, { 'user-agent': BROWSER_UA })))
        }
      }
      catch (error) {
        this.log.warn(`usage-ledger: 智谱 JS 包价格解析失败，仅用运营位接口: ${String(error)}`)
      }
      // Legacy models (GLM-4 generation and earlier) come from the public
      // operation/query endpoint (dataSource); legacy never overrides bundle.
      const legacy = parseZhipuLegacySheet(await fetchText(info.dataSource ?? info.pricingUrl, this.timeoutMs, { 'user-agent': BROWSER_UA }))
      for (const [model, price] of Object.entries(legacy)) {
        if (table[model] === undefined) table[model] = price
      }
      return table
    }
    if (kind === 'doubao-md') {
      const json = JSON.parse(await fetchText(info.dataSource ?? info.pricingUrl, this.timeoutMs, { 'user-agent': BROWSER_UA })) as {
        Result?: { MDContent?: string }
      }
      return parseDoubaoSheet(json.Result?.MDContent ?? '')
    }
    const html = await fetchText(info.dataSource ?? info.pricingUrl, this.timeoutMs, { 'user-agent': BROWSER_UA })
    return parseVendorSheet(html, vendorId)
  }

  /** Refresh DeepSeek plus every other vendor's official pricing page. */
  async refreshAll(): Promise<void> {
    await this.refresh()
    for (const vendorId of Object.keys(VENDORS)) {
      if (vendorId === 'deepseek') continue
      await this.refreshVendor(vendorId)
    }
  }
}

/** The flat table in force at one instant under one sheet (schedule-aware). */
function resolveTable(sheet: PriceSheet, atMs: number): PriceTable {
  if (sheet.scheduled !== undefined && beijingDate(atMs) >= sheet.scheduled.effective) {
    return isPeakTime(atMs, sheet.scheduled.peakWindows ?? DEFAULT_PEAK_WINDOWS)
      ? sheet.scheduled.peak
      : sheet.scheduled.offPeak
  }
  return sheet.current
}
