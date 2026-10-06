const test = require('node:test')
const assert = require('node:assert/strict')
const { loadEnv, makeLocalStorage } = require('./_load.cjs')

const STORAGE_KEY = 'urban-utility-tunnel:entries'

/** 造一条最简渗漏处置单 */
function leakRow(over = {}) {
  return {
    id: 1,
    status: '处置中',
    pending: true,
    abnormal: false,
    处置编号: 'LEAK-T-1',
    渗漏点位: '测试点位',
    渗漏程度: '严重渗漏',
    处置方式: '紧急加固',
    处置班组: '测试班组',
    发现日期: '2026-10-01',
    完工日期: '',
    处置状态: '处置中',
    ...over,
  }
}

let env

test.beforeEach(async () => {
  env = await loadEnv()
})

test('唯一判定口径：严重渗漏未注浆 → 列表 / 详情 / 动作三处结论一致为需返工', () => {
  const { resolveLeakVerdict, projectLeakRow, buildLeakArchive } = env
  const row = leakRow()
  const verdict = resolveLeakVerdict(row)
  assert.equal(verdict.status, '需返工')
  assert.equal(verdict.rework, true)
  assert.equal(verdict.canComplete, false)
  // 列表投影同源
  assert.equal(projectLeakRow(row).status, '需返工')
  // 另存：需返工不得进归档
  assert.deepEqual(buildLeakArchive([row]), [])
})

test('返工与完工分界：严重渗漏注浆放行；轻微引排水放行；中度紧急加固放行', () => {
  const cases = [
    ['严重渗漏', '注浆封堵', true],
    ['严重渗漏', '紧急加固', false],
    ['严重渗漏', '引排水处理', false],
    ['中度渗漏', '紧急加固', true],
    ['中度渗漏', '注浆封堵', true],
    ['轻微渗漏', '引排水处理', true],
    ['轻微渗漏', '注浆封堵', true],
  ]
  for (const [degree, method, canComplete] of cases) {
    const verdict = env.resolveLeakVerdict(leakRow({ 渗漏程度: degree, 处置方式: method }))
    assert.equal(verdict.canComplete, canComplete, `${degree}/${method}`)
    assert.equal(verdict.status, canComplete ? '处置中' : '需返工', `${degree}/${method}`)
  }
})

test('程度未核定不能臆断返工，也不能完工', () => {
  const verdict = env.resolveLeakVerdict(leakRow({ 渗漏程度: '不明情况', 处置方式: '注浆封堵' }))
  assert.equal(verdict.rework, false)
  assert.equal(verdict.canComplete, false)
  assert.match(verdict.degreeText, /未核定/)
})

test('历史已判定单据锁定：严重渗漏当年紧急加固完工，保留已完工不改判', () => {
  const old = leakRow({
    status: '已完工',
    渗漏程度: '严重渗漏',
    处置方式: '紧急加固',
    完工日期: '2021-11-10',
    判定锁定: true,
    判定结论: '已完工',
  })
  const verdict = env.resolveLeakVerdict(old)
  assert.equal(verdict.status, '已完工')
  assert.equal(verdict.rework, false)
  assert.equal(verdict.locked, true)
  // 锁定的完工单仍在归档中
  assert.equal(env.buildLeakArchive([old]).length, 1)
})

