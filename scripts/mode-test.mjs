#!/usr/bin/env node
/**
 * mode-test.mjs — 加密 / 不加密 两种模式端到端验证（操作者需求）
 *
 * 验证：
 *   A 不加密模式：打出来的包**真没加密**（头之后就是 gzip 魔数 1f 8b），恢复时不需要任何凭证
 *   B 凭证绑定模式（v2）：账号+密码可解；密码错被拒且说明原因；恢复码可救；本机免密可解
 *   C 密码策略：不符合"首字母大写 / 含特殊符号 / ≥8 位"的密码在**打包时就被拒绝**
 *   D 三种形态互不干扰：v0 包不会去找凭证，v2 包不会退回 v1
 *   E 旧包兼容：v1（随机密码）路径仍可解 —— 用真实的旧包验证
 *
 * 说明：为了让用例快而干净，用一个临时 $DSH_HOME（几 KB 的假文件）作为被备份对象，
 *     并用 pgContainer=__none__ 让 Hindsight 段自然跳过（不碰真实环境）。
 *
 * 用法：node scripts/mode-test.mjs
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, copyFileSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runBackup } from '../lib/vault/pack.js'
import { decodeHeader } from '../lib/vault/crypto.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, '..', 'lib', 'vault', 'portable-restore.mjs')

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const root = mkdtempSync(join(tmpdir(), 'vault-mode-'))
const home = join(root, 'fake-home')
const out = join(root, 'out')

// 造一个迷你 $DSH_HOME（几 KB）
mkdirSync(join(home, 'sessions'), { recursive: true })
mkdirSync(join(home, 'skills'), { recursive: true })
mkdirSync(join(home, 'storages'), { recursive: true })
writeFileSync(join(home, 'config.json'), JSON.stringify({ hello: 'world', n: 42 }), 'utf8')
writeFileSync(join(home, 'sessions', 'session.v4.jsonl'), '{"seq":1}\n{"seq":2}\n', 'utf8')
writeFileSync(join(home, 'skills', 'demo.md'), '# demo skill\n', 'utf8')
writeFileSync(join(home, 'storages', 'workspace.json'), JSON.stringify({ tables: { workspaces: {} } }), 'utf8')

const account = 'ishii-vault-01'
const password = 'MyVault#2026'
const restore = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', windowsHide: true })

/** 读包头（magic + 4B len + JSON）→ { header, headerBytes } */
function readPkgHeader(p) {
  const { header, headerBytes } = decodeHeader(readFileSync(p))
  return { header, headerBytes }
}

// ── A 不加密模式 ───────────────────────────────────────────────────────────
try {
  const r = await runBackup({ dshHome: home, outDir: out, scope: 'core', encrypt: false, pgContainer: '__none__' })
  const pkg = join(out, `${r.baseName}.vault`)
  const { header, headerBytes } = readPkgHeader(pkg)

  check('A1 未加密包：头里 encrypted=false / v=0', header.encrypted === false && header.v === 0,
    `encrypted=${header.encrypted} v=${header.v} crypto=${JSON.stringify(header.crypto)}`)

  // 头之后应当直接是 gzip 魔数 1f 8b —— 这是"真的没加密"的硬证据
  const fd = openSync(pkg, 'r')
  const magic = Buffer.alloc(2)
  readSync(fd, magic, 0, 2, headerBytes)
  closeSync(fd)
  check('A2 头之后是 gzip 魔数 1f 8b（第三方工具可直接解开）',
    magic[0] === 0x1f && magic[1] === 0x8b, `读到 ${magic.toString('hex')}`)

  const target = join(root, 'out-a')
  const rr = restore(['--package', pkg, '--target', target])
  const payloadOk = statSync(join(target, 'payload', '01-dsh-home', 'config.json')).size > 0
  const content = readFileSync(join(target, 'payload', '01-dsh-home', 'config.json'), 'utf8')
  check('A3 未加密包无需任何凭证即可还原（且内容正确）',
    rr.status === 0 && payloadOk && content.includes('world'),
    `exit=${rr.status} 内容=${content.slice(0, 40)}`)
  check('A4 未加密包还明确指出"跳过解密"',
    String(rr.stderr ?? '').includes('未加密包'), String(rr.stderr ?? '').trim().slice(0, 80))
} catch (e) {
  check('A 不加密模式用例执行', false, String(e?.message ?? e))
}

