/**
 * Local persistence for the WorkBuddy desktop app: everything lives under
 * `~/.wb-hub/`. Unlike the dsh plugin (which split tokens into the dsh
 * credential store), the standalone app keeps FULL account records — tokens
 * included — in its own JSON files, mirroring workbuddy-switch's own model.
 * All writes are atomic (temp + rename, with Windows rename-race retries);
 * auth-file backups land in `~/.wb-hub/auth-backups/` with a retention cap.
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import type { WbAccount } from './core/account.ts'

export const DATA_DIR = path.join(os.homedir(), '.wb-hub')
export const AUTH_BACKUP_DIR = path.join(DATA_DIR, 'auth-backups')

export function dataFile(name: string): string {
  return path.join(DATA_DIR, name)
}

export async function atomicWriteText(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${randomUUID()}`)
  await writeFile(tmp, content, 'utf8')
  const retryable = new Set(['EPERM', 'EBUSY', 'EACCES'])
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(tmp, file)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code ?? ''
      if (attempt >= 5 || !retryable.has(code)) {
        await rm(tmp, { force: true })
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 150 * attempt))
    }
  }
}

export async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  await atomicWriteText(file, `${JSON.stringify(value, null, 2)}\n`)
}

export async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T
  } catch {
    return undefined
  }
}

// ------------------------------------------------------------------ accounts

let records: WbAccount[] = []

export async function loadAccounts(): Promise<WbAccount[]> {
  records = (await readJson<WbAccount[]>(dataFile('accounts.json'))) ?? []
  return records
}

export function currentAccounts(): WbAccount[] {
  return records
}

export async function persistAccounts(): Promise<void> {
  await atomicWriteJson(dataFile('accounts.json'), records)
}

// ------------------------------------------------------------- config/logs

export async function readConfig<T>(name: string, fallback: T): Promise<T> {
  return (await readJson<T>(dataFile(name))) ?? fallback
}

export async function writeConfig(name: string, value: unknown): Promise<void> {
  await atomicWriteJson(dataFile(name), value)
}

export async function readList<T>(name: string): Promise<T[]> {
  return (await readJson<T[]>(dataFile(name))) ?? []
}
