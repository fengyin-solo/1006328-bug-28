<template>
  <section class="page" data-module="leak">
    <header class="page-head">
      <div>
        <h2>渗漏水处置管理</h2>
        <p class="page-desc">维护渗漏处置单，围绕处置编号、渗漏点位、渗漏程度、处置方式做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记渗漏处置单</button>
        <button class="btn" type="button" @click="exportRows">导出渗漏水处置清单</button>
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
      <span class="legend-item">待补录：{{ summary.待补录 }}</span>
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
          <th>返工判定</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td>{{ verdictOf(row).conclusion }}</td>
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
            <button class="link" type="button" @click="selectRow(row)">详情</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无渗漏水处置数据，可先登记渗漏处置单</td>
        </tr>
      </tbody>
    </table>

    <section v-if="selected" class="detail-panel">
      <header class="detail-head">
        <h3>处置单详情：{{ selected['处置编号'] || '待补录' }}</h3>
        <button class="btn ghost" type="button" @click="selected = null">收起</button>
      </header>
      <dl class="detail-grid">
        <template v-for="column in columns" :key="column">
          <dt>{{ column }}</dt>
          <dd>{{ selected[column] ?? '—' }}</dd>
        </template>
        <dt>当前状态</dt>
        <dd>{{ selected.status }}</dd>
        <dt>处置等级</dt>
        <dd>{{ selectedVerdict?.severityLabel ?? '—' }}</dd>
        <dt>处置方式认定</dt>
        <dd>{{ selectedVerdict?.methodLabel ?? '—' }}</dd>
        <dt>返工判定</dt>
        <dd>{{ selectedVerdict?.conclusion ?? '—' }}</dd>
        <dt>判定说明</dt>
        <dd>{{ selectedVerdict?.note || '—' }}</dd>
        <dt>判定基准日</dt>
        <dd>{{ selectedVerdict?.baseDate || '—' }}</dd>
        <dt>备注</dt>
        <dd class="memo">{{ selected['备注'] || '—' }}</dd>
      </dl>
    </section>

    <section class="import-panel">
      <header class="detail-head">
        <h3>导入处置单（CSV，可带导出表头）</h3>
      </header>
      <textarea
        v-model="importText"
        rows="4"
        placeholder="粘贴 CSV 内容：同一张处置单重复导入不会多出记录，差异只记入备注"
      ></textarea>
      <div class="page-actions">
        <button class="btn" type="button" @click="runImport">导入处置单</button>
      </div>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条渗漏水处置记录</span>
      <span v-if="infoMessage" class="info-text">{{ infoMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  importLeakEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { leakSummary, verdictOf, type LeakVerdict } from '@/domain/leak-disposal'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('leak')
const columns = ["处置编号", "渗漏点位", "渗漏程度", "处置方式", "处置班组", "发现日期", "完工日期", "处置状态"]
const actions = ["派出处置", "确认完工", "要求返工"]
const statuses = ["待处置", "处置中", "已完工", "需返工"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const infoMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const selected = ref<EntryRow | null>(null)
const importText = ref('')

// 统计卡片、状态分布、值班台账要情都走 domain 里同一份汇总，条数一致。
const summary = computed(() => leakSummary(rows.value))
const stats = computed(() => [
  { label: '待处置渗漏点', value: summary.value.待处置 },
  { label: '处置中渗漏点', value: summary.value.处置中 },
  { label: '本月完工数', value: summary.value.本月完工 },
])
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)
const selectedVerdict = computed<LeakVerdict | null>(() =>
  selected.value ? verdictOf(selected.value) : null,
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '渗漏处置单登记入口尚未接入审批流'
}

function selectRow(row: EntryRow) {
  selected.value = row
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  infoMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  infoMessage.value = result.message
  reload()
}

function runImport() {
  errorMessage.value = ''
  infoMessage.value = ''
  const result = importLeakEntries(importText.value)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  infoMessage.value = result.message
  importText.value = ''
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    if (selected.value) {
      selected.value = payload.items.find((row) => Number(row.id) === Number(selected.value?.id)) ?? null
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '渗漏水处置列表读取失败'
  }
}

onMounted(reload)
</script>
