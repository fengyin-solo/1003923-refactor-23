<template>
  <section class="page" data-module="crack">
    <header class="page-head">
      <div>
        <h2>裂缝监测管理</h2>
        <p class="page-desc">维护裂缝测点，围绕测点编号、隐患点编号、裂缝编号、初始宽度做登记、筛选与状态流转；观测中断的测点进入「待补录」，只补缺口时段。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记裂缝测点</button>
        <button class="btn" type="button" @click="exportRows">导出裂缝监测清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ formatCell(row, column) }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
            <button
              v-if="row.status === '待补录'"
              class="link"
              type="button"
              @click="openBackfill(row)"
            >
              补录
            </button>
            <button class="link" type="button" @click="openHistory(row)">历史</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无裂缝监测数据，可先登记裂缝测点</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条裂缝监测记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-if="noticeMessage" class="ok-text">{{ noticeMessage }}</span>
    </footer>

    <div v-if="backfillPlan" class="modal-mask">
      <div class="modal">
        <header class="modal-head">
          <h3>观测中断补录 · {{ backfillPlan.pointCode }}</h3>
          <button class="link" type="button" @click="closeBackfill">关闭</button>
        </header>
        <p class="modal-desc">
          隐患点 {{ backfillPlan.hazardCode }} · 裂缝 {{ backfillPlan.crackCode }} ·
          缺口时段 {{ backfillPlan.gapStart || '—' }} ~ {{ backfillPlan.gapEnd || '—' }}（只显示尚未落定的缺口日期）
        </p>
        <table v-if="backfillPlan.slots.length" class="data-table">
          <thead>
            <tr>
              <th>缺口日期</th>
              <th>当前状态</th>
              <th>补录宽度(mm)</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="slot in backfillPlan.slots" :key="slot.date">
              <td>{{ slot.date }}</td>
              <td>
                <span v-if="slot.state === '已放弃'">已放弃：{{ slot.reason }}（可重试）</span>
                <span v-else>待补录</span>
              </td>
              <td>
                <input
                  v-model="slotForms[slot.date].width"
                  placeholder="实测宽度，空白无效"
                />
              </td>
              <td class="row-actions">
                <button class="link" type="button" @click="submitSlot(slot.date)">提交补录</button>
                <button class="link" type="button" @click="toggleAbandon(slot.date)">放弃</button>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-else class="empty-state">缺口时段已全部处理完成</p>
        <div v-if="abandoningDate" class="abandon-bar">
          <span>放弃 {{ abandoningDate }} 补测，必须说明失败原因：</span>
          <input v-model="abandonReason" placeholder="如：持续降雨无法到达测点" />
          <button class="btn" type="button" @click="confirmAbandon">确认放弃</button>
          <button class="btn ghost" type="button" @click="abandoningDate = ''">取消</button>
        </div>
        <p class="modal-desc">
          空白不能作为正常值提交；全部缺口处理完成后测点自动恢复「正常」，并在巡查排查生成一条复查事项；重复提交只保留一次。
        </p>
        <footer class="page-foot">
          <span v-if="backfillError" class="error-text">{{ backfillError }}</span>
          <span v-if="backfillNotice" class="ok-text">{{ backfillNotice }}</span>
        </footer>
      </div>
    </div>

    <div v-if="history" class="modal-mask">
      <div class="modal">
        <header class="modal-head">
          <h3>历史观测 · {{ historyPointCode }}</h3>
          <button class="link" type="button" @click="closeHistory">关闭</button>
        </header>
        <p v-if="!history.total" class="empty-state">暂无观测记录：该测点还没有任何观测数据</p>
        <template v-else>
          <section v-for="group in historyGroups" :key="group.key" class="history-group">
            <h4 class="history-title">{{ group.title }}（{{ group.rows.length }}）</h4>
            <p v-if="!group.rows.length" class="empty-state">无</p>
            <table v-else class="data-table">
              <thead>
                <tr>
                  <th>观测日期</th>
                  <th>裂缝宽度(mm)</th>
                  <th>来源</th>
                  <th>备注</th>
                  <th v-if="group.key === 'missing'">重试</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in group.rows" :key="String(row.id)">
                  <td>{{ row['观测日期'] }}</td>
                  <td>{{ row.status === '缺失' ? '未测' : row['裂缝宽度'] }}</td>
                  <td>{{ row['来源'] }}</td>
                  <td>{{ row['备注'] || '—' }}</td>
                  <td v-if="group.key === 'missing'" class="row-actions">
                    <input
                      v-model="retryForms[String(row['观测日期'])]"
                      placeholder="重测宽度(mm)"
                    />
                    <button
                      class="link"
                      type="button"
                      @click="retryMissing(String(row['观测日期']))"
                    >
                      重试补录
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </section>
        </template>
        <footer class="page-foot">
          <span v-if="historyError" class="error-text">{{ historyError }}</span>
          <span v-if="historyNotice" class="ok-text">{{ historyNotice }}</span>
        </footer>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  abandonBackfill,
  getBackfillPlan,
  markCrackInterrupted,
  observationHistoryFor,
  submitBackfill,
} from '@/api/crack-backfill'
import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { BackfillPlan, EntryRow, ObservationHistory } from '@/data/types'

