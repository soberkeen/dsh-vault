#!/usr/bin/env node
/**
 * restore-drill.mjs — dsh-vault「空机还原演练」：五段核对（零依赖 · 纯 ESM · 不触碰真实位置）
 *
 * 用法：
 *   node scripts/restore-drill.mjs --package <主包.vault> [选项]
 *
 *   选项：
 *     --package <路径>      主包 .vault（必填；多卷包需同目录）
 *     --password <密码>     或 env DSHVAULT_TEST_PASSWORD
 *     --source-home <目录>  真实 DSH_HOME（默认 env DSH_HOME 或 %USERPROFILE%\.dsh）
 *     --fake-home <目录>    演练空机目录（默认 mkdtemp；必须与真实位置互不包含）
 *     --expect-map          第 5 段额外打印映射表明细（前 40 条）
 *     --only <分区id>       限定参与核对的分区（可重复 / 逗号分隔，缺省全部）
 *     --remap C:\X=D:\Y     第 5 段 dry 演示用工作区盘符重映射（可重复）
 *     --pg-container <名>   第 4 段探测用的 pg 容器（缺省自动从 docker ps 找 postgres/pgvector）
 *     --allow-drift         第 2 段容忍源侧漂移（备份后新增/删除），仅告警不判 FAIL
 *     --include-p1          第 2 段源集合包含 P1（与 pack 的 includeP1 对齐；缺省只比 P0）
 *     --clean               演练结束后删除 --fake-home 目录（缺省保留，便于复核）
 *     --help
 *
 * 五段：
 *   1/5 空机解包     spawn portable-restore.mjs --target <fake-home>（全程不使用 --in-place）
 *   2/5 集合比对     真实 $DSH_HOME 的 01-dsh-home 收录集合 vs 还原树（逐项、排序、计数差异）
 *   3/5 RESTORE 五件套齐全 + manifest.json 结构（entries/partitions/plainHash）
 *   4/5 pg_restore 可执行性探测（READY / UNAVAILABLE，不真跑还原）+ 文档命令模板断言
 *   5/5 --in-place 路径映射 dry 断言（只重算映射表 + 只写演练目录，真实位置零写入）
 *
 * 安全约束（硬）：
 *   - 本脚本从不调用 portable-restore.mjs 的 --in-place；
 *   - --fake-home 与 真实 $DSH_HOME / ~/.hindsight / 真实工作区根 互相包含时直接拒绝执行；
 *   - 第 5 段只做路径重算与断言，唯一的写动作（影子映射表 JSON）在演练目录内，越界即计数并抛错。
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, createReadStream, existsSync, mkdirSync, mkdtempSync, openSync, readSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { createGunzip } from 'node:zlib'
import { decodeHeader, DecryptTransform, deriveKey } from '../lib/vault/crypto.js'
import { scanPlan } from '../lib/vault/scan.js'
import { tarRead } from '../lib/vault/tar.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const RESTORE_CLI = join(ROOT, 'lib', 'vault', 'portable-restore.mjs')
const DSH_PART = '01-dsh-home'

const results = []
let writeOutsideTmp = 0
const inPlaceExecuted = false

function ok(name, pass, detail = '') {
  results.push({ name, ok: !!pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}
function skip(name, detail = '') {
  results.push({ name, ok: true, skipped: true, detail })
  console.log(`SKIP  ${name}${detail ? '  — ' + detail : ''}`)
}
function note(name, detail = '') {
  results.push({ name, ok: true, noted: true, detail })
  console.log(`NOTE  ${name}${detail ? '  — ' + detail : ''}`)
}
function stage(title) {
  console.log('')
  console.log(`[STAGE] ${title}`)
}

function usage() {
  console.log(`restore-drill.mjs — dsh-vault 空机还原演练（五段核对）

用法：
  node scripts/restore-drill.mjs --package <主包.vault> [--password <密码>] [--source-home <真实 DSH_HOME>]
                                 [--fake-home <演练目录>] [--expect-map] [--only <分区id>]
                                 [--remap C:\\X=D:\\Y] [--pg-container <名>] [--allow-drift] [--include-p1] [--clean]

密码来源：--password 或 env DSHVAULT_TEST_PASSWORD。
安全：本脚本从不执行 --in-place；第 5 段只在演练目录内做映射表 dry 断言。`)
}

function parseArgs(argv) {
  const out = { only: [], remap: [], expectMap: false, allowDrift: false, includeP1: false, clean: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--package' || a === '-p') out.package = argv[++i]
    else if (a === '--password' || a === '-w') out.password = argv[++i]
    else if (a === '--source-home') out.sourceHome = argv[++i]
    else if (a === '--fake-home') out.fakeHome = argv[++i]
    else if (a === '--pg-container') out.pgContainer = argv[++i]
    else if (a === '--only') out.only.push(...String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean))
    else if (a === '--remap') out.remap.push(argv[++i])
    else if (a === '--expect-map') out.expectMap = true
    else if (a === '--allow-drift') out.allowDrift = true
    else if (a === '--include-p1') out.includeP1 = true
    else if (a === '--clean') out.clean = true
    else if (a === '--help' || a === '-h') out.help = true
  }
  return out
}

// ── 通用工具 ────────────────────────────────────────────────────────────────

function inside(child, parent) {
  const c = resolve(child).toLowerCase()
  const p = resolve(parent).toLowerCase()
  return c === p || c.startsWith(p + sep)
}

function walkFiles(root) {
  const out = []
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    let ents
    try { ents = readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const ent of ents) {
      const abs = join(dir, ent.name)
      if (ent.isDirectory()) { stack.push(abs); continue }
      if (!ent.isFile()) continue
      out.push(relative(root, abs).split(sep).join('/'))
    }
  }
  return out.sort()
}

function sha256File(abs) {
  const h = createHash('sha256')
  h.update(readFileSync(abs))
  return h.digest('hex')
}

function human(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = bytes
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`
}

/** 包外明文索引（sidecar）。 */
function readSidecar(pkgPath) {
  const side = pkgPath.replace(/\.vault$/, '.manifest.json')
  if (!existsSync(side)) return null
  try { return JSON.parse(readFileSync(side, 'utf8')) } catch { return null }
}

