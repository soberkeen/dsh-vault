/**
 * tar.js — 自实现 tar（ustar + GNU LongLink），零外部依赖
 *
 * 为什么自实现：本机实测无 7z/zip/gpg/openssl/rclone，且需求是「任意电脑任意 DSH 都能用」，
 * 因此只用 Node 内置模块；tar 又必须保留，因为恢复端可用系统 tar/7z/资源管理器手工解包。
 * 写入格式被 bsdtar / GNU tar / 7-Zip 兼容（含长路径 GNU LongLink 'L'）。
 */
import { createReadStream, statSync } from 'node:fs'
import { sleep } from './io.js'

const BLOCK = 512

function padOctal(value, len) {
  const s = value.toString(8)
  if (s.length >= len) {
    // ⚠️ 审查 B11：原实现静默截断高位 —— ≥8 GiB 的文件会让 tar 头 size 字段回绕，
    // 造成条目整体错位（与 ⑦ 号事故同类的触发面）。超界宁可报错，也不产出坏包。
    throw new Error(`tar: 数值 ${value} 超出 ustar 八进制字段上限（${len} 位字段）—— 该文件过大，需改用 base-256 扩展格式`)
  }
  return s.padStart(len - 1, '0') + '\0'
}

/** 组装一个 512 字节 tar 头。 */
export function makeHeader({ name, size = 0, mtimeMs = Date.now(), mode = 0o644, type = '0', linkname = '' }) {
  const buf = Buffer.alloc(BLOCK)
  const writeStr = (str, off, len) => {
    const b = Buffer.from(str, 'utf8')
    b.copy(buf, off, 0, Math.min(b.length, len))
  }
  writeStr(name.slice(0, 100), 0, 100)
  writeStr(padOctal(mode & 0o7777, 8), 100, 8)
  writeStr(padOctal(0, 8), 108, 8)      // uid
  writeStr(padOctal(0, 8), 116, 8)      // gid
  writeStr(padOctal(size, 12), 124, 12)
  writeStr(padOctal(Math.max(0, Math.floor(mtimeMs / 1000)), 12), 136, 12)
  writeStr('        ', 148, 8)          // chksum 占位（8 空格）
  writeStr(type, 156, 1)
  writeStr(linkname.slice(0, 100), 157, 100)
  writeStr('ustar\0', 257, 6)
  writeStr('00', 263, 2)
  writeStr('vault', 265, 32)
  writeStr('vault', 297, 32)

  let sum = 0
  for (let i = 0; i < BLOCK; i++) sum += buf[i]
  const chk = sum.toString(8).padStart(6, '0')
  writeStr(chk + '\0 ', 148, 8)
  return buf
}

function longLinkBlocks(path) {
  const data = Buffer.concat([Buffer.from(path, 'utf8'), Buffer.from([0])])
  const head = makeHeader({ name: '././@LongLink', size: data.length, type: 'L', mode: 0o644 })
  const padded = padTo(data, BLOCK)
  return [head, padded]
}

function padTo(buf, unit) {
  const rem = buf.length % unit
  if (rem === 0) return buf
  return Buffer.concat([buf, Buffer.alloc(unit - rem)])
}

/** 把一个 Buffer 切成 unit 对齐的块（尾块补零）。 */
export function chunkToBlocks(buf, unit = BLOCK) {
  const padded = padTo(buf, unit)
  const out = []
  for (let i = 0; i < padded.length; i += unit) out.push(padded.subarray(i, i + unit))
  return out
}

/**
 * 写 tar 流：entries 为异步/同步可迭代的条目
 *   { rel, abs, isDir, size, mtimeMs, mode? }
 * 产出 Buffer 序列（可直接喂给 gzip / 写盘）。
 */
