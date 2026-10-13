# 更新日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵循语义化版本。

## [未发布]

### 新增

- **模型清单统一与零成本同步**：定位官方运行时目录接口（`GET /v3/config` + 企业端点 `/v2|/console/enterprises/personal/models`，均免费），双路并集（`auto` 等路由模型仅在企业端点下发）；清单含倍率/上下文窗口/输出上限/图片/工具/官方标签，`/v1/models` 附带元数据；UI 模型清单改表格化（同步/探测/增删一体），与数据面读同一份
- **台账学习**：真实调用成功的模型自动并入清单（零成本可用性证明，30s 防抖落盘），新模型上线无需发版即可感知
- **MCP stdio server**（`dist/mcp.cjs`）：零依赖手写 JSON-RPC，把控制面包成 12 个原生工具（签到/旅行/积分/切账号/用量/日志），Claude Code、ZCode 可直接注册
- **无头运行入口** `node dist/headless.cjs`：纯 Node 跑完整后台（server + 全部定时循环），无 Electron，适合服务器/Docker
- **AGENTS.md**：AI Agent 使用指南（控制面 API 清单、典型任务手册、MCP 注册、安全边界）
- 远程签名规则源机制：配置 `rulesUrl` 后每日拉取合并（`{"rewrites":[...]}` 静态 GET、零遥测、默认关闭、失败保留缓存）
- 网关响应统一携带 `x-wb-account`（非流式与 Anthropic 路径补齐）；用量台账 200→2000 条
- 配置文件 mtime 缓存：网关高频路径不再每请求整读 JSON（降为一次 stat），外部进程写入后自动重读
- `/v1/messages/count_tokens` 端点：本地估算 input tokens（CJK≈1 token/字、拉丁≈1/4 字符，含 tools 定义），不花积分，供 Agent 做上下文管理
- 客户端断开即中止上游请求（2026-10-13 实测中断不扣费），用量台账如实记 `client_aborted`

### 修复

- **模型清单是静态快照且首运后永久冻结**：内置 7 模型目录为 2026-09-30 快照，上游无感知渠道，探测只查已知候选（kimi-k3 等真实可用模型长期缺席）。现目录改为运行时同步 + 台账学习 + 手动编辑三源合一，`/v1/models` 与 UI 统一
- **探测语义与注释相反**：注释称临时错误不剔除，实际 429/5xx 一律判死并从清单移除；现仅上游确认不存在（400 service info not found）才移除
- **无头构建产物 `GET /` 返回空页**：headless/mcp 打包缺 UI 注入且 CJS 下 `import.meta.url` 不可用；现统一注入内嵌 UI
- **上游超时缺失**（上游挂起会让请求永久悬挂、连接堆积）：连接/首包 120s、响应流空闲 180s 看门狗、模型探测 15s
- **同一账号上游并发无上限**（Agent 并发打满易触发 11128 风控）：每账号在途上游请求上限 2，超出排队
- **11128 调试转储无上限增长**（含完整 prompt 内容，治理+隐私）：只保留最近 20 个
- **11128 签名改写表不随版本传播**：旧版把内置表整包快照存进配置，应用更新内置表对存量用户永不生效，且默认表硬编码在三处（运行时/死代码/UI）。现存储层只存用户增量，生效表 = 内置基线 ∪ 增量；旧配置读取时自动迁移；「恢复默认」= 清空增量，自动回到随版本发布的新基线
- **11128 持续拦截时报错明确化**：自动重发仍失败时，错误消息附处置指引（到「高级：签名改写」加规则、被拦请求体转储位置），不再把上游 400 原文直接甩给客户端
- **打包版 exe 后台循环（签到/旅行/保活）全部失效**：循环注册原在开发入口 `main.ts`，打包链路（Electron `main.cjs` → `backend.cjs`）从未执行；现移入 `startServer` 统一注册，dev/exe/无头入口共享，启动日志「后台循环已注册」可供核对
- **`/v1/messages` 伪流式改真流式**：原先无论是否请求流式都收完上游 SSE 再一次性返回 JSON，Agent 长回合零输出直至客户端读超时；现按 Anthropic SSE 事件协议逐条下发（`message_start`/`content_block_delta`/`input_json_delta`/`message_delta`/`message_stop`），翻译状态机含单测（11 项）
- **Anthropic 图片块被静默丢弃**（Agent 发截图、模型根本没看到图）：现映射为 OpenAI `image_url` 转发上游；`tool_result` 内图片拆分为紧随其后的 user 消息（OpenAI tool 消息只能带文本）
- 上游错误一律 `api_error` 且不透传 Retry-After：现按状态码映射标准 error.type（429→`rate_limit_error`、模型不存在→`not_found_error`、401→`authentication_error`、529→`overloaded_error` 等），Agent 的差异化退避重试可正确工作
- `tool_choice:{type:'none'}` 静默变 auto（导致乱调用工具）；`stop_sequences` 被丢弃：现正确映射为 OpenAI `none` / `stop`
- 网关折叠面板 details summary 双箭头（原生 marker 与自定义箭头叠加）

## [0.2.0] - 2026-10-10

首个开源版本（以此版本为基线开始独立版本管理）。

### 新增

- 内置模型网关：OpenAI / Anthropic 双协议（流式透传 + tools 双向映射）、虚拟 Key 鉴权、积分计量与官方 App 一致、跨重启用量台账
- 官方模型目录管理（按 ID 探测可用性、自动更新清单、UI 可编辑）与思考模式开关
- 上游 11128 通道拦截自动重发（推理前重试，不重复扣费）；请求签名改写管理（增删/重置即时生效）
- 内网 AI 网关专用监听（默认 9527，仅开放 `/v1/*` 数据面 + 虚拟 Key）
- 托盘常驻：关窗不退出，后台签到/旅行/保活与网关持续服务；渲染进程随窗口销毁，常驻内存约 170MB

### 修复

- 思考=关闭时，网关出口侧抑制 `reasoning_content`
- 流式 `/v1/chat/completions` 全部漏记用量（「刷新统计后 token 使用记录不更新」的根因）
- 用量统计刷新命中 HTTP 缓存（no-store + cache-buster）；用量面板只显示最旧 50 条
- 思考模型空回复（折叠 + 思考禁用选项）；积分查询透出官方 20017 错误与套餐表
- 猫猫旅行派发要求原生数字 location_id（字符串被上游 400 拒绝）

## [0.1.0] - 2026-09-30

- Electron 独立窗口版首发：esbuild 单文件后端 + electron-builder 免安装便携 exe
- 账号管理全家桶：双档位 OAuth 扫码登录、本机登录态导入、一键切换（备份 → 原子写 + 写后校验 → 重启进程）、Token 保活刷新、积分/到期查询、自动签到、猫猫旅行
