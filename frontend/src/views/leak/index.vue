<template>
  <section class="page" data-module="leak">
    <header class="page-head">
      <div>
        <h2>渗漏水处置管理</h2>
        <p class="page-desc">渗漏程度、处置方式与返工判定只有一份口径：列表、动作与另存清单读到的结论始终一致。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openRegister">登记渗漏处置单</button>
        <button class="btn" type="button" @click="openImport">导入处置单</button>
        <button class="btn" type="button" @click="exportRows">导出渗漏处置清单</button>
        <button class="btn" type="button" @click="exportArchive">导出另存清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in statCards" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value" :class="{ alert: item.alert }">{{ item.value }}</strong>
      </article>
    </div>

    <div class="leak-tabs" role="tablist">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        type="button"
        class="leak-tab"
        :class="{ active: activeTab === tab.key }"
        @click="activeTab = tab.key"
      >
        {{ tab.label }}（{{ tab.count }}）
      </button>
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
          <th>判定结论</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in displayedRows" :key="String(row.id)" :class="{ selected: selectedId === row.id }">
          <td v-for="column in columns" :key="column" class="cell-clickable" @click="selectRow(row.id)">
            {{ row[column] ?? '—' }}
            <span
              v-if="column === '处置状态' && row._verdict?.rework && row._verdict?.status !== '需返工'"
              class="badge warn"
            >预判返工</span>
          </td>
          <td class="cell-clickable" @click="selectRow(row.id)">
            <span class="status-tag" :class="statusClass(row)">{{ row.status }}</span>
            <span v-if="row._verdict?.locked" class="badge">已锁定</span>
          </td>
          <td class="row-actions">
            <button
              v-for="action in availableActions(row)"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!displayedRows.length">
          <td :colspan="columns.length + 2" class="empty-state">
            {{ activeTab === 'archive' ? '另存清单暂无已完工处置单' : activeTab === 'todo' ? '待办清单为空' : '暂无渗漏水处置数据' }}
          </td>
        </tr>
      </tbody>
    </table>

    <aside v-if="selected" class="leak-detail">
      <header class="detail-head">
        <h3>处置单详情 · {{ selected['处置编号'] }}</h3>
        <button type="button" class="link" @click="selectedId = null">关闭</button>
      </header>
      <dl class="detail-grid">
        <template v-for="column in columns" :key="column">
          <dt>{{ column }}</dt>
          <dd>{{ selected[column] ?? '—' }}</dd>
        </template>
        <dt>返工判定</dt>
        <dd :class="selected._verdict.rework ? 'error-text' : ''">
          {{ selected._verdict.rework ? '需返工（严重渗漏未采用注浆封堵）' : '不触发返工' }}
        </dd>
        <dt>可否完工</dt>
        <dd>{{ selected._verdict.canComplete ? '满足完工条件' : '不满足，按流程继续处置' }}</dd>
        <dt>历史结论</dt>
        <dd>{{ selected._verdict.locked ? `已判定锁定：${selected._verdict.lockedConclusion}，不随新规则改判` : '尚未锁定' }}</dd>
        <dt>备注</dt>
        <dd>{{ selected['备注'] || '—' }}</dd>
        <dt v-if="selected._verdict.notes.length">判定说明</dt>
        <dd v-if="selected._verdict.notes.length">
          <ul class="note-list">
            <li v-for="note in selected._verdict.notes" :key="note">{{ note }}</li>
          </ul>
        </dd>
      </dl>
      <footer class="detail-actions">
        <button
          v-for="action in availableActions(selected)"
          :key="action"
          class="btn"
          :class="{ primary: action === '确认完工' }"
          type="button"
          @click="runAction(action, selected)"
        >
          {{ action }}
        </button>
      </footer>
    </aside>

    <div v-if="registerOpen" class="modal-mask" @click.self="registerOpen = false">
      <form class="modal-card" @submit.prevent="submitRegister">
        <h3>登记渗漏处置单</h3>
        <p class="modal-hint">处置编号可留空，留空即按「待补录」处理；程度与方式按统一口径归一并判定。</p>
        <label class="modal-field"><span>处置编号（可空）</span><input v-model="registerForm.code" placeholder="如 LEAK-2026-023，留空按待补录" /></label>
        <label class="modal-field"><span>渗漏点位 *</span><input v-model="registerForm.point" required /></label>
        <label class="modal-field"><span>发现日期 *</span><input v-model="registerForm.foundDate" type="date" required /></label>
        <label class="modal-field">
          <span>渗漏程度 *</span>
          <select v-model="registerForm.degree" required>
            <option value="" disabled>请选择</option>
            <option>轻微渗漏</option>
            <option>中度渗漏</option>
            <option>严重渗漏</option>
          </select>
        </label>
        <label class="modal-field">
          <span>处置方式（可空，按程度下达标准工艺）</span>
          <select v-model="registerForm.method">
            <option value="">按渗漏程度自动下达</option>
            <option>注浆封堵</option>
            <option>引排水处理</option>
            <option>紧急加固</option>
          </select>
        </label>
        <label class="modal-field"><span>处置班组</span><input v-model="registerForm.crew" /></label>
        <footer class="modal-actions">
          <button type="button" class="btn ghost" @click="registerOpen = false">取消</button>
          <button type="submit" class="btn primary">提交登记</button>
        </footer>
      </form>
    </div>

    <div v-if="importOpen" class="modal-mask" @click.self="importOpen = false">
      <div class="modal-card">
        <h3>导入渗漏处置单</h3>
        <p class="modal-hint">
          支持 CSV / TSV / JSON，表头须含：处置编号,渗漏点位,发现日期,渗漏程度（处置方式可空）。
          整批任一校验失败则整笔退回；同一张处置单再次导入不会新增记录，差异只记备注。
        </p>
        <textarea v-model="importText" class="modal-textarea" rows="10" placeholder="处置编号,渗漏点位,渗漏程度,处置方式,处置班组,发现日期&#10;LEAK-2026-023,望江路舱 K0+500,严重渗漏,注浆封堵,堵漏一班,2026-10-06"></textarea>
        <footer class="modal-actions">
          <button type="button" class="btn ghost" @click="importOpen = false">取消</button>
          <button type="button" class="btn primary" @click="submitImport">整批导入</button>
        </footer>
      </div>
    </div>

    <div v-if="codePrompt" class="modal-mask" @click.self="codePrompt = null">
      <form class="modal-card" @submit.prevent="submitCode">
        <h3>补录处置编号</h3>
        <p class="modal-hint">编号缺失的处置单按待补录处理，补录后转入待处置。</p>
        <label class="modal-field"><span>处置编号 *</span><input v-model="codeInput" required placeholder="如 LEAK-2026-024" /></label>
        <footer class="modal-actions">
          <button type="button" class="btn ghost" @click="codePrompt = null">取消</button>
          <button type="submit" class="btn primary">保存编号</button>
        </footer>
      </form>
    </div>

    <footer class="page-foot">
      <span>共 {{ total }} 条渗漏水处置记录 · 另存清单 {{ archiveRows.length }} 条 · 待办 {{ todoTotal }} 条</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-else-if="successMessage" class="success-text">{{ successMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadLeakCsv,
  exportLeakArchiveCsv,
  getLeakEntry,
  importLeakEntries,
  leakArchive,
  leakStats,
  leakTodoGroups,
  listLeakEntries,
  registerLeak,
  runLeakAction,
} from '@/api/local-service'
import { LEAK_STATUSES, LEAK_STATUS, type ProjectedLeakRow } from '@/domain/leak'

const columns = ['处置编号', '渗漏点位', '渗漏程度', '处置方式', '处置班组', '发现日期', '完工日期', '处置状态']
const filterFields = columns.slice(0, 3)

const rows = ref<ProjectedLeakRow[]>([])
const archiveRows = ref<ProjectedLeakRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const successMessage = ref('')
const filters = ref<Record<string, string>>({})
const selectedId = ref<number | null>(null)
const activeTab = ref<'list' | 'archive' | 'todo'>('list')

const registerOpen = ref(false)
const registerForm = ref({ code: '', point: '', degree: '', method: '', crew: '', foundDate: '2026-10-06' })
const importOpen = ref(false)
const importText = ref('')
const codePrompt = ref<ProjectedLeakRow | null>(null)
const codeInput = ref('')

const stats = ref(leakStats())
const todoGroups = ref(leakTodoGroups())
const todoTotal = computed(() => todoGroups.value.reduce((sum, group) => sum + group.count, 0))

const statCards = computed(() => [
  { label: '待处置渗漏点', value: stats.value.waiting + stats.value.pendingCode, alert: false },
  { label: '处置中渗漏点', value: stats.value.working, alert: false },
  { label: '本月完工数', value: stats.value.finishedThisMonth, alert: false },
  { label: '需返工', value: stats.value.rework, alert: stats.value.rework > 0 },
])

const tabs = computed(() => [
  { key: 'list' as const, label: '处置清单', count: total.value },
  { key: 'archive' as const, label: '另存清单（已完工）', count: archiveRows.value.length },
  { key: 'todo' as const, label: '待办清单', count: todoTotal.value },
])

const statusSummary = computed(() =>
  LEAK_STATUSES.map((status: string) => ({
    status,
    count: rows.value.filter((row) => row.status === status).length,
  })),
)

const todoRows = computed<ProjectedLeakRow[]>(() => {
  const ids = new Set<number>()
  todoGroups.value.forEach((group) => group.items.forEach((item) => ids.add(item.id)))
  return rows.value.filter((row) => ids.has(Number(row.id)))
})

const displayedRows = computed(() =>
  activeTab.value === 'archive'
    ? archiveRows.value
    : activeTab.value === 'todo'
      ? todoRows.value
      : rows.value,
)

const selected = computed(() => {
  if (selectedId.value === null) return null
  return getLeakEntry(selectedId.value)
})

function statusClass(row: ProjectedLeakRow): string {
  switch (row.status) {
    case LEAK_STATUS.DONE:
      return 'tag-done'
    case LEAK_STATUS.REWORK:
      return 'tag-rework'
    case LEAK_STATUS.PENDING_CODE:
      return 'tag-pending'
    default:
      return 'tag-working'
  }
}

/** 可执行动作同样按唯一判定口径派生，页面不做第二遍业务判断。 */
function availableActions(row: ProjectedLeakRow): string[] {
  const verdict = row._verdict
  if (verdict.pendingCode) return ['补录编号']
  switch (verdict.status) {
    case LEAK_STATUS.WAITING:
      return ['派出处置']
    case LEAK_STATUS.WORKING:
      return ['确认完工', '要求返工']
    case LEAK_STATUS.REWORK:
      return ['重新派出处置', '要求返工']
    case LEAK_STATUS.DONE:
      return ['要求返工']
    default:
      return []
  }
}

function notify(message: string, ok = true): void {
  errorMessage.value = ok ? '' : message
  successMessage.value = ok ? message : ''
}

function reload(): void {
  errorMessage.value = ''
  successMessage.value = ''
  try {
    const payload = listLeakEntries(filters.value)
    rows.value = payload.items as unknown as ProjectedLeakRow[]
    total.value = payload.total
    archiveRows.value = leakArchive()
    stats.value = leakStats()
    todoGroups.value = leakTodoGroups()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '渗漏水处置列表读取失败'
  }
}

function resetFilters(): void {
  filters.value = {}
  reload()
}

function selectRow(id: number): void {
  selectedId.value = id
}

function exportRows(): void {
  downloadLeakCsv('list')
}

function exportArchive(): void {
  const file = exportLeakArchiveCsv()
  const blob = new Blob([file.content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = file.filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

function openRegister(): void {
  registerForm.value = { code: '', point: '', degree: '', method: '', crew: '', foundDate: '2026-10-06' }
  registerOpen.value = true
}

function submitRegister(): void {
  const result = registerLeak({
    code: registerForm.value.code.trim(),
    point: registerForm.value.point.trim(),
    degree: registerForm.value.degree,
    method: registerForm.value.method,
    crew: registerForm.value.crew.trim(),
    foundDate: registerForm.value.foundDate,
  })
  registerOpen.value = result.ok
  notify(result.message, result.ok)
  if (result.ok) reload()
}

function openImport(): void {
  importText.value = ''
  importOpen.value = true
}

function submitImport(): void {
  try {
    const result = importLeakEntries(importText.value)
    if (result.ok) {
      importOpen.value = false
      notify(result.message, true)
      reload()
    } else {
      notify(result.message, false)
    }
  } catch (error) {
    notify(error instanceof Error ? error.message : '导入失败', false)
  }
}

function runAction(action: string, row: ProjectedLeakRow): void {
  if (action === '补录编号') {
    codePrompt.value = row
    codeInput.value = ''
    return
  }
  try {
    const result = runLeakAction(Number(row.id), action)
    notify(result.message, result.ok)
    reload()
  } catch (error) {
    notify(error instanceof Error ? error.message : '操作失败，整笔退回', false)
  }
}

function submitCode(): void {
  if (!codePrompt.value) return
  const result = runLeakAction(Number(codePrompt.value.id), '补录编号', { code: codeInput.value.trim() })
  notify(result.message, result.ok)
  if (result.ok) {
    codePrompt.value = null
    selectedId.value = null
    reload()
  }
}

onMounted(reload)
</script>

<style scoped>
.leak-tabs {
  display: flex;
  gap: 8px;
  margin: 12px 0;
}
.leak-tab {
  border: 1px solid var(--border-color, #d8dee8);
  background: #fff;
  border-radius: 6px;
  padding: 6px 14px;
  cursor: pointer;
  color: #465064;
}
.leak-tab.active {
  border-color: #2f6fed;
  color: #2f6fed;
  font-weight: 600;
}
.cell-clickable {
  cursor: pointer;
}
.badge {
  display: inline-block;
  margin-left: 6px;
  padding: 0 6px;
  border-radius: 4px;
  font-size: 12px;
  background: #eef2f8;
  color: #5a6577;
}
.badge.warn {
  background: #fdf1e3;
  color: #b46312;
}
.status-tag {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 4px;
  font-size: 12px;
}
.tag-done { background: #e7f6ec; color: #1f7a3d; }
.tag-rework { background: #fdecec; color: #c0392b; }
.tag-pending { background: #fff6df; color: #9a6b08; }
.tag-working { background: #e9f1fe; color: #2f6fed; }
.stat-value.alert { color: #c0392b; }
.leak-detail {
  margin-top: 16px;
  border: 1px solid #d8dee8;
  border-radius: 8px;
  padding: 16px;
  background: #fbfcfe;
}
.detail-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 10px;
}
.detail-grid {
  display: grid;
  grid-template-columns: 96px 1fr 96px 1fr;
  gap: 6px 12px;
  margin: 0;
  font-size: 13px;
}
.detail-grid dt { color: #6b7485; }
.detail-grid dd { margin: 0; }
.note-list { margin: 0; padding-left: 18px; }
.detail-actions {
  margin-top: 12px;
  display: flex;
  gap: 8px;
}
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(20, 28, 42, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 20;
}
.modal-card {
  background: #fff;
  border-radius: 10px;
  padding: 20px;
  width: 520px;
  max-width: calc(100vw - 32px);
  box-shadow: 0 12px 40px rgba(20, 28, 42, 0.2);
}
.modal-hint {
  font-size: 12px;
  color: #6b7485;
  margin: 4px 0 12px;
}
.modal-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 10px;
  font-size: 13px;
  color: #465064;
}
.modal-field input,
.modal-field select,
.modal-textarea {
  border: 1px solid #d8dee8;
  border-radius: 6px;
  padding: 7px 10px;
  font-size: 13px;
  width: 100%;
  box-sizing: border-box;
}
.modal-textarea {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 12px;
}
.success-text { color: #1f7a3d; }
</style>
