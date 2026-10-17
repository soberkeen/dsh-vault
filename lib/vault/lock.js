/**
 * lock.js — 单实例互斥锁（审查 B9）
 *
 * 问题：备份/清理没有互斥，两个任务同时跑会共用 `_staging` 与「秒级同名包」，
 * 互相 rmSync/renameSync 覆盖；索引文件 read-modify-write 也会丢记录。
 *
 * 实现：`<stateDir>/<name>.lock`，用 O_EXCL 独占创建（跨进程原子）。
 * 陈旧锁自动回收：持有者进程已死，或锁龄超过 staleMs（默认 6 小时）。
 */
import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { ensureDir } from './io.js'

export class LockBusyError extends Error {
  constructor(message) {
    super(message)
    this.name = 'LockBusyError'
  }
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e?.code === 'EPERM'   // EPERM = 进程存在但无权限（仍算活着）
  }
}

/** 本进程的启动时刻（ms）。 */
export const thisPidStart = Math.round(Date.now() - process.uptime() * 1000)

/**
 * 查任意进程的启动时刻（ms）；查不到返回 null（调用方按「保守认定活着」处理）。
 *
 * 为什么要它（GLM-5.3 审查 B-4，已核实）：Windows 的 PID 复用很激进 —— 持有者崩溃后
 * pid 可能立刻被新进程占用，`isAlive` 于是误判「持有者还活着」，备份会被 LockBusyError
 * 挡到 staleMs（6 小时）超时。比对该 pid **现在的启动时刻**与锁里记录的启动时刻，
 * 不一致即说明 pid 被复用 → 锁其实是陈旧的。
 */
export function pidStartTime(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    if (process.platform === 'win32') {
      const ps = `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Subtract([datetime]'1970-01-01').TotalMilliseconds`
      const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 20000 })
      if (r.status !== 0) return null
      const v = Number(String(r.stdout).trim())
      return Number.isFinite(v) ? Math.round(v) : null
    }
    // Linux/macOS：/proc/<pid>/stat 第 22 字段是 starttime（jiffies），配 /proc/uptime 换算
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)
    const startTicks = Number(fields[19])
    const upSec = Number(readFileSync('/proc/uptime', 'utf8').split(/\s+/)[0])
    if (!Number.isFinite(startTicks) || !Number.isFinite(upSec)) return null
    return Math.round(Date.now() - (upSec - startTicks / 100) * 1000)
  } catch {
    return null
  }
}

/**
 * 获取独占锁。
 * @returns {() => void} 释放函数（幂等）
 * @throws {LockBusyError} 已有活跃持有者
 */
export function acquireLock(stateDirectory, name, { staleMs = 6 * 3600_000 } = {}) {
  ensureDir(stateDirectory)
  const file = join(stateDirectory, `${name}.lock`)
  const payload = JSON.stringify({ pid: process.pid, pidStart: thisPidStart, at: new Date().toISOString(), name })

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(file, 'wx')          // wx = O_CREAT|O_EXCL：跨进程原子
      writeFileSync(fd, payload)
      closeSync(fd)
      let released = false
      return () => {
        if (released) return
        released = true
        try { unlinkSync(file) } catch { /* 已被清掉：忽略 */ }
      }
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e

      let info = null
      try { info = JSON.parse(readFileSync(file, 'utf8')) } catch { /* 半截/损坏：按陈旧处理 */ }
      const ageMs = info?.at ? Date.now() - Date.parse(info.at) : Infinity
      const alive = info?.pid ? isAlive(info.pid) : false
      // pid 复用检测（GLM-5.3 审查 B-4）：pid 活着但**启动时刻对不上** → 是别的进程占了这个
      // pid、原持有者已死 → 同样按陈旧锁回收。查不到启动时刻时保守当活着（不误抢）。
      let pidReused = false
      if (alive && typeof info?.pidStart === 'number') {
        const nowStart = pidStartTime(info.pid)
        if (nowStart !== null && Math.abs(nowStart - info.pidStart) > 2000) pidReused = true
      }

      if (!alive || pidReused || ageMs > staleMs) {
        // 陈旧锁（持有者已退出 / 太久没动）→ 回收后重试
        try { unlinkSync(file) } catch { /* 竞态：别人先清了，下一轮自然成功 */ }
        continue
      }
      throw new LockBusyError(
        `另一个任务正在运行：${file}（pid=${info?.pid ?? '?'}，开始于 ${info?.at ?? '?'}，约 ${Math.round(ageMs / 1000)}s 前）`,
      )
    }
  }
  throw new LockBusyError(`无法取得锁：${file}（多次重试仍被占用）`)
}

/** 便捷包装：拿到锁执行 fn，结束（含抛错）必释放。 */
export async function withLock(stateDirectory, name, fn, options) {
  const release = acquireLock(stateDirectory, name, options)
  try {
    return await fn()
  } finally {
    release()
  }
}
