#!/usr/bin/env node
/**
 * vault-restore.mjs — dsh-vault 自包含还原器（随备份包分发）
 *
 * 设计约束：只使用 node: 内置模块，不需要 dsh、不需要 7z/openssl，任何装了 Node 18+ 的机器都能跑。
 *   --list     只读明文头：打印包元信息与分卷表（不解密落盘）
 *   --verify   完整解密 + 逐条 GCM 认证 + 比对 tar 明文 sha256 与分卷 sha256（不落盘）
 *   --target D 解包到 D（payload/ + RESTORE/ 原样落地，不动系统）
 *   --in-place 按分区映射还原到原位（01→$DSH_HOME，02→原工作区路径，03→~/.hindsight，05→$DSH_HOME）
 *
 * 与宿主插件共用同一套算法：scrypt(N,r,p) → AES-256-GCM，8 MiB/块，nonce = baseIV(8B)+counter(4B)，
 * 密文帧 = [4B LE len][ciphertext+16B tag]；每卷文件开头是明文头（magic + 4B len + JSON）。
 */
import { spawnSync } from 'node:child_process'
import { createDecipheriv, createHash, scryptSync } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { createGunzip } from 'node:zlib'

const MAGIC = 'DSHVAULT1'
const BLOCK = 512
const HEADER_OVERHEAD = MAGIC.length + 4

function parseArgs(argv) {
  const out = { list: false, verify: false, inPlace: false, target: '', only: [], remap: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--package' || a === '-p') out.package = argv[++i]
    else if (a === '--password' || a === '-w') out.password = argv[++i]
    else if (a === '--target' || a === '-t') out.target = argv[++i]
    else if (a === '--only') out.only.push(argv[++i])
    else if (a === '--remap') out.remap.push(argv[++i])
    else if (a === '--list') out.list = true
    else if (a === '--verify') out.verify = true
    else if (a === '--in-place') out.inPlace = true
    else if (a === '--account' || a === '-a') out.account = argv[++i]
    else if (a === '--recovery-code') out.recoveryCode = argv[++i]
    else if (a === '--local') out.local = true            // 本机免密（包里的 DPAPI 槽）
    else if (a === '--no-encrypt') out.noEncrypt = true   // 声明"这是未加密包"（可选，通常自动识别）
    else if (a === '--help' || a === '-h') out.help = true
  }
  return out
}

function usage() {
  console.log(`dsh-vault 还原器（零依赖，Node 18+）

用法：
  node vault-restore.mjs --package <主包.vault> --password <密码> [动作]

动作（默认 --list）：
  --list                只读明文头，打印包信息（不解密）
  --verify              完整解密 + 校验明文 sha256 / 分卷 sha256（不落盘）
  --target <目录>        解包到指定目录（payload/ 与 RESTORE/ 原样落地）
  --in-place            按分区映射还原到原位（旧目录自动改名 .bak-<时间戳>）
  --only <分区id>        仅处理指定分区（可重复）
  --remap C:\\X=D:\\Y    工作区盘符重映射（可重复）
`)
}

