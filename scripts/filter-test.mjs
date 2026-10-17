#!/usr/bin/env node
/**
 * filter-test.mjs — 排除规则语义单测（补跨模型审查的测试缺口 #7）
 *
 * 重点验证审查 B6 的修复：E8「备份的备份」不再按**文件名宽匹配**误杀正经文档，
 * 同时仍然拦住真正的备份产物与备份目录。
 *
 * 用法：node scripts/filter-test.mjs
 */
import { classifyEntry } from '../lib/vault/filter.js'

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

/** 判定 tier：classifyEntry 返回 null 表示"交给重要性打分"，等价于可备份（P1）。 */
const tierOf = (rel, isDir = false, extra = {}) => {
  const r = classifyEntry({ rel, isDir, size: extra.size ?? 1024, ...extra })
  return { tier: r ? r.tier : 'P1', rule: r ? r.rule : '(交给打分)' }
}

const cases = [
  // ── B6 修复：这些是"正经文档"，曾经被 E8 误杀 ─────────────────────────────
  ['docs/old-notes.md', false, 'P1', 'old-notes.md（文档，不是备份产物）'],
  ['docs/backup-plan.md', false, 'P1', 'backup-plan.md（文档）'],
  ['config/config-old.yaml', false, 'P1', 'config-old.yaml（配置）'],
  ['docs/archive-guide.md', false, 'P1', 'archive-guide.md（文档）'],
  ['notes/trash-talk.txt', false, 'P1', 'trash-talk.txt（含 trash 词但是文档）'],

  // ── 真正的备份产物/备份目录：必须仍然拦住 ─────────────────────────────────
  ['backups/2026/x.md', false, 'P2', '位于 backups/ 目录'],
  ['old/x.md', false, 'P2', '位于 old/ 目录'],
  ['回收站/x.md', false, 'P2', '位于 回收站/ 目录'],
  ['data/x.zip.bak', false, 'P2', '明确备份后缀 .bak'],
  ['data/backup-2026.zip', false, 'P2', 'backup- 前缀'],
  ['data/dump_20260101.tar', false, 'P2', '日期戳后缀'],
  ['data/config.orig', false, 'P2', '后缀 .orig'],

  // ── 既有四层规则仍然生效 ─────────────────────────────────────────────────
  ['node_modules/pkg/x.js', false, 'P2', 'L2 依赖目录'],
  ['proj/.venv/lib/x.py', false, 'P2', 'L2 虚拟环境'],
  ['proj/dist/bundle.js', false, 'P2', 'L3 构建产物'],
  ['proj/.cache/x.bin', false, 'P2', 'L3 缓存'],
  ['media/clip.mp4', false, 'P2', 'L1 视频'],
  ['models/model.safetensors', false, 'P2', 'L4 模型权重'],

  // ── 正常内容必须保留 ─────────────────────────────────────────────────────
  ['src/index.js', false, 'P1', '普通代码'],
  ['docs/readme.md', false, 'P1', '普通文档'],
  ['data/config.json', false, 'P1', '普通配置'],

  // ── 目录条目 ─────────────────────────────────────────────────────────────
  ['node_modules', true, 'P2', '依赖目录（目录条目）'],
  ['backups', true, 'P2', '备份语义目录（目录条目）'],
  ['src', true, 'P1', '普通目录'],

  // ── 分区级豁免（allowBigBin）：00-installer 的安装包不能被杀 ───────────────
  ['installer/setup.exe', false, 'P1', '大二进制 + allowBigBin 豁免'],
]

let bad = 0
for (const [rel, isDir, want, why] of cases) {
  // ⚠️ 注意参数位置：豁免要作为**第二参数**（ctx）传，塞进 entry 是不生效的
  const ctx = rel.startsWith('installer/') ? { allowBigBin: true } : {}
  const size = rel.startsWith('installer/') ? 300 * 1024 * 1024 : 1024
  const r = classifyEntry({ rel, isDir, size }, ctx)
  const got = r ? r.tier : 'P1'
  const ok = got === want
  if (!ok) bad++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${rel}${isDir ? '/' : ''} → ${got}（期望 ${want}）— ${why}${r ? `［${r.rule}］` : ''}`)
}
check('过滤器语义用例表', bad === 0, `${cases.length} 条中 ${bad} 条不符`)

// ── 目录命中优先于文件后缀（rel 判定与 dir 判定一致性）────────────────────
check('B6-回归：E8 的文件名规则不再命中 old-notes.md',
  tierOf('old-notes.md').tier === 'P1', `tier=${tierOf('old-notes.md').tier} rule=${tierOf('old-notes.md').rule}`)
check('B6-回归：backups/ 目录仍被排除',
  tierOf('backups/x.txt').tier === 'P2', `rule=${tierOf('backups/x.txt').rule}`)

const failed = results.filter((r) => !r.ok)
console.log('')
console.log(`=== ${results.length - failed.length}/${results.length} 通过 ===`)
if (failed.length > 0) {
  for (const f of failed) console.log(`  失败: ${f.name} — ${f.detail}`)
  process.exit(1)
}
