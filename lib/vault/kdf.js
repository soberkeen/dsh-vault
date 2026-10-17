/**
 * kdf.js — 凭证绑定密钥派生（方案③：KEK + DEK + 多钥匙槽）
 *
 * 目标（操作者需求）：在任何电脑上，只要有**本插件 + 同一套用户凭证（账号 + 密码）**，
 * 就能解开由同一套凭证生成的包 —— 不需要联网、不需要随包携带密钥文件、不依赖本机状态。
 *
 * 做法：
 *   1. 数据本身永远只用**随机 DEK**（数据密钥）加密 —— 每次打包都换新；
 *   2. DEK 被 **KEK**（由账号+密码经 scrypt 派生）用 AES-256-GCM 包裹，包裹结果存在明文头里；
 *   3. 头里可以放**多个钥匙槽**（同一个 DEK 的多份包裹）：账号密码槽 / 恢复码槽 / 本机 DPAPI 槽。
 *      任意一把能开就行 —— 换机时用账号密码，忘了就用恢复码。
 *
 * 为什么账号也参与：
 *   - 参与派生：规范化账号进 KDF 输入 → 换账号即换密钥；
 *   - 参与认证：账号摘要作 GCM 的 AAD → **能区分"账号错"与"密码错"**，否则只有一句"解不开"。
 *
 * 仅使用 node: 内置模块（node:crypto）—— 与 ADR-010「零编译零外部依赖」一致。
 * Argon2 因 Node 无内置而被排除（见 docs/调研-凭证绑定加解密.md §一）。
 */
import { spawnSync } from 'node:child_process'
import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb, createHash, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCb)

/** 默认强度：约 0.3–1 秒 / 1 GB 内存（本机实测见 scripts/kdf-test.mjs 输出）。 */
export const KDF_DEFAULTS = { algo: 'scrypt', N: 1 << 17, r: 8, p: 1, dkLen: 32 }
export const SLOT_TYPES = ['passphrase', 'recovery', 'dpapi']

/**
 * 账号规范化：避免"同一个账号因为大小写/空格/全半角而派生出不同密钥"。
 * 规则：去首尾空白 → 全角转半角 → 统一小写 → 折叠内部连续空白。
 */
export function normalizeAccount(account) {
  const s = String(account ?? '')
    .trim()
    .replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0)) // 全角 → 半角
    .replace(/\s+/g, ' ')
    .toLowerCase()
  // 操作者定：账号**不做要求**。留空时用固定占位（它仍参与派生，只是不再由你记）
  return s === '' ? 'local' : s
}

/**
 * 密码策略（操作者定）：首字母大写 · 至少一个特殊符号 · 不少于 8 个字符。
 *
 * ⚠️ 这是**最低门槛**，不等于"足够安全"：目标是对抗网盘运营商/拿到包的人的**离线爆破**。
 * 8 位带符号口令在 GPU 集群前仍偏弱（见 docs/调研-凭证绑定加解密.md §五的算力账），
 * 所以界面除了硬性门槛，还会给出 passwordStrength() 的软提示。
 */
export function validatePassword(password) {
  const p = String(password ?? '')
  const problems = []
  if (p.length < 8) problems.push(`长度不足：当前 ${p.length} 位，要求 ≥ 8 位`)
  if (!/^[A-Z]/.test(p)) problems.push('首字母必须是大写字母（A-Z）')
  if (!/[^A-Za-z0-9]/.test(p)) problems.push('至少含一个特殊符号（如 ! @ # $ % ^ & * _ - .）')
  return { ok: problems.length === 0, problems, length: p.length }
}

/** 粗略强度提示（不参与密钥派生，仅用于界面文案）。 */
export function passwordStrength(password) {
  const p = String(password ?? '')
  let classes = 0
  if (/[a-z]/.test(p)) classes++
  if (/[A-Z]/.test(p)) classes++
  if (/\d/.test(p)) classes++
  if (/[^A-Za-z0-9]/.test(p)) classes++
  const len = p.length
  if (len < 8) return { score: 0, label: '不合格', note: '不满足最低要求' }
  if (len < 12) {
    return {
      score: 1,
      label: '勉强（仅达最低要求）',
      note: '8–11 位：单机爆破要很久，但在 GPU 集群前不算安全；建议 ≥12 位或改用 4 个不相关单词拼接',
    }
  }
  if (len < 16 || classes < 3) {
    return { score: 2, label: '较好', note: '12–15 位：足以挡住常见爆破；16 位以上更稳' }
  }
  return { score: 3, label: '强', note: '长度与字符种类都够，可放心用于上传网盘' }
}

/** 账号摘要（放明文头；用于解包时区分"账号错"与"密码错"）。 */
export function accountTag(account) {
  return createHash('sha256').update(normalizeAccount(account), 'utf8').digest('hex').slice(0, 16)
}