/** 读取明文头（magic + 4B len + JSON）。 */
function readHeader(mainPath) {
  return new Promise((resolvePromise, reject) => {
    const chunks = []
    const rs = createReadStream(mainPath, { start: 0, end: HEADER_OVERHEAD + 1024 * 1024 - 1 })
    rs.on('data', (c) => chunks.push(c))
    rs.on('error', reject)
    rs.on('end', () => {
      const head = Buffer.concat(chunks)
      if (head.length < HEADER_OVERHEAD) return reject(new Error('vault: 文件太短，不是有效的包'))
      if (head.subarray(0, MAGIC.length).toString('latin1') !== MAGIC) {
        return reject(new Error('vault: magic 不匹配 —— 不是 dsh-vault 的包（或被截断）'))
      }
      const len = head.readUInt32LE(MAGIC.length)
      const json = head.subarray(HEADER_OVERHEAD, HEADER_OVERHEAD + len).toString('utf8')
      resolvePromise({ header: JSON.parse(json), headerBytes: HEADER_OVERHEAD + len })
    })
  })
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 枚举同目录下的所有分卷（主包 + _pNN），缺号即报错。 */
function listParts(mainPath) {
  const dir = dirname(mainPath)
  const base = basename(mainPath).replace(/\.vault$/, '')
  const main = join(dir, `${base}.vault`)
  if (!existsSync(main)) throw new Error(`找不到主包：${main}`)
  const parts = [main]
  for (let i = 2; i < 1000; i++) {
    const cand = join(dir, `${base}_p${String(i).padStart(2, '0')}.vault`)
    if (existsSync(cand)) { parts.push(cand); continue }
    const aboveRe = new RegExp(`^${escapeRe(base)}_p(\\d+)\\.vault$`)
    const hasAbove = readdirSync(dir).some((n) => {
      const m = aboveRe.exec(n)
      return m ? Number(m[1]) > i : false
    })
    if (hasAbove) throw new Error(`缺少分卷：${basename(cand)}（多卷包需全部放在同一目录）`)
    break
  }
  return parts
}

/** 同目录的明文索引（包外 sidecar）。 */
function readSidecar(mainPath) {
  const side = mainPath.replace(/\.vault$/, '.manifest.json')
  if (!existsSync(side)) return null
  try { return JSON.parse(readFileSync(side, 'utf8')) } catch { return null }
}

async function sha256File(abs) {
  return new Promise((res, rej) => {
    const h = createHash('sha256')
    const rs = createReadStream(abs)
    rs.on('data', (c) => h.update(c))
    rs.on('error', rej)
    rs.on('end', () => res(h.digest('hex')))
  })
}

/** 失败通道：把 stream 错误变成可被 await 捕获的 reject（否则事件循环空转会导致进程静默退出 0）。 */
function makeFailChannel() {
  let rejectFn = () => {}
  const promise = new Promise((_, rej) => { rejectFn = rej })
  promise.catch(() => { /* 防 unhandled */ })
  return {
    promise,
    fail: (e) => rejectFn(e instanceof Error ? e : new Error(String(e))),
  }
}

// ── v2 凭证绑定：KDF 内联在还原器里 ─────────────────────────────────────────
// 为什么复制一份而不是 import：本文件**随包分发**（被复制进包内 RESTORE/），
// 会在没有本项目源码的机器上单独运行 —— 必须自包含（设计约束，见 ADR-010）。
function normalizeAccountV2(account) {
  const s = String(account ?? '').trim()
    .replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\s+/g, ' ')
    .toLowerCase()
  return s === '' ? 'local' : s
}
function accountTagV2(account) {
  return createHash('sha256').update(normalizeAccountV2(account), 'utf8').digest('hex').slice(0, 16)
}
function normalizeRecoveryCodeV2(code) {
  return String(code ?? '').replace(/[\s-]/g, '').toUpperCase()
}
function deriveKekV2(account, password, kdf) {
  return scryptSync(
    `${normalizeAccountV2(account)}\u0000${String(password ?? '')}`,
    Buffer.from(kdf.salt, 'base64'),
    kdf.dkLen ?? 32,
    { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 1024 * 1024 * 1024 },
  )
}
function unwrapDekV2(slot, kek, { account, salt }) {
  const tag = accountTagV2(account)
  const payload = Buffer.from(slot.wrap, 'base64')
  try {
    const d = createDecipheriv('aes-256-gcm', kek, Buffer.from(slot.nonce, 'base64'))
    d.setAAD(Buffer.from(`${tag}:${salt}`, 'utf8'))
    d.setAuthTag(payload.subarray(payload.length - 16))
    return { ok: true, dek: Buffer.concat([d.update(payload.subarray(0, payload.length - 16)), d.final()]) }
  } catch {
    const stored = slot.acctTag ?? null
    if (stored && stored !== tag) {
      return { ok: false, reason: 'account-mismatch', hint: `包绑定的账号摘要是 ${stored}，你输入的是 ${tag}` }
    }
    return { ok: false, reason: 'passphrase-mismatch', hint: '账号摘要匹配，密码不对（或包已损坏）' }
  }
}
function dpapiUnprotectV2(b64) {
  const script =
    `$b=[Convert]::FromBase64String('${String(b64).trim()}');` +
    `try{$p=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);` +
    `Write-Output ([Convert]::ToBase64String($p))}catch{exit 3}`
  const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true })
  if (r.status !== 0) return null
  const out = String(r.stdout ?? '').trim()
  try { return out ? Buffer.from(out, 'base64') : null } catch { return null }
}

