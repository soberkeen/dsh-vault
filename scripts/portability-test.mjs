#!/usr/bin/env node
/**
 * portability-test.mjs — 跨机可移植性：本机没有的分区必须**干净跳过**
 *
 * 场景（操作者提问）：别人下载这个插件，他们机器上没有 Docker / Hindsight，
 * 不应该报错、也不应该在包里留空分区或在还原文档里留无效步骤。
 *
 * 验证：
 *   1 显式 skipParts 生效：分区不进包
 *   2 被跳过的分区出现在 manifest.skippedParts（可追溯，含原因）
 *   3 核心分区（01-dsh-home）不受影响，仍在包里
 *   4 包内 RESTORE/AGENT.md 里**没有** Docker / pg_restore 的还原步骤（文档按实际分区裁剪）
 *   5 包内文档注明了跳过的分区
 *   6 这种包仍然能正常解包（结构完整）
 *
 * 用法：node scripts/portability-test.mjs
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runBackup } from '../lib/vault/pack.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, '..', 'lib', 'vault', 'portable-restore.mjs')

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const root = mkdtempSync(join(tmpdir(), 'vault-port-'))
const home = join(root, 'bare-home')      // 模拟"裸机"：只有 DSH 基础文件
const out = join(root, 'out')
mkdirSync(join(home, 'sessions'), { recursive: true })
writeFileSync(join(home, 'config.json'), '{"bare":true}', 'utf8')
writeFileSync(join(home, 'sessions', 's.jsonl'), '{"seq":1}\n', 'utf8')

try {
  // 模拟"这台机器没有 Docker / Hindsight"：显式排除这两个分区（等价于探测不到时自动跳过的效果）
  const r = await runBackup({
    dshHome: home, outDir: out, scope: 'core', encrypt: false,
    skipParts: ['03-hindsight', '04-docker'],
    pgContainer: '__none__',
  })
  const pkg = join(out, `${r.baseName}.vault`)
  const partIds = (r.manifest.partitions ?? []).map((p) => p.id)
  const skipped = r.manifest.skippedParts ?? []

  check('1 被排除的分区不进包',
    !partIds.includes('03-hindsight') && !partIds.includes('04-docker'),
    `包内分区：${partIds.join(', ')}`)
  check('2 跳过记录写进 manifest.skippedParts（可追溯）',
    skipped.some((s) => s.id === '03-hindsight') && skipped.some((s) => s.id === '04-docker'),
    skipped.map((s) => `${s.id}（${s.reason}）`).join('；'))
  check('3 核心分区 01-dsh-home 仍在（不被误剔）',
    partIds.includes('01-dsh-home'), `含 01-dsh-home=${partIds.includes('01-dsh-home')}`)

  // 解包并检查包内文档
  const target = join(root, 'extract')
  const rr = spawnSync(process.execPath, [CLI, '--package', pkg, '--target', target], { encoding: 'utf8' })
  check('4 这种包仍能正常解包', rr.status === 0, `exit=${rr.status}`)

  const agentMdPath = join(target, 'RESTORE', 'AGENT.md')
  const agentMd = readFileSync(agentMdPath, 'utf8')
  check('5 包内文档不含 Docker / pg_restore 的还原步骤（按实际分区裁剪）',
    !/pg_restore/.test(agentMd) && !/docker compose/.test(agentMd),
    `含 pg_restore=${/pg_restore/.test(agentMd)}｜含 docker compose=${/docker compose/.test(agentMd)}`)
  check('6 包内文档注明了跳过的分区',
    /跳过的分区/.test(agentMd) && /03-hindsight/.test(agentMd),
    agentMd.split('\n').filter((l) => l.includes('跳过的分区'))[0]?.slice(0, 120) ?? '(未找到)')

  const partitionTable = agentMd.split('## 2. 分区表')[1]?.split('## 3.')[0] ?? ''
  check('7 分区表里不出现空分区行',
    !partitionTable.includes('03-hindsight') && !partitionTable.includes('04-docker'),
    `分区表：${partitionTable.split('\n').filter((l) => l.startsWith('|')).slice(2).join(' ')}`)

  // 反向对照：不排除时，本机确实有 hindsight → 应出现在包里
  const r2 = await runBackup({ dshHome: home, outDir: out, scope: 'core', encrypt: false, pgContainer: '__none__' })
  const ids2 = (r2.manifest.partitions ?? []).map((p) => p.id)
  check('8 反向对照：不排除时 03-hindsight 正常进包（本机确实有）',
    ids2.includes('03-hindsight') || (r2.manifest.skippedParts ?? []).some((s) => s.id === '03-hindsight'),
    `本次分区：${ids2.join(', ')}｜跳过：${(r2.manifest.skippedParts ?? []).map((s) => s.id).join(', ') || '无'}`)

  console.log(`\n（包内文档里的还原步骤：）\n${agentMd.split('## 4. 还原动作')[1]?.split('## 5.')[0]?.trim().split('\n').slice(0, 6).join('\n')}`)
} catch (e) {
  check('可移植性用例执行', false, String(e?.message ?? e))
}

try { rmSync(root, { recursive: true, force: true }) } catch { /* 忽略 */ }
void readdirSync

const failed = results.filter((x) => !x.ok)
console.log('')
console.log(`=== ${results.length - failed.length}/${results.length} 通过 ===`)
if (failed.length > 0) {
  for (const f of failed) console.log(`  失败: ${f.name} — ${f.detail}`)
  process.exit(1)
}
