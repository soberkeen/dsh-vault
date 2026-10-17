/**
 * server.js — dsh-vault host 侧 HTTP API（单前缀路由对象，零编译零依赖）
 *
 * 设计依据：AGENT.md / ADR-011
 *   - 通道：单前缀路由 API_PREFIX，内部按剩余 path 手工分发
 *   - 端点在 node http 的 (req, res) 上实现，只 import node: 内置 + lib/vault/* 纯函数层
 *   - 长任务（scan/backup/verify/restore/prune）= 内存 job（Map）+ 进度日志数组 + client 2s 轮询
 *   - 写操作默认 dry-run，需请求体带 {"confirm": true} 才真执行
 *   - 逻辑单源：全部复用 lib/vault/* 既有导出，不在本文件重写业务逻辑
 *
 * 路由注册形态（照抄本机既有实现 dsh-super-injector/lib/index.js:9629-9631）：
 *   ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path, handler }), label)
 *   其中 handler: (req, res) => void|Promise<void>，req/res 为 node 原生对象。
 *
 * 端点（ADR-011）：
 *   GET  /health         运行环境与配置快照（零副作用）
 *   POST /scan           扫描 + 分层预览（零副作用；走 job 以便前端看进度）
 *   POST /backup         备份（默认 dry-run；confirm:true 才真写包）
 *   GET  /list           历史备份包（按逻辑包聚合多卷）
 *   POST /verify         校验包完整性（只读，直接执行）
 *   POST /restore        还原（默认 dry-run = 只列包信息；confirm:true 才解包/原位还原）
 *   POST /prune          滚动保留（默认 dry-run = 出删除清单；confirm:true 才执行）
 *   GET  /jobs/:id       job 状态与进度日志（2s 轮询目标）
 */
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { stateDir } from './vault/paths.js'
import { loadTargets, normalizeTarget, saveTargets, testTarget } from './vault/targets.js'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { human, isoNow, readJsonSafe } from './vault/io.js'
import { dshHome, findDshInstall, discoverWorkspaces } from './vault/paths.js'
import { scanPlan } from './vault/scan.js'
import { runBackup } from './vault/pack.js'
import { DEFAULT_POLICY, applyRetention, groupVaults, listVaults, planRetention } from './vault/policy.js'

/** 面板数据通道前缀（client 侧 fetch 同源调用）。 */
export const API_PREFIX = '/@soberkeen/dsh-vault/api'

const HERE = dirname(fileURLToPath(import.meta.url))
const RESTORE_CLI = join(HERE, 'vault', 'portable-restore.mjs')
const DEFAULT_OUT_DIR = 'G:\\DSH-Backup'
const MAX_JOBS = 40
const MAX_LOGS = 400
const MAX_BODY_BYTES = 1024 * 1024

/** 读插件自身 package.json（版本号展示用；读不到不阻塞）。 */
function pkgVersion() {
  const pkg = readJsonSafe(join(HERE, '..', 'package.json'), null)
  return pkg && typeof pkg.version === 'string' ? pkg.version : '0.0.0'
}

/** 还原器 CLI 调用（与 lib/index.js 的 runNode 同形态：execPath + 单文件 mjs）。 */
function runNode(args, extraEnv = {}) {
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    const child = spawn(process.execPath, [RESTORE_CLI, ...args], { windowsHide: true, env: { ...process.env, ...extraEnv } })
    child.stdout.on('data', (c) => { out += String(c) })
    child.stderr.on('data', (c) => { err += String(c) })
    child.on('error', (e) => resolve({ code: -1, out, err: String(e) }))
    child.on('close', (code) => resolve({ code, out, err }))
  })
}

