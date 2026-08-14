/**
 * The usage ledger: per-session token/cost aggregation, daily (Beijing) and
 * total buckets, durable JSON persistence, and budget evaluation.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { beijingDate, usageTotalTokens } from './types.js'
import type { BudgetState, BudgetStatus, LedgerFile, SessionUsage, UsageCounters } from './types.js'
import type { ModelPrice } from './types.js'

/** Minimal logger shape (structurally compatible with the cordis logger). */
export interface LedgerLogger {
  warn(...args: unknown[]): void
  info(...args: unknown[]): void
}

/** Budget configuration the ledger evaluates against. */
export interface BudgetConfig {
  /** Daily cost budget (CNY); 0 disables. */
  dailyBudget: number
  /** Total cost budget (CNY); 0 disables. */
  totalBudget: number
  /** Per-session cost budget (CNY); 0 disables. */
  sessionBudget: number
  /** Ratio (0-1) at which a budget enters the warning state. */
  warnRatio: number
}
/** One recorded model call. */
export interface UsageSample {
  time: number
  usage: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
    reasoningTokens?: number
  }
  model?: string
  provider?: string
  cost: number
}

function emptyCounters(): UsageCounters {
  return {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    cost: 0,
  }
}

function emptyFile(): LedgerFile {
  return { version: 1, sessions: {}, daily: {}, total: { calls: 0, tokens: 0, cost: 0 } }
}

function addCounters(target: UsageCounters, sample: UsageSample): void {
  target.calls += 1
  target.inputTokens += sample.usage.inputTokens
  target.outputTokens += sample.usage.outputTokens
  target.cacheReadTokens += sample.usage.cacheReadTokens ?? 0
  target.cacheWriteTokens += sample.usage.cacheWriteTokens ?? 0
  target.reasoningTokens += sample.usage.reasoningTokens ?? 0
  target.cost += sample.cost
}

/** Resolve the ledger file path: configured path, else `$DSH_HOME`/`~/.dsh`. */
export function resolveLedgerPath(configured: string): string {
  const trimmed = configured.trim()
  if (trimmed !== '') return trimmed
  const envHome = process.env.DSH_HOME?.trim()
  const home = envHome !== undefined && envHome !== '' ? envHome : join(homedir(), '.dsh')
  return join(home, 'usage-ledger.json')
}

/**
 * Durable per-session usage ledger. All mutation goes through `record()` and
 * `setTitle()`; persistence is debounced and flushed on `dispose()`.
 */
export class UsageLedger {
  private file: LedgerFile = emptyFile()
  private dirty = false
  private saveTimer: NodeJS.Timeout | undefined
  private disposed = false

  constructor(
    readonly path: string,
    private budgets: BudgetConfig,
    private readonly log: LedgerLogger,
    private readonly saveIntervalMs: number,
  ) {
    this.load()
  }

  /** Replace the budget configuration (live settings update). */
  setBudgets(budgets: BudgetConfig): void {
    this.budgets = budgets
  }

