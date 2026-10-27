# AGENTS.md — AI Agent 使用指南

wb-desktop 在本机维护多个 WorkBuddy/CodeBuddy 账号（登录态、Token 保活、自动签到、猫猫旅行），并把账号积分以 OpenAI/Anthropic 兼容网关的形式暴露给 AI 客户端。本文档供 AI Agent（Claude Code、ZCode 等）阅读后直接驱动本工具。

## 两条接入路径

| 路径 | 地址 | 鉴权 | 用途 |
|---|---|---|---|
| 控制面（任务运维） | `http://127.0.0.1:3081/api/*` | 无（仅本机回环） | 签到/旅行/积分/账号/网关配置 |
| 数据面（模型推理） | `http://127.0.0.1:3081/v1/*` | 虚拟 Key | 把 WorkBuddy 积分当模型端点用 |

端口默认 3081（`WB_PORT` 可改）。局域网数据面默认 `:9527`（仅转发 `/v1/*`，`WB_LAN_PORT=0` 关闭）。控制面**无鉴权且仅绑定 127.0.0.1**——只在可信本机使用，不要试图从远程访问。

**后台自动化已内置**：签到每分钟检查时间窗、旅行每 30/15 分钟派发/领取、Token 保活每 6 小时——账号配置好后这些任务自动运行，Agent 通常只需按需触发、查询与汇报。

## 控制面 API

全部返回 JSON。通用约定：写操作用 POST + JSON body；账号 `id` 来自 `GET /api/accounts`。

### 状态与账号

| 端点 | 方法 | 说明 / 返回要点 |
|---|---|---|
| `/api/status` | GET | 运行状态：`localPort`、`lan`、`gateway.activeAccountName`、`uptimeSec` |
| `/api/accounts` | GET | `{accounts:[{id,email,nickname,variant,...}]}`（已脱敏无 token） |
| `/api/credits` | GET | 实时逐账号查积分：`{results:[{accountName,totalRemaining,expiringSoon,expired,resources}]}`；接口较慢（逐个请求官方） |
| `/api/refresh/:id` | POST | 手动刷新单个账号 token → `{ok}` |
| `/api/switch` | POST | `{id, restart}`：写入官方客户端登录态并重启其进程（影响官方 App 登录，**不是**网关服务账号） |
| `/api/accounts/import-local` | POST | `{variant:'cn'\|'ai'}`：导入本机官方客户端当前登录态 |
| `DELETE /api/accounts/:id` | DELETE | 删除账号 |

### 签到

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/checkin/run` | POST | 立即签到一轮（强制全量，不受时间窗/去重限制）→ `{status:'ok', accounts:[{email, result:'success'\|'already'\|'error', ...}], _hadErrors}` |
| `/api/checkin/config` | GET/POST | 时间窗与自动执行配置 |
| `/api/checkin/logs` | GET | `{logs:[{ts,email,result}]}` |

### 猫猫旅行

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/travel/status` | GET | 状态页数据；`?refresh=1` 强制向官方刷新 |
| `/api/travel/run` | POST | 手动派发一轮 |
| `/api/travel/claim` | POST | 手动领取一轮 |
| `/api/travel/config` | POST | `{enabled:boolean}` |

