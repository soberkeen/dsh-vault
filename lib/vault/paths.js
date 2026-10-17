/**
 * paths.js — 路径与运行环境探测（跨机通用：不硬编码任何本机路径）
 *
 * 设计依据（AGENT.md / ADR-009）：
 *  A 层结构规则：$DSH_HOME 布局跨机稳定，存在即处理、不存在即跳过。
 *  B 层工作区发现：读 $DSH_HOME/storages/workspace.json（DSH 自维护注册表），
 *     实测本机 tables.workspaces.<uuid> 记录工作区绝对路径，共 11 条。
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, parse, resolve } from 'node:path'

/** DSH 主目录（优先 DSH_HOME：web 进程的 homedir 可能与 DSH_HOME 不一致）。 */
export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** Hindsight 本地数据目录（容器数据库另由 docker 侧备份）。 */
export function hindsightHome() {
  return process.env.HINDSIGHT_HOME || join(homedir(), '.hindsight')
}

/** 插件自己的状态目录（索引、锁、日志）。 */
export function stateDir(home = dshHome()) {
  return join(home, 'plugin-data', 'dsh-vault')
}

/**
 * 发现工作区：读 DSH 自己的工作区注册表，跨机通用、无需用户手填。
 * @returns {{id: string, path: string, name: string}[]}
 */
export function discoverWorkspaces(home = dshHome()) {
  const out = []
  const file = join(home, 'storages', 'workspace.json')
  if (!existsSync(file)) return out
  try {
    const doc = JSON.parse(readFileSync(file, 'utf8'))
    const table = doc?.tables?.workspaces ?? {}
    for (const [id, rec] of Object.entries(table)) {
      const p = pickPath(rec)
      if (!p) continue
      const abs = resolve(p)
      out.push({ id, path: abs, name: parse(abs).base })
    }
  } catch {
    // 注册表不可读/结构变化 → 返回空列表，调用方回退「插件登记目录 + 手填」
  }
  return out
}

function pickPath(rec) {
  if (!rec || typeof rec !== 'object') return null
  for (const k of ['root', 'path', 'cwd', 'folder', 'workspacePath', 'dir', 'uri']) {
    const v = rec[k]
    if (typeof v === 'string' && v.trim()) return v
  }
  if (Array.isArray(rec.folders) && typeof rec.folders[0] === 'string') return rec.folders[0]
  return null
}

/**
 * DSH 客户端安装包候选位置（空机恢复的前提）。
 * 跨机：探测各平台常见的更新器缓存目录，不做平台硬编码分支以外的假设。
 */
export function findInstallerCandidates() {
  const home = homedir()
  const local = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local')
  const cands = [
    join(local, '@deepseek-aidsh-desktop-updater', 'installer.exe'),
    join(local, 'dsh-plugin-desktop-updater', 'installer.exe'),
    join(local, 'Programs', 'dsh-desktop', 'installer.exe'),
    join(local, 'Programs', 'DeepSeek Harness', 'installer.exe'),
    join(home, 'Downloads', 'DeepSeek-Harness-Setup.exe'),
  ]
  return cands.filter((p) => existsSync(p))
}

/**
 * DSH 安装目录与版本。
 * 顺序：env → 常见安装根 → 更新器记录（拿不到就返回 null，不猜）。
 */
export function findDshInstall() {
  const home = homedir()
  const local = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local')
  const roots = [
    process.env.DSH_INSTALL_DIR,
    join(local, 'Programs', 'DeepSeek Harness'),
    join(local, 'Programs', 'dsh-desktop'),
    'C:\\Program Files\\DeepSeek Harness',
    'C:\\Program Files (x86)\\DeepSeek Harness',
    'I:\\DSH-Official',
    'D:\\DSH-Official',
  ].filter((p) => typeof p === 'string' && p)

  for (const root of roots) {
    if (!existsSync(root)) continue
    const versionFile = join(root, 'version')
    let version = null
    try {
      if (existsSync(versionFile)) version = readFileSync(versionFile, 'utf8').trim()
    } catch { /* 读不到就留 null */ }
    return { root, version }
  }
  return { root: null, version: null }
}

/** Hindsight docker 编排目录候选（用于把 compose/Dockerfile 打进包）。 */
export function findHindsightCompose(workspaces = []) {
  const cands = []
  for (const w of workspaces) cands.push(join(w.path, 'hindsight-docker'))
  cands.push(join(dshHome(), 'hindsight-docker'))
  for (const c of cands) {
    if (existsSync(join(c, 'docker-compose.yml'))) return c
  }
  return null
}

/** 主机名（备份包命名用，去特殊字符、大写）。 */
export function hostSlug() {
  const raw = process.env.COMPUTERNAME || process.env.HOSTNAME || 'UNKNOWN'
  return raw.replace(/[^A-Za-z0-9\-]/g, '').toUpperCase().slice(0, 24) || 'UNKNOWN'
}