/** 按包头里的槽解出 DEK。local=true 时先试本机免密槽。 */
function openKeyringV2(header, { account, password, recoveryCode, local }) {
  const salt = header.kdf?.salt
  if (!salt) return { ok: false, failures: [{ slot: '-', reason: 'no-kdf', hint: '包头缺少 kdf 参数' }] }
  if (local) {
    for (const s of (header.slots ?? []).filter((x) => x.type === 'dpapi')) {
      const dek = dpapiUnprotectV2(s.wrap)
      if (dek && dek.length === 32) return { ok: true, dek, via: 'device' }
    }
  }
  const failures = []
  for (const slot of header.slots ?? []) {
    if (slot.type === 'passphrase' && password) {
      const res = unwrapDekV2(slot, deriveKekV2(account ?? '', password, header.kdf), { account: account ?? '', salt })
      if (res.ok) return { ok: true, dek: res.dek, via: slot.id }
      failures.push({ slot: slot.id, reason: res.reason, hint: res.hint })
    } else if (slot.type === 'recovery' && recoveryCode) {
      const res = unwrapDekV2(slot, deriveKekV2('recovery', normalizeRecoveryCodeV2(recoveryCode), header.kdf), { account: 'recovery', salt })
      if (res.ok) return { ok: true, dek: res.dek, via: slot.id }
      failures.push({ slot: slot.id, reason: res.reason, hint: res.hint })
    }
  }
  return {
    ok: false,
    failures: failures.length
      ? failures
      : [{ slot: '-', reason: 'no-credential', hint: '这个包是凭证绑定的：需要 --account/--password，或 --recovery-code，或 --local' }],
  }
}

class DecryptTransform extends Transform {
  constructor(key, params) {
    super()
    this.key = key
    this.chunkSize = params?.chunkSize ?? 8 * 1024 * 1024
    this.baseIV = Buffer.from(params.baseIV, 'base64')
    this.counter = 0
    this.pending = Buffer.alloc(0)
    this.hash = createHash('sha256')
  }

  _transform(chunk, _enc, cb) {
    try {
      this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk])
      for (;;) {
        if (this.pending.length < 4) break
        const len = this.pending.readUInt32LE(0)
        // 审查 S5：帧长上限（否则伪造头会让 pending 一直攒 → OOM）
        const maxFrame = this.chunkSize + 64
        if (len <= 16 || len > maxFrame) {
          throw new Error(`密文帧长度非法：${len}（允许 17..${maxFrame}）—— 包已损坏或被构造`)
        }
        if (this.pending.length < 4 + len) break
        const payload = this.pending.subarray(4, 4 + len)
        this.pending = this.pending.subarray(4 + len)
        const n = Buffer.alloc(12)
        this.baseIV.copy(n, 0, 0, 8)
        n.writeUInt32BE(this.counter++ >>> 0, 8)
        const d = createDecipheriv('aes-256-gcm', this.key, n)
        d.setAuthTag(payload.subarray(payload.length - 16))
        const plain = Buffer.concat([d.update(payload.subarray(0, payload.length - 16)), d.final()])
        this.hash.update(plain)
        this.push(plain)
      }
      cb()
    } catch (e) {
      cb(new Error('解密/认证失败（密码错误，或包被改动）：' + e.message))
    }
  }

  _flush(cb) {
    if (this.pending.length !== 0) return cb(new Error('密文尾部残留字节，包可能被截断'))
    cb()
  }
}

/** 拉取式读取器（带失败通道 race，避免空事件循环静默退出）。 */
class ByteReader {
  constructor(source, failPromise) {
    this.iter = source[Symbol.asyncIterator]()
    this.buf = Buffer.alloc(0)
    this.done = false
    this.failPromise = failPromise
  }

  async pull() {
    if (this.done) return false
    const next = this.failPromise ? Promise.race([this.iter.next(), this.failPromise]) : this.iter.next()
    const { value, done } = await next
    if (done) { this.done = true; return false }
    this.buf = this.buf.length === 0 ? value : Buffer.concat([this.buf, value])
    return true
  }

  async read(n) {
    while (this.buf.length < n) {
      const ok = await this.pull()
      if (!ok) return null
    }
    const out = this.buf.subarray(0, n)
    this.buf = this.buf.subarray(n)
    return out
  }

  async skip(n) {
    let left = n
    while (left > 0) {
      if (this.buf.length === 0 && !(await this.pull())) return false
      const take = Math.min(left, this.buf.length)
      this.buf = this.buf.subarray(take)
      left -= take
    }
    return true
  }
}

