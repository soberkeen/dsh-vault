/**
 * @soberkeen/dsh-vault — host 插件入口（toolkit 形态）
 *
 * 工具：
 *   vault_scan    扫描 + 分层预览（P0/P1/P2 + 排除证据，零副作用）
 *   vault_backup  执行加密备份并落地（本地目录，默认 G:\DSH-Backup）
 *   vault_list    列出历史备份包（含分卷聚合与 manifest 摘要）
 *   vault_verify  校验包完整性（调包内自包含还原器 --verify）
 *   vault_restore 还原（解包 / 原位还原）
 *   vault_prune   滚动保留（默认 dry-run，出删除清单）
 *
 * 零非内置依赖：不 import @deepseek-ai/*，保证任意机器任意 DSH 都能加载。
 */
import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { atomicWriteJson, ensureDir, human, isoNow, readJsonSafe } from './vault/io.js'
import { dshHome, discoverWorkspaces, findDshInstall, hostSlug, stateDir } from './vault/paths.js'
import { scanPlan } from './vault/scan.js'
import { runBackup } from './vault/pack.js'
import { applyRetention, groupVaults, listVaults, planRetention } from './vault/policy.js'
import { P, tool } from './vault/toolkit.js'
import { loadTargets } from './vault/targets.js'
import { createApi, API_PREFIX } from './server.js'

export const name = '@soberkeen/dsh-vault'
export const inject = ['tools']

const HERE = dirname(fileURLToPath(import.meta.url))
const RESTORE_CLI = join(HERE, 'vault', 'portable-restore.mjs')

/** 默认落盘目录：配置 → 环境变量 → 约定目录（不硬编码本机盘符以外的假设）。 */
const DEFAULT_OUT_DIR = 'G:\\DSH-Backup'

