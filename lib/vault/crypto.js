/**
 * crypto.js — 分块 AEAD（AES-256-GCM）+ scrypt 密钥派生（AGENT.md / ADR-002）
 *
 * 明文流 → 每 8 MiB 一块 → AES-256-GCM(key, nonce = baseIV(8B) || counter(4B)) → [4B len][ct+16B tag]
 * 头部（明文，便于校验与恢复）由 pack.js 写入：magic + headerLen + header(JSON)。
 * 零外部依赖：只用 node:crypto。
 */
import { createCipheriv, createDecipheriv, randomBytes, scrypt, createHash } from 'node:crypto'
import { Transform } from 'node:stream'
import { promisify } from 'node:util'

const scryptAsync = promisify(scrypt)

export const MAGIC = 'DSHVAULT1'
export const CHUNK_SIZE = 8 * 1024 * 1024
export const KDF_DEFAULTS = { N: 32768, r: 8, p: 1, keyLen: 32 }

/** 生成加密参数（盐随机，写进明文头）。 */
export function newCryptoParams({ chunkSize = CHUNK_SIZE, kdf = KDF_DEFAULTS } = {}) {
  return {
    cipher: 'aes-256-gcm',
    chunkSize,
    kdf: { algo: 'scrypt', N: kdf.N, r: kdf.r, p: kdf.p, salt: randomBytes(32).toString('base64') },
    baseIV: randomBytes(8).toString('base64'),
  }
}

export async function deriveKey(password, params) {
  const salt = Buffer.from(params.kdf.salt, 'base64')
  // scrypt 的 maxmem 默认 32MB，N=32768*r=8 需要 ~32MB+，显式放宽
  const key = await scryptAsync(password, salt, params.kdf.keyLen ?? 32, {
    N: params.kdf.N,
    r: params.kdf.r,
    p: params.kdf.p,
    maxmem: 256 * 1024 * 1024,
  })
  return Buffer.from(key)
}

function nonceFor(baseIV, counter) {
  const n = Buffer.alloc(12)
  baseIV.copy(n, 0, 0, 8)
  n.writeUInt32BE(counter >>> 0, 8)
  return n
}

/**
 * 加密 Transform：输入明文 chunk，输出 [4B len][ciphertext+tag]。
 * 内部按 chunkSize 聚合，保证每块独立认证。
 */
export class EncryptTransform extends Transform {
  constructor(key, params) {
    super()
    this.key = key
    this.chunkSize = params.chunkSize ?? CHUNK_SIZE
    this.baseIV = Buffer.from(params.baseIV, 'base64')
    this.counter = 0
    this.pending = Buffer.alloc(0)
    this.hash = createHash('sha256')
    this.bytes = 0
  }

  _transform(chunk, _enc, cb) {
    try {
      this.hash.update(chunk)
      this.bytes += chunk.length
      this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk])
      while (this.pending.length >= this.chunkSize) {
        const block = this.pending.subarray(0, this.chunkSize)
        this.pending = this.pending.subarray(this.chunkSize)
        this.push(this.#seal(block))
      }
      cb()
    } catch (e) { cb(e) }
  }

  _flush(cb) {
    try {
      if (this.pending.length > 0) {
        this.push(this.#seal(this.pending))
        this.pending = Buffer.alloc(0)
      }
      cb()
    } catch (e) { cb(e) }
  }

  #seal(plain) {
    const iv = nonceFor(this.baseIV, this.counter++)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const ct = Buffer.concat([cipher.update(plain), cipher.final()])
    const tag = cipher.getAuthTag()
    const payload = Buffer.concat([ct, tag])
    const len = Buffer.alloc(4)
    len.writeUInt32LE(payload.length, 0)
    return Buffer.concat([len, payload])
  }

  /** 全流 sha256（写进 manifest，做二次完整性确认）。 */
  plainDigest() {
    return this.hash.digest('hex')
  }
}

/**
 * 解密 Transform：输入 [4B len][ct+tag] 流，输出明文。
 * 需要先把「加密时记录的」chunkSize 与 baseIV 从明文头里读出来。
 */
export class DecryptTransform extends Transform {
  constructor(key, params) {
    super()
    this.key = key
    this.chunkSize = params.chunkSize ?? CHUNK_SIZE
    this.baseIV = Buffer.from(params.baseIV, 'base64')
    this.counter = 0
    this.pending = Buffer.alloc(0)
    this.hash = createHash('sha256')
    this.bytes = 0
  }

  _transform(chunk, _enc, cb) {
    try {
      this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk])
      const maxFrame = this.chunkSize + 64
      for (;;) {
        if (this.pending.length < 4) break
        const len = this.pending.readUInt32LE(0)
        // ⚠️ 审查 S5：帧长必须设上限 —— 伪造的 4 字节头会让 pending 一直攒到 GB 级 → OOM
        if (len <= 16 || len > maxFrame) {
          throw new Error(`密文帧长度非法：${len}（允许 17..${maxFrame}）—— 包已损坏或被构造`)
        }
        if (this.pending.length < 4 + len) break
        const payload = this.pending.subarray(4, 4 + len)
        this.pending = this.pending.subarray(4 + len)
        const iv = nonceFor(this.baseIV, this.counter++)
        const ct = payload.subarray(0, payload.length - 16)
        const tag = payload.subarray(payload.length - 16)
        const decipher = createDecipheriv('aes-256-gcm', this.key, iv)
        decipher.setAuthTag(tag)
        const plain = Buffer.concat([decipher.update(ct), decipher.final()])
        this.hash.update(plain)
        this.bytes += plain.length
        this.push(plain)
      }
      cb()
    } catch (e) { cb(e) }
  }

  _flush(cb) {
    if (this.pending.length !== 0) {
      cb(new Error('crypto: 密文尾部残留字节，包可能被截断'))
      return
    }
    cb()
  }

  plainDigest() {
    return this.hash.digest('hex')
  }
}

/** 头部编解码（明文头：magic + 4B len + JSON）。 */
export function encodeHeader(header) {
  const json = Buffer.from(JSON.stringify(header), 'utf8')
  const magic = Buffer.from(MAGIC, 'latin1')
  const len = Buffer.alloc(4)
  len.writeUInt32LE(json.length, 0)
  return Buffer.concat([magic, len, json])
}

export const HEADER_OVERHEAD = MAGIC.length + 4

export function decodeHeader(buf) {
  if (buf.length < HEADER_OVERHEAD) throw new Error('vault: 头部太短')
  if (buf.subarray(0, MAGIC.length).toString('latin1') !== MAGIC) throw new Error('vault: magic 不匹配，不是 DSHVAULT 包')
  const len = buf.readUInt32LE(MAGIC.length)
  const json = buf.subarray(HEADER_OVERHEAD, HEADER_OVERHEAD + len).toString('utf8')
  return { header: JSON.parse(json), headerBytes: HEADER_OVERHEAD + len }
}

export function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex')
}
