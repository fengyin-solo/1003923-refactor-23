/**
 * 裂缝观测中断补录的服务层：缺口计算、补录任务流转、整批事务提交。
 * 所有写操作都走这里，保证「失败不留半条、重复提交只保留一次、补录完成生成复查事项」。
 */
import {
  listDomain,
  listRows,
  nextDomainId,
  saveDomain,
  saveRows,
} from '@/data/local-store'
import type {
  AutoEstimate,
  BackfillEntryInput,
  BackfillTask,
  CrackObservation,
  GapSummary,
  PointHistory,
} from '@/data/crack-backfill'
import type { ActionResult, EntryRow } from '@/data/types'

// 单日宽度突变超过该差值（mm）时，必须人工勾选「异常确认」，否则整批判失败。
const ABNORMAL_DELTA = 0.5
const DAY_MS = 86400000

// 防止同一条任务在一次会话里被并发重复提交。
const submitting = new Set<number>()

function nowIso(): string {
  return new Date().toISOString()
}

function today(): string {
  return nowIso().slice(0, 10)
}

function addDays(date: string, delta: number): string {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() + delta * DAY_MS)
    .toISOString()
    .slice(0, 10)
}

function enumerateDates(start: string, end: string): string[] {
  const dates: string[] = []
  for (let cursor = start; cursor <= end; cursor = addDays(cursor, 1)) {
    dates.push(cursor)
  }
  return dates
}

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || String(value).trim() === '') {
    return null
  }
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

function cloneTasks(): BackfillTask[] {
  return listDomain('crack_backfill_tasks').map((item) => ({ ...item }))
}

function cloneObservations(): CrackObservation[] {
  return listDomain('crack_observations').map((item) => ({ ...item }))
}

function getPointRow(pointId: number): EntryRow | undefined {
  return listRows('crack').find((row) => Number(row.id) === pointId)
}

function findPointByCode(code: string): EntryRow | undefined {
  return listRows('crack').find((row) => String(row['测点编号']) === code)
}

/** 缺口：首尾实测之间，连续没有任何实测/缺失结论的日期；只有自动估值的日期仍算缺口。 */
export function computeGaps(observations: CrackObservation[]): GapSummary[] {
  const real = observations
    .filter((item) => item.来源 !== '自动估值')
    .sort((a, b) => a.观测日期.localeCompare(b.观测日期))
  if (real.length < 2) {
    return []
  }
  const estimateByDate = new Map<string, AutoEstimate>()
  for (const item of observations) {
    if (item.来源 === '自动估值' && item.宽度 !== null) {
      estimateByDate.set(item.观测日期, {
        date: item.观测日期,
        width: item.宽度,
        rate: item.速率 ?? 0,
      })
    }
  }

  const gaps: GapSummary[] = []
  let cursor = real[0].观测日期
  const lastDate = real[real.length - 1].观测日期
  let lastMeasuredWidth: number | null = real[0].宽度
  let run: string[] = []

  const flush = () => {
    if (run.length === 0) {
      return
    }
    gaps.push({
      start: run[0],
      end: run[run.length - 1],
      days: run.length,
      dates: run,
      autoEstimates: run
        .map((date) => estimateByDate.get(date))
        .filter((item): item is AutoEstimate => Boolean(item)),
      lastMeasuredWidth,
    })
    run = []
  }

  const realByDate = new Map(real.map((item) => [item.观测日期, item]))
  while (cursor <= lastDate) {
    const todayRecord = realByDate.get(cursor)
    if (!todayRecord) {
      run.push(cursor)
    } else {
      flush()
      if (todayRecord.宽度 !== null) {
        lastMeasuredWidth = todayRecord.宽度
      }
    }
    cursor = addDays(cursor, 1)
  }
  flush()
  return gaps
}

export function getPointHistory(pointId: number): PointHistory | null {
  const point = getPointRow(pointId)
  if (!point) {
    return null
  }
  const code = String(point['测点编号'])
  const observations = cloneObservations()
    .filter((item) => item.测点编号 === code)
    .sort((a, b) => a.观测日期.localeCompare(b.观测日期))
  const tasks = cloneTasks()
    .filter((item) => item.测点编号 === code)
    .sort((a, b) => b.id - a.id)
  const initialWidth = toNumberOrNull(point['初始宽度'])
  return {
    pointId,
    code,
    initialWidth,
    initialWidthMissing: initialWidth === null,
    observations,
    gaps: computeGaps(observations),
    activeTask: tasks.find((item) => item.状态 === '待补录' || item.状态 === '补录失败') ?? null,
    tasks,
  }
}

