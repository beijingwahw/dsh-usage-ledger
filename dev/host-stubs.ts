/**
 * 开发期宿主服务桩（仅 `npm run dev` 的独立 cordis 进程使用，不参与构建产物）。
 *
 * 本插件 inject = ['sessions', 'tools', 'systemPrompt', 'settings']，另有可选注入
 * ctx.inject(['webServer']) 的 HTTP dashboard 分支。独立 cordis 进程没有 dsh 宿主，
 * 缺桩时 fiber 永远 PENDING。各桩按源码实际消费的最小面给出：
 * - sessions.list() → 空会话列表（启动期折叠存量日志时用到）
 * - tools.register(def) → 函数型 disposer（usage_report 工具注册）
 * - systemPrompt.section({name,order,text}) → 函数型 disposer（预算警告注入）
 * - settings.register(ns, schema, opts) → 作用域（get 返回 schema 默认值，watch 为空）
 * - webServer.register({kind,path,handler}) → 函数型 disposer（借鉴 dsh-companion
 *   宿主桩：提供后 dashboard 分支开发期即挂载，其代码同样纳入 HMR 热重载验证）
 */
import type { Context } from '@deepseek-ai/cordis'

export const name = 'dev-host-stubs'

export function apply(ctx: Context): void {
  ctx.provide('sessions', {
    list: () => [],
  })

  ctx.provide('tools', {
    register: (_def: unknown) => () => {},
  })

  ctx.provide('systemPrompt', {
    section: (_def: unknown) => () => {},
  })

  ctx.provide('webServer', {
    register: (_def: unknown) => () => {},
  })

  ctx.provide('settings', {
    register(_ns: string, schema: ((value: unknown) => unknown) & { meta?: { default?: unknown } } | undefined) {
      // schemastery 对象的 meta.default 是 {}（字段默认值在各自字段 schema 上），
      // 直接读 meta.default 会得到空对象 → refreshIntervalMin 变 undefined → NaN。
      // 调用 schema({}) 让 schemastery 自行展开全部字段默认值。
      let resolved = {}
      if (typeof schema === 'function') {
        try {
          resolved = (schema({}) ?? {}) as Record<string, unknown>
        } catch {
          resolved = {}
        }
      } else if (schema?.meta?.default && typeof schema.meta.default === 'object') {
        resolved = schema.meta.default as Record<string, unknown>
      }
      const base = resolved
      let value = { ...base }
      return {
        get: () => value,
        update: async (patch: Record<string, unknown>) => {
          value = { ...value, ...patch }
        },
        replace: async (section: Record<string, unknown>) => {
          value = { ...base, ...section }
        },
        watch: (_cb: (next: unknown, prev: unknown) => void) => () => {},
      }
    },
  })
}