function parseOctal(buf) {
  if (!buf || buf.length === 0) return 0
  const s = buf.toString('latin1').replace(/\0.*$/, '').trim()
  if (!s) return 0
  const v = parseInt(s, 8)
  return Number.isFinite(v) ? v : 0
}

/** 解密 → gunzip → tar 条目流（回调式处理，避免一次性载入内存）。 */
async function walkArchive({ parts, headerBytes, key, params }, onEntry) {
  const source = Readable.from((async function* () {
    for (const p of parts) {
      const rs = createReadStream(p, { start: headerBytes })
      for await (const c of rs) yield c
    }
  })())

  // 未加密包（v0）：key 为 null → 不插解密流，直接 gunzip
  const decrypt = key ? new DecryptTransform(key, params) : null
  const gunzip = createGunzip()
  const channel = makeFailChannel()
  const onErr = (e) => channel.fail(e)
  source.on('error', onErr)
  if (decrypt) decrypt.on('error', onErr)
  gunzip.on('error', onErr)

  // plainHash 语义：解密后、解压前的 gzip 流 —— 加密 / 不加密两种模式都用同一个 tap 计算，
  // 保证还原端给出的哈希与打包端 manifest.plainHash 同源可比。
  // （此前直接取 decrypt.hash，未加密时 decrypt 为 null → 抛错，已修。）
  const plainHash = createHash('sha256')
  const hashTap = new Transform({
    transform(chunk, _enc, cb) { plainHash.update(chunk); cb(null, chunk) },
  })
  hashTap.on('error', onErr)
  if (decrypt) source.pipe(decrypt).pipe(hashTap).pipe(gunzip)
  else source.pipe(hashTap).pipe(gunzip)

  const reader = new ByteReader(gunzip, channel.promise)
  let longName = null
  for (;;) {
    const block = await reader.read(BLOCK)
    if (!block) break
    if (block.every((b) => b === 0)) {
      const next = await reader.read(BLOCK)
      if (!next || next.every((b) => b === 0)) break
      continue
    }
    const type = String.fromCharCode(block[156])
    const size = parseOctal(block.subarray(124, 136))
    let name = block.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    const prefix = block.subarray(345, 500).toString('utf8').replace(/\0.*$/, '')
    if (prefix) name = prefix.replace(/\/$/, '') + '/' + name

    if (type === 'L') {
      // 审查 S5：LongLink 长度由包头声明（可达数 GB）—— 设上限，超界直接拒绝（不 OOM）
      if (size > 1024 * 1024) throw new Error(`tar: LongLink 长度 ${size} 超过上限 1 MiB，拒绝（包被构造或损坏）`)
      const data = await reader.read(size)
      const tailPad = (BLOCK - (size % BLOCK)) % BLOCK
      if (tailPad) await reader.skip(tailPad)
      longName = data ? data.subarray(0, size - 1).toString('utf8') : name
      continue
    }
    if (longName) { name = longName; longName = null }

    const isDir = type === '5'
    const body = (async function* () {
      let left = size
      while (left > 0) {
        const c = await reader.read(Math.min(left, 1024 * 1024))
        if (!c) throw new Error(`条目 ${name} 数据不完整`)
        left -= c.length
        yield c
      }
      const tailPad = (BLOCK - (size % BLOCK)) % BLOCK
      if (tailPad) await reader.skip(tailPad)
    })()

    await onEntry({ rel: name, isDir, size, body })
  }

  return { plainHash: plainHash.digest('hex') }
}

/**
 * 该条目 in-place 还原时的「目标根」—— 用于还原前把整根改名备份（.bak-<stamp>）。
 * 这是 usage 里那句「旧目录自动改名」的实现基础（审查 S1：此前只写了承诺，没有实现）。
 */
function rootFor(rel, manifest, args) {
  const parts = rel.split('/')
  const top = parts[0]
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  if (top === '01-dsh-home' || top === '05-plugins') return home
  if (top === '03-hindsight') {
    return parts[1] === 'home' ? join(homedir(), '.hindsight') : join(homedir(), '_vault-hindsight')
  }
  if (top === '02-workspaces') {
    const wsName = parts[1]
    const ws = (manifest?.workspaces ?? []).find((w) => (w.dest ?? '').endsWith(`/${wsName}`) || (w.dest ?? '') === `02-workspaces/${wsName}`)
    let base = ws?.abs ?? join(homedir(), '_vault-workspaces', wsName)
    for (const r of args.remap ?? []) {
      const [from, to] = r.split('=')
      if (from && to && base.toLowerCase().startsWith(from.toLowerCase())) base = to + base.slice(from.length)
    }
    return base
  }
  // 00-installer / 04-docker 等：不再撒在当前工作目录（审查 B18），统一落到 _vault-extras
  return args.target || join(homedir(), '_vault-extras')
}

