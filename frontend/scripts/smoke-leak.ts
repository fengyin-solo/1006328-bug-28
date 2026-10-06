// 冒烟测试：判定一处、迁移回填、事务回滚、导入去重、另存排序、台账同步。
import assert from 'node:assert'

import { exportEntries, importLeakEntries, leakDutySummary, listEntries, runAction } from '@/api/local-service'
import { allRows, listRows, transact } from '@/data/local-store'
import { migrateRows } from '@/data/migrations'
import { SEED_ROWS } from '@/data/seed'
import { judgeLeakDisposal, leakSummary, verdictOf } from '@/domain/leak-disposal'

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

// 1. 判定口径：唯一分界
const severe = judgeLeakDisposal({ id: 1, status: '', pending: true, abnormal: false, 处置编号: 'L1', 渗漏程度: '严重流淌', 处置方式: '引排导流' })
assert.equal(severe.conclusion, '需返工', '严重+临时性 → 需返工')
const rooted = judgeLeakDisposal({ id: 2, status: '', pending: true, abnormal: false, 处置编号: 'L2', 渗漏程度: '涌水', 处置方式: '注浆堵漏' })
assert.equal(rooted.conclusion, '免返工', '涌水+根治性 → 免返工')
const noCode = judgeLeakDisposal({ id: 3, status: '', pending: true, abnormal: false, 处置编号: '', 渗漏程度: '一般渗漏', 处置方式: '表面封堵' })
assert.equal(noCode.conclusion, '待补录', '缺处置编号 → 待补录')
assert.ok(noCode.note.includes('待补录'), '待补录要有说明')

// 2. 迁移：按发现日期回填、已判不改、幂等
const migrated = migrateRows(clone(SEED_ROWS))
const leak = migrated.leak
const byId = (id: number) => leak.find((r) => r.id === id)!
assert.equal(verdictOf(byId(2)).conclusion, '需返工', '种子2：严重+引排 → 需返工')
assert.equal(verdictOf(byId(3)).conclusion, '免返工', '种子3：涌水+注浆 → 免返工')
assert.equal(verdictOf(byId(4)).conclusion, '待补录', '种子4：缺编号 → 待补录')
assert.equal(byId(5)['处置方式'], '注浆堵漏', '种子5：早年缺方式按程度回填注浆堵漏')
assert.equal(byId(5)['判定基准日'], '2023-05-12', '回填基准日=发现日期')
assert.equal(String(byId(5).status), '已完工', '历史单保留原判（状态不动）')
assert.ok(String(byId(5)['判定说明']).includes('存量回填'), '回填要标注')
const duty = migrated.duty
assert.equal(duty[1]['交接编号'], 'DUTY-2026-09-02-夜班-2', '值班台账按班次补齐交接编号')
assert.equal(duty[2]['交接事项'], '', '缺项显式留空')
assert.deepEqual(migrateRows(migrated), migrated, '迁移幂等')

// 3. 事务：抛错整笔退回，前后读到同一份
const before = allRows()
const beforeLeakLen = listRows('leak').length
assert.throws(() =>
  transact((draft) => {
    draft.leak = [...(draft.leak ?? []), { id: 999, status: '待处置', pending: true, abnormal: false }]
    throw new Error('模拟中途失败')
  }),
)
assert.equal(listRows('leak').length, beforeLeakLen, '失败后缓存不动')
assert.deepEqual(allRows(), before, '整笔退回后两次读取一致')

