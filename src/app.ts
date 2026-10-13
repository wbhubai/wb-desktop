/**
 * Business layer of the WorkBuddy desktop app — a direct port of the dsh
 * plugin's service methods onto the local store. All WorkBuddy/CodeBuddy
 * protocol logic lives in the vendored core layer (src/core/), ported file-by-file
 * from the project's dsh-plugin predecessor; it has zero external dependencies.
 */
import {
  accountMeta,
  buildAuthHeaders,
  deleteAccountFrom,
  findAccountIn,
  getStr,
  isEnvelope,
  upsertAccountIn,
  upsertCollectedAccount,
  variantOf,
  type WbAccount,
} from './core/account.ts'
import { OAuthFlow } from './core/oauth.ts'
import { importFromAuthFile } from './core/auth-file.ts'
import { switchAccount, type SwitchDeps } from './core/switch.ts'
import { backupAuthFile } from './core/auth-file.ts'
import { closeWorkbuddy, isWorkbuddyRunning, launchWorkbuddy } from './core/process.ts'
import { ensureFreshToken, refreshAccountToken, runKeepaliveCycle } from './core/refresh.ts'
import {
  apiBaseFor,
  creditResult,
  envelopeShortCircuit,
  extractNestedArray,
  isUnauthorized,
  legacyCreditCandidates,
  mergeResources,
  requestOrigin,
  resourceAuthHeaders,
  resourceSummary,
  usesThreeEndpointQuery,
  type ResourceSummary,
} from './core/credits.ts'
import {
  decideFromStatus,
  defaultCheckinConfig,
  dueAccounts,
  isInactiveMessage,
  normalizeCheckinLogs,
  windowMinutes,
  type CheckinConfig,
  type CheckinLogRow,
} from './core/checkin.ts'
import {
  mergeTravelCache,
  rollCacheToToday,
  travelDisplayLabel,
  classifyDepartError,
  type TravelCache,
  type TravelRecord,
} from './core/travel.ts'
import {
  buildChatActivityEvent,
  LOTTERY_DRAW_CAP,
  REPORT_PATH,
  parseLotteryChances,
  parseStreakFull,
  redeemableTiers,
  rollGrowthStateToToday,
  supportsGrowth,
  type GrowthDayState,
} from './core/growth.ts'
import { randomUUID } from 'node:crypto'
import { fetchHttp, isPlainObject, nowMs } from './core/util.ts'
import { listAt, recordAt, buildEntry } from './core/error-log.ts'
import { buildAccountObj, buildAuthObj, writeAccountToAuthFile } from './core/auth-file.ts'
import { supportsCheckin, supportsTravel } from './core/variant.ts'
import { AUTH_BACKUP_DIR, dataFile, loadAccounts, currentAccounts, persistAccounts, readConfig, readList, readJson, writeConfig } from './store.ts'

const CHECKIN_PREFIX = '/v2/billing/meter'
// wbs credits.rs 的套餐码表——官方 paid/free 端点自 2026-09 起强制要求 PackageCodes
const PAID_PACKAGE_CODES = [
  'TCACA_code_002_AkiJS3ZHF5', 'TCACA_code_023_4xbGhMrE6q', 'TCACA_code_026_BaESVICNoi', 'TCACA_code_027_0FCGVA6vSa',
  'TCACA_code_009_0XmEQc2xOf', 'TCACA_code_038_OhvqZtiPKr', 'TCACA_code_003_FAnt7lcmRT', 'TCACA_code_036_lupO5WgNdG',
]
const FREE_PACKAGE_CODES = [
  'TCACA_code_008_cfWoLwvjU4', 'TCACA_code_007_nzdH5h4Nl0', 'TCACA_code_028_NtpWi0jzXs', 'TCACA_code_029_6wCGEWquYy',
  'TCACA_code_030_BjSt89qTvr', 'TCACA_code_001_PqouKr6QWV', 'TCACA_code_006_DbXS0lrypC', 'TCACA_code_035_ArVxJcGDsm',
  'TCACA_code_037_WxOD3MpI2o', 'TCACA_code_039_KRcQj7wUat', 'TCACA_code_040_mi9rCYg46x',
]
const CHECKIN_API_AI_PREFIX = '/billing/meter'
const TRAVEL_PREFIX = '/activity/growth/buddy/travel'
const GROWTH_BUDDY_BASE = 'https://www.codebuddy.cn/activity/growth/buddy'
// growth 域（连登/抽奖/旅行）统一走 codebuddy.cn + web 指纹（与猫猫旅行同域）
const GROWTH_WEB_BASE = 'https://www.codebuddy.cn'

