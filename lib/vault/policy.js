/**
 * policy.js — 滚动保留（AGENT.md / ADR-004 + D11）
 *
 * 默认：手动档不自动删；开启滚动后按 GFS：
 *   keepLast 7 ｜ keepDaily 14 ｜ keepWeekly 4 ｜ keepMonthly 6 ｜ maxTotalGB 200 ｜ minKeep 3
 * 保护：被增量链依赖的基包禁删；本地删除移入 _trash/（7 天），远端删除独立执行。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { acquireLock } from './lock.js'

export const DEFAULT_POLICY = {
  enabled: false,
  keepLast: 7,
  keepDaily: 14,
  keepWeekly: 4,
  keepMonthly: 6,
  maxTotalGB: 200,
  minKeep: 3,
  trashDir: '_trash',
  trashRetentionDays: 7,
}

export function listVaults(dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.vault')) continue
    const abs = join(dir, name)
    let st
    try { st = statSync(abs) } catch { continue }
    const m = /^DSHVAULT_(?<host>[^_]+)_(?<ts>\d{8}-\d{6})_(?<kind>[a-z]+)_(?<scope>[a-z]+)(?:_p(?<part>\d+))?\.vault$/.exec(name)
    out.push({
      name,
      abs,
      bytes: st.size,
      mtimeMs: st.mtimeMs,
      host: m?.groups?.host ?? null,
      stamp: m?.groups?.ts ?? null,
      createdAt: parseStamp(m?.groups?.ts) ?? new Date(st.mtimeMs),
      kind: m?.groups?.kind ?? 'unknown',
      scope: m?.groups?.scope ?? 'unknown',
      part: m?.groups?.part ? Number(m.groups.part) : 0,
      key: name.replace(/_p\d+\.vault$/, '.vault'),
      manifest: join(dir, name.replace(/\.vault$/, '.manifest.json')),
    })
  }
  return out.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
}

function parseStamp(ts) {
  if (!ts) return null
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(ts)
  if (!m) return null
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]))
}

/** 读包外 sidecar manifest 的增量链基包名（chain.baseOf）；读不到返回 null。 */
function chainBaseOf(sidecarPath) {
  if (!sidecarPath || !existsSync(sidecarPath)) return null
  try {
    const doc = JSON.parse(readFileSync(sidecarPath, 'utf8'))
    const base = doc?.chain?.baseOf
    return typeof base === 'string' && base.trim() !== '' ? base.trim() : null
  } catch {
    return null
  }
}

/** 一个逻辑包除分卷外的配套文件：明文索引 + 密钥（审查 B8：搬/删时必须一起处理）。 */
function companionsOf(dir, group) {
  const base = String(group.key).replace(/\.vault$/, '')
  return [
    { abs: join(dir, `${base}.manifest.json`), name: `${base}.manifest.json` },
    { abs: join(dir, '_keys', `${base}.key.txt`), name: `_keys-${base}.key.txt` },
  ]
}

/** _trash 内防同名冲突（Windows 上 rename 撞名会 EEXIST）。 */
function uniqueDest(abs) {
  if (!existsSync(abs)) return abs
  const dot = abs.lastIndexOf('.')
  const ext = dot > 0 ? abs.slice(dot) : ''
  const stem = dot > 0 ? abs.slice(0, dot) : abs
  for (let i = 1; i < 1000; i++) {
    const cand = `${stem}.${Date.now()}-${i}${ext}`
    if (!existsSync(cand)) return cand
  }
  return `${stem}.${Date.now()}${ext}`
}

/** 把 part 文件聚合成「逻辑备份包」（同一个 key 的多卷算一份）。 */
export function groupVaults(files) {
  const map = new Map()
  for (const f of files) {
    const g = map.get(f.key) ?? { key: f.key, parts: [], bytes: 0, createdAt: f.createdAt, kind: f.kind, scope: f.scope, host: f.host }
    g.parts.push(f)
    g.bytes += f.bytes
    if (f.createdAt > g.createdAt) g.createdAt = f.createdAt
    map.set(f.key, g)
  }
  return [...map.values()].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
}