export function apply(ctx, config = {}) {
  const home = config.dshHome || dshHome()
  const outDir = config.outDir || process.env.DSHVAULT_OUT_DIR || DEFAULT_OUT_DIR
  const state = ensureDir(stateDir(home))
  const indexPath = join(state, 'index.json')
  const logPath = join(state, 'vault.log')

  const log = (msg) => {
    try { appendFileSync(logPath, `[${isoNow()}] ${msg}\n`) } catch { /* 日志失败静默 */ }
  }
  const resolvePassword = (given) => given || process.env.DSHVAULT_PASSWORD || config.password || null

  const appendIndex = (rec) => {
    const idx = readJsonSafe(indexPath, { version: 1, backups: [] }) ?? { version: 1, backups: [] }
    idx.backups = [rec, ...(idx.backups ?? [])].slice(0, 500)
    atomicWriteJson(indexPath, idx)
  }

  // 审查 B14：密码走环境变量（不进 argv，避免本机进程列表可见）
  const runNode = (args, extraEnv = {}) => new Promise((resolve) => {
    let out = ''
    let err = ''
    const child = spawn(process.execPath, [RESTORE_CLI, ...args], { windowsHide: true, env: { ...process.env, ...extraEnv } })
    child.stdout.on('data', (c) => { out += String(c) })
    child.stderr.on('data', (c) => { err += String(c) })
    child.on('error', (e) => resolve({ code: -1, out, err: String(e) }))
    child.on('close', (code) => resolve({ code, out, err }))
  })

  const optCommon = () => ({
    dshHome: home,
  })

  // ─────────────────────────────── vault_scan ───────────────────────────────
  ctx.tools.register(tool({
    name: 'vault_scan',
    description: '扫描将备份的内容并预览分层结果（P0 必存 / P1 可勾 / P2 排除），零副作用。用于确认「哪些文件重要、哪些被排除及其证据」。',
    parameters: {
      scope: { type: 'string', description: "范围：core（配置+会话+记忆+安装包）| ws（工作区）| all" },
      includeP1: { type: 'boolean', description: '是否把 P1（默认关）也列入备份' },
      topExcluded: { type: 'number', description: '每分区展示多少条排除证据（默认 15）' },
    },
    outputSchema: { type: 'string' },
    async execute(args) {
      const scope = args.scope ?? 'core'
      const scan = await scanPlan({ ...optCommon(), scope, includeP1: args.includeP1 === true })
      const lines = []
      lines.push(`# vault_scan — scope=${scope}  DSH ${scan.plan.install?.version ?? 'unknown'}`)
      lines.push(`总计：${scan.totalFiles} 文件 / ${human(scan.totalBytes)}；排除 ${scan.excludedCount} 条 / ${human(scan.excludedBytes)}`)
      lines.push('')
      lines.push('| 分区 | 文件 | 体积 | P0 | P1 | 排除条目 |')
      lines.push('|---|---|---|---|---|---|')
      for (const r of scan.reports) {
        lines.push(`| ${r.id} ${r.label} | ${r.files} | ${human(r.bytes)} | ${r.tier0} | ${r.tier1} | ${r.excluded.length} |`)
      }
      const top = Number(args.topExcluded ?? 15)
      for (const r of scan.reports) {
        if (r.excluded.length === 0) continue
        lines.push('')
        lines.push(`## 排除证据 — ${r.id}（前 ${Math.min(top, r.excluded.length)}/${r.excluded.length}，${human(r.excluded.reduce((s, e) => s + (e.size ?? 0), 0))}）`)
        for (const e of r.excluded.slice(0, top)) lines.push(`- ${e.rel} — ${human(e.size ?? 0)} — [${e.rule}] ${e.reason}`)
      }
      const wsList = scan.plan.workspaces.map((w) => `${w.name} → ${w.path}`).join('\n')
      if (wsList) { lines.push(''); lines.push('## 已发现工作区（来自 $DSH_HOME/storages/workspace.json）'); lines.push(wsList) }
      return lines.join('\n')
    },
  }))

  // ────────────────────────────── vault_backup ──────────────────────────────
  ctx.tools.register(tool({
    name: 'vault_backup',
    description: '执行一次加密备份：tar → gzip → AES-256-GCM 分块 → 分卷，落地到本地目录，并生成包内 RESTORE/（含还原器与台账）。',
    parameters: {
      encrypt: { type: 'boolean', description: '是否加密（默认 true）。false = 不加密：谁拿到都能打开，只适合放本机/可信位置' },
      account: { type: 'string', description: '凭证绑定的账号（可不填；账号不做要求，大小写/空格/全角自动归一）' },
      password: { type: 'string', description: '密码（首字母大写 + 含特殊符号 + ≥8 位）。缺省读 DSHVAULT_PASSWORD 环境变量 / 插件 config.password' },
      recovery: { type: 'boolean', description: '是否生成恢复码槽（默认 true；忘了账号密码时的唯一退路）' },
      recoveryCode: { type: 'string', description: '改用已有恢复码建槽（填了就不再生成新的）' },
      deviceSlot: { type: 'boolean', description: '是否加「本机免密」槽（DPAPI，仅本机本用户可用；默认 true）' },
      writeKey: { type: 'boolean', description: '是否把密码/恢复码写进 <out>/_keys（默认 false：只显示一次，不落盘）' },
      skipParts: { type: 'array', items: { type: 'string' }, description: '要跳过的分区 id（如 04-docker、03-hindsight）。本机探测不到的分区会**自动跳过**，通常无需填写' },
      pushTargets: { type: 'array', items: { type: 'string' }, description: '落地后推送到这些目标名（本地/网络路径/WebDAV，在面板「目标」区配置；本地永远是主副本，推送失败不影响备份）' },
      outDir: { type: 'string', description: `输出目录（缺省 ${DEFAULT_OUT_DIR}）` },
      scope: { type: 'string', description: 'core | ws | all（缺省 core）' },
      includeP1: { type: 'boolean', description: '是否包含 P1（默认关）' },
      dryRun: { type: 'boolean', description: '只出计划不写包' },
    },
    outputSchema: { type: 'string' },
    async execute(args) {
      const encrypt = args.encrypt !== false
      let password = resolvePassword(args.password)
      let generated = false
      if (encrypt && !password && args.deviceSlot !== false) {
        // 没给密码但允许本机免密 → 自动生成合规密码（只显示一次）+ 带恢复码槽
        const rnd = randomBytes(18).toString('base64url')
        const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
        password = upper[randomBytes(1)[0] % upper.length] + rnd.slice(1, 20) + '#' + rnd.slice(20, 23)
        generated = true
      }
      if (encrypt && !password) {
        return '缺少密码：请传 password，或设置 DSHVAULT_PASSWORD 环境变量 / 插件 config.password；或允许 deviceSlot 走本机免密'
      }
      const target = args.outDir || outDir
      const scope = args.scope ?? 'core'
      const started = Date.now()
      const wantRecovery = args.recoveryCode ? false : args.recovery !== false
      // 推送目标（可选）：按名字从 targets.json 里取（凭据已 DPAPI 解密）
      let pushList
      if (Array.isArray(args.pushTargets) && args.pushTargets.length > 0) {
        try {
          const { targets } = loadTargets(state)
          pushList = targets.filter((t) => args.pushTargets.includes(t.name))
          if (pushList.length === 0) log(`⚠️ 配置里没找到这些目标：${args.pushTargets.join(', ')}`)
        } catch (e) {
          log(`⚠️ 目标配置读取失败：${e?.message ?? e}`)
        }
      }
      const res = await runBackup({
        password: password ?? undefined,
        account: args.account ?? '',
        encrypt,
        recoveryCode: args.recoveryCode ?? (wantRecovery ? true : null),
        deviceSlot: encrypt && args.deviceSlot !== false,
        outDir: target,
        scope,
        includeP1: args.includeP1 === true,
        skipParts: Array.isArray(args.skipParts) ? args.skipParts : undefined,
        targets: pushList,
        dryRun: args.dryRun === true,
        kind: 'full',
        ...optCommon(),
      }, log)
      if (res.dryRun) {
        return [
          `# vault_backup（dry-run）`,
          `包名：${res.baseName}`,
          `条目：${res.entries} 个文件 / ${human(res.bytes)}`,
          `排除：${res.excluded.length} 条（示例见下）`,
          ...res.excluded.slice(0, 20).map((e) => `- ${e.rel} — [${e.rule}] ${e.reason}`),
        ].join('\n')
      }
      const rec = {
        baseName: res.baseName,
        outDir: res.outDir,
        bytes: res.totalBytes,
        parts: res.parts.length,
        createdAt: isoNow(),
        seconds: res.seconds,
        entries: res.entries,
        sha256: res.manifest.packSha256,
        notes: res.notes,
      }
      appendIndex(rec)
      // writeKey=true 时才落盘（默认不落盘：密码与恢复码只显示一次，避免"钥匙和保险箱放一起"）
      if (args.writeKey === true && res.encrypted !== false) {
        try {
          const kd = join(target, '_keys')
          mkdirSync(kd, { recursive: true })
          writeFileSync(join(kd, `${res.baseName}.key.txt`), [
            `# dsh-vault 备份包密钥（显式要求落盘）`,
            `包名：${res.baseName}`,
            `账号：${args.account ?? ''}`,
            `密码：${password}`,
            res.keyring?.recoveryCode ? `恢复码：${res.keyring.recoveryCode}` : '',
            ``,
            `⚠️ 本文件等同于解密凭据：泄露 = 包可被解开。请移到安全位置或抄写后删除。`,
          ].filter(Boolean).join('\n'), 'utf8')
        } catch { /* 落盘失败不影响备份结果 */ }
      }
      log(`backup done ${res.baseName} ${human(res.totalBytes)} in ${res.seconds}s`)
      return [
        `# vault_backup 完成`,
        `包：${res.baseName}`,
        `落地：${res.outDir}`,
        `体积：${human(res.totalBytes)}（${res.parts.length} 卷）｜条目 ${res.entries} ｜耗时 ${res.seconds}s`,
        `明文流 sha256：${res.manifest.plainHash}`,
        `包字节 sha256：${res.manifest.packSha256}`,
        `manifest：${res.manifestPath}`,
        res.notes.length > 0 ? `附注：\n- ${res.notes.join('\n- ')}` : '',
        '',
        `还原：照包内 RESTORE/README.md 的步骤做（或直接调 vault_restore）；包位于 ${res.outDir}`,
      ].filter(Boolean).join('\n')
    },
  }))

  // ─────────────────────────────── vault_list ───────────────────────────────
  ctx.tools.register(tool({
    name: 'vault_list',
    description: '列出指定目录下的历史备份包（按逻辑包聚合多卷），含体积、时间、类型、manifest 摘要。',
    parameters: {
      dir: { type: 'string', description: `目录（缺省 ${DEFAULT_OUT_DIR}）` },
    },
    outputSchema: { type: 'string' },
    async execute(args) {
      const dir = args.dir || outDir
      const groups = groupVaults(listVaults(dir))
      if (groups.length === 0) return `目录 ${dir} 下没有发现 .vault 包`
      const lines = [`# 备份包（${dir}）`, '', '| 包名 | 时间 | 类型/范围 | 卷 | 体积 |', '|---|---|---|---|---|']
      for (const g of groups) {
        lines.push(`| ${g.key} | ${g.createdAt.toISOString()} | ${g.kind}/${g.scope} | ${g.parts.length} | ${human(g.bytes)} |`)
      }
      const total = groups.reduce((s, g) => s + g.bytes, 0)
      lines.push('', `共 ${groups.length} 个逻辑包 / ${human(total)}`)
      return lines.join('\n')
    },
  }))

  // ────────────────────────────── vault_verify ──────────────────────────────
  ctx.tools.register(tool({
    name: 'vault_verify',
    description: '校验备份包：完整解密一遍并比对 tar 明文 sha256（与包内 manifest.plainHash 对照），不落盘。',
    parameters: {
      package: { type: 'string', description: '主包 .vault 路径' },
      account: { type: 'string', description: '凭证绑定的账号（v2 包需要；可不填）' },
      password: { type: 'string', description: '密码（v2 凭证包与旧 v1 包都走这里）' },
      recoveryCode: { type: 'string', description: '改用恢复码校验（忘了账号密码时）' },
      local: { type: 'boolean', description: '用本机免密槽（仅生成它的那台电脑/用户可用）' },
    },
    required: ['package'],
    outputSchema: { type: 'string' },
    async execute(args) {
      const password = resolvePassword(args.password)
      if (!password && !args.local && !args.recoveryCode) return '缺少凭证：请传 password（或用 recoveryCode / local）'
      const argv = ['--package', args.package, '--verify']
      if (args.account) argv.push('--account', args.account)
      if (args.recoveryCode) argv.push('--recovery-code', args.recoveryCode)
      if (args.local) argv.push('--local')
      const r = await runNode(argv, password ? { DSHVAULT_PASSWORD: password } : {})
      return [`$ node vault-restore.mjs --verify（exit ${r.code}）`, '```json', r.out.trim(), '```', r.err.trim() ? `stderr:\n${r.err.trim()}` : ''].filter(Boolean).join('\n')
    },
  }))

  // ───────────────────────────── vault_restore ─────────────────────────────
  ctx.tools.register(tool({
    name: 'vault_restore',
    description: '还原备份包：--target 解包到目录；inPlace=true 按分区映射还原到原位（01→$DSH_HOME，02→原工作区路径，03→~/.hindsight，05→$DSH_HOME）。默认先只解包，不动系统。',
    parameters: {
      package: { type: 'string', description: '主包 .vault 路径' },
      account: { type: 'string', description: '凭证绑定的账号（v2 包需要；可不填）' },
      password: { type: 'string', description: '密码（v2 凭证包与旧 v1 包都走这里）' },
      recoveryCode: { type: 'string', description: '改用恢复码还原（忘了账号密码时）' },
      local: { type: 'boolean', description: '用本机免密槽（仅生成它的那台电脑/用户可用）' },
      target: { type: 'string', description: '解包目录（不传且 inPlace=false 时仅列包信息）' },
      inPlace: { type: 'boolean', description: '是否按分区映射还原到原位（写前会先把原目录改名 .bak-<时间戳>）' },
      only: { type: 'array', items: { type: 'string' }, description: '仅处理这些分区 id（如 01-dsh-home）' },
      list: { type: 'boolean', description: '只列包信息（不解密落盘）' },
    },
    required: ['package'],
    outputSchema: { type: 'string' },
    async execute(args) {
      const password = resolvePassword(args.password)
      const argv = ['--package', args.package]
      if (args.list) argv.push('--list')
      else {
        if (!password && !args.local && !args.recoveryCode) {
          return '缺少凭证：请传 password（或用 recoveryCode / local；未加密包不需要凭证）'
        }
        // 审查 B14：密码不进 argv（走环境变量）；账号 / 恢复码 / 本机免密走 argv（非秘密）
        if (args.account) argv.push('--account', args.account)
        if (args.recoveryCode) argv.push('--recovery-code', args.recoveryCode)
        if (args.local) argv.push('--local')
        if (args.inPlace) argv.push('--in-place')
        if (args.target) argv.push('--target', args.target)
        for (const o of args.only ?? []) argv.push('--only', o)
      }
      const r = await runNode(argv, password ? { DSHVAULT_PASSWORD: password } : {})
      return [`$ node vault-restore.mjs ${args.list ? '--list' : args.inPlace ? '--in-place' : '--target'}（exit ${r.code}）`, '```json', r.out.trim(), '```', r.err.trim() ? `stderr:\n${r.err.trim()}` : ''].filter(Boolean).join('\n')
    },
  }))

  // ────────────────────────────── vault_prune ──────────────────────────────
  ctx.tools.register(tool({
    name: 'vault_prune',
    description: '滚动保留：按 GFS（keepLast/keepDaily/keepWeekly/keepMonthly + 体积上限 + 最小保留数）算出保留与删除清单；默认 dry-run，apply=true 才执行（本地默认移入 _trash/）。',
    parameters: {
      dir: { type: 'string', description: `目录（缺省 ${DEFAULT_OUT_DIR}）` },
      apply: { type: 'boolean', description: 'true 才真正执行删除（默认 false = 只出清单）' },
      hardDelete: { type: 'boolean', description: 'true 直接删除（默认移入 _trash/）' },
      keepLast: { type: 'number', description: '保留最近 N 份' },
      maxTotalGB: { type: 'number', description: '总体积上限（GB）' },
    },
    outputSchema: { type: 'string' },
    async execute(args) {
      const dir = args.dir || outDir
      const policy = {
        keepLast: args.keepLast ?? 7,
        maxTotalGB: args.maxTotalGB ?? 200,
      }
      if (args.apply !== true) {
        const plan = planRetention(dir, policy)
        const lines = [
          `# vault_prune（dry-run）`,
          `逻辑包 ${plan.totalGroups} 个，共 ${human(plan.totalBytes)} → 保留 ${plan.keep.length} 个 / ${human(plan.keptBytes)}`,
          '',
          '| 动作 | 包 | 时间 | 体积 | 原因 |',
          '|---|---|---|---|---|',
        ]
        for (const g of plan.keep) lines.push(`| 保留 | ${g.key} | ${g.createdAt.toISOString()} | ${human(g.bytes)} | ${plan.reasons.get(g.parts[0].abs) ?? ''} |`)
        for (const g of plan.drop) lines.push(`| 删除 | ${g.key} | ${g.createdAt.toISOString()} | ${human(g.bytes)} | 不被保留策略覆盖 |`)
        lines.push('', '要真正执行请带 apply=true（本地默认移入 _trash/）。')
        return lines.join('\n')
      }
      const res = applyRetention(dir, policy, { dryRun: false, hardDelete: args.hardDelete === true })
      const lines = [`# vault_prune 执行结果`, `删除 ${res.plan.drop.length} 个逻辑包`]
      for (const a of res.actions) lines.push(`- ${a.action}: ${a.file}${a.error ? ` (${a.error})` : ''}`)
      if (res.actions.length === 0) lines.push('- 无需删除')
      return lines.join('\n')
    },
  }))

  // ── UI 面板通道（ADR-011）：host 单前缀路由 + client 面板 2s 轮询 ────────────
  // 服务获取用 ctx.get 可选方式（不写进 inject：缺 webServer 的组合里工具通道
  // 仍须可用；参考 super-injector/lib/index.js:9586 的 ctx.get 用法），
  // 路由注册签名照抄 super-injector/lib/index.js:9629-9631。
  // host 可能比本插件晚挂上 webServer（cordis 激活顺序）→ 轮询几次再放弃，
  // 避免「面板静默不出现」。为什么不学 workbuddy 把它写进 inject：那样会丢掉
  // 「没有 webServer 时 6 个工具照样可用」的降级能力（同 injectors 的教训：缺服务即整树失败）。
  const mountUi = () => {
    const webServer = ctx.get('webServer')
    if (!webServer || typeof webServer.register !== 'function') return false
    const api = createApi(ctx, { dshHome: home, outDir, log })
    ctx.effect(() => webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: (req, res) => api.handle(req, res),
    }), 'dsh-vault: api route')
    ctx.logger?.info?.(`[dsh-vault] UI 通道：${API_PREFIX}`)
    return true
  }
  if (!mountUi()) {
    // 首次没拿到 → 后台重试（最多约 7 秒）；仍失败只 warn，6 个工具不受影响
    ctx.effect(() => {
      let tries = 0
      const timer = setInterval(() => {
        tries += 1
        if (mountUi() || tries >= 10) {
          clearInterval(timer)
          if (tries >= 10) {
            ctx.logger?.warn?.('[dsh-vault] webServer 始终不可用：UI 通道跳过（vault_* 工具不受影响）')
          }
        }
      }, 700)
      return () => clearInterval(timer)
    }, 'dsh-vault: ui mount retry')
  }

  // ── 可选：定时自动备份（daemon-loop；默认关闭）─────────────────────────────
  // 配置：autoBackup: { enabled:true, dailyAt:"03:00", scope:"core", outDir:"G:\\DSH-Backup",
  //                    prune:true, keepLast:7, includeP1:false, account:"", recoveryCode:null }
  // 设计：用「本机免密」槽打包 → 定时任务**不必在配置里存密码**；
  //       到点后当天首次检查即执行（因此重启/关机错过也能补跑一次），去重靠 schedule.json。
  const ab = config.autoBackup ?? {}
  if (ab.enabled === true) {
    const schedFile = join(state, 'schedule.json')
    let want = String(ab.dailyAt ?? '03:00')
    // 格式校验（GLM-5.3 审查 B-7）：原实现用 Number() 把 "25:00"/"3am" 静默变成 0 点 ——
    // 用户以为设了时间、实际行为完全不同。不合规就回退 03:00 并明确 warn。
    if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(want)) {
      ctx.logger?.warn?.(`[dsh-vault] autoBackup.dailyAt 格式不合法（"${want}"）—— 已回退 03:00；请用 HH:MM（00:00–23:59）`)
      want = '03:00'
    }
    const tick = async () => {
      try {
        const now = new Date()
        const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
        const [wh, wm] = want.split(':').map((x) => Number(x) || 0)
        const nowMin = now.getHours() * 60 + now.getMinutes()
        const last = readJsonSafe(schedFile, null)
        if (nowMin < wh * 60 + wm || last?.lastDate === today) return

        atomicWriteJson(schedFile, { lastDate: today, at: isoNow(), phase: 'running' })
        ctx.logger?.info?.(`[dsh-vault] 定时备份开始（${want} / scope=${ab.scope ?? 'core'}）`)
        const r = await runBackup({
          encrypt: true,
          deviceSlot: true,                     // 本机免密：定时任务不需要密码
          account: ab.account ?? '',
          recoveryCode: ab.recoveryCode ?? null,
          outDir: ab.outDir ?? outDir,
          scope: ab.scope ?? 'core',
          includeP1: ab.includeP1 === true,
          onlyParts: Array.isArray(ab.onlyParts) && ab.onlyParts.length > 0 ? ab.onlyParts : undefined,
          kind: 'full',
          dshHome: home,
        }, (m) => ctx.logger?.info?.(`[dsh-vault] ${m}`))

        let pruned = null
        if (ab.prune === true) {
          const dir = ab.outDir ?? outDir
          const plan = applyRetention(
            dir,
            { ...(ab.policy ?? {}), keepLast: ab.keepLast ?? 7, minKeep: ab.minKeep ?? 1 },
            { dryRun: false, hardDelete: false },    // 默认移入 _trash（可回滚），不硬删
          )
          pruned = { moved: plan.actions.filter((a) => a.action === 'moved-to-trash').length, kept: plan.plan.keep.length }
        }
        atomicWriteJson(schedFile, {
          lastDate: today, at: isoNow(), phase: 'done',
          baseName: r.baseName, bytes: r.totalBytes, parts: r.parts.length, pruned,
        })
        ctx.logger?.info?.(`[dsh-vault] 定时备份完成：${r.baseName}（${human(r.totalBytes)}）${pruned ? `；保留策略移动 ${pruned.moved} 个旧包入 _trash` : ''}`)
      } catch (e) {
        // ⚠️ 失败也必须写 lastDate（当日放弃）（GLM-5.3 审查 S-D，已核实为真 bug）：
        // 原实现只写 {at, phase:'failed'}，于是 60s 后 lastDate !== today 又成立 → 立刻全量重试；
        // G 盘掉线 / 磁盘满 这类持续故障会变成「每分钟一次全扫描 + 打包 + 失败」的风暴。
        try {
          const prevFail = readJsonSafe(schedFile, null)     // last 是 try 内的变量，catch 里够不到 → 就地再读一次
          atomicWriteJson(schedFile, {
            lastDate: today, at: isoNow(), phase: 'failed',
            error: String(e?.message ?? e), failCount: Number(prevFail?.failCount ?? 0) + 1,
          })
        } catch { /* 忽略 */ }
        ctx.logger?.warn?.(`[dsh-vault] 定时备份失败（当日不再重试）：${e?.message ?? e}`)
      }
    }
    ctx.effect(() => {
      // 检查周期可配（autoBackup.intervalMs）——生产默认 60s；测试用它把周期压到几百毫秒，
      // 才能真观察到「第二次 tick 是否被去重挡住」（GLM-5.3 审查：原来用例只等 1.5s，
      // 而周期是 60s，无论去重逻辑在不在都通过 = 自证式测试）
      const everyMs = Number(ab.intervalMs) > 0 ? Math.max(200, Number(ab.intervalMs)) : 60_000
      const t = setInterval(() => { void tick() }, everyMs)
      void tick()                                // 加载时先检查一次（错过时间点也能补跑）
      return () => clearInterval(t)
    }, 'dsh-vault: auto backup')
    ctx.logger?.info?.(`[dsh-vault] 定时自动备份已启用：每天 ${want}（本机免密槽；去重记录 ${schedFile}）`)
  } else {
    ctx.logger?.info?.('[dsh-vault] 定时自动备份：未启用（配置 autoBackup.enabled=true 开启）')
  }

  ctx.logger?.info?.(`[dsh-vault] 已加载：out=${outDir}，state=${state}，工具 6 个（scan/backup/list/verify/restore/prune）`)
  log(`loaded out=${outDir} host=${hostSlug()} dsh=${findDshInstall().version ?? 'unknown'}`)
  void ctx
}
