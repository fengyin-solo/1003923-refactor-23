import type { BackfillTask, CrackObservation } from './crack-backfill'
import type { EntryRow } from './types'

/**
 * 裂缝模块的示例数据贴近真实业务：
 * - CRAC-0001：9/21~9/24 观测中断，缺口期间设备给过自动估值（不补缺口），当前待补录；
 * - CRAC-0002：9/19~9/22 中断，上一次人工补录因「异常突变量未确认」失败，保留失败原因供重试；
 * - CRAC-0003：观测连续，仅用于对照；另放一条旧记录，初始宽度缺失按「未测」兼容。
 *
 * 注意：缺失（null）必须来自「当日无法量测」的明确结论，任何空白都不得落成 0。
 */

type SeedInput = {
  id: number
  code: string
  hazard: string
  crackNo: string
  initialWidth: number | null
  monitor: string
  status: string
  abnormal: boolean
  pending: boolean
  /** [日期, 宽度 | null, 来源, 状态, 异常说明?, 备注?] */
  series: Array<
    [
      string,
      number | null,
      CrackObservation['来源'],
      CrackObservation['状态'],
      string?,
      string?,
    ]
  >
  /** 自动估值（缺口期间的设备参考值）：[日期, 宽度, 速率] */
  estimates?: Array<[string, number, number]>
}


function buildRows(inputs: SeedInput[]): EntryRow[] {
  return inputs.map((input) => {
    // 只认真人实测；自动估值不参与「当前宽度/速率」。
    const measuredValues = input.series
      .filter((item) => item[1] !== null && item[2] !== '自动估值')
      .map((item) => item[1] as number)
    const latest = measuredValues[measuredValues.length - 1] ?? null
    const previous =
      measuredValues.length >= 2
        ? measuredValues[measuredValues.length - 2]
        : input.initialWidth
    return {
      id: input.id,
      status: input.status,
      pending: input.pending,
      abnormal: input.abnormal,
      测点编号: input.code,
      隐患点编号: input.hazard,
      裂缝编号: `LF-${input.code.slice(-4)}`,
      初始宽度: input.initialWidth,
      当前宽度: latest,
      // 旧记录没有初始宽度、又只有一条实测时，速率留空（未测兼容，不编 0）。
      变化速率: latest !== null && previous !== null ? Number((latest - previous).toFixed(2)) : null,
      监测人: input.monitor,
      测点状态: input.status,
    }
  })
}

function buildObservations(inputs: SeedInput[]): CrackObservation[] {
  const rows: CrackObservation[] = []
  let seq = 1
  for (const input of inputs) {
    // 初始宽度缺失（旧记录）时，首条实测没有可对标的初始值，速率留空而不是编 0。
    let previous: number | null = input.initialWidth
    for (const [date, width, source, status, note = '', remark = ''] of input.series) {
      let rate: number | null = null
      let rateSource: CrackObservation['速率口径'] = null
      if (width !== null && previous !== null) {
        rate = Number((width - previous).toFixed(2))
        rateSource = '自动计算'
      }
      rows.push({
        id: seq++,
        测点编号: input.code,
        观测日期: date,
        宽度: width,
        速率: rate,
        速率口径: rateSource,
        来源: source,
        状态: status,
        监测人: status === '缺失' ? '' : input.monitor,
        异常说明: note,
        备注: remark,
        已被补录替代: false,
        更新时间: `${date}T08:30:00+08:00`,
      })
      if (width !== null) {
        previous = width
      }
    }
    for (const [date, width, rate] of input.estimates ?? []) {
      rows.push({
        id: seq++,
        测点编号: input.code,
        观测日期: date,
        宽度: width,
        速率: rate,
        速率口径: null,
        来源: '自动估值',
        状态: '正常',
        监测人: '',
        异常说明: '设备在观测中断期间按历史速率推算，仅供参考，不得作为实测值',
        备注: '待人工补录核定',
        已被补录替代: false,
        更新时间: `${date}T09:00:00+08:00`,
      })
    }
  }
  return rows
}

function daily(
  start: string,
  end: string,
  values: Array<number | null>,
  source: CrackObservation['来源'] = '人工观测',
  abnormalAt: number = -1,
): SeedInput['series'] {
  const series: SeedInput['series'] = []
  const begin = new Date(`${start}T00:00:00Z`).getTime()
  values.forEach((value, index) => {
    const date = new Date(begin + index * 86400000).toISOString().slice(0, 10)
    if (value === null) {
      series.push([date, null, source, '缺失', '', '经现场确认当日无法量测，缺口不等于零值'])
    } else {
      const isAbnormal = index === abnormalAt
      series.push([
        date,
        value,
        source,
        isAbnormal ? '异常值' : '正常',
        isAbnormal ? '宽度较前次突增，需复核' : '',
      ])
    }
  })
  void end
  return series
}

