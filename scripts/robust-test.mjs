#!/usr/bin/env node
/**
 * robust-test.mjs — 健壮性回归（补跨模型审查的测试缺口 #1 / #7 中的两项）
 *
 * 用例：
 *   A 打包期文件突变（⑦ 号事故的正式回归）：文件在写入过程中被追加 → 包结构不得错位，
 *     读回字节数必须等于**声明 size**（不是增长后的新大小）
 *   B 写失败必须报错而非静默成功：outDir 指向一个**已存在的文件** → runBackup 必须抛错
 *   C 删除连带性（B8 回归）：prune 搬包时，manifest / _keys 里的 key 一起搬；_trash 同名不撞
 *
 * 用法：node scripts/robust-test.mjs
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'
import { tarRead, tarWrite } from '../lib/vault/tar.js'
import { applyRetention, listVaults, planRetention } from '../lib/vault/policy.js'
import { runBackup } from '../lib/vault/pack.js'

const HERE = dirname(fileURLToPath(import.meta.url))
void HERE

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const root = mkdtempSync(join(tmpdir(), 'vault-robust-'))

/** 把 async generator 收成 Buffer，并在拿到第一个 chunk 后执行 once()（模拟"写入中途文件被追加"）。 */
async function collectWithMutation(gen, once) {
  const out = []
  let first = true
  for await (const c of gen) {
    if (first) { first = false; try { once() } catch { /* 忽略 */ } }
    out.push(c)
  }
  return Buffer.concat(out)
}

// ── A 打包期文件突变（⑦ 号事故回归）───────────────────────────────────────
try {
  const big = join(root, 'growing.bin')
  const ORIGINAL = 4096
  writeFileSync(big, Buffer.alloc(ORIGINAL, 1))
  const st = statSync(big)
  const partials = []
  const entries = [{ rel: 'growing.bin', abs: big, isDir: false, size: st.size, mtimeMs: st.mtimeMs, mode: 0o644 }]

  const tarBuf = await collectWithMutation(
    tarWrite(entries, { onPartial: (p) => partials.push(p) }),
    () => appendFileSync(big, Buffer.alloc(64 * 1024, 2)),   // 头写完后立刻追加 64 KB
  )
  const grew = statSync(big).size
  check('A1 突变确实发生（文件在写入中被追加）', grew > ORIGINAL, `声明 ${ORIGINAL} B → 实际 ${grew} B`)
  // 期望长度 = 头 512 + 数据按 512 对齐 + 两个结束块 512×2
  const expectLen = 512 + Math.ceil(ORIGINAL / 512) * 512 + 512 * 2
  check('A2 tar 总长按声明 size 对齐（结构没错位）',
    tarBuf.length % 512 === 0 && tarBuf.length === expectLen,
    `tar 长度 ${tarBuf.length}（期望 ${expectLen}）`)

  // 直接用 ustar 头字段自证（不依赖 tarRead —— host 侧那个函数本就不参与打包/还原链路，
  // 且它的 body 语义有坑：把它当数组/一次性流都会拿不到数据）。
  const header = tarBuf.subarray(0, 512)
  const nameField = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
  const sizeField = header.subarray(124, 136).toString('latin1').replace(/\0.*$/, '').trim()
  const sizeOctal = parseInt(sizeField, 8)
  const dataBlock = tarBuf.subarray(512, 512 + ORIGINAL)
  const allOnes = dataBlock.length === ORIGINAL && dataBlock.every((b) => b === 1)
  const hasTwos = dataBlock.some((b) => b === 2)
  check('A3 包内声明的 size = 采集时的 size（未被增长后的新大小污染）',
    sizeOctal === ORIGINAL && nameField.includes('growing.bin'),
    `条目名 "${nameField}"，头部声明 size=${sizeOctal}（期望 ${ORIGINAL}）`)
  check('A4 数据区就是采集那一刻的内容（追加的字节没被写进去）',
    allOnes && !hasTwos,
    `前 ${ORIGINAL} 字节全为原内容=${allOnes}；含追加字节 0x02=${hasTwos}`)
} catch (e) {
  check('A 打包期突变用例执行', false, String(e?.message ?? e))
}

// ── B 写失败必须报错（不能静默成功）────────────────────────────────────────
try {
  const home = join(root, 'home-b')
  mkdirSync(join(home, 'sessions'), { recursive: true })
  writeFileSync(join(home, 'config.json'), '{"x":1}', 'utf8')
  const notADir = join(root, 'this-is-a-file')
  writeFileSync(notADir, 'x', 'utf8')          // outDir 指向文件 → 必然无法写

  let threw = null
  try {
    await runBackup({ dshHome: home, outDir: notADir, scope: 'core', encrypt: false, pgContainer: '__none__' })
  } catch (e) { threw = e }
  check('B1 不可写的 outDir → 抛错（不静默成功）', threw !== null, threw ? String(threw.message).slice(0, 90) : '没有抛错（问题！）')
} catch (e) {
  check('B 写失败用例执行', false, String(e?.message ?? e))
}

