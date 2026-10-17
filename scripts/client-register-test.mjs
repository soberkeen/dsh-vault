#!/usr/bin/env node
/**
 * client-register-test.mjs — 验证 client 半边的模块协议与 slot 注册契约
 *
 * 为什么能提前验证：DSH 的 client 半边靠 `window.__ModuleLoader__.load({ id, factory })`
 * 加载，factory 拿到一个 require；slot 注册的契约是
 *     slots.register(描述符, 渲染函数)   ← 两个参数；描述符没有 component 字段；渲染函数返回 React 元素
 * 这里用 mock 的 window/require/react/slots 把 client.js 真跑一遍，断言上述契约成立
 * ——不必等用户重启就能发现协议/契约错误（2026-10-16 三次空白/消失都是靠人眼发现的）。
 *
 * 用法：node scripts/client-register-test.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT = join(HERE, '..', 'lib', 'client.js')
// 期望的模块 id 不再硬编码 —— 从 package.json 读，改名后测试自动跟随
const PKG_NAME = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8')).name

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

// ── mock DSH client 宿主 ────────────────────────────────────────────────────
// 断言 0（前置静态检查）：模板字符串内不得出现**裸反引号**。
// 2026-10-17 事故：CSS 模板串的注释里写了 `.dsv-kv`（带反引号）→ 模板串提前终结
// → 被解析成 `.dsv - kv` → factory 物化时抛 ReferenceError: kv is not defined
// → **整个 web boot 拒绝启动**（DSH 弹「应用无法启动」）。
// `node --check` 抓不到（语法合法，错在运行期），所以这条必须在这里拦。
{
  const src = readFileSync(CLIENT, 'utf8')
  const lines = src.split('\n')
  const strays = []
  let inTpl = false
  let tplStart = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    for (let j = 0; j < line.length; j++) {
      const ch = line[j]
      if (ch === '\\') { j++; continue }                 // 跳过转义对
      if (ch === '`') {
        if (!inTpl) { inTpl = true; tplStart = i + 1 }    // 模板串开始
        else { inTpl = false }                           // 模板串结束
      }
    }
    // 若某行以 `;` 收尾且处于模板串内，却在行内又出现了反引号 → 记录
    // （实际判定交给下面的整体扫描：模板串内的裸反引号会让配对数为奇数）
  }
  // 更直接的判据：CSS 常量块内（`const CSS = \`` 到行首 `\`;`）出现反引号即违规
  const cssStart = lines.findIndex((l) => l.includes('const CSS = `'))
  if (cssStart >= 0) {
    for (let i = cssStart + 1; i < lines.length; i++) {
      if (/^`;\s*$/.test(lines[i])) break                     // 正常终结
      if (lines[i].includes('`')) { strays.push({ line: i + 1, text: lines[i].trim().slice(0, 90) }); break }
    }
  }
  check('0 CSS 模板字符串内无裸反引号（模板串会被提前终结 → factory 抛 ReferenceError）',
    strays.length === 0,
    strays.length ? `L${strays[0].line}: ${strays[0].text}` : '未发现裸反引号')
}

const registered = []
const reactCalls = []
const fakeReact = {
  createElement: (type, props, ...children) => {
    reactCalls.push(type)
    return { $$react: true, type, props: props ?? null, children }
  },
  useRef: (v) => ({ current: v ?? null }),
  useEffect: () => { /* mock：不执行副作用（避免碰 document） */ },
}
const fakeSlots = {
  injected: [],
  inject(slot, fn) { this.injected.push(slot); return fn() },
  register(desc, render) { registered.push({ desc, render }); return () => {} },
}
// apply 现在直接用 ctx.slots / ctx.locale 属性（不再用 ctx.get 兜底 —— 那会在服务未就绪时
// 拿到 undefined 并抛 "cannot get property ... without inject"）→ mock 必须提供这两个属性。
const localeReg = []
const fakeLocale = {
  register(ns, dicts) { localeReg.push({ ns, dicts }); return () => {} },   // 真实签名：返回 disposer
  bind(ns) { return (key) => `[${ns}.${key}]` },
}
let captured = null
const sandbox = {
  window: {
    __ModuleLoader__: {
      load(mod) {
        captured = mod
        const exports = mod.factory((name) => {
          if (name === 'react') return fakeReact
          throw new Error(`未预期的 require("${name}")（DSH 的 require 只保证提供已安装依赖）`)
        })
        mod.__exports = exports
      },
    },
    setInterval: () => 1,
    clearInterval: () => {},
  },
  console,
  setTimeout,
}
sandbox.globalThis = sandbox
sandbox.window.window = sandbox.window
vm.createContext(sandbox)