test('动作流程：确认完工撞分界自动落需返工并移出归档；重新派出清锁后可再完工', () => {
  const { service, LEAK_STATUS } = env
  // 找到种子中 id=4：严重渗漏/紧急加固，处置中
  let r1 = service.runLeakAction(4, '确认完工')
  assert.equal(r1.ok, false)
  let row = service.getLeakEntry(4)
  assert.equal(row.status, LEAK_STATUS.REWORK)
  assert.equal(row._verdict.locked, true)
  assert.ok(!service.leakArchive().some((item) => Number(item.id) === 4))

  // 重新派出：锁清除，状态回处置中，旧等级不残留
  const r2 = service.runLeakAction(4, '重新派出处置')
  assert.equal(r2.ok, true)
  row = service.getLeakEntry(4)
  assert.equal(row.status, LEAK_STATUS.REWORK, '方式仍不达标，列表预判仍是需返工')
  assert.equal(row._verdict.locked, false)

  // 现场改为注浆封堵后完工
  const stored = env.allRows().leak.find((item) => item.id === 4)
  stored.处置方式 = '注浆封堵'
  env.commitEntries({ ...env.allRows(), leak: env.allRows().leak })
  const r3 = service.runLeakAction(4, '确认完工')
  assert.equal(r3.ok, true)
  row = service.getLeakEntry(4)
  assert.equal(row.status, LEAK_STATUS.DONE)
  assert.ok(service.leakArchive().some((item) => Number(item.id) === 4))
})

test('处置编号缺失按待补录处理，补录后进入待处置', () => {
  const { service, LEAK_STATUS } = env
  const result = service.importLeakEntries(
    '处置编号,渗漏点位,渗漏程度,处置方式,处置班组,发现日期\n,测试缺号点,中度渗漏,注浆封堵,测试班组,2026-10-06',
  )
  assert.equal(result.ok, true)
  assert.equal(result.pendingCode, 1)
  const created = env.allRows().leak.find((item) => item.渗漏点位 === '测试缺号点')
  assert.equal(created.status, LEAK_STATUS.PENDING_CODE)
  const projected = service.getLeakEntry(created.id)
  assert.equal(projected['处置编号'], '（待补录）')
  assert.match(projected._verdict.notes.join('；'), /待补录/)
  // 待补录不能完工
  assert.equal(service.runLeakAction(created.id, '确认完工').ok, false)
  // 补录编号
  const patched = service.runLeakAction(created.id, '补录编号', { code: 'LEAK-2026-099' })
  assert.equal(patched.ok, true)
  assert.equal(service.getLeakEntry(created.id).status, LEAK_STATUS.WAITING)
})

test('同一张处置单再次导入不多记录，重复上报只认第一次，差异记备注', () => {
  const { service } = env
  const csv = (method) =>
    `处置编号,渗漏点位,渗漏程度,处置方式,处置班组,发现日期\nLEAK-2026-018,春申路舱 K2+015 施工缝,严重渗漏,${method},其他班组,2026-09-20`
  const before = env.allRows().leak.length
  const result = service.importLeakEntries(csv('紧急加固'))
  assert.equal(result.ok, true)
  assert.equal(result.inserted, 0)
  assert.equal(result.duplicated, 1)
  assert.equal(env.allRows().leak.length, before)
  const existing = env.allRows().leak.find((item) => item.处置编号 === 'LEAK-2026-018')
  assert.equal(existing.处置方式, '注浆封堵', '后续差异不得覆盖第一次内容')
  assert.equal(existing.处置班组, '堵漏一班')
  assert.match(existing.备注, /第 2 次重复上报/)
  assert.match(existing.备注, /紧急加固（未采纳）/)
  assert.equal(Number(existing.上报次数), 2)
})

test('无编号单据按点位+发现日期去重', () => {
  const { service } = env
  const csv =
    '处置编号,渗漏点位,渗漏程度,处置方式,处置班组,发现日期\n,望江路舱 K0+402 侧墙,严重渗漏,紧急加固,抢险三班,2026-10-05'
  const before = env.allRows().leak.length
  const result = service.importLeakEntries(csv)
  assert.equal(result.inserted, 0)
  assert.equal(result.duplicated, 1)
  assert.equal(env.allRows().leak.length, before)
})