// ── C 删除连带性（B8 回归）─────────────────────────────────────────────────
try {
  const dir = join(root, 'backup-dir')
  mkdirSync(join(dir, '_keys'), { recursive: true })
  const base = 'DSHVAULT_TEST_20260101-000000_full_core'
  writeFileSync(join(dir, `${base}.vault`), Buffer.alloc(1024), 'utf8')
  writeFileSync(join(dir, `${base}_p02.vault`), Buffer.alloc(1024), 'utf8')
  writeFileSync(join(dir, `${base}.manifest.json`), '{"k":1}', 'utf8')
  writeFileSync(join(dir, '_keys', `${base}.key.txt`), 'PASSWORD', 'utf8')
  // 造一个"要保留"的新包（避免 minKeep 之外被删）
  writeFileSync(join(dir, 'DSHVAULT_TEST_20260102-000000_full_core.vault'), Buffer.alloc(2048), 'utf8')

  const plan = planRetention(dir, { keepLast: 1, minKeep: 1, keepDaily: 0, keepWeekly: 0, keepMonthly: 0 })
  check('C0 计划里确实要淘汰旧包', plan.drop.some((g) => g.key.startsWith(base)), `drop=${plan.drop.map((g) => g.key).join(',')}`)

  const res = applyRetention(dir, { keepLast: 1, minKeep: 1, keepDaily: 0, keepWeekly: 0, keepMonthly: 0 }, { dryRun: false, hardDelete: false })
  const trash = join(dir, '_trash')
  const trashNames = existsSync(trash) ? readdirSync(trash) : []
  const movedVault = trashNames.some((n) => n.startsWith(`${base}.vault`))
  const movedManifest = trashNames.some((n) => n.includes('.manifest.json'))
  const movedKey = trashNames.some((n) => n.includes('.key.txt'))
  check('C1 包体被移入 _trash', movedVault, `_trash: ${trashNames.join(', ') || '(空)'}`)
  check('C2 明文索引（manifest）连带搬走（B8 回归）', movedManifest, `movedManifest=${movedManifest}`)
  check('C3 密钥文件（_keys/*.key.txt）连带搬走', movedKey, `movedKey=${movedKey}`)
  check('C4 原目录里不再残留这些孤儿文件',
    !existsSync(join(dir, `${base}.manifest.json`)) && !existsSync(join(dir, '_keys', `${base}.key.txt`)),
    `残留 manifest=${existsSync(join(dir, `${base}.manifest.json`))}`)

  // 再放一组同名文件 → 再次搬入 _trash 不应撞名
  writeFileSync(join(dir, `${base}.vault`), Buffer.alloc(512), 'utf8')
  writeFileSync(join(dir, `${base}.manifest.json`), '{"k":2}', 'utf8')
  const res2 = applyRetention(dir, { keepLast: 1, minKeep: 1, keepDaily: 0, keepWeekly: 0, keepMonthly: 0 }, { dryRun: false, hardDelete: false })
  const failed = [...res.actions, ...res2.actions].filter((a) => a.action === 'failed')
  check('C5 _trash 同名不撞（加了时间戳后缀）', failed.length === 0,
    failed.length ? `失败 ${failed.length} 条：${failed[0].error}` : `两轮共搬 ${trashNames.length} → ${readdirSync(trash).length} 项`)

  void res2
  void listVaults
} catch (e) {
  check('C 删除连带性用例执行', false, String(e?.message ?? e))
}

// ── D 真并发：两个备份同时跑，第二个必须被锁拒绝（B9 真并发验证）──────────
try {
  const home = join(root, 'home-d')
  mkdirSync(join(home, 'sessions'), { recursive: true })
  writeFileSync(join(home, 'config.json'), '{"d":1}', 'utf8')
  const out = join(root, 'out-d')

  const first = runBackup({ dshHome: home, outDir: out, scope: 'core', encrypt: false, pgContainer: '__none__' })
  await new Promise((r) => setTimeout(r, 80))            // 让第一个先拿到锁
  let secondErr = null
  try {
    await runBackup({ dshHome: home, outDir: out, scope: 'core', encrypt: false, pgContainer: '__none__' })
  } catch (e) { secondErr = e }
  const r1 = await first

  check('D1 第一个备份正常完成', Boolean(r1?.baseName) && r1.parts.length >= 1, r1 ? r1.baseName : 'failed')
  check('D2 第二个并发备份被锁拒绝（不会互相覆盖）',
    secondErr !== null && /Lock|另一个任务正在运行/.test(String(secondErr?.name ?? '') + String(secondErr?.message ?? '')),
    secondErr ? `${secondErr.name}: ${String(secondErr.message).slice(0, 80)}` : '没有被拒绝（问题！）')
  const lockLeft = existsSync(join(home, 'plugin-data', 'dsh-vault', 'vault-backup.lock'))
  check('D3 结束后不残留锁文件', !lockLeft, `残留=${lockLeft}`)
} catch (e) {
  check('D 并发用例执行', false, String(e?.message ?? e))
}

// ── E 解密资源上限：伪造超大帧长必须被立即拒绝（不攒到 OOM）──────────────
try {
  const { DecryptTransform, deriveKey, newCryptoParams } = await import('../lib/vault/crypto.js')
  const params = newCryptoParams({ chunkSize: 64 * 1024 })
  const key = await deriveKey('whatever', params)
  const dt = new DecryptTransform(key, params)
  const evil = Buffer.alloc(4 + 4 + 16)
  evil.writeUInt32LE(0x7fffffff, 0)                      // 声明一帧约 2 GB
  let threw = null
  dt.on('error', (e) => { threw = e })
  dt.write(evil)
  await new Promise((r) => setTimeout(r, 250))
  check('E1 超大帧长被立即拒绝（不会一路攒到 OOM）',
    threw !== null && /帧长度非法/.test(String(threw.message)),
    threw ? String(threw.message).slice(0, 90) : '没有报错（问题！）')
} catch (e) {
  check('E 资源上限用例执行', false, String(e?.message ?? e))
}

try { rmSync(root, { recursive: true, force: true }) } catch { /* 忽略 */ }

const failedAll = results.filter((r) => !r.ok)
console.log('')
console.log(`=== ${results.length - failedAll.length}/${results.length} 通过 ===`)
if (failedAll.length > 0) {
  for (const f of failedAll) console.log(`  失败: ${f.name} — ${f.detail}`)
  process.exit(1)
}
