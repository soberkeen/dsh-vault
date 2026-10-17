#!/usr/bin/env node
/**
 * boundary-test.mjs — dsh-vault 边界与健壮性测试（T-BT · 11 用例）
 *
 * 纯 ESM，只用 node: 内置模块，零 npm 依赖；fixture 落在 os.tmpdir()/vault-bt-*，结束时清理。
 *
 * 低层直测：lib/vault/tar.js（tarWrite/tarRead）、crypto.js（encodeHeader/decodeHeader）、
 *          pack.js（PartWriter 分卷）
 * 真实打包：pack.js 的 runBackup（dshHome 指向 fixture → 只扫 01-dsh-home 分区）
 * 端到端　：子进程调 lib/vault/portable-restore.mjs（--verify / --target），断言退出码与 stderr 语义
 *
 * 用法：node scripts/boundary-test.mjs
 * 退出码：0 = 11/11 PASS；1 = 存在 FAIL
 */
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { Writable, Readable, pipeline } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createGzip } from 'node:zlib'
import { EncryptTransform, MAGIC, decodeHeader, deriveKey, encodeHeader, newCryptoParams } from '../lib/vault/crypto.js'
import { PartWriter, runBackup } from '../lib/vault/pack.js'
import { tarRead, tarWrite } from '../lib/vault/tar.js'
import { isoNow } from '../lib/vault/io.js'

const pipe = promisify(pipeline)
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const RESTORE_CLI = join(ROOT, 'lib', 'vault', 'portable-restore.mjs')

const PASSWORD = 'Boundary#Pass42'        // 需符合密码策略（首字母大写 / 含特殊符号 / ≥8 位）
const WRONG_PASSWORD = 'Boundary#Pass43'
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
const BLOCK = 512
const MIB = 1024 * 1024

// ── 断言与输出 ──────────────────────────────────────────────────────────────
class AssertionError extends Error {}

function ok(cond, msg) {
  if (!cond) throw new AssertionError(msg)
}

const results = []
function row(id, name, passed, detail) {
  results.push({ id, name, passed })
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${id} ${name}${detail ? `  — ${detail}` : ''}`)
}
function info(line) { console.log(`      ${line}`) }
function stage(line) { console.log(`[STAGE] ${line}`) }

// ── 基础工具 ────────────────────────────────────────────────────────────────
function sha256(buf) { return createHash('sha256').update(buf).digest('hex') }
function sha256File(abs) { return sha256(readFileSync(abs)) }
function human(n) {
  if (n < 1024) return `${n} B`
  if (n < MIB) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / MIB).toFixed(1)} MB`
}
function writeIn(base, rel, data) {
  const abs = join(base, ...rel.split('/'))
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, data)
  return abs
}
function readOctal(buf) {
  const s = buf.toString('latin1').replace(/\0.*$/, '').trim()
  return s === '' ? 0 : parseInt(s, 8)
}
function blockType(buf, off) { return String.fromCharCode(buf[off + 156]) }
function blockName(buf, off) { return buf.subarray(off, off + 100).toString('utf8').replace(/\0.*$/, '') }

/** 收集 tarWrite 的字节流。 */
async function tarBytes(entries) {
  const chunks = []
  for await (const c of tarWrite(entries)) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
  return Buffer.concat(chunks)
}

/** tarRead 回读整个 tar buffer（完整消费 body）。 */
async function readTarEntries(buf) {
  const out = []
  const src = (async function* () { yield buf })()
  for await (const e of tarRead(src)) {
    const chunks = []
    for await (const c of e.body) chunks.push(c)
    out.push({ rel: e.rel, isDir: e.isDir, size: e.size, mode: e.mode, data: Buffer.concat(chunks) })
  }
  return out
}

function runRestore(args, opts = {}) {
  const r = spawnSync(process.execPath, [RESTORE_CLI, ...args], { encoding: 'utf8', timeout: opts.timeout ?? 120000 })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error }
}

