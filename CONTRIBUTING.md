# 贡献指南

感谢关注 wb-desktop！欢迎通过 Issue 反馈问题、通过 PR 提交改进。

## 环境要求

- **操作系统**：打包目标为 Windows x64；开发与单元测试可在 macOS / Linux 进行（网关与核心逻辑均为跨平台纯 Node 代码，Electron 窗口/托盘相关功能需在 Windows 验证）
- **Node.js ≥ 20**，**pnpm ≥ 10**（`corepack enable`）

## 本地开发

```bash
git clone <你的 fork>
cd wb-desktop
pnpm install
pnpm test          # 跑单测，确认基线全绿
pnpm start         # 构建 + 打开 Electron 窗口
pnpm run serve:watch  # 无头模式 + 后端热重载（改 backend 代码自动重启）
```

环境变量：`WB_PORT`（默认 3081）、`WB_NO_OPEN=1`（不弹窗，适合 CI / 无头调试）、`WB_LAN_PORT`（内网监听端口，默认 9527，设为 0 关闭）。

## 测试要求

- `src/core/`（协议与业务核心）的改动**必须**附带 vitest 单测：`pnpm test` 全绿
- UI / 托盘 / 打包等暂无自动化的部分，请在 PR 描述中写明手动验证步骤
- 涉及网关协议转换（OpenAI ↔ Anthropic、流式、tools）的改动，建议用真实客户端或 curl 各验一遍流式与非流式

## 提交规范

遵循 Conventional Commits（描述可用中文）：

```
feat(gateway): 支持 xxx
fix(core): 修复 xxx
docs: 更新 README
chore: 依赖升级
```

常用 scope：`gateway`、`core`、`ui`、`server`、`store`。

## PR 流程

1. Fork → 新建分支 → 改动 → 提交
2. 确保 `pnpm build` 与 `pnpm test` 通过（CI 会跑同样检查）
3. PR 描述写清：动机 / 改动点 / 验证方式；关联对应 Issue
