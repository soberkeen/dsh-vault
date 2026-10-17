# dsh-vault 发布清单

## 环境（已配好，一次性）

| 项 | 值 | 校验 |
|---|---|---|
| npm 账号 | `soberkeen` | `npm whoami` |
| npm scope（org） | `@lingfengmow`（user scope `@soberkeen` 不能发布 → 已改建 org） | `npm org ls lingfengmow` |
| GitHub 账号 | `soberkeen`（泠风） | `gh auth status` |
| GitHub 仓库 | https://github.com/soberkeen/dsh-vault | `gh repo view soberkeen/dsh-vault` |
| 发布源目录 | `I:\DSH 工作区\DSH完美备份计划\release\dsh-vault` | 与开发源 `src\dsh-vault` **分离**，避免改名破坏现役运行副本 |
| 2FA | 已开 `auth-and-writes` | `npm profile get` |
| 分发渠道 | **GitHub**（npm 发布被 web-auth 缺陷阻塞，见文末） | — |

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

# 6) 发布 npm —— ⚠ 当前被 npm 侧阻塞，见文末「为什么 npm 发布一直 404」
#    账号已开 auth-and-writes，必须手动提供 6 位 TOTP（不能用恢复码）
npm publish --access public --otp=<6位数字>

# 6b) npm 不通时，GitHub 就是正式分发渠道（安装方命令不变）
#     安装方：dsh plugin add github:soberkeen/dsh-vault

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
npm view @lingfengmow/dsh-vault version dist.tarball

# ② 从 npm 装到干净 profile（这是对「发布成功」的真正检验）
& "<DSH>\resources\runtime\cli\bin\dsh.cmd" plugin --profile compat add @lingfengmow/dsh-vault

