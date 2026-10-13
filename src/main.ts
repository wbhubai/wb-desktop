/**
 * wb-desktop dev/CLI entry: boots the local server. Background loops are
 * registered inside startServer (see loops.ts), shared with the Electron exe.
 * Bind is 127.0.0.1 only.
 */
import { spawn } from 'node:child_process'
import { startServer } from './server.ts'

const port = Number(process.env.WB_PORT ?? process.argv[2] ?? 3081)

async function main(): Promise<void> {
  await startServer(port)
  if (process.env.WB_NO_OPEN !== '1' && process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', `http://127.0.0.1:${port}`], { detached: true, stdio: 'ignore' }).unref()
  }
}

void main().catch((error: unknown) => {
  console.error('[wb] 启动失败:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
