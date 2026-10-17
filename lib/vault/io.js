/**
 * io.js — 稳定读 / 遍历 / 哈希 / 原子写
 *
 * 一致性依据（AGENT.md / ADR-007 + D17）：
 *  正在写入的文件（DSH 会话 .jsonl.zstd、storages/*.json）采用「稳定读」：
 *  连续两次采样（间隔 300 ms）size+mtime 一致才收录；3 次仍抖动则收录并标 partial。
 */
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, openSync, readSync, closeSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function ensureDir(p) {
  mkdirSync(p, { recursive: true })
  return p
}

/** 稳定读：两次采样一致才返回，最多尝试 3 轮。 */
export async function stableStat(abs, { tries = 3, gapMs = 300 } = {}) {
  let last = null
  for (let i = 0; i < tries; i++) {
    let st
    try { st = statSync(abs) } catch { return null }
    const sig = `${st.size}:${st.mtimeMs}`
    if (last && last.sig === sig) return { stat: st, partial: false }
    last = { sig, stat: st }
    await sleep(gapMs)
  }
  return last?.stat ? { stat: last.stat, partial: true } : null
}

/** 读文件头部 N 字节（魔数判定用）。 */
export function readHead(abs, n = 16) {
  let fd = -1
  try {
    fd = openSync(abs, 'r')
    const buf = Buffer.alloc(n)
    const read = readSync(fd, buf, 0, n, 0)
    return buf.subarray(0, read)
  } catch {
    return Buffer.alloc(0)
  } finally {
    if (fd >= 0) closeSync(fd)
  }
}

export async function sha256File(abs) {
  return new Promise((resolvePromise, reject) => {
    const h = createHash('sha256')
    const s = createReadStream(abs)
    s.on('data', (c) => h.update(c))
    s.on('error', reject)
    s.on('end', () => resolvePromise(h.digest('hex')))
  })
}

/** 目录遍历：产出相对路径条目（跳过符号链接环、不跟随 junction）。 */
export function walk(root, { onError } = {}) {
  const out = []
  const stack = [root]
  const seen = new Set()
  while (stack.length > 0) {
    const dir = stack.pop()
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch (e) {
      onError?.(dir, e)
      continue
    }
    for (const ent of entries) {
      const abs = join(dir, ent.name)
      let rel
      try { rel = relative(root, abs).split(sep).join('/') } catch { continue }
      let st = null
      try { st = statSync(abs) } catch (e) { onError?.(abs, e); continue }
      if (ent.isDirectory()) {
        // 循环保护：junction/符号链接目录可能成环
        const key = abs.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        out.push({ abs, rel, isDir: true, size: 0, mtimeMs: st.mtimeMs, mode: st.mode })
        stack.push(abs)
      } else if (ent.isFile()) {
        out.push({ abs, rel, isDir: false, size: st.size, mtimeMs: st.mtimeMs, mode: st.mode })
      }
      // 其它类型（socket/fifo/符号链接文件）跳过
    }
  }
  return out
}

/** 原子写：先写 .tmp 再 rename（远端/本地落地都用）。 */
export function atomicWriteFile(abs, data) {
  ensureDir(dirname(abs))
  const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, data)
  renameSync(tmp, abs)
}

export function atomicWriteJson(abs, value) {
  atomicWriteFile(abs, JSON.stringify(value, null, 2))
}

export function readJsonSafe(abs, fallback = null) {
  try { return JSON.parse(readFileSync(abs, 'utf8')) } catch { return fallback }
}

export function rmIfExists(p) {
  try { rmSync(p, { recursive: true, force: true }) } catch { /* 忽略 */ }
}

export function fileSizeSafe(p) {
  try { return statSync(p).size } catch { return 0 }
}

export function exists(p) {
  return existsSync(p)
}

/** 写流（分卷落地用），返回 { stream, close }。 */
export function openWriteStream(abs) {
  ensureDir(dirname(abs))
  const stream = createWriteStream(abs)
  return stream
}

/** 人类可读体积。 */
export function human(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = bytes
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`
}

/** 时间戳：备份包命名用（本地时间）。 */
export function stamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

export function isoNow() {
  return new Date().toISOString()
}
