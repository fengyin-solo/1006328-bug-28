/**
 * 渗漏水处置 —— 全模块唯一判定口径。
 *
 * 列表排序时的预判、「要求返工 / 确认完工」动作、另存归档的先后顺序、
 * 导入去重、值班台账联动，全部只读这里的函数，不再各写一遍。
 *
 * 本文件为纯函数，不依赖 Vue / DOM / localStorage，可直接被 Node 脚本引用验证。
 */

// ---- 常量：列与字段即契约，另存清单永远是这 8 列，不许多也不许少 ----

export const LEAK_COLUMNS = [
  '处置编号',
  '渗漏点位',
  '渗漏程度',
  '处置方式',
  '处置班组',
  '发现日期',
  '完工日期',
  '处置状态',
] as const

export const LEAK_STATUS = {
  WAITING: '待处置',
  WORKING: '处置中',
  DONE: '已完工',
  REWORK: '需返工',
  PENDING_CODE: '待补录',
} as const

export const LEAK_STATUSES = [
  LEAK_STATUS.WAITING,
  LEAK_STATUS.WORKING,
  LEAK_STATUS.DONE,
  LEAK_STATUS.REWORK,
  LEAK_STATUS.PENDING_CODE,
]

export type LeakDegree = '轻微渗漏' | '中度渗漏' | '严重渗漏'
export type LeakMethod = '注浆封堵' | '引排水处理' | '紧急加固'

export const DEGREE_ORDER: LeakDegree[] = ['轻微渗漏', '中度渗漏', '严重渗漏']

/** 显式留空 / 待补录的统一写法，页面与导出都用这两个字面量。 */
export const BLANK = '（留空）'
export const PENDING_CODE_TEXT = '（待补录）'

// ---- 取值归一：历史数据、导入数据、勾选数据共用同一张别名表 ----

const DEGREE_ALIASES: Record<string, LeakDegree> = {
  轻微渗漏: '轻微渗漏',
  轻微: '轻微渗漏',
  轻度: '轻微渗漏',
  渗水: '轻微渗漏',
  湿渍: '轻微渗漏',
  慢渗: '轻微渗漏',
  中度渗漏: '中度渗漏',
  中度: '中度渗漏',
  中等: '中度渗漏',
  滴漏: '中度渗漏',
  线漏: '中度渗漏',
  严重渗漏: '严重渗漏',
  严重: '严重渗漏',
  重度: '严重渗漏',
  涌水: '严重渗漏',
  管涌: '严重渗漏',
  大量渗漏: '严重渗漏',
}

const METHOD_ALIASES: Record<string, LeakMethod> = {
  注浆封堵: '注浆封堵',
  注浆: '注浆封堵',
  灌浆: '注浆封堵',
  化学灌浆: '注浆封堵',
  灌浆封堵: '注浆封堵',
  压力注浆: '注浆封堵',
  引排水处理: '引排水处理',
  引排: '引排水处理',
  引排水: '引排水处理',
  排水引流: '引排水处理',
  开槽引排: '引排水处理',
  紧急加固: '紧急加固',
  临时加固: '紧急加固',
  支撑加固: '紧急加固',
  加固: '紧急加固',
}

export function normalizeDegree(raw: unknown): LeakDegree | null {
  if (raw === null || raw === undefined) return null
  const key = String(raw).trim()
  if (key === '' || key === BLANK) return null
  return DEGREE_ALIASES[key] ?? null
}

export function normalizeMethod(raw: unknown): LeakMethod | null {
  if (raw === null || raw === undefined) return null
  const key = String(raw).trim()
  if (key === '' || key === BLANK) return null
  return METHOD_ALIASES[key] ?? null
}

/**
 * 按渗漏程度下达标准处置方式（派工建议 / 历史单据缺方式时的回填口径）。
 * 中度及以上一律注浆封堵；轻微渗漏先引排水处理。
 */
export function standardMethodFor(degree: LeakDegree | null): LeakMethod | null {
  if (degree === null) return null
  if (degree === '轻微渗漏') return '引排水处理'
  return '注浆封堵'
}

