import {
  applyVerdict,
  diffLeakFields,
  judgeLeakDisposal,
  leakSummary,
  orderLeakForExport,
  todayIso,
  type LeakSummary,
} from '@/domain/leak-disposal'
import { allRows, listRows, resetRows, saveRows, transact } from '@/data/local-store'
import { MODULE_BY_KEY } from '@/data/modules'
import type { ActionResult, EntryRow, ImportResult, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  if (key === 'leak') {
    return runLeakAction(meta, id, action)
  }
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

// 渗漏处置单的动作流转：返工判定调 domain 里那一份共用实现，
// 判定结论与状态在同一个事务里落库，任何一步失败整笔退回。
function runLeakAction(meta: ModuleMeta, id: number, action: string): ActionResult {
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(meta.key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const row = rows[index]
  const current = String(row.status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const verdict = judgeLeakDisposal(row)
  if (verdict.conclusion === '待补录') {
    return { ok: false, message: `${meta.entity}待补录：处置编号缺失，补录后才能${action}` }
  }
  if (action === '派出处置' && current !== '待处置' && current !== '需返工') {
    return { ok: false, message: `当前状态「${current}」不能派出处置` }
  }
  if (action === '要求返工' && current !== '处置中' && current !== '已完工') {
    return { ok: false, message: `当前状态「${current}」不能要求返工` }
  }
  if (action === '确认完工') {
    if (current !== '处置中') {
      return { ok: false, message: `当前状态「${current}」不能确认完工` }
    }
    if (verdict.needsRework) {
      return { ok: false, message: `统一判定为需返工（${verdict.note}），不能确认完工` }
    }
  }
  // 人工要求返工可以覆盖「免返工」的判定，结论与原因照样写回记录，只有这一处能改判定。
  const finalVerdict =
    action === '要求返工' && !verdict.needsRework
      ? { ...verdict, conclusion: '需返工' as const, note: `人工要求返工；${verdict.note}` }
      : verdict
  const today = todayIso()
  const updated = applyVerdict(
    {
      ...row,
      status: target,
      pending: target !== '已完工',
      abnormal: action === '要求返工',
      ...(action === '确认完工' ? { 完工日期: today } : {}),
    },
    { ...finalVerdict, baseDate: today },
  )
  try {
    transact((draft) => {
      const currentRows = draft[meta.key] ?? []
      const at = currentRows.findIndex((item) => Number(item.id) === id)
      if (at < 0) {
        throw new Error(`落库时没有找到编号为 ${id} 的${meta.entity}，已整笔退回`)
      }
      const next = [...currentRows]
      next[at] = updated
      draft[meta.key] = next
    })
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '落库失败，已整笔退回' }
  }
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

// 重复上报的归并键：有处置编号按编号，缺编号按「点位+发现日期」兜底。
function leakDedupKey(row: EntryRow): string {
  const code = String(row['处置编号'] ?? '').trim()
  if (code) {
    return `编号:${code}`
  }
  const point = String(row['渗漏点位'] ?? '').trim()
  const date = String(row['发现日期'] ?? '').trim()
  return point || date ? `点位:${point}|${date}` : ''
}

// 解析导入文本：带表头（导出格式）按列名对齐，不带表头按模块字段顺序对位；
// 任何一行字段数对不上直接抛错，整笔退回，一条都不落库。
function parseLeakCsv(input: string, fields: string[]): EntryRow[] {
  const lines = input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
  if (lines.length === 0) {
    return []
  }
  const first = lines[0].split(',').map((cell) => cell.trim())
  const hasHeader = first.includes('处置编号') || first[0] === '编号'
  const header = hasHeader ? first : fields
  const rows: EntryRow[] = []
  const dataLines = hasHeader ? lines.slice(1) : lines
  dataLines.forEach((line, offset) => {
    const cells = line.split(',').map((cell) => cell.trim())
    if (cells.length !== header.length) {
      throw new Error(`第 ${offset + 1} 行字段数与表头不一致，已整笔退回`)
    }
    const row: EntryRow = { id: 0, status: '待处置', pending: true, abnormal: false }
    header.forEach((name, i) => {
      if (fields.includes(name)) {
        row[name] = cells[i]
      }
    })
    rows.push(row)
  })
  return rows
}

// 导入处置单：同一张单子再次导入不会多出记录——首报内容为准，后续差异只记备注。
export function importLeakEntries(input: string): ImportResult {
  const meta = moduleMeta('leak')
  let incoming: EntryRow[]
  try {
    incoming = parseLeakCsv(input, meta.fields)
  } catch (error) {
    return {
      ok: false,
      added: 0,
      duplicates: 0,
      noted: 0,
      message: error instanceof Error ? error.message : '导入文本解析失败，已整笔退回',
    }
  }
  if (incoming.length === 0) {
    return { ok: false, added: 0, duplicates: 0, noted: 0, message: '没有可导入的处置单' }
  }
  const today = todayIso()
  try {
    return transact((draft) => {
      const rows = [...(draft[meta.key] ?? [])]
      const indexByKey = new Map<string, number>()
      rows.forEach((row, i) => {
        const key = leakDedupKey(row)
        if (key && !indexByKey.has(key)) {
          indexByKey.set(key, i)
        }
      })
      let maxId = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0)
      let added = 0
      let duplicates = 0
      let noted = 0
      for (const item of incoming) {
        const key = leakDedupKey(item)
        const hit = key ? indexByKey.get(key) : undefined
        if (hit !== undefined) {
          duplicates += 1
          const diffs = diffLeakFields(rows[hit], item, meta.fields)
          if (diffs.length > 0) {
            noted += 1
            const memo = String(rows[hit]['备注'] ?? '').trim()
            rows[hit] = {
              ...rows[hit],
              备注: [memo, `重复上报差异（${today}）：${diffs.join('；')}`]
                .filter(Boolean)
                .join('\n'),
            }
          }
          continue
        }
        const baseDate = String(item['发现日期'] ?? '').trim() || today
        const row = applyVerdict(
          { ...item, id: (maxId += 1), status: '待处置', pending: true, abnormal: false },
          judgeLeakDisposal(item, baseDate),
        )
        if (key) {
          indexByKey.set(key, rows.length)
        }
        rows.push(row)
        added += 1
      }
      draft[meta.key] = rows
      return {
        ok: true,
        added,
        duplicates,
        noted,
        message: `导入完成：新增 ${added} 条，重复 ${duplicates} 条（其中 ${noted} 条差异已记入备注）`,
      }
    })
  } catch (error) {
    return {
      ok: false,
      added: 0,
      duplicates: 0,
      noted: 0,
      message: error instanceof Error ? error.message : '导入未落库，已整笔退回',
    }
  }
}

// 值班台账要看的渗漏关键数值：与渗漏列表、运营概览待办读同一份数据，条数一致。
export function leakDutySummary(): LeakSummary {
  return leakSummary(listRows('leak'))
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  // 另存清单的列与字段不变；渗漏模块只按记录上同一份判定定先后。
  const source = key === 'leak' ? orderLeakForExport(listRows(key)) : listRows(key)
  for (const row of source) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
