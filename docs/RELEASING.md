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

# 6) 发布 npm —— 必须在真实终端窗口里跑（后台 job 无 TTY，必败）
#    账号 auth-and-writes，必须手动提供 6 位 TOTP（不能用恢复码：会触发 72h 只读冻结）
npm publish --access public --otp=<6位数字>

#    交互式入口（会自己拉 npm login，并停在 Enter OTP:）
#    C:\Users\sober\Desktop\一键发布npm.cmd

# 6b) GitHub Release 同时作为第二分发渠道
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

## npm 发布 404 全景（已解决 —— 2026-10-20 发布成功）

> **最终结果**：`@lingfengmow/dsh-vault@0.2.0` 已于 **2026-10-20T14:19:46.673Z**（北京 22:19）发布成功。
> 45 文件 / 解包 `532,247 B` / `shasum aa815b930a302d3327a786b9ddfa3e7813958032`（与本地 `npm pack` 逐字节一致）。
> registry 直查 → `name=@lingfengmow/dsh-vault`、`latest=0.2.0`、`maintainers=soberkeen`。
> **发布完成时 CLI 仍打印了 404** —— 那是假警报，见下面第 3 层。

### 三层真因（按发现顺序，每层都推翻了上一层的判断）

**第 1 层 —— 我用恢复码当 OTP，触发了 npm 的 72 小时只读冻结（真主因）**

2026-10-17 我把用户给的 2FA **恢复码**（32 字节 hex）当 `--otp` 传给 `npm publish`。恢复码格式被接受（错误码从 `403` 变成 `E404`，说明认证环节过了），但 npm 判定这是「安全敏感操作」，账号进入预防性只读：

```text
npm notice: Your account has been temporarily suspended due to a recent security-sensitive action.
npm error code E403
npm error 403 Forbidden - POST https://registry.npmjs.org/-/stage/package/@lingfengmow%2fdsh-vault
```

