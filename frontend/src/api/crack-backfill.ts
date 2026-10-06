import { listRows, saveModules } from '@/data/local-store'
import type {
  ActionResult,
  BackfillPlan,
  BackfillSlot,
  EntryRow,
  ObservationHistory,
} from '@/data/types'

// 裂缝观测中断后的补录边界。
//
// 口径（人工补录与自动速率冲突时按此执行）：
// 1. 观测日志按（测点编号, 观测日期）唯一，同一日期的人工补录覆盖自动采集记录；
// 2. 变化速率只由带日期的有效观测（正常值与异常值）重算，缺失记录不参与；
// 3. 初始宽度是登记属性、没有观测日期，不参与速率推算；旧记录缺初始宽度按「未测」兼容；
// 4. 空白不能当正常值：宽度必填且为合理数值，放弃补测必须填写失败原因；
// 5. 缺口全部落定后一次性恢复测点并生成巡查复查事项，重复提交与复查事项都按补录批次去重，
//    任一步失败都不会留下半条补录状态。
export const CRACK_OBS_KEY = 'crack_obs'

const POINT_KEY = 'crack'
const PATROL_KEY = 'patrol'
const STATUS_BACKFILL = '待补录'
const STATUS_NORMAL = '正常'
const OBS_MISSING = '缺失'
const OBS_ABNORMAL = '异常值'
const OBS_NORMAL = '正常'
const SOURCE_MANUAL = '人工补录'
const SOURCE_ABANDONED = '放弃补测'
const UNMEASURED = '未测'
// 日变化超过该阈值仍接收，但标记为异常值单独呈现
const ABNORMAL_JUMP_MM_PER_DAY = 5
const MAX_WIDTH_MM = 1000
// 单次补录最多开放的缺口天数，超出部分处理完这一批再续
const MAX_GAP_DAYS = 31
const DAY_MS = 24 * 60 * 60 * 1000

function today(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

function parseDay(day: string): number {
  const [year, month, date] = day.split('-').map(Number)
  return Date.UTC(year, month - 1, date)
}

function formatDay(time: number): string {
  const date = new Date(time)
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  return `${date.getUTCFullYear()}-${month}-${day}`
}

function eachDay(start: string, end: string): string[] {
  const days: string[] = []
  for (let time = parseDay(start); time <= parseDay(end); time += DAY_MS) {
    days.push(formatDay(time))
  }
  return days
}

function diffDays(start: string, end: string): number {
  return Math.round((parseDay(end) - parseDay(start)) / DAY_MS)
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function findPoint(pointId: number): EntryRow | undefined {
  return listRows(POINT_KEY).find((row) => Number(row.id) === pointId)
}

function pointObservations(obsRows: EntryRow[], pointCode: string): EntryRow[] {
  return obsRows.filter((row) => String(row['测点编号']) === pointCode)
}

function batchId(point: EntryRow): string {
  return `BACKFILL-${String(point['测点编号'])}-${String(point['中断日期'] ?? '')}`
}

// 缺口起点：优先用标记中断时记下的中断日期；缺中断日期的半状态从最后一条观测次日自愈。
function gapStartDate(point: EntryRow, obsRows: EntryRow[]): string {
  const marked = String(point['中断日期'] ?? '')
  if (/^\d{4}-\d{2}-\d{2}$/.test(marked) && marked <= today()) {
    return marked
  }
  const dates = pointObservations(obsRows, String(point['测点编号']))
    .map((row) => String(row['观测日期']))
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))
    .sort()
  const last = dates[dates.length - 1]
  return last ? formatDay(parseDay(last) + DAY_MS) : today()
}

// 缺口时段：中断日起到今天为止、还没有任何观测记录的日期，一次最多 MAX_GAP_DAYS 天。
function gapDates(point: EntryRow, obsRows: EntryRow[]): string[] {
  const start = gapStartDate(point, obsRows)
  const end = today()
  if (start > end) {
    return []
  }
  const recorded = new Set(
    pointObservations(obsRows, String(point['测点编号'])).map((row) => String(row['观测日期'])),
  )
  return eachDay(start, end)
    .filter((date) => !recorded.has(date))
    .slice(0, MAX_GAP_DAYS)
}