export type CrackPointView = {
  id: number
  row: EntryRow
  initialWidth: number | null
  initialWidthMissing: boolean
  latestWidth: number | null
  latestRate: number | null
  rateSource: CrackObservation['速率口径'] | null
  gapDays: number
  activeTask: BackfillTask | null
}

export function listCrackPoints(): CrackPointView[] {
  return listRows('crack').map((row) => {
    const history = getPointHistory(Number(row.id))
    const measured = (history?.observations ?? [])
      .filter((item) => item.来源 !== '自动估值' && item.宽度 !== null)
      .sort((a, b) => a.观测日期.localeCompare(b.观测日期))
    const latest = measured[measured.length - 1] ?? null
    return {
      id: Number(row.id),
      row,
      initialWidth: history?.initialWidth ?? null,
      initialWidthMissing: history?.initialWidthMissing ?? true,
      latestWidth: latest?.宽度 ?? null,
      latestRate: latest?.速率 ?? null,
      rateSource: latest?.速率口径 ?? null,
      gapDays: (history?.gaps ?? []).reduce((sum, gap) => sum + gap.days, 0),
      activeTask: history?.activeTask ?? null,
    }
  })
}

/** 从缺口生成补录任务；已有待办任务时直接返回，保证一个缺口只有一条任务。 */
export function startBackfill(pointId: number): ActionResult & { taskId?: number } {
  const history = getPointHistory(pointId)
  if (!history) {
    return { ok: false, message: '没有找到该裂缝测点' }
  }
  if (history.activeTask) {
    return { ok: true, message: '该测点已有待补录任务', taskId: history.activeTask.id }
  }
  const gap = history.gaps[0]
  if (!gap) {
    return { ok: false, message: '该测点当前没有观测缺口，无需补录' }
  }
  const tasks = cloneTasks()
  const task: BackfillTask = {
    id: nextDomainId('crack_backfill_tasks'),
    测点编号: history.code,
    缺口开始: gap.start,
    缺口结束: gap.end,
    缺口天数: gap.days,
    状态: '待补录',
    失败原因: '',
    尝试次数: 0,
    放弃原因: '',
    创建时间: nowIso(),
    更新时间: nowIso(),
    关联任务: null,
    补录人: '',
  }
  tasks.push(task)
  saveDomain('crack_backfill_tasks', tasks)
  return { ok: true, message: '已生成补录任务', taskId: task.id }
}

export function reopenBackfill(taskId: number): ActionResult {
  const tasks = cloneTasks()
  const task = tasks.find((item) => item.id === taskId)
  if (!task) {
    return { ok: false, message: `没有找到编号为 ${taskId} 的补录任务` }
  }
  if (task.状态 !== '已放弃') {
    return { ok: false, message: '只有已放弃的补录任务才能重新进入' }
  }
  task.状态 = '待补录'
  task.失败原因 = ''
  task.更新时间 = nowIso()
  saveDomain('crack_backfill_tasks', tasks)
  return { ok: true, message: '已重新进入补录，仍只需补齐原缺口时段' }
}

export function abandonBackfill(taskId: number, reason: string): ActionResult {
  const trimmed = reason.trim()
  if (!trimmed) {
    return { ok: false, message: '放弃补录必须填写原因，便于后续追溯' }
  }
  const tasks = cloneTasks()
  const task = tasks.find((item) => item.id === taskId)
  if (!task) {
    return { ok: false, message: `没有找到编号为 ${taskId} 的补录任务` }
  }
  if (task.状态 === '已补录') {
    return { ok: false, message: '该缺口已补录完成，不能放弃' }
  }
  task.状态 = '已放弃'
  task.放弃原因 = trimmed
  task.失败原因 = ''
  task.更新时间 = nowIso()
  saveDomain('crack_backfill_tasks', tasks)
  return { ok: true, message: '已放弃本次补录，缺口保留，可稍后重新进入补录' }
}

type ValidatedEntry = {
  date: string
  width: number | null
  abnormalConfirmed: boolean
  remark: string
}

/**
 * 整批提交：先把全部缺口日期校验完，任一条不通过就只回写失败原因、不写任何观测。
 * 重复提交由任务状态与在途标记双重拦截。
 */