# ③ 起来后看设置左栏有没有「备份」，点进去五个标签都能切
```

## 踩过的坑（发布相关）

| 坑 | 现象 | 正解 |
|---|---|---|
| `files` 只写 `lib` | npm 包里没有 `cordis.patch.yml` → 别人装上去**不装配**、设置里看不到分区 | `files` 必须含 `cordis.patch.yml`；用 `npm pack --dry-run` 确认 |
| 包内模块 id 与包名不一致 | `__ModuleLoader__.load({id})` 与 package.json 的 name 不同 → DSH 找不到模块 | 改名时全局替换 `lib/*.js` 里的 id、API 前缀、cordis entry name（本仓库改了 7 处：`client.js` L9/L22、`index.js` L2/L29、`server.js` L39/L198、`pack.js` L147） |
| 测试脚本硬编码包名 | 改名后契约测试 FAIL 2 | 改成从 `package.json` 读（本仓库已改） |
| npm 收 403 2FA | `Two-factor authentication or granular access token with bypass 2fa enabled is required` | 用 Automation Token（Classic）或 Granular 带 bypass 2FA |
| 无 scope 的 `dsh-vault` | 已被他人占用（1.10.75） | 用 `@lingfengmow/dsh-vault` |
| 在开发源里原地改名 | 破坏现役运行副本的 `@dsh-external/dsh-vault` 引用 | 发布用独立目录 `release/dsh-vault` |
| npm 收 **404**（不是 403） | 走完浏览器授权（`/-/v1/done` 返回 **200**）后 PUT 仍 `404 Not Found` | 见文末完整归因；当前无解，改用 GitHub 分发 |
| 恢复码当 OTP | 32 字节 hex 传 `--otp` → 403 变 404，且**恢复码被消耗** | 恢复码不是 TOTP；只能用 authenticator 的 6 位数字 |
| 后台 job 跑 publish | `EOTP` —— npm 检测不到 TTY 就直接抛 | `otplease` 只在 `stdin`+`stdout` 都是 TTY 时才进 web 流程 |

## 版本约定

- `0.2.x` → 修 bug、UI 微调
- `0.3.0` → 新增工具或新增备份分区
- `1.0.0` → RESTORE 包格式（`manifest.json` 的 `formatVersion`）冻结

---

## 为什么 npm 发布一直 404（已实测归因）

**结论**：不是权限、不是 org、不是包名、不是 token、不是网络、不是客户端版本 ——
是 **npm 11 的 web 授权流程把「登录会话凭据」当成 OTP 塞进 publish 请求**，registry 不认，于是返回 404 而不是再问一次 401。

### 错误码演化（六轮）

| 轮 | 提供的凭据 | 结果 |
|---|---|---|
| 1 | 无 | `403` `Two-factor authentication or granular access token with bypass 2fa enabled is required` |
| 2 | Granular token（未勾 bypass 2FA） | `403` 同上 —— 2026-07 起 GAT bypass 2FA 已弃用 |
| 3 | 32 字节恢复码当 `--otp` | `E404`（且恢复码被消耗） |
| 4 | 非 TTY（后台 job） | `EOTP This operation requires a one-time password` + web auth URL |
| 5 | TTY 走完浏览器授权（点了 Authorize） | `404 Not Found - PUT .../@lingfengmow%2fdsh-vault` |
| 6 | `npx npm@10 publish` 走同样流程 | `404` `'@lingfengmow/dsh-vault@0.2.0' is not in this registry.` |

### 决定性 debug log

`C:\Users\sober\AppData\Local\npm-cache\_logs\2026-10-17T13_14_50_399Z-debug-0.log`：

```text
32 http fetch PUT 401 ...                        ← 首请求要 OTP
33 verbose web auth opening url pair             ← 开浏览器授权
34-41 http fetch GET 202 /-/v1/done?authId=***   ← 轮询等你点（8 次）
42 http fetch GET 200 /-/v1/done?authId=***      ← 点了 Authorize，授权成功
43 verbose web auth done-check finished
44 http fetch PUT 404 ...                        ← 拿会话凭据当 otp 重试 → 404
```

第 42 行 200 说明**授权真的成功了**；第 44 行 404 说明 registry **不认那个"otp"**。

npm 源码：`C:\Program Files\nodejs\node_modules\npm\lib\utils\auth.js:8` 的 `otplease` ——
`if (!process.stdin.isTTY || !process.stdout.isTTY) throw err`，只有 TTY 才进 web 流程，而 web 流程的返回值被当成 otp 用。

### 逐项排除（每项都有实测）

| 怀疑项 | 测法 | 结果 |
|---|---|---|
| 权限不足 | `npm org ls lingfengmow` | `soberkeen - owner` ✓ |
| org 不存在 | `GET /-/org/lingfengmow/user` | `{"soberkeen":"owner"}` ✓ |
| 对照：假 org | `GET /-/org/fake-org-xyz-42/user` | `404 Scope not found` → 证明真 org 有效 |
| 包名被占 | 带 token 直 PUT 5 个不同名字 | **全部 401**（统一「要 OTP」，与名字无关） |
| token 无效 | 重新 `npm login` 后的新 token 重测 | 同样 401 ✓ |
| 网络拦截 | DNS → Cloudflare `104.16.9.34`；`proxy` = null；`GET /express` → 200 | 无代理、无改写 ✓ |
| PUT 被中间层改写 | PowerShell 直 PUT `probe-put-test`（不经过 npm） | **401** —— 服务端判的，不是中间层 ✓ |
| 客户端 bug | `npx npm@10 publish` | 同样 404（与版本无关） |
| `files` / tarball | `npm pack --dry-run` → 44 文件、含 `cordis.patch.yml` | 包体正常 ✓ |

### 唯一可能有效的做法

```powershell
npm publish --access public --otp=<authenticator 里当前的 6 位数字>
```

走 classic OTP 校验，绕开 web-auth 那条坏路。前提：npm 账号绑过 authenticator app。

**2026-10-17 决定放弃 npm 首发** —— GitHub 安装完全等价，`lib/` 是纯 ESM 源码兼产物，装下来即可运行。
