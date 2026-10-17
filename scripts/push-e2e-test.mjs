#!/usr/bin/env node
/**
 * push-e2e-test.mjs — 端到端：一次真实备份 + 推送到 WebDAV（接线验证）
 *
 * 与 targets-test.mjs 的区别：这里走**完整链路**
 *   起桩 WebDAV → 写 targets.json（凭据 DPAPI 加密）→ spawn core-drop.mjs --push →
 *   断言包与索引真的上传到"NAS"目录，且本地主副本仍在。
 *
 * 用临时 DSH_HOME（不碰真实 ~/.dsh），跑完即清。
 *
 * 用法：node scripts/push-e2e-test.mjs
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { saveTargets } from '../lib/vault/targets.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const CORE_DROP = join(HERE, 'core-drop.mjs')

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16)

const root = mkdtempSync(join(tmpdir(), 'vault-push-e2e-'))
const fakeHome = join(root, 'home')                 // 假 DSH_HOME → 假 stateDir
const outDir = join(root, 'local-out')              // 本地主副本
const uploadRoot = join(root, 'nas-uploads')        // "NAS" 侧
mkdirSync(join(fakeHome, 'sessions'), { recursive: true })
writeFileSync(join(fakeHome, 'config.json'), '{"e2e":1}', 'utf8')
mkdirSync(join(fakeHome, 'skills'), { recursive: true })
writeFileSync(join(fakeHome, 'skills', 'demo.md'), '# demo\n', 'utf8')

// ── 桩 WebDAV ──────────────────────────────────────────────────────────────
const DAV_USER = 'nasuser'
const DAV_PASS = 'Nas#Pass2026'
const auth = 'Basic ' + Buffer.from(`${DAV_USER}:${DAV_PASS}`, 'utf8').toString('base64')
const davLog = []
const server = createServer((req, res) => {
  const p = decodeURIComponent((req.url ?? '/').split('?')[0])
  if (req.headers.authorization !== auth) { res.writeHead(401); return res.end('unauthorized') }
  if (req.method === 'MKCOL') { davLog.push(['MKCOL', p]); res.writeHead(201); return res.end() }
  if (req.method === 'PUT') {
    const dest = join(uploadRoot, p.replace(/^\/dav\/?/, '').replace(/^\/+/, ''))
    mkdirSync(dirname(dest), { recursive: true })
    const ws = createWriteStream(dest)
    req.on('data', (c) => ws.write(c))
    req.on('end', () => ws.end(() => { davLog.push(['PUT', p]); res.writeHead(201); res.end() }))
    return
  }
  res.writeHead(404); res.end('nope')
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const davUrl = `http://127.0.0.1:${server.address().port}/dav/`

try {
  // ── 写目标配置（凭据走 DPAPI）；stateDir 在假 DSH_HOME 下 ────────────────
  const stateDir = join(fakeHome, 'plugin-data', 'dsh-vault')
  const saved = saveTargets(stateDir, [
    { name: 'NAS-Test', type: 'webdav', url: davUrl, user: DAV_USER, secret: DAV_PASS, remoteDir: 'DSH-Backup' },
  ])
  check('1 目标配置写入（凭据 DPAPI 加密，不含明文密码）',
    saved.encrypted && !readFileSync(saved.path, 'utf8').includes(DAV_PASS),
    `file=${saved.path.split('\\').pop()} encrypted=${saved.encrypted}`)

  // ── 跑一次真实备份 + 推送 ────────────────────────────────────────────────
  // ⚠️ 必须用**异步** spawn：用 spawnSync 会冻结父进程的事件循环，
  // 桩 WebDAV 服务器就无法响应子进程的请求（会一路等到 120s 超时）—— 本次实测踩到。
  const r = await new Promise((resolve) => {
    const child = spawn(process.execPath, [
      CORE_DROP, '--out', outDir, '--scope', 'core', '--only', '05-plugins',
      '--password', 'E2e#Pass2026', '--push', 'NAS-Test',
    ], { env: { ...process.env, DSH_HOME: fakeHome } })
    let out = ''
    let err = ''
    child.stdout.on('data', (c) => { out += c })
    child.stderr.on('data', (c) => { err += c })
    child.on('close', (code) => resolve({ status: code, stdout: out, stderr: err }))
  })

  const stdout = String(r.stdout ?? '')
  const stderr = String(r.stderr ?? '')
  check('2 core-drop 执行成功', r.status === 0, `exit=${r.status}｜${stderr.split('\n').filter(Boolean).slice(-1)[0] ?? ''}`)
  check('3 日志里出现"推送目标：NAS-Test(webdav)"与"推送成功"',
    /推送目标：NAS-Test/.test(stdout) && /推送成功：NAS-Test/.test(stdout),
    stdout.split('\n').filter((l) => l.includes('推送')).slice(0, 2).join(' ｜ '))

  // ── 断言：本地主副本 + NAS 侧都拿到包与索引 ──────────────────────────────
  const localFiles = existsSync(outDir) ? readdirSync(outDir).filter((f) => f.endsWith('.vault') || f.endsWith('.manifest.json')) : []
  const nasFiles = existsSync(uploadRoot) ? readdirSync(join(uploadRoot, 'DSH-Backup')) : []
  check('4 本地主副本存在（包 + 索引）', localFiles.length >= 2, `本地：${localFiles.join(', ')}`)
  check('5 NAS 侧（WebDAV）拿到同样的文件',
    nasFiles.filter((f) => f.endsWith('.vault')).length >= 1 && nasFiles.some((f) => f.endsWith('.manifest.json')),
    `NAS：${nasFiles.join(', ')}`)

  const localVault = localFiles.find((f) => f.endsWith('.vault'))
  const nasVault = nasFiles.find((f) => f.endsWith('.vault'))
  check('6 上传内容与本地字节级一致（sha256 相同）',
    localVault && nasVault && sha(join(outDir, localVault)) === sha(join(uploadRoot, 'DSH-Backup', nasVault)),
    `${localVault}：本地 ${localVault ? sha(join(outDir, localVault)) : '-'} vs NAS ${nasVault ? sha(join(uploadRoot, 'DSH-Backup', nasVault)) : '-'}`)

  // ── manifest 里应记录推送结果 ────────────────────────────────────────────
  const manifest = JSON.parse(readFileSync(join(outDir, localFiles.find((f) => f.endsWith('.manifest.json'))), 'utf8'))
  check('7 manifest.pushTargets 记录了推送结果',
    Array.isArray(manifest.pushTargets) && manifest.pushTargets[0]?.ok === true,
    JSON.stringify(manifest.pushTargets?.[0] ?? null))

  const nasSize = nasVault ? statSync(join(uploadRoot, 'DSH-Backup', nasVault)).size : 0
  console.log(`\n（NAS 侧体积：${(nasSize / 1024).toFixed(1)} KB｜MKCOL：${davLog.filter((x) => x[0] === 'MKCOL').map((x) => x[1]).join(' ')}）`)
  void spawn
} catch (e) {
  check('端到端推送用例执行', false, String(e?.message ?? e))
} finally {
  await new Promise((r) => server.close(r))
}

try { rmSync(root, { recursive: true, force: true }) } catch { /* 忽略 */ }

const failed = results.filter((x) => !x.ok)
console.log('')
console.log(`=== ${results.length - failed.length}/${results.length} 通过 ===`)
if (failed.length > 0) {
  for (const f of failed) console.log(`  失败: ${f.name} — ${f.detail}`)
  process.exit(1)
}
