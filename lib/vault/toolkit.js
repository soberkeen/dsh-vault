/**
 * toolkit.js — 零依赖工具定义构造器
 *
 * 为什么不 import '@deepseek-ai/dsh-tools' 的 defineTool：
 *  插件经 junction/link 注入后，Node 从 realpath 出发解析 import，祖先目录里
 *  不一定有 @deepseek-ai/*；为保证「任意电脑任意 DSH 都能加载」，本插件
 *  不引入任何非 node: 内置的模块。工具定义按 dsh-tools 的注册契约手工构造：
 *    { name, description, parameters(JSON Schema), output: { schema, render }, execute }
 *  （super-injector 的 defineTool 产物形状即此，见其 lib/index.js:4067）
 */

/** 归一化 parameters：调用方既可给完整 JSON Schema（含 type:'object'），
 *  也可给裸 properties 字典（本插件各工具的写法）。归一化做两件事：
 *  1. 补顶层 type:'object' —— DeepSeek 等 API 对 function schema 强制要求顶层
 *     type 为 'object'，缺失会直接 400（"got 'type: null'"）。
 *  2. 把属性里的布尔 required 提升成顶层数组 —— JSON Schema 的 required
 *     只能是字符串数组且只出现在 object 节点上，属性内写 required:false
 *     会被 DeepSeek 元 schema 拒绝（"false is not of type \"array\""），
 *     mimo（Xiaomi OpenAI 兼容端点）同样以 400 Invalid request parameters 拒绝。
 */
function normalizeParameters(raw) {
  let schema
  if (raw == null) schema = { type: 'object', properties: {} }
  else if (raw.type === 'object') schema = { ...raw, properties: { ...(raw.properties ?? {}) } }
  else schema = { type: 'object', properties: { ...raw } }

  const hoisted = []
  for (const [key, spec] of Object.entries(schema.properties ?? {})) {
    if (spec == null || typeof spec !== 'object') continue
    if (!Object.hasOwn(spec, 'required')) continue
    if (spec.required === true) {
      // 布尔形态必填**非法**（DeepSeek/mimo 会 400）→ 剔掉并提升到顶层数组
      const { required: _omit, ...rest } = spec
      hoisted.push(key)
      schema.properties[key] = rest
    }
    // ⚠️ 数组形态的 required 是**对象子 schema 的合法写法**：原样保留，不发一言地删掉它会
    //    悄悄吃掉合法 schema（跨模型审查的风格条）。
  }
  const declared = Array.isArray(schema.required) ? schema.required : []
  const merged = [...new Set([...declared, ...hoisted])]
  if (merged.length > 0) schema.required = merged
  else delete schema.required
  if (schema.additionalProperties === undefined) schema.additionalProperties = false
  return schema
}

/** 把声明式必填（def.required: string[]）并入顶层 required 数组。
 *  必填只在顶层声明 —— 属性节点内写布尔 required 会让 DeepSeek/mimo 直接 400（见 ADR-012）。 */
function withRequired(schema, required) {
  if (!Array.isArray(required) || required.length === 0) return schema
  const merged = [...new Set([...(schema.required ?? []), ...required])]
  return { ...schema, required: merged }
}

/** 组装一个 registry-ready 工具定义。 */
export function tool(def) {
  const render = def.render ?? ((_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }])
  const t = {
    name: def.name,
    description: def.description,
    parameters: withRequired(normalizeParameters(def.parameters), def.required),
    output: { schema: def.outputSchema ?? { type: 'string' }, render },
    async execute(args, exec) {
      const a = args ?? {}
      const required = t.parameters.required ?? []
      for (const key of required) {
        if (a[key] === undefined) {
          throw new Error(`${def.name}: 缺少必填参数 ${key}`)
        }
      }
      return def.execute(a, exec)
    },
  }
  if (def.presentCall) t.presentCall = def.presentCall
  if (def.presentResult) t.presentResult = def.presentResult
  if (def.timeoutMs) t.timeoutMs = def.timeoutMs
  return t
}

/** 常用参数片段。**不产出布尔 required** —— 必填一律走顶层数组（ADR-012）。 */
export const P = {
  str(description) { return { type: 'string', description } },
  num(description) { return { type: 'number', description } },
  bool(description) { return { type: 'boolean', description } },
  strList(description) { return { type: 'array', items: { type: 'string' }, description } },
}
