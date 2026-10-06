/**
 * 裂缝观测中断补录的领域模型。
 *
 * 设计口径（人工补录 vs 自动速率冲突时）：
 * - 中断缺口期间设备侧可能产生「自动估值」，它只作参考，永远不填补观测缺口；
 * - 人工补录的实测值一旦提交，同日期的自动估值标记为「已被人工补录替代」，保留留痕但不参与计算；
 * - 变化速率以人工补录值为准整段重算，并在来源上标注「补录重算」，与常规「自动计算」区分。
 *
 * 「不能把空白当正常值」：缺口日期必须明确给出数值或勾选「当日无法量测」，
 * 未明确的空值直接判校验失败，不会写入任何观测记录。
 */

/** 观测数据来源 */
export type ObservationSource = '人工观测' | '自动采集' | '自动估值' | '人工补录'

/** 观测记录的判定状态：正常值 / 异常值（突变量过大）/ 缺失（明确无法量测） */
export type ObservationStatus = '正常' | '异常值' | '缺失'

/** 速率口径 */
export type RateSource = '自动计算' | '补录重算'

export type CrackObservation = {
  id: number
  测点编号: string
  观测日期: string
  /** 裂缝宽度，单位 mm；缺失记录为 null，表达「当日无法量测」，不能按 0 处理 */
  宽度: number | null
  速率: number | null
  速率口径: RateSource | null
  来源: ObservationSource
  状态: ObservationStatus
  监测人: string
  异常说明: string
  备注: string
  /** 中断缺口期间设备产生的估值，被人工补录替代后置灰留痕 */
  已被补录替代: boolean
  更新时间: string
}

export type BackfillTaskStatus = '待补录' | '补录失败' | '已补录' | '已放弃'

export type BackfillTask = {
  id: number
  测点编号: string
  缺口开始: string
  缺口结束: string
  缺口天数: number
  状态: BackfillTaskStatus
  失败原因: string
  尝试次数: number
  放弃原因: string
  创建时间: string
  更新时间: string
  /** 放弃后重新补录会挂回这条任务，沿用原始缺口编号 */
  关联任务: number | null
  补录人: string
}

/** 补录表单单日条目 */
export type BackfillEntryInput = {
  date: string
  width: string
  unmeasurable: boolean
  abnormalConfirmed: boolean
  remark: string
}

/** 缺口期间的设备自动估值 */
export type AutoEstimate = {
  date: string
  width: number
  rate: number
}

export type GapSummary = {
  start: string
  end: string
  days: number
  dates: string[]
  /** 缺口期间设备给出的自动估值（仅供参考，不补缺口） */
  autoEstimates: AutoEstimate[]
  /** 缺口前最后一条实测，用于提示突变 */
  lastMeasuredWidth: number | null
}

export type PointHistory = {
  pointId: number
  code: string
  initialWidth: number | null
  initialWidthMissing: boolean
  observations: CrackObservation[]
  gaps: GapSummary[]
  activeTask: BackfillTask | null
  tasks: BackfillTask[]
}
