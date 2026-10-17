#!/usr/bin/env node
/**
 * sync-to-plugin-dir.mjs — 把项目源码同步到 DSH 插件目录
 *
 * 为什么需要这个脚本：
 *   DSH 装配本地插件的**硬条件**是「包住在 ~/.dsh/plugins-desk-v1/<scope>/<name>」，
 *   而且那份必须是**实体目录**（2026-10-16 实测：用跨盘 junction 时 pnpm 会把该依赖剔除 →
 *   装配失败 → DSH 永远提示"需要重启"，形成死循环；purge/super-injector 都是实体目录）。
 *   于是：项目目录是**开发源**，插件目录是**运行副本**，本脚本负责把改动推过去。
 *
 * 用法：
 *   node scripts/sync-to-plugin-dir.mjs           # 同步（只复制有差异的文件）
 *   node scripts/sync-to-plugin-dir.mjs --check    # 只检查不写（退出码 1 = 不同步）
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..')
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const DST = join(DSH_HOME, 'plugins-desk-v1', '@dsh-external', 'dsh-vault')
const CHECK_ONLY = process.argv.includes('--check')

/** 参与同步的路径（源码目录里的相对路径）。scripts/ 也带上：运维脚本要能就地跑。 */
const INCLUDE_DIRS = ['lib', 'scripts']
const INCLUDE_FILES = ['package.json', 'cordis.patch.yml', 'README.md']
/** 不参与同步的内容 */
const SKIP = new Set(['node_modules', '.git', 'docs', '_selftest', '.gitignore'])

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

function collect(root) {
  const out = []
  for (const d of INCLUDE_DIRS) {
    const abs = join(root, d)
    if (!existsSync(abs)) continue
    const walk = (dir) => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        if (SKIP.has(ent.name)) continue
        const p = join(dir, ent.name)
        if (ent.isDirectory()) walk(p)
        else if (ent.isFile()) out.push(relative(root, p).replace(/\\/g, '/'))
      }
    }
    walk(abs)
  }
  for (const f of INCLUDE_FILES) if (existsSync(join(root, f))) out.push(f)
  return out.sort()
}

if (!existsSync(DST)) {
  console.error(`✗ 插件目录不存在：${DST}`)
  console.error('  先建实体目录（不要用 junction，pnpm 不认）：')
  console.error(`  robocopy "${SRC}" "${DST}" /E /XD .git node_modules docs`)
  process.exit(1)
}

const files = collect(SRC)
let copied = 0
let same = 0
const diffs = []
for (const rel of files) {
  const a = join(SRC, rel)
  const b = join(DST, rel)
  const aHash = sha(a)
  const bHash = existsSync(b) ? sha(b) : null
  if (aHash === bHash) { same += 1; continue }
  diffs.push(rel)
  if (!CHECK_ONLY) {
    mkdirSync(dirname(b), { recursive: true })
    copyFileSync(a, b)
    copied += 1
  }
}

// 反向检查：插件目录里有但项目里没有的文件（提醒用，不自动删）
const dstOnly = collect(DST).filter((rel) => !files.includes(rel))

console.log(`源：${SRC}`)
console.log(`目标：${DST}`)
console.log(`文件总数：${files.length}｜一致：${same}｜${CHECK_ONLY ? '待同步' : '已同步'}：${diffs.length}`)
if (diffs.length > 0 && diffs.length <= 20) for (const d of diffs) console.log(`  ${CHECK_ONLY ? '差异' : '复制'}  ${d}`)
if (diffs.length > 20) console.log(`  （差异过多，仅列前 20 条；共 ${diffs.length}）`)
if (copied > 0) console.log(`\n✓ 已同步 ${copied} 个文件到插件目录 —— 需要重启 DSH 才生效（或让 DSH 自己重载）`)
if (dstOnly.length > 0 && dstOnly.length <= 10) console.log(`\n注意：插件目录里这些文件项目里没有（未自动删除）：\n  ${dstOnly.join('\n  ')}`)
if (CHECK_ONLY && diffs.length > 0) process.exit(1)
void statSync
