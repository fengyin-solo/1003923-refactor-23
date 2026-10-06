<template>
  <section class="page" data-module="crack">
    <header class="page-head">
      <div>
        <h2>裂缝监测管理</h2>
        <p class="page-desc">
          维护裂缝测点与观测序列，观测中断后的缺口只允许通过补录补齐；空白不得当正常值，设备自动估值仅供参考。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记裂缝测点</button>
        <button class="btn" type="button" @click="exportRows">导出裂缝监测清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value" :class="item.tone">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item">
        <span>测点编号</span>
        <input v-model="filters.code" placeholder="按测点编号检索" />
      </label>
      <label class="filter-item">
        <span>隐患点编号</span>
        <input v-model="filters.hazard" placeholder="按隐患点编号检索" />
      </label>
      <label class="filter-item">
        <span>裂缝编号</span>
        <input v-model="filters.crackNo" placeholder="按裂缝编号检索" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table crack-table">
      <thead>
        <tr>
          <th>测点编号</th>
          <th>隐患点编号</th>
          <th>裂缝编号</th>
          <th>初始宽度</th>
          <th>当前宽度</th>
          <th>变化速率</th>
          <th>观测缺口</th>
          <th>监测人</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in views" :key="item.id" :class="{ 'row-interrupt': item.activeTask }">
          <td>{{ item.row['测点编号'] }}</td>
          <td>{{ item.row['隐患点编号'] }}</td>
          <td>{{ item.row['裂缝编号'] }}</td>
          <td>
            <span v-if="item.initialWidthMissing" class="tag tag-muted">未测（旧记录）</span>
            <template v-else>{{ item.initialWidth }} mm</template>
          </td>
          <td>{{ item.latestWidth === null ? '—' : `${item.latestWidth} mm` }}</td>
          <td>
            <span v-if="item.latestRate === null" class="tag tag-muted">无法计算</span>
            <template v-else>
              {{ item.latestRate }} mm/d
              <span v-if="item.rateSource === '补录重算'" class="tag tag-recalc">补录重算</span>
            </template>
          </td>
          <td>
            <span v-if="item.gapDays > 0" class="tag tag-gap">缺 {{ item.gapDays }} 天</span>
            <span v-else class="tag tag-ok">连续</span>
          </td>
          <td>{{ item.row['监测人'] || '—' }}</td>
          <td><span :class="['status-badge', statusTone(String(item.row.status))]">{{ item.row.status }}</span></td>
          <td class="row-actions">
            <button class="link" type="button" @click="openDetail(item)">观测历史/补录</button>
            <button class="link" type="button" @click="runAction('标记加速', item.row)">标记加速</button>
            <button class="link" type="button" @click="runAction('确认稳定', item.row)">确认稳定</button>
          </td>
        </tr>
        <tr v-if="!views.length">
          <td colspan="10" class="empty-state">
            <template v-if="hasFilter">没有符合筛选条件的裂缝测点，请调整查询条件</template>
            <template v-else>暂无裂缝测点数据，可先登记裂缝测点</template>
          </td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ views.length }} 个裂缝测点</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <!-- 测点历史与补录抽屉 -->
    <div v-if="detail" class="modal-mask" @click.self="closeDetail">
      <div class="modal modal-wide">
        <header class="modal-head">
          <div>
            <h3>{{ detail.code }} 观测历史与补录</h3>
            <p class="modal-sub">
              初始宽度：
              <strong v-if="!detail.initialWidthMissing">{{ detail.initialWidth }} mm</strong>
              <span v-else class="tag tag-muted">未测（旧记录按未测兼容，不参与速率推算）</span>
            </p>
          </div>
          <button class="btn ghost" type="button" @click="closeDetail">关闭</button>
        </header>

        <div class="modal-body">
          <!-- 补录任务横幅 -->
          <section v-if="detail.activeTask" class="task-banner">
            <div class="task-banner-head">
              <span :class="['status-badge', taskTone(detail.activeTask.状态)]">{{ detail.activeTask.状态 }}</span>
              <strong>
                观测缺口 {{ detail.activeTask.缺口开始 }} ~ {{ detail.activeTask.缺口结束 }}
                （{{ detail.activeTask.缺口天数 }} 天）
              </strong>
              <span class="task-meta">已尝试 {{ detail.activeTask.尝试次数 }} 次</span>
            </div>
            <p v-if="detail.activeTask.状态 === '补录失败'" class="task-fail">
              失败原因：{{ detail.activeTask.失败原因 }}
            </p>
            <p v-else class="task-tip">
              重新进入补录只显示缺口时段；可重试或放弃，放弃后仍可再次进入。
            </p>
            <div class="task-actions">
              <button class="btn primary" type="button" @click="openBackfillForm">
                {{ detail.activeTask.状态 === '补录失败' ? '按缺口重试补录' : '进入补录' }}
              </button>
              <button class="btn" type="button" @click="askAbandonFromBanner">放弃补录</button>
            </div>
          </section>

          <!-- 已放弃的历史任务 -->
          <section
            v-for="task in abandonedTasks"
            :key="task.id"
            class="task-banner task-abandoned"
          >
            <div class="task-banner-head">
              <span class="status-badge tone-muted">已放弃</span>
              <strong>{{ task.缺口开始 }} ~ {{ task.缺口结束 }}（{{ task.缺口天数 }} 天）</strong>
            </div>
            <p class="task-tip">放弃原因：{{ task.放弃原因 || '—' }}</p>
            <div class="task-actions">
              <button class="btn" type="button" @click="reopenTask(task.id)">重新进入补录</button>
            </div>
          </section>

          <!-- 三分区：缺失记录 / 异常值 / 缺口 -->
          <div class="zone-grid">
            <section class="zone">
              <h4 class="zone-title">缺失记录（已确认当日无法量测）</h4>
              <ul v-if="missingRecords.length" class="zone-list">
                <li v-for="rec in missingRecords" :key="rec.id">
                  <span>{{ rec.观测日期 }}</span>
                  <span class="tag tag-missing">未测</span>
                  <span class="zone-note">{{ rec.备注 || '当日无法量测' }}</span>
                </li>
              </ul>
              <p v-else class="zone-empty">暂无缺失记录</p>
            </section>

            <section class="zone">
              <h4 class="zone-title">异常值（需复核）</h4>
              <ul v-if="abnormalRecords.length" class="zone-list">
                <li v-for="rec in abnormalRecords" :key="rec.id">
                  <span>{{ rec.观测日期 }}</span>
                  <span class="tag tag-abnormal">{{ rec.宽度 }} mm</span>
                  <span class="zone-note">{{ rec.异常说明 || '宽度突变超限' }}</span>
                </li>
              </ul>
              <p v-else class="zone-empty">暂无异常值</p>
            </section>

            <section class="zone">
              <h4 class="zone-title">观测缺口（待补录）</h4>
              <ul v-if="openGaps.length" class="zone-list">
                <li v-for="gap in openGaps" :key="gap.start">
                  <span>{{ gap.start }} ~ {{ gap.end }}</span>
                  <span class="tag tag-gap">缺 {{ gap.days }} 天</span>
                  <span v-if="gap.autoEstimates.length" class="zone-note">
                    设备给过 {{ gap.autoEstimates.length }} 天自动估值，仅供参考
                  </span>
                  <button
                    v-if="!detail.activeTask"
                    class="link"
                    type="button"
                    @click="createBackfill"
                  >
                    发起补录
                  </button>
                </li>
              </ul>
              <p v-else-if="detail.observations.length" class="zone-empty">观测连续，没有缺口</p>
              <p v-else class="zone-empty">该测点还没有任何观测记录，不属于中断缺口</p>
            </section>
          </div>

          <!-- 自动估值参考区 -->
          <section v-if="estimateRecords.length" class="estimate-block">
            <h4 class="zone-title">设备自动估值（不作为实测，不补缺口）</h4>
            <ul class="zone-list">
              <li
                v-for="rec in estimateRecords"
                :key="rec.id"
                :class="{ 'estimate-dead': rec.已被补录替代 }"
              >
                <span>{{ rec.观测日期 }}</span>
                <span class="tag" :class="rec.已被补录替代 ? 'tag-muted' : 'tag-estimate'">
                  估值 {{ rec.宽度 }} mm
                </span>
                <span class="zone-note">
                  {{ rec.已被补录替代 ? '已被人工补录替代，不再参与计算' : rec.异常说明 }}
                </span>
              </li>
            </ul>
          </section>

          <!-- 完整历史观测 -->
          <section class="history-block">
            <h4 class="zone-title">历史观测序列</h4>
            <table v-if="detail.observations.length" class="data-table history-table">
              <thead>
                <tr>
                  <th>观测日期</th>
                  <th>宽度(mm)</th>
                  <th>速率(mm/d)</th>
                  <th>来源</th>
                  <th>判定</th>
                  <th>监测人</th>
                  <th>说明</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="rec in detail.observations"
                  :key="rec.id"
                  :class="{
                    'row-missing': rec.状态 === '缺失',
                    'row-abnormal': rec.状态 === '异常值',
                    'row-estimate': rec.来源 === '自动估值',
                    'row-dead': rec.已被补录替代,
                  }"
                >
                  <td>{{ rec.观测日期 }}</td>
                  <td>{{ rec.宽度 === null ? '未测' : rec.宽度 }}</td>
                  <td>
                    {{ rec.速率 === null ? '—' : rec.速率 }}
                    <span v-if="rec.速率口径 === '补录重算'" class="tag tag-recalc">重算</span>
                  </td>
                  <td>{{ rec.来源 }}</td>
                  <td>
                    <span
                      class="tag"
                      :class="{
                        'tag-missing': rec.状态 === '缺失',
                        'tag-abnormal': rec.状态 === '异常值',
                        'tag-ok': rec.状态 === '正常',
                      }"
                    >{{ rec.状态 }}</span>
                  </td>
                  <td>{{ rec.监测人 || '—' }}</td>
                  <td class="zone-note">{{ rec.备注 || rec.异常说明 || '—' }}</td>
                </tr>
              </tbody>
            </table>
            <p v-else class="zone-empty">该测点暂无任何观测记录</p>
          </section>
        </div>
      </div>
    </div>

    <!-- 补录表单 -->
    <div v-if="backfill" class="modal-mask" @click.self="closeBackfillForm">
      <div class="modal">
        <header class="modal-head">
          <div>
            <h3>补录缺口观测 · {{ backfill.task.测点编号 }}</h3>
            <p class="modal-sub">
              仅补录缺口时段 {{ backfill.task.缺口开始 }} ~ {{ backfill.task.缺口结束 }}。
              空白不能当正常值：请填写实测宽度，或勾选当日无法量测。
            </p>
          </div>
          <button class="btn ghost" type="button" @click="closeBackfillForm">关闭</button>
        </header>

        <div class="modal-body">
          <p v-if="backfill.task.状态 === '补录失败'" class="task-fail">
            上次失败原因：{{ backfill.task.失败原因 }}
          </p>

          <table class="data-table backfill-table">
            <thead>
              <tr>
                <th>缺口日期</th>
                <th>设备估值（仅参考）</th>
                <th>实测宽度(mm)</th>
                <th>当日无法量测</th>
                <th>异常确认</th>
                <th>备注</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="entry in backfill.entries" :key="entry.date">
                <td>{{ entry.date }}</td>
                <td>{{ entry.estimate === null ? '—' : `${entry.estimate.width}（${entry.estimate.rate} mm/d）` }}</td>
                <td>
                  <input
                    v-model="entry.width"
                    class="input-width"
                    type="number"
                    step="0.01"
                    min="0"
                    :disabled="entry.unmeasurable"
                    placeholder="填实测值"
                  />
                </td>
                <td>
                  <label class="inline-check">
                    <input v-model="entry.unmeasurable" type="checkbox" />
                    无法量测
                  </label>
                </td>
                <td>
                  <label v-if="entry.needAbnormalCheck" class="inline-check">
                    <input v-model="entry.abnormalConfirmed" type="checkbox" />
                    确认突变
                  </label>
                  <span v-else class="tag tag-muted">无需</span>
                </td>
                <td><input v-model="entry.remark" class="input-remark" placeholder="可选" /></td>
              </tr>
            </tbody>
          </table>

          <div v-if="backfill.localError" class="form-error">{{ backfill.localError }}</div>

          <div v-if="abandonMode" class="abandon-box">
            <label class="filter-item">
              <span>放弃原因（必填）</span>
              <textarea v-model="abandonReason" rows="2" placeholder="说明为什么放弃本次补录"></textarea>
            </label>
            <div class="task-actions">
              <button class="btn primary" type="button" @click="confirmAbandon">确认放弃</button>
              <button class="btn ghost" type="button" @click="abandonMode = false">取消</button>
            </div>
          </div>

          <footer v-else class="modal-foot">
            <span class="foot-hint">提交为整批校验：任一日不通过则整批不写入，不会留下半条补录。</span>
            <div class="task-actions">
              <button class="btn primary" type="button" :disabled="backfill.submitting" @click="submitForm">
                {{ backfill.submitting ? '提交中…' : '提交补录' }}
              </button>
              <button class="btn" type="button" @click="askAbandon">放弃</button>
            </div>
          </footer>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  abandonBackfill,
  getPointHistory,
  listCrackPoints,
  reopenBackfill,
  startBackfill,
  submitBackfill,
} from '@/api/crack-service'
import type { CrackPointView } from '@/api/crack-service'
import { listDomain } from '@/data/local-store'
import type { BackfillTask, GapSummary, PointHistory } from '@/data/crack-backfill'
import { useSessionStore } from '@/stores/session'

