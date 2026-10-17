/**
 * filter.js — 四层排除规则（AGENT.md / ADR-006 + ADR-008）
 *
 *  L1 视频      扩展名 + 魔数双判（裸 .ts 必须过 0x47 且 >1MB，防误杀 TypeScript）
 *  L2 依赖/虚拟环境  node_modules/.venv/venv/site-packages/__pycache__/...
 *  L3 构建产物/缓存  dist/build/out/obj/target/.next/.cache/tmp/.work/.mimocode/logs/...
 *  L4 AI 运行时/模型 runtime/ + *.pth/*.pt/*.ckpt/*.onnx/*.safetensors/*.gguf
 *     大二进制兜底：单文件 > 200 MB 且扩展名 ∈ {.dll .exe .bin .zip .gz .msi .iso .pkg}
 *  E8「备份的备份」命名：backup|bak|archive|old|回收站|迁移包|_备份（默认排除）
 *
 * 纪律：排除必须带证据（命中哪条规则），写进 manifest.excluded[]，不要静默丢弃。
 */

export const VIDEO_EXT = new Set([
  '.mp4', '.mkv', '.mov', '.avi', '.flv', '.wmv', '.webm', '.m4v', '.rmvb', '.rm',
  '.mpg', '.mpeg', '.3gp', '.vob', '.m2ts', '.f4v', '.mts', '.asf', '.ogv', '.divx',
  '.mxf', '.mpv', '.m2v', '.dav', '.ts',
])

export const DEP_DIRS = new Set([
  'node_modules', '.venv', 'venv', 'site-packages', '__pycache__', '.pnpm-store',
  '.yarn', '.gradle', '.nuget', '.cargo', '.tox', '.bundle',
  // ⚠️ 审查风格条：`env` 与 `vendor` 已移出本集合 —— 普通项目里的 `env/`（配置）、
  // `vendor/`（自研三方代码）是**正经内容**，一刀切会把它们整树排除。
  // 真要排 Python 虚拟环境时应命中 `.venv` 或 `venv`（上面已有）。
])

export const BUILD_DIRS = new Set([
  'dist', 'build', 'out', 'obj', 'target', '.next', '.nuxt', '.dart_tool', '.cache',
  'cache', 'Cache', 'tmp', 'temp', 'Temp', '_staging', '.work', '.mimocode', '.idea',
  '.vs', '.vscode', '.pytest_cache', '.mypy_cache', '.turbo', '.parcel-cache', 'logs',
])

// E8「备份的备份」——修正（审查 B6）：原实现用一条宽正则同时匹配**文件名**，
// 结果把 old-notes.md / backup-plan.md / config-old.yaml 这类正经文档当垃圾排除。
// 现在拆两条：目录名可以宽（backups/、old/、回收站/），文件名只认**明确的备份产物后缀**。
export const BACKUP_DIR_RE = /(^|[_\-. ])(backup|backups|bak|archive|old|trash|recycle|回收站|迁移包|备份)([_\-.\/]|$)/i
// 文件名必须是**备份产物**才排除：明确后缀，或 bak/backup + 至少 4 位数字（日期/序号），或 _8位以上数字。
// —— 不能只认 "backup-" 前缀，否则 backup-plan.md 这类正经文档会被误杀（B6 二次修正）
export const BACKUP_FILE_RE = /\.(bak|old|orig|save|copy)$|(^|[_\-. ])(bak|backup)[-_.]?\d{4,}([_\-.]|$)|_[0-9]{8,}([_\-.]|$)/i

export const MODEL_EXT = new Set(['.pth', '.pt', '.ckpt', '.onnx', '.safetensors', '.gguf', '.pb', '.tflite', '.h5'])

/** 图片 / 设计稿 —— 操作者口径是「工作区只排除视频」，所以这些属**该备份的非视频内容**。 */
export const IMAGE_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff',
  '.psd', '.ai', '.sketch', '.fig', '.heic', '.avif', '.raw', '.cr2', '.nef',
])

