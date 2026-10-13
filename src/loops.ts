/**
 * Background task loops: check-in window/due gating every minute, travel
 * dispatch/claim, daily keepalive, daily remote signature-rules refresh.
 * Registered inside startServer so every entry (Electron exe, dev tsx,
 * headless node) shares one scheduling definition — the packaged exe
 * previously ran NO loops because registration lived only in the dev entry.
 */
import { checkinCycle, keepaliveDaily, pushLog, travelCycle } from './app.ts'
import { refreshRemoteRules } from './gateway.ts'

function guard(label: string, run: () => Promise<unknown>): void {
  run().catch((error: unknown) => {
    pushLog('error', `后台任务异常：${label}`, { error: error instanceof Error ? error.message : String(error) })
  })
}

export function startBackgroundLoops(): void {
  pushLog('info', '后台循环已注册：签到(1m) / 旅行派发(30m) / 旅行领取(15m) / 保活(6h) / 远程规则(24h)')
  setInterval(() => guard('签到', () => checkinCycle()), 60_000)
  setInterval(() => guard('旅行派发', () => travelCycle('dispatch')), 30 * 60_000)
  setInterval(() => guard('旅行领取', () => travelCycle('claim')), 15 * 60_000)
  setInterval(() => guard('保活', () => keepaliveDaily()), 6 * 3_600_000)
  // 远程签名规则每日刷新；未配置 rulesUrl 时内部静默跳过，不发起任何请求
  setInterval(() => guard('远程规则', () => refreshRemoteRules()), 24 * 3_600_000)
}