const meta = moduleMeta('crack')
const session = useSessionStore()
const statuses = ['正常', '观测中断', '加速发展', '趋于稳定', '已修复', '已废弃']
// 单日宽度突变超过该差值（mm）就要求人工确认，与服务层口径一致。
const ABNORMAL_DELTA = 0.5

const errorMessage = ref('')
const filters = reactive({ code: '', hazard: '', crackNo: '' })
const views = ref<CrackPointView[]>([])
const detail = ref<PointHistory | null>(null)

type BackfillEntryState = {
  date: string
  width: string
  unmeasurable: boolean
  abnormalConfirmed: boolean
  remark: string
  estimate: { width: number; rate: number } | null
  needAbnormalCheck: boolean
}

const backfill = ref<{
  task: BackfillTask
  gap: GapSummary
  entries: BackfillEntryState[]
  localError: string
  submitting: boolean
} | null>(null)
const abandonMode = ref(false)
const abandonReason = ref('')

const stats = computed(() => {
  const allObs = listDomain('crack_observations')
  return [
    { label: '测点总数', value: views.value.length, tone: '' },
    { label: '中断待补录', value: views.value.filter((item) => item.activeTask).length, tone: 'tone-gap' },
    {
      label: '补录失败',
      value: views.value.filter((item) => item.activeTask?.状态 === '补录失败').length,
      tone: 'tone-danger',
    },
    { label: '异常观测', value: allObs.filter((item) => item.状态 === '异常值').length, tone: 'tone-danger' },
    { label: '缺失记录', value: allObs.filter((item) => item.状态 === '缺失').length, tone: 'tone-muted' },
  ]
})

