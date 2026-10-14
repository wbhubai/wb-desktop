# wb-desktop · WorkBuddy 账号助手

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20x64-lightgrey)](../../releases)
[![Electron](https://img.shields.io/badge/Electron-37-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)

A local account manager & AI model gateway for WorkBuddy / CodeBuddy, shipped as a single portable Windows executable.

**wb-desktop** 是面向 WorkBuddy / CodeBuddy 用户的 Windows 桌面工具：把多账号登录态管理、Token 保活、自动签到和一个本地 AI 模型网关打包进**单个免安装 exe**（Electron，双击即用，无需 Node 环境）。

> ⚠️ **本项目仅限个人自用账号（账号管理 / 签到保活 / 猫猫旅行 / 本地网关接入），不支持同时也禁止批量小号分发额度、付费 API 共享池、二次打包或收费售卖。** 详见下方[使用声明（必读）](#使用声明必读)。

## 📜 使用声明（必读）

本项目（wb-desktop）的开发初衷只有一个：**方便个人管理自己的 WorkBuddy / CodeBuddy 账号**——登录态管理、自动签到、猫猫旅行、成长任务，以及把自己的账号积分包装成本地模型网关供自己的 AI 工具使用。它是免费、开源、按「原样」提供的个人自用工具。

特别提示：本项目包含对上游接口的自动化调用与部分逆向实现（签到协议、成长任务事件上报、通道签名改写等）。这些机制可能随上游升级而失效，也可能触碰平台风控——**使用即表示理解并接受相应的账号风险**。

若发现以下滥用行为，我们表达最强烈的反对：

- 批量注册小号 / 收购账号，对外提供付费 API、共享池、代充等业务；
- 二次加壳、捆绑卡密（授权码）售卖，或以「公益服」「低价中转」等名义变相收费分发。

声明如下：

1. **一切商用 / 售卖行为与本项目及作者无关。** 本项目不授权、不支持、不参与任何面向公众的 API 售卖、账号池出租、卡密收费分发；行为人由此产生的一切后果自行承担。
2. **自动化操作与转售接口配额违反目标平台服务条款。** 批量注册账号、共享分发额度均违反 WorkBuddy / CodeBuddy 服务条款；由此导致的账号封禁、条款违约或法律风险由使用者自行承担，作者不对使用结果负责。
3. **请勿购买任何「收费版」「卡密版」「公益中转版」。** 本项目永远免费开源；任何加壳、加密、捆绑收费的「版本」都是他人篡改的产物，且 `~/.wb-hub/accounts.json` 保存的是明文 token，无法审计的分发存在窃取凭证的风险。
4. **关于开源协议的诚实说明。** 本项目基于 MIT 协议开源——MIT 赋予的是代码层面的自由，**不赋予**以本项目名义宣传、售卖、捆绑分发，或要求作者提供支持与背书的权利。
5. **作者保留止损的权利。** 若滥用行为持续或上游环境变化，作者可能随时停止维护、删除仓库，且不另行通知。

## ✨ 功能

### 账号管理

- 双档位（国内 cn / 国际 ai）OAuth 扫码登录
- 一键切换账号：备份官方认证文件 → 原子写 + 写后校验 → 自动关闭/重启 WorkBuddy 进程
- Token 保活刷新（每日自动）；积分余额 / 到期查询（7 天内到期高亮排序）
- 自动签到（可选时间窗，窗口内各账号自动错峰；高级项可调保活天数）
- 猫猫旅行（派发 / 领取 / 官方状态同步；国际版自动跳过）

### 模型网关（供 ZCode 等本机 AI 客户端调用）

把 WorkBuddy 账号积分以标准 API 形式提供给本机 AI 客户端，**积分计量与官方 App 完全一致**（同上游端点、同官方用量台账、逐请求上报 usage.credit）。

- OpenAI 格式：`POST /v1/chat/completions`（流式透传，支持 tools）
- Anthropic 格式：`POST /v1/messages`（协议转换，支持流式 / tools / thinking blocks）
- 模型清单：`GET /v1/models`（内置官方模型目录，可编辑、可探测刷新）
- 思考模式开关；上游 11128 通道拦截自动重发（官方文档记载的重发方式，推理前重试不重复扣费）
- 虚拟 Key 鉴权（`Authorization: Bearer` / `X-Api-Key`），可随时重置
- 用量台账：按模型 / 账号汇总的 token 与积分记录，跨重启保留
- 可选内网监听（默认 9527）：仅开放 `/v1/*` 数据面，供局域网内其他设备接入

### 桌面体验

- **托盘常驻**：关闭窗口不退出，后台签到 / 旅行 / 保活与网关持续运行；托盘菜单随时重开主界面
- 内存优化：关窗即销毁渲染进程，常驻内存约 170MB
- 无头模式：`WB_NO_OPEN=1` 启动不弹窗（自启 / 测试场景）

## 🚀 快速开始

### 方式一：下载便携版（推荐）

从 [Releases](../../releases) 下载 `wb-desktop-portable.exe`，双击即运行；可复制到任何 Windows x64 机器独立使用。

- 界面分「账号助手 / 网关代理 / 操作日志」三个页签，右上角实时显示网关运行状态（本地端口与局域网开关）
- 主界面网关地址：`http://127.0.0.1:3081/v1`（虚拟 Key 在「网关代理」页签查看）
- 关闭窗口 = 缩到托盘继续运行；托盘右键「退出」才是真正退出

### 方式二：从源码构建

```bash
git clone https://github.com/wbhubai/wb-desktop.git
cd wb-desktop
pnpm install      # 首次
pnpm run dist     # 产出 release/wb-desktop-portable.exe
```

环境要求：Node.js ≥ 20、pnpm ≥ 10（`corepack enable`）；打包目标为 Windows x64。

## 🛠 开发

```bash
pnpm install
pnpm start        # 构建 + 打开 Electron 窗口
pnpm run serve    # 无头服务模式（不开打包、不弹窗）
pnpm run serve:watch
pnpm test         # vitest（核心协议与业务逻辑单测）
pnpm run icon     # 重新生成应用图标 build/icon.ico
```

环境变量：`WB_PORT`（默认 3081）、`WB_NO_OPEN=1`（不弹窗）、`WB_LAN_PORT`（内网监听端口，默认 9527，设为 0 关闭）。

架构一览：

```
src/
├── main.ts      # 无头/开发入口（tsx 直接运行）
├── server.ts    # HTTP 服务：控制面（UI + 管理 API，仅 127.0.0.1）+ 内网网关监听
├── gateway.ts   # 模型网关：OpenAI/Anthropic 双协议、流式、用量台账
├── app.ts       # 业务层：账号/签到/旅行/保活等
├── store.ts     # ~/.wb-hub 数据目录读写
├── ui.html      # 控制台单页 UI（构建时内联）
└── core/        # WorkBuddy/CodeBuddy 协议与业务核心（零外部依赖，含单测）
```

## 📁 数据目录

`~/.wb-hub/`（accounts、configs、logs、auth-backups）。

> ⚠️ **安全提示**：账号 token 以明文保存在 `~/.wb-hub/accounts.json`。请勿将该目录纳入同步/备份到不受信任的位置。

## 🔒 安全与合规

### 1. 凭据管理

- 账号 token 以**明文**保存在 `~/.wb-hub/accounts.json`（与官方客户端登录态文件同一风险面）；请勿纳入同步 / 备份到不受信任的位置，**切勿提交 git**
- 运行日志与调用台账只记录模型 / 账号名 / token 数 / 积分，**不含** access token / refresh token / 虚拟 Key 明文

### 2. 网络暴露

- 控制面（UI + 管理 API）仅绑定 `127.0.0.1`，**无鉴权**——只在本机可信环境使用，不要将 3081 端口转发 / 暴露
- 局域网数据面默认 `:9527`，仅开放 `/v1/*` 推理端点且强制虚拟 Key 鉴权；`WB_LAN_PORT=0` 可关闭

### 3. 发布来源与合规边界

- 官方产物**仅通过 GitHub Releases** 发布（由 tag 触发 CI 从源码构建，可溯源）；其他渠道的分发与本项目无关
- wb-desktop 是 WorkBuddy / CodeBuddy 的**非官方第三方工具**，与腾讯及官方产品无任何关联；「WorkBuddy」「CodeBuddy」及相关名称的权利归其各自所有者
- 自动签到、猫猫旅行、成长任务自动化等属于对第三方服务的自动化操作，**可能违反其服务条款**；是否使用请自行判断，本项目不提供、不破解任何付费能力

### 4. 授权使用边界

- 仅限**本人授权账号**、本机 / 私有环境使用
- 不得共享、转售、违规分发，或用于违反目标平台条款的用途；严禁批量注册账号做 API 业务——详见[使用声明（必读）](#使用声明必读)
- 遵守平台服务条款与所在地法律；妥善保管 `~/.wb-hub/` 目录与网关虚拟 Key（泄露后可在「网关代理」页重置）

## 🤝 贡献

欢迎 Issue 与 PR，见 [CONTRIBUTING.md](CONTRIBUTING.md)。安全漏洞请勿公开发布，见 [SECURITY.md](SECURITY.md)。

## 📄 License

[MIT](LICENSE)