/** 首次向某个目标根写入之前，把原目录整体改名成 <root>.bak-<stamp> 再重建空目录。 */
function ensureRootBackup(root, stamp, backedUp) {
  if (backedUp.has(root)) return
  backedUp.add(root)
  const bak = `${root}.bak-${stamp}`
  try {
    if (!existsSync(root)) { mkdirSync(root, { recursive: true }); return }
    let dest = bak
    for (let i = 2; existsSync(dest); i++) dest = `${bak}-${i}`
    renameSync(root, dest)
    mkdirSync(root, { recursive: true })
    // 走 stderr：stdout 必须保持"只有一段可解析 JSON"（调用方会 JSON.parse）
    console.error(`[in-place] 原目录已备份：${root}  →  ${dest}`)
  } catch (e) {
    // 备份失败必须中止：宁可不还原，也不能无回退点地覆盖真实数据
    throw new Error(`in-place 前无法备份原目录 ${root}：${e.message}（已中止，未覆盖任何数据）`)
  }
}

/** 分区落地映射（跨机通用：由环境推导，不写死盘符）。 */
function mapDestination(rel, manifest, args) {
  const [top, ...rest] = rel.split('/')
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  if (top === '01-dsh-home') return join(home, ...rest)
  if (top === '05-plugins') {
    const sub = rest.join('/')
    if (sub.startsWith('plugins-desk-v1/') || sub.startsWith('plugin-data/') || sub.startsWith('profiles/')) return join(home, sub)
    return join(home, '_vault', sub)
  }
  if (top === '03-hindsight') {
    if (rest[0] === 'home') return join(homedir(), '.hindsight', ...rest.slice(1))
    return join(homedir(), '_vault-hindsight', ...rest)
  }
  if (top === '02-workspaces') {
    const wsName = rest[0]
    const ws = (manifest?.workspaces ?? []).find((w) => (w.dest ?? '').endsWith(`/${wsName}`) || (w.dest ?? '') === `02-workspaces/${wsName}`)
    let base = ws?.abs ?? join(homedir(), '_vault-workspaces', wsName)
    for (const r of args.remap ?? []) {
      const [from, to] = r.split('=')
      if (from && to && base.toLowerCase().startsWith(from.toLowerCase())) base = to + base.slice(from.length)
    }
    return join(base, ...rest.slice(1))
  }
  // 00-installer / 04-docker / 未知分区：统一落 _vault-extras（不再撒在当前工作目录，审查 B18）
  return join(args.target || join(homedir(), '_vault-extras'), rel)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.package) { usage(); process.exit(args.package ? 0 : 1) }
  const mainPath = resolve(args.package)
  const { header, headerBytes } = await readHeader(mainPath)
  const parts = listParts(mainPath)
  const sidecar = readSidecar(mainPath)

  if (args.list || (!args.verify && !args.target && !args.inPlace)) {
    console.log(JSON.stringify({
      baseName: header.baseName,
      createdAt: header.createdAt,
      host: header.host,
      dsh: header.dsh,
      kind: header.kind,
      scope: header.scope,
      cipher: header.crypto?.cipher,
      kdf: header.crypto?.kdf?.algo,
      kdfParams: { N: header.crypto?.kdf?.N, r: header.crypto?.kdf?.r, p: header.crypto?.kdf?.p, chunkSize: header.crypto?.chunkSize },
      parts: parts.map((p) => ({ file: basename(p), bytes: statSync(p).size })),
      headerBytes,
      sidecarManifest: sidecar ? basename(mainPath).replace(/\.vault$/, '.manifest.json') : null,
      sidecarPlainHash: sidecar?.plainHash ?? null,
      partitions: sidecar?.partitions ?? null,
    }, null, 2))
    if (!args.verify && !args.target && !args.inPlace) return
  }

  // 审查 B14：优先从环境变量取密码 —— 避免明文出现在子进程 argv（本机进程列表可见）
  if (!args.password && process.env.DSHVAULT_PASSWORD) args.password = process.env.DSHVAULT_PASSWORD
  if (!args.account && process.env.DSHVAULT_ACCOUNT) args.account = process.env.DSHVAULT_ACCOUNT

  // ── 按包头决定怎么解（三种形态）────────────────────────────────────────────
  //   v0 / encrypted:false → 未加密包：直接 gunzip，不要任何凭证
  //   v2（有 slots）        → 凭证绑定：账号密码 / 恢复码 / 本机免密，任一槽解开即得 DEK
  //   v1（crypto.kdf）      → 旧的"随机密码直接派生"模式
  const encrypted = header.encrypted !== false && header.v !== 0
  let key = null
  const params = header.crypto ?? null
  let unlockInfo = null

  if (!encrypted) {
    unlockInfo = '未加密包（v0）：跳过解密，直接解压'
  } else if (header.slots?.length) {
    const opened = openKeyringV2(header, {
      account: args.account,
      password: args.password,
      recoveryCode: args.recoveryCode,
      local: Boolean(args.local),
    })
    if (!opened.ok) {
      const f = opened.failures?.[0] ?? {}
      const err = new Error(`解不出密钥：${f.reason ?? 'unknown'}${f.hint ? ' —— ' + f.hint : ''}`)
      err.vaultFailures = opened.failures
      throw err
    }
    key = opened.dek
    unlockInfo = `凭证绑定（v2）：通过「${opened.via}」槽解开`
  } else {
    if (!args.password) throw new Error('这个包需要密码：--password 或环境变量 DSHVAULT_PASSWORD')
    key = scryptSync(args.password, Buffer.from(header.crypto.kdf.salt, 'base64'), header.crypto.kdf.keyLen ?? 32, {
      N: header.crypto.kdf.N, r: header.crypto.kdf.r, p: header.crypto.kdf.p, maxmem: 512 * 1024 * 1024,
    })
    unlockInfo = '密码派生（v1）'
  }
  console.error(`[unlock] ${unlockInfo}`)

  const stats = { files: 0, bytes: 0, skipped: 0, rejected: 0 }
  const written = []
  const rejected = []
  const backedUpRoots = new Set()
  const stampTag = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  let inPackageManifest = null

  const onEntry = async (entry) => {
    if (entry.rel === 'RESTORE/manifest.json') {
      // 审查 S5：manifest 也全量入内存 —— 设上限（正常远小于 1 MiB，超大即视为构造包）
      const LIMIT = 8 * 1024 * 1024
      if ((entry.size ?? 0) > LIMIT) throw new Error(`RESTORE/manifest.json 声明过大（${entry.size} B），拒绝`)
      const chunks = []
      let total = 0
      for await (const c of entry.body) {
        total += c.length
        if (total > LIMIT) throw new Error('RESTORE/manifest.json 超过 8 MiB，拒绝（包被构造或损坏）')
        chunks.push(c)
      }
      const raw = Buffer.concat(chunks)
      try { inPackageManifest = JSON.parse(raw.toString('utf8')) } catch { /* 忽略 */ }
      // 审查 B17：--target 模式也要把它**落到磁盘**（usage 承诺 payload/ 与 RESTORE/ 原样落地；
      // 原实现解析后直接 return，从来不写盘 → 解包目录里缺这个文件）。
      if (!args.inPlace && args.target && raw.length > 0) {
        try {
          const dest = join(resolve(args.target), 'RESTORE', 'manifest.json')
          mkdirSync(dirname(dest), { recursive: true })
          writeFileSync(dest, raw)
        } catch { /* 落盘失败不影响解包主体 */ }
      }
      return
    }
    if (args.verify) { for await (const _ of entry.body) { /* drain */ } return }

    let dest
    let root
    if (args.inPlace) {
      const rel = entry.rel.replace(/^payload\//, '')
      const top = rel.split('/')[0]
      if (args.only.length > 0 && !args.only.includes(top)) { for await (const _ of entry.body) { /* drain */ } stats.skipped++; return }
      // S1 修复：首次向该目标根写入前，把原目录整根改名 .bak-<stamp>（失败即中止，绝不无回退覆盖）
      root = rootFor(rel, inPackageManifest ?? sidecar, args)
      ensureRootBackup(root, stampTag, backedUpRoots)
      dest = mapDestination(rel, inPackageManifest ?? sidecar, args)
    } else {
      // 审查 B17：--only 以前只在 in-place 模式生效；--target 解包也要能用
      // （RESTORE/ 下的文档与还原器不参与过滤，始终落地）
      if (args.only.length > 0 && entry.rel.startsWith('payload/')) {
        const top = entry.rel.slice('payload/'.length).split('/')[0]
        if (!args.only.includes(top)) {
          for await (const _ of entry.body) { /* drain */ }
          stats.skipped++
          return
        }
      }
      root = resolve(args.target || '.')
      dest = join(root, entry.rel)
    }

    // S2 修复：路径穿越防护 —— 解析后的落点必须落在该条目所属目标根内，否则拒绝并计数
    const destAbs = resolve(dest)
    const rootAbs = resolve(root)
    if (!(destAbs === rootAbs || destAbs.startsWith(rootAbs + sep))) {
      for await (const _ of entry.body) { /* drain */ }
      stats.skipped++
      stats.rejected++
      if (rejected.length < 50) rejected.push(entry.rel)
      return
    }

    if (entry.isDir) { mkdirSync(destAbs, { recursive: true }); return }
    mkdirSync(dirname(destAbs), { recursive: true })
    dest = destAbs
    const ws = createWriteStream(dest)
    for await (const c of entry.body) {
      if (!ws.write(c)) await new Promise((r) => ws.once('drain', r))
    }
    await new Promise((r) => ws.end(r))
    stats.files++
    stats.bytes += entry.size
    written.push(dest)
  }

  const res = await walkArchive({ parts, headerBytes, key, params: header.crypto }, onEntry)

  // 分卷 sha256（与 sidecar 对照）
  const partHashes = []
  let partsMatch = null
  if (sidecar?.parts) {
    let allMatch = true
    for (const p of parts) {
      const h = await sha256File(p)
      const rec = sidecar.parts.find((x) => x.name === basename(p))
      partHashes.push({ file: basename(p), sha256: h, match: rec ? rec.sha256 === h : null })
      if (rec && rec.sha256 !== h) allMatch = false
      if (!rec) allMatch = false
    }
    partsMatch = allMatch
  } else {
    for (const p of parts) partHashes.push({ file: basename(p), sha256: await sha256File(p) })
  }

  const expected = inPackageManifest?.plainHash ?? sidecar?.plainHash ?? null
  const expectedFrom = inPackageManifest?.plainHash ? 'in-package' : (sidecar?.plainHash ? 'sidecar' : null)
  const hashMatch = expected ? expected === res.plainHash : null

  console.log(JSON.stringify({
    // ⚠️ 审查 B2：没有基准哈希时不能宣称 ok:true —— 那会让人以为"完整性已确认"。
    // 此时只说结构/GCM 认证通过，内容比对无从谈起。
    ok: expected ? true : 'unknown',
    integrityNote: expected
      ? 'plainHash 与基准一致（基准来源：' + expectedFrom + '）'
      : '未找到基准哈希（包外 sidecar 缺失）：本次只校验了 GCM 认证与 tar 结构，未做内容比对',
    mode: args.verify ? 'verify' : (args.inPlace ? 'in-place' : 'extract'),
    plainHash: res.plainHash,
    plainHashScope: 'decrypted-gzip-stream（解密后 / 解压前；不是 tar 明文）',
    expectedPlainHash: expected,
    expectedFrom,
    hashMatch,
    partsMatch,
    partHashes,
    files: stats.files,
    bytes: stats.bytes,
    skipped: stats.skipped,
    rejected: stats.rejected,
    rejectedSample: rejected,
    backedUpRoots: [...backedUpRoots],
    target: args.target || null,
    sample: written.slice(0, 10),
  }, null, 2))

  if (stats.rejected > 0) {
    console.error(`警告：${stats.rejected} 个条目因路径越界被拒绝（包被构造或已损坏）`)
    process.exitCode = 3
  }

  if (expected && expected !== res.plainHash) {
    console.error('警告：tar 明文 sha256 与索引不一致 —— 内容可能被改动')
    process.exitCode = 2
  }
  if (partsMatch === false) {
    console.error('警告：分卷 sha256 与索引不一致 —— 某个卷文件被改动或替换')
    process.exitCode = 2
  }
}

main().catch((e) => {
  console.error('还原失败：' + (e?.stack ?? e))
  process.exit(1)
})