/**
 * GFS 决策 → 删除清单（零副作用）。
 * @returns {{ keep: object[], drop: object[], reasons: Map<string,string>, totalBytes: number, keptBytes: number }}
 */
export function planRetention(dir, policy = {}) {
  const p = { ...DEFAULT_POLICY, ...policy }
  const groups = groupVaults(listVaults(dir))
  const n = groups.length
  const keep = new Set()
  const reasons = new Map()

  const mark = (g, why) => {
    const key = g.parts[0].abs
    if (!keep.has(key)) { keep.add(key); reasons.set(key, why) }
  }

  // 1) 最小保留（永不删最近 N 份）
  for (let i = 0; i < Math.min(p.minKeep, n); i++) mark(groups[i], `minKeep(${p.minKeep})`)

  // 2) keepLast
  for (let i = 0; i < Math.min(p.keepLast, n); i++) mark(groups[i], `keepLast(${p.keepLast})`)

  // 3) 日 / 周 / 月桶
  const bucket = (label, count, bucketKey) => {
    if (!(count > 0)) return          // count<=0 = 不按该维度保留（此前会在首轮 mark 一个，属小缺陷）
    const seen = new Set()
    for (const g of groups) {
      const k = bucketKey(g.createdAt)
      if (seen.has(k)) continue
      seen.add(k)
      mark(g, `${label}(${count}) 桶 ${k}`)
      if (seen.size >= count) break
    }
  }
  const dayKey = (d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
  const weekKey = (d) => {
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
    const day = t.getUTCDay() || 7
    t.setUTCDate(t.getUTCDate() + 4 - day)
    const y = t.getUTCFullYear()
    const start = new Date(Date.UTC(y, 0, 1))
    const week = Math.ceil(((t - start) / 86400000 + 1) / 7)
    return `${y}-W${week}`
  }
  const monthKey = (d) => `${d.getFullYear()}-${d.getMonth() + 1}`
  bucket('keepDaily', p.keepDaily, dayKey)
  bucket('keepWeekly', p.keepWeekly, weekKey)
  bucket('keepMonthly', p.keepMonthly, monthKey)

  // 4) 体积上限：保留总量超限时，把「最旧的、非 minKeep 保护」的已保留包降级为淘汰。
  //    ⚠️ 修正记录：原实现误用 mark()（mark 的语义是「保留」），导致一旦超限就把候选全部
  //    标记为保留 → 体积上限永不生效（policy-test 用例 06/09 暴露）。现改为 keep.delete()。
  const dropReasons = new Map()
  const protectedKeys = new Set(groups.slice(0, p.minKeep).map((g) => g.parts[0].abs))
  const limit = p.maxTotalGB * 1024 * 1024 * 1024
  let keptBytes = groups.filter((g) => keep.has(g.parts[0].abs)).reduce((s, g) => s + g.bytes, 0)
  for (const g of [...groups].reverse()) {          // groups 按时间降序 → reverse 后最旧优先
    if (keptBytes <= limit) break
    if (!keep.has(g.parts[0].abs)) continue
    if (protectedKeys.has(g.parts[0].abs)) continue // minKeep 永不删
    keep.delete(g.parts[0].abs)
    reasons.delete(g.parts[0].abs)
    dropReasons.set(g.parts[0].abs, '体积上限淘汰')
    keptBytes -= g.bytes
  }

  // 5) 增量链保护（ADR-004 / D11）：被「将保留的增量包」所依赖的 base 包不得删除。
  //    依赖关系取自包外 sidecar manifest 的 chain.baseOf（明文索引，无需解密）。
  const chainPinned = []
  {
    const byKey = new Map(groups.map((g) => [g.key, g]))
    const resolveBaseKey = (baseOf) => String(baseOf).replace(/_p\d+\.vault$/, '.vault')
    let grew = true
    while (grew) {
      grew = false
      for (const g of groups) {
        if (!keep.has(g.parts[0].abs)) continue           // 只看「留下来的包」所依赖的基包
        // 审查 B7：不能取 parts[0].manifest —— 多卷时它可能是 X_p02.manifest.json（该文件不存在），
        // 于是 chainBaseOf 恒返回 null、链保护静默失效。改为按分组 key 归一成主包的 sidecar。
        const sidecarPath = join(dir, String(g.key).replace(/_p\d+\.vault$/, '.vault').replace(/\.vault$/, '.manifest.json'))
        const baseOf = chainBaseOf(sidecarPath)
        if (!baseOf) continue
        const base = byKey.get(resolveBaseKey(baseOf))
        if (!base || keep.has(base.parts[0].abs)) continue
        keep.add(base.parts[0].abs)
        reasons.set(base.parts[0].abs, `被保留的增量包 ${g.key} 依赖（链保护）`)
        chainPinned.push(base.key)
        grew = true                                        // 基包本身可能又是更早链上的一环
      }
    }
  }

  const totalBytes = groups.reduce((s, g) => s + g.bytes, 0)
  const keepList = groups.filter((g) => keep.has(g.parts[0].abs))
  const drop = groups.filter((g) => !keep.has(g.parts[0].abs))
  return {
    policy: p,
    totalGroups: n,
    keep: keepList,
    drop,
    reasons,
    totalBytes,
    keptBytes: keepList.reduce((s, g) => s + g.bytes, 0),
    chainPinned,
    dropReasons,
  }
}

/**
 * 执行删除：本地移入 _trash/（默认）或硬删。dryRun=true 时只出清单。
 */
export function applyRetention(dir, policy = {}, { dryRun = true, hardDelete = false } = {}) {
  const plan = planRetention(dir, policy)
  const actions = []
  // 审查 B9：非 dry-run（真搬/真删）时与备份互斥 —— 锁名与 backup 相同，避免「备份正在写、清理同时在删」。
  // 注：为保持最小 diff，下面的循环体未重排缩进（JS 不依赖缩进）。
  const release = dryRun ? () => {} : acquireLock(dir, 'vault-backup')
  try {
  for (const g of plan.drop) {
    for (const f of g.parts) {
      if (dryRun) { actions.push({ file: f.abs, action: 'would-' + (hardDelete ? 'delete' : 'move-to-trash') }); continue }
      try {
        const companions = companionsOf(dir, g)
        if (hardDelete) {
          rmSync(f.abs, { force: true })
          actions.push({ file: f.abs, action: 'deleted' })
        } else {
          const trash = join(dir, policy.trashDir ?? DEFAULT_POLICY.trashDir)
          mkdirSync(trash, { recursive: true })
          const dest = uniqueDest(join(trash, f.name))
          renameSync(f.abs, dest)
          actions.push({ file: f.abs, action: 'moved-to-trash', dest })
        }
        // 审查 B8：分卷搬走后，索引（.manifest.json）与密钥（_keys/*.key.txt）必须一起搬，
        // 否则留下孤儿；_trash 内同名也不能直接撞（Windows 的 rename 会 EEXIST）。
        for (const c of companions) {
          if (!existsSync(c.abs)) continue
          if (hardDelete) {
            rmSync(c.abs, { force: true })
            actions.push({ file: c.abs, action: 'deleted', companion: true })
          } else {
            const trash = join(dir, policy.trashDir ?? DEFAULT_POLICY.trashDir)
            mkdirSync(trash, { recursive: true })
            const dest = uniqueDest(join(trash, c.name))
            renameSync(c.abs, dest)
            actions.push({ file: c.abs, action: 'moved-to-trash', dest, companion: true })
          }
        }
      } catch (e) {
        actions.push({ file: f.abs, action: 'failed', error: String(e?.message ?? e) })
      }
    }
  }
  return { plan, actions, dryRun }
  } finally {
    release()
  }
}

/** 清理 _trash 中超过保留天数的文件。 */
export function purgeTrash(dir, policy = DEFAULT_POLICY) {
  const trash = join(dir, policy.trashDir ?? DEFAULT_POLICY.trashDir)
  if (!existsSync(trash)) return []
  const cutoff = Date.now() - (policy.trashRetentionDays ?? 7) * 86400000
  const removed = []
  for (const name of readdirSync(trash)) {
    const abs = join(trash, name)
    try {
      const st = statSync(abs)
      if (st.mtimeMs < cutoff) { rmSync(abs, { recursive: true, force: true }); removed.push(abs) }
    } catch { /* 忽略 */ }
  }
  return removed
}
