import {
  LEAK_STATUS,
  PENDING_CODE_TEXT,
  buildLeakArchive,
  normalizeDegree,
  normalizeMethod,
  reworkRequired,
  standardMethodFor,
} from '@/domain/leak'
import { normalizeShift } from '@/domain/duty'
import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'urban-utility-tunnel:entries'
const STORAGE_VERSION = 2

type PersistedV2 = {
  version: typeof STORAGE_VERSION
  entries: Record<string, EntryRow[]>
}

// v1（无版本号，直接就是各模块数组的对象）；升级时整库迁移后再落库。
type PersistedV1 = Record<string, EntryRow[]>

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// ---------------------------------------------------------------------------
// v1 → v2 存量迁移
// ---------------------------------------------------------------------------

const LEAK_PLACEHOLDER = /^渗漏水处置样例(\d+)$/
const DUTY_PLACEHOLDER = /^运维值班交接样例(\d+)$/
const GENERIC_PLACEHOLDER = /样例\d+$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function isPlaceholder(value: unknown): boolean {
  return GENERIC_PLACEHOLDER.test(String(value ?? ''))
}

function blankedIfPlaceholder(value: unknown): string {
  const text = String(value ?? '').trim()
  if (text === '' || isPlaceholder(text)) return ''
  return text
}

function appendNote(notes: string[], note: string): void {
  if (note && !notes.includes(note)) notes.push(note)
}

/**
 * 存量渗漏处置单迁移（规则取舍详见 src/domain/README.md）：
 * - 处置编号缺失/占位：按待补录处理；
 * - 渗漏程度/处置方式走唯一别名表归一；占位演示数据按序号启发式定级；
 * - 早年已完工但没有处置方式的，按渗漏程度回填标准工艺，原结论保留；
 * - 已经判定过的单据（已完工/需返工）锁定判定，等级不因新规则改变；
 * - 完工日期与流程状态冲突时以流程状态为准，日期清空并备注；
 * - 其余缺项显式留空。
 */