export function submitBackfill(
  taskId: number,
  inputs: BackfillEntryInput[],
  operator: string,
): ActionResult {
  if (submitting.has(taskId)) {
    return { ok: false, message: '补录正在提交中，请勿重复点击；同一缺口只保留一次补录' }
  }
  const tasks = cloneTasks()
  const task = tasks.find((item) => item.id === taskId)
  if (!task) {
    return { ok: false, message: `没有找到编号为 ${taskId} 的补录任务` }
  }
  if (task.状态 === '已补录') {
    return { ok: false, message: '该缺口已完成补录，重复提交只保留一次' }
  }
  if (task.状态 === '已放弃') {
    return { ok: false, message: '任务已放弃，请先重新进入补录' }
  }

  const history = getPointHistory(findPointByCode(task.测点编号)?.id ?? -1)
  const expectedDates = enumerateDates(task.缺口开始, task.缺口结束)
  const inputByDate = new Map(inputs.map((item) => [item.date, item]))

  const errors: string[] = []
  if (inputs.length !== expectedDates.length) {
    errors.push(`本次只能补录缺口时段 ${task.缺口开始} 至 ${task.缺口结束}，共 ${task.缺口天数} 天`)
  }

  // 校验阶段的「前一实测宽度」：取缺口前最后一条实测，再逐日推进。
  const taskGap = history?.gaps.find(
    (gap) => gap.start === task.缺口开始 && gap.end === task.缺口结束,
  )
  let previous = taskGap?.lastMeasuredWidth ?? null
  const validated: ValidatedEntry[] = []

  for (const date of expectedDates) {
    const input = inputByDate.get(date)
    if (!input) {
      errors.push(`${date} 缺少补录条目`)
      continue
    }
    const rawWidth = input.width.trim()
    if (input.unmeasurable) {
      if (rawWidth !== '') {
        errors.push(`${date} 已勾选当日无法量测，不能再填写宽度数值`)
        continue
      }
      validated.push({ date, width: null, abnormalConfirmed: false, remark: input.remark.trim() })
      continue
    }
    if (rawWidth === '') {
      errors.push(
        `${date} 补录宽度为空白：空白不能按正常值入库，请填写实测宽度，或勾选「当日无法量测」`,
      )
      continue
    }
    const width = Number(rawWidth)
    if (!Number.isFinite(width) || width < 0) {
      errors.push(`${date} 宽度「${rawWidth}」不是有效的非负数值`)
      continue
    }
    if (previous !== null && Math.abs(width - previous) > ABNORMAL_DELTA) {
      if (!input.abnormalConfirmed) {
        errors.push(
          `${date} 填报宽度 ${width}mm，较前次实测 ${previous}mm 突变 ${Number(
            Math.abs(width - previous).toFixed(2),
          )}mm，超过异常阈值 ${ABNORMAL_DELTA}mm，需核对后勾选「确认异常突变」`,
        )
        continue
      }
    }
    validated.push({
      date,
      width,
      abnormalConfirmed: input.abnormalConfirmed,
      remark: input.remark.trim(),
    })
    previous = width
  }

  if (errors.length > 0) {
    task.状态 = '补录失败'
    task.尝试次数 += 1
    task.失败原因 = errors.join('；')
    task.更新时间 = nowIso()
    saveDomain('crack_backfill_tasks', tasks)
    return {
      ok: false,
      message: `补录未通过校验，整批未写入（第 ${task.尝试次数} 次）：${task.失败原因}`,
    }
  }

  submitting.add(taskId)
  try {
    persistBackfill(task, validated, operator)
    return {
      ok: true,
      message: `缺口 ${task.缺口开始} 至 ${task.缺口结束} 已补录 ${validated.length} 天，并已生成一条巡查复查事项`,
    }
  } finally {
    submitting.delete(taskId)
  }
}

