# publish-manual.ps1 — 手动发布 dsh-vault 到 npm（交互式，自己输 6 位 OTP）
#
# 为什么必须你自己在这个终端里跑：
#   npm 11 在非交互进程（后台 job、没有 stdin 的管道）里遇到 2FA 时，会改走浏览器
#   web-auth 授权；那条路径返回的是登录会话凭据、被当作 OTP 塞进 PUT，registry
#   不认 → 404。在**你自己的终端窗口**里跑，npm 会直接提示 "Enter OTP:"，你敲 6 位
#   数字，走的是 classic OTP 校验，能成。
#
# 用法：在 pwsh 里执行  .\publish-manual.ps1
#       或右键本文件 →「使用 PowerShell 运行」（想让它不闪退，用方式一）

$ErrorActionPreference = 'Continue'
$PkgDir = 'I:\DSH 工作区\DSH完美备份计划\release\dsh-vault'
Set-Location $PkgDir

function Line($t) { Write-Host ''; Write-Host ('=' * 64) -ForegroundColor DarkGray; Write-Host $t -ForegroundColor Cyan; Write-Host ('=' * 64) -ForegroundColor DarkGray }

Line '[1/6] 环境'
Write-Host ('  node    : ' + (& node -v))
Write-Host ('  npm     : ' + (& npm -v))
Write-Host ('  目录    : ' + (Get-Location).Path)

$pkg = Get-Content package.json -Raw | ConvertFrom-Json
Write-Host ('  name    : ' + $pkg.name) -ForegroundColor Yellow
Write-Host ('  version : ' + $pkg.version) -ForegroundColor Yellow

Line '[2/6] 登录（先登录，否则查不到 2FA 状态）'
$who = (& npm whoami 2>$null)
if (-not $who) {
  Write-Host '  未登录 → 即将拉起 npm login（浏览器里点一下 Authorize）' -ForegroundColor Yellow
  & npm login --auth-type=web
  $who = (& npm whoami 2>$null)
}
if (-not $who) {
  Write-Host '  ✗ 登录失败，终止。先单独跑一次  npm login --auth-type=web' -ForegroundColor Red
  exit 1
}
Write-Host ('  已登录为 : ' + $who) -ForegroundColor Green

Line '[3/6] 2FA 状态（发布强制要求开着）'
$profRaw = (& npm profile get --json 2>&1) -join ''
$tfaMode = $null
try { $tfaMode = ($profRaw | ConvertFrom-Json).tfa.mode } catch {}
if ([string]::IsNullOrWhiteSpace($tfaMode)) { $tfaMode = '(读取失败)' }
Write-Host ('  two-factor auth : ' + $tfaMode)
if ($profRaw -match 'E401|authenticate|token seems to be invalid') {
  Write-Host ''
  Write-Host '  ✗ 凭据失效（E401）。先跑一次  npm login --auth-type=web  再重跑本脚本。' -ForegroundColor Red
  exit 1
}
if ($tfaMode -match 'disabled|^false$|读取失败') {
  Write-Host ''
  Write-Host '  ✗ 2FA 没开。npm 现在强制发布必须过 2FA，没开一定 403。' -ForegroundColor Red
  Write-Host '    去这里开，选 "Authentication and Publishing"，用 authenticator app 扫码：' -ForegroundColor Yellow
  Write-Host '    https://www.npmjs.com/settings/soberkeen/tfa' -ForegroundColor Yellow
  Write-Host '    扫完手机 app 里会出现一条 npm，之后每次发布它会跳 6 位数字。' -ForegroundColor Yellow
  Write-Host '    开好后再跑一次本脚本。' -ForegroundColor Yellow
  exit 1
}

Line '[4/6] 名字占用检查'
$view = (& npm view $pkg.name version 2>&1)
if ($view -match 'E404|404 Not Found') {
  Write-Host '  ✓ 该名字在 registry 上还不存在 —— 可以首发' -ForegroundColor Green
} else {
  Write-Host ('  已存在版本：' + ($view -join ' ')) -ForegroundColor Yellow
  Write-Host '  → 若不是你发的，说明名字被占；若是你发的，先升 version 再发。' -ForegroundColor Yellow
  $ans = Read-Host '  仍要继续吗？(y/N)'
  if ($ans -ne 'y') { exit 0 }
}

Line '[5/6] 打包预检（不发布，只看 tarball 里有什么）'
& npm pack --dry-run 2>&1 | Select-Object -Last 14 | ForEach-Object { Write-Host ('  ' + $_) }
Write-Host ''
Write-Host '  ↑ 必须看到 package/cordis.patch.yml —— 没有它，别人装上去不会装配' -ForegroundColor Yellow

Line '[6/6] 正式发布'
Write-Host ''
Write-Host '  接下来 npm 会提示：  Enter OTP:' -ForegroundColor Yellow
Write-Host '  打开手机 authenticator → 找到 npm 那一条 → 敲当前 6 位数字 → 回车。' -ForegroundColor Yellow
Write-Host '  （30 秒换一次；如果输错了，重跑本脚本即可）' -ForegroundColor DarkGray
Write-Host ''
Read-Host '  准备好了按回车开始发布'

& npm publish --access public

if ($LASTEXITCODE -eq 0) {
  Line '发布成功'
  Write-Host ('  https://www.npmjs.com/package/' + $pkg.name) -ForegroundColor Green
  Write-Host ''
  & npm view $pkg.name version dist.tarball
  Write-Host ''
  Write-Host '  后续（可选）：把 README 安装章节改成 npm 优先，然后' -ForegroundColor Cyan
  Write-Host '    git add -A; git commit -m "docs: 转 npm 分发"; git push' -ForegroundColor DarkGray
} else {
  Line '发布失败 —— 对照错误码'
  Write-Host '  403 Two-factor authentication ... required'
  Write-Host '      → 2FA 没开，或 granular token 没勾 bypass-2fa。开 authenticator。'
  Write-Host '  404 Not Found - PUT ...'
  Write-Host '      → OTP 输错/过期；或把恢复码（64 位 hex）当 OTP 填了 —— 恢复码不是 TOTP。'
  Write-Host '  EOTP This operation requires a one-time password'
  Write-Host '      → 又走到 web-auth 了，说明不是交互终端。换 Windows Terminal 里的 pwsh 重跑。'
  Write-Host '  E409 / EPUBLISHCONFLICT cannot publish over previously published versions'
  Write-Host '      → 版本号没升，改 package.json 的 version。'
  Write-Host '  402 Payment Required'
  Write-Host '      → scope 是私有包默认收费；必须带 --access public 且 org 存在。'
}