export function observationHistoryFor(pointCode: string): ObservationHistory {
  const rows = pointObservations(listRows(CRACK_OBS_KEY), pointCode).sort((a, b) =>
    String(b['观测日期']).localeCompare(String(a['观测日期'])),
  )
  return {
    total: rows.length,
    normal: rows.filter((row) => row.status === OBS_NORMAL),
    abnormal: rows.filter((row) => row.status === OBS_ABNORMAL),
    missing: rows.filter((row) => row.status === OBS_MISSING),
  }
}

// 从待补录重新进入：只返回缺口时段里还没落定的日期（未补录 + 已放弃可重试）。
export function getBackfillPlan(pointId: number): BackfillPlan | null {
  const point = findPoint(pointId)
  if (!point || point.status !== STATUS_BACKFILL) {
    return null
  }
  const obsRows = listRows(CRACK_OBS_KEY)
  const pointCode = String(point['测点编号'])
  const byDate = new Map(
    pointObservations(obsRows, pointCode).map((row) => [String(row['观测日期']), row]),
  )
  const start = gapStartDate(point, obsRows)
  const days = start <= today() ? eachDay(start, today()).slice(0, MAX_GAP_DAYS) : []
  const slots: BackfillSlot[] = []
  for (const date of days) {
    const record = byDate.get(date)
    if (!record) {
      slots.push({ date, state: '待补录', reason: '' })
    } else if (record.status === OBS_MISSING) {
      slots.push({ date, state: '已放弃', reason: String(record['备注'] ?? '') })
    }
  }
  return {
    pointId,
    pointCode,
    hazardCode: String(point['隐患点编号']),
    crackCode: String(point['裂缝编号']),
    gapStart: days[0] ?? '',
    gapEnd: days[days.length - 1] ?? '',
    slots,
  }
}

export function markCrackInterrupted(pointId: number): ActionResult {
  const rows = listRows(POINT_KEY)
  const point = rows.find((row) => Number(row.id) === pointId)
  if (!point) {
    return { ok: false, message: `没有找到编号为 ${pointId} 的裂缝测点` }
  }
  if (point.status === STATUS_BACKFILL) {
    return { ok: false, message: '测点已经是「待补录」，不用重复标记' }
  }
  if (point.status === '已修复' || point.status === '已废弃') {
    return { ok: false, message: `测点已${String(point.status)}，不能标记观测中断` }
  }
  const next = rows.map((row) =>
    Number(row.id) === pointId
      ? {
          ...row,
          status: STATUS_BACKFILL,
          测点状态: STATUS_BACKFILL,
          pending: true,
          中断日期: today(),
        }
      : row,
  )
  saveModules({ [POINT_KEY]: next })
  return { ok: true, message: `测点已标记观测中断，进入「待补录」，缺口从 ${today()} 起算` }
}

// 速率与当前宽度重算：只用带日期的有效观测（正常值与异常值），缺失记录不参与；
// 不足两条有效观测时速率记「未测」，不拿没有日期的初始宽度编造时间基准。
function recomputeWidthAndRate(
  point: EntryRow,
  obsRows: EntryRow[],
): Pick<EntryRow, '当前宽度' | '变化速率'> {
  const valid = pointObservations(obsRows, String(point['测点编号']))
    .filter((row) => row.status !== OBS_MISSING)
    .map((row) => ({ date: String(row['观测日期']), width: toNumber(row['裂缝宽度']) }))
    .filter((row): row is { date: string; width: number } => row.width !== null)
    .sort((a, b) => a.date.localeCompare(b.date))
  if (valid.length === 0) {
    return { 当前宽度: toNumber(point['当前宽度']) ?? UNMEASURED, 变化速率: UNMEASURED }
  }
  const latest = valid[valid.length - 1]
  if (valid.length < 2) {
    return { 当前宽度: latest.width, 变化速率: UNMEASURED }
  }
  const previous = valid[valid.length - 2]
  const days = Math.max(1, diffDays(previous.date, latest.date))
  const rate = Math.round(((latest.width - previous.width) / days) * 100) / 100
  return { 当前宽度: latest.width, 变化速率: rate }
}