function persistBackfill(task: BackfillTask, entries: ValidatedEntry[], operator: string): void {
  const observations = cloneObservations()
  const point = findPointByCode(task.测点编号)

  // 幂等兜底：同日期已存在人工补录记录时拒绝再写（正常由任务状态拦截，这里防绕过）。
  const existed = new Set(
    observations
      .filter((item) => item.来源 === '人工补录')
      .map((item) => `${item.测点编号}@${item.观测日期}`),
  )
  for (const entry of entries) {
    if (existed.has(`${task.测点编号}@${entry.date}`)) {
      throw new Error(`${entry.date} 已存在补录记录，重复提交只保留一次`)
    }
  }

  // 1) 缺口期间的设备自动估值一律标记为已被替代（含当日确认无法量测的情形：估值不成立）。
  const gapDates = new Set(enumerateDates(task.缺口开始, task.缺口结束))
  for (const item of observations) {
    if (item.测点编号 === task.测点编号 && item.来源 === '自动估值' && gapDates.has(item.观测日期)) {
      item.已被补录替代 = true
      item.备注 = entryRemark(entries, item.观测日期)
        ? `已被人工补录替代；${entryRemark(entries, item.观测日期)}`
        : '已被人工补录替代，自动估值不再参与计算'
    }
  }

  // 2) 写入人工补录观测；缺失（当日无法量测）用 null 明确表达，绝不落成 0。
  for (const entry of entries) {
    const abnormal =
      entry.width !== null &&
      entry.abnormalConfirmed
    observations.push({
      id: nextDomainId('crack_observations'),
      测点编号: task.测点编号,
      观测日期: entry.date,
      宽度: entry.width,
      速率: null,
      速率口径: null,
      来源: '人工补录',
      状态: entry.width === null ? '缺失' : abnormal ? '异常值' : '正常',
      监测人: entry.width === null ? operator : operator,
      异常说明: abnormal ? '补录宽度较前次实测突变，已经人工确认留档' : '',
      备注:
        entry.width === null
          ? `补录确认当日无法量测${entry.remark ? `：${entry.remark}` : ''}`
          : entry.remark,
      已被补录替代: false,
      更新时间: nowIso(),
    })
  }

  // 3) 以人工补录值为准整段重算速率；数值发生变化的记录标注「补录重算」。
  recomputeRates(observations, task.测点编号, point ? toNumberOrNull(point['初始宽度']) : null)

  // 4) 回写测点当前宽度、速率与状态（统一在最后落盘，避免与观测序列写成半成品）。
  if (point) {
    const mine = observations
      .filter((item) => item.测点编号 === task.测点编号 && item.来源 !== '自动估值')
      .sort((a, b) => a.观测日期.localeCompare(b.观测日期))
    const measured = mine.filter((item) => item.宽度 !== null)
    const latest = measured[measured.length - 1]
    point['当前宽度'] = latest?.宽度 ?? null
    point['变化速率'] = latest?.速率 ?? null
    const rate = latest?.速率 ?? 0
    if (point.status !== '已修复' && point.status !== '已废弃') {
      point.status = rate >= 0.4 ? '加速发展' : rate <= 0.05 ? '趋于稳定' : '正常'
      point.abnormal = point.status === '加速发展'
    }
    point['测点状态'] = point.status
    point.pending = point.status !== '已废弃' && point.status !== '已修复'
  }

  // 5) 任务收尾。
  const tasks = cloneTasks()
  const target = tasks.find((item) => item.id === task.id)
  if (target) {
    target.状态 = '已补录'
    target.失败原因 = ''
    target.补录人 = operator
    target.更新时间 = nowIso()
  }

  // 统一提交：观测序列、任务、测点依次落盘，全部成功后才生成巡查复查事项。
  saveDomain('crack_observations', observations)
  if (target) {
    saveDomain('crack_backfill_tasks', tasks)
  }
  if (point) {
    saveRows('crack', listRows('crack'))
  }

  // 6) 巡查排查生成复查事项（按任务幂等，重复提交只生成一条）。
  ensureReviewItem(task, operator)
}

function entryRemark(entries: ValidatedEntry[], date: string): string {
  return entries.find((item) => item.date === date)?.remark ?? ''
}

function recomputeRates(
  observations: CrackObservation[],
  code: string,
  initialWidth: number | null,
): void {
  const mine = observations
    .filter((item) => item.测点编号 === code && item.来源 !== '自动估值')
    .sort((a, b) => a.观测日期.localeCompare(b.观测日期))
  // 旧记录初始宽度缺失按未测兼容：没有对标基线时，首条实测速率留空。
  let previous = initialWidth
  for (const item of mine) {
    if (item.宽度 === null) {
      item.速率 = null
      item.速率口径 = null
      continue
    }
    if (previous === null) {
      item.速率 = null
      item.速率口径 = null
    } else {
      const nextRate = Number((item.宽度 - previous).toFixed(2))
      if (item.来源 === '人工补录' || item.速率 !== nextRate) {
        item.速率口径 = '补录重算'
      }
      item.速率 = nextRate
    }
    previous = item.宽度
  }
}

function ensureReviewItem(task: BackfillTask, operator: string): void {
  const rows = listRows('patrol')
  if (rows.some((row) => String(row['关联补录任务']) === String(task.id))) {
    return
  }
  const point = findPointByCode(task.测点编号)
  const id = rows.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1
  rows.push({
    id,
    status: '待复查',
    pending: true,
    abnormal: false,
    巡查编号: `REV-${String(id).padStart(4, '0')}`,
    隐患点编号: point ? String(point['隐患点编号']) : '—',
    巡查日期: today(),
    巡查人员: operator,
    巡查范围: `裂缝测点 ${task.测点编号}（缺口 ${task.缺口开始}~${task.缺口结束}）补录复查`,
    发现异常: `补录完成后需现场复核：核对补录宽度、确认自动估值已停用、回看补录重算速率`,
    处置措施: '',
    巡查状态: '待复查',
    任务类型: '补录复查',
    关联补录任务: task.id,
  })
  saveRows('patrol', rows)
}
