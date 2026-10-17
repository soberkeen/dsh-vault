#!/usr/bin/env node
/**
 * core-drop.mjs — 真实备份落地入口（可复现 runner，零依赖）
 *
 * 与「面板按钮」等价的一次性命令行入口，便于审计与回归：
 *   预估 → 空间检查 → runBackup（tar→gzip→AES-256-GCM→分卷）→ 结果 JSON
 *
 * 密码策略（不给明文落进日志/文档）：
 *   --password <值>           显式传入（会体现在进程参数里，仅本地用）
 *   --password-env <VAR>      从环境变量读（默认 DSHVAULT_PASSWORD）
 *   都未提供 → 生成 24 字符随机密码，写入 <out>/_keys/<baseName>.key.txt，
 *              并只在 stdout 打印一次（提示：该文件=可解密凭据，请自行保管）
 *
 * 用法：
 *   node scripts/core-drop.mjs --dry                      # 只预估，不写包
 *   node scripts/core-drop.mjs --out G:\DSH-Backup        # 真写包
 *   node scripts/core-drop.mjs --scope all --include-p1   # 含工作区 + P1
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { human, isoNow } from '../lib/vault/io.js'
import { runBackup } from '../lib/vault/pack.js'
import { dshHome, hostSlug, stateDir } from '../lib/vault/paths.js'
import { loadTargets } from '../lib/vault/targets.js'
import { scanPlan } from '../lib/vault/scan.js'

const HERE = dirname(fileURLToPath(import.meta.url))
void HERE

const DEFAULT_OUT = process.env.DSHVAULT_OUT_DIR || 'G:\\DSH-Backup'

function parseArgs(argv) {
  const out = { out: DEFAULT_OUT, scope: 'core', includeP1: false, dry: false, passwordEnv: 'DSHVAULT_PASSWORD', only: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--out' || a === '-o') out.out = argv[++i]
    else if (a === '--scope') out.scope = argv[++i]
    else if (a === '--password' || a === '-w') out.password = argv[++i]
    else if (a === '--account' || a === '-a') out.account = argv[++i]
    else if (a === '--recovery') out.recovery = true            // 生成恢复码槽（打包时显示一次）
    else if (a === '--local') out.local = true                  // 加本机免密槽（DPAPI）
    else if (a === '--no-encrypt' || a === '--plain') out.noEncrypt = true   // 不加密模式
    else if (a === '--write-key') out.writeKey = true                        // 显式要求把密码/恢复码写进 _keys
    else if (a === '--skip-parts') out.skipParts = String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean)   // 显式跳过分区（如 04-docker,03-hindsight）
    else if (a === '--push') out.push = String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean)              // 落地后推送到这些目标名（读 targets.json）
    else if (a === '--targets-file') out.targetsFile = argv[++i]                                                             // 目标配置文件（缺省 plugin-data/dsh-vault/targets.json）
    else if (a === '--password-env') out.passwordEnv = argv[++i]
    else if (a === '--only') out.only.push(argv[++i])
    else if (a === '--include-p1') out.includeP1 = true
    else if (a === '--no-installer') out.noInstaller = true
    else if (a === '--part-bytes') out.partBytes = Number(argv[++i])
    else if (a === '--gzip-level') out.gzipLevel = Number(argv[++i])
    else if (a === '--dry' || a === '--dry-run') out.dry = true
    else if (a === '--help' || a === '-h') out.help = true
  }
  return out
}

function usage() {
  console.log(`dsh-vault 真实落地入口

  --out <目录>            输出目录（默认 ${DEFAULT_OUT}）
  --scope core|ws|all     范围（默认 core：配置+会话+记忆+安装包+插件+编排）
  --include-p1            同时纳入 P1（默认关）
  --only <分区id>         仅这些分区（可重复；调试用）
  --no-installer          不打包 DSH 客户端安装包
  --part-bytes <N>        分卷大小（默认 4 GiB）
  --gzip-level <1-9>      gzip 级别（默认 6）
  --password <值>         加密密码
  --password-env <VAR>    从环境变量取密码（默认 DSHVAULT_PASSWORD）
  --dry                   只预估，不写包
`)
}

const args = parseArgs(process.argv.slice(2))
if (args.help) { usage(); process.exit(0) }

const outDir = resolve(args.out)
const started = Date.now()

// ── 1) 预估（零副作用）────────────────────────────────────────────────────
const scanOpts = {
  scope: args.scope,
  includeP1: args.includeP1,
  onlyParts: args.only.length > 0 ? args.only : undefined,
}
if (args.noInstaller) {
  scanOpts.onlyParts = (scanOpts.onlyParts ?? ['00-installer', '01-dsh-home', '02-workspaces', '03-hindsight', '04-docker', '05-plugins'])
    .filter((p) => p !== '00-installer')
}

const scan = await scanPlan(scanOpts)
const p0Bytes = scan.reports.reduce((s, r) => s + r.bytes, 0)
const p0Entries = scan.reports.reduce((s, r) => s + r.entries.filter((e) => e.tier === 'P0').length, 0)
const p1Entries = scan.reports.reduce((s, r) => s + r.entries.filter((e) => e.tier === 'P1').length, 0)

console.log('=== dsh-vault core-drop ===')
console.log(`host=${hostSlug()}  scope=${args.scope}  includeP1=${args.includeP1}  out=${outDir}`)
console.log('')
console.log('| 分区 | 文件 | 体积 | P0 | P1 | 排除条目 |')
console.log('|---|---|---|---|---|---|')
for (const r of scan.reports) {
  console.log(`| ${r.id} ${r.label} | ${r.files} | ${human(r.bytes)} | ${r.tier0} | ${r.tier1} | ${r.excluded.length} |`)
}
console.log('')
console.log(`合计：文件 ${scan.totalFiles} / ${human(scan.totalBytes)}；P0 条目 ${p0Entries}，P1 条目 ${p1Entries}`)
console.log(`排除：${scan.excludedCount} 条 / ${human(scan.excludedBytes)}`)

if (args.dry) {
  console.log('')
  console.log(JSON.stringify({ dry: true, out: outDir, scope: args.scope, files: scan.totalFiles, bytes: scan.totalBytes, p0Entries, p1Entries, excludedCount: scan.excludedCount, excludedBytes: scan.excludedBytes }, null, 2))
  process.exit(0)
}

// ── 2) 空间检查 ────────────────────────────────────────────────────────────
mkdirSync(outDir, { recursive: true })
let freeBytes = null
try {
  // Node 18.15+ 有 statfs；失败就跳过检查（不因平台差异阻塞）
  const { statfsSync } = await import('node:fs')
  const st = statfsSync(outDir)
  freeBytes = Number(st.bavail) * Number(st.bsize)
} catch { freeBytes = null }

const need = Math.ceil(p0Bytes * 1.5) + (args.includeP1 ? p1Entries * 0 : 0)
console.log('')
if (freeBytes !== null) {
  console.log(`空间：可用 ${human(freeBytes)}；预估需要 ≥ ${human(need)}（原体积×1.5）`)
  if (freeBytes < need) {
    console.error(`空间不足：可用 ${human(freeBytes)} < 需要 ${human(need)}。已中止，未写任何文件。`)
    process.exit(2)
  }
} else {
  console.log('空间：无法探测（statfs 不可用）→ 跳过检查，继续')
}

// ── 3) 密码 / 凭证 ─────────────────────────────────────────────────────────
// 三种形态（操作者定）：
//   --no-encrypt                → 不加密：谁拿到都能打开，只适合放本机 / 可信位置
//   默认（给了 --password 等）  → 凭证绑定 v2：账号(可不填) + 密码 [+ --recovery 恢复码] [+ --local 本机免密]
//   密码规则：首字母大写 · 含特殊符号 · ≥8 位（不合规在打包时就被拒）
const noEncrypt = Boolean(args.noEncrypt)
let password = args.password ?? process.env[args.passwordEnv] ?? null
let keyFile = null
let passwordSource = 'arg'
let recoveryRequested = Boolean(args.recovery)
let localRequested = Boolean(args.local)
if (noEncrypt) {
  password = null
  passwordSource = 'none'
} else if (!password) {
  // ⚠️ 老路径已废弃：不再"生成随机密码 + 写进 _keys/*.key.txt"（那等于钥匙和保险箱放一起）。
  // 现在默认走**凭证绑定**：随机密码 + 自动恢复码 + 本机免密槽；
  // 密码与恢复码都**只打印一次、不落盘**（要落盘需显式 --write-key）。
  const rnd = randomBytes(18).toString('base64url')
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
  password = upper[randomBytes(1)[0] % upper.length] + rnd.slice(1, 20) + '#' + rnd.slice(20, 23)
  passwordSource = 'generated'
  recoveryRequested = true      // 恢复码是"忘了密码"时的退路，默认就带上
  localRequested = true        // 本机免密槽：本机还原不用输任何东西
}

// ── 3.5) 推送目标（可选）───────────────────────────────────────────────────
// 目标配置在 plugin-data/dsh-vault/targets.json（面板「目标」区或保存 API 写入；
// 凭据用 DPAPI 加密，不落明文）。这里按名字挑出要推的目标。
let targetsToPush
if (Array.isArray(args.push) && args.push.length > 0) {
  const st = stateDir(dshHome())
  const { targets, file } = loadTargets(st)
  targetsToPush = targets.filter((t) => args.push.includes(t.name))
  const missing = args.push.filter((n) => !targetsToPush.some((t) => t.name === n))
  if (missing.length > 0) console.error(`⚠️ 目标配置里没找到：${missing.join(', ')}（配置文件：${file}）`)
  console.log(`推送目标：${targetsToPush.map((t) => `${t.name}(${t.type})`).join('、') || '（无）'}`)
}

// ── 4) 真跑 ────────────────────────────────────────────────────────────────
console.log('')
console.log('开始打包（tar → gzip → AES-256-GCM 分块 → 分卷）…')
const res = await runBackup({
  password,
  account: args.account ?? '',
  encrypt: !noEncrypt,
  recoveryCode: recoveryRequested ? true : null,
  deviceSlot: localRequested,
  outDir,
  scope: args.scope,
  includeP1: args.includeP1,
  kind: 'full',
  skipParts: args.skipParts,
  targets: targetsToPush,
  onlyParts: args.only.length > 0 ? args.only : undefined,
  partBytes: args.partBytes,
  gzipLevel: args.gzipLevel,
}, (m) => console.log('  [vault] ' + m))

// ── 5) 密码文件（仅当随机生成时）───────────────────────────────────────────
if (passwordSource === 'generated') {
  console.log('')
  console.log(`密码（仅本次显示一次，请抄下）：${password}`)
  if (args.writeKey) {
    // 显式要求才落盘（默认已废弃老路径：钥匙不该和保险箱放一起）
    const keyDir = join(outDir, '_keys')
    mkdirSync(keyDir, { recursive: true })
    keyFile = join(keyDir, `${res.baseName}.key.txt`)
    const body = [
      `# dsh-vault 备份包密钥（你显式要求落盘：--write-key）`,
      `包名：${res.baseName}`,
      `生成时间：${isoNow()}`,
      `账号：${args.account ?? ''}`,
      `密码：${password}`,
      ``,
      `⚠️ 本文件等同于解密凭据：泄露 = 包可被解开。请移到安全位置（或抄写后删除本文件）。`,
    ].join('\n')
    writeFileSync(keyFile, body, 'utf8')
    console.log(`已写入密钥文件：${keyFile}`)
  } else {
    console.log('（未落盘；要落盘请加 --write-key）')
  }
}

// ── 6) 恢复码 / 模式 提示 ──────────────────────────────────────────────────
if (res.keyring?.recoveryCode) {
  console.log('')
  console.log(`恢复码（仅本次显示一次，请抄到纸上或存进密码管理器）：${res.keyring.recoveryCode}`)
  if (args.writeKey) {
    const recDir = join(outDir, '_keys')
    mkdirSync(recDir, { recursive: true })
    const recFile = join(recDir, `${res.baseName}.recovery.txt`)
    writeFileSync(recFile, [
      `# dsh-vault 恢复码（忘了账号密码时的唯一退路）`,
      `包名：${res.baseName}`,
      `恢复码：${res.keyring.recoveryCode}`,
      ``,
      `⚠️ 恢复码丢了 + 账号密码忘了 = 这个包永久打不开。`,
    ].join('\n'), 'utf8')
    console.log(`已写入：${recFile}`)
  } else {
    console.log('（未落盘；要落盘请加 --write-key）')
  }
}
if (res.encrypted === false) {
  console.log('')
  console.log('⚠️ 未加密模式：这个包**任何人都能打开**（头之后就是 gzip 数据）。')
  console.log('   适合放本机或可信位置；要传到网盘请去掉 --no-encrypt。')
} else {
  console.log('')
  console.log(`加密模式：${res.manifest?.crypto?.mode ?? 'encrypted'}｜钥匙槽：${(res.keyring?.slots ?? []).map((s) => s.type).join(' + ') || 'password'}`)
  console.log('   跨机还原：node RESTORE/vault-restore.mjs --package <包> --account <账号> --password <密码> --target <目录>')
}

const totalPartsBytes = res.parts.reduce((s, p) => s + p.bytes, 0)
const seconds = Math.round((Date.now() - started) / 1000)

console.log('')
console.log('=== 落地完成 ===')
console.log(`包名：${res.baseName}`)
console.log(`目录：${outDir}`)
console.log(`体积：${human(totalPartsBytes)}（${res.parts.length} 卷）｜条目 ${res.entries}｜耗时 ${seconds}s`)
console.log(`明文流 sha256：${res.manifest.plainHash}`)
console.log(`包字节 sha256：${res.manifest.packSha256}`)
console.log(`manifest：${res.manifestPath}`)
console.log('')
console.log(`下一步校验：node scripts/verify-drop.mjs --package "${join(outDir, res.parts[0].name)}" --key-file "${keyFile ?? '(用你的密码)'}"`)

// 机器可读结果（供报告引用）
console.log('')
console.log('CORE-DROP-RESULT ' + JSON.stringify({
  baseName: res.baseName,
  outDir,
  parts: res.parts.length,
  bytes: totalPartsBytes,
  entries: res.entries,
  seconds,
  plainHash: res.manifest.plainHash,
  packSha256: res.manifest.packSha256,
  manifestPath: res.manifestPath,
  keyFile,
  passwordSource,
  passwordEnv: args.passwordEnv,
  scope: args.scope,
  includeP1: args.includeP1,
  excludedCount: res.manifest.excludedCount,
  excludedBytes: res.manifest.excludedBytes,
}))

// 保持 existsSync/statSync 引用（供将来扩展的产物体检，避免未使用告警）
void existsSync
void statSync