function migrateLeakV1(row: EntryRow): EntryRow {
  const id = Number(row.id)
  const notes: string[] = []
  const rawStatus = String(row.status ?? '').trim() || LEAK_STATUS.WAITING

  const rawDegree = String(row['渗漏程度'] ?? '').trim()
  let degree = normalizeDegree(rawDegree)
  if (!degree && LEAK_PLACEHOLDER.test(rawDegree)) {
    // 只有仓库生成的占位演示数据才启用按序号启发式定级；真实未识别程度保持原样待核定
    degree = (['轻微渗漏', '中度渗漏', '严重渗漏'] as const)[(id - 1) % 3]
    appendNote(notes, `存量演示数据：渗漏程度按点位序号回填为「${degree}」，请现场核定`)
  } else if (!degree && rawDegree !== '') {
    appendNote(notes, `存量迁移：渗漏程度「${rawDegree}」未识别，保持原值待现场核定`)
  }

  const rawMethod = String(row['处置方式'] ?? '').trim()
  let method = normalizeMethod(rawMethod)
  if (!method && !LEAK_PLACEHOLDER.test(rawMethod) && rawMethod !== '') {
    appendNote(notes, `存量迁移：处置方式「${rawMethod}」未识别，保持原值待核定`)
  }

  const codeRaw = String(row['处置编号'] ?? '').trim()
  const missingCode = codeRaw === '' || codeRaw === PENDING_CODE_TEXT || isPlaceholder(codeRaw)
  const code = missingCode ? PENDING_CODE_TEXT : codeRaw
  if (missingCode) appendNote(notes, '处置编号缺失，按待补录处理')

  const point = blankedIfPlaceholder(row['渗漏点位'])
  const crew = blankedIfPlaceholder(row['处置班组'])
  const foundDate = String(row['发现日期'] ?? '').trim()
  if (!DATE_RE.test(foundDate)) appendNote(notes, '存量迁移：发现日期缺失或格式不符，已显式留空')

  const concluded = rawStatus === LEAK_STATUS.DONE || rawStatus === LEAK_STATUS.REWORK
  // 早年已完工但没有处置方式：按渗漏程度回填标准工艺，历史处置单按发现日期保留原判
  if (concluded && method === null) {
    const standard = standardMethodFor(degree)
    if (standard) {
      method = standard
      appendNote(notes, `历史处置单缺处置方式，按渗漏程度回填「${standard}」，原判定结论不变`)
    }
  }

  let status = rawStatus
  let finishDate = blankedIfPlaceholder(row['完工日期'])
  if (missingCode) {
    status = LEAK_STATUS.PENDING_CODE
    if (finishDate) appendNote(notes, `存量迁移：完工日期 ${finishDate} 与待补录状态冲突，已清空`)
    finishDate = ''
  } else if (!concluded && finishDate) {
    // 两版取值冲突：流程状态与完工日期只能留一版，取流程状态为准
    appendNote(notes, `存量迁移：完工日期 ${finishDate} 与流程状态「${status}」冲突，以流程状态为准，日期清空`)
    finishDate = ''
  }

  const migrated: EntryRow = {
    ...row,
    id,
    status,
    处置编号: code,
    渗漏点位: point,
    渗漏程度: degree ?? rawDegree,
    处置方式: method ?? rawMethod,
    处置班组: crew,
    发现日期: DATE_RE.test(foundDate) ? foundDate : '',
    完工日期: finishDate,
    处置状态: status,
    备注: notes.join('；'),
  }

  if (concluded) {
    migrated['判定锁定'] = true
    migrated['判定结论'] = rawStatus
    // 已完工老单据即便按新口径落在返工分界上（如严重渗漏当年未注浆），也保留原判
    if (rawStatus === LEAK_STATUS.DONE && reworkRequired(degree, method)) {
      appendNote(notes, '按现行口径该工艺需返工，但该单已判定完工，历史结论保留不改判')
      migrated['备注'] = notes.join('；')
    }
  }

  migrated.status = status
  migrated.pending = status !== LEAK_STATUS.DONE
  migrated.abnormal = status === LEAK_STATUS.REWORK
  return migrated
}

/**
 * 存量值班台账迁移：按交接班次迁移。
 * - 班次别名统一归一为白班/夜班全称；认不出来的显式留空待补（不擅自派班）；
 * - 仓库占位演示数据按序号轮排白班/夜班，保证演示台账可按班次对账；
 * - 缺项要么按别名补齐，要么显式留空，全部写入备注。
 */
function migrateDutyV1(row: EntryRow): EntryRow {
  const id = Number(row.id)
  const notes: string[] = []
  const rawShift = String(row['班次'] ?? '').trim()

  let shift = normalizeShift(rawShift)
  if (!shift && DUTY_PLACEHOLDER.test(rawShift)) {
    shift = id % 2 === 0 ? '夜班 20:00-次日08:00' : '白班 08:00-20:00'
    appendNote(notes, `存量演示数据：班次按交接序号补排为「${shift}」，请核实`)
  } else if (!shift && rawShift !== '') {
    appendNote(notes, `存量迁移：班次「${rawShift}」未识别，已显式留空待补`)
  }

  const dateRaw = String(row['值班日期'] ?? '').trim()
  const dutyDate = DATE_RE.test(dateRaw) ? dateRaw : ''
  if (!dutyDate) appendNote(notes, '存量迁移：值班日期缺失或格式不符，已显式留空')

  const status = String(row.status ?? '').trim() || '待交接'
  const migrated: EntryRow = {
    ...row,
    id,
    status,
    交接编号: blankedIfPlaceholder(row['交接编号']),
    值班班组: blankedIfPlaceholder(row['值班班组']),
    值班日期: dutyDate,
    班次: shift ?? '',
    值班人员: blankedIfPlaceholder(row['值班人员']),
    交接事项: blankedIfPlaceholder(row['交接事项']),
    交接人员: blankedIfPlaceholder(row['交接人员']),
    交接状态: status,
    备注: notes.join('；'),
    pending: status !== '已交接',
    abnormal: status === '有遗留',
  }
  if (!shift && !migrated['班次']) migrated['班次'] = ''
  return migrated
}