  /** Load the durable file; a corrupt file is archived aside, never fatal. */
  private load(): void {
    if (!existsSync(this.path)) return
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<LedgerFile>
      if (parsed.version !== 1 || typeof parsed !== 'object' || parsed === null) {
        throw new Error('unsupported ledger version')
      }
      this.file = {
        version: 1,
        sessions: parsed.sessions ?? {},
        daily: parsed.daily ?? {},
        total: parsed.total ?? { calls: 0, tokens: 0, cost: 0 },
      }
    }
    catch (error) {
      const backup = `${this.path}.corrupt-${Date.now()}`
      this.log.warn(`usage-ledger: cannot read ${this.path} (${String(error)}); starting fresh, old file kept at ${backup}`)
      try {
        renameSync(this.path, backup)
      }
      catch {
        // The fresh ledger is the recovery path; the rename is best-effort.
      }
      this.file = emptyFile()
    }
  }

  /** The last folded session-log seq, for resume double-count protection. */
  lastSeq(sessionId: string): number {
    return this.file.sessions[sessionId]?.lastSeq ?? -1
  }

  /** Session display title, when one was logged. */
  title(sessionId: string): string | undefined {
    return this.file.sessions[sessionId]?.title
  }

  /** Remember the session title (latest-wins). */
  setTitle(sessionId: string, title: string, time: number): void {
    const row = this.sessionRow(sessionId, time)
    if (row.title !== title) {
      row.title = title
      this.markDirty()
    }
  }

  /** Record one priced model call into session, daily, and total buckets. */
  record(sessionId: string, sample: UsageSample): void {
    const row = this.sessionRow(sessionId, sample.time)
    addCounters(row, sample)
    if (sample.model !== undefined) row.model = sample.model
    if (sample.provider !== undefined) row.provider = sample.provider
    row.updatedAt = sample.time

    const day = beijingDate(sample.time)
    const daily = this.file.daily[day] ?? { calls: 0, tokens: 0, cost: 0 }
    daily.calls += 1
    daily.tokens += usageTotalTokens(sample.usage)
    daily.cost += sample.cost
    this.file.daily[day] = daily

    this.file.total.calls += 1
    this.file.total.tokens += usageTotalTokens(sample.usage)
    this.file.total.cost += sample.cost
    this.markDirty()
  }

  /** Advance the folded-seq watermark after events were consumed. */
  advanceSeq(sessionId: string, seq: number): void {
    const row = this.file.sessions[sessionId]
    if (row !== undefined && seq > row.lastSeq) {
      row.lastSeq = seq
      this.markDirty()
    }
  }

  private sessionRow(sessionId: string, time: number): SessionUsage {
    let row = this.file.sessions[sessionId]
    if (row === undefined) {
      row = { ...emptyCounters(), title: '', createdAt: time, updatedAt: time, lastSeq: -1 }
      this.file.sessions[sessionId] = row
      this.markDirty()
    }
    return row
  }

  /** One session's aggregate, when recorded. */
  session(sessionId: string): SessionUsage | undefined {
    return this.file.sessions[sessionId]
  }

  /** All session rows, newest activity first. */
  sessions(): Array<[string, SessionUsage]> {
    return Object.entries(this.file.sessions).sort((a, b) => b[1].updatedAt - a[1].updatedAt)
  }

  /** One day's bucket (Beijing date). */
  daily(day: string): { calls: number; tokens: number; cost: number } {
    return this.file.daily[day] ?? { calls: 0, tokens: 0, cost: 0 }
  }

  /** Lifetime totals. */
  total(): { calls: number; tokens: number; cost: number } {
    return this.file.total
  }

  private budgetState(cost: number, budget: number): BudgetState {
    const ratio = budget > 0 ? cost / budget : 0
    return {
      cost,
      budget,
      ratio,
      warn: budget > 0 && ratio >= this.budgets.warnRatio && cost < budget,
      exceeded: budget > 0 && cost >= budget,
    }
  }

  /** Evaluate daily, total, and (optionally) session budgets. */
  budgetStatus(atMs: number, sessionId?: string): BudgetStatus {
    const day = beijingDate(atMs)
    const status: BudgetStatus = {
      day,
      daily: this.budgetState(this.daily(day).cost, this.budgets.dailyBudget),
      total: this.budgetState(this.file.total.cost, this.budgets.totalBudget),
    }
    if (sessionId !== undefined && this.budgets.sessionBudget > 0) {
      status.session = this.budgetState(this.session(sessionId)?.cost ?? 0, this.budgets.sessionBudget)
    }
    return status
  }

  /** Whether any configured budget is already exceeded. */
  isExceeded(atMs: number, sessionId?: string): boolean {
    const status = this.budgetStatus(atMs, sessionId)
    return status.daily.exceeded || status.total.exceeded || (status.session?.exceeded ?? false)
  }

  /** Whether any configured budget reached the warning threshold. */
  isWarn(atMs: number, sessionId?: string): boolean {
    const status = this.budgetStatus(atMs, sessionId)
    return status.daily.warn || status.total.warn || (status.session?.warn ?? false)
  }

  /** Whether at least one budget is configured. */
  get hasBudget(): boolean {
    return this.budgets.dailyBudget > 0 || this.budgets.totalBudget > 0 || this.budgets.sessionBudget > 0
  }

  /** The resolved price table description for reports. */
  private markDirty(): void {
    this.dirty = true
    if (this.saveTimer === undefined && !this.disposed) {
      this.saveTimer = setTimeout(() => {
        this.saveTimer = undefined
        this.flush()
      }, this.saveIntervalMs)
      this.saveTimer.unref?.()
    }
  }

  /** Write the ledger to disk (atomic rename). */
  flush(): void {
    if (!this.dirty) return
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.tmp`
      writeFileSync(tmp, JSON.stringify(this.file, null, 2), 'utf8')
      renameSync(tmp, this.path)
      this.dirty = false
    }
    catch (error) {
      this.log.warn(`usage-ledger: persist failed: ${String(error)}`)
    }
  }

  /** Stop timers and persist the final state. */
  dispose(): void {
    this.disposed = true
    if (this.saveTimer !== undefined) {
      clearTimeout(this.saveTimer)
      this.saveTimer = undefined
    }
    this.flush()
  }
}

/** Format one CNY amount with sensible precision. */
export function formatCny(value: number): string {
  if (value === 0) return '¥0'
  if (value < 0.01) return `¥${value.toFixed(4)}`
  if (value < 1) return `¥${value.toFixed(3)}`
  return `¥${value.toFixed(2)}`
}

/** Format one token count with thousands separators. */
export function formatTokens(value: number): string {
  return value.toLocaleString('en-US')
}

/** Describe one price row for reports. */
export function formatPrice(price: ModelPrice): string {
  return `输入(缓存命中) ${price.inputCacheHit}元/M, 输入(未命中) ${price.inputMiss}元/M, 输出 ${price.output}元/M`
}
