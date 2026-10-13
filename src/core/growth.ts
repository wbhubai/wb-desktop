/**
 * 成长中心收益自动化：对话活跃上报 + 连登档位兑换 + 抽奖（零对话消耗）。
 * growth 域（/activity/growth/*）与猫猫旅行同域同指纹（www.codebuddy.cn +
 * web 头）；活跃上报走 billing 指纹（WorkBuddy/<ver> 单段 UA、无 web 头）——
 * web 指纹上报会被服务端 200 静默丢弃（wb 域 2026-10-13 实测：计费指纹点亮
 * streak.days=1，web 指纹 days=0）。机制逆向来源：workbuddy2api-panel。
 * HTTP 注入，纯函数可单测。
 */
import type { WbVariant } from './variant.ts'

export const GROWTH_API_PREFIX = '/activity/growth'
export const REPORT_PATH = '/v2/report'
/** 抽奖保护上限：chances 异常时不再无限抽 */
export const LOTTERY_DRAW_CAP = 20

// ------------------------------------------------------------- 活跃上报事件

export interface ChatActivityEvent {
  eventCode: 'chat_request_send'
  timestamp: number
  reportDelay: number
  mode: string
  conversationId: string
  requestId: string
  inputLength: number
  requestModelId: string
  requestModelName: string
  isPlan: boolean
  isAutoExecuteTerminal: boolean
  isAutoModify: boolean
  codebaseEnable: boolean
  maxToken: number
  maxSteps: number
  temperature: number
  maxRetries: number
  mentionContexts: unknown[]
  knowledgeId: unknown[]
  knowledgeName: unknown[]
  codebaseId: string
  mentionContextCount: number
  command: string
  expertId: string
  recommendId: string
  skillId: string
  skillCount: number
  totalCount: number
  fileUri: string
  presentAt: number
  traceId: string
  rootRequestId: string
  parentConversationId: string
  agentName: string
  agentType: string
  userId: string
}

/** 照抄客户端 chat_request_send 事件完整形状（勿用最小 3 字段，防上游加严）。 */
export function buildChatActivityEvent(userId: string, conversationId: string, now: number): ChatActivityEvent {
  return {
    eventCode: 'chat_request_send',
    timestamp: now,
    reportDelay: 0,
    mode: 'craft',
    conversationId,
    requestId: conversationId,
    inputLength: 12,
    requestModelId: 'deepseek-v4-flash',
    requestModelName: 'DeepSeek V4 Flash',
    isPlan: false,
    isAutoExecuteTerminal: false,
    isAutoModify: false,
    codebaseEnable: false,
    maxToken: 0,
    maxSteps: 0,
    temperature: 0,
    maxRetries: 0,
    mentionContexts: [],
    knowledgeId: [],
    knowledgeName: [],
    codebaseId: '',
    mentionContextCount: 0,
    command: '',
    expertId: '',
    recommendId: '',
    skillId: '',
    skillCount: 0,
    totalCount: 0,
    fileUri: '',
    presentAt: now,
    traceId: '',
    rootRequestId: conversationId,
    parentConversationId: conversationId,
    agentName: 'default',
    agentType: 'conversation',
    userId,
  }
}

// ------------------------------------------------------------- 连登状态解析

export interface StreakTier {
  tier: string
  /** locked=未解锁；其余（unclaimed/claimed 等）见官方；unclaimed 即可兑换 */
  status: string
}

export interface StreakFull {
  /** 连登天数；0 且已上报 = 上游静默丢弃的告警信号 */
  days: number
  tiers: StreakTier[]
}

/** 解析 GET /activity/growth/streak 的 data（纯函数）。 */
export function parseStreakFull(data: unknown): StreakFull {
  const source = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>
  const streak = (source.streak && typeof source.streak === 'object' ? source.streak : {}) as Record<string, unknown>
  const redemption = (source.redemption_status && typeof source.redemption_status === 'object' ? source.redemption_status : {}) as Record<string, unknown>
  const tiers: StreakTier[] = []
  for (const raw of Array.isArray(redemption.tiers) ? (redemption.tiers as Record<string, unknown>[]) : []) {
    const tier = typeof raw.tier === 'string' ? raw.tier : ''
    const status = typeof raw.status === 'string' ? raw.status : ''
    if (tier !== '' && status !== '') tiers.push({ tier, status })
  }
  return { days: typeof streak.days === 'number' ? streak.days : 0, tiers }
}

/** 可兑换档位：官方语义为「非 locked 且非 claimed」；未知状态保守跳过。 */
export function redeemableTiers(streak: StreakFull): string[] {
  return streak.tiers
    .filter((tier) => tier.status !== 'locked' && tier.status !== 'claimed')
    .map((tier) => tier.tier)
}

/** 解析 GET /activity/growth/lottery/summary 的 data（纯函数）。 */
export function parseLotteryChances(data: unknown): number {
  const source = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>
  return typeof source.chances === 'number' && Number.isFinite(source.chances) ? Math.max(0, Math.floor(source.chances)) : 0
}

// ------------------------------------------------------------- 循环编排状态

export interface GrowthDayState {
  date: string
  /** 已活跃上报的账号 id（每号每天 1 次） */
  reported: Record<string, boolean>
  /** 已完成连登兑换/抽奖巡检的账号 id（巡检幂等，标记防重复打日志） */
  checked: Record<string, boolean>
}

export function rollGrowthStateToToday(state: GrowthDayState, today: string): GrowthDayState {
  if (state.date === today) return state
  return { date: today, reported: {}, checked: {} }
}

/** 成长体系仅个人账号参与（与猫猫旅行同口径：ai 版跳过）。 */
export function supportsGrowth(variant: WbVariant): boolean {
  return variant === 'cn'
}
