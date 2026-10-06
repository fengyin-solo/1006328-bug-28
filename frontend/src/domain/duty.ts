/**
 * 运维值班交接 —— 共用口径。
 *
 * 渗漏待办清单与值班台账两个入口的条数、分组都由 groupLeakTodosByShift
 * 一个函数给出，不存在两边各算一遍后对不上的情况。
 * 存量台账的班次归一、缺项补齐也只在本文件里定义。
 */

import {
  BLANK,
  LEAK_STATUS,
  type LeakInput,
  resolveLeakVerdict,
  textOrBlank,
} from './leak'

export const SHIFT_DAY = '白班 08:00-20:00'
export const SHIFT_NIGHT = '夜班 20:00-次日08:00'
export const SHIFT_UNASSIGNED = '未排入班次'
export const DUTY_SHIFTS = [SHIFT_DAY, SHIFT_NIGHT] as const

const SHIFT_ALIASES: Record<string, string> = {
  [SHIFT_DAY]: SHIFT_DAY,
  白班: SHIFT_DAY,
  日班: SHIFT_DAY,
  早班: SHIFT_DAY,
  白: SHIFT_DAY,
  day: SHIFT_DAY,
  [SHIFT_NIGHT]: SHIFT_NIGHT,
  夜班: SHIFT_NIGHT,
  晚班: SHIFT_NIGHT,
  夜: SHIFT_NIGHT,
  night: SHIFT_NIGHT,
}

/** 班次只归一到白班 / 夜班两套取值；认不出来的显式留空，不擅自派班。 */
export function normalizeShift(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null
  const key = String(raw).trim()
  if (key === '' || key === BLANK) return null
  return SHIFT_ALIASES[key] ?? null
}

export type DutyRow = {
  id?: number
  status?: unknown
  [field: string]: unknown
}

export function dutyDate(row: DutyRow): string {
  return String(row['值班日期'] ?? '').trim()
}

/** 某一发现日期落在哪个已交接/在册班次：按值班日期匹配白班、夜班各一条。 */
function matchShift(foundDate: string, dutyRows: DutyRow[]): string {
  const onDate = dutyRows.filter((row) => dutyDate(row) === foundDate)
  if (!onDate.length) return SHIFT_UNASSIGNED
  const shifts = new Set(
    onDate.map((row) => normalizeShift(row['班次'])).filter((shift): shift is string => shift !== null),
  )
  if (shifts.size === 1) return [...shifts][0]
  // 当天两条班次都在册：夜间 20:00 后发现归夜班，其余归白班；无时间信息按白班
  return SHIFT_DAY
}

export type ShiftTodoGroup = {
  shift: string
  count: number
  reworkCount: number
  items: { id: number; code: string; point: string; degreeText: string; status: string; foundDate: string }[]
}

/**
 * 待办清单：仍需盯办的渗漏处置单（待补录 / 待处置 / 处置中 / 需返工），
 * 已完工（含归档）不进待办。返回的总数就是值班台账上的关键条数。
 */
export function pendingLeakTodos(leakRows: LeakInput[]) {
  return leakRows.filter((row) => resolveLeakVerdict(row).status !== LEAK_STATUS.DONE)
}

/**
 * 待办清单与值班台账共用同一份分组结果：按交接班次归集。
 * 匹配不到在册班次的单据显式归入「未排入班次」，既不丢弃也不乱派班。
 */
export function groupLeakTodosByShift(leakRows: LeakInput[], dutyRows: DutyRow[]): ShiftTodoGroup[] {
  const groups = new Map<string, ShiftTodoGroup>()
  const ensure = (shift: string): ShiftTodoGroup => {
    let group = groups.get(shift)
    if (!group) {
      group = { shift, count: 0, reworkCount: 0, items: [] }
      groups.set(shift, group)
    }
    return group
  }

  for (const row of pendingLeakTodos(leakRows)) {
    const verdict = resolveLeakVerdict(row)
    const foundDate = String(row['发现日期'] ?? '').trim()
    const shift = /^\d{4}-\d{2}-\d{2}$/.test(foundDate) ? matchShift(foundDate, dutyRows) : SHIFT_UNASSIGNED
    const group = ensure(shift)
    group.count += 1
    if (verdict.status === LEAK_STATUS.REWORK) group.reworkCount += 1
    group.items.push({
      id: Number(row.id),
      code: verdict.code ?? '（待补录）',
      point: textOrBlank(row['渗漏点位']),
      degreeText: verdict.degreeText,
      status: verdict.status,
      foundDate,
    })
  }

  const orderedKeys = [...DUTY_SHIFTS, SHIFT_UNASSIGNED]
  return orderedKeys.filter((key) => groups.has(key)).map((key) => groups.get(key) as ShiftTodoGroup)
}