/** 枚举包所在目录的全部分卷（主包 + _pNN.vault）。 */
function partsIn(dir, baseName) {
  const names = readdirSync(dir).filter((n) => /\.vault$/.test(n))
  return names.filter((n) => n === `${baseName}.vault` || new RegExp(`^${escapeRe(baseName)}_p\\d+\\.vault$`).test(n))
    .sort()
    .map((n) => ({ name: n, abs: join(dir, n), bytes: statSync(join(dir, n)).size }))
}
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

/** 逐卷跳过明文头 → 拼接密文 → 逐帧解析（验证帧流闭合，返回帧数与残留字节）。 */
function scanFrames(dir, baseName) {
  const parts = partsIn(dir, baseName)
  const bufs = []
  for (const p of parts) {
    const buf = readFileSync(p.abs)
    const { headerBytes } = decodeHeader(buf)
    bufs.push(buf.subarray(headerBytes))
  }
  const ct = Buffer.concat(bufs)
  const frames = []
  let off = 0
  while (off + 4 <= ct.length) {
    const len = ct.readUInt32LE(off)
    if (len <= 16 || off + 4 + len > ct.length) break
    frames.push({ head: off, len })
    off += 4 + len
  }
  return { parts, frames, rest: ct.length - off, cipherBytes: ct.length }
}

/**
 * 与 pack.js 同构的最小打包器：tar（tarWrite）→ gzip → AES-GCM 分块（EncryptTransform）→ 分卷（PartWriter）
 * → 明文头（encodeHeader）+ 侧车 manifest。用于无法经扫描层构造的边界内容（空目录条目等）。
 */