const POINT_INPUTS: SeedInput[] = [
  {
    id: 1,
    code: 'CRAC-0001',
    hazard: 'HAZA-0007',
    crackNo: 'LF-0001',
    initialWidth: 3.2,
    monitor: '周建国',
    status: '观测中断',
    abnormal: false,
    pending: true,
    series: [
      ...daily('2026-09-15', '2026-09-20', [3.2, 3.3, 3.3, 3.4, 3.5, 3.6]),
      // 9/21~9/24 中断：无任何实测/缺失结论，构成待补录缺口
      ...daily('2026-09-25', '2026-09-27', [4.1, 4.2, 4.2]),
    ],
    estimates: [
      ['2026-09-21', 3.7, 0.1],
      ['2026-09-22', 3.8, 0.1],
      ['2026-09-23', 3.9, 0.1],
      ['2026-09-24', 4.0, 0.1],
    ],
  },
  {
    id: 2,
    code: 'CRAC-0002',
    hazard: 'HAZA-0007',
    crackNo: 'LF-0002',
    initialWidth: 5.0,
    monitor: '李海峰',
    status: '加速发展',
    abnormal: true,
    pending: true,
    series: [
      ...daily('2026-09-15', '2026-09-18', [5.0, 5.1, 5.2, 5.3]),
      // 9/19~9/22 中断（含一条异常补录尝试将在校验时拦截）
      ...daily('2026-09-23', '2026-09-26', [6.2, 6.6, 7.1, 7.7], '人工观测', 3),
    ],
    estimates: [
      ['2026-09-19', 5.4, 0.1],
      ['2026-09-20', 5.5, 0.1],
      ['2026-09-21', 5.6, 0.1],
      ['2026-09-22', 5.7, 0.1],
    ],
  },
  {
    id: 3,
    code: 'CRAC-0003',
    hazard: 'HAZA-0012',
    crackNo: 'LF-0003',
    // 旧记录：初始宽度未测，按「未测」兼容，首条实测速率留空
    initialWidth: null,
    monitor: '陈晓敏',
    status: '趋于稳定',
    abnormal: false,
    pending: false,
    series: [
      ...daily('2026-09-15', '2026-09-20', [2.0, 2.05, 2.08, 2.1, 2.1, 2.11]),
      ...daily('2026-09-21', '2026-09-22', [null, null], '人工观测'),
      ...daily('2026-09-23', '2026-09-26', [2.12, 2.12, 2.13, 2.13]),
    ],
  },
]

// 用种子裂缝测点替换通用模板数据；其余模块沿用 seed.ts 的模板。
export function buildCrackSeedRows(existing: Record<string, EntryRow[]>): Record<string, EntryRow[]> {
  return { ...existing, crack: buildRows(POINT_INPUTS) }
}

export const SEED_CRACK_OBSERVATIONS: CrackObservation[] = buildObservations(POINT_INPUTS)

export const SEED_BACKFILL_TASKS: BackfillTask[] = [
  {
    id: 1,
    测点编号: 'CRAC-0001',
    缺口开始: '2026-09-21',
    缺口结束: '2026-09-24',
    缺口天数: 4,
    状态: '待补录',
    失败原因: '',
    尝试次数: 0,
    放弃原因: '',
    创建时间: '2026-09-25T08:40:00+08:00',
    更新时间: '2026-09-25T08:40:00+08:00',
    关联任务: null,
    补录人: '',
  },
  {
    id: 2,
    测点编号: 'CRAC-0002',
    缺口开始: '2026-09-19',
    缺口结束: '2026-09-22',
    缺口天数: 4,
    状态: '补录失败',
    失败原因: '2026-09-22 填报宽度 6.2mm，较缺口前实测 5.3mm 突变 0.9mm，超过异常阈值且未勾选异常确认，整批未写入',
    尝试次数: 1,
    放弃原因: '',
    创建时间: '2026-09-23T08:40:00+08:00',
    更新时间: '2026-09-23T19:05:00+08:00',
    关联任务: null,
    补录人: '',
  },
]
