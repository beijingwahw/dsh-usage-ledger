# dsh-usage-ledger(Token费用统计)

[![dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-blue)](https://github.com/topics/dsh-plugin)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

**中文** | [English](#english)

DeepSeek Harness 的 Token / 用量统计与成本控制插件：按对话聚合消耗、动态跟随官方定价、支持预算拦截，并内置 Web 仪表盘。

## 功能特性

- **按会话统计**：监听 `session/event`，把每次 `assistant/message` 的 `usage`（输入 / 输出 / 缓存读写 Token）折算为费用，按会话、按北京日、按生命周期三个维度聚合，并持久化到账本文件。
- **动态官方定价**：定期抓取官方定价页，自动解析并热更新价格，官方调价 / 上新模型时无需改代码即可生效。
- **DeepSeek 峰谷分时**：识别官方「高峰 / 空闲」时段表与生效日期，按调用发生的北京时间实时取价。
- **多厂商价格目录**：覆盖 DeepSeek、智谱 GLM、月之暗面 Kimi、阿里通义、字节豆包、MiniMax、百度文心等主流国产模型，新模型上线官方定价页后自动导入。
- **预算控制**：支持日 / 总 / 单会话三级预算，达到阈值进入告警，超限可通过 `llm/stream` 钩子直接拦截模型调用。
- **Web 仪表盘**：通过 `dsh-host-webserver` 注册 `/usage-ledger` 路由，提供用量可视化与 JSON API。
- **用户覆盖价**：`customPrices` 设置可为任意模型（含自定义模型）覆盖或补充价格，优先级最高。

## 安装

将本仓库放入 DeepSeek Harness 的插件目录（或通过包管理器安装），Harness 会依据 `dsh.plugin.json` 与 `cordis.patch.yml` 自动加载。

```bash
git clone https://github.com/beijingwahw/dsh-usage-ledger.git
cd dsh-usage-ledger
pnpm install
pnpm run build
```

## 配置

在 Harness 的 `cordis.yml` 中挂载并配置：

```yaml
- name: dsh-usage-ledger
  config:
    ledgerPath: ''            # 留空则使用 $DSH_HOME/usage-ledger.json
    saveIntervalMs: 5000      # 账本落盘防抖
    pricingTimeoutMs: 10000   # 单次定价抓取超时
```

`usage-ledger` 命名空间的用户设置（可在运行时热更新）：

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| `dailyBudget` | `0` | 日预算（元），0 关闭 |
| `totalBudget` | `0` | 总预算（元），0 关闭 |
| `sessionBudget` | `0` | 单会话预算（元），0 关闭 |
| `warnRatio` | `0.8` | 进入告警的预算占比 |
| `enforceBudget` | `true` | 超预算时拦截模型调用 |
| `pricingUrl` | DeepSeek 官方页 | 定价刷新来源 |
| `refreshIntervalMin` | `60` | 定价刷新间隔（分钟） |
| `customPrices` | `{}` | 按模型 id 覆盖价格（最长前缀匹配） |

`customPrices` 示例：

```json
{
  "glm-4.6": { "inputCacheHit": 1, "inputMiss": 5, "output": 5 }
}
```

价格单位为 **元 / 百万 tokens**。

## 价格解析优先级

`用户覆盖 > DeepSeek 实时表 > 各厂商实时抓取表 > 内置目录精确匹配 > 最长前缀匹配`

各厂商抓取方式（`fetchKind`）：

| 厂商 | 通道 |
| --- | --- |
| DeepSeek | 官方定价页 HTML（含峰谷表） |
| 智谱 GLM | SPA `app.*.js` 内嵌价格 + 公开运营位接口 |
| Kimi | Next.js RSC flight payload 子页 |
| 通义千问 | 官方定价页表格 |
| 豆包 | 火山文档中心服务端 Markdown |
| MiniMax | 官方定价页表格 |
| 文心 | 百度 CDN Gatsby page-data |

抓取失败时沿用上一次成功的价格，网络异常不影响记账。

## 提供的工具

- `usage_report`：输出当前用量 / 费用 / 预算状态报表。

## HTTP 接口

- `GET /usage-ledger`：仪表盘页面。
- `GET /usage-ledger/api/...`：用量与定价 JSON API。

## 开发

```bash
pnpm run build        # 编译到 lib/
pnpm run typecheck    # 仅类型检查
```

目录结构：

```
src/
  index.ts      # 插件入口：事件折叠、预算门、工具与路由注册
  ledger.ts     # 用量聚合、持久化、预算评估
  pricing.ts    # 定价抓取、解析、变更检测
  catalog.ts    # 厂商元信息与内置价格目录
  scrapers.ts   # 通用 / 专用定价页解析器
  types.ts      # 共享类型
```

## 参与贡献

欢迎提交 Issue 与 Pull Request。请保持改动聚焦，提交前运行 `pnpm run typecheck`。

## 许可

[MIT](./LICENSE)

---

<a id="english"></a>

# dsh-usage-ledger

**[中文](#dsh-usage-ledger)** | English

A token usage & cost ledger plugin for [DeepSeek Harness](https://github.com/topics/dsh-plugin): per-session cost aggregation, dynamic official pricing, budget gating, and a built-in web dashboard.

## Features

- **Per-session accounting**: listens to `session/event`, prices every `assistant/message` `usage` record (input / output / cache read & write tokens), and aggregates it per session, per Beijing-time day, and per lifetime, persisting everything to a ledger file.
- **Dynamic official pricing**: periodically scrapes official pricing pages, parses and hot-reloads prices — official price changes and newly published models take effect without any code change.
- **DeepSeek peak/off-peak**: understands the official peak/off-peak schedule and its effective date, resolving the price in force at the exact Beijing time of each call.
- **Multi-vendor catalog**: covers DeepSeek, Zhipu GLM, Moonshot Kimi, Alibaba Qwen, ByteDance Doubao, MiniMax and Baidu ERNIE; new models are imported automatically once they appear on an official pricing page.
- **Budget control**: daily / total / per-session budgets with a warning threshold, optionally blocking model calls through the `llm/stream` gate when exceeded.
- **Web dashboard**: registers the `/usage-ledger` route via `dsh-host-webserver`, with usage visualization and a JSON API.
- **User price overrides**: the `customPrices` setting can override or add prices for any model (including custom ones) and takes top priority.

## Installation

Drop this repository into the DeepSeek Harness plugin directory (or install it via a package manager). Harness loads it automatically through `dsh.plugin.json` and `cordis.patch.yml`.

```bash
git clone https://github.com/beijingwahw/dsh-usage-ledger.git
cd dsh-usage-ledger
pnpm install
pnpm run build
```

## Configuration

Mount and configure it in Harness's `cordis.yml`:

```yaml
- name: dsh-usage-ledger
  config:
    ledgerPath: ''            # empty = $DSH_HOME/usage-ledger.json
    saveIntervalMs: 5000      # ledger persistence debounce
    pricingTimeoutMs: 10000   # wall-clock budget for one pricing fetch
```

User settings in the `usage-ledger` namespace (hot-reloadable at runtime):

| Setting | Default | Description |
| --- | --- | --- |
| `dailyBudget` | `0` | Daily cost budget (CNY); 0 disables |
| `totalBudget` | `0` | Lifetime cost budget (CNY); 0 disables |
| `sessionBudget` | `0` | Per-session cost budget (CNY); 0 disables |
| `warnRatio` | `0.8` | Ratio at which budgets enter the warning state |
| `enforceBudget` | `true` | Block model calls once any budget is exceeded |
| `pricingUrl` | DeepSeek official page | Pricing refresh source |
| `refreshIntervalMin` | `60` | Pricing refresh interval (minutes) |
| `customPrices` | `{}` | Price overrides by model id (longest-prefix match) |

`customPrices` example:

```json
{
  "glm-4.6": { "inputCacheHit": 1, "inputMiss": 5, "output": 5 }
}
```

All prices are **CNY per 1M tokens**.

## Price Resolution Priority

`user overrides > DeepSeek live sheet > vendor live tables > built-in catalog exact match > longest-prefix match`

Per-vendor fetch channels (`fetchKind`):

| Vendor | Channel |
| --- | --- |
| DeepSeek | Official pricing page HTML (incl. peak/off-peak table) |
| Zhipu GLM | Prices embedded in the SPA `app.*.js` bundle + public operation API |
| Kimi | Next.js RSC flight payload subpages |
| Qwen | Official pricing page tables |
| Doubao | Volcano doc-center server-side Markdown |
| MiniMax | Official pricing page tables |
| ERNIE | Baidu CDN Gatsby page-data |

On fetch failure the last good prices are kept, so network issues never break accounting.

## Provided Tool

- `usage_report`: reports current usage / cost / budget status.

## HTTP Endpoints

- `GET /usage-ledger`: dashboard page.
- `GET /usage-ledger/api/...`: usage and pricing JSON API.

## Development

```bash
pnpm run build        # compile to lib/
pnpm run typecheck    # type check only
```

Layout:

```
src/
  index.ts      # plugin entry: event folding, budget gate, tool & route registration
  ledger.ts     # usage aggregation, persistence, budget evaluation
  pricing.ts    # pricing fetch, parsing, change detection
  catalog.ts    # vendor metadata and built-in price catalog
  scrapers.ts   # generic / vendor-specific pricing page parsers
  types.ts      # shared types
```

## Contributing

Issues and pull requests are welcome. Please keep changes focused and run `pnpm run typecheck` before submitting.

## License

[MIT](./LICENSE)
