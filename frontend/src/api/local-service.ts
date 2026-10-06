import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, commitEntries, listRows, resetRows, saveRows } from '@/data/local-store'
import {
  LEAK_STATUS,
  PENDING_CODE_TEXT,
  buildLeakArchive,
  compareByFoundDate,
  duplicateRemark,
  leakIdentityKey,
  parseLeakImport,
  projectLeakRow,
  resolveLeakVerdict,
  standardMethodFor,
  toLeakCsv,
  type LeakDraft,
  type ProjectedLeakRow,
} from '@/domain/leak'
import { groupLeakTodosByShift } from '@/domain/duty'
import type {
  ActionResult,
  EntryRow,
  LeakImportResult,
  ModuleMeta,
  OverviewResult,
  PageResult,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

function todayText(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

function appendRemark(row: EntryRow, remark: string): string {
  const current = String(row['备注'] ?? '').trim()
  if (!current) return remark
  if (current.includes(remark)) return current
  return `${current}；${remark}`
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

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

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
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

// ===========================================================================
// 渗漏水处置：列表 / 动作 / 另存归档 / 导入，全部走 domain/leak.ts 这一份判定
// ===========================================================================

const DEGREE_RANK: Record<string, number> = { 严重渗漏: 3, 中度渗漏: 2, 轻微渗漏: 1 }

function commitLeak(rows: EntryRow[]): void {
  commitEntries({ ...allRows(), leak: rows })
}

/** 列表：处置编号缺失按待补录显示，结论直接投影唯一判定结果，不另算。 */
export function listLeakEntries(filters: Record<string, string> = {}): PageResult {
  const projected = listRows('leak')
    .map(projectLeakRow)
    .sort((a, b) => {
      // 列表按渗漏程度从高到低排，同程度按发现日期先后
      const rankDiff = (DEGREE_RANK[b._verdict.degree ?? ''] ?? 0) - (DEGREE_RANK[a._verdict.degree ?? ''] ?? 0)
      if (rankDiff !== 0) return rankDiff
      return compareByFoundDate(a, b)
    })
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  const matched = pairs.length
    ? projected.filter((row) =>
        pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
      )
    : projected
  return { items: matched as unknown as EntryRow[], total: matched.length, page: 1, size: matched.length }
}

export function getLeakEntry(id: number): ProjectedLeakRow | null {
  const row = listRows('leak').find((item) => Number(item.id) === id)
  return row ? projectLeakRow(row) : null
}

export type LeakStats = {
  waiting: number
  working: number
  finishedThisMonth: number
  rework: number
  pendingCode: number
}

/** 关键数值的唯一出口，列表、值班台账都读它。 */
export function leakStats(month: string = todayText().slice(0, 7)): LeakStats {
  const stats: LeakStats = { waiting: 0, working: 0, finishedThisMonth: 0, rework: 0, pendingCode: 0 }
  for (const row of listRows('leak')) {
    const verdict = resolveLeakVerdict(row)
    switch (verdict.status) {
      case LEAK_STATUS.WAITING:
        stats.waiting += 1
        break
      case LEAK_STATUS.WORKING:
        stats.working += 1
        break
      case LEAK_STATUS.REWORK:
        stats.rework += 1
        break
      case LEAK_STATUS.PENDING_CODE:
        stats.pendingCode += 1
        break
      case LEAK_STATUS.DONE:
        if (String(row['完工日期'] ?? '').startsWith(month)) stats.finishedThisMonth += 1
        break
    }
  }
  return stats
}

/** 待办清单（渗漏页与值班台账同一份数据，两个入口条数必然一致）。 */
export function leakTodoGroups() {
  return groupLeakTodosByShift(listRows('leak'), listRows('duty'))
}

export function leakArchive(): ProjectedLeakRow[] {
  // 优先读持久化的归档分片；它在 commitEntries 里由同一份判定重建，
  // 与现算结论永远一致。这里对兜底场景再算一次也无妨（同一函数）。
  const stored = listRows('leakArchive')
  return stored.length ? (stored.map(projectLeakRow) as ProjectedLeakRow[]) : buildLeakArchive(listRows('leak'))
}

/**
 * 渗漏处置单动作。返工与完工的分界只在 resolveLeakVerdict.canComplete / rework 里，
 * 这里只负责按那份结论落锁、同步归档与待办（同一笔提交）。
 */
export function runLeakAction(id: number, action: string, payload: { code?: string } = {}): ActionResult {
  const rows = listRows('leak')
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) return { ok: false, message: `没有找到编号为 ${id} 的渗漏处置单` }

  const row = rows[index]
  const verdict = resolveLeakVerdict(row)
  const updated: EntryRow = { ...row }
  const today = todayText()

  if (action === '派出处置' || action === '重新派出处置') {
    if (!([LEAK_STATUS.WAITING, LEAK_STATUS.REWORK] as string[]).includes(verdict.status)) {
      return { ok: false, message: `当前是「${verdict.status}」，不能派出处置` }
    }
    updated.status = LEAK_STATUS.WORKING
    // 上一轮的处置等级不能残留在记录上：重新派单时清掉旧锁，按新一轮现场工艺重新判定
    delete updated['判定锁定']
    delete updated['判定结论']
    if (!updated['处置方式'] || updated['处置方式'] === '') {
      const standard = standardMethodFor(verdict.degree)
      if (standard) updated['处置方式'] = standard
    }
    updated['处置状态'] = LEAK_STATUS.WORKING
    updated['完工日期'] = ''
    updated.pending = true
    updated.abnormal = false
    updated['备注'] = appendRemark(
      updated,
      verdict.status === LEAK_STATUS.REWORK
        ? `返工后重新派出处置（${today}），按新一轮处置方式重新判定`
        : `已派出处置（${today}），建议工艺：${updated['处置方式']}`,
    )
  } else if (action === '确认完工') {
    if (verdict.pendingCode) {
      return { ok: false, message: '处置编号缺失，需先补录编号后才能确认完工' }
    }
    if (verdict.status === LEAK_STATUS.DONE) {
      return { ok: false, message: '该处置单已完工，不用重复操作' }
    }
    if (verdict.degree === null) {
      return { ok: false, message: '渗漏程度未核定，不能确认完工；请先现场核定渗漏程度' }
    }
    if (verdict.method === null) {
      return { ok: false, message: '处置方式未记录，不能确认完工；请先补录实际采用的处置方式' }
    }
    if (!verdict.canComplete || verdict.rework) {
      // 分界只此一份：严重渗漏未注浆一律退回返工
      updated.status = LEAK_STATUS.REWORK
      updated['处置状态'] = LEAK_STATUS.REWORK
      updated['完工日期'] = ''
      updated['判定锁定'] = true
      updated['判定结论'] = LEAK_STATUS.REWORK
      updated.pending = true
      updated.abnormal = true
      rows[index] = updated
      commitLeak(rows)
      return {
        ok: false,
        message: '严重渗漏必须采用注浆封堵，当前处置方式不达标，已按「需返工」处理并从另存清单移除',
      }
    }
    updated.status = LEAK_STATUS.DONE
    updated['处置状态'] = LEAK_STATUS.DONE
    updated['完工日期'] = today
    updated['判定锁定'] = true
    updated['判定结论'] = LEAK_STATUS.DONE
    updated.pending = false
    updated.abnormal = false
    updated['备注'] = appendRemark(updated, `确认完工（${today}），判定结论锁定`)
  } else if (action === '要求返工') {
    if (verdict.pendingCode) {
      return { ok: false, message: '处置编号缺失，需先补录编号' }
    }
    updated.status = LEAK_STATUS.REWORK
    updated['处置状态'] = LEAK_STATUS.REWORK
    updated['完工日期'] = ''
    updated['判定锁定'] = true
    updated['判定结论'] = LEAK_STATUS.REWORK
    updated.pending = true
    updated.abnormal = true
    updated['备注'] = appendRemark(updated, `要求返工（${today}），判定结论锁定；需重新派出处置`)
  } else if (action === '补录编号') {
    if (!verdict.pendingCode) return { ok: false, message: '该处置单已有处置编号，无需补录' }
    const code = String(payload.code ?? '').trim()
    if (!code) return { ok: false, message: '补录编号不能为空' }
    if (rows.some((item) => String(item['处置编号'] ?? '').trim() === code)) {
      return { ok: false, message: `处置编号 ${code} 已存在，不能重复补录` }
    }
    updated['处置编号'] = code
    updated.status = LEAK_STATUS.WAITING
    updated['处置状态'] = LEAK_STATUS.WAITING
    updated.pending = true
    updated.abnormal = false
    updated['备注'] = appendRemark(updated, `处置编号补录为 ${code}（${today}），转入待处置`)
  } else {
    return { ok: false, message: `渗漏处置单没有登记「${action}」这个动作` }
  }

  rows[index] = updated
  commitLeak(rows) // 归档分片与待办在同一笔提交里同步变化
  const message =
    action === '确认完工'
      ? '处置单已确认完工并进入另存清单，返工/完工判定口径与列表一致'
      : action === '要求返工'
        ? '处置单已判定需返工，并从另存清单移除'
        : action === '补录编号'
          ? `处置编号已补录，当前状态「${LEAK_STATUS.WAITING}」`
          : verdict.status === LEAK_STATUS.REWORK
            ? '已按新一轮处置重新派出，旧判定等级已清除'
            : `处置单已派出，当前状态「${LEAK_STATUS.WORKING}」`
  return { ok: true, message }
}

/** 登记新渗漏处置单（同一张处置单再次登记不会多出一条记录）。 */
export function registerLeak(input: {
  code: string
  point: string
  degree: string
  method?: string
  crew?: string
  foundDate: string
}): LeakImportResult {
  const text = [
    '处置编号,渗漏点位,渗漏程度,处置方式,处置班组,发现日期',
    [
      input.code ?? '',
      input.point ?? '',
      input.degree ?? '',
      input.method ?? '',
      input.crew ?? '',
      input.foundDate ?? '',
    ]
      .map((value) => String(value).replace(/,/g, '，'))
      .join(','),
  ].join('\n')
  return importLeakEntries(text, { allowFinishDate: false })
}

/**
 * 批量导入（CSV/TSV/JSON）。整批校验通过后才整笔落库；
 * 重复上报只认第一次内容，后续差异追加到备注，不产生第二条记录。
 */
export function importLeakEntries(text: string, _options: { allowFinishDate?: boolean } = {}): LeakImportResult {
  const parsed = parseLeakImport(text)
  if (!parsed.ok) {
    return { ok: false, message: `导入整笔退回：${parsed.errors.join('；')}`, inserted: 0, pendingCode: 0, duplicated: 0, errors: parsed.errors }
  }

  const rows = listRows('leak')
  const identityIndex = new Map<string, number>()
  rows.forEach((row, index) => {
    const verdict = resolveLeakVerdict(row)
    identityIndex.set(leakIdentityKey(verdict.code, String(row['渗漏点位'] ?? ''), String(row['发现日期'] ?? '')), index)
  })

  const batchKeys = new Set<string>()
  let inserted = 0
  let pendingCode = 0
  let duplicated = 0
  let id = nextId(rows)
  const today = todayText()
  const next = [...rows]

  for (const draft of parsed.drafts as LeakDraft[]) {
    const key = leakIdentityKey(draft.code, draft.point, draft.foundDate)
    // 同一批文件里就有两张同一点位的单：不猜先后，整笔退回（最先判）
    if (batchKeys.has(key)) {
      return {
        ok: false,
        message: `导入整笔退回：同批文件中存在重复点位「${draft.point} ${draft.foundDate}」，请合并后再导入`,
        inserted: 0,
        pendingCode: 0,
        duplicated: 0,
      }
    }
    const existingIndex = identityIndex.get(key)
    if (existingIndex !== undefined) {
      duplicated += 1
      const existing = next[existingIndex]
      const times = Number(existing['上报次数'] ?? 1) + 1
      existing['上报次数'] = times
      existing['备注'] = appendRemark(existing, duplicateRemark(existing, draft, times, today))
      continue
    }
    batchKeys.add(key)
    const missingCode = draft.code === null
    const row: EntryRow = {
      id,
      status: missingCode ? LEAK_STATUS.PENDING_CODE : LEAK_STATUS.WAITING,
      pending: true,
      abnormal: false,
      处置编号: missingCode ? PENDING_CODE_TEXT : (draft.code as string),
      渗漏点位: draft.point,
      渗漏程度: draft.degree,
      处置方式: draft.method,
      处置班组: draft.crew,
      发现日期: draft.foundDate,
      完工日期: '',
      处置状态: missingCode ? LEAK_STATUS.PENDING_CODE : LEAK_STATUS.WAITING,
      上报次数: 1,
      备注: draft.ignoredFinishDate ? '导入按重新上报处理，原完工日期未采纳' : '',
    }
    if (missingCode) {
      pendingCode += 1
      row['备注'] = appendRemark(row, '处置编号缺失，按待补录处理')
    }
    next.push(row)
    identityIndex.set(key, next.length - 1)
    inserted += 1
    id += 1
  }

  // 全部校验、合并完成后才整笔提交；任一步异常 commitEntries 会抛出，旧数据不动
  commitEntries({ ...allRows(), leak: next })

  const notes: string[] = []
  if (inserted) notes.push(`新增 ${inserted} 条`)
  if (pendingCode) notes.push(`${pendingCode} 条处置编号缺失按待补录处理`)
  if (duplicated) notes.push(`重复上报 ${duplicated} 条，只认第一次内容，差异已记备注`)
  if (parsed.ignoredFinishCount) notes.push(`${parsed.ignoredFinishCount} 行带完工日期，按重新上报处理未采纳`)
  return {
    ok: true,
    message: notes.length ? `导入完成：${notes.join('；')}` : '没有可导入的数据',
    inserted,
    pendingCode,
    duplicated,
  }
}

/** 渗漏清单导出（8 列字段顺序不变）。 */
export function exportLeakCsv(): { filename: string; content: string } {
  return { filename: '渗漏水处置-清单.csv', content: toLeakCsv(listRows('leak').map(projectLeakRow)) }
}

/** 另存清单导出：已完工处置单，按发现日期先后，列与字段不变。 */
export function exportLeakArchiveCsv(): { filename: string; content: string } {
  return { filename: '渗漏水处置-另存清单.csv', content: toLeakCsv(leakArchive()) }
}

export function downloadLeakCsv(kind: 'list' | 'archive' = 'list'): void {
  const { filename, content } = kind === 'archive' ? exportLeakArchiveCsv() : exportLeakCsv()
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