const statusSummary = computed(() =>
  statuses.map((status) => ({
    status,
    count: views.value.filter((item) => String(item.row.status) === status).length,
  })),
)

const hasFilter = computed(() =>
  [filters.code, filters.hazard, filters.crackNo].some((value) => value.trim() !== ''),
)

const missingRecords = computed(() =>
  detail.value?.observations.filter((item) => item.状态 === '缺失') ?? [],
)
const abnormalRecords = computed(() =>
  detail.value?.observations.filter((item) => item.状态 === '异常值') ?? [],
)
const estimateRecords = computed(() =>
  detail.value?.observations.filter((item) => item.来源 === '自动估值') ?? [],
)
const openGaps = computed(() => detail.value?.gaps ?? [])
const abandonedTasks = computed(() =>
  detail.value?.tasks.filter((task) => task.状态 === '已放弃') ?? [],
)

function statusTone(status: string): string {
  if (status === '加速发展') return 'tone-danger'
  if (status === '观测中断') return 'tone-gap'
  if (status === '趋于稳定') return 'tone-ok'
  if (status === '已废弃') return 'tone-muted'
  return ''
}

function taskTone(status: string): string {
  if (status === '补录失败') return 'tone-danger'
  if (status === '已补录') return 'tone-ok'
  return 'tone-gap'
}