async function packLowLevel({ entries, outDir, baseName, password, partBytes, chunkSize }) {
  mkdirSync(outDir, { recursive: true })
  const params = newCryptoParams({ chunkSize })
  const key = await deriveKey(password, params)
  const manifest = {
    magic: MAGIC, schema: 1, baseName, createdAt: isoNow(), host: 'boundary-test',
    kind: 'full', scope: 'core',
    crypto: { cipher: params.cipher, chunkSize: params.chunkSize, kdf: params.kdf, baseIV: params.baseIV },
    partitions: [{ id: '01-dsh-home', label: 'boundary fixture', files: entries.filter((e) => !e.isDir).length, bytes: 0, tier0: 0, tier1: 0, excludedCount: 0 }],
    workspaces: [], parts: [], plainHash: null,
  }
  const docs = [
    { rel: 'RESTORE/manifest.json', isDir: false, size: 0, mtimeMs: Date.now(), mode: 0o644, data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') },
    { rel: 'RESTORE/README.md', isDir: false, size: 0, mtimeMs: Date.now(), mode: 0o644, data: Buffer.from('# boundary-test fixture package\n', 'utf8') },
  ].map((d) => ({ ...d, size: d.data.length }))

  const headerBuf = encodeHeader({
    magic: MAGIC, schema: 1, baseName, createdAt: manifest.createdAt, host: 'boundary-test',
    kind: 'full', scope: 'core', crypto: manifest.crypto, partsUnknown: true,
  })
  const staging = join(outDir, '_staging_low')
  mkdirSync(staging, { recursive: true })
  const enc = new EncryptTransform(key, params)
  const writer = new PartWriter({ dir: staging, baseName, partSize: partBytes, headerBuf })
  await pipe(Readable.from(tarWrite([...docs, ...entries])), createGzip({ level: 6 }), enc, writer)
  const res = writer.result()
  manifest.plainHash = enc.plainDigest()
  manifest.parts = res.parts.map((p) => ({ name: p.name, bytes: p.bytes, sha256: p.sha256 }))

  const landed = []
  for (const p of res.parts) {
    const dest = join(outDir, p.name)
    rmSync(dest, { force: true })
    renameSync(p.abs, dest)
    landed.push({ name: p.name, abs: dest, bytes: p.bytes })
  }
  writeFileSync(join(outDir, `${baseName}.manifest.json`), JSON.stringify(manifest, null, 2), 'utf8')
  return { baseName, outDir, parts: landed, plainHash: manifest.plainHash, entries: entries.length }
}

// ── fixture 与准备阶段 ──────────────────────────────────────────────────────
const LONG_DIR = 'd'.repeat(60)
const LONG_FILE = 'f'.repeat(60)
const LONG_REL = `longpath/${LONG_DIR}/${LONG_FILE}.txt`
const UNICODE_REL = '中文目录/记忆 🧠·notes.txt'
const PAD_BYTES = 1 * MIB

const ctx = {}

async function prepare(root) {
  const A = join(root, 'fixtureA')
  const outA = join(root, 'outA')
  const outLow = join(root, 'outLow')
  const extractA = join(root, 'extractA')

  // fixture A：零字节 / Unicode+emoji / 长路径 / 小文件 / 不可压缩 pad / 空目录
  writeIn(A, 'zero.txt', Buffer.alloc(0))
  writeIn(A, UNICODE_REL, Buffer.from('记忆行 1\n记忆行 2\n', 'utf8'))
  writeIn(A, 'small/alpha.txt', Buffer.from('alpha\n', 'utf8'))
  writeIn(A, 'small/beta.json', Buffer.from('{"k":1}\n', 'utf8'))
  writeIn(A, LONG_REL, Buffer.from('long path payload\n', 'utf8'))
  writeIn(A, 'pad/random-pad.txt', randomBytes(PAD_BYTES))
  mkdirSync(join(A, 'empty-dir'), { recursive: true })

  const filesA = [
    'zero.txt', UNICODE_REL, 'small/alpha.txt', 'small/beta.json', LONG_REL, 'pad/random-pad.txt',
  ]

  // 真实打包：runBackup（dshHome → fixture，只扫 01-dsh-home；关掉 installer/hindsight 分支）
  const packMain = await runBackup({
    password: PASSWORD,
    outDir: outA,
    dshHome: A,
    scope: 'core',
    onlyParts: ['01-dsh-home'],
    kind: 'full',
    partBytes: 128 * 1024,
    chunkSize: 64 * 1024,
    includeInstaller: false,
    includeHindsightDb: false,
  }, () => {})

  // 低层打包：空目录条目（扫描层只收文件，空目录只能在 tar 层构造）
  const packEmpty = await packLowLevel({
    entries: [{ rel: 'payload/01-dsh-home/empty-dir', isDir: true, size: 0, mtimeMs: Date.now(), mode: 0o755 }],
    outDir: outLow,
    baseName: 'BV_EMPTY_DIR',
    password: PASSWORD,
    partBytes: 4 * MIB,
    chunkSize: 64 * 1024,
  })

  // 端到端解包（真实包）
  const ex = runRestore(['--package', join(outA, `${packMain.baseName}.vault`), '--password', PASSWORD, '--target', extractA])
  ok(ex.status === 0, `解包退出码 ${ex.status}：${ex.stderr.slice(0, 300)}`)

  Object.assign(ctx, {
    root, A, outA, outLow, extractA, filesA, packMain, packEmpty,
    mainPart: join(outA, `${packMain.baseName}.vault`),
  })
}

// ── 11 个用例 ───────────────────────────────────────────────────────────────

// 01 空目录
async function case01() {
  const tarBuf = await tarBytes([
    { rel: 'payload/01-dsh-home/empty-dir', isDir: true, size: 0, mtimeMs: Date.now(), mode: 0o755 },
  ])
  ok(blockType(tarBuf, 0) === '5', `目录条目类型应为 '5'，实际 '${blockType(tarBuf, 0)}'`)
  ok(readOctal(tarBuf.subarray(124, 136)) === 0, '目录条目 size 应为 0')
  ok(tarBuf.length === BLOCK + BLOCK * 2, `目录条目应只占 1 头 + 2 结束块，实际 ${tarBuf.length} 字节`)

  const back = await readTarEntries(tarBuf)
  ok(back.length === 1, `回读条目数应为 1，实际 ${back.length}`)
  ok(back[0].isDir === true && back[0].rel === 'payload/01-dsh-home/empty-dir', `回读 isDir/rel 异常：${JSON.stringify({ rel: back[0].rel, isDir: back[0].isDir })}`)
  ok(back[0].size === 0, `回读 size 应为 0，实际 ${back[0].size}`)

  const dest = join(ctx.root, 'ex-empty')
  const r = runRestore(['--package', join(ctx.outLow, `${ctx.packEmpty.baseName}.vault`), '--password', PASSWORD, '--target', dest])
  ok(r.status === 0, `端到端解包退出码 ${r.status}：${r.stderr.slice(0, 200)}`)
  const landed = join(dest, 'payload', '01-dsh-home', 'empty-dir')
  ok(existsSync(landed) && statSync(landed).isDirectory(), '还原后空目录未重建')
  ok(readdirSync(landed).length === 0, '还原后的目录应为空')
  return `tar type '5' + size 0 + 端到端落地为空目录（${ctx.packEmpty.parts.length} 卷）`
}

// 02 零字节文件
async function case02() {
  const src = join(ctx.A, 'zero.txt')
  ok(statSync(src).size === 0, 'fixture 零字节文件不存在或非 0 字节')

  const tarBuf = await tarBytes([{ rel: 'payload/01-dsh-home/zero.txt', isDir: false, size: 0, mtimeMs: Date.now(), mode: 0o644, data: Buffer.alloc(0) }])
  ok(tarBuf.length === BLOCK + BLOCK * 2, `零字节条目不应有数据块（预期 ${BLOCK * 3}，实际 ${tarBuf.length}）`)
  const back = await readTarEntries(tarBuf)
  ok(back.length === 1 && back[0].size === 0 && back[0].data.length === 0, 'tar 回读零字节条目异常')

  const dst = join(ctx.extractA, 'payload', '01-dsh-home', 'zero.txt')
  ok(existsSync(dst), `还原后缺少 zero.txt：${dst}`)
  const got = sha256File(dst)
  ok(got === EMPTY_SHA256, `还原后 sha256=${got} ≠ ${EMPTY_SHA256}`)
  return `还原后 size=${statSync(dst).size} sha256=${got.slice(0, 16)}… = 空串常量`
}

// 03 20MiB 随机文件跨 chunk
async function case03() {
  const B = join(ctx.root, 'fixtureB')
  const outB = join(ctx.root, 'outB')
  const extractB = join(ctx.root, 'extractB')
  const src = writeIn(B, 'big/rand-20m.txt', randomBytes(20 * MIB))
  const srcSha = sha256File(src)

  const packBig = await runBackup({
    password: PASSWORD,
    outDir: outB,
    dshHome: B,
    scope: 'core',
    onlyParts: ['01-dsh-home'],
    kind: 'full',
    partBytes: 32 * MIB,
    includeInstaller: false,
    includeHindsightDb: false,
  }, () => {})

  const scan = scanFrames(outB, packBig.baseName)
  ok(scan.frames.length >= 3, `8 MiB/块下 20 MiB 明文应跨 ≥3 帧，实际 ${scan.frames.length} 帧`)
  ok(scan.rest === 0, `帧流未闭合：残留 ${scan.rest} 字节`)

  const r = runRestore(['--package', join(outB, `${packBig.baseName}.vault`), '--password', PASSWORD, '--target', extractB])
  ok(r.status === 0, `解包退出码 ${r.status}：${r.stderr.slice(0, 200)}`)
  const dst = join(extractB, 'payload', '01-dsh-home', 'big', 'rand-20m.txt')
  ok(existsSync(dst), '还原后缺少 20 MiB 文件')
  ok(sha256File(dst) === srcSha, `还原后 sha256 与源不一致`)
  return `20 MiB → ${scan.frames.length} 帧（密文 ${human(scan.cipherBytes)} / ${scan.parts.length} 卷），还原 sha256 一致 ${srcSha.slice(0, 16)}…`
}

// 04 长路径 >100 字节 → GNU LongLink
async function case04() {
  const nameInPack = `payload/01-dsh-home/${LONG_REL}`
  const nameBytes = Buffer.byteLength(nameInPack, 'utf8')
  ok(nameBytes > 100, `构造的路径只 ${nameBytes} 字节，未触发 LongLink`)

  const payload = Buffer.from('long path payload\n', 'utf8')
  const tarBuf = await tarBytes([{ rel: nameInPack, isDir: false, size: payload.length, mtimeMs: Date.now(), data: payload }])
  ok(blockType(tarBuf, 0) === 'L', `首头应为 GNU LongLink 'L'，实际 '${blockType(tarBuf, 0)}'`)
  ok(blockName(tarBuf, 0) === '././@LongLink', `LongLink 头名异常：${blockName(tarBuf, 0)}`)

  const llSize = readOctal(tarBuf.subarray(124, 136))
  const llData = tarBuf.subarray(BLOCK, BLOCK + llSize).subarray(0, llSize - 1).toString('utf8')
  ok(llData === nameInPack, `LongLink 数据与原名不一致`)

  const dataBlocks = Math.ceil(llSize / BLOCK)
  const fileHeadOff = BLOCK + dataBlocks * BLOCK
  ok(blockType(tarBuf, fileHeadOff) === '0', `LongLink 后应为文件头，实际 '${blockType(tarBuf, fileHeadOff)}'`)
  ok(readOctal(tarBuf.subarray(fileHeadOff + 124, fileHeadOff + 136)) === payload.length, '文件头 size 字段异常')

  const back = await readTarEntries(tarBuf)
  ok(back.length === 1 && back[0].rel === nameInPack, `tar 回读长名不一致：${back[0]?.rel?.length ?? 0} 字节`)

  const dst = join(ctx.extractA, 'payload', '01-dsh-home', ...LONG_REL.split('/'))
  ok(existsSync(dst), '真实包还原后缺少长路径文件')
  ok(sha256File(dst) === sha256(payload), '长路径文件内容 sha256 不一致')
  return `${nameBytes} 字节路径 → 'L' 头(size=${llSize}) + 还原落地一致`
}

// 05 Unicode / 中文 / emoji 文件名
async function case05() {
  const src = join(ctx.A, ...UNICODE_REL.split('/'))
  const srcSha = sha256File(src)

  const tarBuf = await tarBytes([{ rel: `payload/01-dsh-home/${UNICODE_REL}`, isDir: false, size: srcSha ? statSync(src).size : 0, mtimeMs: Date.now(), abs: src }])
  const back = await readTarEntries(tarBuf)
  ok(back.length === 1 && back[0].rel === `payload/01-dsh-home/${UNICODE_REL}`, `tar 回读 Unicode 名不一致：${back[0]?.rel}`)

  const dir = join(ctx.extractA, 'payload', '01-dsh-home', '中文目录')
  ok(existsSync(dir), '还原后缺少中文目录')
  ok(readdirSync(dir).includes('记忆 🧠·notes.txt'), `目录项不含 emoji 文件名：${readdirSync(dir).join(', ')}`)
  const dst = join(dir, '记忆 🧠·notes.txt')
  ok(sha256File(dst) === srcSha, 'Unicode 文件内容 sha256 不一致')
  return `'中文目录/记忆 🧠·notes.txt' tar 往返 + 还原一致 sha256=${srcSha.slice(0, 16)}…`
}

// 06 partBytes=64KiB → ≥3 卷且每卷可独立读头
async function case06() {
  const parts = ctx.packMain.parts
  ok(parts.length >= 3, `runBackup(partBytes=128KiB) 应产出 ≥3 卷，实际 ${parts.length} 卷`)
  const baseNames = new Set()
  for (const p of parts) {
    const abs = join(ctx.outA, p.name)
    const buf = readFileSync(abs)
    ok(buf.subarray(0, MAGIC.length).toString('latin1') === MAGIC, `${p.name} 缺明文头 magic`)
    const { header, headerBytes } = decodeHeader(buf)
    ok(header.baseName === ctx.packMain.baseName, `${p.name} 头 baseName 与外层不一致`)
    ok(headerBytes > MAGIC.length, `${p.name} 头长度异常`)
    baseNames.add(header.baseName)
  }
  ok(baseNames.size === 1, '各卷 header baseName 不一致')

  // 低层直测 PartWriter（真实 pipeline 的 chunk 粒度：每块 < partSize）
  const dir = join(ctx.root, 'pw-direct')
  mkdirSync(dir, { recursive: true })
  const headerBuf = encodeHeader({ magic: MAGIC, schema: 1, baseName: 'PW_DIRECT', partsUnknown: true, crypto: {} })
  const pw = new PartWriter({ dir, baseName: 'PW_DIRECT', partSize: 64 * 1024, headerBuf })
  for (let i = 0; i < 32; i++) {
    await new Promise((res, rej) => pw.write(Buffer.alloc(8 * 1024, i & 0xff), (e) => (e ? rej(e) : res())))
  }
  await new Promise((res, rej) => pw.end((e) => (e ? rej(e) : res())))
  const pr = pw.result()
  ok(pr.parts.length >= 3, `PartWriter 直测应产出 ≥3 卷，实际 ${pr.parts.length}`)
  for (const p of pr.parts) {
    const buf = readFileSync(p.abs)
    ok(buf.subarray(0, MAGIC.length).toString('latin1') === MAGIC, `${p.name} 缺明文头 magic`)
    const { header } = decodeHeader(buf)
    ok(header.baseName === 'PW_DIRECT', `${p.name} 直测头 baseName 异常`)
  }
  const sizes = pr.parts.map((p) => human(p.bytes)).join(' / ')
  return `runBackup ${parts.length} 卷（每卷头可读）；PartWriter 直测 ${pr.parts.length} 卷 [${sizes}]`
}

// 07 删中间卷 → 还原失败且 stderr 含缺卷名
async function case07() {
  const dir = join(ctx.root, 'neg-missing')
  mkdirSync(dir, { recursive: true })
  const parts = ctx.packMain.parts.map((p) => p.name)
  ok(parts.length >= 3, `需要 ≥3 卷才能测「删中间卷」，实际 ${parts.length}`)
  for (const n of parts) copyFileSync(join(ctx.outA, n), join(dir, n))
  const missing = parts[1]
  rmSync(join(dir, missing), { force: true })
  ok(!existsSync(join(dir, missing)), `未成功删除 ${missing}`)

  const r = runRestore(['--package', join(dir, `${ctx.packMain.baseName}.vault`), '--password', PASSWORD, '--verify'])
  ok(r.status !== 0, `缺卷时退出码应为非 0，实际 ${r.status}`)
  ok(/缺少分卷/.test(r.stderr), `stderr 未报缺卷：${r.stderr.slice(0, 200)}`)
  ok(r.stderr.includes(basename(missing)), `stderr 未含缺卷名 ${missing}`)
  return `删 ${missing} → exit ${r.status}，stderr 命中「缺少分卷：${missing}」`
}

// 08 翻转卷中段 1 字节 → GCM 认证失败
async function case08() {
  const dir = join(ctx.root, 'neg-bitflip')
  mkdirSync(dir, { recursive: true })
  for (const p of ctx.packMain.parts) copyFileSync(join(ctx.outA, p.name), join(dir, p.name))

  const mainAbs = join(dir, `${ctx.packMain.baseName}.vault`)
  const buf = readFileSync(mainAbs)
  const { headerBytes } = decodeHeader(buf)
  const target = headerBytes + 4 + 8 // 第一帧 payload 内部
  ok(target < buf.length, '主包太短，无法在密文帧内翻转字节')
  const before = buf[target]
  buf[target] = before ^ 0xff
  writeFileSync(mainAbs, buf)

  const r = runRestore(['--package', mainAbs, '--password', PASSWORD, '--verify'])
  ok(r.status !== 0, `篡改 1 字节后退出码应为非 0，实际 ${r.status}`)
  ok(/认证失败|解密/.test(r.stderr), `stderr 未报认证失败：${r.stderr.slice(0, 200)}`)
  return `offset ${target} 0x${before.toString(16)}→0x${(before ^ 0xff).toString(16)} → exit ${r.status}（GCM 认证失败）`
}

// 09 错误密码被拒
async function case09() {
  const r = runRestore(['--package', ctx.mainPart, '--password', WRONG_PASSWORD, '--verify'])
  ok(r.status !== 0, `错误密码退出码应为非 0，实际 ${r.status}`)
  // v2（凭证绑定）给的是更明确的诊断（passphrase-mismatch / account-mismatch）；
  // v1（随机密码）走 GCM 认证失败 —— 两者都属于"被正确拒绝"
  ok(/认证失败|解密|mismatch|密码不对|解不出密钥/.test(r.stderr), `stderr 未报认证失败：${r.stderr.slice(0, 200)}`)
  ok(!/"ok":\s*true/.test(r.stdout), '错误密码竟然输出了 ok:true')
  return `错误密码 → exit ${r.status}（明文头可读、密钥/密文认证失败）`
}

// 10 还原后逐文件 sha256 与源一致（输出比对表）
async function case10() {
  const rows = []
  let same = 0
  for (const rel of ctx.filesA) {
    const srcAbs = join(ctx.A, ...rel.split('/'))
    const dstAbs = join(ctx.extractA, 'payload', '01-dsh-home', ...rel.split('/'))
    const s = sha256File(srcAbs)
    const d = existsSync(dstAbs) ? sha256File(dstAbs) : '(缺失)'
    const match = s === d
    if (match) same++
    rows.push(`  ${match ? 'OK  ' : 'DIFF'} ${rel}  src=${s.slice(0, 12)}… dst=${String(d).slice(0, 12)}…  ${human(statSync(srcAbs).size)}`)
  }
  for (const line of rows) info(line)
  ok(same === ctx.filesA.length, `比对表不一致：${same}/${ctx.filesA.length} 通过`)
  ok(same >= 4, `比对表样本过少：${same}`)
  return `逐文件 sha256 比对 ${same}/${ctx.filesA.length} 一致（见上方比对表）`
}

// 11 破坏明文头 magic → 报错含 magic
async function case11() {
  // 低层：encodeHeader / decodeHeader 往返 + magic 破坏
  const header = { magic: MAGIC, schema: 1, baseName: 'BV_HEADER', createdAt: isoNow(), crypto: {} }
  const enc = encodeHeader(header)
  const dec = decodeHeader(enc)
  ok(dec.header.baseName === 'BV_HEADER', 'decodeHeader 往返 baseName 不一致')
  ok(dec.headerBytes === enc.length, `headerBytes=${dec.headerBytes} ≠ 实际 ${enc.length}`)
  const broken = Buffer.from(enc)
  broken[0] = 0x58
  let lowErr = ''
  try { decodeHeader(broken) } catch (e) { lowErr = String(e.message ?? e) }
  ok(/magic/.test(lowErr), `decodeHeader 破坏 magic 后未报 magic：${lowErr}`)
  let shortErr = ''
  try { decodeHeader(Buffer.alloc(4)) } catch (e) { shortErr = String(e.message ?? e) }
  ok(/头部|magic/.test(shortErr), `decodeHeader 短头未报错：${shortErr}`)

  // 端到端：把主包 magic 改写 → 还原器必须拒绝
  const dir = join(ctx.root, 'neg-magic')
  mkdirSync(dir, { recursive: true })
  const mainName = `${ctx.packMain.baseName}.vault`
  const buf = readFileSync(ctx.mainPart)
  buf.write('XXXXXXXXX', 0, 'latin1')
  writeFileSync(join(dir, mainName), buf)

  const r = runRestore(['--package', join(dir, mainName), '--password', PASSWORD, '--verify'])
  ok(r.status !== 0, `magic 破坏后退出码应为非 0，实际 ${r.status}`)
  ok(/magic/i.test(r.stderr), `stderr 未含 magic/header：${r.stderr.slice(0, 200)}`)
  return `decodeHeader 往返 OK；magic 破坏 → exit ${r.status}「${r.stderr.split('\n')[0].slice(0, 80)}」`
}

// ── 表驱动执行 ──────────────────────────────────────────────────────────────
const CASES = [
  ['01', '空目录（tar type 5 + 端到端重建）', case01],
  ['02', '零字节文件（sha256 = e3b0c442…）', case02],
  ['03', '20 MiB 随机文件跨 chunk（≥3 帧）', case03],
  ['04', '长路径 >100 字节（GNU LongLink）', case04],
  ['05', 'Unicode / 中文 / emoji 文件名', case05],
  ['06', '64 KiB 分卷 ≥3 卷 + 每卷独立读头', case06],
  ['07', '删中间卷 → 缺卷报错', case07],
  ['08', '翻转卷中段 1 字节 → GCM 认证失败', case08],
  ['09', '错误密码被拒', case09],
  ['10', '还原后逐文件 sha256 比对表', case10],
  ['11', '明文头 magic 破坏 → 报错含 magic', case11],
]

const started = Date.now()
let root = null

console.log('=== dsh-vault boundary-test（11 用例）===')
console.log(`node=${process.version}  restore=${RESTORE_CLI}`)

try {
  stage('fixture — 建临时目录与边界 fixture')
  root = mkdtempSync(join(tmpdir(), 'vault-bt-'))
  console.log(`      root=${root}`)

  stage('打包 — runBackup(真实路径) + packLowLevel(空目录条目) + 端到端解包')
  await prepare(root)
  console.log(`      fixtureA 文件 ${ctx.filesA.length} 个；主包 ${ctx.packMain.parts.length} 卷 / ${human(ctx.packMain.totalBytes)}`)

  stage('断言 — 表驱动 11 用例')
  for (const [id, name, fn] of CASES) {
    try {
      const detail = await fn()
      row(id, name, true, detail)
    } catch (e) {
      const detail = e instanceof AssertionError ? e.message : `${e?.constructor?.name ?? 'Error'}: ${e?.message ?? e}`
      row(id, name, false, detail)
    }
  }
} catch (e) {
  console.log(`准备阶段失败：${e?.stack ?? e}`)
  for (const [id, name] of CASES) {
    if (!results.some((r) => r.id === id)) row(id, name, false, '准备阶段失败，未执行')
  }
} finally {
  if (root) {
    try { rmSync(root, { recursive: true, force: true }) } catch { /* 忽略 */ }
    console.log(`      cleaned ${root}`)
  }
}

const failed = results.filter((r) => !r.passed)
const secs = ((Date.now() - started) / 1000).toFixed(1)
console.log('')
console.log(`=== ${results.length - failed.length}/${results.length} PASS（${secs}s）===`)
if (failed.length > 0) {
  console.log('失败项：')
  for (const f of failed) console.log(`  - ${f.id} ${f.name}`)
  process.exit(1)
}