function sendJson(res, code, obj) {
  let text
  try {
    text = JSON.stringify(obj, null, 2)
  } catch {
    text = JSON.stringify({ ok: false, error: 'response not serializable' })
  }
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const c of req) {
    const buf = Buffer.from(c)
    size += buf.length
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大（>1MB）')
    chunks.push(buf)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return {}
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

/**
 * 创建面板 API 对象。
 * @param {object} ctx cordis 上下文（仅用于日志兜底；路由注册由调用方负责）
 * @param {object} config { dshHome, outDir, password, log }
 * @returns {{ prefix: string, handle: (req: any, res: any) => Promise<void>, jobs: Map<string, object> }}
 */
export function createApi(ctx, config = {}) {
  const home = config.dshHome || dshHome()
  const outDir = config.outDir || process.env.DSHVAULT_OUT_DIR || DEFAULT_OUT_DIR
  const version = pkgVersion()
  const apiLog = typeof config.log === 'function' ? config.log : () => {}
  /** job 表：内存 Map（进程内），超出上限淘汰最老的一条。 */
  const jobs = new Map()
  let seq = 0

  const resolvePassword = (given) => (
    (typeof given === 'string' && given.trim()) ? given.trim() : (process.env.DSHVAULT_PASSWORD || config.password || null)
  )

  /** 启动一个 job：立即返回句柄，runner 异步跑，进度写 job.logs。 */
  function startJob(kind, dryRun, runner) {
    const id = `j${++seq}-${Date.now().toString(36)}`
    const job = {
      id,
      kind,
      dryRun: dryRun === true,
      status: 'running',
      startedAt: isoNow(),
      endedAt: null,
      seconds: null,
      logs: [],
      result: null,
      error: null,
    }
    jobs.set(id, job)
    while (jobs.size > MAX_JOBS) {
      const oldest = jobs.keys().next().value
      jobs.delete(oldest)
    }
    const log = (msg) => {
      const line = `[${new Date().toISOString().slice(11, 19)}] ${String(msg)}`
      job.logs.push(line)
      if (job.logs.length > MAX_LOGS) job.logs.splice(0, job.logs.length - MAX_LOGS)
      try { apiLog(`${kind}#${id} ${msg}`) } catch { /* 日志失败静默 */ }
    }
    const t0 = Date.now()
    log(`start kind=${kind} dryRun=${dryRun === true}`)
    Promise.resolve()
      .then(() => runner(log))
      .then((result) => {
        job.result = result ?? null
        job.status = 'done'
        log('完成')
      })
      .catch((e) => {
        job.error = String((e && e.message) ? e.message : e)
        job.status = 'failed'
        log(`失败：${job.error}`)
      })
      .finally(() => {
        job.endedAt = isoNow()
        job.seconds = Math.round((Date.now() - t0) / 100) / 10
      })
    return job
  }

  /** job 视图（不回传密码等敏感输入；logs 截尾）。 */
  function jobView(job, { tail = 200 } = {}) {
    if (!job) return null
    // ⚠️ 恢复码 / 自动生成的密码是「仅此一次」的（GLM-5.3 审查 S-E，已核实为真）：
    // 原实现每次都把 job.result 原样回传，而 job 留在内存 Map（MAX_JOBS=40）→ 任何后续同源
    // 请求 GET /jobs/:id 都能再读到，承诺不成立。改为「读过即抹」：明文只在首次视图出现，
    // 之后只留标志位（面板仍能提示"已生成过恢复码"）。
    let result = job.result
    if (result && (result.recoveryCode || result.generatedPassword)) {
      if (job.secretDelivered === true) {
        const { recoveryCode: _rc, generatedPassword: _gp, ...rest } = result
        result = { ...rest, hasRecoveryCode: true, secretNote: '明文仅首次显示（已抹除；需要再取请重新打包）' }
      } else {
        job.secretDelivered = true
      }
    }
    return {
      id: job.id,
      kind: job.kind,
      dryRun: job.dryRun,
      status: job.status,
      startedAt: job.startedAt,
      endedAt: job.endedAt,
      seconds: job.seconds,
      logs: job.logs.slice(-tail),
      result,
      error: job.error,
    }
  }

  function health() {
    const install = findDshInstall()
    const ws = discoverWorkspaces(home)
    return {
      ok: true,
      name: '@soberkeen/dsh-vault',
      version,
      api: API_PREFIX,
      dshHome: home,
      outDir,
      install: { root: install.root, version: install.version },
      workspaces: ws.map((w) => ({ name: w.name, path: w.path })),
      hasPassword: !!resolvePassword(null),
      policy: DEFAULT_POLICY,
      restoreCli: existsSync(RESTORE_CLI),
      jobs: [...jobs.values()].slice(-10).map((j) => ({ id: j.id, kind: j.kind, status: j.status })),
    }
  }

  /** 目录白名单（审查 B10）：只允许备份根及其子目录，避免变成「任意目录枚举/删除原语」。 */
  function safeDir(candidate) {
    const base = resolve(outDir)
    if (!candidate || typeof candidate !== 'string' || candidate.trim() === '') return base
    const want = resolve(candidate)
    return (want === base || want.startsWith(base + sep)) ? want : null
  }

  function listPackages(url) {
    const dir = safeDir(url.searchParams.get('dir'))
    if (!dir) return { ok: false, error: `目录不在允许范围：只允许备份根 ${outDir} 及其子目录` }
    const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit') || 50) || 50))
    const groups = groupVaults(listVaults(dir)).slice(0, limit).map((g) => ({
      key: g.key,
      createdAt: (g.createdAt instanceof Date ? g.createdAt.toISOString() : String(g.createdAt)),
      kind: g.kind,
      scope: g.scope,
      host: g.host,
      parts: g.parts.length,
      bytes: g.bytes,
      size: human(g.bytes),
      files: g.parts.map((p) => p.name),
      main: g.parts.map((p) => p.abs).sort((a, b) => a.length - b.length)[0] ?? null,
    }))
    const totalBytes = groups.reduce((s, g) => s + g.bytes, 0)
    return {
      ok: true,
      dir,
      exists: existsSync(dir),
      count: groups.length,
      totalBytes,
      totalSize: human(totalBytes),
      groups,
    }
  }

  /**
   * 访问护栏（审查 B10）：仅允许本机回环访问 + 拒绝跨站 Origin。
   * 为什么不用 token：token 必须经一个不安全的通道（浏览器）分发，反而制造"以为安全"的错觉；
   * 这里的真实威胁是「浏览器里任意网页向 127.0.0.1 发请求（CSRF）」与「局域网直连」。
   */
  function guard(req, res) {
    const ra = String(req.socket?.remoteAddress ?? '')
    const localOk = ra === '' || ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1'
    if (!localOk) {
      sendJson(res, 403, { ok: false, error: `仅允许本机访问（来源 ${ra}）` })
      return false
    }
    const origin = req.headers?.origin
    if (typeof origin === 'string' && origin !== 'null' &&
        !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin)) {
      sendJson(res, 403, { ok: false, error: `跨站请求被拒绝（Origin: ${origin}）` })
      return false
    }
    return true
  }

  async function handle(req, res) {
    if (!guard(req, res)) return
    let url
    try {
      url = new URL(req.url ?? '/', 'http://localhost')
    } catch {
      return sendJson(res, 400, { ok: false, error: '非法 URL' })
    }
    let path = url.pathname
    if (path.startsWith(API_PREFIX)) path = path.slice(API_PREFIX.length)
    if (!path.startsWith('/')) path = `/${path}`

    try {
      if (req.method === 'GET' && (path === '/health' || path === '/' || path === '')) {
        return sendJson(res, 200, health())
      }

      if (req.method === 'GET' && path === '/list') {
        const result = listPackages(url)
        // 目录越界属客户端参数错误 → 400（审查 B10：不该用 200 包一个 ok:false）
        return sendJson(res, result?.ok === false ? 400 : 200, result)
      }

      if (req.method === 'GET' && path.startsWith('/jobs/')) {
        const id = decodeURIComponent(path.slice('/jobs/'.length))
        const job = jobs.get(id)
        if (!job) return sendJson(res, 404, { ok: false, error: `job 不存在：${id}` })
        return sendJson(res, 200, { ok: true, job: jobView(job) })
      }

      // /targets 支持 GET（读取目标配置，已脱敏）；其余写操作端点一律 POST
      if (req.method !== 'POST' && !(req.method === 'GET' && path === '/targets')) {
        return sendJson(res, 405, { ok: false, error: `method not allowed: ${req.method} ${path}` })
      }

      const body = await readBody(req)
      const confirm = body.confirm === true

      // ── /scan：零副作用，走 job 便于前端看进度 ─────────────────────────────
      if (path === '/scan') {
        const scope = typeof body.scope === 'string' && body.scope ? body.scope : 'core'
        const includeP1 = body.includeP1 === true
        const topExcluded = Math.max(0, Math.min(100, Number(body.topExcluded ?? 15) || 15))
        const job = startJob('scan', true, async (log) => {
          log(`scan scope=${scope} includeP1=${includeP1}`)
          const scan = await scanPlan({ dshHome: home, scope, includeP1 })
          const reports = scan.reports.map((r) => ({
            id: r.id,
            label: r.label,
            files: r.files,
            bytes: r.bytes,
            size: human(r.bytes),
            tier0: r.tier0,
            tier1: r.tier1,
            excluded: r.excluded.length,
            excludedBytes: r.excluded.reduce((s, e) => s + (e.size ?? 0), 0),
            excludedSample: r.excluded.slice(0, topExcluded).map((e) => ({ rel: e.rel, size: e.size ?? 0, rule: e.rule, reason: e.reason })),
          }))
          log(`总计 ${scan.totalFiles} 文件 / ${human(scan.totalBytes)}；排除 ${scan.excludedCount} 条 / ${human(scan.excludedBytes)}`)
          return {
            scope,
            includeP1,
            dshVersion: scan.plan.install?.version ?? null,
            totalFiles: scan.totalFiles,
            totalBytes: scan.totalBytes,
            totalSize: human(scan.totalBytes),
            excludedCount: scan.excludedCount,
            excludedBytes: scan.excludedBytes,
            reports,
            workspaces: scan.plan.workspaces.map((w) => ({ name: w.name, path: w.path })),
          }
        })
        return sendJson(res, 200, { ok: true, jobId: job.id, job: jobView(job) })
      }

      // ── /backup：写操作，默认 dry-run ─────────────────────────────────────
      if (path === '/backup') {
        const encrypt = body.encrypt !== false
        let password = resolvePassword(body.password)
        let generatedPassword = null
        if (encrypt && !password && body.deviceSlot !== false) {
          // 面板没填密码但允许本机免密 → 自动生成合规密码（随 job 结果返回一次）
          const rnd = randomBytes(18).toString('base64url')
          const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
          password = upper[randomBytes(1)[0] % upper.length] + rnd.slice(1, 20) + '#' + rnd.slice(20, 23)
          generatedPassword = password
        }
        const target = safeDir(typeof body.outDir === 'string' && body.outDir ? body.outDir : '') ?? outDir
        const scope = typeof body.scope === 'string' && body.scope ? body.scope : 'core'
        const includeP1 = body.includeP1 === true
        const dryRun = !confirm
        if (encrypt && !password) {
          return sendJson(res, 400, { ok: false, error: '缺少密码：请在面板输入，或设置 DSHVAULT_PASSWORD 环境变量 / 插件 config.password；也可勾选「本机免密」' })
        }
        const job = startJob('backup', dryRun, async (log) => {
          log(`备${dryRun ? '份预览（dry-run，未写盘）' : '份执行'}：outDir=${target} scope=${scope} 加密=${encrypt ? '是' : '否'}`)
          const r = await runBackup({
            password: password ?? undefined,
            account: typeof body.account === 'string' ? body.account : '',
            encrypt,
            recoveryCode: typeof body.recoveryCode === 'string' && body.recoveryCode
              ? body.recoveryCode
              : (body.recovery === false ? null : true),
            deviceSlot: encrypt && body.deviceSlot !== false,
            outDir: target,
            scope,
            includeP1,
            skipParts: Array.isArray(body.skipParts) ? body.skipParts.filter((x) => typeof x === 'string') : undefined,
            dryRun,
            kind: 'full',
            dshHome: home,
          }, log)
          if (r.dryRun) {
            return {
              dryRun: true,
              baseName: r.baseName,
              entries: r.entries,
              bytes: r.bytes,
              size: human(r.bytes),
              excludedCount: r.excluded.length,
              excludedSample: r.excluded.slice(0, 20).map((e) => ({ rel: e.rel, rule: e.rule, reason: e.reason })),
              hint: '确认无误后带 {"confirm": true} 重新提交即真执行',
            }
          }
          return {
            dryRun: false,
            baseName: r.baseName,
            outDir: r.outDir,
            entries: r.entries,
            totalBytes: r.totalBytes,
            totalSize: human(r.totalBytes),
            parts: r.parts.map((p) => p.name),
            seconds: r.seconds,
            plainHash: r.manifest?.plainHash ?? null,
            packSha256: r.manifest?.packSha256 ?? null,
            manifestPath: r.manifestPath ?? null,
            encrypted: r.encrypted !== false,
            cryptoMode: r.manifest?.crypto?.mode ?? null,
            keySlots: (r.keyring?.slots ?? []).map((s) => s.type),
            recoveryCode: r.keyring?.recoveryCode ?? null,   // 仅此一次：面板必须提示用户抄下
            generatedPassword,                                // 仅此一次：面板必须提示用户抄下
            notes: r.notes ?? [],
          }
        })
        return sendJson(res, 200, { ok: true, jobId: job.id, job: jobView(job) })
      }

      // ── /targets：备份目标（本地 / 网络路径 / WebDAV）───────────────────────
      if (path === '/targets') {
        const stDir = stateDir(home)
        if (req.method === 'GET') {
          const { targets, file, exists } = loadTargets(stDir)
          // 脱敏：不回传 secret，只告诉前端「已保存密码」
          return sendJson(res, 200, {
            ok: true,
            file,
            exists,
            targets: targets.map((t) => ({
              name: t.name, type: t.type, enabled: t.enabled, dir: t.dir,
              user: t.user, hasSecret: Boolean(t.secret), url: t.url,
              remoteDir: t.remoteDir, insecure: t.insecure,
            })),
          })
        }
        if (req.method === 'POST') {
          // ⚠️ 改成 upsert + 显式删除（GLM-5.3 审查 B-10，已核实）：原来是「整表替换」——
          // 前端一旦漏传一条，该目标连同它的 DPAPI 凭据就被静默删掉。现在：
          //   · body.targets 里的条目做 upsert（同名改址也保留原密码）
          //   · 只有 body.remove 里**显式点名**的才删除
          const upserts = Array.isArray(body.targets) ? body.targets : []
          const remove = Array.isArray(body.remove) ? body.remove.filter((x) => typeof x === 'string') : []
          const prev = loadTargets(stDir).targets
          const byName = new Map(prev.map((t) => [t.name, t]))
          for (const t of upserts) {
            if (!t || typeof t.name !== 'string' || !t.name.trim()) continue
            const old = byName.get(t.name)
            byName.set(t.name, { ...t, secret: t.secret ? t.secret : (old?.secret ?? '') })
          }
          for (const n of remove) byName.delete(n)
          const merged = [...byName.values()]
          const saved = saveTargets(stDir, merged)
          return sendJson(res, 200, {
            ok: true, saved: merged.length, removed: remove.length,
            path: saved.path, secretEncrypted: saved.encrypted,
          })
        }
      }

      // ── /targets/test：连通性测试（建目录 + 写探针）────────────────────────
      // ⚠️ 这是**写操作**（会在目标位置真的建目录并写 probe.txt），且 dir/url 由调用方给定：
      // 无门控时它等于一个「任意路径写 + 内网 SSRF 探测」原语（GLM-5.3 审查 S-C）。
      // 依 ADR-011 与备份本身同规矩：不带 confirm:true 一律拒绝。
      if (path === '/targets/test' && req.method === 'POST') {
        if (body.confirm !== true) {
          return sendJson(res, 400, { ok: false, error: '写操作需 confirm:true（会在目标位置建目录并写探针文件）' })
        }
        const r = await testTarget(body.target ?? normalizeTarget(body), () => {})
        return sendJson(res, 200, { ok: r.ok, target: r.target, type: r.type, sent: r.sent.length, errors: r.errors })
      }

      // ── /verify：只读校验，直接执行 ───────────────────────────────────────
      if (path === '/verify') {
        const pkg = typeof body.package === 'string' ? body.package.trim() : ''
        const password = resolvePassword(body.password)
        const account = typeof body.account === 'string' ? body.account : ''
        const recoveryCode = typeof body.recoveryCode === 'string' ? body.recoveryCode : ''
        const local = body.local === true
        if (!pkg) return sendJson(res, 400, { ok: false, error: '缺少 package（主包 .vault 路径）' })
        if (!existsSync(pkg)) return sendJson(res, 400, { ok: false, error: `包不存在：${pkg}` })
        if (!password && !recoveryCode && !local) {
          return sendJson(res, 400, { ok: false, error: '缺少凭证：请输入密码（或用恢复码 / 本机免密；未加密包不需要）' })
        }
        const job = startJob('verify', false, async (log) => {
          log('校验完整性（完整解密一遍并比对明文 sha256，不落盘）')
          const argv = ['--package', pkg, '--verify']
          if (account) argv.push('--account', account)
          if (recoveryCode) argv.push('--recovery-code', recoveryCode)
          if (local) argv.push('--local')
          const r = await runNode(argv, password ? { DSHVAULT_PASSWORD: password } : {})
          log(`还原器退出码 ${r.code}`)
          if (r.err.trim()) log(r.err.trim().slice(0, 500))
          return { package: pkg, exit: r.code, stdout: r.out.trim().slice(0, 4000), stderr: r.err.trim().slice(0, 2000) }
        })
        return sendJson(res, 200, { ok: true, jobId: job.id, job: jobView(job) })
      }

      // ── /restore：写操作，默认 dry-run（只列包信息） ──────────────────────
      if (path === '/restore') {
        const pkg = typeof body.package === 'string' ? body.package.trim() : ''
        const password = resolvePassword(body.password)
        const account = typeof body.account === 'string' ? body.account : ''
        const recoveryCode = typeof body.recoveryCode === 'string' ? body.recoveryCode : ''
        const local = body.local === true
        const target = typeof body.target === 'string' ? body.target.trim() : ''
        const inPlace = body.inPlace === true
        const only = Array.isArray(body.only) ? body.only.filter((x) => typeof x === 'string' && x) : []
        if (!pkg) return sendJson(res, 400, { ok: false, error: '缺少 package（主包 .vault 路径）' })
        if (!existsSync(pkg)) return sendJson(res, 400, { ok: false, error: `包不存在：${pkg}` })
        const dryRun = !confirm
        if (!dryRun && !password && !recoveryCode && !local) {
          return sendJson(res, 400, { ok: false, error: '缺少凭证：请输入密码（或用恢复码 / 本机免密；未加密包不需要）' })
        }
        if (!dryRun && !target && !inPlace) {
          return sendJson(res, 400, { ok: false, error: '真还原需给 target（解包目录）或 inPlace=true' })
        }
        const job = startJob('restore', dryRun, async (log) => {
          const argv = ['--package', pkg]
          if (dryRun) {
            argv.push('--list')
            log('还原预览（dry-run：只列包信息，不解密落盘）')
          } else {
            // 审查 B14：密码不进 argv（走环境变量）；账号 / 恢复码 / 本机免密走 argv（非秘密）
            if (account) argv.push('--account', account)
            if (recoveryCode) argv.push('--recovery-code', recoveryCode)
            if (local) argv.push('--local')
            if (inPlace) argv.push('--in-place')
            if (target) argv.push('--target', target)
            for (const o of only) argv.push('--only', o)
            log(`还原执行：${inPlace ? '原位映射' : `解包到 ${target}`}${only.length ? ` only=${only.join(',')}` : ''}`)
          }
          const r = await runNode(argv, !dryRun && password ? { DSHVAULT_PASSWORD: password } : {})
          log(`还原器退出码 ${r.code}`)
          if (r.err.trim()) log(r.err.trim().slice(0, 500))
          return { dryRun, package: pkg, target: target || null, inPlace, only, exit: r.code, stdout: r.out.trim().slice(0, 6000), stderr: r.err.trim().slice(0, 2000) }
        })
        return sendJson(res, 200, { ok: true, jobId: job.id, job: jobView(job) })
      }

      // ── /prune：写操作，默认 dry-run（出删除清单） ────────────────────────
      if (path === '/prune') {
        const dir = safeDir(body.dir)
        if (!dir) return sendJson(res, 400, { ok: false, error: `目录不在允许范围：只允许备份根 ${outDir} 及其子目录` })
        const hardDelete = body.hardDelete === true
        const dryRun = !confirm
        const policy = {
          keepLast: Number.isFinite(Number(body.keepLast)) ? Number(body.keepLast) : DEFAULT_POLICY.keepLast,
          minKeep: Number.isFinite(Number(body.minKeep)) ? Number(body.minKeep) : DEFAULT_POLICY.minKeep,
          maxTotalGB: Number.isFinite(Number(body.maxTotalGB)) ? Number(body.maxTotalGB) : DEFAULT_POLICY.maxTotalGB,
        }
        const job = startJob('prune', dryRun, async (log) => {
          log(`${dryRun ? '滚动保留预览（dry-run）' : '滚动保留执行'}：dir=${dir} policy=${JSON.stringify(policy)}`)
          if (dryRun) {
            const plan = planRetention(dir, policy)
            log(`逻辑包 ${plan.totalGroups} 个 / ${human(plan.totalBytes)} → 保留 ${plan.keep.length} 个 / ${human(plan.keptBytes)}`)
            return {
              dryRun: true,
              dir,
              policy,
              totalGroups: plan.totalGroups,
              totalBytes: plan.totalBytes,
              totalSize: human(plan.totalBytes),
              keptBytes: plan.keptBytes,
              keptSize: human(plan.keptBytes),
              keep: plan.keep.map((g) => ({ key: g.key, createdAt: g.createdAt.toISOString(), size: human(g.bytes), reason: plan.reasons.get(g.parts[0].abs) ?? '' })),
              drop: plan.drop.map((g) => ({ key: g.key, createdAt: g.createdAt.toISOString(), size: human(g.bytes) })),
              hint: hardDelete ? 'confirm:true 将直接删除（hardDelete）' : 'confirm:true 将移入 _trash/（可用 hardDelete:true 直接删除）',
            }
          }
          const r = applyRetention(dir, policy, { dryRun: false, hardDelete })
          log(`删除 ${r.plan.drop.length} 个逻辑包`)
          return {
            dryRun: false,
            dir,
            policy,
            deleted: r.plan.drop.length,
            actions: (r.actions ?? []).map((a) => ({ action: a.action, file: a.file, error: a.error ?? null })),
          }
        })
        return sendJson(res, 200, { ok: true, jobId: job.id, job: jobView(job) })
      }

      return sendJson(res, 404, { ok: false, error: `not found: ${path}` })
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: String((e && e.message) ? e.message : e) })
    }
  }

  return { prefix: API_PREFIX, handle, jobs, health }
}
