/**
 * Headless entry: run the full backend (server + background loops) on plain
 * Node — no Electron/GUI. Same data dir and loops as the exe; bind stays
 * 127.0.0.1 for the control plane. Usage: node dist/headless.cjs [port]
 */
import { startServer } from './server.ts'

const port = Number(process.env.WB_PORT ?? process.argv[2] ?? 3081)

startServer(port).catch((error: unknown) => {
  console.error('[wb] 启动失败:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