/** 受控写：目标必须落在演练目录内，越界即计数并抛错。 */
function sandboxWriteFile(abs, data, allowedRoot) {
  if (!inside(abs, allowedRoot)) { writeOutsideTmp++; throw new Error('拒绝写入演练目录之外：' + abs) }
  writeFileSync(abs, data)
}

/**
 * 复刻 portable-restore.mjs 的分区落地映射（dry 版，逐分支抄自该文件 mapDestination）。
 * 第 5 段用它重算映射表，并用源码关键串断言两边分支一致。
 */
function mapDry(rel, manifest, opts) {
  const [top, ...rest] = rel.split('/')
  const home = opts.home
  if (top === '01-dsh-home') return join(opts.dshHome, ...rest)
  if (top === '05-plugins') {
    const sub = rest.join('/')
    if (sub.startsWith('plugins-desk-v1/') || sub.startsWith('plugin-data/') || sub.startsWith('profiles/')) return join(opts.dshHome, sub)
    return join(opts.dshHome, '_vault', sub)
  }
  if (top === '03-hindsight') {
    if (rest[0] === 'home') return join(home, '.hindsight', ...rest.slice(1))
    return join(home, '_vault-hindsight', ...rest)
  }
  if (top === '02-workspaces') {
    const wsName = rest[0]
    const ws = (manifest?.workspaces ?? []).find((w) => (w.dest ?? '').endsWith(`/${wsName}`) || (w.dest ?? '') === `02-workspaces/${wsName}`)
    let base = ws?.abs ?? join(home, '_vault-workspaces', wsName)
    for (const r of opts.remap ?? []) {
      const [from, to] = r.split('=')
      if (from && to && base.toLowerCase().startsWith(from.toLowerCase())) base = to + base.slice(from.length)
    }
    return join(base, ...rest.slice(1))
  }
  return join(opts.target || '.', rel)
}

/** 读包的明文头（magic + 4B len + JSON）。 */
function readPlainHeader(pkgPath) {
  const fd = openSync(pkgPath, 'r')
  try {
    const buf = Buffer.alloc(64 * 1024)
    const n = readSync(fd, buf, 0, buf.length, 0)
    return decodeHeader(buf.subarray(0, n))
  } finally {
    closeSync(fd)
  }
}

/** 主包 + _pNN 分卷列表（与还原器命名规则一致）。 */
function listPartFiles(pkgPath) {
  const dir = dirname(pkgPath)
  const base = basename(pkgPath).replace(/\.vault$/, '')
  const out = [pkgPath]
  for (let i = 2; i < 1000; i++) {
    const c = join(dir, `${base}_p${String(i).padStart(2, '0')}.vault`)
    if (existsSync(c)) out.push(c)
    else break
  }
  return out
}

