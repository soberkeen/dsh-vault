/**
 * targets.js — 备份目标与推送（本地 / 网络路径UNC / WebDAV）
 *
 * 操作者需求：「本地好选（填一个地址）；推到 NAS 该让他们填什么」。
 * 结论：① 网络路径（UNC / 映射盘）——用户填的东西与本地目录**完全一样**；
 *       ② WebDAV ——跨平台通用（群晖/威联通/极空间/坚果云/Nextcloud 自带）。
 *
 * 设计要点：
 *   - 推送在**本地包落地之后**进行：本地永远是主副本，推送失败不影响备份成立；
 *   - 凭据不落明文：用 DPAPI（本机 + 当前 Windows 用户）加密后存 plugin-data；
 *   - 零依赖：HTTP/HTTPS 用 node 内置模块手写 WebDAV（PUT/MKCOL/PROPFIND）。
 */
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { basename, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { atomicWriteJson, ensureDir, human, readJsonSafe } from './io.js'
import { dpapiProtect, dpapiUnprotect } from './kdf.js'

export const TARGET_TYPES = ['local', 'unc', 'webdav']

/** 目标定义（保存到磁盘时把 secret 换成密文）。 */
export function normalizeTarget(t = {}) {
  const type = TARGET_TYPES.includes(t.type) ? t.type : 'local'
  return {
    name: String(t.name ?? t.id ?? type),
    type,
    enabled: t.enabled !== false,
    // local / unc
    dir: typeof t.dir === 'string' ? t.dir.trim() : '',
    // unc / webdav 凭据（user 明文，secret 视情况）
    user: typeof t.user === 'string' ? t.user : '',
    secret: typeof t.secret === 'string' ? t.secret : '',
    // webdav
    url: typeof t.url === 'string' ? t.url.trim() : '',
    // Windows 习惯用反斜杠写路径（DSH-Backup\sub）→ 在 WebDAV 里会被 percent-encode 成
    // 单个字面目录名 "%5C"，落点与预期不符。统一归一为 "/"（GLM-5.3 审查 B-1）。
    remoteDir: typeof t.remoteDir === 'string'
      ? t.remoteDir.trim().replace(/\\+/g, '/').replace(/^\/+|\/+$/g, '')
      : '',
    insecure: t.insecure === true,          // 自签证书时跳过校验（仅局域网 NAS 建议开）
  }
}

/**
 * 保存目标配置。secret 用 DPAPI 加密（本机 + 当前用户可解），不落明文。
 * @returns {{ path: string, encrypted: boolean }}
 */
export function saveTargets(stateDirectory, targets) {
  ensureDir(stateDirectory)
  const file = join(stateDirectory, 'targets.json')
  let canEncrypt = true
  const out = (targets ?? []).map((t) => {
    const n = normalizeTarget(t)
    if (!n.secret) return n
    try {
      return { ...n, secret: `dpapi:${dpapiProtect(Buffer.from(n.secret, 'utf8'))}` }
    } catch {
      canEncrypt = false
      return { ...n, secret: '' }            // 加密不可用（非 Windows/无 pwsh）→ 宁可不存密码
    }
  })
  atomicWriteJson(file, { schema: 1, targets: out, secretEncrypted: canEncrypt })
  return { path: file, encrypted: canEncrypt }
}

/** 读取目标配置（自动解密 secret）。 */
export function loadTargets(stateDirectory) {
  const file = join(stateDirectory, 'targets.json')
  const doc = readJsonSafe(file, null)
  const list = (doc?.targets ?? []).map((t) => {
    const n = normalizeTarget(t)
    if (typeof n.secret === 'string' && n.secret.startsWith('dpapi:')) {
      const buf = dpapiUnprotect(n.secret.slice('dpapi:'.length))
      return { ...n, secret: buf ? buf.toString('utf8') : '' }
    }
    return n
  })
  return { file, targets: list, exists: existsSync(file) }
}

// ── 本地 / 网络路径 ─────────────────────────────────────────────────────────

/** UNC 或映射盘：直接用 fs 写（node 原生支持 \\host\share\... 与 Z:\...）。 */
async function pushFileToPath(dir, abs, log) {
  const { copyFile } = await import('node:fs/promises')
  mkdirSync(dir, { recursive: true })
  const dest = join(dir, basename(abs))
  await copyFile(abs, dest)
  const st = statSync(dest)
  if (st.size !== statSync(abs).size) throw new Error(`大小不一致：${dest}`)
  log?.(`已推送 ${basename(abs)} → ${dir}`)
  return dest
}

/** 带凭据的 UNC：用 pwsh 建临时带凭据会话（**密码不进 argv**）。
 *
 * ⚠️ GLM-5.3 审查 S-B（已核实）：原先用 `net use \\host\share /user:u 密码`，密码以明文
 * 出现在子进程命令行 —— 任何本机进程读 Win32_Process.CommandLine 即可拿到，也会进
 * 4688/Sysmon 事件日志。改成 pwsh + 环境变量传凭据（环境变量不出现在 CommandLine 里）。
 *
 * 失败**不抛**（原来 throw 会整块中止该目标）：很可能 Windows 已缓存凭据、直连本就能写；
 * 所以这里只努力建一次会话，真正的成败交给随后的 fs 写。
 */
function ensureCredentialedSession(uncRoot, user, secret) {
  if (process.platform !== 'win32' || !user || !secret) return false
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$sec = ConvertTo-SecureString -String $env:DSHVAULT_UNC_SECRET -AsPlainText -Force',
    '$cred = New-Object System.Management.Automation.PSCredential($env:DSHVAULT_UNC_USER, $sec)',
    '$d = New-PSDrive -Name DSHVAULT_TMP -PSProvider FileSystem -Root $env:DSHVAULT_UNC_ROOT -Credential $cred -Scope Global',
    'Remove-PSDrive -Name DSHVAULT_TMP -Force',
  ].join('; ')
  try {
    const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60000,
      env: {
        ...process.env,
        DSHVAULT_UNC_SECRET: secret,
        DSHVAULT_UNC_USER: user,
        DSHVAULT_UNC_ROOT: uncRoot,
      },
    })
    return r.status === 0
  } catch {
    return false
  }
}

