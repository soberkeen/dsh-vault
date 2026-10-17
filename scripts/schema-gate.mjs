#!/usr/bin/env node
/**
 * schema-gate.mjs — 工具 schema 合规门禁（P0 防线，零依赖）
 *
 * 背景（2026-10-15 事故）：本插件为「零依赖」手写了工具构造器并裸注册，
 * 产出的 function schema 含非法构造 —— 属性节点内写布尔 `required`，
 * 且早期版本缺顶层 `type:'object'`。该 schema 会原样进入每次模型请求的
 * `tools[].function.parameters`，导致：
 *   DeepSeek → 400 `false is not of type "array"` / `got 'type: null'`
 *   mimo     → 400 `Invalid request parameters`
 *   即：整个会话不可用。
 *
 * 本门禁把「注册前必校验」变成可执行步骤：mock 一个 ctx，调用插件 apply()
 * 收集它注册的全部工具，然后按 JSON Schema / function calling 元规则逐条校验。
 * 任何一条不合规 → exit 1（并打印违规路径）。
 *
 * 用法：node scripts/schema-gate.mjs   （CI/提交前/注册前都跑）
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const ALLOWED_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'])
const BANNED_KEYS = ['$ref', 'definitions', '$defs', 'oneOf', 'anyOf', 'allOf', 'not', 'if', 'then', 'else']

const violations = []
const warn = []
const report = (p, msg) => violations.push(`${p}: ${msg}`)

/** 递归校验一个 JSON Schema 节点（针对 function calling 的元规则）。 */
function validateNode(node, path, { isRoot = false } = {}) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    report(path, `必须是对象节点，实际是 ${Array.isArray(node) ? 'array' : typeof node}`)
    return
  }
  if (Object.hasOwn(node, 'required') && typeof node.required !== 'string' && !Array.isArray(node.required)) {
    report(path, `required 只能出现在 object 节点且必须是字符串数组，实际是 ${JSON.stringify(node.required)}`)
  }
  for (const k of BANNED_KEYS) {
    if (Object.hasOwn(node, k)) report(path, `包含不受支持的构造 ${k}（部分 OpenAI 兼容端点会 400）`)
  }
  if (node.type !== undefined) {
    if (typeof node.type !== 'string') report(path, `type 必须是字符串，实际是 ${JSON.stringify(node.type)}`)
    else if (!ALLOWED_TYPES.has(node.type)) report(path, `type 非法值 "${node.type}"`)
  }
  if (isRoot) {
    if (node.type !== 'object') report(path, `顶层 type 必须是 "object"，实际是 ${JSON.stringify(node.type ?? null)}（DeepSeek 会报 type: null）`)
    if (!Object.hasOwn(node, 'additionalProperties')) warn.push(`${path}: 建议显式声明 additionalProperties（DeepSeek/mimo 对开放对象容忍度不同）`)
  }
  if (node.description !== undefined && typeof node.description !== 'string') {
    report(path, 'description 必须是字符串')
  }
  if (node.type === 'array' || Object.hasOwn(node, 'items')) {
    if (node.items === undefined) report(path, 'array 节点缺少 items')
    else validateNode(node.items, `${path}.items`)
  }
  if (node.properties !== undefined) {
    if (node.type !== 'object') report(path, 'properties 只能出现在 object 节点上')
    if (node.properties === null || typeof node.properties !== 'object' || Array.isArray(node.properties)) {
      report(path, 'properties 必须是对象')
    } else {
      for (const [key, child] of Object.entries(node.properties)) {
        validateNode(child, `${path}.properties.${key}`)
      }
    }
  }
  if (Array.isArray(node.required)) {
    const props = node.properties ?? {}
    for (const key of node.required) {
      if (typeof key !== 'string') report(path, `required 数组元素必须是字符串，实际 ${JSON.stringify(key)}`)
      else if (!Object.hasOwn(props, key)) report(path, `required 里的 "${key}" 不在 properties 中`)
    }
  }
}

/** 收集插件注册的工具（不碰真实宿主、不写真实 state）。 */
async function collectTools() {
  const fakeHome = mkdtempSync(join(tmpdir(), 'vault-gate-'))
  const tools = []
  const ctx = {
    tools: { register(def) { tools.push(def); return () => {} } },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    get: () => null,              // webServer 可选：路由接线走降级分支
    effect(fn) { fn?.(); return () => {} },
    on() {},
    plugin() { return { dispose: async () => {} } },
  }
  const mod = await import(new URL('../lib/index.js', import.meta.url).href)
  mod.apply(ctx, { dshHome: fakeHome })
  rmSync(fakeHome, { recursive: true, force: true })
  return tools
}

function validateTool(t) {
  if (typeof t?.name !== 'string' || t.name.trim() === '') report(`${t?.name ?? '<unnamed>'}`, 'name 缺失或非字符串')
  if (typeof t?.description !== 'string' || t.description.trim() === '') report(t?.name, 'description 缺失（模型可见，必填）')
  if (typeof t?.execute !== 'function') report(t?.name, 'execute 缺失或非函数')
  if (!t?.output || typeof t.output.render !== 'function') report(t?.name, 'output.render 缺失')
  validateNode(t?.parameters, `${t?.name}.parameters`, { isRoot: true })
}

const tools = await collectTools()
console.log(`=== dsh-vault 工具 schema 门禁（收集到 ${tools.length} 个工具）===`)

if (tools.length === 0) {
  report('<plugins>', 'apply() 未注册任何工具 —— 装配链路可能已损坏')
}

for (const t of tools) {
  const before = violations.length
  validateTool(t)
  const ok = violations.length === before
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${t.name}`)
  if (!ok) {
    for (const v of violations.slice(before)) console.log(`        → ${v}`)
  }
}

// 必填语义回归：凡在顶层声明了 required 的工具，execute({}) 必须被运行时校验拦下。
// （防的是"schema 合法但运行时校验被绕过"这一类回归）
for (const t of tools) {
  const req = Array.isArray(t?.parameters?.required) ? t.parameters.required : []
  if (req.length === 0) continue
  try {
    await t.execute({})
    report(t.name, `顶层 required=${JSON.stringify(req)} 但 execute({}) 未抛错 —— 运行时必填校验缺失`)
  } catch (e) {
    const msg = String(e?.message ?? '')
    if (!msg.includes('缺少必填参数')) report(t.name, `execute({}) 抛错信息不符（期望"缺少必填参数"）：${msg}`)
    else console.log(`PASS  ${t.name} 必填语义（${req.join(', ')}）`)
  }
}

if (warn.length > 0) {
  console.log('--- 提醒 ---')
  for (const w of warn) console.log(`  ! ${w}`)
}

console.log('')
if (violations.length > 0) {
  console.log(`=== 门禁拒绝：${violations.length} 处违规（这些 schema 会进入每次模型请求，必须修完才能注册）===`)
  process.exit(1)
}
console.log(`=== 门禁通过：${tools.length} 个工具的 parameters 均为合法 function schema（顶层 object / required 为顶层数组 / 无非法构造）===`)
