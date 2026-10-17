#!/usr/bin/env node
/**
 * security-test.mjs — 安全专项验收（补跨模型审查的测试缺口 #2 / #3），零依赖
 *
 * 用例：
 *   S2-1 路径穿越拒绝：包内条目名含 `../` → 解包时必须拒绝（不逃出目标根）+ 非零退出
 *   S2-2 正常条目同包内不受影响（拒绝是精确的，不是"整包失败"）
 *   S1-1 in-place 前整根备份：目标目录被改名 <root>.bak-<stamp>，原名重建
 *   S1-2 备份里保留了原内容（marker 文件仍在 .bak 里）→ 失败可回滚
 *
 * 用法：node scripts/security-test.mjs
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'
import { EncryptTransform, deriveKey, encodeHeader, newCryptoParams } from '../lib/vault/crypto.js'
import { PartWriter } from '../lib/vault/pack.js'
import { tarWrite } from '../lib/vault/tar.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, '..', 'lib', 'vault', 'portable-restore.mjs')
const PASSWORD = 'security-test-pass'

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const root = mkdtempSync(join(tmpdir(), 'vault-sec-'))

/** 用一个条目列表打一个最小可解包（含明文头）的包。 */
async function makePack({ dir, baseName, entries }) {
  mkdirSync(dir, { recursive: true })
  const params = newCryptoParams({ chunkSize: 64 * 1024 })
  const key = await deriveKey(PASSWORD, params)
  const headerBuf = encodeHeader({
    magic: 'DSHVAULT1', schema: 1, baseName, createdAt: new Date().toISOString(),
    host: 'SECTEST', dsh: { version: 'test' }, kind: 'full', scope: 'core',
    crypto: params, partsUnknown: true,
  })
  const enc = new EncryptTransform(key, params)
  const writer = new PartWriter({ dir, baseName, partSize: 8 * 1024 * 1024, headerBuf })
  await pipeline(
    Readable.from(tarWrite(entries)),
    createGzip({ level: 1 }),
    enc,
    writer,
  )
  return join(dir, `${baseName}.vault`)
}

// ── 用例 1/2：路径穿越 ──────────────────────────────────────────────────────
try {
  const pkgDir = join(root, 'pkgs')
  const target = join(root, 'extract-target')
  mkdirSync(target, { recursive: true })
  const outside = join(root, 'EVIL-escaped.txt')   // 逃逸后应落在这里（绝不该出现）

  const pkg = await makePack({
    dir: pkgDir,
    baseName: 'DSHVAULT_SECTEST_20260101-000000_full_core',
    entries: [
      { rel: '../EVIL-escaped.txt', isDir: false, size: 5, data: Buffer.from('EVIL\n') },
      { rel: 'payload/01-dsh-home/ok.txt', isDir: false, size: 3, data: Buffer.from('ok\n') },
    ],
  })

  const r = spawnSync(process.execPath, [CLI, '--package', pkg, '--password', PASSWORD, '--target', target], { encoding: 'utf8' })
  let out = null
  try { out = JSON.parse(r.stdout) } catch { /* 保留原样 */ }

  check('S2-1 越界条目被拒绝（未逃出目标根）', !existsSync(outside),
    `越界文件存在=${existsSync(outside)}（期望 false）`)
  check('S2-2 还原器以非零退出并报告拒绝数', r.status !== 0 && (out?.rejected ?? 0) >= 1,
    `exit=${r.status} rejected=${out?.rejected} sample=${JSON.stringify(out?.rejectedSample ?? [])}`)
  check('S2-3 同包内合法条目正常落地', existsSync(join(target, 'payload', '01-dsh-home', 'ok.txt')),
    `ok.txt 存在=${existsSync(join(target, 'payload', '01-dsh-home', 'ok.txt'))}`)
} catch (e) {
  check('S2 路径穿越用例执行', false, String(e?.message ?? e))
}