/** 从 UNC 路径取出 \\host\share 用于建会话。 */
function uncHostOf(dir) {
  const m = /^(\\\\[^\\]+\\[^\\]+)/.exec(String(dir))
  return m ? m[1] : null
}

// ── WebDAV（纯 node 手写）──────────────────────────────────────────────────

function davRequest(target, method, urlPath, { body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const base = new URL(target.url)
    const full = new URL(urlPath.replace(/^\//, ''), base.href.endsWith('/') ? base.href : `${base.href}/`)
    const mod = full.protocol === 'https:' ? httpsRequest : httpRequest
    const auth = target.user
      ? 'Basic ' + Buffer.from(`${target.user}:${target.secret ?? ''}`, 'utf8').toString('base64')
      : null
    const req = mod({
      method,
      hostname: full.hostname,
      port: full.port || (full.protocol === 'https:' ? 443 : 80),
      path: full.pathname + full.search,
      headers: {
        ...(auth ? { authorization: auth } : {}),
        ...headers,
      },
      rejectUnauthorized: target.insecure ? false : true,
      timeout: 120000,
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }))
    })
    req.on('timeout', () => req.destroy(new Error('WebDAV 请求超时')))
    req.on('error', reject)
    if (body && typeof body.pipe === 'function') body.pipe(req)
    else req.end()
  })
}

/** 逐级 MKCOL 建目录（已存在返回 405 也算成功）。 */
async function davEnsureDir(target, dirPath) {
  const segs = String(dirPath).split('/').filter(Boolean)
  let cur = ''
  for (const s of segs) {
    cur += `/${s}`
    const r = await davRequest(target, 'MKCOL', cur)
    // 405 = 目录已存在（RFC 4918 允许）；3xx 不再当成功（GLM-5.3 审查 B-2）：
    // 不跟随重定向时真实位置在 Location 里，当成"目录已建"只会让后续 PUT 报出误导性错误。
    if ([301, 302, 307, 308].includes(r.status)) {
      throw new Error(`服务器要求重定向（HTTP ${r.status}）：请把 WebDAV 地址改成最终地址`)
    }
    if (![201, 200, 405].includes(r.status)) {
      const hint = davHint(r.status)
      throw new Error(`MKCOL ${cur} 失败：HTTP ${r.status}${hint ? ` —— ${hint}` : ''} ${r.body.toString('utf8').slice(0, 120)}`)
    }
  }
}

/** 把 HTTP 状态翻译成「用户能照着做」的话（GLM-5.3 审查 B-3：原来只抛裸状态码）。 */
function davHint(status) {
  if (status === 401) return '认证失败：用户名或密码不对（部分 NAS 要求「应用专用密码」）'
  if (status === 403) return '权限不足：该账号没有写这个目录的权限'
  if (status === 404) return '远端目录不存在且服务器不允许自动建目录（请先手工建一次）'
  if (status === 405) return '服务器不允许 PUT（路径可能写成了目录，或该挂载是只读的）'
  if (status === 507) return '远端空间不足（NAS 配额已满）'
  if ([301, 302, 307, 308].includes(status)) return '服务器要求重定向，请把 WebDAV 地址改成最终地址'
  return ''
}

