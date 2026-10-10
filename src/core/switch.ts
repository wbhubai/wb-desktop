/**
 * Port of wbs `modules/switch.rs` (switch flow without session copy/sync —
 * the requirement scope is backup → envelope-verbatim write → atomic write +
 * verification → process restart).
 */
import os from 'node:os'
import path from 'node:path'
import { backupAuthFile, writeAccountToAuthFile } from './auth-file.ts'
import { accountDisplayName, findAccountIn, type WbAccount } from './account.ts'
import { closeWorkbuddy, isWorkbuddyRunning, launchWorkbuddy } from './process.ts'
import { variantOf } from './account.ts'
import { type WbVariant } from './variant.ts'

export interface SwitchOptions {
  home?: string
  backupDir: string
  restart: boolean
  now?: () => number
}

export interface SwitchResult {
  ok: true
  account: string
  variant: string
  backup?: string
  restart: boolean
  wasRunning: boolean
}

export interface SwitchDeps {
  backup: (variant: 'cn' | 'ai') => Promise<string | undefined>
  write: (account: WbAccount, variant: 'cn' | 'ai') => Promise<string>
  close: (variant: 'cn' | 'ai', timeoutSecs: number) => Promise<void>
  launch: (variant: 'cn' | 'ai') => Promise<string>
  isRunning: (variant: 'cn' | 'ai') => Promise<boolean>
}

/** Progress callback mirroring wbs ProgressFn. */
export type ProgressFn = (message: string) => void

export async function switchAccount(
  accounts: WbAccount[],
  accountId: string,
  options: SwitchOptions,
  deps: SwitchDeps,
  progress: ProgressFn = () => {},
): Promise<SwitchResult> {
  const account = findAccountIn(accounts, accountId)
  if (!account) throw new Error(`账号不存在: ${accountId}`)
  const variant = variantOf(account)
  progress('开始切换账号…')
  const backup = await deps.backup(variant)
  const wasRunning = await deps.isRunning(variant)
  if (options.restart) {
    progress('正在关闭 WorkBuddy…')
    await deps.close(variant, 20)
  }
  progress('正在写入认证文件…')
  await deps.write(account, variant)
  if (options.restart) {
    progress('正在启动 WorkBuddy…')
    await deps.launch(variant)
  }
  progress('切换完成')
  return {
    ok: true,
    account: accountDisplayName(account),
    variant,
    backup,
    restart: options.restart,
    wasRunning,
  }
}

/** Default deps: real filesystem + process control. */
export function defaultSwitchDeps(home: string | undefined): SwitchDeps {
  return {
    backup: (variant) => backupAuthFile(variant, backupDirFor(home)),
    write: (account, variant) => writeAccountToAuthFile(account, variant, home ? { home } : {}),
    close: (variant, timeoutSecs) => closeWorkbuddy(variant, timeoutSecs),
    launch: (variant) => launchWorkbuddy(variant),
    isRunning: (variant) => isWorkbuddyRunning(variant),
  }
}

function backupDirFor(home: string | undefined): string {
  return path.join(home ?? os.homedir(), '.dsh', 'hub', 'workbuddy-accounts', 'auth-backups')
}