function migrateV1(raw: PersistedV1): PersistedV2 {
  const entries: Record<string, EntryRow[]> = {}
  for (const key of Object.keys(SEED_ROWS)) {
    const rows = Array.isArray(raw[key]) ? raw[key] : []
    if (key === 'leak') entries[key] = rows.map(migrateLeakV1)
    else if (key === 'duty') entries[key] = rows.map(migrateDutyV1)
    else entries[key] = clone(rows)
  }
  // 归档分片由渗漏数据在提交时统一重建，迁移阶段给空数组即可
  entries['leakArchive'] = []
  return { version: STORAGE_VERSION, entries }
}

// ---------------------------------------------------------------------------
// 读写
// ---------------------------------------------------------------------------

function seedV2(): PersistedV2 {
  return { version: STORAGE_VERSION, entries: clone(SEED_ROWS) }
}

function persist(snapshot: PersistedV2): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot))
  }
}

function readStorage(): PersistedV2 {
  if (typeof window === 'undefined' || !window.localStorage) {
    return seedV2()
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const seeded = seedV2()
    persist(seeded)
    return seeded
  }
  try {
    const parsed = JSON.parse(raw) as PersistedV2 | PersistedV1
    if (parsed && typeof parsed === 'object' && (parsed as PersistedV2).version === STORAGE_VERSION) {
      // 新版本里新增的模块键也要补齐
      return { version: STORAGE_VERSION, entries: { ...clone(SEED_ROWS), ...(parsed as PersistedV2).entries } }
    }
    // 无版本号 → v1：整库迁移后一次性写回，迁移本身也是整笔提交
    const migrated = migrateV1(parsed as PersistedV1)
    persist(migrated)
    return migrated
  } catch {
    const seeded = seedV2()
    persist(seeded)
    return seeded
  }
}

let cache: Record<string, EntryRow[]> | null = null

function assertValidEntries(entries: Record<string, EntryRow[]>): void {
  for (const key of ['leak', 'duty']) {
    const rows = entries[key] ?? []
    const ids = new Set<number>()
    for (const row of rows) {
      if (typeof row.id !== 'number' || Number.isNaN(row.id)) {
        throw new Error(`落库校验失败：${key} 存在非数字编号，整笔退回`)
      }
      if (ids.has(row.id)) throw new Error(`落库校验失败：${key} 编号 ${row.id} 重复，整笔退回`)
      ids.add(row.id)
    }
  }
}

/**
 * 整笔提交：校验通过且 localStorage 写入成功后，才切换内存缓存。
 * 任一步失败都保留旧缓存不动（整笔退回），保证前后两次读到同一份数据。
 * 另存归档分片在此按唯一口径重建，调用方无法把不一致的归档落库。
 */
export function commitEntries(entries: Record<string, EntryRow[]>): void {
  assertValidEntries(entries)
  const snapshot: PersistedV2 = {
    version: STORAGE_VERSION,
    entries: {
      ...entries,
      // _verdict 是读出时的派生字段，不入库；归档结论直接复用同一份判定重建
      leakArchive: buildLeakArchive(entries['leak'] ?? []).map((row) => {
        const { _verdict, ...plain } = row
        void _verdict
        return plain as unknown as EntryRow
      }),
    },
  }
  // 先尝试落盘；抛错时旧缓存保持原样，等于整笔退回
  persist(snapshot)
  cache = snapshot.entries
}

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage().entries
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

/** 兼容旧调用：单模块写入同样走整笔提交。 */
export function saveRows(key: string, rows: EntryRow[]): void {
  commitEntries({ ...allRows(), [key]: rows })
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  commitEntries({ ...allRows(), [key]: rows })
  return rows
}

// 多标签页：其他标签页落库后，本页放弃旧缓存，下次读取以 localStorage 为准
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY) cache = null
  })
}

export function storageKey(): string {
  return STORAGE_KEY
}