/**
 * 返工判定的唯一分界，全模块只此一份：
 * 严重渗漏必须注浆封堵，其余等级只要方式落实即达标。
 * 程度未核定时不臆断返工（交由人工核定），返回 false。
 */
export function reworkRequired(degree: LeakDegree | null, method: LeakMethod | null): boolean {
  return degree === '严重渗漏' && method !== null && method !== '注浆封堵'
}

// ---- 行结构 ----

export type LeakInput = {
  id?: number
  status?: unknown
  [field: string]: unknown
}

export type LeakVerdict = {
  /** 处置编号缺失时为 null（按待补录处理） */
  code: string | null
  pendingCode: boolean
  degree: LeakDegree | null
  /** 列表 / 详情 / 归档统一展示的渗漏程度文案 */
  degreeText: string
  method: LeakMethod | null
  /** 列表 / 详情 / 归档统一展示的处置方式文案 */
  methodText: string
  /** 是否落在返工分界上（唯一判定口径） */
  rework: boolean
  /** 「确认完工」动作是否放行（返工与完工的分界只保留这一份） */
  canComplete: boolean
  /** 权威展示状态，三个入口读到的都是它 */
  status: string
  /** 历史已判定单据：结论锁定，不因新规则改判 */
  locked: boolean
  lockedConclusion: '已完工' | '需返工' | ''
  notes: string[]
}

export function isMissingCode(raw: unknown): boolean {
  if (raw === null || raw === undefined) return true
  const key = String(raw).trim()
  return key === '' || key === PENDING_CODE_TEXT || key === BLANK
}

/** 空值统一渲染成显式留空（迁移时也用同一个判定）。 */
export function textOrBlank(value: unknown): string {
  if (value === null || value === undefined) return BLANK
  const text = String(value).trim()
  return text === '' ? BLANK : text
}

/**
 * 读一条渗漏处置单的权威结论。
 *
 * - 已经判定过（判定锁定）的单据：原样保留历史结论，已完工不翻成需返工，
 *   需返工不因换工艺自动脱锁；历史单据按发现日期保留原判。
 * - 未锁定单据：渗漏程度 → 处置方式 → 返工判定在同一处一次算完，
 *   列表、动作、另存归档都拿这份结果。
 */