// ── C 密码策略在打包时就拦 ─────────────────────────────────────────────────
try {
  let msg = null
  try {
    await runBackup({ dshHome: home, outDir: out, scope: 'core', encrypt: true, account, password: 'abc123', pgContainer: '__none__' })
  } catch (e) { msg = String(e?.message ?? e) }
  check('C1 弱密码在打包时被拒（首字母大写 / 符号 / ≥8 位）',
    msg != null && /密码不符合要求/.test(msg), msg ? msg.slice(0, 120) : '没有被拒绝（问题！）')

  let msg2 = null
  try {
    await runBackup({ dshHome: home, outDir: out, scope: 'core', encrypt: true, account, password: 'Abc12345', pgContainer: '__none__' })
  } catch (e) { msg2 = String(e?.message ?? e) }
  check('C2 无特殊符号也被拒', msg2 != null && /特殊符号/.test(msg2), msg2 ? msg2.slice(0, 120) : '没有被拒绝')
} catch (e) {
  check('C 密码策略用例执行', false, String(e?.message ?? e))
}

// ── B 凭证绑定模式（v2）────────────────────────────────────────────────────
try {
  const r2 = await runBackup({
    dshHome: home, outDir: out, scope: 'core', encrypt: true,
    account, password, recoveryCode: true, deviceSlot: true, pgContainer: '__none__',
  })
  const pkg2 = join(out, `${r2.baseName}.vault`)
  const { header } = readPkgHeader(pkg2)

  check('B1 v2 头：v=2，含 passphrase/recovery/dpapi 三个槽',
    header.v === 2 && ['passphrase', 'recovery', 'dpapi'].every((t) => (header.slots ?? []).some((s) => s.type === t)),
    `v=${header.v} slots=${(header.slots ?? []).map((s) => s.type).join('+')} kdf=${header.kdf ? 'N' + header.kdf.N : 'MISSING'}`)
  check('B2 恢复码只在打包结果里返回一次（供用户抄写）',
    typeof r2.keyring?.recoveryCode === 'string' && /^[A-Z0-9]{4}(-[A-Z0-9]{4}){4}$/.test(r2.keyring.recoveryCode),
    `recoveryCode=${r2.keyring?.recoveryCode}`)

  const target2 = join(root, 'out-b')
  const ok = restore(['--package', pkg2, '--account', account, '--password', password, '--target', target2])
  check('B3 账号+密码可解（跨机路径）', ok.status === 0 && readFileSync(join(target2, 'payload', '01-dsh-home', 'config.json'), 'utf8').includes('world'),
    `exit=${ok.status} unlock=${String(ok.stderr ?? '').split('\n')[0]}`)

  const bad = restore(['--package', pkg2, '--account', account, '--password', 'MyVault#2027', '--target', join(root, 'out-bad')])
  check('B4 密码错 → 非零退出 + 明确原因',
    bad.status !== 0 && /passphrase-mismatch|密码不对/.test(bad.stderr + bad.stdout),
    `exit=${bad.status} ${String(bad.stderr ?? '').trim().split('\n').filter(Boolean).pop()?.slice(0, 120)}`)

  const badAcct = restore(['--package', pkg2, '--account', 'someone-else', '--password', password, '--target', join(root, 'out-bad2')])
  check('B5 账号错 → 明确报"账号不对"', badAcct.status !== 0 && /account-mismatch|账号/.test(badAcct.stderr + badAcct.stdout),
    `exit=${badAcct.status}`)

  const rec = restore(['--package', pkg2, '--recovery-code', r2.keyring.recoveryCode, '--target', join(root, 'out-rec')])
  check('B6 恢复码可救（忘了账号密码也能解）', rec.status === 0,
    `exit=${rec.status} unlock=${String(rec.stderr ?? '').split('\n')[0]}`)

  const local = restore(['--package', pkg2, '--local', '--target', join(root, 'out-local')])
  check('B7 本机免密（DPAPI 槽）无需任何凭证', local.status === 0,
    `exit=${local.status} unlock=${String(local.stderr ?? '').split('\n')[0]}`)

  const none = restore(['--package', pkg2, '--target', join(root, 'out-none')])
  check('B8 不给任何凭证 → 被拒且提示要什么', none.status !== 0 && /no-credential|需要/.test(none.stderr + none.stdout),
    `exit=${none.status}`)
} catch (e) {
  check('B 凭证绑定模式用例执行', false, String(e?.message ?? e))
}

