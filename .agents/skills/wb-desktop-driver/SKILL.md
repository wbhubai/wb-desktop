---
name: wb-desktop-driver
description: 驱动本机 wb-desktop（WorkBuddy 账号助手）：查积分/签到/猫猫旅行/成长任务/账号管理/网关配置，以及把网关当 OpenAI·Anthropic 兼容模型端点使用。当用户提到 WorkBuddy/CodeBuddy 账号、积分、签到、猫猫旅行、成长任务、切换网关账号、虚拟 Key、或需要用本机 3081 端口跑模型推理时使用本 skill。
---

# wb-desktop 驱动指南

wb-desktop 在本机维护多个 WorkBuddy/CodeBuddy 账号（登录态、Token 保活、自动签到、猫猫旅行、成长任务），并把账号积分以 OpenAI/Anthropic 兼容网关的形式暴露给 AI 客户端。本 skill 让 Agent 直接驱动它。

## 两条接入路径

| 路径 | 地址 | 鉴权 | 用途 |
|---|---|---|---|
| 控制面（任务运维） | `http://127.0.0.1:3081/api/*` | 无（仅本机回环） | 签到/旅行/积分/账号/网关配置 |
| 数据面（模型推理） | `http://127.0.0.1:3081/v1/*` | 虚拟 Key | 把 WorkBuddy 积分当模型端点用 |

端口默认 3081（`WB_PORT` 可改）。局域网数据面默认 `:9527`（仅转发 `/v1/*`，`WB_LAN_PORT=0` 关闭）。

**后台自动化已内置**：签到每分钟检查时间窗、旅行每 30/15 分钟派发/领取、成长任务每小时巡检、Token 保活每 6 小时——账号配置好后自动运行，Agent 通常只需按需触发、查询与汇报。

## 第一步：确认服务在跑

```bash
curl -s http://127.0.0.1:3081/api/status
```

返回 `localPort`、`gateway.activeAccountName`、`uptimeSec`。连接失败 = 用户没启动程序（Windows 上双击 wb-desktop-portable.exe 或托盘「打开主界面」确认进程在）——不要反复重试，告诉用户启动即可。

## 控制面常用任务

全部返回 JSON；写操作用 POST + JSON body；账号 `id` 来自 `GET /api/accounts`。

| 用户意图 | 调用 |
|---|---|
| 查各账号积分 | `GET /api/credits` → 按账号报 `totalRemaining` 与 `expiringSoon`（慢，逐个请求官方，勿并发轮询） |
| 跑一次签到 | `POST /api/checkin/run` → 逐账号报 `result`（success/already/error），error 给原因 |
| 成长任务（上报/连登兑换/抽奖） | `POST /api/growth/run` → 每账号 `reported`/`streakDays`/`redeemed`/`draws` |
| 旅行怎么样了 | `GET /api/travel/status` → 汇报在途/可领取；`?refresh=1` 强制向官方刷新 |
| 手动派猫/领取 | `POST /api/travel/run`、`POST /api/travel/claim` |
| 切换网关用哪个账号扣积分 | `GET /api/accounts` 找 id → `POST /api/gateway/config {"activeAccountId": id}` |
| 模型调用失败了 | `GET /api/logs` + `GET /api/gateway/config`（看 usage 最新 error） |
| 同步官方模型目录（免费） | `POST /api/gateway/models/sync`（`/v3/config` ∪ 企业端点，含倍率/上下文元数据） |

**两种"切账号"必须区分**：`POST /api/gateway/config {"activeAccountId"}` 只影响网关扣积分的账号；`POST /api/switch {"id"}` 会改写官方客户端登录态并重启其进程——除非用户明确要求，**不要动后者**。

账号凭据为加密信封态（envelope）时接口会明确报错，只能让用户在 UI 里扫码重新添加（无 API 替代）。

## 数据面：把网关当模型端点

- `baseURL = http://127.0.0.1:3081/v1`，鉴权用虚拟 Key（`Authorization: Bearer <key>` / `x-api-key` / `?key=`），Key 从 `GET /api/gateway/config` 的 `virtualKey` 读（**对用户展示时脱敏，只显示前后几位**；泄露后 `POST /api/gateway/key/rotate` 重置）。
- 端点：`POST /v1/chat/completions`（OpenAI）、`POST /v1/messages`（Anthropic，真流式 SSE）、`POST /v1/messages/count_tokens`（本地估算，零积分）、`GET /v1/models`（带 context_window/multiplier 元数据）。
- 模型 id 用小写短名：`glm-5.3-flash`、`hy3`、`kimi-k3-1`、`deepseek-v4-pro` 等。清单外模型也可能真实可用——上游没有可查询目录，清单是官方目录+台账学习+手动维护的合并视图，以调用结果为准。

### 协议要点（踩过的坑）

- **客户端断开即中断上游且不扣费**（台账记 `client_aborted`）——用户按 Esc 中断回合是安全操作，不必担心积分损失。
- **错误语义按 `error.type` 判重试策略**：`rate_limit_error`（429，看 Retry-After）→ 等一会重试；`authentication_error` → 让用户检查账号/刷新 token；`not_found_error` → 模型不存在，换模型别重试；`overloaded_error` → 稍后重试。
- **Anthropic 协议支持**：tools、tool_choice（none/auto/any/tool）、图片（base64 image 块）、count_tokens、stop_sequences；thinking 由网关全局开关控制，客户端不必传思考参数。
- **不要发裸数字 `11-128`**（风控错误码）——网关会改写，但自己别主动带。

## 计费与额度

计费与官方 App 一致（服务端按积分扣）。`GET /api/gateway/config` 的 `usage`/`summary` 是按模型/账号的台账；`GET /api/credits` 是官方口径的实时余额。余额不足时调用返回 402/余额类错误——先查积分再汇报用户。

## 何时用 MCP 而非 curl

用户环境配了 MCP server（`claude mcp add wb-desktop -- node <安装目录>/dist/mcp.cjs`）时优先用原生工具：`wb_status` `wb_accounts` `wb_credits` `wb_checkin_run` `wb_checkin_logs` `wb_travel_status` `wb_travel_run` `wb_travel_claim` `wb_switch_account` `wb_refresh_account` `wb_gateway_usage` `wb_logs`。未配置 MCP 时按本文件 curl。

## 安全边界

- 控制面无鉴权，仅限本机可信环境；不要把 3081 端口转发/暴露出去。
- 虚拟 Key 等同积分扣费权限：不要写入代码仓库、日志或对外输出。
- 账号 token 明文存于 `~/.wb-hub/accounts.json`——**不要读取/回显该文件内容**。
- 签到/旅行/成长任务是自动化操作，触碰平台风控，使用风险由用户承担；仅限用户自己的账号。

## 脚本

`scripts/wb.sh`——封装常用 curl（status/credits/checkin/growth/travel/accounts），输出原样 JSON。不想记 URL 时直接 `bash scripts/wb.sh credits`。