/**
 * 从「账号 + 密码」派生 KEK。
 * 注意：账号与密码**都**参与，且串接顺序固定（账号在前）—— 任何一处不同都会得到不同 KEK。
 */
export async function deriveKek(account, password, kdf) {
  const norm = `${normalizeAccount(account)}\u0000${String(password ?? '')}`
  const key = await scrypt(norm, Buffer.from(kdf.salt, 'base64'), kdf.dkLen ?? 32, {
    N: kdf.N, r: kdf.r, p: kdf.p,
    maxmem: 512 * 1024 * 1024 * 2,
  })
  return Buffer.from(key)
}

/**
 * 本机免密锁孔（Windows DPAPI）—— 操作者要求「本地登录免密」。
 *
 * 用 .NET 的 ProtectedData（CurrentUser 作用域）包裹 DEK：只有**当前 Windows 用户**能在
 * **这台电脑**上解开，且不需要你输入任何东西。
 *
 * 为什么必须与"账号+密码"分成两个锁孔：
 *   - 本机免密槽换台电脑/换个用户就解不开 → 不能用来对抗"上传网盘后被运营商解开"；
 *   - 账号密码槽才是**跨机可复现**的，也是上传网盘时唯一能保护你的那把锁。
 * 两者绑同一把 DEK，互不影响。
 */
export function dpapiProtect(buf) {
  const b64 = Buffer.from(buf).toString('base64')
  const script =
    `$b=[Convert]::FromBase64String('${b64}');` +
    `$p=[System.Security.Cryptography.ProtectedData]::Protect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);` +
    `[Convert]::ToBase64String($p)`
  const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true })
  if (r.status !== 0 || !String(r.stdout ?? '').trim()) {
    throw new Error(`DPAPI 包裹失败（需 Windows + pwsh 7）：${String(r.stderr ?? '').trim().slice(0, 200)}`)
  }
  return String(r.stdout).trim()
}

export function dpapiUnprotect(b64) {
  const script =
    `$b=[Convert]::FromBase64String('${String(b64).trim()}');` +
    `try{$p=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);` +
    `Write-Output ([Convert]::ToBase64String($p))}catch{exit 3}`
  const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true })
  if (r.status !== 0) return null
  const out = String(r.stdout ?? '').trim()
  if (!out) return null
  try { return Buffer.from(out, 'base64') } catch { return null }
}

/** 本机是否具备 DPAPI 能力（界面用它决定「本地免密」选项是否可选）。 */
export function dpapiAvailable() {
  try {
    const probe = dpapiUnprotect(dpapiProtect(Buffer.from('probe', 'utf8')))
    return probe?.toString('utf8') === 'probe'
  } catch {
    return false
  }
}

/** 包裹 DEK：AES-256-GCM，AAD = 账号摘要 + salt（账号被改则认证失败）。 */
export function wrapDek(dek, kek, { tag, salt }) {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', kek, nonce)
  cipher.setAAD(Buffer.from(`${tag}:${salt}`, 'utf8'))
  const ct = Buffer.concat([cipher.update(dek), cipher.final()])
  return { nonce: nonce.toString('base64'), wrap: Buffer.concat([ct, cipher.getAuthTag()]).toString('base64') }
}

/** 解包裹 DEK：返回 { ok, dek?, reason? }，reason ∈ account-mismatch | passphrase-mismatch | corrupted。 */
export function unwrapDek(slot, kek, { account, salt }) {
  const tag = accountTag(account)
  const aad = Buffer.from(`${tag}:${salt}`, 'utf8')
  const payload = Buffer.from(slot.wrap, 'base64')
  const nonce = Buffer.from(slot.nonce, 'base64')
  try {
    const decipher = createDecipheriv('aes-256-gcm', kek, nonce)
    decipher.setAAD(aad)
    decipher.setAuthTag(payload.subarray(payload.length - 16))
    const dek = Buffer.concat([decipher.update(payload.subarray(0, payload.length - 16)), decipher.final()])
    return { ok: true, dek }
  } catch {
    // 认证失败：GCM 无法区分"密钥错"还是"AAD 错"，但我们可以比对账号摘要来给出**明确原因**
    const stored = slot.acctTag ?? null
    if (stored && !safeEqualStr(stored, tag)) {
      return { ok: false, reason: 'account-mismatch', hint: `包绑定的账号摘要 ${stored}，你输入的是 ${tag}` }
    }
    return { ok: false, reason: 'passphrase-mismatch', hint: '账号摘要匹配，密码不对（或包已损坏）' }
  }
}

