/**
 * pack.js — 打包流水线（AGENT.md / ADR-002 + ADR-004）
 *
 *   条目 → tar → gzip → AES-256-GCM 分块加密 → 分卷写盘（默认 4 GB/卷）
 *   每卷开头写明文头（magic + header JSON），任何一卷都能识别包并报出缺卷号。
 *   输出到 _staging/ → 全部完成后原子改名落地到目标目录。
 *   同时产出：<base>.manifest.json（明文索引：分区表 / 排除证据 / 校验和 / 链信息）
 */
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable, Transform, Writable, pipeline } from 'node:stream'
import { createGzip } from 'node:zlib'
import { promisify } from 'node:util'
import { CHUNK_SIZE, EncryptTransform, MAGIC, deriveKey, encodeHeader, newCryptoParams } from './crypto.js'
import { acquireLock } from './lock.js'
import { createKeyring, validatePassword } from './kdf.js'
import { pushToTargets } from './targets.js'
import { atomicWriteFile, human, isoNow, stamp } from './io.js'
import { hostSlug, stateDir } from './paths.js'
import { dumpHindsight, scanPlan } from './scan.js'
import { tarWrite } from './tar.js'
import { rulesSummary } from './filter.js'

const pipe = promisify(pipeline)
const HERE = dirname(fileURLToPath(import.meta.url))

export const DEFAULT_PART_BYTES = 4 * 1024 * 1024 * 1024

/** 分卷写入器：每卷自带明文头，超限自动开新卷。 */
export class PartWriter extends Writable {
  constructor({ dir, baseName, partSize = DEFAULT_PART_BYTES, headerBuf }) {
    super()
    this.dir = dir
    this.baseName = baseName
    this.partSize = partSize
    this.headerBuf = headerBuf
    this.parts = []
    this.totalHash = createHash('sha256')
    this.current = null
    this.currentBytes = 0
    this._open()
  }

  _open() {
    const idx = this.parts.length + 1
    const name = idx === 1 ? `${this.baseName}.vault` : `${this.baseName}_p${String(idx).padStart(2, '0')}.vault`
    const abs = join(this.dir, name)
    const stream = createWriteStream(abs)
    // 审查 S4：写流错误必须让 pipeline 失败（否则磁盘满会静默出残包 / 崩掉宿主）
    stream.on('error', (e) => this.destroy(e instanceof Error ? e : new Error(String(e))))
    const hash = createHash('sha256')
    const rec = { name, abs, stream, hash, bytes: 0, index: idx }
    this.parts.push(rec)
    this.current = rec
    this.currentBytes = 0
    if (this.headerBuf) {
      stream.write(this.headerBuf)
      hash.update(this.headerBuf)
      rec.bytes += this.headerBuf.length
      this.totalHash.update(this.headerBuf)
    }
  }

  _write(chunk, _enc, cb) {
    // ⚠️ 审查 S4：原实现 stream.write() 不看返回值、不处理错误 —— 磁盘写满时会
    // 触发未处理的 'error'（崩 Electron 主进程），或在错误时机静默产出残包。
    const writeTo = (done) => {
      const s = this.current.stream
      const ok = s.write(chunk)
      this.current.hash.update(chunk)
      this.current.bytes += chunk.length
      this.totalHash.update(chunk)
      this.currentBytes += chunk.length
      if (ok) done()
      else s.once('drain', done)          // 背压：等下游腾出空间再继续
    }
    if (this.currentBytes >= this.partSize) {
      this._closeCurrent().then(() => { this._open(); writeTo(cb) }).catch(cb)
    } else writeTo(cb)
  }

  _closeCurrent() {
    return new Promise((resolve, reject) => {
      if (!this.current) return resolve()
      const s = this.current.stream
      s.once('error', reject)             // 关卷失败必须冒泡，不能被吞成"成功"
      s.end(() => resolve())
    })
  }

  _final(cb) {
    this._closeCurrent().then(() => cb()).catch(cb)
  }

  result() {
    return {
      parts: this.parts.map((p) => ({ name: p.name, abs: p.abs, bytes: p.bytes, sha256: p.hash.digest('hex') })),
      sha256: this.totalHash.digest('hex'),
    }
  }
}

