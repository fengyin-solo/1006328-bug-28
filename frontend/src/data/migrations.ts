import { applyVerdict, judgeLeakDisposal, todayIso } from '@/domain/leak-disposal'
import { MODULE_BY_KEY } from './modules'
import type { EntryRow } from './types'

// 存量数据迁移：幂等，每次落库前都会过一遍，重复执行结果不变。
// 渗漏处置单按发现日期回填判定；值班台账按交接班次补齐缺项。

function text(value: unknown): string {
  return String(value ?? '').trim()
}

// 渗漏：已判定过的处置单不改等级；没判过的按发现日期回填判定。
// 早年没有处置方式的，按渗漏程度推导一个补上（严重及以上→注浆堵漏，其余→表面封堵），
// 并在判定说明里标注「存量回填」，与人工认定区分开；状态与待办标记一律不动，保留原判。
function migrateLeak(rows: EntryRow[]): EntryRow[] | null {
  let changed = false
  const next = rows.map((row) => {
    if (text(row['返工判定'])) {
      return row
    }
    changed = true
    const baseDate = text(row['发现日期']) || todayIso()
    let filled = row
    let backfillNote = ''
    if (!text(row['处置方式'])) {
      const derived = judgeLeakDisposal(row, baseDate).level >= 3 ? '注浆堵漏' : '表面封堵'
      filled = { ...filled, 处置方式: derived }
      backfillNote = `存量回填：处置方式缺失，按渗漏程度推导为${derived}`
    }
    const verdict = judgeLeakDisposal(filled, baseDate)
    const note = [backfillNote, verdict.note].filter(Boolean).join('；')
    return applyVerdict(filled, { ...verdict, note })
  })
  return changed ? next : null
}

// 值班台账：按交接班次迁移——交接编号缺失的按「值班日期+班次+序号」补齐，
// 其余字段缺项显式留空（空字符串），不猜内容。
function migrateDuty(rows: EntryRow[]): EntryRow[] | null {
  const meta = MODULE_BY_KEY.get('duty')
  if (!meta) {
    return null
  }
  let changed = false
  const next = rows.map((row) => {
    const filled: EntryRow = { ...row }
    if (!text(filled['交接编号'])) {
      const date = text(filled['值班日期']) || '日期未知'
      const shift = text(filled['班次']) || '班次未知'
      filled['交接编号'] = `DUTY-${date}-${shift}-${filled.id}`
    }
    for (const field of meta.fields) {
      if (filled[field] === undefined || filled[field] === null) {
        filled[field] = ''
      }
    }
    if (JSON.stringify(filled) !== JSON.stringify(row)) {
      changed = true
    }
    return filled
  })
  return changed ? next : null
}

export function migrateRows(all: Record<string, EntryRow[]>): Record<string, EntryRow[]> {
  let changed = false
  const next: Record<string, EntryRow[]> = { ...all }
  if (Array.isArray(all.leak)) {
    const migrated = migrateLeak(all.leak)
    if (migrated) {
      next.leak = migrated
      changed = true
    }
  }
  if (Array.isArray(all.duty)) {
    const migrated = migrateDuty(all.duty)
    if (migrated) {
      next.duty = migrated
      changed = true
    }
  }
  return changed ? next : all
}
