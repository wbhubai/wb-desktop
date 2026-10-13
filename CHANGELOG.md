# 更新日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵循语义化版本。

## [未发布]

### 修复

- **打包版 exe 后台循环（签到/旅行/保活）全部失效**：循环注册原在开发入口 `main.ts`，打包链路（Electron `main.cjs` → `backend.cjs`）从未执行；现移入 `startServer` 统一注册，dev/exe/无头入口共享，启动日志「后台循环已注册」可供核对
- **`/v1/messages` 伪流式改真流式**：原先无论是否请求流式都收完上游 SSE 再一次性返回 JSON，Agent 长回合零输出直至客户端读超时；现按 Anthropic SSE 事件协议逐条下发（`message_start`/`content_block_delta`/`input_json_delta`/`message_delta`/`message_stop`），翻译状态机含单测（11 项）
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
