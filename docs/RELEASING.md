# dsh-vault 发布清单

## 环境（已配好，一次性）

| 项 | 值 | 校验 |
|---|---|---|
| npm 账号 | `soberkeen` | `npm whoami` |
| npm scope | `@soberkeen`（首发自动创建） | — |
| GitHub 账号 | `soberkeen`（泠风） | `gh auth status` |
| GitHub 仓库 | https://github.com/soberkeen/dsh-vault | `gh repo view soberkeen/dsh-vault` |
| 发布源目录 | `I:\DSH 工作区\DSH完美备份计划\release\dsh-vault` | 与开发源 `src\dsh-vault` **分离**，避免改名破坏现役运行副本 |
| 2FA | npm 账号已开 → 发布必须 Automation Token | 见下 |

## 发布流程

```powershell
cd 'I:\DSH 工作区\DSH完美备份计划\release\dsh-vault'

# 1) 从开发源同步（改了 src 之后）
#    robocopy ..\..\src\dsh-vault . /E /XD node_modules .git /XF *.tgz

# 2) 改版本号
#    package.json → "version"

# 3) 自检（prepublishOnly 也会自动跑，但先跑一遍省得白等）
npm run check
node scripts/client-register-test.mjs      # 必须 8/8

# 4) 确认包里有关键文件（缺 cordis.patch.yml = 装上不装配）
npm pack --dry-run | Select-String 'cordis.patch.yml|total files'

# 5) 提交并推送
git add -A
git commit -m "chore: release v<ver>"
git push

# 6) 发布 npm
#    2FA 账号：先取 Automation Token，写进临时 .npmrc
npm publish --access public

# 7) GitHub Release
gh release create v<ver> --title "v<ver>" --notes "..."
```

## 2FA：Automation Token 用法

```powershell
# 临时 .npmrc（用完立刻删）
"//registry.npmjs.org/:_authToken=<TOKEN>" | Set-Content -Path .npmrc -Encoding ASCII
npm publish --access public
Remove-Item .npmrc -Force
```

**不要**把 token 写进 `~/.npmrc`（长期留在磁盘）或任何入库文件。

## 发布后验证（必做，别省）

```powershell
# ① registry 上确实有
npm view @soberkeen/dsh-vault version dist.tarball

# ② 从 npm 装到干净 profile（这是对「发布成功」的真正检验）
& "<DSH>\resources\runtime\cli\bin\dsh.cmd" plugin --profile compat add @soberkeen/dsh-vault

# ③ 起来后看设置左栏有没有「备份」，点进去五个标签都能切
```

## 踩过的坑（发布相关）

| 坑 | 现象 | 正解 |
|---|---|---|
| `files` 只写 `lib` | npm 包里没有 `cordis.patch.yml` → 别人装上去**不装配**、设置里看不到分区 | `files` 必须含 `cordis.patch.yml`；用 `npm pack --dry-run` 确认 |
| 包内模块 id 与包名不一致 | `__ModuleLoader__.load({id})` 与 package.json 的 name 不同 → DSH 找不到模块 | 改名时全局替换 `lib/*.js` 里的 id、API 前缀、cordis entry name（本仓库改了 7 处：`client.js` L9/L22、`index.js` L2/L29、`server.js` L39/L198、`pack.js` L147） |
| 测试脚本硬编码包名 | 改名后契约测试 FAIL 2 | 改成从 `package.json` 读（本仓库已改） |
| npm 收 403 2FA | `Two-factor authentication or granular access token with bypass 2fa enabled is required` | 用 Automation Token（Classic）或 Granular 带 bypass 2FA |
| 无 scope 的 `dsh-vault` | 已被他人占用（1.10.75） | 用 `@soberkeen/dsh-vault` |
| 在开发源里原地改名 | 破坏现役运行副本的 `@dsh-external/dsh-vault` 引用 | 发布用独立目录 `release/dsh-vault` |

## 版本约定

- `0.2.x` → 修 bug、UI 微调
- `0.3.0` → 新增工具或新增备份分区
- `1.0.0` → RESTORE 包格式（`manifest.json` 的 `formatVersion`）冻结