test('整批校验失败整笔退回：坏数据不产生半批落库', () => {
  const { service } = env
  const before = JSON.stringify(env.allRows().leak)
  const csv =
    '处置编号,渗漏点位,渗漏程度,处置方式,处置班组,发现日期\n' +
    'LEAK-X-1,合法点位,中度渗漏,注浆封堵,甲班,2026-10-06\n' +
    'LEAK-X-2,,严重渗漏,紧急加固,乙班,2026-10-06\n' +
    'LEAK-X-3,另一处,瞎写的程度,注浆封堵,丙班,2026-10-06'
  const result = service.importLeakEntries(csv)
  assert.equal(result.ok, false)
  assert.match(result.message, /整笔退回/)
  assert.equal(JSON.stringify(env.allRows().leak), before, '失败后前后两次读到同一份数据')
})

test('同批文件内重复身份整笔退回', () => {
  const { service } = env
  const before = env.allRows().leak.length
  const csv =
    '处置编号,渗漏点位,渗漏程度,处置方式,处置班组,发现日期\n' +
    'LEAK-B-1,同一点,中度渗漏,注浆封堵,甲班,2026-10-06\n' +
    'LEAK-B-1,同一点,严重渗漏,紧急加固,乙班,2026-10-06'
  const result = service.importLeakEntries(csv)
  assert.equal(result.ok, false)
  assert.equal(env.allRows().leak.length, before)
})

test('另存清单：仅已完工、按发现日期先后、8 列字段不变', () => {
  const { service } = env
  const archive = service.leakArchive()
  const dates = archive.map((row) => String(row.发现日期))
  assert.deepEqual(dates, [...dates].sort())
  assert.ok(archive.every((row) => row.status === '已完工'))
  const csv = service.exportLeakArchiveCsv().content
  const header = csv.replace(/^﻿/, '').split('\n')[0]
  assert.equal(header, '编号,处置编号,渗漏点位,渗漏程度,处置方式,处置班组,发现日期,完工日期,处置状态,当前状态')
  // 老单（2021 年）与本月完工单都在
  assert.ok(archive.some((row) => String(row.发现日期).startsWith('2021')))
  assert.ok(archive.some((row) => String(row.完工日期).startsWith('2026-10')))
})

test('列表/详情/归档三处结论完全一致', () => {
  const { service } = env
  const list = service.listLeakEntries().items
  for (const item of list) {
    const detail = service.getLeakEntry(Number(item.id))
    assert.equal(detail.status, item.status, `id=${item.id} 列表与详情状态一致`)
    assert.equal(detail.处置方式, item.处置方式, `id=${item.id} 处置方式一致`)
    const archived = service.leakArchive().find((row) => Number(row.id) === Number(item.id))
    if (item.status === '已完工') {
      assert.ok(archived, `id=${item.id} 已完工必须在另存清单`)
      assert.equal(archived.status, '已完工')
    } else {
      assert.equal(archived, undefined, `id=${item.id} 非完工不得在另存清单`)
    }
  }
})

test('关键数值两处一致：渗漏页待办条数 == 值班台账分组合计', () => {
  const { service } = env
  const stats = service.leakStats()
  const groups = service.leakTodoGroups()
  const total = groups.reduce((sum, group) => sum + group.count, 0)
  const expected = stats.waiting + stats.working + stats.rework + stats.pendingCode
  assert.equal(total, expected)
  // 种子：id=4 严重渗漏不达标 → 需返工计入对应班次；id=6 待补录；id=5/7 待处置/处置中
  assert.ok(total >= 4)
  const reworkSum = groups.reduce((sum, group) => sum + group.reworkCount, 0)
  assert.equal(reworkSum, stats.rework)
  // id=4 发现于 2026-10-04，归 10-04 白班（当日白夜班均在册，无时间信息归白班）
  const dayGroup = groups.find((group) => group.shift === '白班 08:00-20:00')
  assert.ok(dayGroup.items.some((item) => item.id === 4))
  // id=7 发现于 2026-09-28，当天无在册班次：显式归「未排入班次」，不丢弃不乱派
  const unassigned = groups.find((group) => group.shift === '未排入班次')
  assert.ok(unassigned.items.some((item) => item.id === 7))
})

