import type { EntryRow } from '@/data/types'

// 渗漏处置判定：渗漏程度、处置方式、返工判定只在这一个文件里算。
// 列表、动作流转、另存清单、详情面板、值班台账都从这里取结论，
// 返工与完工的分界只有一份判定，任何入口不再各自解释。

export type LeakConclusion = '需返工' | '免返工' | '待补录'

export type LeakVerdict = {
  level: number // 渗漏程度等级：1 轻微 / 2 一般 / 3 严重 / 4 涌水
  severityLabel: string
  methodLabel: string // 认定后的处置方式（归一化）
  methodCategory: '根治性' | '临时性' | '待补录'
  needsRework: boolean
  conclusion: LeakConclusion
  note: string // 判定说明：待补录原因、兜底认定、人工覆盖都写在这里
  baseDate: string // 判定基准日：存量回填用发现日期，新判定用当天
}

// 判定结论落在行上的字段名（不在模块 fields 里，另存清单的列因此不变）。
export const VERDICT_KEYS = ['处置等级', '处置方式认定', '返工判定', '判定说明', '判定基准日'] as const

export function todayIso(now: Date = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function text(value: unknown): string {
  return String(value ?? '').trim()
}

// 渗漏程度归一化：按关键词从高到低匹配，空值与无法识别一律按「一般」兜底并写说明。
const SEVERITY_RULES: [RegExp, number, string][] = [
  [/涌水|喷涌|突涌/, 4, '涌水'],
  [/严重|流淌|线流|射流/, 3, '严重'],
  [/一般|渗漏|滴水|滴漏/, 2, '一般'],
  [/轻微|潮湿|渗水|湿润/, 1, '轻微'],
]

export function normalizeSeverity(raw: unknown): { level: number; label: string; note: string } {
  const value = text(raw)
  if (!value) {
    return { level: 2, label: '一般', note: '渗漏程度未登记，按一般认定' }
  }
  for (const [pattern, level, label] of SEVERITY_RULES) {
    if (pattern.test(value)) {
      return { level, label, note: '' }
    }
  }
  return { level: 2, label: '一般', note: `渗漏程度「${value}」无法识别，按一般认定` }
}

// 处置方式认定：注浆堵漏、结构加固为根治性；引排导流、表面封堵为临时性；
// 空值记待补录，无法识别的按临时性兜底（宁严勿宽），都写进判定说明。
const METHOD_RULES: [RegExp, string, '根治性' | '临时性'][] = [
  [/注浆|灌浆|堵漏/, '注浆堵漏', '根治性'],
  [/加固|衬砌|结构修补/, '结构加固', '根治性'],
  [/引排|导流|排水/, '引排导流', '临时性'],
  [/封堵|涂刷|抹面|表面/, '表面封堵', '临时性'],
]

export function normalizeMethod(raw: unknown): {
  label: string
  category: '根治性' | '临时性' | '待补录'
  note: string
} {
  const value = text(raw)
  if (!value) {
    return { label: '待补录', category: '待补录', note: '处置方式未登记' }
  }
  for (const [pattern, label, category] of METHOD_RULES) {
    if (pattern.test(value)) {
      return { label, category, note: '' }
    }
  }
  return { label: '临时性处置', category: '临时性', note: `处置方式「${value}」无法识别，按临时性处置认定` }
}

// 返工与完工的唯一分界：渗漏程度严重及以上（level >= 3）且处置方式不是根治性 → 需返工。
// 处置编号缺失的单据不参与分界，一律按待补录处理并说明。
export function judgeLeakDisposal(row: EntryRow, baseDate: string = todayIso()): LeakVerdict {
  const severity = normalizeSeverity(row['渗漏程度'])
  const method = normalizeMethod(row['处置方式'])
  const extraNotes = [severity.note, method.note].filter(Boolean)

  if (!text(row['处置编号'])) {
    return {
      level: severity.level,
      severityLabel: severity.label,
      methodLabel: method.label,
      methodCategory: method.category,
      needsRework: false,
      conclusion: '待补录',
      note: ['处置编号缺失，按待补录处理：补录处置编号后再参与返工判定', ...extraNotes].join('；'),
      baseDate,
    }
  }

  const needsRework = severity.level >= 3 && method.category !== '根治性'
  const boundary = needsRework
    ? `渗漏程度${severity.label}且处置方式${method.label}属临时性，判定需返工`
    : `渗漏程度${severity.label}、处置方式${method.label}，判定免返工`
  return {
    level: severity.level,
    severityLabel: severity.label,
    methodLabel: method.label,
    methodCategory: method.category,
    needsRework,
    conclusion: needsRework ? '需返工' : '免返工',
    note: [boundary, ...extraNotes].join('；'),
    baseDate,
  }
}

// 把判定结论写回行记录：判定与状态流转在同一个事务里落库，记录上不会残留上一轮结论。
export function applyVerdict(row: EntryRow, verdict: LeakVerdict): EntryRow {
  return {
    ...row,
    处置等级: verdict.severityLabel,
    处置方式认定: verdict.methodLabel,
    返工判定: verdict.conclusion,
    判定说明: verdict.note,
    判定基准日: verdict.baseDate,
  }
}

// 读结论：记录上已有判定就用记录上的（已判定过的不改等级），没有才现场算一份兜底。
export function verdictOf(row: EntryRow): LeakVerdict {
  const stored = text(row['返工判定'])
  if (stored === '需返工' || stored === '免返工' || stored === '待补录') {
    return {
      level: 0,
      severityLabel: text(row['处置等级']) || '—',
      methodLabel: text(row['处置方式认定']) || '—',
      methodCategory: '待补录',
      needsRework: stored === '需返工',
      conclusion: stored,
      note: text(row['判定说明']),
      baseDate: text(row['判定基准日']),
    }
  }
  return judgeLeakDisposal(row)
}

export type LeakSummary = {
  total: number
  待处置: number
  处置中: number
  需返工: number
  已完工: number
  待补录: number
  待办: number
  本月完工: number
}

// 渗漏关键数值：统计卡片、值班台账要情、待办清单都从这一份算，两处条数自然一致。
export function leakSummary(rows: EntryRow[], today: string = todayIso()): LeakSummary {
  const month = today.slice(0, 7)
  const byStatus = (status: string) => rows.filter((row) => String(row.status) === status).length
  return {
    total: rows.length,
    待处置: byStatus('待处置'),
    处置中: byStatus('处置中'),
    需返工: byStatus('需返工'),
    已完工: byStatus('已完工'),
    待补录: rows.filter((row) => verdictOf(row).conclusion === '待补录').length,
    待办: rows.filter((row) => row.pending).length,
    本月完工: rows.filter(
      (row) => String(row.status) === '已完工' && text(row['完工日期']).startsWith(month),
    ).length,
  }
}

// 重复上报只认第一次的内容：逐字段对比，差异只生成备注文字，不覆盖原记录。
export function diffLeakFields(existing: EntryRow, incoming: EntryRow, fields: string[]): string[] {
  return fields
    .filter((field) => text(existing[field]) !== text(incoming[field]))
    .map((field) => `${field}「${text(existing[field]) || '空'}→${text(incoming[field]) || '空'}」`)
}

// 另存清单的先后：需返工在前、待补录其次、其余按发现日期升序，读的是记录上同一份判定。
export function orderLeakForExport(rows: EntryRow[]): EntryRow[] {
  const rank = (row: EntryRow): number => {
    const conclusion = verdictOf(row).conclusion
    if (conclusion === '需返工') return 0
    if (conclusion === '待补录') return 1
    return 2
  }
  return [...rows].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      text(a['发现日期']).localeCompare(text(b['发现日期'])) ||
      Number(a.id) - Number(b.id),
  )
}
