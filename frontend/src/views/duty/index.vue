<template>
  <section class="page" data-module="duty">
    <header class="page-head">
      <div>
        <h2>运维值班交接管理</h2>
        <p class="page-desc">存量台账按交接班次迁移，缺项补齐或显式留空；渗漏待办按同一口径归集，条数与渗漏页一致。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记值班交接记录</button>
        <button class="btn" type="button" @click="exportRows">导出运维值班交接清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in statCards" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value" :class="{ alert: item.alert }">{{ item.value }}</strong>
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
          <td v-for="column in columns" :key="column" :class="{ blank: String(row[column] ?? '').trim() === '' }">
            {{ row[column] === '' || row[column] === undefined ? '（留空）' : row[column] }}
          </td>
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
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无运维值班交接数据，可先登记值班交接记录</td>
        </tr>
      </tbody>
    </table>

    <section class="duty-sync">
      <header class="sync-head">
        <h3>渗漏待办按交接班次归集</h3>
        <span class="sync-hint">与渗漏页「待办清单」同一份数据，合计 {{ todoTotal }} 条；匹配不到在册班次的显式归入「未排入班次」</span>
      </header>
      <table class="data-table">
        <thead>
          <tr><th>交接班次</th><th>待办条数</th><th>其中需返工</th><th>待办处置单</th></tr>
        </thead>
        <tbody>
          <tr v-for="group in todoGroups" :key="group.shift">
            <td>{{ group.shift }}</td>
            <td>{{ group.count }}</td>
            <td :class="{ 'error-text': group.reworkCount > 0 }">{{ group.reworkCount }}</td>
            <td>
              <span v-for="item in group.items" :key="item.id" class="todo-chip" :class="{ rework: item.status === '需返工' }">
                {{ item.code }} · {{ item.point }} · {{ item.foundDate }} · {{ item.status }}
              </span>
            </td>
          </tr>
          <tr v-if="!todoGroups.length">
            <td colspan="4" class="empty-state">暂无渗漏待办</td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条值班交接记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  leakStats,
  leakTodoGroups,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('duty')
const columns = ['交接编号', '值班班组', '值班日期', '班次', '值班人员', '交接事项', '交接人员', '交接状态']
const actions = ['发起交接', '确认交接', '登记遗留']
const statuses = ['待交接', '交接中', '已交接', '有遗留']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const stats = ref(leakStats())
const todoGroups = ref(leakTodoGroups())
const todoTotal = computed(() => todoGroups.value.reduce((sum, group) => sum + group.count, 0))

const statCards = computed(() => [
  { label: '待交接班次', value: rows.value.filter((row) => String(row.status) === '待交接').length, alert: false },
  { label: '已交接班次', value: rows.value.filter((row) => String(row.status) === '已交接').length, alert: false },
  { label: '有遗留事项', value: rows.value.filter((row) => String(row.status) === '有遗留').length, alert: true },
  // 关键数值反映到值班台账：与渗漏页同源，两处条数一致
  { label: '渗漏待办条数', value: todoTotal.value, alert: todoTotal.value > 0 },
  { label: '渗漏需返工', value: stats.value.rework, alert: stats.value.rework > 0 },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '值班交接记录登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
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
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    stats.value = leakStats()
    todoGroups.value = leakTodoGroups()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '运维值班交接列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.blank { color: #97a0af; }
.stat-value.alert { color: #c0392b; }
.duty-sync {
  margin-top: 20px;
  border: 1px solid #d8dee8;
  border-radius: 8px;
  padding: 14px 16px;
  background: #fbfcfe;
}
.sync-head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 8px;
}
.sync-head h3 { margin: 0; font-size: 15px; }
.sync-hint { font-size: 12px; color: #6b7485; }
.todo-chip {
  display: inline-block;
  margin: 2px 6px 2px 0;
  padding: 1px 8px;
  border-radius: 10px;
  background: #e9f1fe;
  color: #2f6fed;
  font-size: 12px;
}
.todo-chip.rework { background: #fdecec; color: #c0392b; }
</style>