// ── E 旧包（v1）兼容 ───────────────────────────────────────────────────────
try {
  const oldPkg = (() => {
    try {
      const dir = 'G:\\DSH-Backup\\_selftest'
      const f = readdirSync(dir).filter((n) => n.endsWith('.vault')).map((n) => join(dir, n))
      // 取**最早**的那个 = 历史 v1 包（selftest 之后新打的是 v2，不能用它测 v1 兼容）
      return f.sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs)[0] ?? null
    } catch { return null }
  })()
  if (oldPkg) {
    const v = restore(['--package', oldPkg, '--password', 'selftest-pass-123', '--verify'])
    const body = v.stdout + v.stderr
    check('E1 旧 v1 包仍可解（向后兼容）', v.status === 0 && /password-v1|密码派生/.test(body),
      `exit=${v.status} ${String(v.stderr ?? '').split('\n')[0]}`)
  } else {
    check('E1 旧 v1 包兼容', false, '找不到 _selftest 下的旧包（跳过）')
  }
} catch (e) {
  check('E 兼容用例执行', false, String(e?.message ?? e))
}

try {
  const leftover = readdirSync(out).filter((n) => n.endsWith('.vault'))
  console.log(`\n（本用例共产出包 ${leftover.length} 个：${leftover.join(', ')}）`)
  console.log(`sha256(第一个包)=${createHash('sha256').update(readFileSync(join(out, leftover[0]))).digest('hex').slice(0, 16)}…`)
} catch { /* 忽略 */ }

// ── D 校验降级：没有 sidecar 时必须说 unknown（不能谎报 ok:true）──────────
try {
  const tmp = join(root, 'no-sidecar')
  mkdirSync(tmp, { recursive: true })
  const firstPkg = readdirSync(out).filter((n) => n.endsWith('.vault'))[0]
  copyFileSync(join(out, firstPkg), join(tmp, firstPkg))
  const r = restore(['--package', join(tmp, firstPkg), '--password', password, '--verify'])
  const hasUnknown = /"ok":\s*"unknown"/.test(r.stdout)
  check('D1 无 sidecar → ok:"unknown"（不谎报 ok:true）', hasUnknown,
    `exit=${r.status}｜${hasUnknown ? 'ok=unknown ✓' : r.stdout.slice(0, 100)}`)
  check('D2 输出里明确说"未做内容比对"', /未做内容比对|未找到基准哈希/.test(r.stdout),
    String(r.stdout).match(/"integrityNote":[^\n]*/)?.[0]?.slice(0, 100) ?? '(未找到 integrityNote)')
} catch (e) {
  check('D verify 降级用例执行', false, String(e?.message ?? e))
}

try { rmSync(root, { recursive: true, force: true }) } catch { /* 忽略 */ }

const failed = results.filter((r) => !r.ok)
console.log('')
console.log(`=== ${results.length - failed.length}/${results.length} 通过 ===`)
if (failed.length > 0) {
  for (const f of failed) console.log(`  失败: ${f.name} — ${f.detail}`)
  process.exit(1)
}
