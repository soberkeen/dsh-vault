#!/usr/bin/env node
/**
 * policy-test.mjs — 滚动保留（GFS）决策的单元验收，零依赖
 *
 * 覆盖（10 项断言）：
 *   1 groupVaults 把 _pNN 多卷聚合成一个逻辑包
 *   2 listVaults 正确解析包名（host / 时间戳 / kind / scope / 卷号）
 *   3 minKeep 保护最近 N 个（永不删）
 *   4 keepLast 依据命中
 *   5 keepDaily 日桶代表命中
 *   6 体积上限触发淘汰，但仍受 minKeep 保护
 *   7 增量链保护：被保留的 incr 包所依赖的 base 包不得删（ADR-004 / D11）
 *   8 dry-run 零副作用（文件原地不动）
 *   9 applyRetention 把被淘汰包移入 _trash/（默认不硬删）
 *  10 purgeTrash 按保留天数清理 _trash
 *
 * 使用：node scripts/policy-test.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyRetention, groupVaults, listVaults, planRetention, purgeTrash } from '../lib/vault/policy.js'

const HERE = dirname(fileURLToPath(import.meta.url))
void HERE

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

/** 生成命名规范的时间戳（本地时间）。 */
function stamp(d) {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

const root = mkdtempSync(join(tmpdir(), 'vault-policy-'))
const dir = join(root, 'backups')
mkdirSync(dir, { recursive: true })

/** 造一个逻辑包：主包 + N-1 个分卷；可选 sidecar manifest（含 chain.baseOf）。 */
function makePack({ hoursAgo, kind = 'full', scope = 'core', parts = 1, bytesPerPart = 2048, chainBaseOf = null, host = 'TESTHOST' }) {
  const when = new Date(Date.now() - hoursAgo * 3600_000)
  const base = `DSHVAULT_${host}_${stamp(when)}_${kind}_${scope}`
  const names = []
  for (let i = 1; i <= parts; i++) {
    const name = i === 1 ? `${base}.vault` : `${base}_p${String(i).padStart(2, '0')}.vault`
    const abs = join(dir, name)
    writeFileSync(abs, Buffer.alloc(bytesPerPart, 0x41))
    utimesSync(abs, when, when)
    names.push(name)
  }
  const manifestBase = `${base}.manifest.json`
  const manifest = {
    magic: 'DSHVAULT1', baseName: base, createdAt: when.toISOString(), host, kind, scope,
    parts: names.map((n) => ({ name: n, bytes: bytesPerPart, sha256: 'x'.repeat(64) })),
    chain: { prev: null, baseOf: chainBaseOf },
    plainHash: 'y'.repeat(64),
    entries: 1, partitions: [],
  }
  writeFileSync(join(dir, manifestBase), JSON.stringify(manifest, null, 2), 'utf8')

  // 用 A+D 造一个 fake 的明文头（listVaults 只按文件名解析，不需要真头）
  return { base, names, manifestBase }
}

// ── 造 fixture ───────────────────────────────────────────────────────────────
// 8 个 full（时间递推）+ 1 个 incr（最新，声明依赖最旧的那个 full）
const fulls = []
const hoursList = [1, 26, 50, 74, 170, 340, 730, 1460] // 覆盖日内、周内、跨月
for (const h of hoursList) fulls.push(makePack({ hoursAgo: h, parts: h === 1 ? 3 : 1 }))
const oldest = fulls[fulls.length - 1]
makePack({ hoursAgo: 0, kind: 'incr', parts: 1, chainBaseOf: `${oldest.base}.vault` })

// ── 1 / 2 ────────────────────────────────────────────────────────────────────
const files = listVaults(dir)
const groups = groupVaults(files)
check('01 groupVaults 聚合多卷', groups.length === 9, `${files.length} 卷文件 → ${groups.length} 逻辑包（期望 9）`)
const newest = groups[0]
check('02 listVaults 解析包名', newest.kind === 'incr' && newest.scope === 'core' && newest.host === 'TESTHOST',
  `kind=${newest.kind} scope=${newest.scope} host=${newest.host} parts=${newest.parts.length}`)

// ── 3 / 4 / 5 ────────────────────────────────────────────────────────────────
const p1 = planRetention(dir, { minKeep: 3, keepLast: 2, keepDaily: 3, keepWeekly: 2, keepMonthly: 1, maxTotalGB: 1000, trashDir: '_trash', trashRetentionDays: 7 })
const kept = (plan) => plan.keep.map((g) => g.key)
const groupByKey = new Map(groups.map((g) => [g.key, g]))
const reasonsOf = (plan, key) => {
  const g = plan.keep.find((x) => x.key === key) ?? groupByKey.get(key)
  return g ? (plan.reasons.get(g.parts[0].abs) ?? '') : ''
}
const containsAll = (plan, keys) => keys.every((k) => kept(plan).includes(k))

check('03 minKeep 保护最近 3 个', containsAll(p1, groups.slice(0, 3).map((g) => g.key)), `keep=${kept(p1).length}/${groups.length}`)
check('04 keepLast 命中', reasonsOf(p1, groups[0].key).includes('keepLast') || reasonsOf(p1, groups[0].key).includes('minKeep'), `reason="${reasonsOf(p1, groups[0].key)}"`)
const dailyHit = groups.filter((g) => reasonsOf(p1, g.key).includes('keepDaily')).length
check('05 keepDaily 日桶代表命中', dailyHit >= 1, `命中 ${dailyHit} 个（keepDaily=3）`)

// ── 6 ────────────────────────────────────────────────────────────────────────
const tiny = planRetention(dir, { minKeep: 3, keepLast: 0, keepDaily: 0, keepWeekly: 0, keepMonthly: 0, maxTotalGB: 0.000001, trashDir: '_trash', trashRetentionDays: 7 })
const tinyKeep = kept(tiny)
const tinyPinned = (tiny.chainPinned ?? []).length
check('06 体积上限淘汰仍受 minKeep 保护', tinyKeep.length === 3 + tinyPinned,
  `保留 ${tinyKeep.length} 个 = minKeep(3) + 链保护 ${tinyPinned}（链保护是正确行为，非泄漏）`)

// ── 7 链保护 ─────────────────────────────────────────────────────────────────
const tight = planRetention(dir, { minKeep: 2, keepLast: 1, keepDaily: 1, keepWeekly: 0, keepMonthly: 0, maxTotalGB: 0.000001, trashDir: '_trash', trashRetentionDays: 7 })
const incrKey = groups[0].key
const baseKey = `${oldest.base}.vault`
const incrKept = kept(tight).includes(incrKey)
const baseKept = kept(tight).includes(baseKey)
const basePinned = tight.chainPinned?.includes(baseKey) === true
check('07 增量链保护：被保留 incr 的 base 不得删', (!incrKept) || (baseKept && basePinned),
  `incrKept=${incrKept} baseKept=${baseKept} chainPinned=${JSON.stringify(tight.chainPinned ?? [])}`)

// ── 8 dry-run 零副作用 ───────────────────────────────────────────────────────
const before = readdirSync(dir).length
const dry = applyRetention(dir, { minKeep: 2, keepLast: 1, maxTotalGB: 0.000001, trashDir: '_trash' }, { dryRun: true })
const afterDry = readdirSync(dir).length
check('08 dry-run 零副作用', before === afterDry && dry.actions.every((a) => a.action.startsWith('would-')),
  `${before} → ${afterDry} 个文件；动作 ${dry.actions.length} 条全为 would-*`)

// ── 9 apply 移入 _trash ──────────────────────────────────────────────────────
const applied = applyRetention(dir, { minKeep: 2, keepLast: 1, maxTotalGB: 0.000001, trashDir: '_trash' }, { dryRun: false, hardDelete: false })
const trashDir = join(dir, '_trash')
const trashed = existsSync(trashDir) ? readdirSync(trashDir).length : 0
const movedOk = applied.actions.filter((a) => a.action === 'moved-to-trash').length
check('09 apply 把淘汰包移入 _trash', movedOk > 0 && trashed >= movedOk, `moved=${movedOk} trash 内 ${trashed} 个文件`)

// ── 10 purgeTrash ────────────────────────────────────────────────────────────
if (trashed > 0) {
  // 把 trash 内文件 mtime 拨老 30 天，再按 7 天保留清理
  for (const n of readdirSync(trashDir)) {
    const abs = join(trashDir, n)
    const old = new Date(Date.now() - 30 * 86400000)
    utimesSync(abs, old, old)
  }
  const removed = purgeTrash(dir, { trashDir: '_trash', trashRetentionDays: 7 })
  const left = existsSync(trashDir) ? readdirSync(trashDir).length : 0
  check('10 purgeTrash 按天数清理', removed.length > 0 && left === 0, `清理 ${removed.length} 个，剩余 ${left}`)
} else {
  check('10 purgeTrash 按天数清理', false, 'trash 为空，无法验证')
}

// ── 清理 ─────────────────────────────────────────────────────────────────────
try { rmSync(root, { recursive: true, force: true }) } catch { /* 忽略 */ }

const failed = results.filter((r) => !r.ok)
console.log('')
console.log(`=== ${results.length - failed.length}/${results.length} 通过 ===`)
if (failed.length > 0) {
  for (const f of failed) console.log(`  失败: ${f.name} — ${f.detail}`)
  process.exit(1)
}
void statSync
void resolve
