#!/usr/bin/env node
/**
 * targets-test.mjs — 备份目标与推送验收（本地 / 网络路径 / WebDAV）
 *
 * 验证：
 *   1 本地/网络路径推送：文件到位且大小一致
 *   2 **真 WebDAV 推送**：起一个最小 WebDAV 服务器（MKCOL + Basic Auth + PUT），
 *     断言目录被创建、文件字节级一致（比对 sha256）
 *   3 凭据不落明文：保存后文件里只有 `dpapi:` 密文，读取时能还原
 *   4 目标不可达：返回 ok:false + 错误信息（**不抛异常**，不阻断备份）
 *   5 多目标独立：一个成功一个失败，各自结果正确
 *
 * 用法：node scripts/targets-test.mjs
 */
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { loadTargets, pushToTarget, pushToTargets, saveTargets } from '../lib/vault/targets.js'

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16)

const root = mkdtempSync(join(tmpdir(), 'vault-targets-'))
const uploadRoot = join(root, 'dav-uploads')
const srcDir = join(root, 'src')
mkdirSync(srcDir, { recursive: true })
const fileA = join(srcDir, 'DSHVAULT_TEST_p01.vault')
const fileB = join(srcDir, 'DSHVAULT_TEST.manifest.json')
writeFileSync(fileA, Buffer.alloc(64 * 1024, 7))
writeFileSync(fileB, JSON.stringify({ hello: 'world', n: 42 }), 'utf8')

// ── 最小 WebDAV 服务器（MKCOL + Basic Auth + PUT）──────────────────────────
const davLog = []
const DAV_USER = 'nasuser'
const DAV_PASS = 'Nas#Pass2026'
const expectedAuth = 'Basic ' + Buffer.from(`${DAV_USER}:${DAV_PASS}`, 'utf8').toString('base64')
const server = createServer((req, res) => {
  const p = decodeURIComponent((req.url ?? '/').split('?')[0])
  if (req.headers.authorization !== expectedAuth) { res.writeHead(401); return res.end('unauthorized') }
  if (req.method === 'MKCOL') { davLog.push(['MKCOL', p]); res.writeHead(201); return res.end() }
  if (req.method === 'PUT') {
    // 桩服务器挂在 /dav/ 前缀下（模拟 NAS 的 WebDAV 挂载点）→ 落盘前先扣掉该前缀
    const dest = join(uploadRoot, p.replace(/^\/dav\/?/, '').replace(/^\/+/, ''))
    mkdirSync(dirname(dest), { recursive: true })
    const ws = createWriteStream(dest)
    let n = 0
    req.on('data', (c) => { n += c.length; ws.write(c) })
    req.on('end', () => ws.end(() => { davLog.push(['PUT', p, n]); res.writeHead(201); res.end() }))
    return
  }
  res.writeHead(404); res.end('nope')
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const davUrl = `http://127.0.0.1:${port}/dav/`

try {
  // ── 1 本地/网络路径推送 ──────────────────────────────────────────────────
  const localDest = join(root, 'nas-like-dir')
  const r1 = await pushToTarget({ name: '本地', type: 'unc', dir: localDest }, [fileA, fileB])
  check('1 路径型目标：文件到位且大小一致',
    r1.ok && r1.sent.length === 2 && statSync(join(localDest, 'DSHVAULT_TEST_p01.vault')).size === 64 * 1024,
    `sent=${r1.sent.length} err=${r1.errors.join('；') || '无'}`)

  // ── 2 真 WebDAV 推送 ────────────────────────────────────────────────────
  const r2 = await pushToTarget({
    name: 'NAS-WebDAV', type: 'webdav', url: davUrl, user: DAV_USER, secret: DAV_PASS, remoteDir: 'DSH-Backup/sub',
  }, [fileA, fileB])
  const upA = join(uploadRoot, 'DSH-Backup/sub/DSHVAULT_TEST_p01.vault')
  const upB = join(uploadRoot, 'DSH-Backup/sub/DSHVAULT_TEST.manifest.json')
  check('2 WebDAV：MKCOL 建目录 + PUT 上传成功', r2.ok && existsSync(upA) && existsSync(upB),
    `sent=${r2.sent.length}｜MKCOL=${davLog.filter((x) => x[0] === 'MKCOL').map((x) => x[1]).join(' ')}`)
  check('3 上传内容字节级一致（sha256 相同）',
    existsSync(upA) && sha(upA) === sha(fileA) && sha(upB) === sha(fileB),
    `vault ${sha(fileA)} vs ${existsSync(upA) ? sha(upA) : '-'}｜manifest ${sha(fileB)} vs ${existsSync(upB) ? sha(upB) : '-'}`)

  // ── 3 凭据不落明文 ──────────────────────────────────────────────────────
  const stateDir = join(root, 'state')
  const saved = saveTargets(stateDir, [{
    name: 'NAS-WebDAV', type: 'webdav', url: davUrl, user: DAV_USER, secret: DAV_PASS, remoteDir: 'DSH-Backup',
  }])
  const raw = readFileSync(saved.path, 'utf8')
  const noPlain = !raw.includes(DAV_PASS)
  const loaded = loadTargets(stateDir)
  check('4 凭据不落明文（DPAPI 密文）+ 能还原',
    noPlain && loaded.targets[0].secret === DAV_PASS && raw.includes('dpapi:'),
    `文件含明文=${!noPlain}｜加密标志=${saved.encrypted}｜还原密码一致=${loaded.targets[0].secret === DAV_PASS}`)

  // ── 4 目标不可达：不抛异常、返回错误 ────────────────────────────────────
  const r4 = await pushToTarget({ name: '死目标', type: 'webdav', url: 'http://127.0.0.1:1/dav/', user: 'x', secret: 'y' }, [fileA])
  check('5 目标不可达 → ok:false + 错误信息（不抛异常）',
    r4.ok === false && r4.errors.length > 0, `${r4.errors[0]?.slice(0, 70)}`)

  // ── 5 多目标独立 ────────────────────────────────────────────────────────
  const multi = await pushToTargets([
    { name: '好目标', type: 'unc', dir: join(root, 'ok-dir') },
    { name: '坏目标', type: 'webdav', url: 'http://127.0.0.1:1/dav/', user: 'x', secret: 'y' },
  ], [fileA])
  check('6 多目标独立：好的成功、坏的报错，互不影响',
    multi.length === 2 && multi[0].ok === true && multi[1].ok === false,
    multi.map((m) => `${m.target}:${m.ok ? 'ok' : 'fail'}`).join(' '))

  // ── 6 只推「包 + 索引 + 恢复码」这一组文件 ──────────────────────────────
  const group = readdirSync(srcDir).map((f) => join(srcDir, f))
  const r6 = await pushToTarget({ name: '组推', type: 'unc', dir: join(root, 'group-dir') }, group)
  check('7 按组推送（多个文件一次送齐）', r6.ok && r6.sent.length === group.length, `sent=${r6.sent.length}/${group.length}`)
} catch (e) {
  check('目标推送用例执行', false, String(e?.message ?? e))
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
