import { migrateRows } from './migrations'
import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'urban-utility-tunnel:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return migrateRows(fallback)
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const seeded = migrateRows(fallback)
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded))
    return seeded
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    const merged = migrateRows({ ...fallback, ...parsed })
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(merged))
    return merged
  } catch {
    const seeded = migrateRows(fallback)
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded))
    return seeded
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

// 落库的唯一入口：先迁移补齐，再整体校验，最后一次性写入。
// 任何一步不过都抛错，缓存与 localStorage 都不动，整笔退回；
// 提交成功后缓存整体换快照，前后两次读到的必须是同一份数据。
function commit(next: Record<string, EntryRow[]>): void {
  const migrated = migrateRows(next)
  for (const [key, rows] of Object.entries(migrated)) {
    if (!Array.isArray(rows)) {
      throw new Error(`模块 ${key} 的数据不是列表，已整笔退回`)
    }
    const ids = new Set<number>()
    for (const row of rows) {
      if (row === null || typeof row !== 'object' || typeof row.id !== 'number') {
        throw new Error(`模块 ${key} 存在没有编号的记录，已整笔退回`)
      }
      if (ids.has(row.id)) {
        throw new Error(`模块 ${key} 存在重复编号 ${row.id}，已整笔退回`)
      }
      ids.add(row.id)
    }
  }
  cache = migrated
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated))
  }
}

// 一笔事务：在草稿快照上改，任何一步抛错都不落库；全部走完才一次性提交。
export function transact<T>(fn: (draft: Record<string, EntryRow[]>) => T): T {
  const draft = clone(allRows())
  const result = fn(draft)
  commit(draft)
  return result
}

export function saveRows(key: string, rows: EntryRow[]): void {
  commit({ ...allRows(), [key]: rows })
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return listRows(key)
}

export function storageKey(): string {
  return STORAGE_KEY
}