export async function* tarWrite(entries, hooks = {}) {
  const onPartial = hooks.onPartial
  for await (const e of entries) {
    // 热点文件（sessions/storages/plugin-data/logs 且最近 2 分钟被写过）：写头前短复检一次，
    // 取最新 size —— 这是 ADR-007「稳定读」在打包侧的落地，降低把"写入中间态"带进包的概率。
    if (e.hot && !e.isDir && e.abs) {
      await sleep(150)
      try {
        const st = statSync(e.abs)
        if (st.size !== e.size) {
          onPartial?.({ rel: e.rel, reason: `hot 文件 size 变化 ${e.size} → ${st.size}（已按最新值写入）` })
          e.size = st.size
          e.mtimeMs = st.mtimeMs
        }
      } catch { /* 文件消失：保持原 size，读取阶段会补零并回报 partial */ }
    }
    const name = e.isDir ? e.rel.replace(/\/?$/, '/') : e.rel
    const nameBytes = Buffer.byteLength(name, 'utf8')
    if (nameBytes > 100) yield* longLinkBlocks(name)
    // 按**字节**截断（GLM-5.3 审查 B-8）：name.slice(0,60) 切的是 UTF-16 字符 —— 60 个中文
    // 字符 = 180 字节，仍超头字段 100 字节上限，写出来的是坏数据（有 LongLink 兜底才没坏结构）。
    let headName = name
    if (nameBytes > 100) {
      const b = Buffer.from(name, 'utf8').subarray(0, 90)   // 留余量
      let n = b.length
      while (n > 0 && (b[n - 1] & 0xc0) === 0x80) n--        // 别切出半个多字节字符
      headName = b.subarray(0, n).toString('utf8')
    }
    yield makeHeader({
      name: headName,
      size: e.isDir ? 0 : (e.size ?? 0),
      mtimeMs: e.mtimeMs ?? Date.now(),
      mode: e.mode ?? (e.isDir ? 0o755 : 0o644),
      type: e.isDir ? '5' : '0',
    })
    if (e.isDir) continue
    // 合成条目（内存数据：包内 RESTORE/ 文档、manifest 等）
    if (e.data !== undefined) {
      const buf = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), 'utf8')
      yield* chunkToBlocks(buf)
      continue
    }
    // 文件数据：**必须按 scan 时声明的 size 精确读取**（end 为 inclusive）。
    // ⚠️ 事故记录：原实现 createReadStream(abs) 无上界，若文件在 scan 之后被追加
    // （DSH 正在写的 session.v4.jsonl.zstd、日志等），流会读到新 EOF → 实际写入字节
    // 多于头部声明 size → **后续所有 tar 条目整体错位**，只在恢复时才暴露。
    // 2026-10-15 真实 1.1 GB core 包实测踩到：解包 1217 文件后 tar 校验和失配。
    let remaining = e.size ?? 0
    if (remaining > 0 && e.abs) {
      try {
        const stream = createReadStream(e.abs, { start: 0, end: remaining - 1, highWaterMark: 1024 * 1024 })
        for await (const chunk of stream) {
          remaining -= chunk.length
          yield chunk
        }
      } catch (err) {
        // ⚠️ 审查 B12：scan 之后文件被删除/轮转（DSH 的 session 文件是常态）会抛 ENOENT，
        // 原实现让**整个备份作废**。现在按短读处理：补零 + 记 partial，其它分区不受影响。
        onPartial?.({ rel: e.rel, reason: `读取中断（${err?.code ?? err?.message}），剩余 ${Math.max(0, remaining)} B 将补零` })
      }
      if (remaining > 0) {
        // 文件比 scan 时短（被截断/替换/删除）：补零保持 tar 结构合法，并回报 partial
        yield Buffer.alloc(remaining)
        onPartial?.({ rel: e.rel, reason: `读取少于声明 size（差 ${remaining} B），已补零` })
      }
      const tail = (e.size ?? 0) % BLOCK
      if (tail !== 0) yield Buffer.alloc(BLOCK - tail)
    }
  }
  yield Buffer.alloc(BLOCK * 2) // 结束标记
}

/** 拉取式字节读取器：把 async iterable 变成 read(n)/skip(n)。 */
export class ByteReader {
  constructor(source) {
    this.iter = source[Symbol.asyncIterator]()
    this.buf = Buffer.alloc(0)
    this.done = false
  }

  async pull() {
    if (this.done) return false
    const { value, done } = await this.iter.next()
    if (done) { this.done = true; return false }
    this.buf = this.buf.length === 0 ? value : Buffer.concat([this.buf, value])
    return true
  }

  async read(n) {
    while (this.buf.length < n) {
      const ok = await this.pull()
      if (!ok) return null
    }
    const out = this.buf.subarray(0, n)
    this.buf = this.buf.subarray(n)
    return out
  }

  async skip(n) {
    let left = n
    while (left > 0) {
      if (this.buf.length === 0) {
        const ok = await this.pull()
        if (!ok) return false
      }
      const take = Math.min(left, this.buf.length)
      this.buf = this.buf.subarray(take)
      left -= take
    }
    return true
  }
}

function parseOctal(buf) {
  if (!buf || buf.length === 0) return 0
  const s = buf.toString('latin1').replace(/\0.*$/, '').trim()
  if (s === '') return 0
  const v = parseInt(s, 8)
  return Number.isFinite(v) ? v : 0
}