function resetFilters() {
  filters.code = ''
  filters.hazard = ''
  filters.crackNo = ''
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '裂缝测点登记入口尚未接入审批流'
}

function runAction(action: string, row: { id: number }) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, {
      测点编号: filters.code,
      隐患点编号: filters.hazard,
      裂缝编号: filters.crackNo,
    })
    const ids = new Set(payload.items.map((row) => Number(row.id)))
    views.value = listCrackPoints().filter((item) => ids.has(item.id))
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '裂缝监测列表读取失败'
  }
}

function refreshDetail() {
  if (!detail.value) {
    return
  }
  detail.value = getPointHistory(detail.value.pointId)
  reload()
}

function openDetail(item: CrackPointView) {
  const history = getPointHistory(item.id)
  if (!history) {
    errorMessage.value = '测点历史读取失败'
    return
  }
  detail.value = history
}

function closeDetail() {
  if (!backfill.value) {
    detail.value = null
  }
}

/** 用缺口日期组装补录表单：从待补录重新进入时只显示缺口时段。 */
function buildBackfill(task: BackfillTask) {
  if (!detail.value) {
    return
  }
  const gap = detail.value.gaps.find(
    (item) => item.start === task.缺口开始 && item.end === task.缺口结束,
  )
  if (!gap) {
    errorMessage.value = '缺口状态已变化，可能已被补录，请刷新后重试'
    refreshDetail()
    return
  }
  const estimateByDate = new Map(gap.autoEstimates.map((item) => [item.date, item]))
  const entries: BackfillEntryState[] = gap.dates.map((date) => ({
    date,
    width: '',
    unmeasurable: false,
    abnormalConfirmed: false,
    remark: '',
    estimate: estimateByDate.get(date) ?? null,
    needAbnormalCheck: false,
  }))
  backfill.value = { task: { ...task }, gap, entries, localError: '', submitting: false }
  abandonMode.value = false
  abandonReason.value = ''
  watchJump()
}

