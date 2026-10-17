#!/bin/bash
# dsh-vault build：本插件是「零编译」形态（lib/ 即源码，纯 ESM JS，不 import 任何非 node: 内置模块）。
#
# 为什么不走 tsc：宿主是 Electron 安装版（app.asar），本机没有 dsh 源码 checkout（无 packages/），
# 也没有全局 tsc/tsdown/pnpm；而插件要「装到任意电脑的任意 DSH 都能用」——零编译 = 零构建依赖。
# 本脚本只做语法与结构自检（node --check），保证注入前不会因语法错误炸掉宿主加载器。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

fail=0
check() {
  if ! node --check "$1" 2>&1; then
    echo "FAIL: $1" >&2
    fail=1
  else
    echo "OK:   $1"
  fi
}

check lib/index.js
for f in lib/vault/*.js lib/vault/*.mjs; do
  check "$f"
done

if [ ! -f package.json ]; then
  echo "FAIL: package.json 缺失" >&2
  fail=1
fi
if [ ! -f lib/vault/portable-restore.mjs ]; then
  echo "FAIL: lib/vault/portable-restore.mjs 缺失（包内还原器，必需）" >&2
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "=== build 失败 ===" >&2
  exit 1
fi

# ── schema 门禁（P0 防线，ADR-012）───────────────────────────────────────────
# 手写工具 schema 若含非法构造（属性内布尔 required / 缺顶层 type:'object'），
# 会原样进入每次模型请求，导致 DeepSeek 与 mimo 会话直接 400。注册前必过。
echo "=== schema 门禁（工具 parameters 必须为合法 function schema）==="
if ! node scripts/schema-gate.mjs; then
  echo "FAIL: schema 门禁未通过 —— 非法 schema 会让会话 400，禁止注册" >&2
  exit 1
fi

echo "=== build 通过（零编译形态，lib/ 直接可注入；schema 门禁已过）==="