export function resolveLeakVerdict(row: LeakInput): LeakVerdict {
  const rawStatus = String(row.status ?? '').trim()
  const code = isMissingCode(row['处置编号']) ? null : String(row['处置编号']).trim()
  const pendingCode = code === null
  const degree = normalizeDegree(row['渗漏程度'])
  const method = normalizeMethod(row['处置方式'])
  const notes: string[] = []

  const degreeText =
    degree ?? (textOrBlank(row['渗漏程度']) === BLANK ? '未核定' : `${textOrBlank(row['渗漏程度'])}（未核定）`)
  if (degree === null && rawStatus !== LEAK_STATUS.PENDING_CODE) {
    notes.push('渗漏程度未核定，需先现场核定后才能完工')
  }

  // ---- 已判定单据：历史结论原样保留，只做取值归一显示，不改等级 ----
  const locked = row['判定锁定'] === true
  const rawConclusion = String(row['判定结论'] ?? '').trim()
  if (locked && (rawConclusion === LEAK_STATUS.DONE || rawConclusion === LEAK_STATUS.REWORK)) {
    let methodText: string
    if (method) {
      methodText = method
    } else if (standardMethodFor(degree)) {
      methodText = standardMethodFor(degree) as LeakMethod
      notes.push('历史单据缺处置方式，按渗漏程度回填显示，结论不变')
    } else {
      methodText = textOrBlank(row['处置方式'])
    }
    return {
      code,
      pendingCode,
      degree,
      degreeText,
      method,
      methodText,
      rework: rawConclusion === LEAK_STATUS.REWORK,
      canComplete: false,
      status: rawConclusion,
      locked: true,
      lockedConclusion: rawConclusion,
      notes,
    }
  }

  // ---- 未锁定：程度、方式、返工在同一处一次算完 ----

  // 处置编号缺失：整单按待补录处理，不进入处置流程
  if (pendingCode || rawStatus === LEAK_STATUS.PENDING_CODE) {
    if (pendingCode) notes.push('处置编号缺失，按待补录处理；补录编号后进入待处置')
    return {
      code: null,
      pendingCode: true,
      degree,
      degreeText: degree ?? degreeText,
      method,
      methodText: method ?? standardMethodFor(degree) ?? BLANK,
      rework: false,
      canComplete: false,
      status: LEAK_STATUS.PENDING_CODE,
      locked: false,
      lockedConclusion: '',
      notes,
    }
  }

  if (rawStatus === LEAK_STATUS.WAITING) {
    const suggested = standardMethodFor(degree)
    if (method === null && suggested) {
      notes.push(`派工时将按渗漏程度下达标准工艺：${suggested}`)
    }
    return {
      code,
      pendingCode: false,
      degree,
      degreeText,
      method,
      methodText: method ?? suggested ?? BLANK,
      rework: false,
      canComplete: false,
      status: LEAK_STATUS.WAITING,
      locked: false,
      lockedConclusion: '',
      notes,
    }
  }

  if (rawStatus === LEAK_STATUS.WORKING) {
    const rework = reworkRequired(degree, method)
    if (method === null) notes.push('处置方式未记录，需补录实际采用的工艺')
    if (rework) notes.push('严重渗漏必须采用注浆封堵，当前处置方式不达标，按返工处理')
    const canComplete = degree !== null && method !== null && !rework
    return {
      code,
      pendingCode: false,
      degree,
      degreeText,
      method,
      methodText: method ?? BLANK,
      rework,
      canComplete,
      // 列表预判与动作判定同一份结果：不达标即在列表显示「需返工」
      status: rework ? LEAK_STATUS.REWORK : LEAK_STATUS.WORKING,
      locked: false,
      lockedConclusion: '',
      notes,
    }
  }

  // 已完工 / 需返工 但缺锁定标记（防御性分支：正常流程里动作一定会落锁）
  const fallbackStatus =
    rawStatus === LEAK_STATUS.DONE || rawStatus === LEAK_STATUS.REWORK ? rawStatus : LEAK_STATUS.WAITING
  if (fallbackStatus === LEAK_STATUS.DONE) notes.push('该单据缺少判定锁定记录，建议复核流程')
  return {
    code,
    pendingCode: false,
    degree,
    degreeText,
    method,
    methodText: method ?? standardMethodFor(degree) ?? BLANK,
    rework: fallbackStatus === LEAK_STATUS.REWORK,
    canComplete: false,
    status: fallbackStatus,
    locked: false,
    lockedConclusion: '',
    notes,
  }
}

// ---- 投影：三个入口（列表 / 详情 / 另存）读同一结构，杜绝结论打架 ----

export type ProjectedLeakRow = LeakInput & {
  id: number
  status: string
  处置编号: string
  渗漏点位: string
  渗漏程度: string
  处置方式: string
  处置班组: string
  发现日期: string
  完工日期: string
  处置状态: string
  _verdict: LeakVerdict
}

export function projectLeakRow(row: LeakInput): ProjectedLeakRow {
  const verdict = resolveLeakVerdict(row)
  const finished = verdict.status === LEAK_STATUS.DONE
  const rawFinish = row['完工日期']
  const finishText = finished
    ? textOrBlank(rawFinish)
    : rawFinish === null || rawFinish === undefined || String(rawFinish).trim() === ''
      ? BLANK
      : textOrBlank(rawFinish)
  return {
    ...(row as Record<string, unknown>),
    id: Number(row.id),
    status: verdict.status,
    处置编号: verdict.code ?? PENDING_CODE_TEXT,
    渗漏点位: textOrBlank(row['渗漏点位']),
    渗漏程度: verdict.degreeText,
    处置方式: verdict.methodText,
    处置班组: textOrBlank(row['处置班组']),
    发现日期: textOrBlank(row['发现日期']),
    完工日期: finishText,
    处置状态: verdict.status,
    _verdict: verdict,
  }
}

