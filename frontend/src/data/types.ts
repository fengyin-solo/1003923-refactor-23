/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

// 裂缝观测中断补录：缺口时段里的一天，只可能是「还没补」或「已放弃（可重试）」。
export type BackfillSlot = {
  date: string
  state: '待补录' | '已放弃'
  reason: string
}

// 从待补录重新进入时拿到的补录边界：只含缺口时段，不含已落定的日期。
export type BackfillPlan = {
  pointId: number
  pointCode: string
  hazardCode: string
  crackCode: string
  gapStart: string
  gapEnd: string
  slots: BackfillSlot[]
}

// 历史观测按空态 / 正常 / 异常值 / 缺失记录分开呈现。
export type ObservationHistory = {
  total: number
  normal: EntryRow[]
  abnormal: EntryRow[]
  missing: EntryRow[]
}
