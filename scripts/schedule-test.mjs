#!/usr/bin/env node
/**
 * schedule-test.mjs — 定时自动备份（daemon-loop）验收
 *
 * 验证：
 *   1 到点后触发一次备份（用迷你 $DSH_HOME，只打 03-hindsight，几秒完成）
 *   2 写出 schedule.json（记录 lastDate / 结果），供面板与排障查看
 *   3 同一天不重复跑（去重）
 *   4 effect 的清理函数可调用（卸载时定时器停止）
 *   5 未启用时不注册定时器、也不写 schedule.json
 *
 * 用法：node scripts/schedule-test.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const indexPath = 'file:///' + join(HERE, '..', 'lib', 'index.js').replace(/\\/g, '/').replace(/ /g, '%20')

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const root = mkdtempSync(join(tmpdir(), 'vault-sched-'))
const home = join(root, 'home')
const out = join(root, 'out')
mkdirSync(join(home, 'sessions'), { recursive: true })
writeFileSync(join(home, 'config.json'), '{"sched":1}', 'utf8')
writeFileSync(join(home, 'sessions', 's.jsonl'), '{"seq":1}\n', 'utf8')

/** 造一个最小可用的 mock ctx（只实现插件真正用到的原语）。 */
function mockCtx() {
  const logs = []
  const tools = []
  const disposers = []
  return {
    logs, tools, disposers,
    ctx: {
      logger: { info: (m) => logs.push(String(m)), warn: (m) => logs.push('WARN ' + m), error: (m) => logs.push('ERR ' + m), debug: () => {} },
      tools: { register: (t) => { tools.push(t.name); return () => {} } },
      // 记 name：插件现在会注册多个 effect（UI 就绪轮询 + 定时备份），
      // 只数数量会把两者混为一谈（本次改动就暴露了这一点）→ 断言要按名字精确区分
      effect: (fn, name) => { const d = fn(); if (typeof d === 'function') disposers.push({ name: name ?? '', dispose: d }); return d },
      get: () => null,
      on: () => {},
    },
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 用例 1-4：启用并触发 ───────────────────────────────────────────────────
try {
  const { apply } = await import(indexPath)
  process.env.DSH_HOME = home                      // paths.js 优先读它 → 插件会认这个"假 home"
  const { ctx, logs, tools, disposers } = mockCtx()
  const past = new Date(Date.now() - 5 * 60_000)   // 5 分钟前 → 必然"已过点"
  const hhmm = `${String(past.getHours()).padStart(2, '0')}:${String(past.getMinutes()).padStart(2, '0')}`

  apply(ctx, {
    dshHome: home,
    outDir: out,
    // intervalMs：把检查周期压到 300ms，测试才能真观察到"第二次 tick 有没有被去重挡住"
    // （GLM-5.3 审查：原用例只等 1.5s 而周期是 60s，无论去重在不在都通过 = 自证）
    autoBackup: { enabled: true, dailyAt: hhmm, scope: 'core', outDir: out, onlyParts: ['03-hindsight'], prune: false, intervalMs: 300 },
  })

  check('1a 插件加载后注册了 6 个工具', tools.length === 6, tools.join(','))
  const schedEffects = disposers.filter((d) => d.name.includes('auto backup'))
  check('1b 启用了定时备份（按 effect 名字断言，不数总数）', schedEffects.length >= 1,
    `定时 effect=${schedEffects.length}｜全部 effect=[${disposers.map((d) => d.name).join(' | ')}]`)

  // 等首次 tick（apply 内是 void tick()，异步跑）
  let pkg = null
  for (let i = 0; i < 60; i++) {
    await wait(500)
    const files = existsSync(out) ? readdirSync(out).filter((n) => n.endsWith('.vault')) : []
    if (files.length > 0) { pkg = files[0]; break }
  }
  check('2 到点后自动打出包（daemon-loop 真跑）', pkg !== null, pkg ? `包=${pkg}` : '60×500ms 内未产出包')

  const schedFile = join(home, 'plugin-data', 'dsh-vault', 'schedule.json')
  let sched = null
  try { sched = JSON.parse(readFileSync(schedFile, 'utf8')) } catch { /* 未写 */ }
  check('3 写出 schedule.json（含 lastDate / phase / 结果）',
    sched !== null && typeof sched.lastDate === 'string' && sched.phase === 'done',
    sched ? `lastDate=${sched.lastDate} phase=${sched.phase} baseName=${sched.baseName ?? '-'}` : `未找到 ${schedFile}`)

  // 周期已压到 300ms → 这段等待里有 ≥6 次 tick 机会；去重若失效会连续产出多个包
  const before = readdirSync(out).filter((n) => n.endsWith('.vault')).length
  await wait(1800)
  const after = readdirSync(out).filter((n) => n.endsWith('.vault')).length
  check('4 同一天不重复跑（去重生效，1800ms ≈ 6 个 tick 周期）',
    before === after, `tick 前后包数 ${before} → ${after}`)

  const logText = logs.join('\n')
  check('5 日志里能看到"定时自动备份已启用"与"完成"',
    /定时自动备份已启用/.test(logText) && /定时备份完成/.test(logText),
    logs.filter((l) => l.includes('定时')).slice(0, 3).join(' ｜ '))

  // ── 用例 6：**真验证**定时器停了（GLM-5.3 审查：原实现 check(..., true) 恒真 = 自证）
  // 证据用**日志里的"定时备份开始"次数**，而不是包文件数 —— 重跑可能因同名覆盖或被锁挡住，
  // 数包会误判；数"是否走到了执行分支"才是定时器活着的直接证据。
  const startedTicks = () => logs.filter((l) => l.includes('定时备份开始')).length
  writeFileSync(schedFile, '{}', 'utf8')                 // 抹掉"今天已跑过"的短路条件（顺带覆盖文件为空的场景）
  const t1 = startedTicks()
  await wait(1500)                                       // 300ms × 5
  const t2 = startedTicks()
  check('6a 抹掉短路条件后定时器仍会触发（证明机制真的在跑）', t2 > t1, `启动次数 ${t1} → ${t2}`)

  for (const d of disposers) { try { d.dispose() } catch { /* 忽略 */ } }
  writeFileSync(schedFile, '{}', 'utf8')
  const t3 = startedTicks()
  await wait(1500)
  const t4 = startedTicks()
  check('6b dispose 后定时器真的停了（同条件下不再触发）', t4 === t3, `启动次数 ${t3} → ${t4}`)
} catch (e) {
  check('定时备份用例执行', false, String(e?.message ?? e))
}

// ── 用例 7：未启用时不注册 ─────────────────────────────────────────────────
try {
  delete process.env.DSH_HOME
  const home2 = join(root, 'home2')
  const out2 = join(root, 'out2')
  mkdirSync(home2, { recursive: true })
  process.env.DSH_HOME = home2
  const { ctx, disposers, logs } = mockCtx()
  const { apply } = await import(indexPath)
  apply(ctx, { dshHome: home2, outDir: out2, autoBackup: { enabled: false } })
  await wait(800)
  const made = existsSync(out2) ? readdirSync(out2).filter((n) => n.endsWith('.vault')).length : 0
  const schedFx = disposers.filter((d) => d.name.includes('auto backup'))
  check('7 未启用：不注册定时备份、不产出包', schedFx.length === 0 && made === 0,
    `定时 effect=${schedFx.length} 包数=${made}｜全部 effect=[${disposers.map((d) => d.name).join(' | ')}]｜${logs.filter((l) => l.includes('定时')).join(' ')}`)
} catch (e) {
  check('未启用用例执行', false, String(e?.message ?? e))
}

try { rmSync(root, { recursive: true, force: true }) } catch { /* 忽略 */ }
delete process.env.DSH_HOME

const failed = results.filter((r) => !r.ok)
console.log('')
console.log(`=== ${results.length - failed.length}/${results.length} 通过 ===`)
if (failed.length > 0) {
  for (const f of failed) console.log(`  失败: ${f.name} — ${f.detail}`)
  process.exit(1)
}