function travelHeaders(account: WbAccount): Record<string, string> {
  return {
    ...buildAuthHeaders(account),
    Accept: 'application/json',
    'x-client-platform': 'web',
    Origin: GROWTH_WEB_BASE,
    Referer: `${GROWTH_WEB_BASE}/profile/growth-center`,
  }
}

const logRing: unknown[] = []
export function pushLog(level: 'info' | 'warn' | 'error', message: string, detail?: unknown): void {
  const entry = { ts: Date.now(), level, message, detail }
  logRing.push(entry)
  if (logRing.length > 200) logRing.splice(0, logRing.length - 200)
  if (level === 'error') console.error(`[wb] ${message}`, detail === undefined ? '' : JSON.stringify(detail))
  else console.log(`[wb] ${message}`)
}

export function recentLogs(): unknown[] {
  return [...logRing].reverse()
}

async function recordError(message: string, detail: unknown): Promise<void> {
  pushLog('error', message, detail)
  await recordAt(dataFile('error.log'), buildEntry('backend', message, JSON.stringify(detail ?? ''), nowMs(), 'wb-desktop', process.platform)).catch(() => {})
}

const cycleState = { checkinBusy: false, travelBusy: false, claimBusy: false, growthBusy: false, fastRetryBudget: 12 }
let lastKeepaliveDay = ''

export const oauth = new OAuthFlow(async (collected) => {
  await loadAccounts()
  const saved = upsertCollectedAccount(currentAccounts(), collected)
  await persistAccounts()
  return accountMeta(saved)
})

// --------------------------------------------------------------- checkin

function statusFromCheckinResponse(response: Record<string, unknown>, statusUnsupported: boolean): { ok: boolean; todayCheckedIn?: boolean; error?: string; statusUnsupported?: boolean } {
  const code = response['code']
  if (code !== 0 && code !== 200) {
    if (statusUnsupported) return { ok: false, statusUnsupported: true }
    const message = typeof response['message'] === 'string' ? response['message'] : typeof response['msg'] === 'string' ? response['msg'] : undefined
    return { ok: false, ...(message !== undefined ? { error: message } : {}) }
  }
  const data = (response['data'] ?? {}) as Record<string, unknown>
  return { ok: true, todayCheckedIn: data['today_checked_in'] === true || data['todayCheckedIn'] === true }
}

async function checkinRequest(account: WbAccount, suffix: string): Promise<Record<string, unknown>> {
  const variant = variantOf(account)
  if (isEnvelope(account, 'access_token')) {
    return { code: -2, message: '该账号凭据为 WorkBuddy 加密信封态，无法直接调用签到 / 积分 / Token 统计等接口；切换功能不受影响，如需上述功能请删除该账号后改用「OAuth 扫码添加」获取明文凭据。' }
  }
  const candidates = variant === 'ai' ? [`${CHECKIN_API_AI_PREFIX}${suffix}`, `${CHECKIN_PREFIX}${suffix}`] : [`${CHECKIN_PREFIX}${suffix}`]
  let response: Record<string, unknown> = {}
  for (const [index, path] of candidates.entries()) {
    const url = `${variantOf(account) === 'ai' ? 'https://www.workbuddy.ai' : 'https://www.codebuddy.cn'}${path}`
    response = (await fetchHttp(url, 'POST', {}, buildAuthHeaders(account))) as Record<string, unknown>
    if (isUnauthorized(response) && getStr(account, 'refresh_token')) {
      const result = await refreshAccountToken(account, persistUpdated)
      if (result.ok) response = (await fetchHttp(url, 'POST', {}, buildAuthHeaders(result.account))) as Record<string, unknown>
    }
    const code = response['code']
    if (code === 0 || code === 200 || index === candidates.length - 1) return response
    if (code !== 404) return response
  }
  return response
}

