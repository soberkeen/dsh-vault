#!/usr/bin/env node
/**
 * probe-client-in-graph.mjs — 判定本插件是否进了「浏览器启动图」
 *
 * 为什么需要：client 半边（设置页面板）是否被加载，**与 host 半边是否装配**是两件事；
 * 而 GUI 需要进程级 launch token 才能访问（无 cookie 时 GET / 一律 401，Playwright 亦然），
 * 所以不能靠抓首页看 window.__DSH_BOOT__。可用的判据是 dsh-client-modules 的
 * **artifact revision 复现**：
 *
 *   rev = sha1("plugin-artifact\0" + "<len>:<mtimeMs>" + "<len>:<ctimeMs>" + "<len>:<size>").slice(0,12)
 *   （len = Buffer.byteLength(part)；算法见 dsh-client-modules/lib/index.js 的
 *     artifactRevision / framedHash / graphRow / bundleResource）
 *
 * 然后请求**单行 combo URL**：
 *   GET /plugins/??<pkgName>/client.js&rev=<rev>
 *   200 = 该包已在宿主启动图里（dsh.client 被采纳，bundle 已提供）
 *   404 = 不在图里（loader entry 缺失，或 dsh.client 解析被跳过）
 *
 * ⚠️ 必须用 combo 形态（`??<name>/client.js&rev=`）；`/plugins/<name>/client.js?rev=`
 *    永远 404 —— 这个坑在排查中已被验证过，别用它下结论。
 *
 * 用法：
 *   node scripts/probe-client-in-graph.mjs                      # 默认探自己 + 两个参照
 *   node scripts/probe-client-in-graph.mjs --base http://127.0.0.1:19387
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SELF = join(HERE, '..', 'package.json')
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const NM = join(DSH_HOME, 'profiles', 'desktop', 'node_modules')
const BASE = (process.argv.includes('--base') ? process.argv[process.argv.indexOf('--base') + 1] : null) ?? 'http://127.0.0.1:19387'

/** 只读参照样本：这两个的 client 半边是确认能工作的（面板都正常显示）。 */
const REFS = [
  join(NM, '@michengai', 'dsh-skills-manager', 'package.json'),
  join(NM, 'dsh-better-sidebar', 'package.json'),
]

const framedHash = (domain, parts) => {
  const h = createHash('sha1').update(domain).update('\0')
  for (const p of parts) h.update(`${String(Buffer.byteLength(p))}:`).update(p)
  return h.digest('hex').slice(0, 12)
}

async function probe(pkgJson) {
  if (!existsSync(pkgJson)) return { name: pkgJson, skip: true }
  const pkg = JSON.parse(readFileSync(pkgJson, 'utf8'))
  const relExport = pkg.exports?.['./client']
  const clientRel = typeof relExport === 'string' ? relExport : relExport?.default
  if (!clientRel) return { name: pkg.name, skip: true, why: '无 exports["./client"]' }
  const clientPath = join(dirname(pkgJson), clientRel)
  if (!existsSync(clientPath)) return { name: pkg.name, skip: true, why: `client 文件不存在：${clientRel}` }
  const st = statSync(clientPath)
  const rev = framedHash('plugin-artifact', [String(st.mtimeMs), String(st.ctimeMs), String(st.size)])
  const url = `${BASE}/plugins/??${pkg.name}/client.js&rev=${rev}`
  let status = 0
  let len = 0
  try {
    const r = await fetch(url)
    status = r.status
    len = (await r.text()).length
  } catch (e) {
    return { name: pkg.name, rev, status: -1, err: String(e?.message ?? e).slice(0, 80) }
  }
  return { name: pkg.name, rev, status, len, url }
}

const rows = []
rows.push(await probe(SELF))
for (const r of REFS) rows.push(await probe(r))

console.log(`探测 ${BASE} 的浏览器启动图（dsh-client-modules revision 复现）\n`)
let selfOk = null
for (const r of rows) {
  if (r.skip) { console.log(`  ——  ${r.name}（跳过：${r.why ?? '无 client 半边'}）`); continue }
  const verdict = r.status === 200 ? '✓ 在图里' : r.status === 404 ? '✗ 不在图里' : `? HTTP ${r.status}${r.err ? ` ${r.err}` : ''}`
  console.log(`  ${r.status === 200 ? '✓' : '✗'} ${verdict.padEnd(12)} len=${String(r.len).padStart(7)}  rev=${r.rev}  ${r.name}`)
  if (r.name === '@dsh-external/dsh-vault') selfOk = r.status === 200
}

console.log('')
if (selfOk === true) {
  console.log('结论：✅ dsh-vault 的 client 半边已进启动图 —— 开「设置」应能看到「备份」分区。')
  console.log('      若分区仍异常，看 DevTools console（cordis 的 without inject / SlotAssemblyError / entry error）。')
} else if (selfOk === false) {
  console.log('结论：❌ dsh-vault 不在启动图里 —— client 半边不会被加载。')
  console.log('      先查 host 侧装配：node scripts/health-check.mjs（看「有可用装配路径」与「host 侧插件在运行」）。')
  console.log('      装配来源排查：包内 cordis.patch.yml 必须是 - insert: [{id, name}] 形式，空列表 = 不装配。')
} else {
  console.log('结论：? host 未响应或本包无 client 半边，无法判定。')
}
process.exitCode = selfOk === true ? 0 : 1