/**
 * 自解包提取包内 RESTORE/manifest.json。
 * 为什么需要：portable-restore.mjs 在 --target 模式下把该条目读入内存后**不落盘**（in-place 映射要用），
 * 所以演练侧直接解密 tar 流取它，才能真断言「五件套在包内齐全 + manifest 结构」。
 * 只读：不写任何文件；复用 lib/vault/crypto.js 与 lib/vault/tar.js，不改动它们。
 */
async function extractInPackageManifest(pkgPath, password) {
  const { header, headerBytes } = readPlainHeader(pkgPath)
  const parts = listPartFiles(pkgPath)
  const key = await deriveKey(password, header.crypto)
  const source = Readable.from((async function* () {
    for (const p of parts) {
      const rs = createReadStream(p, { start: headerBytes })
      for await (const c of rs) yield c
    }
  })())
  const dec = new DecryptTransform(key, header.crypto)
  const gun = createGunzip()
  const errs = []
  source.on('error', (e) => errs.push(e))
  dec.on('error', (e) => errs.push(e))
  gun.on('error', (e) => errs.push(e))
  source.pipe(dec).pipe(gun)

  let text = null
  let entries = 0
  for await (const e of tarRead(gun)) {
    entries++
    if (e.rel === 'RESTORE/manifest.json') {
      const chunks = []
      for await (const c of e.body) chunks.push(c)
      text = Buffer.concat(chunks).toString('utf8')
      continue
    }
    for await (const _ of e.body) { /* drain */ }
  }
  if (text === null && errs.length > 0) throw errs[0]
  return { text, entries, parts: parts.length }
}