async function checkinAccount(account: WbAccount): Promise<{ result: string; error?: string; inactive?: boolean }> {
  if (!supportsCheckin(variantOf(account))) return { result: 'skipped', error: 'unsupported_variant' }
  await ensureFreshToken(account, persistUpdated, 24)
  const statusResponse = await checkinRequest(account, '/checkin-activity-status')
  const unsupported = variantOf(account) === 'cn' && (statusResponse['code'] === 404 || statusResponse['code'] === -1)
  const decision = decideFromStatus(statusFromCheckinResponse(statusResponse, unsupported))
  if (decision.action !== 'submit') {
    return decision.action === 'already' ? { result: 'already' } : { result: 'error', error: decision.error }
  }
  const submit = await checkinRequest(account, '/daily-checkin')
  const code = submit['code']
  const message = typeof submit['message'] === 'string' ? submit['message'] : ''
  if (code === 0 || code === 200) return { result: 'success' }
  if (message.includes('已签到') || message.toLowerCase().includes('repeat')) return { result: 'already' }
  if (variantOf(account) === 'ai' && isInactiveMessage(message)) return { result: 'inactive', inactive: true, error: message }
  await appendCheckinLog({ ts: Date.now(), accountId: getStr(account, 'id'), email: getStr(account, 'email'), variant: variantOf(account), result: 'error', error: message })
  pushLog('error', `签到失败：${getStr(account, 'email') ?? getStr(account, 'id') ?? '未知账号'}：${message}`)
  return { result: 'error', error: message }
}

async function appendCheckinLog(row: CheckinLogRow): Promise<void> {
  const logs = normalizeCheckinLogs([...(await readList<CheckinLogRow>('checkin-logs.json')), row])
  await writeConfig('checkin-logs.json', logs)
}

export async function checkinCycle(manual = false): Promise<unknown> {
  if (cycleState.checkinBusy) return manual ? { status: 'skipped', reason: 'already_running' } : undefined
  cycleState.checkinBusy = true
  try {
    const config = await readConfig<CheckinConfig>('checkin-config.json', defaultCheckinConfig(false))
    if (!config.enabled && !manual) return { status: 'disabled' }
    await loadAccounts()
    const win = windowMinutes(config)
    const eligible = currentAccounts()
      .filter((record) => supportsCheckin(variantOf(record)) && !config.excluded_account_ids.includes(getStr(record, 'id') ?? ''))
      .map((record) => ({ record, id: getStr(record, 'id') ?? undefined, displayName: getStr(record, 'email') ?? getStr(record, 'nickname') ?? 'unknown' }))
    if (eligible.length === 0) return { status: 'skipped', reason: 'no_accounts' }
    const logs = await readList<CheckinLogRow>('checkin-logs.json')
    // 手动执行 = 强制检查全部符合条件账号（wbs run_checkin_all 语义）
    const due = manual ? eligible : dueAccounts(eligible, Date.now(), win, logs)
    if (!manual && win !== undefined && due.length === 0) return { status: 'skipped', reason: 'before_checkin_time' }
    let hadErrors = false
    const rows: unknown[] = []
    for (const entry of due) {
      const result = await checkinAccount(entry.record)
      if (result.result === 'success' || result.result === 'already') {
        await appendCheckinLog({ ts: Date.now(), accountId: entry.id, email: entry.displayName, variant: variantOf(entry.record), result: result.result })
      }
      if (result.result === 'error') hadErrors = true
      rows.push({ accountId: entry.id, email: entry.displayName, ...result })
    }
    await writeConfig('checkin-logs.json', normalizeCheckinLogs(logs))
    pushLog('info', `签到循环完成（${rows.length} 个账号）`)
    return { status: 'ok', accounts: rows, _hadErrors: hadErrors }
  } finally {
    cycleState.checkinBusy = false
  }
}

// ---------------------------------------------------------------- credits