test('待办与台账随动作同步变化（同一笔提交）', () => {
  const { service } = env
  const before = service.leakTodoGroups().reduce((s, g) => s + g.count, 0)
  // id=5 轻微渗漏待处置：派出 → 完工，待办减少 1，归档增加 1
  assert.equal(service.runLeakAction(5, '派出处置').ok, true)
  assert.equal(service.runLeakAction(5, '确认完工').ok, true)
  const after = service.leakTodoGroups().reduce((s, g) => s + g.count, 0)
  assert.equal(after, before - 1)
  assert.ok(service.leakArchive().some((row) => Number(row.id) === 5))
})

test('v1 存量迁移：渗漏单回填 / 锁定 / 缺编号待补录 / 冲突日期清空', async () => {
  const v1 = {
    [STORAGE_KEY]: JSON.stringify({
      leak: [
        // 已完工严重渗漏紧急加固：保留原判
        {
          id: 1, status: '已完工', pending: false, abnormal: false,
          处置编号: 'LEAK-O-1', 渗漏点位: '老点1', 渗漏程度: '严重渗漏', 处置方式: '紧急加固',
          处置班组: '甲班', 发现日期: '2019-03-02', 完工日期: '2019-03-05', 处置状态: '已完工',
        },
        // 已完工但缺处置方式：按程度回填，结论不变
        {
          id: 2, status: '已完工', pending: false, abnormal: false,
          处置编号: 'LEAK-O-2', 渗漏点位: '老点2', 渗漏程度: '中度渗漏', 处置方式: '',
          处置班组: '乙班', 发现日期: '2018-06-01', 完工日期: '2018-06-03', 处置状态: '已完工',
        },
        // 处置中却有完工日期：以流程状态为准清空
        {
          id: 3, status: '处置中', pending: true, abnormal: false,
          处置编号: 'LEAK-O-3', 渗漏点位: '老点3', 渗漏程度: '轻微渗漏', 处置方式: '引排水处理',
          处置班组: '甲班', 发现日期: '2026-09-10', 完工日期: '2026-09-12', 处置状态: '处置中',
        },
        // 缺编号：待补录
        {
          id: 4, status: '待处置', pending: true, abnormal: false,
          处置编号: '', 渗漏点位: '老点4', 渗漏程度: '轻微渗漏', 处置方式: '',
          处置班组: '', 发现日期: '2026-09-15', 完工日期: '', 处置状态: '待处置',
        },
        // 仓库占位演示数据：程度按序号启发式回填
        {
          id: 5, status: '待处置', pending: true, abnormal: false,
          处置编号: 'LEAK-0005', 渗漏点位: '渗漏水处置样例5', 渗漏程度: '渗漏水处置样例5',
          处置方式: '渗漏水处置样例5', 处置班组: '渗漏水处置样例5', 发现日期: '2026-09-05',
          完工日期: '2026-09-05', 处置状态: '渗漏水处置样例5',
        },
      ],
      duty: [
        {
          id: 1, status: '已交接', pending: false, abnormal: false,
          交接编号: 'D-1', 值班班组: '运维一班', 值班日期: '2026-09-01', 班次: '日班',
          值班人员: '张三', 交接事项: '正常', 交接人员: '李四', 交接状态: '已交接',
        },
        {
          id: 2, status: '交接中', pending: true, abnormal: false,
          交接编号: 'D-2', 值班班组: '运维二班', 值班日期: '2026-09-02', 班次: '没见过的班次',
          值班人员: '王五', 交接事项: '', 交接人员: '', 交接状态: '交接中',
        },
        {
          id: 3, status: '待交接', pending: true, abnormal: false,
          交接编号: 'D-3', 值班班组: '运维一班', 值班日期: 'bad-date', 班次: '运维值班交接样例3',
          值班人员: '赵六', 交接事项: '运维值班交接样例3', 交接人员: '运维值班交接样例3', 交接状态: '待交接',
        },
      ],
    }),
  }
  const migratedEnv = await loadEnv(v1)
  const leak = migratedEnv.allRows().leak
  const duty = migratedEnv.allRows().duty

  const l1 = leak.find((r) => r.id === 1)
  assert.equal(l1['判定结论'], '已完工')
  assert.equal(l1['判定锁定'], true)
  assert.equal(migratedEnv.resolveLeakVerdict(l1).status, '已完工')
  assert.match(l1['备注'], /历史结论保留/)

  const l2 = leak.find((r) => r.id === 2)
  assert.equal(l2['处置方式'], '注浆封堵')
  assert.equal(l2['判定结论'], '已完工')
  assert.match(l2['备注'], /回填/)

  const l3 = leak.find((r) => r.id === 3)
  assert.equal(l3['完工日期'], '')
  assert.match(l3['备注'], /以流程状态为准/)

  const l4 = leak.find((r) => r.id === 4)
  assert.equal(l4.status, '待补录')
  assert.equal(l4['处置编号'], '（待补录）')

  const l5 = leak.find((r) => r.id === 5)
  // (id-1)%3: id=5 → 4%3 = 1 → 中度渗漏
  assert.equal(l5['渗漏程度'], '中度渗漏')
  assert.match(l5['备注'], /现场核定/)

  // 值班迁移
  const d1 = duty.find((r) => r.id === 1)
  assert.equal(d1['班次'], '白班 08:00-20:00')
  const d2 = duty.find((r) => r.id === 2)
  assert.equal(d2['班次'], '')
  assert.equal(d2['交接事项'], '')
  assert.match(d2['备注'], /班次/)
  const d3 = duty.find((r) => r.id === 3)
  // 演示数据：id 奇数补排白班，偶数补排夜班
  assert.equal(d3['班次'], '白班 08:00-20:00')
  assert.equal(d3['值班日期'], '')
  assert.match(d3['备注'], /值班日期/)
})