function safeEqualStr(a, b) {
  const ba = Buffer.from(String(a), 'utf8')
  const bb = Buffer.from(String(b), 'utf8')
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

/**
 * 建一个「主槽（账号密码）」+ 可选的「恢复码槽」。
 * @returns {{ header, dek, recoveryCode? }}
 */
export async function createKeyring({ account = '', password, recoveryCode = null, deviceSlot = false, kdf = KDF_DEFAULTS }) {
  const dek = randomBytes(32)
  const params = {
    algo: kdf.algo ?? 'scrypt',
    N: kdf.N, r: kdf.r, p: kdf.p, dkLen: kdf.dkLen ?? 32,
    salt: randomBytes(32).toString('base64'),
  }
  const slots = []
  // ⚠️ 只在**确实给了密码**时才建 primary 槽（GLM-5.3 审查 S-A，已核实为真漏洞）：
  // 原实现无条件建槽，password 为 undefined/空串时 deriveKek 得到的是「空口令 KEK」，
  // 于是 autoBackup 产出的包都带一个「账号 + 空密码」即可解开的槽 —— 拿到包的人试 local+空串就破。
  if (typeof password === 'string' && password !== '') {
    const kek = await deriveKek(account, password, params)
    slots.push({
      id: 'primary',
      type: 'passphrase',
      label: `账号 ${normalizeAccount(account)}`,
      acctTag: accountTag(account),
      ...wrapDek(dek, kek, { tag: accountTag(account), salt: params.salt }),
    })
  }

  let generatedRecovery = null
  if (recoveryCode === true) {
    generatedRecovery = formatRecoveryCode(randomBytes(20))
    recoveryCode = generatedRecovery
  }
  if (typeof recoveryCode === 'string' && normalizeRecoveryCode(recoveryCode) !== '') {
    // 恢复码槽：账号固定为字面量 `recovery`（与人类账号解耦），独立派生 KEK。
    // ⚠️ 必须先规范化：用户抄写/输入时带不带分隔符、大小写都可能不同
    // （本机实测踩到：建槽用带横线的原码、校验侧规范化 → 去横线就解不开）。
    const rkek = await deriveKek('recovery', normalizeRecoveryCode(recoveryCode), params)
    slots.push({
      id: 'recovery',
      type: 'recovery',
      label: '恢复码',
      acctTag: accountTag('recovery'),
      ...wrapDek(dek, rkek, { tag: accountTag('recovery'), salt: params.salt }),
    })
  }

  if (deviceSlot) {
    // 本机免密槽：DEK 用 Windows DPAPI 包裹（CurrentUser）—— 这台电脑免输入即可解开
    slots.push({ id: 'device', type: 'dpapi', label: '本机免密（DPAPI）', wrap: dpapiProtect(dek) })
  }

  return {
    header: { v: 2, kdf: params, slots },
    dek,
    recoveryCode: generatedRecovery,
  }
}

/** 用凭证解出 DEK：依次尝试各槽（默认只试主槽；恢复码需显式给） */
export async function openKeyring(header, { account = '', password, recoveryCode, deviceSlot = false } = {}) {
  const salt = header.kdf.salt

  // 1) 本机免密槽（仅当调用方显式要求 deviceSlot 时尝试）
  //    默认关闭是刻意的：否则"以为在验证凭证，其实走了本机免密"，会掩盖真正的凭证错误。
  if (deviceSlot) {
    for (const slot of (header.slots ?? []).filter((s) => s.type === 'dpapi')) {
      const dek = dpapiUnprotect(slot.wrap)
      if (dek && dek.length === 32) return { ok: true, dek, via: slot.id }
    }
  }

  const attempts = []
  for (const slot of header.slots ?? []) {
    if (slot.type === 'passphrase' && password != null) {
      attempts.push({ slot, kek: await deriveKek(account, password, header.kdf) })
    } else if (slot.type === 'recovery' && recoveryCode) {
      // 与建槽侧一致：先规范化 —— 用户输入带不带分隔符、大小写不同都要能开
      attempts.push({ slot, kek: await deriveKek('recovery', normalizeRecoveryCode(recoveryCode), header.kdf) })
    }
  }
  const failures = []
  for (const { slot, kek } of attempts) {
    const acct = slot.type === 'recovery' ? 'recovery' : account
    const res = unwrapDek(slot, kek, { account: acct, salt })
    if (res.ok) return { ok: true, dek: res.dek, via: slot.id }
    failures.push({ slot: slot.id, reason: res.reason, hint: res.hint })
  }
  return { ok: false, failures }
}

/** 人类可抄写的恢复码：XXXX-XXXX-XXXX-XXXX-XXXX（去掉易混字符） */
export function formatRecoveryCode(buf) {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
  let out = ''
  for (let i = 0; i < 20; i++) out += alphabet[buf[i] % alphabet.length]
  return out.match(/.{1,4}/g).join('-')
}

/** 恢复码规范化（去掉分隔符与空格、统一大写） */
export function normalizeRecoveryCode(code) {
  return String(code ?? '').replace(/[\s-]/g, '').toUpperCase()
}