export async function queryCredit(account: WbAccount): Promise<ReturnType<typeof creditResult> | { ok: false; accountId: string | null; accountName: string; error: string }> {
  const short = envelopeShortCircuit(account)
  if (short) return short
  const now = Date.now()
  const variant = variantOf(account)
  const refreshed = await ensureFreshToken(account, persistUpdated, 24)
  const target = findAccountIn(currentAccounts(), getStr(refreshed, 'id') ?? '') ?? refreshed
  const base = apiBaseFor(target)
  const origin = requestOrigin(base)
  const summaries: ResourceSummary[] = []
  let unauthorized = false
  const sourceErrors: string[] = []
  if (usesThreeEndpointQuery(variant)) {
    const endpoints = [
      { path: '/billing/meter/get-user-resource-summary', body: {} },
      { path: '/billing/meter/get-user-resource-paid-packages', body: { PageNumber: 1, PageSize: 200, Status: [0, 3], PackageCodes: PAID_PACKAGE_CODES, NeedRenewInfo: true } },
      { path: '/billing/meter/get-user-resource-free-packages', body: { PageNumber: 1, PageSize: 200, Status: [0, 3], PackageCodes: FREE_PACKAGE_CODES } },
    ]
    for (const endpoint of endpoints) {
      const response = (await fetchHttp(`${base}${endpoint.path}`, 'POST', endpoint.body, resourceAuthHeaders(target, origin, buildAuthHeaders))) as Record<string, unknown>
      if (isUnauthorized(response)) unauthorized = true
      const packages = extractNestedArray(response, 'Packages')
      if (Array.isArray(packages)) summaries.push(...packages.filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object').map((entry) => resourceSummary(entry, now)))
      else {
        const code = response['code']
        if (code !== 0 && code !== 200) sourceErrors.push(`${code ?? '?'}: ${String(response['msg'] ?? response['message'] ?? 'no data')}`)
      }
    }
    // 三个端点都报错时退回 legacy 端点
    if (summaries.length === 0 && sourceErrors.length > 0) {
      for (const path of legacyCreditCandidates(variant)) {
        const response = (await fetchHttp(`${base}${path}`, 'POST', { PageNumber: 1, PageSize: 100, ProductCode: 'p_tcaca', Status: [0, 3] }, resourceAuthHeaders(target, origin, buildAuthHeaders))) as Record<string, unknown>
        const accounts = extractNestedArray(response, 'Accounts')
        if (Array.isArray(accounts)) {
          summaries.push(...accounts.filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object').map((entry) => resourceSummary(entry, now)))
          break
        }
        if (response['code'] === 404) continue
        break
      }
    }
  } else {
    let response: Record<string, unknown> = {}
    for (const path of legacyCreditCandidates(variant)) {
      response = (await fetchHttp(`${base}${path}`, 'POST', { PageNumber: 1, PageSize: 100, ProductCode: 'p_tcaca', Status: [0, 3] }, resourceAuthHeaders(target, origin, buildAuthHeaders))) as Record<string, unknown>
      if (response['code'] === 404) continue
      break
    }
    if (isUnauthorized(response)) unauthorized = true
    const accounts = extractNestedArray(response, 'Accounts')
    if (Array.isArray(accounts)) summaries.push(...accounts.filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object').map((entry) => resourceSummary(entry, now)))
  }
  if (unauthorized && getStr(target, 'refresh_token')) {
    const result = await refreshAccountToken(target, persistUpdated)
    if (result.ok) return await queryCredit(result.account)
  }
  if (summaries.length === 0) {
    // 官方各资源端点都没有给出数据（如 20017 InternalError）——显示官方原因而不是误导性的 0
    const officialError = (sourceErrors[0] ?? '官方积分接口未返回数据').slice(0, 160)
    return { ok: false, accountId: getStr(target, 'id') ?? null, accountName: getStr(target, 'email') ?? getStr(target, 'nickname') ?? 'unknown', error: `官方接口暂不可用：${officialError}` }
  }
  return creditResult(target, mergeResources(summaries, []), Date.now())
}

function desktopSwitchDeps(): SwitchDeps {
  return {
    backup: (variant) => backupAuthFile(variant, AUTH_BACKUP_DIR),
    write: (account, variant) => writeAccountToAuthFile(account, variant),
    close: (variant, timeoutSecs) => closeWorkbuddy(variant, timeoutSecs),
    launch: (variant) => launchWorkbuddy(variant),
    isRunning: (variant) => isWorkbuddyRunning(variant),
  }
}

// ---------------------------------------------------------------- travel

interface TravelStatusResult {
  ok: boolean
  error?: string
  state?: string
  dailyLimitReached: boolean
  recordId?: number
  arriveAt?: number
  locationName?: string
  firstLocationId?: string | number
}

async function travelStatus(account: WbAccount): Promise<TravelStatusResult> {
  const base = GROWTH_WEB_BASE
  const headers = travelHeaders(account)
  const status = (await fetchHttp(`${base}${TRAVEL_PREFIX}/status`, 'GET', undefined, headers)) as Record<string, unknown>
  const statusCode = status['code']
  if (statusCode !== 0 && statusCode !== 200) {
    const message = typeof status['message'] === 'string' ? status['message'] : ''
    return { ok: false, error: `官方状态查询失败（code=${String(statusCode)}）${message}`.slice(0, 160), dailyLimitReached: false }
  }
  const data = (status['data'] ?? {}) as Record<string, unknown>
  const config = (await fetchHttp(`${base}${TRAVEL_PREFIX}/config`, 'GET', undefined, headers)) as Record<string, unknown>
  const configData = (config['data'] ?? {}) as Record<string, unknown>
  const locations = Array.isArray(configData['locations']) ? configData['locations'] : []
  const firstLocation = locations[0] as Record<string, unknown> | undefined
  return {
    ok: true,
    state: typeof data['state'] === 'string' ? data['state'] : undefined,
    dailyLimitReached: data['daily_limit_reached'] === true,
    ...(typeof data['record_id'] === 'number' ? { recordId: data['record_id'] } : {}),
    ...(typeof data['arrive_at'] === 'number' ? { arriveAt: data['arrive_at'] } : {}),
    ...(typeof data['location'] === 'object' && data['location'] !== null && typeof (data['location'] as Record<string, unknown>)['name'] === 'string' ? { locationName: (data['location'] as Record<string, unknown>)['name'] as string } : {}),
    ...(firstLocation && (typeof firstLocation['id'] === 'string' || typeof firstLocation['id'] === 'number') ? { firstLocationId: firstLocation['id'] } : {}),
  }
}

async function travelRequest(account: WbAccount, suffix: string, body: unknown): Promise<Record<string, unknown>> {
  return (await fetchHttp(`${GROWTH_WEB_BASE}${TRAVEL_PREFIX}${suffix}`, 'POST', body, travelHeaders(account))) as Record<string, unknown>
}

export async function travelCycle(mode: 'dispatch' | 'claim', manual = false): Promise<unknown> {
  const busyKey = mode === 'dispatch' ? 'travelBusy' : 'claimBusy'
  if (cycleState[busyKey]) return manual ? { status: 'skipped', reason: 'already_running' } : undefined
  const travelEnabled = (await readConfig<{ enabled?: boolean }>('travel-config.json', { enabled: false })).enabled === true
  if (!travelEnabled && !manual) return { status: 'disabled' }
  cycleState[busyKey] = true
  try {
    await loadAccounts()
    if (currentAccounts().length === 0) return { status: 'skipped', reason: 'no_accounts' }
    const today = new Date().toISOString().slice(0, 10)
    let cache = rollCacheToToday((await readJson<TravelCache>(dataFile('travel-cache.json'))) ?? { date: today, completed: false, results: {} }, today)
    const overlay: Record<string, TravelRecord> = {}
    const rows: Record<string, unknown>[] = []
    const rowOf = (account: WbAccount, outcome: string, extra: Record<string, unknown> = {}) => ({
      accountId: getStr(account, 'id'),
      name: getStr(account, 'email') ?? getStr(account, 'nickname') ?? 'unknown',
      outcome,
      ...extra,
    })
    for (const account of currentAccounts()) {
      const id = getStr(account, 'id') ?? ''
      if (!supportsTravel(variantOf(account))) {
        rows.push(rowOf(account, 'skipped', { reason: 'unsupported_variant' }))
        continue
      }
      if (isEnvelope(account, 'access_token')) {
        rows.push(rowOf(account, 'skipped', { reason: 'envelope_credentials' }))
        continue
      }
      const status = await travelStatus(account)
      if (!status.ok) {
        rows.push(rowOf(account, 'error', { error: status.error }))
        continue
      }
      if (status.state === 'traveling') {
        rows.push(rowOf(account, mode === 'dispatch' ? 'already-traveling' : 'waiting'))
        overlay[id] = { accountId: id, ok: true, state: 'traveling', at: Date.now(), ...(status.arriveAt !== undefined ? { arriveAt: status.arriveAt } : {}), ...(status.locationName !== undefined ? { locationName: status.locationName } : {}) }
      } else if (status.state === 'arrived') {
        if (mode !== 'claim') {
          rows.push(rowOf(account, 'arrived'))
        } else {
          const claim = await travelRequest(account, '/claim', status.recordId !== undefined ? { record_id: status.recordId } : {})
          if (claim['code'] === 0 || claim['code'] === 200) {
            overlay[id] = { accountId: id, ok: true, claimed: true, claimedAt: Date.now(), state: 'idle', at: Date.now() }
            rows.push(rowOf(account, 'claimed'))
          } else {
            rows.push(rowOf(account, 'error', { error: `领取失败（code=${String(claim['code'])}）` }))
          }
        }
      } else if (status.state === 'idle' && !status.dailyLimitReached && mode === 'dispatch') {
        const depart = await travelRequest(account, '/depart', { location_id: status.firstLocationId })
        if (depart['code'] === 0 || depart['code'] === 200) {
          overlay[id] = { accountId: id, ok: true, state: 'traveling', at: Date.now() }
          rows.push(rowOf(account, 'dispatched'))
        } else {
          // 无猫（含协议未同意）→ 同意协议 + 领养第一只（+300 积分），下一轮自动派出；
          // 领养门槛未达标（first_buddy 未完成）当日不再重试
          const message = typeof depart['message'] === 'string' ? depart['message'] : typeof depart['msg'] === 'string' ? depart['msg'] : ''
          if (classifyDepartError(typeof depart['code'] === 'number' ? depart['code'] : undefined, message) === 'no-buddy') {
            await fetchHttp(`${GROWTH_BUDDY_BASE}/agreement`, 'POST', { agree: true }, travelHeaders(account))
            const first = (await fetchHttp(`${GROWTH_BUDDY_BASE}/first`, 'POST', {}, travelHeaders(account))) as Record<string, unknown>
            const firstCode = first['code']
            if (firstCode === 0 || firstCode === 200) {
              overlay[id] = { accountId: id, ok: true, state: 'idle', at: Date.now(), message: '已领养 Buddy（+300 积分），下一轮自动派出' }
              rows.push(rowOf(account, 'adopted'))
            } else {
              rows.push(rowOf(account, 'adopt-skip', { reason: '领养门槛未达标（先完成活跃上报解锁 first_buddy）' }))
            }
          } else {
            rows.push(rowOf(account, 'error', { error: `派发失败（code=${String(depart['code'])}）` }))
          }
        }
      } else if (status.state === 'idle' && status.dailyLimitReached) {
        overlay[id] = { accountId: id, ok: true, claimed: true, skip: 'daily-limit', state: 'idle', message: '累了，明天再来吧', at: Date.now() }
        rows.push(rowOf(account, 'daily-limit'))
      } else if (status.state === 'idle') {
        rows.push(rowOf(account, mode === 'claim' ? 'idle' : 'no-action'))
      } else {
        rows.push(rowOf(account, 'error', { error: `未知状态 ${String(status.state)}` }))
      }
    }
    cache = mergeTravelCache(cache, overlay)
    await writeConfig('travel-cache.json', cache)
    pushLog('info', `旅行${mode === 'dispatch' ? '派发' : '领取'}：更新 ${Object.keys(overlay).length} 个账号`)
    return { status: 'ok', updated: Object.keys(overlay), accounts: rows }
  } finally {
    cycleState[busyKey] = false
  }
}

// ------------------------------------------------- 成长任务（活跃上报/连登/抽奖）

function growthHeaders(account: WbAccount): Record<string, string> {
  return { ...buildAuthHeaders(account), Accept: 'application/json', 'x-client-platform': 'web', Origin: GROWTH_WEB_BASE, Referer: `${GROWTH_WEB_BASE}/profile/growth-center` }
}

/**
 * 活跃上报（chat_request_send）：点亮连登 + 解锁领养前置任务。**必须用计费
 * 指纹**（单段 WorkBuddy UA、无 web 头）——web 指纹上报被服务端 200 静默丢弃
 * （wb 域 2026-10-13 实测：计费指纹 streak.days=1，web 指纹 days=0）。
 */
async function reportChatActivity(account: WbAccount): Promise<{ ok: boolean; error?: string }> {
  const uid = getStr(account, 'uid') ?? ''
  const now = nowMs()
  const conversationId = `wbdesk-${now}`
  const event = buildChatActivityEvent(uid, conversationId, now)
  const response = (await fetchHttp(`https://www.codebuddy.cn${REPORT_PATH}`, 'POST', [event], {
    ...buildAuthHeaders(account),
    Accept: 'application/json',
    'user-agent': 'WorkBuddy/5.5.2',
  })) as Record<string, unknown>
  const code = response['code']
  if (code === 0 || code === 200) return { ok: true }
  const message = typeof response['message'] === 'string' ? response['message'] : typeof response['msg'] === 'string' ? response['msg'] : ''
  return { ok: false, error: `code=${String(code ?? '?')} ${message}`.trim().slice(0, 160) }
}

/**
 * 成长任务巡检（幂等，每号每天一轮）：活跃上报（点亮连登）→ 连登档位兑换
 * （非 locked 非 claimed 即兑）→ 抽奖次数抽完。全部零对话消耗。
 */
export async function growthCycle(manual = false): Promise<unknown> {
  if (cycleState.growthBusy) return manual ? { status: 'skipped', reason: 'already_running' } : undefined
  cycleState.growthBusy = true
  try {
    await loadAccounts()
    if (currentAccounts().length === 0) return { status: 'skipped', reason: 'no_accounts' }
    const today = new Date().toISOString().slice(0, 10)
    const state = rollGrowthStateToToday(
      (await readJson<GrowthDayState>(dataFile('growth-state.json'))) ?? { date: today, reported: {}, checked: {} },
      today,
    )
    const rows: Record<string, unknown>[] = []
    for (const account of currentAccounts()) {
      const id = getStr(account, 'id') ?? ''
      const name = getStr(account, 'email') ?? getStr(account, 'nickname') ?? 'unknown'
      const row: Record<string, unknown> = { accountId: id, name, outcome: 'ok' }
      if (!supportsGrowth(variantOf(account))) {
        rows.push({ ...row, outcome: 'skipped', reason: 'unsupported_variant' })
        continue
      }
      if (isEnvelope(account, 'access_token')) {
        rows.push({ ...row, outcome: 'skipped', reason: 'envelope_credentials' })
        continue
      }
      // 1) 活跃上报（每号每天 1 次，日活跃奖励按天去重）
      if (!state.reported[id]) {
        const report = await reportChatActivity(account)
        if (report.ok) {
          state.reported[id] = true
          row.reported = true
        } else {
          row.outcome = 'error'
          row.error = `活跃上报失败：${report.error}`
        }
      } else {
        row.reported = 'done'
      }
      // 2) 连登档位兑换
      const streakResponse = (await fetchHttp(`${GROWTH_WEB_BASE}/activity/growth/streak`, 'GET', undefined, growthHeaders(account))) as Record<string, unknown>
      const streak = parseStreakFull(streakResponse?.data)
      row.streakDays = streak.days
      const redeemed: string[] = []
      for (const tier of redeemableTiers(streak)) {
        const redeem = (await fetchHttp(`${GROWTH_WEB_BASE}/activity/growth/redeem`, 'POST', { tier, client_token: randomUUID() }, growthHeaders(account))) as Record<string, unknown>
        const code = redeem['code']
        if (code === 0 || code === 200) redeemed.push(tier)
        else row.redeemNote = `${tier} 兑换未成功（code=${String(code ?? '?')}）`
      }
      if (redeemed.length > 0) row.redeemed = redeemed
      // 3) 抽奖（次数来自连登兑换，抽完为止）
      const lotteryResponse = (await fetchHttp(`${GROWTH_WEB_BASE}/activity/growth/lottery/summary`, 'GET', undefined, growthHeaders(account))) as Record<string, unknown>
      let chances = parseLotteryChances(lotteryResponse?.data)
      const prizes: string[] = []
      let draws = 0
      while (chances > 0 && draws < LOTTERY_DRAW_CAP) {
        const draw = (await fetchHttp(`${GROWTH_WEB_BASE}/activity/growth/lottery/draw`, 'POST', { client_token: randomUUID() }, growthHeaders(account))) as Record<string, unknown>
        draws += 1
        if (draw['code'] === 0 || draw['code'] === 200) {
          chances -= 1
          prizes.push(JSON.stringify(draw['data'] ?? {}).slice(0, 120))
        } else {
          break
        }
      }
      if (draws > 0) {
        row.draws = draws
        row.prizes = prizes
      }
      state.checked[id] = true
      rows.push(row)
    }
    await writeConfig('growth-state.json', state)
    const abnormal = rows.filter((row) => row.outcome === 'error').length
    pushLog(abnormal > 0 ? 'warn' : 'info', `成长任务巡检完成（${rows.length} 个账号，异常 ${abnormal}）`, { rows })
    return { status: 'ok', accounts: rows }
  } finally {
    cycleState.growthBusy = false
  }
}

export async function travelStatusPage(refresh: boolean): Promise<unknown> {
  await loadAccounts()
  const today = new Date().toISOString().slice(0, 10)
  let cache = rollCacheToToday((await readJson<TravelCache>(dataFile('travel-cache.json'))) ?? { date: today, completed: false, results: {} }, today)
  if (refresh) {
    const overlay: Record<string, TravelRecord> = {}
    for (const record of currentAccounts()) {
      const id = getStr(record, 'id') ?? ''
      if (!supportsTravel(variantOf(record)) || isEnvelope(record, 'access_token')) continue
      const status = await travelStatus(record)
      if (!status.ok) continue
      if (status.state === 'traveling' || status.state === 'arrived') {
        overlay[id] = { accountId: id, ok: true, state: status.state, at: Date.now(), ...(status.arriveAt !== undefined ? { arriveAt: status.arriveAt } : {}), ...(status.locationName !== undefined ? { locationName: status.locationName } : {}) }
      }
    }
    cache = mergeTravelCache(cache, overlay)
    await writeConfig('travel-cache.json', cache)
  }
  return {
    enabled: (await readConfig<{ enabled?: boolean }>('travel-config.json', { enabled: false })).enabled === true,
    accounts: currentAccounts().map((record) => {
      const id = getStr(record, 'id') ?? ''
      const cached = cache.results[id]
      return {
        id,
        name: getStr(record, 'email') ?? getStr(record, 'nickname') ?? 'unknown',
        label: travelDisplayLabel(variantOf(record), cache, id, today),
        locationName: cached?.locationName ?? null,
      }
    }),
  }
}

// ------------------------------------------------------------- keepalive

export async function keepaliveDaily(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10)
  if (lastKeepaliveDay === today) return
  lastKeepaliveDay = today
  await loadAccounts()
  const config = await readConfig<CheckinConfig>('checkin-config.json', defaultCheckinConfig(false))
  const result = await runKeepaliveCycle(currentAccounts(), { keepaliveDays: config.keepalive_days }, persistUpdated)
  pushLog('info', '保活完成', result)
}

// ---------------------------------------------------------- account ops

async function persistUpdated(updated: WbAccount): Promise<void> {
  const index = currentAccounts().findIndex((entry) => getStr(entry, 'id') === getStr(updated, 'id'))
  if (index >= 0) currentAccounts()[index] = updated
  await persistAccounts()
}

export async function importLocal(variant: 'cn' | 'ai'): Promise<unknown> {
  await loadAccounts()
  const collected = await importFromAuthFile(variant)
  if (!collected) throw new Error('未读取到本地 WorkBuddy 登录信息')
  const saved = upsertCollectedAccount(currentAccounts(), collected)
  await persistAccounts()
  return { account: accountMeta(saved) }
}

export async function removeAccount(accountId: string): Promise<boolean> {
  await loadAccounts()
  const ok = deleteAccountFrom(currentAccounts(), accountId)
  if (ok) await persistAccounts()
  return ok
}

export async function switchTo(accountId: string, restart: boolean): Promise<unknown> {
  await loadAccounts()
  return await switchAccount(currentAccounts(), accountId, { backupDir: AUTH_BACKUP_DIR, restart }, desktopSwitchDeps(), (message) => pushLog('info', message))
}

export async function refreshOne(accountId: string): Promise<unknown> {
  await loadAccounts()
  const account = findAccountIn(currentAccounts(), accountId)
  if (!account) throw new Error('账号不存在')
  const result = await refreshAccountToken(account, persistUpdated)
  return { ok: result.ok, error: result.error, account: accountMeta(result.account) }
}

export { accountMeta, listAt as listErrorLog, dataFile, atomicWriteJson, buildAccountObj, buildAuthObj, isPlainObject }