test('v1 迁移只执行一次：迁移结果落盘 version=2，再次读取不重复迁移', async () => {
  const ls = makeLocalStorage({
    [STORAGE_KEY]: JSON.stringify({
      leak: [
        {
          id: 1, status: '已完工', pending: false, abnormal: false,
          处置编号: 'LEAK-V-1', 渗漏点位: '点', 渗漏程度: '中度渗漏', 处置方式: '',
          处置班组: '班', 发现日期: '2020-01-01', 完工日期: '2020-01-03', 处置状态: '已完工',
        },
      ],
    }),
  })
  globalThis.__HARNESS_LS__ = ls
  const modA = await loadEnv(ls)
  const firstNote = modA.allRows().leak[0]['备注']
  const persisted = ls._dump()
  assert.equal(persisted.version, 2)
  // 第二次用已落盘数据启动，备注不重复追加
  globalThis.__HARNESS_LS__ = makeLocalStorage({ [STORAGE_KEY]: JSON.stringify(persisted) })
  const modB = await loadEnv(globalThis.__HARNESS_LS__)
  assert.equal(modB.allRows().leak[0]['备注'], firstNote)
})

test('落库校验失败整笔退回（重复 id）', () => {
  const rows = env.allRows().leak
  const dup = [...rows, { ...rows[0] }]
  const before = JSON.stringify(rows)
  assert.throws(() => env.commitEntries({ ...env.allRows(), leak: dup }), /重复/)
  assert.equal(JSON.stringify(env.allRows().leak), before, '缓存未被污染')
})

test('程度 / 方式别名归一（老叫法与新叫法同判）', () => {
  assert.equal(env.normalizeDegree('涌水'), '严重渗漏')
  assert.equal(env.normalizeDegree('滴漏'), '中度渗漏')
  assert.equal(env.normalizeDegree('湿渍'), '轻微渗漏')
  assert.equal(env.normalizeMethod('灌浆'), '注浆封堵')
  assert.equal(env.normalizeMethod('开槽引排'), '引排水处理')
  assert.equal(env.standardMethodFor('轻微渗漏'), '引排水处理')
  assert.equal(env.standardMethodFor('中度渗漏'), '注浆封堵')
})