// ---- 另存归档：不重算第二遍，只搬运同一份判定，并按发现日期定先后 ----

export function isValidDateText(value: unknown): boolean {
  if (typeof value !== 'string') return false
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return false
  const date = new Date(`${value.trim()}T00:00:00`)
  return !Number.isNaN(date.getTime())
}

function dateValue(value: unknown): number {
  const text = String(value ?? '').trim()
  if (!isValidDateText(text)) return Number.POSITIVE_INFINITY
  return new Date(`${text}T00:00:00`).getTime()
}

/** 归档先后：发现日期升序；同日按 id；日期缺失排最后。 */
export function compareByFoundDate(a: LeakInput, b: LeakInput): number {
  const diff = dateValue(a['发现日期']) - dateValue(b['发现日期'])
  if (diff !== 0) return diff
  return Number(a.id ?? 0) - Number(b.id ?? 0)
}

/**
 * 生成另存归档快照：只收录判定结论为「已完工」的处置单，
 * 结论直接取 resolveLeakVerdict（不另算），按发现日期排序。
 */
export function buildLeakArchive(rows: LeakInput[]): ProjectedLeakRow[] {
  return rows
    .filter((row) => resolveLeakVerdict(row).status === LEAK_STATUS.DONE)
    .map(projectLeakRow)
    .sort(compareByFoundDate)
}

/** 导出 CSV 的列头与字段顺序，与原清单完全一致（编号 + 8 列 + 当前状态）。 */
export function toLeakCsv(rows: ProjectedLeakRow[]): string {
  const escape = (value: unknown) => {
    const text = String(value ?? '')
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  const header = ['编号', ...LEAK_COLUMNS, '当前状态']
  const lines = [header.join(',')]
  for (const row of rows) {
    lines.push(
      [row.id, ...LEAK_COLUMNS.map((column) => row[column] ?? ''), row.status].map(escape).join(','),
    )
  }
  return `﻿${lines.join('\n')}`
}

// ---- 导入：解析、校验、去重键，全部集中在此 ----

export type LeakDraft = {
  code: string | null
  point: string
  degree: LeakDegree
  method: LeakMethod
  crew: string
  foundDate: string
  ignoredFinishDate: boolean
}

export type ParsedLeakImport =
  | { ok: true; drafts: LeakDraft[]; ignoredFinishCount: number }
  | { ok: false; errors: string[] }

function parseCsvLine(line: string): string[] {
  const cells: string[] = []
  let current = ''
  let quoted = false
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"'
          i += 1
        } else {
          quoted = false
        }
      } else {
        current += char
      }
    } else if (char === '"') {
      quoted = true
    } else if (char === ',') {
      cells.push(current)
      current = ''
    } else {
      current += char
    }
  }
  cells.push(current)
  return cells.map((cell) => cell.trim())
}

/** 重复上报去重键：处置编号优先；编号缺失按「渗漏点位 + 发现日期」认定同一点位。 */
export function leakIdentityKey(code: string | null, point: string, foundDate: string): string {
  return code ? `code:${code}` : `point:${point}|${foundDate}`
}

function buildDraft(raw: Record<string, unknown>, line: number): LeakDraft | { errors: string[] } {
  const errors: string[] = []
  const point = String(raw['渗漏点位'] ?? '').trim()
  const foundDate = String(raw['发现日期'] ?? '').trim()
  const degree = normalizeDegree(raw['渗漏程度'])
  if (!point) errors.push(`第 ${line} 行缺少渗漏点位`)
  if (!foundDate) errors.push(`第 ${line} 行缺少发现日期`)
  else if (!isValidDateText(foundDate)) errors.push(`第 ${line} 行发现日期格式应为 YYYY-MM-DD：${foundDate}`)
  if (!degree) errors.push(`第 ${line} 行渗漏程度无法识别：${String(raw['渗漏程度'] ?? '').trim() || '（空）'}`)
  if (errors.length) return { errors }

  const rawCode = String(raw['处置编号'] ?? '').trim()
  const code = rawCode === '' || rawCode === PENDING_CODE_TEXT ? null : rawCode
  const method = normalizeMethod(raw['处置方式']) ?? standardMethodFor(degree as LeakDegree)
  return {
    code,
    point,
    degree: degree as LeakDegree,
    method: method as LeakMethod,
    crew: String(raw['处置班组'] ?? '').trim(),
    foundDate,
    ignoredFinishDate: String(raw['完工日期'] ?? '').trim() !== '',
  }
}