function buildReviewItem(point: EntryRow, obsRows: EntryRow[], patrolRows: EntryRow[]): EntryRow {
  const batch = batchId(point)
  const filled = pointObservations(obsRows, String(point['测点编号'])).filter(
    (row) => row['补录批次'] === batch && row.status !== OBS_MISSING,
  ).length
  const abandoned = pointObservations(obsRows, String(point['测点编号'])).filter(
    (row) => row['补录批次'] === batch && row.status === OBS_MISSING,
  ).length
  const id = nextId(patrolRows)
  const usedCodes = new Set(patrolRows.map((row) => String(row['巡查编号'])))
  let seq = id
  let code = `PATR-${String(seq).padStart(4, '0')}`
  while (usedCodes.has(code)) {
    seq += 1
    code = `PATR-${String(seq).padStart(4, '0')}`
  }
  return {
    id,
    status: '待巡查',
    pending: true,
    abnormal: false,
    巡查编号: code,
    隐患点编号: String(point['隐患点编号']),
    巡查日期: today(),
    巡查人员: '值班管理员',
    巡查范围: `裂缝测点 ${String(point['测点编号'])} 观测中断补录复查`,
    发现异常: `缺口自 ${String(point['中断日期'])} 起：补录 ${filled} 条、放弃 ${abandoned} 条`,
    处置措施: '现场复查补录数据与裂缝实际发展是否一致',
    巡查状态: '待巡查',
    复查批次: batch,
  }
}

// 补录落库的唯一出口：校验全部通过后一次性写入测点、观测日志和巡查复查事项，
// 任一步失败都不落库，不会留下半条补录状态。
function persistBackfill(point: EntryRow, nextObs: EntryRow[], okMessage: string): ActionResult {
  const crackRows = listRows(POINT_KEY)
  const current = crackRows.find((row) => Number(row.id) === Number(point.id))
  if (!current) {
    return { ok: false, message: '裂缝测点已被移除，本次补录未写入' }
  }
  let nextPoint: EntryRow = { ...current, ...recomputeWidthAndRate(current, nextObs) }
  let patrolRows = listRows(PATROL_KEY)
  let finalized = false
  if (current.status === STATUS_BACKFILL && gapDates(current, nextObs).length === 0) {
    finalized = true
    nextPoint = { ...nextPoint, status: STATUS_NORMAL, 测点状态: STATUS_NORMAL, pending: false }
    const batch = batchId(current)
    if (!patrolRows.some((row) => row['复查批次'] === batch)) {
      patrolRows = [...patrolRows, buildReviewItem(current, nextObs, patrolRows)]
    }
  }
  const nextCrack = crackRows.map((row) =>
    Number(row.id) === Number(point.id) ? nextPoint : row,
  )
  try {
    saveModules({ [POINT_KEY]: nextCrack, [CRACK_OBS_KEY]: nextObs, [PATROL_KEY]: patrolRows })
  } catch (error) {
    return {
      ok: false,
      message: `补录写入失败，未留下任何补录状态：${error instanceof Error ? error.message : '本地存储不可用'}`,
    }
  }
  return {
    ok: true,
    message: finalized
      ? `${okMessage}；缺口已全部处理，测点恢复「正常」，巡查排查已生成复查事项`
      : okMessage,
  }
}

// 补录边界：只接受缺口时段内的新日期；已有记录的日期允许人工补录覆盖（含重试已放弃的缺失记录）。
function assertDateInBoundary(point: EntryRow, date: string, existing: EntryRow | undefined): string | null {
  if (existing) {
    return null
  }
  if (point.status !== STATUS_BACKFILL) {
    return '测点不在「待补录」状态，不能新增补录日期'
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !gapDates(point, listRows(CRACK_OBS_KEY)).includes(date)) {
    return `${date} 不在缺口时段内，补录只覆盖缺口时段`
  }
  return null
}