export const TEXT_EXT = new Set([
  '.md', '.markdown', '.txt', '.rst', '.org', '.tex', '.log', '.csv', '.tsv',
  '.py', '.pyi', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.vue', '.svelte',
  '.ps1', '.psm1', '.psd1', '.sh', '.bash', '.zsh', '.fish', '.bat', '.cmd', '.fish',
  '.json', '.jsonc', '.json5', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.env',
  '.xml', '.html', '.htm', '.css', '.scss', '.less', '.sql', '.graphql', '.proto',
  '.rs', '.go', '.java', '.kt', '.c', '.h', '.hpp', '.cpp', '.cc', '.cs', '.php', '.rb',
  '.lua', '.pl', '.r', '.jl', '.swift', '.dart', '.sol', '.asm', '.cmake', '.dockerfile',
  '.gitignore', '.gitattributes', '.editorconfig', '.npmrc', '.nvmrc',
  '.ipynb', '.lock', '.sum', '.patch', '.diff',
])

export const DOC_EXT = new Set(['.docx', '.xlsx', '.pptx', '.pdf', '.odt', '.ods', '.odp', '.rtf', '.epub'])
export const AUDIO_EXT = new Set(['.wav', '.flac', '.mp3', '.aac', '.m4a', '.ogg', '.opus', '.ape', '.wma', '.aiff'])
export const ARCHIVE_BIN_EXT = new Set(['.zip', '.gz', '.rar', '.7z', '.tar', '.bz2', '.xz', '.iso', '.msi', '.pkg', '.dmg', '.exe', '.dll', '.bin', '.cab', '.lz4', '.zst'])

/** 视频魔数判定（扩展名不可信：.ts 可能是 TypeScript 源码）。 */
export function isVideoMagic(head) {
  if (!head || head.length < 4) return false
  const b = head
  // MP4/MOV: ....ftyp
  if (b.length >= 8 && b.subarray(4, 8).toString('latin1') === 'ftyp') return true
  // Matroska/WebM: 1A 45 DF A3
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return true
  // AVI: RIFF....AVI
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'AVI ') return true
  // FLV
  if (b.subarray(0, 3).toString('latin1') === 'FLV') return true
  // ASF/WMV: 30 26 B2 75 8E 66 CF 11
  if (b[0] === 0x30 && b[1] === 0x26 && b[2] === 0xb2 && b[3] === 0x75) return true
  // MPEG-TS: 0x47 sync at 0 and (188 | 192 | 204)
  if (b[0] === 0x47) return true
  // Ogg
  if (b.subarray(0, 4).toString('latin1') === 'OggS') return false // 音频容器，交音频规则处理
  return false
}

export function extOf(name) {
  const i = name.lastIndexOf('.')
  return i <= 0 ? '' : name.slice(i).toLowerCase()
}

export function isVideoName(name) {
  const e = extOf(name)
  if (!VIDEO_EXT.has(e)) return false
  if (e === '.ts') return false // 裸 .ts 一律交给魔数判定（TypeScript 误杀教训）
  return true
}

/** 路径是否落在 git 忽略语义的目录里（本地粗判；精确判定由 .gitignore 解析补充）。 */
export function dirHit(relPath, set) {
  const parts = relPath.split('/')
  for (let i = 0; i < parts.length - 1; i++) {
    if (set.has(parts[i])) return parts[i]
  }
  return null
}

/**
 * 单条目判定。
 * @returns {{ tier: 'P0'|'P1'|'P2', rule: string, reason: string, score: number }}
 */