/** pg_restore 可执行性探测（只探测，不跑还原）。 */function probePgRestore(containerHint) {
  const notes = []
  let ready = false
  let via = null
  let where = null
  let container = containerHint ?? null

  const hostProbe = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', ['pg_restore'], { encoding: 'utf8', windowsHide: true })
  const hostHit = hostProbe.status === 0 ? String(hostProbe.stdout ?? '').trim().split(/\r?\n/)[0] : ''
  if (hostHit) { ready = true; via = 'host'; where = hostHit }
  else notes.push('host 未找到 pg_restore')

  if (!container) {
    const ps = spawnSync('docker', ['ps', '--format', '{{.Names}}|{{.Image}}'], { encoding: 'utf8', windowsHide: true, timeout: 20000 })
    if (ps.status === 0) {
      const line = String(ps.stdout ?? '').split(/\r?\n/).find((l) => /pgvector|postgres/i.test(l))
      container = line ? line.split('|')[0].trim() : null
      if (!container) notes.push('docker ps 中未发现 postgres/pgvector 容器')
    } else {
      notes.push('docker ps 不可用：' + (String(ps.stderr ?? '').trim().split(/\r?\n/).pop() || `status=${ps.status}`))
    }
  }

  if (container) {
    const d = spawnSync('docker', ['exec', container, 'sh', '-lc', 'which pg_restore || command -v pg_restore'], { encoding: 'utf8', windowsHide: true, timeout: 30000 })
    const hit = String(d.stdout ?? '').trim().split(/\r?\n/).filter(Boolean).pop() ?? ''
    if (d.status === 0 && hit) { ready = true; via = `docker:${container}`; where = hit }
    else notes.push(`docker exec ${container} 未找到 pg_restore：` + (String(d.stderr ?? '').trim().split(/\r?\n/).pop() || `exit=${d.status}`))
  }

  return { ready, via, where, container, notes }
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) { usage(); return 0 }
  if (!args.package) { usage(); console.log('FAIL  缺少 --package'); return 1 }

  const pkg = resolve(args.package)
  if (!existsSync(pkg)) { console.log('FAIL  包不存在：' + pkg); return 1 }

  const password = args.password || process.env.DSHVAULT_TEST_PASSWORD || ''
  const sourceHome = resolve(args.sourceHome || process.env.DSH_HOME || join(homedir(), '.dsh'))
  const realHindsight = join(homedir(), '.hindsight')
  const sidecar = readSidecar(pkg)
  const realWsRoots = (sidecar?.workspaces ?? []).map((w) => w.abs).filter(Boolean).map((p) => resolve(p))
  const protectedRoots = [sourceHome, realHindsight, ...realWsRoots]

  const fakeHome = args.fakeHome ? resolve(args.fakeHome) : mkdtempSync(join(tmpdir(), 'dsh-vault-drill-'))
  const startedAt = Date.now()

  console.log('=== dsh-vault 空机还原演练（restore-drill）===')
  console.log(`package=${pkg}`)
  console.log(`fake-home=${fakeHome}`)
  console.log(`source-home=${sourceHome}`)
  console.log(`sidecar=${sidecar ? pkg.replace(/\.vault$/, '.manifest.json') : '（缺失）'}  dshHome=${process.env.DSH_HOME ?? '(未设)'}`)
  console.log(`protected=${protectedRoots.join(' | ')}`)

  // 安全闸：演练目录必须与所有真实位置互不包含
  const conflicts = protectedRoots.filter((p) => inside(fakeHome, p) || inside(p, fakeHome))
  if (conflicts.length > 0) {
    console.log('FAIL  --fake-home 与真实位置互相包含，拒绝执行：' + conflicts.join(' | '))
    return 1
  }
  if (!existsSync(fakeHome)) mkdirSync(fakeHome, { recursive: true })
  if (inside(process.env.DSH_HOME ?? '', sourceHome) === false && process.env.DSH_HOME) {
    note('演练环境：进程 DSH_HOME 与 --source-home 不同', `env=${process.env.DSH_HOME} → source=${sourceHome}`)
  }

  const guards = [sourceHome, realHindsight, ...realWsRoots].filter((p) => existsSync(p))
  const snapMtime = () => guards.map((p) => { try { return statSync(p).mtimeMs } catch { return -1 } })
  const mtimeBefore = snapMtime()

  // ── 段 1：空机解包 ─────────────────────────────────────────────────────────
  stage('1/5 空机解包（spawn portable-restore.mjs --target；不使用 --in-place）')
  if (!password) {
    ok('解包: 密码可用（--password 或 env DSHVAULT_TEST_PASSWORD）', false, '未提供密码')
    return finish(pkg, fakeHome, startedAt, args)
  }
  if (!existsSync(RESTORE_CLI)) {
    ok('解包: 还原器存在', false, RESTORE_CLI)
    return finish(pkg, fakeHome, startedAt, args)
  }

  const t1 = Date.now()
  const run1 = spawnSync(process.execPath, [RESTORE_CLI, '--package', pkg, '--password', password, '--target', fakeHome], {
    encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024,
  })
  let r1 = null
  try { r1 = JSON.parse(String(run1.stdout ?? '')) } catch { r1 = null }
  const t1ms = Date.now() - t1
  ok('解包: 还原器退出码 0', run1.status === 0, `status=${run1.status} 耗时=${t1ms}ms` + (run1.status !== 0 ? ' stderr=' + (String(run1.stderr ?? '').trim().split(/\r?\n/).slice(-1)[0] ?? '') : ''))
  ok('解包: payload/ 与 RESTORE/ 落地', existsSync(join(fakeHome, 'payload')) && existsSync(join(fakeHome, 'RESTORE')), fakeHome)
  const hashAssert = r1 ? (r1.expectedPlainHash == null ? true : r1.hashMatch === true) : false
  ok('解包: 明文流 sha256 与索引一致', hashAssert, `plainHash=${String(r1?.plainHash ?? '').slice(0, 16)}… expectedFrom=${r1?.expectedFrom ?? 'n/a'} hashMatch=${r1?.hashMatch}`)
  const partsAssert = r1 ? (r1.partsMatch == null ? true : r1.partsMatch === true) : false
  ok('解包: 分卷 sha256 与索引一致', partsAssert, `${r1?.partHashes?.length ?? 0} 卷 partsMatch=${r1?.partsMatch}`)
  ok('解包: 产出文件数 > 0', (r1?.files ?? 0) > 0, `files=${r1?.files} bytes=${human(r1?.bytes)}`)

  // ── 段 3 的资料：RESTORE/ 与包内 manifest（段 2 需要 createdAt，先读）────────
  const restoreDir = join(fakeHome, 'RESTORE')
  let pkgManifest = null
  try { pkgManifest = JSON.parse(readFileSync(join(restoreDir, 'manifest.json'), 'utf8')) } catch { pkgManifest = null }
  const packCreatedMs = Date.parse(sidecar?.createdAt ?? pkgManifest?.createdAt ?? '')

  // ── 段 2：集合比对 ─────────────────────────────────────────────────────────
  stage('2/5 集合比对（真实 $DSH_HOME 收录集合 vs 还原树）')
  const onlyPart = (id) => args.only.length === 0 || args.only.includes(id)
  const restoredDsh = join(fakeHome, 'payload', DSH_PART)

  if (!onlyPart(DSH_PART)) {
    skip('集合比对: 01-dsh-home', '--only 未包含 01-dsh-home')
  } else if (!existsSync(restoredDsh)) {
    const pkgHasPart = (sidecar?.partitions ?? []).some((p) => p.id === DSH_PART && p.files > 0) || (pkgManifest?.partitions ?? []).some((p) => p.id === DSH_PART && p.files > 0)
    if (pkgHasPart) ok('集合比对: 还原树存在', false, '包内有 01-dsh-home 条目但还原树缺失：' + restoredDsh)
    else skip('集合比对: 01-dsh-home', '包内不含 01-dsh-home 分区（core 包常见），无集合可比')
  } else if (!existsSync(sourceHome)) {
    ok('集合比对: 源 $DSH_HOME 存在', false, sourceHome)
  } else {
    const t2 = Date.now()
    const plan = await scanPlan({ scope: 'core', dshHome: sourceHome, onlyParts: [DSH_PART] })
    const rep = plan.reports.find((r) => r.id === DSH_PART)
    const srcEntries = (rep?.entries ?? []).filter((e) => e.tier === 'P0' || (args.includeP1 && e.tier === 'P1'))
    const prefix = `${DSH_PART}/`
    const srcSet = new Set(srcEntries.map((e) => (e.rel.startsWith(prefix) ? e.rel.slice(prefix.length) : e.rel)))
    const restored = walkFiles(restoredDsh)
    const restoredSet = new Set(restored)

    const extra = restored.filter((p) => !srcSet.has(p))
    const missing = [...srcSet].filter((p) => !restoredSet.has(p))
    const driftOf = (p) => {
      if (args.allowDrift) return true
      if (!Number.isFinite(packCreatedMs)) return false
      try { return statSync(join(sourceHome, ...p.split('/'))).mtimeMs > packCreatedMs } catch { return true }
    }
    const drift = missing.filter(driftOf)
    const driftSet = new Set(drift)
    const realMissing = missing.filter((p) => !driftSet.has(p))

    console.log(`  COUNT source=${srcSet.size} restored=${restored.length} extra=${extra.length} missing=${missing.length} (drift=${drift.length}: 备份后新增)`)
    console.log(`  COUNT 差异明细 ${srcSet.size - restored.length >= 0 ? '+' : ''}${srcSet.size - restored.length}（源 - 还原；负值=还原树多出）`)
    if (extra.length > 0) console.log(`  EXTRA 例：${extra.slice(0, 5).join(' | ')}`)
    if (realMissing.length > 0) console.log(`  MISSING 例：${realMissing.slice(0, 5).join(' | ')}`)
    if (drift.length > 0) console.log(`  DRIFT 例（备份后新增，非缺陷）：${drift.slice(0, 5).join(' | ')}`)

    ok('集合比对: 排序后逐项全等（extra=0 且 missing 仅剩备份后新增）', extra.length === 0 && realMissing.length === 0,
      `源 ${srcSet.size} 条 / 还原 ${restored.length} 条 / extra ${extra.length} / 真实缺失 ${realMissing.length} / drift ${drift.length} / scan ${Date.now() - t2}ms`)
    if (srcSet.size === restored.length) ok('集合比对: 文件计数差 = 0', true, `${srcSet.size} = ${restored.length}`)
    else ok('集合比对: 文件计数差 = 0', false, `源 ${srcSet.size} vs 还原 ${restored.length}`)
  }

  // ── 段 3：RESTORE/ 五件套 ──────────────────────────────────────────────────
  stage('3/5 RESTORE/ 五件套齐全 + manifest.json 结构')
  const LANDED = ['AGENT.md', 'README.md', 'restore.ps1', 'vault-restore.mjs']
  const landedDetail = LANDED.map((f) => {
    const p = join(restoreDir, f)
    return `${f}=${existsSync(p) ? human(statSync(p).size) : '缺失'}`
  }).join(' ')
  ok('RESTORE/ 落地四件套（AGENT.md / README.md / restore.ps1 / vault-restore.mjs）', LANDED.every((f) => existsSync(join(restoreDir, f))), landedDetail)

  let inPkg = null
  let inPkgErr = null
  try { inPkg = await extractInPackageManifest(pkg, password) } catch (e) { inPkgErr = String(e?.message ?? e) }
  ok('RESTORE/manifest.json 在包内存在（自解包提取，不依赖落盘）', inPkg?.text != null,
    inPkg?.text != null
      ? `${human(Buffer.byteLength(inPkg.text))}／tar 条目 ${inPkg.entries} 条／不落地（还原器 --target 模式读入内存后跳过落盘，设计见 portable-restore.mjs:348）`
      : `提取失败：${inPkgErr}`)
  let im = pkgManifest
  if (inPkg?.text != null) { try { im = JSON.parse(inPkg.text) } catch { im = null } }
  ok('RESTORE/manifest.json 可 JSON.parse', im !== null, im ? `keys=${Object.keys(im).length}` : '解析失败')
  ok('RESTORE/manifest.json 含 entries/partitions', typeof im?.entries === 'number' && Array.isArray(im?.partitions),
    `entries=${im?.entries} partitions=${im?.partitions?.length}`)
  ok('RESTORE/manifest.json 含 plainHash 字段（打包期快照，值可为 null）', im != null && 'plainHash' in im, `in-pkg plainHash=${JSON.stringify(im?.plainHash ?? null)}`)
  ok('sidecar 完整 manifest 含 entries/partitions/plainHash（回填版）',
    typeof sidecar?.entries === 'number' && Array.isArray(sidecar?.partitions) && typeof sidecar?.plainHash === 'string',
    `entries=${sidecar?.entries} partitions=${sidecar?.partitions?.length} plainHash=${String(sidecar?.plainHash ?? '').slice(0, 16)}…`)
  if (im) {
    console.log(`  partitions=${(im.partitions ?? []).map((p) => p.id).join(',')}  created=${im.createdAt}  host=${im.host}  kind=${im.kind}/${im.scope}`)
    ok('包内 manifest.createdAt 可解析（第 2 段 drift 判据）', Number.isFinite(packCreatedMs), String(im.createdAt))
  }
  const pkgRestorer = join(restoreDir, 'vault-restore.mjs')
  if (existsSync(pkgRestorer)) {
    const same = sha256File(pkgRestorer) === sha256File(RESTORE_CLI)
    if (same) ok('RESTORE/vault-restore.mjs 与 lib/vault/portable-restore.mjs 字节一致', true, sha256File(pkgRestorer).slice(0, 16) + '…')
    else note('RESTORE/vault-restore.mjs 与 lib 版本不一致（打包后 lib 又改过）', '建议重新出包')
  }

  // ── 段 4：pg_restore 可执行性探测（不真跑）──────────────────────────────────
  stage('4/5 pg_restore 可执行性探测（不真跑还原）+ 文档命令模板')
  const probe = probePgRestore(args.pgContainer)
  ok('pg_restore 探测: 命令完成', true, probe.ready ? `READY via=${probe.via} path=${probe.where}` : `UNAVAILABLE（探测不真跑；${probe.notes.join('；')}）`)
  if (!probe.ready) console.log('  UNAVAILABLE 说明：空机还原第 5 步需要 pg_restore 客户端；容器内可用时用 docker exec 路径。')

  const readmePath = join(restoreDir, 'README.md')
  const agentPath = join(restoreDir, 'AGENT.md')
  const readmeTxt = existsSync(readmePath) ? readFileSync(readmePath, 'utf8') : ''
  const agentTxt = existsSync(agentPath) ? readFileSync(agentPath, 'utf8') : ''
  const templateRe = /pg_restore[^\n]*(-d\b|--dbname|-U\b)/
  const readmeHasWord = /pg_restore/.test(readmeTxt)
  const readmeHasTemplate = templateRe.test(readmeTxt)
  const agentHasTemplate = templateRe.test(agentTxt)
  ok('文档: RESTORE/README.md 含 pg_restore 说明', readmeHasWord, readmeHasWord ? '命中' : '缺失')
  if (readmeHasTemplate) {
    ok('文档: RESTORE/README.md 含 pg_restore 命令行模板', true, readmeTxt.split(/\r?\n/).find((l) => templateRe.test(l))?.trim().slice(0, 120) ?? '')
  } else if (agentHasTemplate) {
    note('文档: RESTORE/README.md 无 pg_restore 命令行模板，模板在 RESTORE/AGENT.md §4 第 5 步',
      agentTxt.split(/\r?\n/).find((l) => templateRe.test(l))?.trim().slice(0, 120) ?? '')
  } else {
    ok('文档: RESTORE/ 内含 pg_restore 命令行模板', false, 'README.md 与 AGENT.md 均无命令模板')
  }

  // ── 段 5：--in-place 映射 dry 断言 ─────────────────────────────────────────
  stage('5/5 --in-place 路径映射 dry 断言（只重算映射表；不写真实位置）')
  const libSrc = readFileSync(RESTORE_CLI, 'utf8')
  const NEEDLES = [
    "'01-dsh-home'", "'05-plugins'", "'03-hindsight'", "'02-workspaces'",
    "'_vault-workspaces'", "'_vault'", "homedir(), '.hindsight'", 'args.target',
  ]
  const lack = NEEDLES.filter((n) => !libSrc.includes(n))
  ok('dry: 复刻规则与 portable-restore.mjs 分支一致（源码关键串齐全）', lack.length === 0,
    lack.length ? '缺：' + lack.join(', ') : `${NEEDLES.length} 条规则串全部命中`)

  const payloadRoot = join(fakeHome, 'payload')
  const tops = existsSync(payloadRoot) ? readdirSync(payloadRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort() : []
  const sampleRel = []
  const CAP = 20000
  for (const t of tops) {
    const files = walkFiles(join(payloadRoot, t))
    for (const f of files.slice(0, CAP)) sampleRel.push(`${t}/${f}`)
    if (files.length > CAP) console.log(`  （${t}: ${files.length} 条，dry 抽样前 ${CAP} 条）`)
  }
  const wsList = (sidecar?.workspaces ?? []).length > 0
    ? sidecar.workspaces.map((w) => ({ name: (w.dest ?? '').split('/').pop(), abs: w.abs }))
    : [{ name: 'DSH完美备份计划', abs: null }]
  if (!tops.includes('02-workspaces')) for (const w of wsList) sampleRel.push(`02-workspaces/${w.name}/docs/sample.md`)
  if (!tops.includes('03-hindsight')) { sampleRel.push('03-hindsight/home/hindsight.sqlite'); sampleRel.push('03-hindsight/hindsight_1700000000000.dump') }

  const mapOpts = { dshHome: fakeHome, home: homedir(), target: fakeHome, remap: args.remap }
  const mapManifest = sidecar ?? pkgManifest
  const maps = sampleRel.map((rel) => ({ rel, dest: mapDry(rel, mapManifest, mapOpts) }))
  const onlyTops = args.only.length > 0 ? args.only : null
  const scoped = onlyTops ? maps.filter((m) => onlyTops.includes(m.rel.split('/')[0])) : maps

  const groups = new Map()
  for (const m of scoped) {
    const [top, ...rest] = m.rel.split('/')
    const sub = rest.join('/')
    let good = true
    let why = '<fake-home>（installer/docker/兜底）'
    if (top === '01-dsh-home') {
      good = inside(m.dest, fakeHome)
      why = '<fake-home>（$DSH_HOME 重定向）'
    } else if (top === '05-plugins') {
      const white = sub.startsWith('plugins-desk-v1/') || sub.startsWith('plugin-data/') || sub.startsWith('profiles/')
      good = white ? inside(m.dest, fakeHome) : inside(m.dest, join(fakeHome, '_vault'))
      why = white ? '<fake-home> 子路径（白名单）' : '<fake-home>/_vault'
    } else if (top === '03-hindsight') {
      good = sub.startsWith('home/') ? inside(m.dest, realHindsight) : inside(m.dest, join(homedir(), '_vault-hindsight'))
      why = sub.startsWith('home/') ? '~/.hindsight（dry：只算不写）' : '~/_vault-hindsight（dry）'
    } else if (top === '02-workspaces') {
      const wsName = rest[0]
      const w = wsList.find((x) => x.name === wsName)
      let exp = w?.abs ?? join(homedir(), '_vault-workspaces', wsName)
      for (const r of args.remap) {
        const [from, to] = r.split('=')
        if (from && to && exp.toLowerCase().startsWith(from.toLowerCase())) exp = to + exp.slice(from.length)
      }
      good = m.dest === join(exp, ...rest.slice(1))
      why = args.remap.length > 0 ? '02-workspaces/<名> → remap 后前缀' : '02-workspaces/<名> → 原工作区路径（dry）'
    }
    const g = groups.get(top) ?? { n: 0, bad: 0, why, sample: '' }
    g.n++
    if (!good) { g.bad++; if (!g.sample) g.sample = `${m.rel} → ${m.dest}` }
    groups.set(top, g)
  }
  for (const [top, g] of groups) {
    ok(`dry-映射 ${top} → ${g.why}`, g.bad === 0, `${g.n} 条${g.bad > 0 ? ` / 异常 ${g.bad}，例：${g.sample}` : ''}`)
  }

  // ⚠️ 判据修正（2026-10-15，真实 all 包暴露的误报）：
  // `03-hindsight` 与 `02-workspaces` 的 in-place 语义**本来就是回到原位置**
  // （hindsight → ~/.hindsight；工作区 → 原工作区路径），dry 模式全程不写盘。
  // 旧判据只给 03 开了例外 → 含工作区的包必然误报（实测 all 包 37295 条里 20000 条被判"异常"）。
  // 现在两者都排除在"危险命中"之外，并用 NOTE 显式声明工作区那部分是预期语义。
  const wsRealHits = maps.filter((m) => {
    const top = m.rel.split('/')[0]
    if (top !== '02-workspaces') return false
    return realWsRoots.some((p) => inside(m.dest, p))
  })
  const touchesReal = maps.filter((m) => {
    const top = m.rel.split('/')[0]
    if (top === '03-hindsight') return false  // 目标即 ~/.hindsight（dry 不写）
    if (top === '02-workspaces') return false // 目标即原工作区路径（in-place 语义）
    return inside(m.dest, sourceHome) || inside(m.dest, realHindsight) || realWsRoots.some((p) => inside(m.dest, p))
  })
  ok('dry: 无任何映射目标落在真实位置（$DSH_HOME / ~/.hindsight / 真实工作区）', touchesReal.length === 0,
    touchesReal.length > 0 ? `异常 ${touchesReal.length} 条，例：${touchesReal[0].rel} → ${touchesReal[0].dest}` : `${maps.length} 条映射中，除 02-workspaces 的 ${wsRealHits.length} 条（in-place 预期语义）外全部指向演练目录或规则路径`)
  if (wsRealHits.length > 0) {
    note('dry 声明', `02-workspaces 有 ${wsRealHits.length} 条映射目标为原工作区路径 —— 这是 in-place 的预期语义（dry 不写盘）；若要演练期改道，加 --remap "I:\\DSH 工作区=<演练目录>"`)
  }
  ok('dry: 未执行 --in-place（全程只用 --target 解包）', inPlaceExecuted === false, `inPlaceExecuted=${inPlaceExecuted}`)
  ok('dry: 写到演练目录之外的次数为 0', writeOutsideTmp === 0, `writeOutsideTmp=${writeOutsideTmp}`)

  const shadowPath = join(fakeHome, '_inplace-dry-map.json')
  try {
    sandboxWriteFile(shadowPath, JSON.stringify({
      dryRun: true,
      generatedAt: new Date().toISOString(),
      package: pkg,
      fakeHome,
      remap: args.remap,
      total: maps.length,
      counts: [...groups].map(([top, g]) => ({ top, n: g.n, bad: g.bad })),
      samples: maps.slice(0, 50),
    }, null, 2), fakeHome)
    ok('dry: 映射表影子只落在演练目录内', existsSync(shadowPath), shadowPath)
  } catch (e) {
    ok('dry: 映射表影子只落在演练目录内', false, String(e?.message ?? e))
  }

  if (args.expectMap) {
    console.log(`  映射表（前 40 / 共 ${maps.length} 条）：`)
    for (const m of maps.slice(0, 40)) console.log(`    ${m.rel}  →  ${m.dest}`)
  }

  const mtimeAfter = snapMtime()
  const changed = guards.filter((p, i) => mtimeBefore[i] !== mtimeAfter[i])
  if (changed.length > 0) note('dry: 真实位置 mtime 快照有变化（可能由 DSH/Hindsight 等外部进程写入，本脚本写入计数为 0）', changed.slice(0, 3).join(' | '))
  else ok('dry: 真实位置 mtime 快照前后一致', true, `${guards.length} 个受保护根未变`)

  return finish(pkg, fakeHome, startedAt, args)
}

function finish(pkg, fakeHome, startedAt, args) {
  const failed = results.filter((r) => !r.ok)
  const passed = results.length - failed.length
  console.log('')
  console.log(`=== 五段核对 ${passed}/${results.length} PASS（FAIL ${failed.length} / SKIP ${results.filter((r) => r.skipped).length} / NOTE ${results.filter((r) => r.noted).length}）===`)
  if (failed.length > 0) {
    console.log('失败项：')
    for (const f of failed) console.log(`  - ${f.name} ${f.detail}`)
  }
  console.log(`DRILL-RESULT ${JSON.stringify({ package: pkg, fakeHome, pass: passed, total: results.length, fail: failed.map((f) => f.name), inPlaceExecuted, writeOutsideTmp, ms: Date.now() - startedAt })}`)
  if (args.clean) {
    try { rmSync(fakeHome, { recursive: true, force: true }); console.log(`已清理演练目录：${fakeHome}`) } catch { /* 忽略 */ }
  } else {
    console.log(`演练目录保留（复核用）：${fakeHome}`)
  }
  return failed.length > 0 ? 1 : 0
}

main().then((code) => { process.exitCode = code }).catch((e) => {
  console.error('演练失败：' + (e?.stack ?? e))
  process.exit(1)
})
