#!/usr/bin/env node
/**
 * selftest.mjs — 端到端自检（不需要 DSH 注入即可跑）
 *
 *   1) scan    扫描小分区（03-hindsight + 05-plugins），打印分层与排除统计
 *   2) backup  真跑一次加密备份（tar → gzip → AES-256-GCM → 分卷）
 *   3) verify  调包内自包含还原器 --verify，比对 tar 明文 sha256
 *   4) extract 解包到临时目录，核对条目数
 *
 * 用法：node scripts/selftest.mjs [输出目录]
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { human } from '../lib/vault/io.js'
import { runBackup } from '../lib/vault/pack.js'
import { scanPlan } from '../lib/vault/scan.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const RESTORE_CLI = join(ROOT, 'lib', 'vault', 'portable-restore.mjs')
const OUT = process.argv[2] ? resolve(process.argv[2]) : join(tmpdir(), 'dsh-vault-selftest')
const PASSWORD = process.env.DSHVAULT_TEST_PASSWORD || 'Selftest#Pass123'   // 需符合密码策略（首字母大写 / 含特殊符号 / ≥8 位）

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

console.log('=== dsh-vault selftest ===')
console.log(`out=${OUT}`)
mkdirSync(OUT, { recursive: true })

// ── 1) scan ────────────────────────────────────────────────────────────────
const onlyParts = (process.env.DSHVAULT_TEST_PARTS ?? '03-hindsight,05-plugins').split(',').map((s) => s.trim()).filter(Boolean)
const scan = await scanPlan({ scope: 'core', onlyParts })
check('scan: 分区数量 > 0', scan.reports.length > 0, `${scan.reports.length} 分区 / ${scan.totalFiles} 文件 / ${human(scan.totalBytes)}`)
for (const r of scan.reports) {
  console.log(`  - ${r.id}: ${r.files} 文件 / ${human(r.bytes)} / P0=${r.tier0} P1=${r.tier1} / 排除 ${r.excluded.length}`)
}

// ── 2) backup ──────────────────────────────────────────────────────────────
const res = await runBackup({
  password: PASSWORD,
  outDir: OUT,
  scope: 'core',
  onlyParts,
  kind: 'full',
  partBytes: 64 * 1024 * 1024, // 自检用小分卷（易触发多卷路径）
}, (m) => console.log('  [vault] ' + m))
check('backup: 产出主包', existsSync(join(OUT, res.parts[0].name)), `${res.parts[0].name} (${human(res.totalBytes)})`)
check('backup: 卷数 >= 1', res.parts.length >= 1, `${res.parts.length} 卷`)
check('backup: 条目数 > 0', res.entries > 0, `${res.entries} 条目`)
check('backup: manifest 落盘', existsSync(res.manifestPath), res.manifestPath)

// ── 3) verify（包内自包含还原器）────────────────────────────────────────────
const mainPack = join(OUT, res.parts[0].name)
const vr = spawnSync(process.execPath, [RESTORE_CLI, '--package', mainPack, '--password', PASSWORD, '--verify'], { encoding: 'utf8' })
check('verify: 退出码 0', vr.status === 0, `status=${vr.status}`)
if (vr.status !== 0) console.log(vr.stderr)
let parsed = null
try { parsed = JSON.parse(vr.stdout) } catch { /* 保留原样 */ }
if (parsed) {
  check('verify: plainHash 与索引一致', parsed.hashMatch === true, `expectedFrom=${parsed.expectedFrom} plainHash=${String(parsed.plainHash).slice(0, 16)}…`)
  check('verify: 分卷 sha256 与索引一致', parsed.partsMatch === true, `${parsed.partHashes?.length ?? 0} 卷`)
}

// ── 4) extract（解包到临时目录）─────────────────────────────────────────────
const dest = join(OUT, '_extract')
try { rmSync(dest, { recursive: true, force: true }) } catch { /* 忽略 */ }
mkdirSync(dest, { recursive: true })
const ex = spawnSync(process.execPath, [RESTORE_CLI, '--package', mainPack, '--password', PASSWORD, '--target', dest], { encoding: 'utf8' })
check('extract: 退出码 0', ex.status === 0, `status=${ex.status}`)
if (ex.status !== 0) console.log(ex.stderr)
const restoreDir = join(dest, 'RESTORE')
check('extract: 包内 RESTORE/ 存在', existsSync(restoreDir), existsSync(restoreDir) ? readdirSync(restoreDir).join(', ') : '')
check('extract: payload/ 存在', existsSync(join(dest, 'payload')), '')

// ── 5) 错误密码必须失败（负例）──────────────────────────────────────────────
const bad = spawnSync(process.execPath, [RESTORE_CLI, '--package', mainPack, '--password', 'wrong-password', '--verify'], { encoding: 'utf8' })
check('负例: 错误密码被拒', bad.status !== 0, `status=${bad.status}`)

// ── 汇总 ───────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok)
console.log('')
console.log(`=== ${results.length - failed.length}/${results.length} 通过 ===`)
if (failed.length > 0) {
  console.log('失败项：')
  for (const f of failed) console.log(`  - ${f.name} ${f.detail}`)
  process.exit(1)
}