export function classifyEntry(entry, ctx = {}) {
  const name = entry.name ?? entry.rel.split('/').pop()
  const rel = entry.rel
  const ext = extOf(name)
  const size = entry.size ?? 0
  // 兼容两种调用形态：classifyEntry(entry, {options}) 或 classifyEntry(entry, opts)
  // ⚠️ 修正记录：原实现只读 ctx.options，而 scan.js 传的是 opts 本身 →
  // 分区级豁免（allowBigBin / keepModels / keepBackupOfBackup）全部静默失效，
  // 表现为「00-installer 安装包被 L4-bigbin 误杀成 0 文件」（dry 预览暴露）。
  const opts = ctx.options ?? ctx ?? {}

  if (entry.isDir) {
    const depHit = DEP_DIRS.has(name)
    if (depHit) return { tier: 'P2', rule: 'L2-dep', reason: `虚拟环境/依赖目录 ${name}/`, score: -70 }
    const buildHit = BUILD_DIRS.has(name)
    if (buildHit) return { tier: 'P2', rule: 'L3-cache', reason: `构建产物/缓存目录 ${name}/`, score: -60 }
    if (name === 'runtime') return { tier: 'P2', rule: 'L4-runtime', reason: 'AI 运行时目录 runtime/', score: -60 }
    if (BACKUP_DIR_RE.test(name) && !opts.keepBackupOfBackup) {
      return { tier: 'P2', rule: 'E8-backup-dir', reason: `目录名是备份语义 ${name}/`, score: -30 }
    }
    return { tier: 'P1', rule: 'dir-neutral', reason: '普通目录（内容按文件判定）', score: 0 }
  }

  // 目录层排除的外溢（文件级再判一次，保证父目录未展开时也正确）
  const depDir = dirHit(rel, DEP_DIRS)
  if (depDir) return { tier: 'P2', rule: 'L2-dep', reason: `位于依赖目录 ${depDir}/ 内`, score: -70 }
  const buildDir = dirHit(rel, BUILD_DIRS)
  if (buildDir) return { tier: 'P2', rule: 'L3-cache', reason: `位于缓存目录 ${buildDir}/ 内`, score: -60 }

  if (isVideoName(name)) return { tier: 'P2', rule: 'L1-video', reason: `视频扩展名 ${ext}`, score: -55 }
  if (ext === '.ts' && entry.videoMagic) return { tier: 'P2', rule: 'L1-video-magic', reason: 'MPEG-TS 魔数命中且 >1MB', score: -55 }

  if (MODEL_EXT.has(ext)) {
    const lookTrain = /(^|\/)(train|self|my|finetune|finetuned|checkpoints?|my-models?)(\/|$)/i.test(rel)
    if (lookTrain || opts.keepModels) {
      return { tier: 'P0', rule: 'L4-exception', reason: `模型权重但在例外清单（${ext}）`, score: 20 }
    }
    return { tier: 'P2', rule: 'L4-model', reason: `模型权重 ${ext}（可重新下载）`, score: -60 }
  }

  if (entry.videoMagic && size > 1024 * 1024) {
    return { tier: 'P2', rule: 'L1-video-magic', reason: '视频魔数命中（扩展名未标）', score: -55 }
  }

  if (AUDIO_EXT.has(ext) && size > 50 * 1024 * 1024) {
    return { tier: 'P2', rule: 'E6-audio-big', reason: `音频 > 50 MB（${ext}）`, score: -55 }
  }

  if (!opts.allowBigBin && size > 200 * 1024 * 1024 && ARCHIVE_BIN_EXT.has(ext)) {
    // allowBigBin：分区级豁免（00-installer 的安装包 275.9 MB 属刚需，被这条兜底误杀过一次）
    return { tier: 'P2', rule: 'L4-bigbin', reason: `大二进制 > 200 MB（${ext}）`, score: -40 }
  }

  if (entry.gitignored) return { tier: 'P2', rule: 'E1-gitignore', reason: '.gitignore 命中', score: -50 }

  if (!opts.keepBackupOfBackup) {
    // 目录名带备份语义（backups/、old/、回收站/ …）→ 整树排除
    const relStr = typeof entry.rel === 'string' ? entry.rel : ''
    const dirPart = relStr.includes('/') ? relStr.slice(0, relStr.lastIndexOf('/')) : ''
    if (dirPart && BACKUP_DIR_RE.test(dirPart)) {
      return { tier: 'P2', rule: 'E8-backup-dir', reason: `目录名是备份语义：${dirPart}`, score: -30 }
    }
    // 文件名只认明确的备份产物后缀：x.zip.bak / backup-2026.zip / dump_20260101.tar
    if (BACKUP_FILE_RE.test(name)) {
      return { tier: 'P2', rule: 'E8-backup-of-backup', reason: `备份产物命名 ${name}`, score: -30 }
    }
  }

  return null // 交给 importance.js 打分
}

/** 生成一份人类可读的排除规则摘要（写进包内 RESTORE/README.md）。 */
export function rulesSummary() {
  return [
    'L1 视频：' + [...VIDEO_EXT].join(' ') + '（裸 .ts 走魔数 0x47 判定）',
    'L2 依赖/虚拟环境：' + [...DEP_DIRS].join(' '),
    'L3 构建产物/缓存：' + [...BUILD_DIRS].join(' '),
    'L4 AI 运行时/模型：runtime/ ' + [...MODEL_EXT].join(' ') + ' + >200MB 的 {.dll .exe .bin .zip .gz .msi .iso .pkg}',
    'E8 备份的备份：目录名 ' + String(BACKUP_DIR_RE) + '；文件名 ' + String(BACKUP_FILE_RE),
  ].join('\n')
}
