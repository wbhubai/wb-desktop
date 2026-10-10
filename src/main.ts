/**
 * wb-desktop entry point: boots the local server and the background loops
 * (check-in every minute with window/due gating, travel dispatch/claim,
 * daily keepalive). Bind is 127.0.0.1 only.
 */
import { spawn } from 'node:child_process'
import { checkinCycle, keepaliveDaily, pushLog, travelCycle } from './app.ts'
import { startServer } from './server.ts'

const port = Number(process.env.WB_PORT ?? process.argv[2] ?? 3081)

function guard(label: string, run: () => Promise<unknown>): void {
  run().catch((error: unknown) => {
    pushLog('error', `后台任务异常：${label}`, { error: error instanceof Error ? error.message : String(error) })
  })
}

async function main(): Promise<void> {
  await startServer(port)
  pushLog('info', 'wb-desktop 已启动')

  setInterval(() => guard('签到', () => checkinCycle()), 60_000)
  setInterval(() => guard('旅行派发', () => travelCycle('dispatch')), 30 * 60_000)
  setInterval(() => guard('旅行领取', () => travelCycle('claim')), 15 * 60_000)
  setInterval(() => guard('保活', () => keepaliveDaily()), 6 * 3_600_000)

  if (process.env.WB_NO_OPEN !== '1' && process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', `http://127.0.0.1:${port}`], { detached: true, stdio: 'ignore' }).unref()
  }
}

void main().catch((error: unknown) => {
  console.error('[wb] 启动失败:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
