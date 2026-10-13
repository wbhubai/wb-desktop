/**
 * Background task loops: check-in window/due gating every minute, travel
 * dispatch/claim, daily keepalive. Registered inside startServer so every
 * entry (Electron exe, dev tsx, future headless) shares one scheduling
 * definition — the packaged exe previously ran NO loops because registration
 * lived only in the dev entry, which the build never bundles.
 */
import { checkinCycle, keepaliveDaily, pushLog, travelCycle } from './app.ts'

function guard(label: string, run: () => Promise<unknown>): void {
  run().catch((error: unknown) => {
    pushLog('error', `后台任务异常：${label}`, { error: error instanceof Error ? error.message : String(error) })
  })
}

export function startBackgroundLoops(): void {
  pushLog('info', '后台循环已注册：签到(1m) / 旅行派发(30m) / 旅行领取(15m) / 保活(6h)')
  setInterval(() => guard('签到', () => checkinCycle()), 60_000)
  setInterval(() => guard('旅行派发', () => travelCycle('dispatch')), 30 * 60_000)
  setInterval(() => guard('旅行领取', () => travelCycle('claim')), 15 * 60_000)
  setInterval(() => guard('保活', () => keepaliveDaily()), 6 * 3_600_000)
}
