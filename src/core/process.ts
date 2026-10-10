/**
 * Port of wbs `modules/process.rs` (Windows path) — detection via tasklist CSV
 * with exact image-name matching, graceful→forced close, detached launch.
 * macOS/Linux follow wbs's approach where reachable; not exercised on win32.
 */
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { access } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { dataRootAt, windowsExeNames, windowsImageNames, type WbVariant } from './variant.ts'

const CREATE_NO_WINDOW = 0x08000000

export interface ProcessRow {
  pid: number
  name: string
  image: string
}

const SELF_IMAGE_NAMES = ['workbuddy-switch', 'wb-switch', 'node', 'dsh']

/** tasklist /FO CSV /NH row parse: "WorkBuddy.exe","1234","Console",... */
export function parseTasklistCsv(output: string): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim().startsWith('"')) continue
    const cells = line.match(/"([^"]*)"/g)?.map((cell) => cell.slice(1, -1)) ?? []
    const image = cells[0] ?? ''
    const pid = Number(cells[1])
    if (!Number.isInteger(pid) || pid <= 0) continue
    rows.push({ pid, name: image, image })
  }
  return rows
}

export function keepWindowsWorkbuddyRow(variant: WbVariant, row: ProcessRow, ownPid: number): boolean {
  if (row.pid === ownPid) return false
  if (row.name.toLowerCase().includes('crashpad_handler')) return false
  if (SELF_IMAGE_NAMES.includes(row.name.toLowerCase().replace(/\.exe$/, ''))) return false
  const exeNames = windowsExeNames(variant).map((name) => name.toLowerCase())
  const byName = exeNames.includes(row.name.toLowerCase())
  const byImage = exeNames.includes(row.image.toLowerCase())
  return byName || byImage
}

function runCommand(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' }, (error, stdout) => {
      if (error && typeof stdout !== 'string') reject(error)
      else resolve(stdout ?? '')
    })
  })
}

export async function windowsWorkbuddyProcessRows(variant: WbVariant): Promise<ProcessRow[]> {
  const rows: ProcessRow[] = []
  for (const exe of windowsExeNames(variant)) {
    try {
      const output = await runCommand('tasklist', ['/FI', `IMAGENAME eq ${exe}`, '/FO', 'CSV', '/NH'], 5000)
      rows.push(...parseTasklistCsv(output))
    } catch {
      // tasklist missing/failed → no rows for this image
    }
  }
  const ownPid = process.pid
  const filtered = rows.filter((row) => keepWindowsWorkbuddyRow(variant, row, ownPid))
  const seen = new Set<number>()
  return filtered.filter((row) => (seen.has(row.pid) ? false : (seen.add(row.pid), true)))
}

export async function isWorkbuddyRunning(variant: WbVariant): Promise<boolean> {
  if (process.platform !== 'win32') return false
  return (await windowsWorkbuddyProcessRows(variant)).length > 0
}

async function waitProcessGone(variant: WbVariant, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await isWorkbuddyRunning(variant))) return true
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return !(await isWorkbuddyRunning(variant))
}

export async function closeWorkbuddy(variant: WbVariant, timeoutSecs = 20): Promise<void> {
  if (process.platform !== 'win32') return
  const rows = await windowsWorkbuddyProcessRows(variant)
  if (rows.length === 0) return
  for (const row of rows) {
    await runCommand('taskkill', ['/PID', String(row.pid), '/T'], 10_000).catch(() => {})
  }
  if (await waitProcessGone(variant, Math.min(8000, timeoutSecs * 1000))) return
  for (const row of rows) {
    await runCommand('taskkill', ['/PID', String(row.pid), '/T', '/F'], 10_000).catch(() => {})
  }
  if (!(await waitProcessGone(variant, Math.max(1000, timeoutSecs * 1000 - 8000)))) {
    throw new Error('WorkBuddy 进程无法关闭，请手动结束 WorkBuddy/CodeBuddy 进程')
  }
}

export function windowsDefaultAppPath(variant: WbVariant): string {
  const image = windowsImageNames(variant)[0] ?? 'WorkBuddy'
  return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'Programs', image, `${image}.exe`)
}

export function dataRootExists(variant: WbVariant): boolean {
  return existsSync(dataRootAt(os.homedir(), variant))
}

export async function launchWorkbuddy(variant: WbVariant): Promise<string> {
  if (process.platform !== 'win32') throw new Error('仅支持 Windows 平台自动启动')
  let exe = windowsDefaultAppPath(variant)
  if (!existsSync(exe)) {
    for (const candidate of fallbackCandidates(variant)) {
      try {
        await access(candidate)
        exe = candidate
        break
      } catch {
        continue
      }
    }
  }
  if (!existsSync(exe)) {
    throw new Error(`未找到 WorkBuddy 程序（尝试路径: ${exe}）。请在 Windows 上打开 WorkBuddy 后重试。`)
  }
  const child = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: CREATE_NO_WINDOW !== 0 })
  child.unref()
  return exe
}

function fallbackCandidates(variant: WbVariant): string[] {
  const image = windowsImageNames(variant)[0] ?? 'WorkBuddy'
  const exe = `${image}.exe`
  const candidates: string[] = []
  for (const base of [process.env.LOCALAPPDATA, process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)']]) {
    if (base) candidates.push(path.join(base, 'Programs', image, exe), path.join(base, image, exe))
  }
  for (const drive of 'CDEFGH') {
    candidates.push(path.join(`${drive}:\\Users`, os.userInfo().username, 'AppData', 'Local', 'Programs', image, exe))
  }
  return candidates
}
