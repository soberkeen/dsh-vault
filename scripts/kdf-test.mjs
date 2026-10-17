#!/usr/bin/env node
/**
 * kdf-test.mjs — 凭证绑定加解密验证（账号+密码 → 密钥，跨机可复现）
 *
 * 验证项：
 *   1 同凭证解出同一 DEK
 *   2 密码错 → 明确报 passphrase-mismatch（不是含糊的"解不开"）
 *   3 账号错 → 明确报 account-mismatch
 *   4 恢复码槽 → 用恢复码解出同一 DEK（忘了账号密码也能救）
 *   5 账号规范化：大小写/前后空格/全角 视为同一账号
 *   6 **跨进程/跨目录模拟"换电脑"**：只把一个 header.json 交给另一个 node 进程，
 *     不带任何本机状态，同凭证仍能解出 DEK
 *   7 KDF 强度实测：量 scrypt(N=2^17) 的实际耗时与内存，用于估算离线爆破成本
 *
 * 用法：node scripts/kdf-test.mjs
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KDF_DEFAULTS, accountTag, createKeyring, deriveKek, dpapiAvailable, normalizeAccount, normalizeRecoveryCode, openKeyring, passwordStrength, validatePassword } from '../lib/vault/kdf.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const KDF_JS = join(HERE, '..', 'lib', 'vault', 'kdf.js')
const KDF_URL = 'file:///' + KDF_JS.replace(/\\/g, '/').replace(/ /g, '%20')

const ACCOUNT = 'Ishii@Example.COM'
const PASSWORD = 'correct horse battery staple 2026'
const WRONG_PASS = 'correct horse battery staple 2027'
const WRONG_ACCT = 'not-me@example.com'

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}
const sha = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 16)

const root = mkdtempSync(join(tmpdir(), 'vault-kdf-'))

// ── 建 keyring（带自动生成恢复码）───────────────────────────────────────────
const t0 = Date.now()
const ring = await createKeyring({ account: ACCOUNT, password: PASSWORD, recoveryCode: true })
const genMs = Date.now() - t0
const dekHash = sha(ring.dek)
console.log(`keyring: slots=${ring.header.slots.map((s) => s.type).join('+')}  KDF=N${ring.header.kdf.N},r${ring.header.kdf.r}  建钥耗时 ${genMs}ms`)
console.log(`恢复码（示意）：${ring.recoveryCode}`)
console.log(`DEK 指纹：${dekHash}`)
console.log('')

// ── 1 同凭证 ───────────────────────────────────────────────────────────────
const ok1 = await openKeyring(ring.header, { account: ACCOUNT, password: PASSWORD })
check('1 同凭证解出同一 DEK', ok1.ok && sha(ok1.dek) === dekHash, ok1.ok ? `via=${ok1.via} DEK=${sha(ok1.dek)}` : JSON.stringify(ok1.failures))

// ── 2 密码错 ───────────────────────────────────────────────────────────────
const bad2 = await openKeyring(ring.header, { account: ACCOUNT, password: WRONG_PASS })
check('2 密码错 → 明确报"密码不对"', !bad2.ok && bad2.failures?.[0]?.reason === 'passphrase-mismatch',
  `${bad2.failures?.[0]?.reason} / ${bad2.failures?.[0]?.hint ?? ''}`)

// ── 3 账号错 ───────────────────────────────────────────────────────────────
const bad3 = await openKeyring(ring.header, { account: WRONG_ACCT, password: PASSWORD })
check('3 账号错 → 明确报"账号不对"', !bad3.ok && bad3.failures?.[0]?.reason === 'account-mismatch',
  `${bad3.failures?.[0]?.reason} / ${bad3.failures?.[0]?.hint ?? ''}`)

// ── 4 恢复码 ───────────────────────────────────────────────────────────────
const ok4 = await openKeyring(ring.header, { recoveryCode: normalizeRecoveryCode(ring.recoveryCode) })
check('4 恢复码可解出同一 DEK（忘账号密码也能救）', ok4.ok && sha(ok4.dek) === dekHash,
  ok4.ok ? `via=${ok4.via} DEK=${sha(ok4.dek)}` : JSON.stringify(ok4.failures))

// ── 5 账号规范化 ───────────────────────────────────────────────────────────
const variants = ['Ishii@Example.COM', '  ishii@example.com  ', 'Ｉｓｈｉｉ@ｅｘａｍｐｌｅ.ｃｏｍ', 'ISHII@EXAMPLE.COM']
const normOk = variants.every((v) => normalizeAccount(v) === normalizeAccount(ACCOUNT))
check('5 账号规范化（大小写/空格/全角等价）', normOk, variants.map((v) => normalizeAccount(v)).join(' | '))
const ok5 = await openKeyring(ring.header, { account: '  ISHII@example.com  ', password: PASSWORD })
check('5b 规范化后不同写法仍能解开', ok5.ok && sha(ok5.dek) === dekHash, ok5.ok ? 'ok' : JSON.stringify(ok5.failures))

// ── 6 跨进程模拟「换电脑」──────────────────────────────────────────────────
const headerFile = join(root, 'header.json')
writeFileSync(headerFile, JSON.stringify(ring.header), 'utf8')
const childSrc = `
import { readFileSync } from 'node:fs'
import { openKeyring } from '${KDF_URL}'
import { createHash } from 'node:crypto'
const header = JSON.parse(readFileSync(process.argv[1], 'utf8'))
const r = await openKeyring(header, { account: process.env.K_ACCT, password: process.env.K_PASS })
if (!r.ok) { console.log('CHILD-FAIL ' + JSON.stringify(r.failures)); process.exit(2) }
console.log('CHILD-OK ' + createHash('sha256').update(r.dek).digest('hex').slice(0, 16) + ' via=' + r.via)
`
const child = spawnSync(process.execPath, ['--input-type=module', '-e', childSrc, headerFile], {
  encoding: 'utf8',
  env: { ...process.env, K_ACCT: ACCOUNT, K_PASS: PASSWORD },
  cwd: root,                       // 故意换 cwd：只带一个 header 文件，不带任何本机状态
})
const childOut = String(child.stdout ?? '').trim()
check('6 跨进程+跨目录（只给 header 文件）同凭证可解', childOut.includes(`CHILD-OK ${dekHash}`),
  `${childOut || '(无输出)'} exit=${child.status}`)

const childBad = spawnSync(process.execPath, ['--input-type=module', '-e', childSrc, headerFile], {
  encoding: 'utf8',
  env: { ...process.env, K_ACCT: ACCOUNT, K_PASS: WRONG_PASS },
  cwd: root,
})
check('6b 跨进程用错密码 → 被拒且说明原因', String(childBad.stdout ?? '').includes('passphrase-mismatch'),
  String(childBad.stdout ?? '').trim().slice(0, 120))

// ── 7 KDF 强度实测 ─────────────────────────────────────────────────────────
const samples = []
for (let i = 0; i < 3; i++) {
  const t = Date.now()
  await deriveKek(ACCOUNT, PASSWORD, ring.header.kdf)
  samples.push(Date.now() - t)
}
const avg = Math.round(samples.reduce((a, b) => a + b, 0) / samples.length)
const memMb = Math.round((128 * ring.header.kdf.N * ring.header.kdf.r) / (1 << 17) * 2 / 1024 / 1024 * 1024 / 128 * 128)
check('7 KDF 强度实测（每次尝试的成本）', avg >= 100 && avg <= 5000,
  `scrypt N=${ring.header.kdf.N} r=${ring.header.kdf.r} → 平均 ${avg}ms/次（样本 ${samples.join(',')}ms）；理论内存约 ${(128 * ring.header.kdf.N * ring.header.kdf.r / 1024 / 1024 / 1024 * 1).toFixed(2)} GiB`)
void memMb

// ── 8 恢复码规范化 ─────────────────────────────────────────────────────────
check('8 恢复码规范化（忽略分隔符/空格/大小写）',
  normalizeRecoveryCode(ring.recoveryCode.toLowerCase().replace(/-/g, ' ')) === normalizeRecoveryCode(ring.recoveryCode),
  `${ring.recoveryCode} → ${normalizeRecoveryCode(ring.recoveryCode)}`)

check('9 不同账号派生出不同 KEK（账号确实参与密钥）',
  sha(await deriveKek(ACCOUNT, PASSWORD, ring.header.kdf)) !== sha(await deriveKek(WRONG_ACCT, PASSWORD, ring.header.kdf)),
  `acctTag(A)=${accountTag(ACCOUNT)} acctTag(B)=${accountTag(WRONG_ACCT)}`)

// ── 10 密码策略（操作者定：首字母大写 · 特殊符号 · ≥8 位）─────────────────
const policyCases = [
  ['abc123', false, '太短且首字母小写、无符号'],
  ['Abc12345', false, '无特殊符号'],
  ['abc12345!', false, '首字母小写'],
  ['Abc1!', false, '不足 8 位'],
  ['Abc12345!', true, '满足：首字母大写 + 符号 + 8 位'],
  ['Zq7#kLm9', true, '满足'],
]
const policyBad = policyCases.filter(([pw, want]) => validatePassword(pw).ok !== want)
check('10 密码策略校验（首字母大写 / 含特殊符号 / ≥8 位）', policyBad.length === 0,
  policyCases.map(([pw, want]) => `${pw}:${validatePassword(pw).ok === want ? 'OK' : 'WRONG'}`).join(' '))
console.log(`     强度提示示例：Abc12345! → ${JSON.stringify(passwordStrength('Abc12345!'))}`)
console.log(`     强度提示示例：MyVault#2026Secure → ${JSON.stringify(passwordStrength('MyVault#2026Secure'))}`)

// ── 11 本机免密槽（DPAPI）──────────────────────────────────────────────────
const avail = dpapiAvailable()
console.log(`     DPAPI 可用性：${avail}`)
if (avail) {
  const ring2 = await createKeyring({ account: '', password: 'LocalOnly1!', recoveryCode: false, deviceSlot: true })
  const dek2 = sha(ring2.dek)
  const viaDevice = await openKeyring(ring2.header, { deviceSlot: true })          // 不输任何凭证
  check('11 本机免密：不给凭证也能解开（DPAPI 槽）', viaDevice.ok && sha(viaDevice.dek) === dek2,
    viaDevice.ok ? `via=${viaDevice.via}` : JSON.stringify(viaDevice.failures))
  const noDevice = await openKeyring(ring2.header, { account: '', password: 'LocalOnly1!' })  // 默认不走免密
  check('11b 默认不启用免密时仍需凭证', noDevice.ok && sha(noDevice.dek) === dek2,
    noDevice.ok ? `via=${noDevice.via}` : JSON.stringify(noDevice.failures))
  check('11c 空账号可用（账号不做要求）', noDevice.ok && accountTag('') === accountTag('   '),
    `acctTag('')=${accountTag('')}`)
} else {
  check('11 本机免密槽', false, 'DPAPI 不可用（非 Windows 或无 pwsh 7）—— 该槽在此环境不可验证')
}

// ── 12 双向兼容：不同 kdf 档位都能自洽 ─────────────────────────────────────
const weak = await createKeyring({ account: 'x', password: 'Abc12345!', kdf: { ...KDF_DEFAULTS, N: 1 << 14 } })
const weakOpen = await openKeyring(weak.header, { account: 'x', password: 'Abc12345!' })
check('12 档位写入头并可还原（N 随包走，跨机不依赖本机配置）',
  weakOpen.ok && weak.header.kdf.N === (1 << 14) && sha(weakOpen.dek) === sha(weak.dek),
  `头里 N=${weak.header.kdf.N}`)

// ── 13 S-A 回归：空密码**不得**产生可解开的 primary 槽（GLM-5.3 审查发现的真漏洞）──────
// 漏洞原形：createKeyring 无条件建 primary 槽；password 为 undefined/'' 时 deriveKek 派生出
// 「空口令 KEK」→ autoBackup 产出的每个包都带一个「账号 + 空密码」即可解开的槽。
const noPass = await createKeyring({
  account: 'local', password: undefined,
  recoveryCode: 'THK3-LYDY-K8WJ-VYUU-ZZKY', deviceSlot: false,
})
const noPassSlots = (noPass.header.slots ?? []).map((s) => s.id)
check('13a 无密码时不建 primary 槽', !noPassSlots.includes('primary'), `槽=${noPassSlots.join(',') || '（无）'}`)

const emptyTry = await openKeyring(noPass.header, { account: 'local', password: '' })
check('13b 空密码解不开（漏洞的核心断言）',
  !(emptyTry.ok && emptyTry.dek),
  emptyTry.ok ? '⚠️ 竟然解开了' : `拒绝：${(emptyTry.failures ?? []).map((f) => f.reason).join('/') || '未匹配任何槽'}`)

const recTry = await openKeyring(noPass.header, { recoveryCode: 'THK3-LYDY-K8WJ-VYUU-ZZKY' })
check('13c 同一包仍能用恢复码解开（没把可用性修坏）',
  recTry.ok && sha(recTry.dek) === sha(noPass.dek), recTry.ok ? `via=${recTry.via}` : JSON.stringify(recTry.failures))

const withPass = await createKeyring({ account: 'local', password: 'Abc#12345', deviceSlot: false })
const withPassOpen = await openKeyring(withPass.header, { account: 'local', password: 'Abc#12345' })
check('13d 有密码时 primary 槽正常建立且可解',
  (withPass.header.slots ?? []).some((s) => s.id === 'primary') && withPassOpen.ok,
  `槽=${(withPass.header.slots ?? []).map((s) => s.id).join(',')}`)

try { rmSync(root, { recursive: true, force: true }) } catch { /* 忽略 */ }

const failed = results.filter((r) => !r.ok)
console.log('')
console.log(`=== ${results.length - failed.length}/${results.length} 通过 ===`)
if (failed.length > 0) {
  for (const f of failed) console.log(`  失败: ${f.name} — ${f.detail}`)
  process.exit(1)
}
