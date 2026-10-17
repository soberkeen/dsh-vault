/**
 * scan.js — 分区扫描：把「要备份什么」变成条目清单 + 分层 + 排除证据
 *
 * 分区（AGENT.md / README §3）：
 *   00-installer  客户端安装包（空机恢复前提）
 *   01-dsh-home   $DSH_HOME（排除 node_modules/cache/plugin-backups/rewind-snapshots）
 *   02-workspaces 工作区（白名单勾选；四层排除 + 打分分层）
 *   03-hindsight  ~/.hindsight + Postgres 逻辑 dump（pg_dump -F c）
 *   04-docker     compose/Dockerfile/.env（镜像不打包，编排重建）
 *   05-plugins    插件源码与装配清单
 */
import { createWriteStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { classifyEntry, extOf } from './filter.js'
import { scorePath, tierOf, DSH_STRUCT_RE } from './importance.js'
import { readHead, walk, human, ensureDir } from './io.js'
import { discoverWorkspaces, dshHome, findDshInstall, findHindsightCompose, findInstallerCandidates, hindsightHome, stateDir } from './paths.js'

/** $DSH_HOME 下这些顶层目录不进核心包（可重建或体积无关）。 */
export const DSH_HOME_EXCLUDE_TOP = new Set([
  'node_modules', 'cache', 'plugin-backups', 'rewind-snapshots', 'dsh-runtimes', 'logs', 'telemetry',
])

/** 05-plugins 白名单式采集（插件源码/装配清单，不含 node_modules）。 */
export const PLUGIN_SUBPATHS = [
  'profiles/{profile}/package.json',
  'profiles/{profile}/cordis.patch.yml',
  'plugins-desk-v1',
  'plugin-data',
  'super-injector',
]

/**
 * 生成分区计划。
 * @param {object} opts
 *   { kind: 'full'|'incr', scope: 'core'|'ws'|'all', workspaces?: string[], profile?: string,
 *     dshHome?: string, includeInstaller?: boolean, includeHindsightDb?: boolean }
 */
export function planPartitions(opts = {}) {
  const home = opts.dshHome ?? dshHome()
  const install = findDshInstall()
  const wsAll = discoverWorkspaces(home)
  const picked = opts.workspaces && opts.workspaces.length > 0
    ? wsAll.filter((w) => opts.workspaces.some((s) => w.path === s || w.name === s))
    : wsAll
  const scope = opts.scope ?? 'core'

  const parts = []

  if (opts.includeInstaller !== false) {
    const cands = findInstallerCandidates()
    parts.push({
      id: '00-installer',
      label: 'DSH 客户端安装包',
      kind: 'files',
      optional: true,
      // rel 必须带来源目录名：两个更新器目录里都有 installer.exe，只取 basename 会让
      // 它们 rel 相同 → tar 内互相覆盖，还原后只剩一个（审查 B4 核验为真，此前误判已修）
      sources: cands.map((p) => ({ abs: p, rel: `00-installer/${basename(dirname(p))}/${basename(p)}` })),
      note: cands.length === 0 ? '未找到安装包（空机恢复需另行提供 DSH 安装介质）' : '',
      dshVersion: install.version,
    })
  }

  parts.push({
    id: '01-dsh-home',
    label: 'DSH 配置 / 会话 / 技能 / 规则',
    kind: 'tree',
    sources: [{ abs: home, prefix: '01-dsh-home' }],
    note: `DSH ${install.version ?? 'unknown'}`,
  })

  if (scope === 'ws' || scope === 'all') {
    parts.push({
      id: '02-workspaces',
      label: '工作区文件（非视频 / 非缓存）',
      kind: 'tree',
      tiered: true,
      optional: true,          // 没有工作区（或未勾选）时整块跳过，不占包内分区
      sources: picked.map((w) => ({ abs: w.path, prefix: `02-workspaces/${w.name}` })),
      note: picked.length === 0 ? '未发现工作区（注册表为空或未勾选）' : `${picked.length} 个工作区`,
    })
  }

  if (opts.includeHindsightDb !== false) {
    parts.push({
      id: '03-hindsight',
      label: 'Hindsight 记忆（本地目录 + Postgres 逻辑备份）',
      kind: 'hindsight',
      // optional：本机没有 Hindsight（~/.hindsight 不存在、也没跑 postgres）时**整块跳过**，
      // 不占包内分区、还原文档里也不会留步骤（跨机友好）
      optional: true,
      sources: [{ abs: hindsightHome(), prefix: '03-hindsight/home' }],
      note: existsSync(hindsightHome()) ? '' : '本机未发现 ~/.hindsight（未安装或未使用 Hindsight）',
    })
  }

  const composeDir = findHindsightCompose(wsAll)
  parts.push({
    id: '04-docker',
    label: 'Docker 编排（compose/Dockerfile，镜像不打包）',
    kind: 'files',
    optional: true,
    sources: composeDir
      ? ['docker-compose.yml', 'Dockerfile', '.env', 'backup-memory.ps1'].map((f) => ({ abs: join(composeDir, f), rel: `04-docker/${f}` }))
      : [],
    note: composeDir ? composeDir : '未找到 hindsight-docker 编排目录',
  })

  parts.push({
    id: '05-plugins',
    label: '插件与其装配清单',
    kind: 'tree',
    optional: true,
    sources: [
      { abs: join(home, 'plugins-desk-v1'), prefix: '05-plugins/plugins-desk-v1' },
      { abs: join(home, 'plugin-data'), prefix: '05-plugins/plugin-data' },
      { abs: join(home, 'profiles'), prefix: '05-plugins/profiles' },
    ],
    note: '',
  })

  return { parts, workspaces: wsAll, install, home }
}

const EXCLUDED_CAP = 2000

/** 热点路径：会话/存储/日志/插件数据/附件 —— 这些最可能在打包瞬间被写。 */
const HOT_PATH_RE = /(^|\/)(sessions|storages|plugin-data|logs|telemetry|attachments)(\/|$)/
const HOT_WINDOW_MS = 120_000

/** mtime 落在最近窗口内 → 视为热点（tar.js 会对它做写前复检，T20 稳定读加固）。 */
export function isHot(rel, mtimeMs) {
  return HOT_PATH_RE.test(String(rel)) && (Date.now() - (mtimeMs ?? 0)) < HOT_WINDOW_MS
}

/**
 * 扫描单个分区 → 条目 + 排除证据 + partial 清单。
 * @returns {{ entries: object[], excluded: object[], partial: object[], bytes: number, skipped: number }}
 */
export async function scanPartition(part, opts = {}) {
  // 审查 B16：原实现是纯同步遍历 —— 扫 5 万文件的工作区时会把 Electron 主进程**冻住**
  // （GUI 与所有工具都卡）。改为 async 并在内层循环分批让出事件循环。
  let __seen = 0
  const entries = []
  const excluded = []
  const partial = []
  const seenExcluded = new Set()
  let bytes = 0
  let skipped = 0

  const recordExcluded = (rel, size, rule, reason) => {
    if (excluded.length >= EXCLUDED_CAP) { skipped++; return }
    const key = `${rule}|${rel}`
    if (seenExcluded.has(key)) return
    seenExcluded.add(key)
    excluded.push({ rel, size, rule, reason })
  }

  for (const src of part.sources ?? []) {
    if (!existsSync(src.abs)) {
      recordExcluded(src.rel ?? src.abs, 0, 'missing', '源不存在（跳过）')
      continue
    }
    let st
    try { st = statSync(src.abs) } catch { continue }

    // ---- 单文件源（安装包 / compose 文件）----
    if (st.isFile()) {
      // rel 带上来源目录名：两个更新器的安装包同名 installer.exe，
      // 只用 basename 会让它们 rel 相同 → tar 内互相覆盖（同源实测踩到）
      const rel = src.rel ?? `${part.id}/${basename(dirname(src.abs))}/${basename(src.abs)}`
      const name = basename(src.abs)
      // 00-installer = 空机恢复刚需：豁免 L4 大二进制兜底（否则 275.9 MB 的
      // installer.exe 会被「>200 MB 二进制」规则误杀，整包失去可装机能力）
      const fileOpts = part.id === '00-installer' ? { ...opts, allowBigBin: true } : opts
      const judge = classifyEntry({ rel, name, ext: extOf(name), size: st.size, isDir: false }, fileOpts)
      if (judge && judge.tier === 'P2' && !judge.rule.startsWith('L4-exception')) {
        recordExcluded(rel, st.size, judge.rule, judge.reason)
        continue
      }
      entries.push({ rel, abs: src.abs, size: st.size, mtimeMs: st.mtimeMs, mode: st.mode, part: part.id, tier: 'P0' })
      bytes += st.size
      continue
    }

    // ---- 目录树 ----
    const list = walk(src.abs, {
      onError: (p, e) => recordExcluded(p, 0, 'walk-error', String(e?.message ?? e)),
    })
    for (const raw of list) {
      // 审查 B16：每 400 条让出一次事件循环（大工作区扫描不再冻住宿主 GUI）
      if (++__seen % 400 === 0) await new Promise((r) => setImmediate(r))
      const rel = `${src.prefix}/${raw.rel}`
      const name = basename(raw.abs)
      const top = raw.rel.split('/')[0]

      // 热点标记（T20 稳定读）：会话/存储/日志类且最近 2 分钟内被写过 →
      // tar.js 会在写头前做一次短复检并取最新 size，减少「打包瞬间带进写入中间态」。
      raw.hot = isHot(raw.rel, raw.mtimeMs)

      // DSH_HOME 顶层白名单裁剪
      if (part.id === '01-dsh-home' && DSH_HOME_EXCLUDE_TOP.has(top)) {
        if (!raw.isDir || raw.rel.includes('/')) continue
        recordExcluded(rel, raw.size, 'L3-dsh-top', `$DSH_HOME 顶层 ${top}/ 可重建或体积无关`)
        continue
      }
      // 05-plugins：profiles 只收每个 profile 的两个装配清单文件
      // ⚠️ 审查 B5：旧实现按 depth 判定，而 walk 的 rel 相对 `profiles/`（`web/package.json`
      // 的 depth 是 2），分支却写 depth===3 → 等于放行 `profiles/<p>/` 下**任意文件**
      // （.env、token、缓存都会进包）。改为显式白名单。
      if (part.id === '05-plugins' && raw.rel.startsWith('profiles/')) {
        const seg = raw.rel.split('/')
        const wanted = name === 'package.json' || name === 'cordis.patch.yml'
        if (raw.isDir || seg.length !== 2 || !wanted) {
          recordExcluded(rel, raw.size, 'B5-profiles-whitelist', 'profiles 只收 <profile>/package.json 与 cordis.patch.yml')
          continue
        }
      }

      let videoMagic = false
      if (!raw.isDir) {
        const ext = extOf(name)
        if (ext === '.ts' && raw.size > 1024 * 1024) {
          try {
            // MPEG-TS 的 sync 字节每 188 字节出现一次 → 同时检查第 1 与第 189 字节，
            // 避免把 "G…" 开头的文本 .ts（TypeScript / 纯文本）误判成视频（审查风格条）
            const head = readHead(raw.abs, 189)
            videoMagic = head.length >= 1 && head[0] === 0x47
              && (head.length < 189 || head[188] === 0x47)
          } catch { videoMagic = false }
        }
      }

      const entryForJudge = {
        rel, name, ext: extOf(name), size: raw.size, isDir: raw.isDir, videoMagic,
      }
      const judge = classifyEntry(entryForJudge, opts)
      if (judge) {
        if (judge.tier === 'P2') {
          recordExcluded(rel, raw.size, judge.rule, judge.reason)
          continue
        }
        if (judge.tier === 'P0') {
          if (!raw.isDir) entries.push({ ...raw, rel, part: part.id, tier: 'P0', reason: judge.reason })
          bytes += raw.size
          continue
        }
      }

      if (raw.isDir) continue // 目录本身不入包（tar 只写文件）

      const sc = scorePath(entryForJudge, {
        dshStruct: part.id === '01-dsh-home' || DSH_STRUCT_RE.test(rel),
      })
      const tier = tierOf(sc.score, raw.size)
      if (tier === 'P2') {
        recordExcluded(rel, raw.size, 'score-P2', `打分 ${sc.score}（${sc.reasons.join(' / ') || '无正向信号'}）`)
        continue
      }
      entries.push({ ...raw, rel, part: part.id, tier, score: sc.score, reasons: sc.reasons })
      bytes += raw.size
    }
  }

  return { entries, excluded, partial, bytes, skipped }
}

/** 找 Postgres 容器（跨机：不强依赖容器名）。 */
export async function findPgContainer(explicit) {
  if (explicit) return explicit
  return await new Promise((resolve) => {
    let out = ''
    let child
    try {
      child = spawn('docker', ['ps', '--format', '{{.Names}}|{{.Image}}'], { windowsHide: true })
    } catch { resolve(null); return }
    child.stdout.on('data', (c) => { out += String(c) })
    child.on('error', () => resolve(null))
    child.on('close', () => {
      // ⚠️ 不再兜底取「第一行」（GLM-5.3 审查 B-6，已核实）：docker ps 首行可能是 redis/nginx，
      // 拿它去 pg_dump 只会失败并留下误导性 note。只认名字/镜像里含 pg|postgres|hindsight 的。
      const line = out.split(/\r?\n/).find((l) => /pgvector|postgres|hindsight/i.test(l))
      if (!line || !line.includes('|')) { resolve(null); return }
      resolve(line.split('|')[0].trim() || null)
    })
  })
}

/**
 * Hindsight 逻辑备份：docker exec pg_dump -F c → 本地文件。
 * 不拷 pgdata 卷（热拷会得到 torn pages）。容器不必停。
 */
export async function dumpHindsight(opts = {}, log = () => {}) {
  const container = await findPgContainer(opts.pgContainer)
  if (!container) return { ok: false, reason: '未发现 postgres 容器（docker 不可用或未运行）' }
  // 落 OS 临时目录（而非 $DSH_HOME/plugin-data 下）：审查 S6 —— 明文 dump 不能长期驻盘，
  // 也不能被下一次备份的 05-plugins 扫描再收进包；打包完成后由 pack.js 立即删除。
  const tmpDir = ensureDir(join(tmpdir(), 'dsh-vault-dump'))
  const outFile = join(tmpDir, `hindsight_${Date.now()}.dump`)
  const user = opts.pgUser ?? 'hindsight'
  const db = opts.pgDb ?? 'hindsight'
  log(`hindsight: pg_dump -F c from ${container}`)
  const ok = await new Promise((resolve) => {
    let err = ''
    let bytes = 0
    const child = spawn('docker', ['exec', container, 'pg_dump', '-U', user, '-d', db, '-F', 'c'], { windowsHide: true })
    // 流式直写：不把整个 dump 攒在内存里（审查 S6 附带项：大库 OOM）
    const ws = createWriteStream(outFile)
    child.stdout.on('data', (c) => { bytes += c.length; if (!ws.write(c)) child.stdout.pause() })
    ws.on('drain', () => child.stdout.resume())
    ws.on('error', (e) => { err = String(e) })
    child.stderr.on('data', (c) => { err += String(c) })
    child.on('error', (e) => { err = String(e); ws.destroy(); resolve({ ok: false, err }) })
    child.on('close', (code) => {
      ws.end(() => {
        if (code === 0 && bytes > 0) resolve({ ok: true })
        else resolve({ ok: false, err: (err || `pg_dump 退出码 ${code}，写出 ${bytes} 字节`).slice(0, 300) })
      })
    })
  })
  if (!ok.ok) return { ok: false, reason: ok.err || 'pg_dump 失败' }
  const size = statSync(outFile).size
  return { ok: true, abs: outFile, size, rel: `03-hindsight/${basename(outFile)}`, container, human: human(size) }
}

/** 扫描计划 → 完整报告（面板/工具预览用，不写包）。 */
export async function scanPlan(opts = {}) {
  const plan = planPartitions(opts)
  const partFilter = (p) => !opts.onlyParts || opts.onlyParts.length === 0 || opts.onlyParts.includes(p.id)
  const skipSet = new Set(opts.skipParts ?? [])
  const reports = []
  const skippedParts = []          // 被跳过的分区（显式排除 / 本机没有源）→ 写进 manifest 与包内文档
  let totalBytes = 0
  let totalFiles = 0
  let excludedBytes = 0
  let excludedCount = 0

  for (const part of plan.parts) {
    if (!partFilter(part)) continue
    if (skipSet.has(part.id)) {
      skippedParts.push({ id: part.id, label: part.label, reason: '被 skipParts 显式排除' })
      continue
    }
    // 03-hindsight：本地目录部分**正常扫描**（DB dump 由 runBackup 实采后并入 entries）。
    // 旧实现此处直接 continue，导致 `~/.hindsight/`（coding-agent.json、profiles/*.env）
    // 从未进包 —— dry 预览暴露，属真实缺件。
    const r = await scanPartition(part, opts)
    // 可选分区且一个文件都没扫到 → **整块剔除**：
    // 别人机器上没有 Docker / Hindsight 时，包里不会留空分区，包内文档也不会写出
    // 指向不存在目录的还原步骤。它仍会出现在 manifest.skippedParts 里，可追溯。
    if (part.optional && r.entries.length === 0) {
      skippedParts.push({
        id: part.id,
        label: part.label,
        reason: part.note || '本机未检测到该分区的源（自动跳过）',
      })
      excludedBytes += r.excluded.reduce((s, e) => s + (e.size ?? 0), 0)
      excludedCount += r.excluded.length
      continue
    }
    reports.push({
      id: part.id,
      label: part.label,
      files: r.entries.length,
      bytes: r.bytes,
      tier0: r.entries.filter((e) => e.tier === 'P0').length,
      tier1: r.entries.filter((e) => e.tier === 'P1').length,
      excluded: r.excluded,
      skipped: r.skipped,
      note: part.note,
      entries: r.entries,
    })
    totalBytes += r.bytes
    totalFiles += r.entries.length
    excludedBytes += r.excluded.reduce((s, e) => s + (e.size ?? 0), 0)
    excludedCount += r.excluded.length
  }

  return { plan, reports, skippedParts, totalBytes, totalFiles, excludedBytes, excludedCount }
}

/** 创建输出目录（本地落地位）。 */
export function ensureOutDir(dir) {
  mkdirSync(dir, { recursive: true })
  return dir
}