官方依据：
- [npm adds preventive account protection for high-impact accounts](https://github.blog/changelog/2026-06-25-npm-adds-preventive-account-protection-for-high-impact-accounts/)：「the account returns to normal automatically after 72 hours, with no re-confirmation step」
- [Recovering your 2FA-enabled account](https://docs.npmjs.com/recovering-your-2fa-enabled-account/)：「When you use a recovery code to log in, npm places a temporary 72-hour security hold on your account」

冻结期：`2026-10-17T13:14:50Z` → `2026-10-20T13:14:50Z`（北京 10-20 21:14）。
**冻结期内所有写操作都失败，但读操作（`whoami` / `org ls` / `stage list`）全部 200** —— 这就是为什么前面几轮排查一直误判「权限正常」。

> 教训一：**恢复码不是 OTP**。它只能用于登录恢复，不能当 `--otp` 提交；用了就冻结 72 小时。

**第 2 层 —— 2FA 状态被读错字段，导致误判「2FA 没开」**

`npm profile get tfa` 只取顶层字段，npm 返回的是嵌套对象，所以一直显示为空 → 我误判「账号没开 2FA，所以没 OTP 可给」。真实值：

```powershell
npm profile get --json | ConvertFrom-Json | Select-Object -ExpandProperty tfa
# { "pending": null, "mode": "auth-and-writes" }
```

> 教训二：查 npm 2FA 状态用 `npm profile get --json` 读 `.tfa.mode`，不要用 `npm profile get tfa`。

**第 3 层 —— 后台进程无 TTY，`npm login` 结构性走不通；且发布成功时 CLI 会误报 404**

解冻后旧 token 已作废（`E401 token invalid`），必须重新 `npm login`。从后台 job 启动 `npm login --auth-type=web` 的 debug log：

```text
83-110  GET https://registry.npmjs.org/-/v1/done?sessionId=***  → 202 × 28 次
111     GET https://registry.npmjs.org/-/v1/done?sessionId=***  → 404
112     verbose web login not supported, trying couch
        Username:            ← 退化成 2015 年的旧式问答登录，后台无 stdin，exit 1
```

`202` = 在等你点浏览器授权；`404` = 那个 web 会话过期（约 5 分钟）或没走完；随后 npm 判定 web 登录不可用，回退到 couch `Username:` 交互，后台没有 stdin 立即退出。

`npm` 源码 `C:\Program Files\nodejs\node_modules\npm\lib\utils\auth.js:8` 的 `otplease`：
`if (!process.stdin.isTTY || !process.stdout.isTTY) throw err` —— 只有 TTY 才进 web 流程。

> 教训三：**`npm login` 和 `npm publish --otp` 必须在真实终端窗口里跑**，不能用后台 job / Agent 工具调用。交付物是 `publish-manual.ps1` + `一键发布.cmd`（双击出真窗口）。

### 那个 404 到底是什么（关键结论）

**它在发布成功之后才出现。** 2026-10-20 22:19 那次运行：`npm publish` 打印 404，但 registry 上包已经在了，且 tarball 的 sha1 与本地 pack 完全一致。

所以「404 = 发布失败」是错的。实际是：**PUT 上传成功 → registry 写入成功 → CLI 后续某个步骤（access 设置 / 通知 / 版本确认）拿到 404 → CLI 把整次运行标成失败**。判断发布是否成功的唯一可靠依据是**直查 registry**：

```powershell
Invoke-RestMethod 'https://registry.npmjs.org/@lingfengmow%2Fdsh-vault' | Select-Object name,
  @{n='latest';e={$_.'dist-tags'.latest}},
  @{n='shasum';e={$_.versions.($_.'dist-tags'.latest).dist.shasum}}
```

> 教训四：**不要用 CLI 退出码判断 npm 发布成败**，直查 registry。

### 六轮错误码（历史记录）

| 轮 | 提供的凭据 | 结果 |
|---|---|---|
| 1 | 无 | `403` `Two-factor authentication or granular access token with bypass 2fa enabled is required` |
| 2 | Granular token（未勾 bypass 2FA） | `403` 同上 —— 2026-07 起 GAT bypass 2FA 已弃用 |
| 3 | 32 字节恢复码当 `--otp` | `E404`（触发 72h 冻结，见第 1 层） |
| 4 | 非 TTY（后台 job） | `EOTP This operation requires a one-time password` + web auth URL |
| 5 | TTY 走完浏览器授权 | `404 Not Found - PUT .../@lingfengmow%2fdsh-vault` |
| 6 | `npx npm@10 publish` | `404` `'@lingfengmow/dsh-vault@0.2.0' is not in this registry.` |
| 7 | **解冻后 TTY + authenticator 6 位 TOTP** | **发布成功**（CLI 仍打印 404，但 registry 已写入） |

### 逐项排除（每项都有实测）

| 怀疑项 | 测法 | 结果 |
|---|---|---|
| 权限不足 | `npm org ls lingfengmow` | `soberkeen - owner` ✓ |
| org 不存在 | `GET /-/org/lingfengmow/user` | `{"soberkeen":"owner"}` ✓ |
| 对照：假 org | `GET /-/org/fake-org-xyz-42/user` | `404 Scope not found` → 证明真 org 有效 |
| 包名被占 | 带 token 直 PUT 5 个不同名字 | **全部 401**（统一「要 OTP」，与名字无关） |
| token 无效 | 重新 `npm login` 后的新 token 重测 | 同样 401 ✓ |
| 网络拦截 | DNS → Cloudflare `104.16.9.34`；`proxy` = null；`GET /express` → 200 | 无代理、无改写 ✓ |
| PUT 被中间层改写 | PowerShell 直 PUT（不经过 npm） | **401** —— 服务端判的，不是中间层 ✓ |
| 客户端 bug | `npx npm@10 publish` | 同样 404（与版本无关） |
| `files` / tarball | `npm pack --dry-run` | 45 文件、含 `cordis.patch.yml` ✓ |

### user scope 发不了包 —— 必须建 org

`@soberkeen/dsh-vault` 发不上去（404）：**npm 的 user scope 不会自动创建**。要先在 https://www.npmjs.com/org/create 建一个同名 org（Free/Public plan），才能发 `@<scope>/*`。

### 发布后验证（每次发版必做）

```powershell
# ① registry 上确实有，且 shasum 与本地一致
Invoke-RestMethod 'https://registry.npmjs.org/@lingfengmow%2Fdsh-vault' | Select-Object name,
  @{n='latest';e={$_.'dist-tags'.latest}}

# ② 下载 tarball 核对关键文件（缺 cordis.patch.yml = 装上不装配）
$t = Join-Path $env:TEMP 'v.tgz'
Invoke-WebRequest 'https://registry.npmjs.org/@lingfengmow/dsh-vault/-/dsh-vault-0.2.0.tgz' -OutFile $t
tar -tzf $t | Select-String 'package/cordis.patch.yml|package/lib/client.js|package/lib/index.js'

# ③ 干净 profile 真装一次（这才是对「发布成功」的终检）
& "<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd" plugin --profile <干净profile> add "@lingfengmow/dsh-vault"
```
