#!/usr/bin/env node
/**
 * verify-drop.mjs — 落地包校验入口（配合 core-drop.mjs 的密钥文件），零依赖
 *
 * 作用：把「密码从哪来」这件事收敛掉 —— 既支持显式密码，也支持从 core-drop
 * 生成的 `<out>/_keys/<baseName>.key.txt` 里读取，避免每次手抄。
 *
 * 用法：
 *   node scripts/verify-drop.mjs --package G:\DSH-Backup\DSHVAULT_xxx.vault --key-file G:\DSH-Backup\_keys\DSHVAULT_xxx.key.txt
 *   node scripts/verify-drop.mjs --package <包> --password <密码>
 *   node scripts/verify-drop.mjs --package <包> --key-file <密钥文件> --target D:\vault-out   # 顺带解包核对
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const RESTORE_CLI = join(HERE, '..', 'lib', 'vault', 'portable-restore.mjs')

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--package' || a === '-p') out.package = argv[++i]
    else if (a === '--password' || a === '-w') out.password = argv[++i]
    else if (a === '--key-file' || a === '-k') out.keyFile = argv[++i]
    else if (a === '--target' || a === '-t') out.target = argv[++i]
    else if (a === '--list') out.list = true
    else if (a === '--help' || a === '-h') out.help = true
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
if (args.help || !args.package) {
  console.log(`dsh-vault 校验入口

  --package <主包.vault>   必填
  --key-file <密钥文件>    core-drop 生成的 _keys/*.key.txt
  --password <密码>        或显式给密码
  --target <目录>          额外解包到该目录（核对落地）
  --list                   只列包信息
`)
  process.exit(args.package ? 0 : 1)
}

/** 从密钥文件里抠出密码行（`密码：xxx`）。 */
function readKeyFile(p) {
  const text = readFileSync(p, 'utf8')
  const m = /^\s*密码[:：]\s*(\S+)\s*$/m.exec(text)
  if (!m) throw new Error(`密钥文件里找不到「密码：」行：${p}`)
  return m[1]
}

const pkg = resolve(args.package)
if (!existsSync(pkg)) { console.error(`包不存在：${pkg}`); process.exit(1) }

let password = args.password ?? null
let source = 'arg'
if (!password && args.keyFile) {
  if (!existsSync(args.keyFile)) { console.error(`密钥文件不存在：${args.keyFile}`); process.exit(1) }
  password = readKeyFile(args.keyFile)
  source = 'key-file'
}
if (!password && !args.list) { console.error('需要 --password 或 --key-file（或用 --list 只看包信息）'); process.exit(1) }

const run = (argv) => spawnSync(process.execPath, [RESTORE_CLI, ...argv], { encoding: 'utf8', timeout: 600000 })

// 包体体检
const sidecar = pkg.replace(/\.vault$/, '.manifest.json')
const parts = readdirSync(dirname(pkg)).filter((n) => n === pkg.split(/[\\/]/).pop() || /_p\d+\.vault$/.test(n))
console.log('=== dsh-vault verify-drop ===')
console.log(`包：${pkg}`)
console.log(`体积：${(statSync(pkg).size / 1048576).toFixed(1)} MB（主包）｜同目录分卷 ${parts.length} 卷`)
console.log(`sidecar：${existsSync(sidecar) ? sidecar : '（缺失）'}`)
console.log(`密码来源：${args.list ? '（--list 不解密）' : source}`)

const out = {}
if (args.list) {
  const r = run(['--package', pkg, '--list'])
  console.log(r.stdout?.trim() || r.stderr?.trim())
  out.mode = 'list'
  out.exit = r.status
} else {
  const r = run(['--package', pkg, '--password', password, '--verify'])
  console.log('--- verify ---')
  console.log(r.stdout?.trim() || '')
  if (r.status !== 0) console.log(r.stderr?.trim())
  out.mode = 'verify'
  out.exit = r.status
  try { out.verify = JSON.parse(r.stdout) } catch { /* 保留原始输出 */ }

  if (args.target) {
    mkdirSync(args.target, { recursive: true })
    const e = run(['--package', pkg, '--password', password, '--target', args.target])
    console.log('--- extract ---')
    console.log(e.stdout?.trim() || '')
    if (e.status !== 0) console.log(e.stderr?.trim())
    out.mode = 'verify+extract'
    out.extractExit = e.status
    try { out.extract = JSON.parse(e.stdout) } catch { /* 保留原始输出 */ }
  }
}

console.log('')
console.log('VERIFY-DROP-RESULT ' + JSON.stringify(out))
process.exit(out.exit === 0 && (out.extractExit === undefined || out.extractExit === 0) ? 0 : 1)