// 4. 动作：同一份判定拦截完工；待补录拦截动作；人工返工覆盖
const r1 = runAction('leak', 2, '确认完工')
assert.equal(r1.ok, false, '判定需返工不能确认完工')
assert.ok(r1.message.includes('需返工'))
const r2 = runAction('leak', 4, '派出处置')
assert.equal(r2.ok, false, '待补录不能派出')
assert.ok(r2.message.includes('待补录'))
const r3 = runAction('leak', 3, '确认完工')
assert.equal(r3.ok, true, '涌水+注浆可完工')
const row3 = listRows('leak').find((r) => r.id === 3)!
assert.equal(String(row3.status), '已完工')
assert.equal(row3.pending, false, '已完工不再待办')
assert.ok(String(row3['完工日期']).length === 10, '完工日期落库')
assert.equal(verdictOf(row3).conclusion, '免返工', '详情/另存读到同一份结论')
const r4 = runAction('leak', 1, '要求返工')
assert.equal(r4.ok, true, '已完工可人工要求返工')
const row1 = listRows('leak').find((r) => r.id === 1)!
assert.equal(String(row1.status), '需返工')
assert.equal(row1.pending, true, '需返工回到待办')
assert.ok(String(row1['判定说明']).includes('人工要求返工'), '人工覆盖写说明')

// 5. 导入：重复只认第一次，差异记备注；缺编号新单判待补录
const csv1 = '编号,处置编号,渗漏点位,渗漏程度,处置方式,处置班组,发现日期,完工日期,处置状态,当前状态\n1,LEAK-0001,综合舱K0+120侧墙,轻微渗水,注浆堵漏,处置一班,2026-09-01,2026-09-02,已完工,已完工\n,LEAK-0001,综合舱K0+120侧墙,轻微渗水,表面封堵,处置一班,2026-09-01,2026-09-02,已完工,已完工\n,,新点位K9+900,严重流淌,引排导流,处置三班,2026-10-06,,待处置,待处置'
const imp1 = importLeakEntries(csv1)
assert.equal(imp1.ok, true, imp1.message)
assert.equal(imp1.added, 1, '缺编号新单导入为一条')
assert.equal(imp1.duplicates, 2, 'LEAK-0001 两次重复')
assert.equal(imp1.noted, 1, '只有内容不同的那次记备注')
const after1 = listRows('leak')
const le0001 = after1.filter((r) => String(r['处置编号']) === 'LEAK-0001')
assert.equal(le0001.length, 1, '同一张单不会多出记录')
assert.equal(le0001[0]['处置方式'], '表面封堵', '首报内容为准（存量记录即首报）')
assert.ok(String(le0001[0]['备注']).includes('注浆堵漏'), '后续差异记备注')
const newRow = after1.find((r) => String(r['渗漏点位']) === '新点位K9+900')!
assert.equal(verdictOf(newRow).conclusion, '待补录', '缺编号新单判待补录')
const countBefore = after1.length
const imp2 = importLeakEntries(csv1)
assert.equal(imp2.ok, true)
assert.equal(imp2.added, 0, '再次导入不新增')
assert.equal(listRows('leak').length, countBefore, '再次导入条数不变')
const bad = importLeakEntries('LEAK-X,点位,程度\n1,2,3,4')
assert.equal(bad.ok, false, '字段数不齐整笔退回')
assert.equal(listRows('leak').length, countBefore, '坏数据一条不落')

// 6. 另存：列不变，需返工在前
const exported = exportEntries('leak')
const lines = exported.content.replace(/^﻿/, '').split('\n')
assert.equal(lines[0], '编号,处置编号,渗漏点位,渗漏程度,处置方式,处置班组,发现日期,完工日期,处置状态,当前状态', '另存列与字段不变')
const firstDataCode = lines[1].split(',')[1]
assert.equal(firstDataCode, 'LEAK-0001', '需返工排在最前')

// 7. 台账同步：值班台账要情与列表同源同数
const brief = leakDutySummary()
const summary = leakSummary(listRows('leak'))
assert.deepEqual(brief, summary, '两处条数一致')
assert.equal(brief.待办, listRows('leak').filter((r) => r.pending).length, '待办与pending一致')
const page = listEntries('leak')
assert.equal(page.total, listRows('leak').length, '列表读取同一份数据')

console.log('全部冒烟断言通过')
console.log('台账要情:', JSON.stringify(brief))