function openBackfillForm() {
  if (detail.value?.activeTask) {
    buildBackfill(detail.value.activeTask)
  }
}

function createBackfill() {
  if (!detail.value) {
    return
  }
  const result = startBackfill(detail.value.pointId)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  refreshDetail()
  if (detail.value?.activeTask) {
    buildBackfill(detail.value.activeTask)
  }
}

function closeBackfillForm() {
  backfill.value = null
  abandonMode.value = false
}

/** 实时提示突变，减少提交失败；最终以服务层整批校验为准。 */
function watchJump() {
  if (!backfill.value || !detail.value) {
    return
  }
  let previous = backfill.value.gap.lastMeasuredWidth ?? detail.value.initialWidth
  for (const entry of backfill.value.entries) {
    if (entry.unmeasurable || entry.width.trim() === '') {
      entry.needAbnormalCheck = false
      continue
    }
    const value = Number(entry.width)
    entry.needAbnormalCheck =
      Number.isFinite(value) && previous !== null && Math.abs(value - previous) > ABNORMAL_DELTA
    if (Number.isFinite(value) && value >= 0) {
      previous = value
    }
  }
}

watch(
  () => backfill.value?.entries.map((entry) => `${entry.width}|${entry.unmeasurable}`).join(','),
  () => watchJump(),
)

function askAbandon() {
  abandonReason.value = ''
  abandonMode.value = true
}

function askAbandonFromBanner() {
  openBackfillForm()
  askAbandon()
}

function confirmAbandon() {
  if (!backfill.value) {
    return
  }
  const result = abandonBackfill(backfill.value.task.id, abandonReason.value)
  if (!result.ok) {
    backfill.value.localError = result.message
    return
  }
  closeBackfillForm()
  refreshDetail()
}

function reopenTask(taskId: number) {
  const result = reopenBackfill(taskId)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  refreshDetail()
  if (detail.value?.activeTask) {
    buildBackfill(detail.value.activeTask)
  }
}