// ── 用例 3/4：in-place 前整根备份 ───────────────────────────────────────────
try {
  const pkgDir2 = join(root, 'pkgs2')
  const fakeHome = join(root, 'fakehome')
  mkdirSync(fakeHome, { recursive: true })
  writeFileSync(join(fakeHome, 'marker-original.txt'), 'ORIGINAL\n', 'utf8')   // 待被保护的原数据

  const pkg2 = await makePack({
    dir: pkgDir2,
    baseName: 'DSHVAULT_SECTEST_20260101-000001_full_core',
    entries: [
      { rel: 'payload/01-dsh-home/hello.txt', isDir: false, size: 6, data: Buffer.from('hello\n') },
    ],
  })

  const r2 = spawnSync(process.execPath, [CLI, '--package', pkg2, '--password', PASSWORD, '--in-place'], {
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: fakeHome },
  })
  let out2 = null
  try { out2 = JSON.parse(r2.stdout) } catch { /* 保留原样 */ }

  const bakDirs = readdirSync(root).filter((n) => n.startsWith('fakehome.bak-'))
  const bakHasMarker = bakDirs.length > 0 && existsSync(join(root, bakDirs[0], 'marker-original.txt'))
  check('S1-1 in-place 前原目录被改名备份（.bak-<stamp>）', bakDirs.length === 1,
    `备份目录=${JSON.stringify(bakDirs)}`)
  check('S1-2 备份保留了原内容（可回滚）', bakHasMarker,
    bakHasMarker ? `${bakDirs[0]}/marker-original.txt 内容=${JSON.stringify(readFileSync(join(root, bakDirs[0], 'marker-original.txt'), 'utf8').trim())}` : '备份里找不到原 marker')
  check('S1-3 还原后的新目录内容正确', existsSync(join(fakeHome, 'hello.txt')) && readFileSync(join(fakeHome, 'hello.txt'), 'utf8') === 'hello\n',
    `hello.txt=${existsSync(join(fakeHome, 'hello.txt'))} exit=${r2.status}`)
  check('S1-4 输出中声明了被备份的根', Array.isArray(out2?.backedUpRoots) && out2.backedUpRoots.length >= 1,
    `backedUpRoots=${JSON.stringify(out2?.backedUpRoots ?? [])}`)
} catch (e) {
  check('S1 in-place 备份用例执行', false, String(e?.message ?? e))
}

// ── 用例 5-8：面板 API 护栏（审查 B10）────────────────────────────────────
try {
  const { createApi } = await import('../lib/server.js')
  const api = createApi(
    { logger: { info() {}, warn() {}, error() {}, debug() {} }, get: () => null, effect: (f) => { f?.(); return () => {} }, on() {} },
    { dshHome: root, outDir: join(root, 'backups') },
  )
  const makeRes = () => ({
    code: 0, body: '',
    writeHead(c) { this.code = c },
    end(b) { this.body = String(b ?? '') },
    setHeader() {}, write() {},
  })
  const reqOf = (over = {}) => ({ method: 'GET', url: '/health', headers: {}, socket: { remoteAddress: '127.0.0.1' }, ...over })

  const r1 = makeRes()
  await api.handle(reqOf({ socket: { remoteAddress: '192.168.1.5' } }), r1)
  check('B10-1 非本机来源被拒（403）', r1.code === 403, `code=${r1.code}`)

  const r2 = makeRes()
  await api.handle(reqOf({ headers: { origin: 'https://evil.example' } }), r2)
  check('B10-2 跨站 Origin 被拒（403）', r2.code === 403, `code=${r2.code}`)

  const r3 = makeRes()
  await api.handle(reqOf({ url: '/list?dir=' + encodeURIComponent('C:/Windows') }), r3)
  check('B10-3 越界目录被拒（400）', r3.code === 400, `code=${r3.code}`)

  const r4 = makeRes()
  await api.handle(reqOf(), r4)
  check('B10-4 本机正常请求放行（200）', r4.code === 200, `code=${r4.code}`)
} catch (e) {
  check('B10 API 护栏用例执行', false, String(e?.message ?? e))
}

// ── 用例 9-10：单实例锁（审查 B9）─────────────────────────────────────────
try {
  const { acquireLock, LockBusyError } = await import('../lib/vault/lock.js')
  const lockDir = join(root, 'locks')
  const release1 = acquireLock(lockDir, 'vault-backup')
  let held = null
  try { acquireLock(lockDir, 'vault-backup') } catch (e) { held = e }
  check('B9-1 第二次取同一把锁被拒', held instanceof LockBusyError, `err=${held?.name ?? 'none'}`)
  release1()
  let reused = null
  try { reused = acquireLock(lockDir, 'vault-backup') } catch (e) { reused = null }
  check('B9-2 释放后可再次取得', typeof reused === 'function', typeof reused === 'function' ? 'ok' : '取不到')
  if (typeof reused === 'function') reused()
} catch (e) {
  check('B9 锁用例执行', false, String(e?.message ?? e))
}

try { rmSync(root, { recursive: true, force: true }) } catch { /* 忽略 */ }

const failed = results.filter((r) => !r.ok)
console.log('')
console.log(`=== ${results.length - failed.length}/${results.length} 通过 ===`)
if (failed.length > 0) {
  for (const f of failed) console.log(`  失败: ${f.name} — ${f.detail}`)
  process.exit(1)
}
void resolve