function checksumOk(block) {
  let sum = 0
  for (let i = 0; i < BLOCK; i++) {
    sum += (i >= 148 && i < 156) ? 0x20 : block[i]
  }
  const stored = parseOctal(block.subarray(148, 156))
  return stored === sum
}

/**
 * 读 tar 流：产出 `{ rel, isDir, size, mtimeMs, mode, body: AsyncGenerator<Buffer> }`。
 * 调用方必须完整消费 body（或调用 skipBody）才能继续下一个条目。
 */
/**
 * tar 流读取器 —— **测试用低层直读**：boundary-test / restore-drill / robust-test 用它逐条校验
 * 头字段与载荷；生产还原链路走包内的自包含还原器 `RESTORE/vault-restore.mjs`（跨机不依赖本插件）。
 *
 * 注：GLM-5.3 审查把本函数列为「host 侧未使用的死代码」，复核后**不成立** —— 它有三个测试调用者，
 * 删掉会直接打断低层回归，故保留并在此注明定位。
 */
export async function* tarRead(source) {
  const reader = new ByteReader(source)
  let pendingLongName = null

  for (;;) {
    const block = await reader.read(BLOCK)
    if (!block) return
    if (block.every((b) => b === 0)) {
      // 结束块（可能是两块中的第一块）
      const maybe = await reader.read(BLOCK)
      if (!maybe || maybe.every((b) => b === 0)) return
      // 非全零 → 继续按该块解析（容错：有些写入器只补一块）
      yield* handleBlock(maybe, reader, pendingLongName)
      pendingLongName = null
      continue
    }
    if (!checksumOk(block)) throw new Error('tar: 校验和不匹配（文件可能被截断或非 tar 格式）')

    const type = String.fromCharCode(block[156])
    const size = parseOctal(block.subarray(124, 136))
    let name = block.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    const prefix = block.subarray(345, 500).toString('utf8').replace(/\0.*$/, '')
    if (prefix) name = prefix.replace(/\/$/, '') + '/' + name

    if (type === 'L') { // GNU LongLink
      const data = await reader.read(size)
      await reader.skip(padTo(Buffer.alloc(0), 1).length) // no-op，保持结构清晰
      const tailPad = (BLOCK - (size % BLOCK)) % BLOCK
      if (tailPad) await reader.skip(tailPad)
      pendingLongName = data ? data.subarray(0, size - 1).toString('utf8') : name
      continue
    }

    if (pendingLongName) { name = pendingLongName; pendingLongName = null }

    // 尾部 padding
    let consumed = 0n
    const body = (async function* () {
      let left = size
      while (left > 0) {
        const chunk = await reader.read(Math.min(left, 1024 * 1024))
        if (!chunk) throw new Error(`tar: 条目 ${name} 数据不完整`)
        left -= chunk.length
        consumed += BigInt(chunk.length)
        yield chunk
      }
      const tailPad = (BLOCK - (size % BLOCK)) % BLOCK
      if (tailPad) await reader.skip(tailPad)
    })()

    const isDir = type === '5'
    yield { rel: isDir ? name.replace(/\/$/, '') : name, isDir, size, mtimeMs: parseOctal(block.subarray(136, 148)) * 1000, mode: parseOctal(block.subarray(100, 108)), body }
    if (isDir) continue
    // 若调用方未消费 body，这里会等待；消费完后再读下一个头
    await drain(body)
  }
}

async function drain(gen) {
  // body 生成器是惰性的：调用方若没读，drain 会把它读完（避免阻塞读取下一个头）
  try {
    for await (const _ of gen) { /* 丢弃 */ }
  } catch { /* 已抛错则忽略 */ }
}

async function* handleBlock(block, reader, pendingLongName) {
  // 简化：非零的“结束块后数据”按普通条目解析一次（极少出现，容错用）
  const type = String.fromCharCode(block[156])
  const size = parseOctal(block.subarray(124, 136))
  let name = block.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
  if (pendingLongName) name = pendingLongName
  const body = (async function* () {
    let left = size
    while (left > 0) {
      const chunk = await reader.read(Math.min(left, 1024 * 1024))
      if (!chunk) return
      left -= chunk.length
      yield chunk
    }
    const tailPad = (BLOCK - (size % BLOCK)) % BLOCK
    if (tailPad) await reader.skip(tailPad)
  })()
  yield { rel: name, isDir: type === '5', size, mtimeMs: 0, mode: 0o644, body }
}