function submitForm() {
  if (!backfill.value) {
    return
  }
  watchJump()
  backfill.value.localError = ''
  backfill.value.submitting = true
  const taskId = backfill.value.task.id
  try {
    const result = submitBackfill(
      taskId,
      backfill.value.entries.map((entry) => ({
        date: entry.date,
        width: entry.width,
        unmeasurable: entry.unmeasurable,
        abnormalConfirmed: entry.abnormalConfirmed,
        remark: entry.remark,
      })),
      session.operator,
    )
    if (!result.ok) {
      backfill.value.localError = result.message
      refreshDetail()
      const refreshed = detail.value?.tasks.find((item) => item.id === taskId)
      if (refreshed) {
        backfill.value.task = { ...refreshed }
      }
      return
    }
    closeBackfillForm()
    refreshDetail()
  } finally {
    if (backfill.value) {
      backfill.value.submitting = false
    }
  }
}

onMounted(reload)
</script>

<style scoped>
.crack-table .row-interrupt {
  background: #fff8ec;
}
.status-badge {
  display: inline-block;
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 12px;
  background: #eef2f7;
}
.tone-danger {
  background: #fee4e2;
  color: #b42318;
}
.tone-gap {
  background: #fef3c7;
  color: #92400e;
}
.tone-ok {
  background: #dcfce7;
  color: #166534;
}
.tone-muted {
  background: #e5e7eb;
  color: #475569;
}
.tag {
  display: inline-block;
  border-radius: 4px;
  padding: 1px 6px;
  font-size: 12px;
  background: #eef2f7;
  color: #334155;
}
.tag-muted { background: #e5e7eb; color: #64748b; }
.tag-gap { background: #fef3c7; color: #92400e; }
.tag-abnormal,
.tag-missing { background: #fee4e2; color: #b42318; }
.tag-ok { background: #dcfce7; color: #166534; }
.tag-estimate { background: #e0e7ff; color: #3730a3; }
.tag-recalc { background: #ede9fe; color: #6d28d9; margin-left: 4px; }

.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 40px 16px;
  z-index: 50;
  overflow-y: auto;
}
.modal {
  background: #fff;
  border-radius: 10px;
  width: 640px;
  max-width: 100%;
  box-shadow: 0 18px 48px rgba(15, 23, 42, 0.25);
}
.modal-wide { width: 960px; }
.modal-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border);
}
.modal-head h3 { margin: 0; font-size: 16px; }
.modal-sub { margin: 4px 0 0; font-size: 12px; color: var(--muted); }
.modal-body { padding: 14px 18px; }
.modal-foot {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-top: 12px;
}
.foot-hint { font-size: 12px; color: var(--muted); }

.task-banner {
  border: 1px solid #fcd34d;
  background: #fffbeb;
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 12px;
}
.task-abandoned { border-color: var(--border); background: #f8fafc; }
.task-banner-head {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
}
.task-meta { margin-left: auto; font-size: 12px; color: var(--muted); }
.task-fail {
  margin: 8px 0 0;
  font-size: 12px;
  color: #b42318;
  background: #fee4e2;
  border-radius: 6px;
  padding: 6px 8px;
}
.task-tip { margin: 8px 0 0; font-size: 12px; color: #92400e; }
.task-actions { display: flex; gap: 8px; margin-top: 10px; }

.zone-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
  margin-bottom: 12px;
}
.zone {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px;
  background: #fff;
}
.zone-title { margin: 0 0 8px; font-size: 13px; }
.zone-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.zone-list li { display: flex; align-items: center; gap: 8px; font-size: 12px; flex-wrap: wrap; }
.zone-note { color: var(--muted); font-size: 12px; }
.zone-empty { margin: 0; font-size: 12px; color: var(--muted); background: #f8fafc; border-radius: 6px; padding: 8px; text-align: center; }

.estimate-block,
.history-block { margin-bottom: 12px; }
.estimate-dead { text-decoration: line-through; color: #94a3b8; }
.history-table { font-size: 12px; }
.row-missing { background: #fef2f2; }
.row-abnormal { background: #fff7ed; }
.row-estimate { background: #eef2ff; }
.row-dead { opacity: 0.55; }

.backfill-table .input-width { width: 110px; }
.backfill-table .input-remark { width: 100%; }
.inline-check { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; }
.form-error {
  margin-top: 10px;
  background: #fee4e2;
  color: #b42318;
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 12px;
  white-space: pre-wrap;
}
.abandon-box {
  margin-top: 12px;
  border: 1px dashed var(--border);
  border-radius: 8px;
  padding: 10px;
}
.abandon-box textarea { width: 100%; resize: vertical; }
</style>