### 网关

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/gateway/config` | GET | 虚拟 Key（`virtualKey`）、模型清单、生效改写表、`usage`（最近台账）、`summary`（按模型汇总）、可用账号列表 |
| `/api/gateway/config` | POST | 局部更新：`activeAccountId`（网关服务账号）、`models`、`thinking:'default'\|'disabled'`、`signatureRewrites`（传生效表全量，内置基线自动剔除）、`rulesUrl`（远程规则源，默认关闭） |
| `/api/gateway/models/sync` | POST | 免费同步官方模型目录（`/v3/config` ∪ 企业端点，含倍率/上下文/图片/工具元数据）；后台每日自动同步，真实调用成功的模型也会自动并入 |
| `/api/gateway/models/refresh` | POST | 逐个探测清单内模型可用性（约 0.01 积分/个）；仅上游确认不存在才移除 |
| `/api/gateway/key/rotate` | POST | 重置虚拟 Key |
| `/api/gateway/rules/refresh` | POST | 立即拉取远程规则（未配置 `rulesUrl` 时返回提示） |

### 日志

`GET /api/logs` → `{logs:[{ts,level,message,...}]}`（最近 200 条，后台任务/请求处理事件流）。

## 典型任务手册

```text
「查各账号积分」        GET /api/credits → 按账号报 totalRemaining 与 expiringSoon
「跑一次签到」          POST /api/checkin/run → 逐账号报 result；error 的给出原因
「旅行怎么样了」        GET /api/travel/status → 汇报在途/可领取
「切换网关用账号 X」     GET /api/accounts 找 id → POST /api/gateway/config {"activeAccountId": id}
「模型调用失败了」       GET /api/logs + GET /api/gateway/config（看 usage 里最新 error）
「虚拟 Key 是什么」      GET /api/gateway/config → virtualKey（对用户展示时注意脱敏）
```

注意区分两种"切账号"：`POST /api/gateway/config {"activeAccountId"}` 只影响网关用哪个账号扣积分；`POST /api/switch {"id"}` 会改写官方客户端登录态并重启 App——除非用户明确要求，不要动后者。

账号凭据为**加密信封态**（`envelope`）时无法签到/查积分/调用模型，接口会明确报错，此时需要用户在 UI 里扫码重新添加（人工环节，无 API 替代）。

## 数据面：把 wb-desktop 当模型端点

- `baseURL = http://127.0.0.1:3081/v1`，鉴权用虚拟 Key（`Authorization: Bearer <key>` / `x-api-key` / `?key=`），Key 在 UI「网关代理」页或 `GET /api/gateway/config` 查看。
- 模型 id：wb 积分模型用小写短名（`glm-5.3-flash`、`hy3`、`kimi-k3-1`…）；配置了 Zai Coding Key 后 `zai/` 前缀模型走智谱套餐计费（不计 wb 积分）
- 端点：`POST /v1/chat/completions`（OpenAI 格式，流式透传）、`POST /v1/messages`（Anthropic 格式，**真流式** SSE）、`POST /v1/messages/count_tokens`（本地估算）、`GET /v1/models`。
- 支持流式、tools 双向映射、图片（Anthropic image → 上游，模型不支持时会明确回复/报错）、标准错误语义（`error.type` + `Retry-After`）、思考模式全局开关（`thinking:'disabled'` 时网关侧抑制思考内容下发）。
- 计费与官方 App 一致（服务端按积分扣）；客户端断开会中止上游（中断不扣费，台账记 `client_aborted`）。
- 客户端接入示例：Claude Code 设 `ANTHROPIC_BASE_URL=http://127.0.0.1:3081/v1`、`ANTHROPIC_API_KEY=<虚拟Key>`；ZCode 等同理配 OpenAI 兼容端点。

## MCP Server

```bash
# Claude Code
claude mcp add wb-desktop -- node <安装目录>/dist/mcp.cjs
# ZCode：MCP 服务器 command=node，args=[<安装目录>/dist/mcp.cjs]
```

工具（12 个）：`wb_status` `wb_accounts` `wb_credits` `wb_checkin_run` `wb_checkin_logs` `wb_travel_status` `wb_travel_run` `wb_travel_claim` `wb_switch_account` `wb_refresh_account` `wb_gateway_usage` `wb_logs`。目标端口跟随 `WB_PORT`（默认 3081）。

## 无头运行

`node dist/headless.cjs`（或 `pnpm serve:headless`）：纯 Node 跑完整后台（server + 全部定时循环），无 Electron/GUI，适合服务器/Docker。数据与 exe 完全共用 `~/.wb-hub/`。

## 安全边界（Agent 必读）

- 控制面无鉴权：本工具的所有 `/api/*` 都能操作账号与扣积分的配置，**仅限本机可信环境**调用；不要把 3081 端口转发/暴露出去。
- 虚拟 Key 等同积分扣费权限：不要写入代码仓库、日志或对外输出；泄露后用 `/api/gateway/key/rotate` 重置。
- 账号 token 以明文存于 `~/.wb-hub/accounts.json`（详见 SECURITY.md），不要读取/回显该文件内容。
