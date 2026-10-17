/**
 * importance.js — 重要性打分器（AGENT.md / ADR-009 C 层）
 *
 * 正向：文本/代码 +40 ｜ 办公产物 +35（<100MB）｜ DSH 结构 +30 ｜ git 有未提交改动 +25
 *       语义正面命名 +15 ｜ 小体积数据 +20
 * 反向：gitignore −50 ｜ 依赖清单 −45 ｜ 构建缓存 −60 ｜ 虚拟环境 −70 ｜ 模型 −60
 *       媒体 −55 ｜ 大二进制 −40 ｜ 备份的备份 −30
 *
 * 判定顺序：先证据（filter.js 的硬规则）→ 再价值（本文件打分）→ 灰区保守（P1）。
 */
import { DOC_EXT, IMAGE_EXT, TEXT_EXT } from './filter.js'

export const DSH_STRUCT_RE = /(^|\/)(\.dsh|hindsight|profiles?|skills?|rules?|storages?|plugin-data|agents?|prompts?|memories?|knowledge)(\/|$)/i

export const POSITIVE_NAME_RE = /(^|\/)(src|source|docs?|scripts?|conf(ig)?|notes?|prompts?|skills?|rules?|templates?|wiki|data|assets?|outputs?|report|handoff|sop|spec|design|schema|migration|backup-plan)(\/|\.|$)/i

export const SMALL_DATA_EXT = new Set(['.db', '.sqlite', '.sqlite3', '.parquet', '.jsonl', '.ndjson', '.dump', '.sql'])
export const DEP_MANIFEST_NAMES = new Set([
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'requirements.txt', 'pyproject.toml',
  'Pipfile.lock', 'poetry.lock', 'Cargo.lock', 'go.sum', 'composer.lock', 'Gemfile.lock',
  'packages.lock.json', 'gradle.lockfile',
])

/**
 * @param {object} entry  { rel, name, ext, size, isDir }
 * @param {object} ctx    { gitDirty?: boolean, gitignored?: boolean, dshStruct?: boolean }
 * @returns {{ score: number, reasons: string[] }}
 */
export function scorePath(entry, ctx = {}) {
  const reasons = []
  let score = 0
  const ext = entry.ext ?? ''
  const size = entry.size ?? 0

  if (TEXT_EXT.has(ext)) { score += 40; reasons.push('文本/代码 +40') }
  else if (DOC_EXT.has(ext) && size < 100 * 1024 * 1024) { score += 35; reasons.push('办公/文档产物 +35') }
  else if (IMAGE_EXT.has(ext) && size < 50 * 1024 * 1024) {
    // 操作者口径「工作区只排除视频」→ 截图/设计稿属**该备份的非视频内容**。
    // 打分必须够到 P0（≥40），否则默认（includeP1=false）会静默丢掉它们（跨模型审查风格条）。
    score += 45; reasons.push('图片/设计稿（非视频内容）+45')
  }
  else if (SMALL_DATA_EXT.has(ext) && size < 200 * 1024 * 1024) { score += 20; reasons.push('小体积数据 +20') }

  if (ctx.dshStruct || DSH_STRUCT_RE.test(entry.rel)) { score += 30; reasons.push('DSH 结构 +30') }
  if (ctx.gitDirty) { score += 25; reasons.push('git 工作区有未提交改动 +25') }
  if (POSITIVE_NAME_RE.test(entry.rel)) { score += 15; reasons.push('语义正面命名 +15') }
  if (ctx.gitignored) { score -= 50; reasons.push('.gitignore 命中 −50') }
  if (ctx.depManifestDir) { score -= 45; reasons.push('目录含依赖清单 −45') }
  if (DEP_MANIFEST_NAMES.has(entry.name)) { score += 45; reasons.push('锁文件（重建依据） +45') }

  return { score, reasons }
}

/** 打分 → 分层（P0 必存 / P1 默认关 / P2 排除）。 */
export function tierOf(score, size) {
  if (score >= 40) return 'P0'
  if (score >= 0 && size < 200 * 1024 * 1024) return 'P1'
  return 'P2'
}

/**
 * 汇总一份扫描结果的分层统计（面板预览用）。
 */
export function summarize(items) {
  const acc = { P0: { files: 0, bytes: 0 }, P1: { files: 0, bytes: 0 }, P2: { files: 0, bytes: 0 } }
  for (const it of items) {
    const t = it.tier ?? 'P1'
    acc[t].files += 1
    acc[t].bytes += it.size ?? 0
  }
  return acc
}