/** 读取包内还原器源码（自包含单文件，随包分发 → 换机也能还原）。 */
export function portableRestoreSource() {
  const p = join(HERE, 'portable-restore.mjs')
  return existsSync(p) ? readFileSync(p) : Buffer.from('// portable-restore.mjs 缺失\n')
}

/** RESTORE/ 合成条目：AGENT.md（台账） + README.md（步骤） + manifest.json + 还原器 + ps1 包装。 */
export function buildRestoreDocs(manifest, opts = {}) {
  const created = manifest.createdAt
  const partLines = manifest.partitions
    .map((p) => `| ${p.id} | ${p.label} | ${p.files} | ${human(p.bytes)} | ${p.tier0} | ${p.excludedCount} |`)
    .join('\n')
  const partList = manifest.parts.map((p) => `- ${p.name} — ${human(p.bytes)} — sha256 ${p.sha256}`).join('\n')

  // 按**实际存在的分区**生成还原步骤 —— 别人机器上没装 Docker / Hindsight 时，
  // 包内不会出现指向不存在目录的步骤（跨机友好；配合 scan.js 的空分区自动剔除）
  const has = (id) => (manifest.partitions ?? []).some((p) => p.id === id)
  const hasInstaller = has('00-installer')
  const hasWs = has('02-workspaces')
  const hasDocker = has('04-docker')
  const hasHindsight = has('03-hindsight')
  const restoreSteps = [
    hasInstaller ? '安装 DSH 客户端：`payload/00-installer/`' : null,
    '设密码环境变量：`$env:DSHVAULT_PASSWORD = "<密码>"`（**不要**放命令行 —— 会进进程 argv 与 4688 事件日志）',
    '解密解包：`node RESTORE/vault-restore.mjs --package <包路径> --target <落地目录>`',
    '还原 $DSH_HOME：把 `payload/01-dsh-home/` 覆盖到 `%USERPROFILE%\\.dsh`（旧目录先改名备份）',
    hasWs ? '还原工作区：把 `payload/02-workspaces/<工作区名>/` 覆盖回原路径' : null,
    (hasDocker || hasHindsight)
      ? `还原 Hindsight：${hasDocker ? '`docker compose -f payload/04-docker/docker-compose.yml up -d` 后 ' : ''}${hasHindsight ? '`docker exec -i <pg容器> pg_restore -U hindsight -d hindsight -c --if-exists --no-owner < payload/03-hindsight/*.dump`' : ''}`
      : null,
    hasHindsight ? '还原 `%USERPROFILE%\\.hindsight`：`payload/03-hindsight/home/`' : null,
    '校验：`node RESTORE/vault-restore.mjs --package <包> --verify`',
    '重启 DSH，确认插件/技能/记忆在线',
  ].filter(Boolean).map((s, i) => `${i + 1}. ${s}`).join('\n')

  const skippedParts = manifest.skippedParts ?? []
  const dockerNote = hasDocker
    ? '- 本包**不含** Docker 镜像与 build cache（可由编排重建）：见 `payload/04-docker/`'
    : '- 本包不含 Docker 相关内容（打包机器上未检测到编排目录 —— 属正常，不影响其它分区还原）'

  const agentMd = `# RESTORE/AGENT.md — ${manifest.host} 备份还原台账

> 由 dsh-vault（@soberkeen/dsh-vault）生成 ｜ 包：${manifest.baseName}
> 生成时间：${created} ｜ 主机：${manifest.host} ｜ DSH 版本：${manifest.dsh?.version ?? 'unknown'}
> 类型：${manifest.kind} ｜ 范围：${manifest.scope} ｜ 规则集：ADR-006（四层排除）+ ADR-009（跨机判定）

## 1. 包清单（含校验和）

${partList}

- 整包字节流 sha256：\`${manifest.packSha256}\`
- 解密后（解压前）流 sha256：\`${manifest.plainHash}\`
- ⚠️ **本文件是打包期快照**：分卷 sha256、排除证据全量清单等"只有流结束后才知道"的字段，
  以**包外同目录**的 \`${manifest.baseName}.manifest.json\` 为准（那份在打包完成后回填）。
  包内这份故意不重复记录，避免自引用（写它时包还没写完）。

## 2. 分区表

| 分区 | 说明 | 文件数 | 体积 | P0 | 排除条目 |
|---|---|---|---|---|---|
${partLines}

## 3. 排除证据（前 ${manifest.excludedSample.length} 条 / 共 ${manifest.excludedCount} 条，${human(manifest.excludedBytes)}）

${manifest.excludedSample.map((e) => `- \`${e.rel}\` — ${human(e.size ?? 0)} — [${e.rule}] ${e.reason}`).join('\n') || '（无）'}

排除规则摘要：
\`\`\`text
${rulesSummary()}
\`\`\`

## 4. 还原动作（按序执行）

${restoreSteps}

## 5. 注意

${dockerNote}
- 本包**不含**视频、依赖目录、构建产物、AI 模型权重（规则见第 3 节）
${skippedParts.length > 0 ? `- 本包**跳过的分区**：${skippedParts.map((s) => `\`${s.id}\`（${s.reason}）`).join('；')} —— 打包机器上不存在这些源，属正常，不影响其它分区` : ''}
- 写入抖动导致未稳定的文件列在 manifest.partial[]，还原后请抽查

## 6. partial（写入未稳定）清单

${(manifest.partial ?? []).map((p) => `- \`${p.rel}\` — ${p.reason ?? ''}`).join('\n') || '（无）'}
`

  const readmeMd = `# RESTORE/README.md — 怎么把这个包还原回去

## 最短路径（任意 Windows + Node 18+）

\`\`\`powershell
# 1) 看包结构（不解密落地）
$env:DSHVAULT_PASSWORD = "<密码>"   # 密码走环境变量，别放命令行（会进进程 argv 与 4688 事件日志）
node .\\RESTORE\\vault-restore.mjs --package .\\${manifest.baseName}.vault --list

# 2) 解到临时目录检查
node .\\RESTORE\\vault-restore.mjs --package .\\${manifest.baseName}.vault --target D:\\vault-out

# 3) 直接按分区还原到原位（会先把旧目录改名成 .bak-<时间戳>）
node .\\RESTORE\\vault-restore.mjs --package .\\${manifest.baseName}.vault --in-place

# 4) 只校验完整性（不落地）
node .\\RESTORE\\vault-restore.mjs --package .\\${manifest.baseName}.vault --verify
\`\`\`

PowerShell 包装（内部调用上面的 node 命令）：

\`\`\`powershell
$env:DSHVAULT_PASSWORD = "<密码>"          # 同上：密码走环境变量
.\\RESTORE\\restore.ps1 -Package .\\${manifest.baseName}.vault
.\\RESTORE\\restore.ps1 -Package .\\${manifest.baseName}.vault -Verify
\`\`\`

## 分区 → 落地位置

| 分区 | 内容 | 还原位置 |
|---|---|---|
| 00-installer | DSH 安装包 | 手动双击安装 |
| 01-dsh-home | DSH 配置/会话/技能 | \`%USERPROFILE%\\.dsh\` |
| 02-workspaces | 工作区（非视频/非缓存） | 原路径（可 remap 盘符） |
| 03-hindsight | 记忆（本地 + Postgres dump） | \`%USERPROFILE%\\.hindsight\` + pg_restore |
| 04-docker | compose/Dockerfile | 项目目录（重建容器） |
| 05-plugins | 插件与装配清单 | 随 01-dsh-home 一起生效 |

## Hindsight 数据库还原（pg_restore）

\`\`\`powershell
# 1) 先起 postgres（编排在包内 04-docker/）
docker compose -f .\\payload\\04-docker\\docker-compose.yml up -d

# 2) 容器名探测（跨机通用，不要写死）
docker ps --format "{{.Names}}|{{.Image}}"

# 3) 把逻辑备份灌回去（-F c 自定义归档，必须用 pg_restore）
docker exec -i <pg容器名> pg_restore -U hindsight -d hindsight -c --if-exists --no-owner < .\\payload\\03-hindsight\\<dump文件>.dump
\`\`\`

- 备份格式是 \`pg_dump -F c\`（自定义归档）→ **必须**用 \`pg_restore\`，直接 \`psql -f\` 会失败
- \`-c --if-exists\` = 先清空同名对象再导入（幂等，可重复执行）
- \`--no-owner\` = 忽略原库角色归属，跨机恢复不会因角色不存在而报错
- 起容器前请确认 \`payload/04-docker/.env\` 里的库名/用户与实际一致（若不同，改上面的 \`-U\`/\`-d\`）

## 常见错误

- \`magic 不匹配\`：文件不是本插件产物，或被截断
- \`缺少分卷 _pNN\`：多卷包需要全部卷放在同一目录
- \`scrypt/GCM 认证失败\`：密码错误（或头部被改动）
- \`pg_restore 失败\`：先确认 postgres 容器已起且版本兼容
`

  const ps1 = `# restore.ps1 — dsh-vault 还原包装（pwsh 7 / Windows PowerShell 5.1 均可）
#
# 密码怎么给（推荐第一种）：
#   1) 先设环境变量再调用：$env:DSHVAULT_PASSWORD = "密码"; .\\restore.ps1 -Package <包>
#   2) 传 -Password "密码" —— 不推荐：它会进本进程的命令行，本机任何进程都能读到
param(
  [Parameter(Mandatory = $true)][string]$Package,
  [string]$Password = '',
  [string]$Target = '',
  [switch]$InPlace,
  [switch]$Verify,
  [switch]$List
)
$ErrorActionPreference = 'Stop'
if (-not $Password) { $Password = $env:DSHVAULT_PASSWORD }
if (-not $Password) { throw '未提供密码：请先 $env:DSHVAULT_PASSWORD = "密码"，或用 -Password 传入（不推荐）' }
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw '未找到 node（DSH 运行时自带，或用官网 Node 18+）' }
$script = Join-Path $PSScriptRoot 'vault-restore.mjs'
# 密码只走环境变量交给 node —— 绝不拼进命令行（GLM-5.3 审查：B14 的残留修复）
$env:DSHVAULT_PASSWORD = $Password
$args = @($script, '--package', $Package)
if ($List) { $args += '--list' }
if ($Verify) { $args += '--verify' }
if ($InPlace) { $args += '--in-place' }
if ($Target) { $args += @('--target', $Target) }
& $node @args
exit $LASTEXITCODE
`

  const manifestJson = JSON.stringify(manifest, null, 2)

  return [
    { rel: 'RESTORE/AGENT.md', data: Buffer.from(agentMd, 'utf8') },
    { rel: 'RESTORE/README.md', data: Buffer.from(readmeMd, 'utf8') },
    { rel: 'RESTORE/manifest.json', data: Buffer.from(manifestJson, 'utf8') },
    { rel: 'RESTORE/restore.ps1', data: Buffer.from(ps1, 'utf8') },
    { rel: 'RESTORE/vault-restore.mjs', data: portableRestoreSource() },
  ]
}

/**
 * 执行一次备份。
 * @param {object} opts { password, outDir, scope, workspaces, includeP1, partBytes, chunkSize, gzipLevel, dryRun, kind }
 */
/** 对外入口：先取单实例锁（审查 B9）—— 两个备份同时跑会共用 _staging 与秒级同名包，互相覆盖。 */
export async function runBackup(opts, log = () => {}) {
  const release = acquireLock(stateDir(opts.dshHome), 'vault-backup')
  try {
    return await runBackupLocked(opts, log)
  } finally {
    release()
  }
}

async function runBackupLocked(opts, log = () => {}) {
  // 只有在"要加密"、且不是"本机免密"模式时才必须给密码
  // （encrypt:false 的明文模式、deviceSlot:true 的本机免密模式都不需要）
  if (opts.encrypt !== false && !opts.password && !opts.deviceSlot) {
    throw new Error('缺少加密密码（vault_backup 的 password 参数）；若要本机免密请设 deviceSlot，若要明文包请设 encrypt:false')
  }
  const outDir = opts.outDir
  if (!outDir) throw new Error('缺少输出目录（outDir）')
  const kind = opts.kind ?? 'full'
  const scope = opts.scope ?? 'core'

  const scan = await scanPlan(opts)
  log(`scan: ${scan.totalFiles} 文件 / ${human(scan.totalBytes)}；排除 ${scan.excludedCount} 条 / ${human(scan.excludedBytes)}`)

  // Hindsight 逻辑备份（PG dump）
  const dbEntries = []
  const notes = []
  if (scan.plan.parts.some((p) => p.id === '03-hindsight')) {
    const dump = await dumpHindsight(opts, log)
    if (dump.ok) {
      dbEntries.push({ rel: dump.rel, abs: dump.abs, size: dump.size, mtimeMs: Date.now(), mode: 0o644, part: '03-hindsight', tier: 'P0' })
      notes.push(`Hindsight dump：${dump.human}（容器 ${dump.container}）`)
    } else {
      notes.push(`Hindsight dump 跳过：${dump.reason}`)
      log(`hindsight: ${dump.reason}`)
    }
  }

  const entries = []
  for (const r of scan.reports) {
    for (const e of r.entries) {
      if (e.tier === 'P0' || (opts.includeP1 && e.tier === 'P1')) entries.push(e)
    }
  }
  entries.push(...dbEntries)

  const baseName = `DSHVAULT_${hostSlug()}_${stamp()}_${kind}_${scope}`

  // ── 加密模式（操作者定：加密 / 不加密两种选项）─────────────────────────────
  //   encrypt:false  → 只 tar + gzip，**谁拿到都能打开**（只适合存在本机/可信位置）
  //   encrypt:true + 凭证（account/password/recoveryCode/deviceSlot）
  //                  → v2：数据用随机 DEK 加密，DEK 由凭证派生的 KEK 包裹（多钥匙槽：
  //                    账号密码 / 恢复码 / 本机免密 DPAPI）→ 跨机只要有凭证就能解
  //   encrypt:true + 仅 password（旧路径）→ v1：随机密码直接派生（保持兼容）
  const encrypted = opts.encrypt !== false
  let params = null
  let key = null
  let keyring = null
  if (encrypted) {
    params = newCryptoParams({ chunkSize: opts.chunkSize ?? CHUNK_SIZE })
    const credentialMode = Boolean(opts.account || opts.password || opts.deviceSlot || opts.recoveryCode)
    if (credentialMode) {
      // 密码策略（操作者定：首字母大写 · 含特殊符号 · ≥8 位）—— 在**打包时**就拦，
      // 别等到换机解包时才发现密码不合规。
      // ⚠️ 至少要有一个**可解槽**：password / recoveryCode / deviceSlot（GLM-5.3 审查 S-A 配套修复）。
      // kdf.js 已改成「空密码不建 primary 槽」，所以三者皆无时包根本无法解开 —— 必须拦在打包前。
      if (!opts.password && !opts.deviceSlot && !opts.recoveryCode) {
        throw new Error('凭证模式至少要一个可解槽：password / recoveryCode / deviceSlot（本机免密）')
      }
      if (opts.password) {
        const v = validatePassword(opts.password)
        if (!v.ok) throw new Error(`密码不符合要求（首字母大写 / 含特殊符号 / ≥8 位）：${v.problems.join('；')}`)
      }
      keyring = await createKeyring({
        account: opts.account ?? '',
        password: opts.password,
        recoveryCode: opts.recoveryCode ?? null,
        deviceSlot: Boolean(opts.deviceSlot),
        kdf: opts.kdf,
      })
      key = keyring.dek                     // 数据用 DEK 加密：换凭证只需重包裹 DEK，不必重加密数据
    } else {
      key = await deriveKey(opts.password, params)   // v1 兼容路径
    }
  }

  const manifest = {
    magic: MAGIC,
    schema: 1,
    baseName,
    createdAt: isoNow(),
    host: hostSlug(),
    os: { platform: process.platform, release: process.version },
    dsh: { version: scan.plan.install?.version ?? null, home: scan.plan.home },
    kind,
    scope,
    encrypted,
    crypto: encrypted
      ? {
          cipher: params.cipher,
          chunkSize: params.chunkSize,
          kdf: params.kdf,
          baseIV: params.baseIV,
          mode: keyring ? 'credential-v2' : 'password-v1',
        }
      : null,
    partitions: scan.reports.map((r) => ({
      id: r.id, label: r.label, files: r.files, bytes: r.bytes, tier0: r.tier0, tier1: r.tier1,
      excludedCount: r.excluded.length, note: r.note,
    })),
    entries: entries.length,
    bytes: entries.reduce((s, e) => s + (e.size ?? 0), 0),
    excludedCount: scan.excludedCount,
    excludedBytes: scan.excludedBytes,
    excludedSample: scan.reports.flatMap((r) => r.excluded).slice(0, 500),
    // 被跳过的分区（本机没有源 / 显式排除）：写进 manifest，包内文档也据此裁剪还原步骤
    skippedParts: scan.skippedParts ?? [],
    partial: [],
    notes,
    workspaces: (scan.plan.parts.find((p) => p.id === '02-workspaces')?.sources ?? []).map((s) => ({ abs: s.abs, dest: s.prefix })),
    restore: {
      entry: 'RESTORE/restore.ps1',
      node: 'RESTORE/vault-restore.mjs',
      docs: ['RESTORE/AGENT.md', 'RESTORE/README.md', 'RESTORE/manifest.json'],
      order: ['00-installer', '01-dsh-home', '02-workspaces', '04-docker', '03-hindsight', '05-plugins'],
    },
    chain: { prev: null, baseOf: null },
    parts: [],
    packSha256: null,
    plainHash: null,
    // ⚠️ 审查 B3：这个哈希是对「解密之后、gunzip 之前」的字节流（即 gzip 流）取的 sha256，
    // **不是 tar 明文**。直接解包出 tar 再算 sha256 会对不上，别据此误判"内容被改过"。
    plainHashScope: 'decrypted-gzip-stream（解密后 / 解压前）',
  }

  const restoreDocs = buildRestoreDocs(manifest, opts)
  const allEntries = [
    ...restoreDocs.map((d) => ({ rel: d.rel, isDir: false, size: d.data.length, mtimeMs: Date.now(), mode: 0o644, data: d.data })),
    ...entries.map((e) => ({ rel: `payload/${e.rel}`, abs: e.abs, isDir: false, size: e.size, mtimeMs: e.mtimeMs, mode: e.mode ?? 0o644 })),
  ]

  if (opts.dryRun) {
    return { dryRun: true, baseName, entries: allEntries.length, bytes: manifest.bytes, manifest, excluded: scan.reports.flatMap((r) => r.excluded).slice(0, 200) }
  }

  const staging = join(outDir, '_staging')
  mkdirSync(staging, { recursive: true })
  // （原处有一行自我循环的死代码 `for (const f of (existsSync(staging) ? [] : [])) void f`，
  //  审查风格条：已删除）

  const headerBuf = encodeHeader({
    magic: MAGIC,
    schema: 1,
    v: encrypted ? (keyring ? 2 : 1) : 0,   // 0=未加密 1=密码派生 2=凭证绑定
    encrypted,
    baseName,
    createdAt: manifest.createdAt,
    host: manifest.host,
    dsh: manifest.dsh,
    kind,
    scope,
    crypto: manifest.crypto,
    // v2：KDF 参数（含 salt）—— 必须随包走，否则换台电脑无从派生同一把 KEK
    kdf: keyring?.header?.kdf ?? null,
    // v2：钥匙槽（账号密码 / 恢复码 / 本机免密）。头里**只有被包裹的 DEK**，没有明文密钥。
    slots: keyring?.header?.slots ?? null,
    partsUnknown: true,
  })

  const writer = new PartWriter({ dir: staging, baseName, partSize: opts.partBytes ?? DEFAULT_PART_BYTES, headerBuf })

  const t0 = Date.now()
  // 打包期可能出现的「读到少于声明 size」由 tar.js 回报，收进 manifest.partial（sidecar 版）
  const partialHits = []
  // 不加密时不插入 EncryptTransform —— 包体就是 gzip(tar)，任何解压工具都能打开。
  // plainHash 统一由一个 tap 计算（语义：解密后、解压前的 gzip 流），这样
  // 「加密 / 不加密」两种模式都有同一套完整性基准。
  // （此前依赖 enc.plainDigest()，未加密时没有 enc → 直接抛错，已修。）
  const plainHash = createHash('sha256')
  const hashTap = new Transform({
    transform(chunk, _enc, cb) { plainHash.update(chunk); cb(null, chunk) },
  })
  const stages = [
    Readable.from(tarWrite(allEntries, { onPartial: (p) => partialHits.push(p) })),
    createGzip({ level: opts.gzipLevel ?? 6 }),
    hashTap,
  ]
  if (encrypted) stages.push(new EncryptTransform(key, params))
  stages.push(writer)
  await pipe(...stages)
  manifest.partial = partialHits
  const result = writer.result()
  manifest.plainHash = plainHash.digest('hex')
  manifest.packSha256 = result.sha256
  manifest.parts = result.parts.map((p) => ({ name: p.name, bytes: p.bytes, sha256: p.sha256 }))

  // 原子落地：staging → outDir
  const landed = []
  for (const p of result.parts) {
    const dest = join(outDir, p.name)
    try { rmSync(dest, { force: true }) } catch { /* 覆盖旧同名 */ }
    renameSync(p.abs, dest)
    landed.push({ ...p, abs: dest })
  }
  manifest.parts = landed.map((p) => ({ name: p.name, bytes: p.bytes, sha256: p.sha256 }))

  // ⚠️ 审查 S4：落地后按字节数**复核每一卷** —— 防「报成功其实是残包」
  for (const p of landed) {
    let actual = -1
    try { actual = statSync(p.abs).size } catch { /* 留 -1，下面统一报错 */ }
    if (actual !== p.bytes) {
      throw new Error(`落地校验失败：${p.name} 期望 ${p.bytes} 字节，实际 ${actual} 字节（磁盘可能写满 / 文件被占用）`)
    }
  }

  // 收尾 1：清掉本次 staging 目录（分卷已全部改名落地，残留空目录只是噪声）
  try {
    const left = existsSync(staging) ? readdirSync(staging) : []
    if (left.length === 0) rmSync(staging, { recursive: true, force: true })
  } catch { /* 清理失败不影响备份结果 */ }

  // 收尾 2：清掉 Hindsight 明文 dump 临时文件（审查 S6）—— 明文记忆库不应长期驻盘，
  // 更不能被下一次备份的 05-plugins 扫描再次收进包。dump 内容此刻已进包。
  try {
    for (const e of dbEntries) if (e.abs) rmSync(e.abs, { force: true })
  } catch { /* 忽略 */ }

  const manifestPath = join(outDir, `${baseName}.manifest.json`)
  // ⚠️ 审查 S4/B19：manifest 走原子写（先 .tmp 再 rename），避免留下半截 JSON
  atomicWriteFile(manifestPath, JSON.stringify(manifest, null, 2))

  // ── 推送（可选）：本地永远是主副本，推送失败**不影响备份成立** ──────────────
  // 目标来自配置（本地 / 网络路径 UNC / WebDAV），见 lib/vault/targets.js
  let pushes = null
  if (Array.isArray(opts.targets) && opts.targets.length > 0) {
    log(`推送 ${opts.targets.length} 个目标…`)
    pushes = await pushToTargets(opts.targets, [...landed.map((p) => p.abs), manifestPath], log)
    for (const p of pushes) {
      if (p.ok) log(`推送成功：${p.target}（${p.sent.length} 个文件）`)
      else log(`推送失败：${p.target} —— ${p.errors.join('；')}`)
    }
    manifest.pushTargets = pushes.map((p) => ({ target: p.target, type: p.type, ok: p.ok, sent: p.sent.length, errors: p.errors }))
    atomicWriteFile(manifestPath, JSON.stringify(manifest, null, 2))   // 补上推送结果
  }

  const seconds = Math.max(1, Math.round((Date.now() - t0) / 1000))
  log(`done: ${baseName} → ${landed.length} 卷 / ${human(landed.reduce((s, p) => s + p.bytes, 0))} / ${seconds}s`)

  return {
    baseName,
    outDir,
    encrypted,
    parts: landed.map((p) => ({ name: p.name, bytes: p.bytes, sha256: p.sha256 })),
    totalBytes: landed.reduce((s, p) => s + p.bytes, 0),
    manifestPath,
    manifest,
    seconds,
    entries: allEntries.length,
    notes,
    pushes,
    // v2：返回槽清单（不含密钥）与**一次性**恢复码 —— 调用方必须提示用户抄下来
    keyring: keyring
      ? {
          slots: keyring.header.slots.map((s) => ({ id: s.id, type: s.type, label: s.label })),
          recoveryCode: keyring.recoveryCode ?? null,
        }
      : null,
  }
}