const meta = moduleMeta('crack')
const columns = ["测点编号", "隐患点编号", "裂缝编号", "初始宽度", "当前宽度", "变化速率", "监测人", "测点状态"]
const actions = ["记录数据", "标记加速", "确认稳定", "标记中断"]
const statuses = ["正常", "加速发展", "趋于稳定", "已修复", "已废弃", "待补录"]
const stats = [{"label": "测点总数", "value": 0}, {"label": "加速发展数", "value": 0}, {"label": "正常测点数", "value": 0}]

// 初始宽度、当前宽度、变化速率是量测值：旧记录缺初始宽度等空值/非数值一律按「未测」兼容展示
const MEASURE_COLUMNS = new Set(["初始宽度", "当前宽度", "变化速率"])

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const backfillPlan = ref<BackfillPlan | null>(null)
const slotForms = ref<Record<string, { width: string }>>({})
const abandoningDate = ref('')
const abandonReason = ref('')
const backfillError = ref('')
const backfillNotice = ref('')

const history = ref<ObservationHistory | null>(null)
const historyPointId = ref(0)
const historyPointCode = ref('')
const retryForms = ref<Record<string, string>>({})
const historyError = ref('')
const historyNotice = ref('')
const historyGroups = computed(() => {
  const current = history.value
  if (!current) {
    return []
  }
  return [
    { key: 'normal', title: '正常记录', rows: current.normal },
    { key: 'abnormal', title: '异常值', rows: current.abnormal },
    { key: 'missing', title: '缺失记录', rows: current.missing },
  ]
})

function formatCell(row: EntryRow, column: string): string {
  const value = row[column]
  if (MEASURE_COLUMNS.has(column)) {
    const text = value === undefined || value === null ? '' : String(value).trim()
    if (text === '' || text === '未测') {
      return '未测'
    }
    return Number.isFinite(Number(text)) ? text : '未测'
  }
  return value === undefined || value === null || value === '' ? '—' : String(value)
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '裂缝测点登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
  if (action === '标记中断') {
    const result = markCrackInterrupted(Number(row.id))
    if (!result.ok) {
      errorMessage.value = result.message
      return
    }
    noticeMessage.value = result.message
    reload()
    return
  }
  // 待补录的测点不能用普通流转直接恢复正常，必须先处理缺口
  if (row.status === '待补录') {
    errorMessage.value = '测点处于「待补录」，请先进入补录处理缺口时段，不能直接流转'
    return
  }
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function openBackfill(row: EntryRow) {
  const plan = getBackfillPlan(Number(row.id))
  if (!plan) {
    errorMessage.value = '测点不在「待补录」状态，无法进入补录'
    return
  }
  backfillPlan.value = plan
  slotForms.value = Object.fromEntries(plan.slots.map((slot) => [slot.date, { width: '' }]))
  abandoningDate.value = ''
  abandonReason.value = ''
  backfillError.value = ''
  backfillNotice.value = ''
}

function closeBackfill() {
  backfillPlan.value = null
  reload()
}

// 每次补录/放弃后重取边界：缺口还在就刷新弹窗，全部落定（测点已恢复）就关掉弹窗
function refreshBackfill(pointId: number, message: string) {
  const plan = getBackfillPlan(pointId)
  if (plan) {
    backfillPlan.value = plan
    const forms = { ...slotForms.value }
    for (const slot of plan.slots) {
      forms[slot.date] = forms[slot.date] ?? { width: '' }
    }
    slotForms.value = forms
    backfillNotice.value = message
  } else {
    backfillPlan.value = null
    noticeMessage.value = message
  }
  reload()
}

function submitSlot(date: string) {
  backfillError.value = ''
  backfillNotice.value = ''
  const plan = backfillPlan.value
  if (!plan) {
    return
  }
  const result = submitBackfill(plan.pointId, date, slotForms.value[date]?.width ?? '')
  if (!result.ok) {
    backfillError.value = result.message
    return
  }
  refreshBackfill(plan.pointId, result.message)
}

function toggleAbandon(date: string) {
  backfillError.value = ''
  abandoningDate.value = abandoningDate.value === date ? '' : date
  abandonReason.value = ''
}

function confirmAbandon() {
  backfillError.value = ''
  backfillNotice.value = ''
  const plan = backfillPlan.value
  if (!plan || !abandoningDate.value) {
    return
  }
  const result = abandonBackfill(plan.pointId, abandoningDate.value, abandonReason.value)
  if (!result.ok) {
    backfillError.value = result.message
    return
  }
  abandoningDate.value = ''
  abandonReason.value = ''
  refreshBackfill(plan.pointId, result.message)
}

function openHistory(row: EntryRow) {
  historyPointId.value = Number(row.id)
  historyPointCode.value = String(row['测点编号'])
  history.value = observationHistoryFor(historyPointCode.value)
  retryForms.value = {}
  historyError.value = ''
  historyNotice.value = ''
}

function closeHistory() {
  history.value = null
  reload()
}

// 缺失记录的重试：原地更新该日期的记录并重算速率，不新增重复记录
function retryMissing(date: string) {
  historyError.value = ''
  historyNotice.value = ''
  const result = submitBackfill(historyPointId.value, date, retryForms.value[date] ?? '')
  if (!result.ok) {
    historyError.value = result.message
    return
  }
  history.value = observationHistoryFor(historyPointCode.value)
  retryForms.value = { ...retryForms.value, [date]: '' }
  historyNotice.value = result.message
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '裂缝监测列表读取失败'
  }
}

onMounted(reload)
</script>