export function submitBackfill(pointId: number, date: string, widthRaw: string): ActionResult {
  const point = findPoint(pointId)
  if (!point) {
    return { ok: false, message: `没有找到编号为 ${pointId} 的裂缝测点` }
  }
  const widthText = widthRaw.trim()
  if (!widthText) {
    return { ok: false, message: '宽度不能为空：空白不能作为正常值，请填实测宽度，或选择放弃并说明失败原因' }
  }
  const width = Number(widthText)
  if (!Number.isFinite(width)) {
    return { ok: false, message: '宽度必须是数值，空白或非数值不能作为正常值' }
  }
  if (width < 0 || width > MAX_WIDTH_MM) {
    return { ok: false, message: `宽度超出合理范围（0–${MAX_WIDTH_MM}mm），请核对后再提交` }
  }
  const obsRows = listRows(CRACK_OBS_KEY)
  const pointCode = String(point['测点编号'])
  const existing = obsRows.find(
    (row) => String(row['测点编号']) === pointCode && String(row['观测日期']) === date,
  )
  const boundaryError = assertDateInBoundary(point, date, existing)
  if (boundaryError) {
    return { ok: false, message: boundaryError }
  }
  // 幂等：同值重复提交只保留一次，直接忽略
  if (existing && existing.status !== OBS_MISSING && toNumber(existing['裂缝宽度']) === width) {
    return { ok: true, message: `${date} 已登记过相同宽度，重复提交已忽略` }
  }
  // 与前一有效观测相比日变化超限的，仍接收但标记异常值单独呈现
  const previous = pointObservations(obsRows, pointCode)
    .filter((row) => row.status !== OBS_MISSING && String(row['观测日期']) < date)
    .map((row) => ({ date: String(row['观测日期']), width: toNumber(row['裂缝宽度']) }))
    .filter((row): row is { date: string; width: number } => row.width !== null)
    .sort((a, b) => b.date.localeCompare(a.date))[0]
  let status = OBS_NORMAL
  let abnormal = false
  let note = ''
  if (previous) {
    const days = Math.max(1, diffDays(previous.date, date))
    const jump = (width - previous.width) / days
    if (Math.abs(jump) > ABNORMAL_JUMP_MM_PER_DAY) {
      status = OBS_ABNORMAL
      abnormal = true
      note = `较 ${previous.date} 有效观测日变化 ${jump.toFixed(2)}mm，超过 ${ABNORMAL_JUMP_MM_PER_DAY}mm/天，标记异常值`
    }
  }
  const record: EntryRow = {
    id: existing ? existing.id : nextId(obsRows),
    status,
    pending: false,
    abnormal,
    测点编号: pointCode,
    隐患点编号: String(point['隐患点编号']),
    观测日期: date,
    裂缝宽度: width,
    来源: SOURCE_MANUAL,
    备注: note,
    补录批次: batchId(point),
  }
  const nextObs = existing
    ? obsRows.map((row) => (Number(row.id) === Number(existing.id) ? record : row))
    : [...obsRows, record]
  return persistBackfill(point, nextObs, `${date} 补录成功${abnormal ? '（异常值，已单独标记）' : ''}`)
}

export function abandonBackfill(pointId: number, date: string, reasonRaw: string): ActionResult {
  const point = findPoint(pointId)
  if (!point) {
    return { ok: false, message: `没有找到编号为 ${pointId} 的裂缝测点` }
  }
  const reason = reasonRaw.trim()
  if (reason.length < 2) {
    return { ok: false, message: '放弃补测必须说明失败原因（如「持续降雨无法到达测点」），不能把空白当正常值' }
  }
  const obsRows = listRows(CRACK_OBS_KEY)
  const pointCode = String(point['测点编号'])
  const existing = obsRows.find(
    (row) => String(row['测点编号']) === pointCode && String(row['观测日期']) === date,
  )
  if (existing && existing.status !== OBS_MISSING) {
    return { ok: false, message: `${date} 已有有效观测，不能放弃` }
  }
  const boundaryError = assertDateInBoundary(point, date, existing)
  if (boundaryError) {
    return { ok: false, message: boundaryError }
  }
  // 幂等：同原因重复放弃只保留一次
  if (existing && String(existing['备注']) === reason) {
    return { ok: true, message: `${date} 已登记过相同原因的放弃，重复提交已忽略` }
  }
  const record: EntryRow = {
    id: existing ? existing.id : nextId(obsRows),
    status: OBS_MISSING,
    pending: false,
    abnormal: false,
    测点编号: pointCode,
    隐患点编号: String(point['隐患点编号']),
    观测日期: date,
    裂缝宽度: UNMEASURED,
    来源: SOURCE_ABANDONED,
    备注: reason,
    补录批次: batchId(point),
  }
  const nextObs = existing
    ? obsRows.map((row) => (Number(row.id) === Number(existing.id) ? record : row))
    : [...obsRows, record]
  return persistBackfill(point, nextObs, `${date} 已登记放弃补测，原因：${reason}`)
}