async function davUpload(target, dirPath, abs, log) {
  const name = basename(abs)
  const url = `${dirPath.replace(/\/+$/, '')}/${encodeURIComponent(name)}`
  const size = statSync(abs).size
  let last = null
  // 失败重试一次（网络抖动 / NAS 打盹）；确定性错误（401/403/404/405/507）不重试
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await davRequest(target, 'PUT', url, {
      body: createReadStream(abs),
      headers: { 'content-length': String(size), 'content-type': 'application/octet-stream' },
    })
    if ([200, 201, 204].includes(r.status)) {
      log?.(`已推送 ${name}（${human(size)}）→ ${target.url}${dirPath}${attempt > 0 ? '（重试后成功）' : ''}`)
      return `${target.url}${url}`
    }
    last = r
    if (![408, 429, 500, 502, 503, 504].includes(r.status)) break
    await new Promise((res) => setTimeout(res, 800))
  }
  const hint = davHint(last?.status)
  throw new Error(`PUT ${name} 失败：HTTP ${last?.status}${hint ? ` —— ${hint}` : ''}${last?.body?.length ? ` ｜ ${last.body.toString('utf8').slice(0, 120)}` : ''}`)
}

// ── 统一入口 ───────────────────────────────────────────────────────────────

/**
 * 把一个目标的包文件推上去。
 * @returns {{ target: string, ok: boolean, sent: string[], errors: string[] }}
 */
export async function pushToTarget(target, files, log) {
  const t = normalizeTarget(target)
  const abs = (files ?? []).filter((f) => typeof f === 'string' && existsSync(f))
  const result = { target: t.name, type: t.type, ok: false, sent: [], errors: [] }
  if (abs.length === 0) { result.errors.push('没有可推送的文件（本地包缺失？）'); return result }
  try {
    if (t.type === 'local' || t.type === 'unc') {
      if (!t.dir) throw new Error('缺少目标目录（dir）')
      const host = t.type === 'unc' ? uncHostOf(t.dir) : null
      // 有凭据就先努力建一次会话；建不成也照样写（凭据可能已被 Windows 缓存）——成败看 fs 写
      if (host) ensureCredentialedSession(host, t.user, t.secret)
      for (const f of abs) result.sent.push(await pushFileToPath(t.dir, f, log))
    } else if (t.type === 'webdav') {
      if (!t.url) throw new Error('缺少 WebDAV 地址（url）')
      const remote = t.remoteDir || 'DSH-Backup'
      await davEnsureDir(t, remote)
      for (const f of abs) result.sent.push(await davUpload(t, remote, f, log))
    } else {
      throw new Error(`未知目标类型：${t.type}`)
    }
    result.ok = result.errors.length === 0
  } catch (e) {
    result.errors.push(String(e?.message ?? e))
  }
  return result
}

/** 批量推送到多个目标（彼此独立：一个失败不影响其它）。 */
export async function pushToTargets(targets, files, log) {
  // 并行推送到各目标（GLM-5.3 审查 B-3）：原来串行 await —— 一个慢目标（120s 超时 × 文件数）
  // 会把后面所有目标一起拖住。allSettled 保证单个失败不影响其它，且保持输入顺序。
  const list = (targets ?? []).filter((t) => t.enabled !== false)
  const settled = await Promise.allSettled(list.map((t) => pushToTarget(t, files, log)))
  return settled.map((s, i) => (s.status === 'fulfilled'
    ? s.value
    : {
      target: list[i]?.name ?? '?', type: list[i]?.type ?? '?', ok: false, sent: [],
      errors: [String(s.reason?.message ?? s.reason)],
    }))
}

/** 连通性测试（面板/CLI 用）：建目录 + 写一个小探针文件。 */
export async function testTarget(target, log) {
  const t = normalizeTarget(target)
  const probe = join(ensureDir(join(tmpProbeDir(), t.name.replace(/[^\w.-]/g, '_'))), 'probe.txt')
  atomicWriteJson(probe, { at: new Date().toISOString(), probe: true })
  const res = await pushToTarget(t, [probe], log)
  return res
}

function tmpProbeDir() {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  return join(base, 'dsh-vault-probe')
}