// ── 加载 client.js ─────────────────────────────────────────────────────────
const src = readFileSync(CLIENT, 'utf8')
try {
  vm.runInContext(src, sandbox, { filename: 'client.js' })
  check('1 client.js 能在 __ModuleLoader__ 协议下加载', captured !== null, captured ? `id=${captured.id}` : '未调用 load()')
} catch (e) {
  check('1 client.js 能在 __ModuleLoader__ 协议下加载', false, String(e?.message ?? e).slice(0, 120))
}

if (captured) {
  check('2 模块 id 正确', captured.id === PKG_NAME, `${captured.id}（package.json: ${PKG_NAME}）`)
  const ex = captured.__exports ?? {}
  check('3 导出 apply + inject', typeof ex.apply === 'function' && Array.isArray(ex.inject), `inject=${JSON.stringify(ex.inject)}`)

  // 真正调用 apply（用 mock ctx）
  try {
    ex.apply({
      get: (n) => (n === 'slots' ? fakeSlots : n === 'locale' ? fakeLocale : null),
      slots: fakeSlots,
      locale: fakeLocale,
      effect: (fn) => { fn(); return () => {} },
    })
    check('4 apply 成功执行且注册了 settings.section',
      fakeSlots.injected.includes('settings.section') && registered.length >= 1,
      `inject=[${fakeSlots.injected.join(',')}] register=${registered.length} locale 字典=${localeReg.length}`)
  } catch (e) {
    check('4 apply 成功执行且注册了 settings.section', false, String(e?.message ?? e).slice(0, 120))
  }

  const first = registered[0]
  if (first) {
    const d = first.desc ?? {}
    // 契约（skills-manager/src/client-types.ts + 其 lib/client.js 真实调用现场）：
    //   register({ name, id, order, label: () => string, icon: string, locale: string }, ComponentType)
    // 子代理实测 SlotCore.register：只有 key/id/order/label/priority 进 entry.options
    // （icon 会被丢弃 → 不写），locale 另存到 entry.locale —— 故只声明会被消费的字段。
    check('5 描述符字段正确（name/id/order/label/locale，且无 component/icon）',
      d.name === 'settings.section' && typeof d.id === 'string' && typeof d.order === 'number' &&
      typeof d.label === 'function' && d.locale === 'dsh-vault' &&
      !('component' in d) && !('icon' in d),
      JSON.stringify({ ...d, label: '<fn>' }))
    check('6 第 2 参是 React 组件本身（函数，不是工厂、不是对象）', typeof first.render === 'function',
      typeof first.render === 'function' ? `组件名=${first.render.name || '(匿名)'}` : `是 ${typeof first.render}`)
    try {
      const out = first.render()          // mock React 下调用组件 → 返回 mock 元素
      const okType = typeof out?.type === 'string' || typeof out?.type === 'function'
      check('7 组件调用返回 React 元素（不是 DOM、不是 {dispose}）',
        out !== null && typeof out === 'object' && out.$$react === true && okType,
        out?.$$react ? `React 元素 type=${typeof out.type === 'function' ? `${out.type.name}（组件）` : out.type}` : `返回的是 ${typeof out}`)
    } catch (e) {
      check('7 组件调用返回 React 元素（不是 DOM、不是 {dispose}）', false, String(e?.message ?? e).slice(0, 120))
    }
  }
}

const failed = results.filter((x) => !x.ok)
console.log('')
console.log(`=== ${results.length - failed.length}/${results.length} 通过 ===`)
if (failed.length > 0) {
  for (const f of failed) console.log(`  失败: ${f.name} — ${f.detail}`)
  process.exitCode = 1
}