/**
 * 解析导入文本（CSV / TSV / JSON 数组）。
 * 注意这里只做整批解析与逐行校验；只要有一行不过，调用方必须整笔退回，
 * 不得落库半批。
 */
export function parseLeakImport(text: string): ParsedLeakImport {
  const trimmed = text.trim()
  if (!trimmed) return { ok: false, errors: ['导入内容为空'] }

  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const json = JSON.parse(trimmed) as unknown
      const list = Array.isArray(json) ? json : [json]
      const drafts: LeakDraft[] = []
      const errors: string[] = []
      let ignoredFinish = 0
      list.forEach((item, index) => {
        const draft = buildDraft((item ?? {}) as Record<string, unknown>, index + 2)
        if ('errors' in draft) errors.push(...draft.errors)
        else {
          if (draft.ignoredFinishDate) ignoredFinish += 1
          drafts.push(draft)
        }
      })
      return errors.length
        ? { ok: false, errors }
        : { ok: true, drafts, ignoredFinishCount: ignoredFinish }
    } catch (error) {
      return { ok: false, errors: [`JSON 解析失败：${error instanceof Error ? error.message : String(error)}`] }
    }
  }

  const delimiter = trimmed.includes('\t') ? '\t' : ','
  const rawLines = trimmed.split(/\r?\n/).filter((line) => line.trim() !== '')
  if (rawLines.length < 2) return { ok: false, errors: ['缺少表头或数据行'] }
  const header = rawLines[0].split(delimiter).map((cell) => cell.trim().replace(/^"|"$/g, ''))
  const drafts: LeakDraft[] = []
  const errors: string[] = []
  let ignoredFinish = 0
  rawLines.slice(1).forEach((line, index) => {
    const cells = delimiter === '\t' ? line.split('\t').map((cell) => cell.trim()) : parseCsvLine(line)
    const record: Record<string, unknown> = {}
    header.forEach((key, cellIndex) => {
      record[key] = cells[cellIndex] ?? ''
    })
    const draft = buildDraft(record, index + 2)
    if ('errors' in draft) {
      errors.push(...draft.errors)
    } else {
      if (draft.ignoredFinishDate) ignoredFinish += 1
      drafts.push(draft)
    }
  })
  if (errors.length) return { ok: false, errors }
  return { ok: true, drafts, ignoredFinishCount: ignoredFinish }
}

/**
 * 重复上报：以第一次内容为准，后续差异只追加备注，不改任何字段。
 * 返回应追加到既有单据的备注文本。
 */
export function duplicateRemark(
  existing: LeakInput,
  incoming: LeakDraft,
  times: number,
  today: string,
): string {
  const diffs: string[] = []
  const check = (label: string, before: unknown, after: string) => {
    const beforeText = String(before ?? '').trim()
    if (beforeText !== '' && beforeText !== after) diffs.push(`${label} ${beforeText}→${after}（未采纳）`)
  }
  check('渗漏点位', existing['渗漏点位'], incoming.point)
  const beforeDegree = normalizeDegree(existing['渗漏程度'])
  if (beforeDegree && beforeDegree !== incoming.degree) {
    diffs.push(`渗漏程度 ${beforeDegree}→${incoming.degree}（未采纳）`)
  }
  const beforeMethod = normalizeMethod(existing['处置方式'])
  if (beforeMethod && beforeMethod !== incoming.method) {
    diffs.push(`处置方式 ${beforeMethod}→${incoming.method}（未采纳）`)
  }
  check('处置班组', existing['处置班组'], incoming.crew)
  const tail = diffs.length ? `；差异：${diffs.join('，')}` : '；内容一致'
  return `第 ${times} 次重复上报（${today}）以首次上报为准${tail}`
}
