#!/usr/bin/env node
/**
 * health-check.mjs — dsh-vault 装态自检（一条命令看清全部）
 *
 * 解决「用户不知道怎么看输出」：跑这一个脚本，它自己去问 host、查日志、比版本，
 * 最后给一句结论（就绪 / 缺什么 / 下一步做什么）。
 *
 * 用法：node scripts/health-check.mjs   （可选 --base http://127.0.0.1:19387）
 */
import { createRequire } from 'node:module'
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = join(HERE, '..')
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const PROFILE = join(DSH_HOME, 'profiles', 'desktop')
const BASE = (process.argv.includes('--base') ? process.argv[process.argv.indexOf('--base') + 1] : null) ?? 'http://127.0.0.1:19387'
const API = `${BASE}/@dsh-external/dsh-vault/api`

const rows = []
const row = (name, ok, detail) => { rows.push({ name, ok, detail }); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `  — ${detail}` : ''}`) }

async function getJson(url, ms = 8000) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), ms)
  try {
    const r = await fetch(url, { signal: ctrl.signal })
    const text = await r.text()
    let j = null
    try { j = JSON.parse(text) } catch { /* 非 JSON */ }
    return { status: r.status, json: j, text }
  } catch (e) {
    return { status: 0, error: String(e?.message ?? e) }
  } finally { clearTimeout(t) }
}

console.log(`dsh-vault 装态自检 ｜ ${new Date().toLocaleString('zh-CN')}\n`)

// ── 1) 本地文件层 ──────────────────────────────────────────────────────────
const pkgPath = join(PLUGIN_DIR, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
row('插件包存在', existsSync(join(PLUGIN_DIR, 'lib', 'index.js')), `${pkg.name} v${pkg.version}`)
try {
  const req = createRequire(join(PROFILE, 'package.json'))
  const resolved = req.resolve('@dsh-external/dsh-vault')
  row('profile 能解析到包', true, resolved.replace(/\\/g, '/').split('/lib/')[0])
} catch (e) { row('profile 能解析到包', false, String(e?.message ?? e).slice(0, 80)) }

// ── 2) 装配声明（bundles / patch 双路径）──────────────────────────────────
// ⚠️ 本地 link 插件的**真正装配来源**：包必须住在 ~/.dsh/plugins-desk-v1/ 下（或其 junction）。
// 2026-10-16 实测：purge / shield / super-injector 都在那个目录且都能装配；而只在
// profile 的 deps/bundles 里声明、包本体留在别处（如项目目录），重启后**不会**装配。
const pluginDirLink = join(DSH_HOME, 'plugins-desk-v1', '@dsh-external', 'dsh-vault')
const inPluginDir = existsSync(join(pluginDirLink, 'lib', 'index.js'))
row('包在 DSH 插件目录 plugins-desk-v1 下（真正的装配来源）', inPluginDir,
  inPluginDir
    ? '~/.dsh/plugins-desk-v1/@dsh-external/dsh-vault'
    : '✗ 不在！只在 deps/bundles 里声明不够 —— 本地插件必须住在这个目录')

// 必须是**实体目录**：2026-10-16 实测，用跨盘 junction 时 pnpm 会把该依赖剔除 →
// 装配失败 → DSH 永远提示"需要重启"（死循环）。purge / super-injector 都是实体目录。
let isRealDir = false
try {
  const st = lstatSync(pluginDirLink)   // lstat 不跟随链接：junction 会显示为 symbolic link
  isRealDir = st.isDirectory() && !st.isSymbolicLink()
} catch { /* 忽略 */ }
row('插件目录是实体目录（junction 会被 pnpm 剔除）', isRealDir,
  isRealDir ? '实体目录 ✓（与 purge / super-injector 一致）' : '⚠️ 是链接/junction → pnpm 安装时会剔除该依赖，导致永远"提示重启"')

// 运行副本是否与项目源码同步（实体复制后靠 sync-to-plugin-dir.mjs 保持一致）
let syncOk = null
let syncDetail = ''
try {
  const crypto = await import('node:crypto')
  const h = (p) => crypto.createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 12)
  const files = ['lib/index.js', 'lib/client.js', 'lib/vault/targets.js', 'package.json']
  const diff = files.filter((f) => h(join(PLUGIN_DIR, f)) !== h(join(pluginDirLink, f)))
  syncOk = diff.length === 0
  syncDetail = syncOk ? '项目与插件目录一致（4 个关键文件 sha256 相同）'
    : `不一致：${diff.join(', ')} → 跑 node scripts/sync-to-plugin-dir.mjs`
} catch (e) { syncOk = false; syncDetail = String(e?.message ?? e).slice(0, 80) }
row('运行副本与项目源码同步', syncOk, syncDetail)

const profPkg = JSON.parse(readFileSync(join(PROFILE, 'package.json'), 'utf8'))
const inBundles = (profPkg.dsh?.profile?.bundles ?? []).includes(pkg.name)
let patchHas = false
try {
  const patch = readFileSync(join(PROFILE, 'cordis.patch.yml'), 'utf8')
  patchHas = /^-\s*id:\s*dsh-vault/m.test(patch) && /name:\s*'@dsh-external\/dsh-vault'/.test(patch)
} catch { /* 无 patch */ }
// 装配路径：两条任选其一即可 ——
//   ① bundles 列表 + package.json 里的 dsh.bundle 声明（2026-10-16 起的正解，
//      走正常装配，UI 半边会被 client-modules 收录）
//   ② profile 的 cordis.patch.yml 根列表里插一行（历史方案；与 ① 同用会出现 duplicate id）
const bundleReady = inBundles && Boolean(pkg.dsh?.bundle?.patch)
row('有可用装配路径（bundles+dsh.bundle 或 patch 行）', patchHas || bundleReady,
  patchHas ? 'patch 根列表里有 dsh-vault'
    : bundleReady ? 'bundles 列表 ✓ + dsh.bundle 声明 ✓（DSH 会当 bundle 装配）'
      : '两条路径都没有 —— 重启后不会装配')

// 装配来源：patch/bundles（正常装配，UI 半边会被收录）优于注入器 registry（[injected] 装配）
// —— 2026-10-16 实测：super-injector/registry.json 里的插件都以 [injected] 装配，UI 半边不出现
let inInjectorRegistry = false
try {
  const reg = JSON.parse(readFileSync(join(DSH_HOME, 'super-injector', 'registry.json'), 'utf8'))
  inInjectorRegistry = (Array.isArray(reg) ? reg : []).some((x) => x?.name === pkg.name)
} catch { /* 无 registry 文件 */ }
row('装配来源干净（不在注入器清单里）', !inInjectorRegistry,
  inInjectorRegistry
    ? '⚠️ 仍在 super-injector/registry.json 里 → 会以 [injected] 装配，UI 半边可能不被收录'
    : '走 bundles/patch 正常装配（UI 半边会被收录）')

// ── 3) client 半边声明是否规范 ────────────────────────────────────────────
// dsh.bundle：DSH 靠它判定"这个包是 bundle、可以装配"。缺了就只能靠运行时注入
// （2026-10-16 实测：摘掉注入清单后重启 → /api 全 404，因为没装配）
const bundlePatch = pkg.dsh?.bundle?.patch
row('dsh.bundle 声明存在（DSH 才当 bundle 装配）',
  Boolean(bundlePatch) && existsSync(join(PLUGIN_DIR, bundlePatch)),
  bundlePatch ? `patch=${bundlePatch}` : '缺！DSH 不会把它当 bundle 装配（只能靠运行时注入）')

const dc = pkg.dsh?.client ?? {}
const hasEntry = Object.hasOwn(dc, 'entry')
row('client 声明规范（不写非标准 entry）', !hasEntry,
  hasEntry ? `⚠️ 写了 entry=${dc.entry}（生态里没人写，会导致 client 半边不加载）` : `inject=[${(dc.inject ?? []).join(', ')}]`)
row('exports["./client"] 存在', Boolean(pkg.exports?.['./client']), String(pkg.exports?.['./client'] ?? '缺失'))

// ── 4) host 运行态 ─────────────────────────────────────────────────────────
const h = await getJson(`${API}/health`)
if (h.status === 200 && h.json?.ok) {
  row('host 侧插件在运行', true, `version=${h.json.version} outDir=${h.json.outDir} 工作区 ${h.json.workspaces?.length ?? 0} 个`)
  row('运行版本与文件版本一致', h.json.version === pkg.version,
    h.json.version === pkg.version ? `都是 ${pkg.version}` : `运行 ${h.json.version} ≠ 文件 ${pkg.version}（host 未重载，需重启）`)
} else {
  row('host 侧插件在运行', false, `HTTP ${h.status}${h.error ? ` ${h.error}` : ''}`)
}
const l = await getJson(`${API}/list`)
row('备份包枚举可用', l.status === 200 && l.json?.ok, l.json ? `发现 ${l.json.count} 个包（${l.json.totalSize}）` : `HTTP ${l.status}`)
const t = await getJson(`${API}/targets`)
row('远端目标 API 可用', t.status === 200 && t.json?.ok, t.json ? `targets.json ${t.json.exists ? '已存在' : '尚未创建'}，目标 ${t.json.targets?.length ?? 0} 个` : `HTTP ${t.status}`)

// ── 5) 宿主日志 ───────────────────────────────────────────────────────────
const logFile = join(DSH_HOME, 'plugin-data', 'dsh-vault', 'vault.log')
if (existsSync(logFile)) {
  const lines = readFileSync(logFile, 'utf8').trim().split('\n')
  const last = lines[lines.length - 1] ?? ''
  const m = /^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]/.exec(last)
  const at = m ? new Date(m[1]) : null
  const mins = at ? Math.round((Date.now() - at.getTime()) / 60000) : null
  row('插件日志有加载记录', Boolean(at), at ? `最后一次 apply 于 ${at.toLocaleString('zh-CN')}（${mins} 分钟前）` : last.slice(0, 80))
} else {
  row('插件日志有加载记录', false, `无 ${logFile}`)
}

// ── 结论 ──────────────────────────────────────────────────────────────────
const bad = rows.filter((r) => !r.ok)
console.log('')
if (bad.length === 0) {
  console.log('结论：✅ 全部就绪。')
  console.log('     面板在【设置】页左栏（分区名「备份」；五个标签页：一键备份 / 计划 / 目标 / 历史 / 设置）；')
  console.log('     6 个工具（vault_scan / vault_backup / vault_list / vault_verify / vault_restore / vault_prune）在新会话里可用。')
} else {
  console.log(`结论：❌ ${bad.length} 项未就绪 ——`)
  for (const b of bad) console.log(`     · ${b.name}：${b.detail}`)
  if (bad.some((b) => b.name.includes('client 声明'))) {
    console.log('     处理：修 package.json 的 dsh.client（去掉 entry）→ 重启 DSH。')
  } else if (bad.some((b) => b.name.includes('host 侧'))) {
    console.log('     处理：检查 patch 层是否含本插件 → 重启 DSH。')
  }
}
// ⚠️ 不用 process.exit()：fetch 的 keep-alive 句柄未关时强制退出会触发 libuv 断言
// （Windows 上表现为 exit=-1073740791）。设 exitCode 让 Node 自然退出。
process.exitCode = bad.length === 0 ? 0 : 1
