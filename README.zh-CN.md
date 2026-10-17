# dsh-vault

**中文** · [English](./README.md)

**DSH（DeepSeek Harness）加密全量备份与恢复插件**

[![install](https://img.shields.io/badge/install-github%3Asoberkeen%2Fdsh--vault-2ea043.svg)](https://github.com/soberkeen/dsh-vault)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)

> 把**配置 / 会话 / 技能 / 插件 / 工作区 / Hindsight 记忆 / 客户端安装包**打成**加密分卷包**，
> 落盘本地目录 + 可推送到 NAS（网络路径 / WebDAV）；包内自带**自包含还原器**与恢复台账，配 GFS 滚动保留，支持定时自动备份。
>
> **零编译 · 零外部依赖**：`lib/` 下的纯 ESM JavaScript 就是源码兼产物；只使用 `node:` 内置模块 —— 不依赖 7z / openssl / rclone / 任何 npm 包，因此可装到任意电脑的任意 DSH 上。
>
> 状态（2026-10-17）：**已验证** —— 真实包 `core` 599 MB 与 `full_all` 711 MB 均通过 `verify`（明文 + 分卷哈希双一致）与 `restore-drill`（30/30、31/31）。已在 DSH `0.2.0-rc.2` 实跑（面板 / 6 工具 / HTTP API 全部在真实注入态验证通过）；与 `0.2.1-rc.2` 的契约核对见 [docs/兼容性-0.2.1-rc.2.md](https://github.com/soberkeen/dsh-vault/blob/main/docs/compat-0.2.1-rc.2.md)（9 项契约中 8 项零变化、1 项纯增量）。

---

## 1. 安装

### 从 GitHub 装（推荐 —— 当前唯一分发渠道）

```powershell
# DSH 官方 CLI —— 会同时维护 dependencies + lock + node_modules + profile bundles
& "<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd" plugin add github:soberkeen/dsh-vault

# 指定 profile（多 profile 时）
& "<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add github:soberkeen/dsh-vault
```

装完**完全退出 DSH 再启动**（不是点崩溃框的重启），设置左栏出现「备份」即成功。

> **npm 分发暂缓**：包名已定为 `@lingfengmow/dsh-vault`，但 npm 在 2026-07 起的 2FA 发布策略（granular token bypass 2FA 弃用）与 `npm publish` 的 web 授权交接存在缺陷 —— 浏览器授权返回 200 之后 PUT 仍返回 404，六轮对照实验确认与权限 / org / 包名 / token / 网络 / 客户端版本全都无关。完整证据链见 [docs/RELEASING.md](./docs/RELEASING.md#为什么-npm-发布一直-404已实测归因)。**GitHub 安装完全等价**：`lib/` 是纯 ESM，无构建步骤，装下来即可运行。

### 本地开发

```powershell
# 免重启注入（需 dsh-super-injector）
dev_inject_plugin  -dir "<本目录绝对路径>"

# 或写进 profile（重启后由 bundles 装配）
dev_install_package -dir "<本目录绝对路径>" -profile desktop

# 打成 tgz 跨机分发（无构建步骤，tgz 即产物）
npm pack
```

**要求**：DSH ≥ 0.2.0、Node ≥ 18（DSH 自带 runtime 即可）、pwsh 7（仅 `restore.ps1` 需要）。
**不需要**：7z / openssl / gpg / rclone / 任何 npm 依赖。Docker 仅在需要备份 Hindsight 的 Postgres 库时用到（`docker exec … pg_dump`）。

### 装完自检

```powershell
npm run check                       # 语法检查
node scripts/client-register-test.mjs   # client 注册契约 8 项断言，必须全绿
node scripts/health-check.mjs       # 15 项运行时自检
```


---

## 2. 六个工具（AI 侧入口）

| 工具 | 作用 | 关键参数 |
|---|---|---|
| `vault_scan` | 扫描 + 分层预览（P0 必存 / P1 可勾 / P2 排除），**零副作用** | `scope`、`includeP1`、`topExcluded` |
| `vault_backup` | 执行加密备份并落地 | `password`、`outDir`、`scope`、`includeP1`、`dryRun` |
| `vault_list` | 列出历史包（按逻辑包聚合多卷） | `dir` |
| `vault_verify` | 完整解密 + 明文/分卷哈希校验（不落盘） | `package`（必填）、`password` |
| `vault_restore` | 还原：`--target` 解包 / `inPlace` 原位还原 | `package`（必填）、`password`、`target`、`inPlace`、`only`、`list` |
| `vault_prune` | GFS 滚动保留（默认 dry-run，出删除清单） | `dir`、`apply`、`hardDelete`、`keepLast`、`maxTotalGB` |

> 工具 schema 受 `scripts/schema-gate.mjs` 门禁保护：顶层 `type:'object'`、`required` 为顶层字符串数组、属性节点内**不得**有布尔 `required`（历史上非法 schema 会导致 DeepSeek/mimo 会话整体 400）。

---

## 3. 脚本速查（命令行侧入口，全部零依赖）

```powershell
cd <本目录>

# ── 关卡/回归 ────────────────────────────────────────────────────────────
node scripts/schema-gate.mjs      # 工具 schema 门禁（注册前必过；已接入 build.sh）→ 6 工具 + 必填语义全 PASS
node scripts/policy-test.mjs      # GFS 保留策略单元验收（10 用例：minKeep/keepLast/日周月桶/体积上限/链保护/trash）→ 10/10
node scripts/boundary-test.mjs    # 边界与健壮性（11 用例：空目录/零字节/20MiB 跨帧/长路径 LongLink/Unicode/多卷/缺卷/篡改/错密码/逐文件哈希/头损坏）→ 11/11
node scripts/selftest.mjs "G:\DSH-Backup\_selftest"   # 端到端（扫描→打包→校验→解包→负例）→ 12/12

# ── 真实落地 ─────────────────────────────────────────────────────────────
node scripts/core-drop.mjs --dry                                  # 只预估（强烈建议先跑）
node scripts/core-drop.mjs --out "G:\DSH-Backup"                  # core：配置+会话+记忆+安装包+插件+编排
node scripts/core-drop.mjs --out "G:\DSH-Backup" --scope all      # 再加工作区（02-workspaces）

# ── 校验与演练 ───────────────────────────────────────────────────────────
$key = (Get-ChildItem "G:\DSH-Backup\_keys\*.key.txt" | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
$pkg = (Get-ChildItem "G:\DSH-Backup\*.vault" | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
node scripts/verify-drop.mjs --package $pkg --key-file $key           # 校验（密码从密钥文件读）
node scripts/verify-drop.mjs --package $pkg --key-file $key --target D:\vault-check   # 顺带解包核对
$pw = (Select-String -Path $key -Pattern '^密码：(.+)$').Matches[0].Groups[1].Value.Trim()
node scripts/restore-drill.mjs --package $pkg --password $pw          # 空机还原演练（五段核对，默认零副作用）
```

**构建**：`bash scripts/build.sh`（零编译形态，只做 `node --check` 语法门禁 + schema 门禁 + 必需文件存在性检查）。

---

## 4. 密码与密钥策略

| 来源 | 优先级 | 说明 |
|---|---|---|
| `--password <值>` | 1 | 显式传入（会出现在进程参数里，仅本机临时用） |
| 环境变量 `DSHVAULT_PASSWORD`（名可配） | 2 | 适合脚本/定时任务 |
| 自动生成 | 3 | `core-drop.mjs` 未拿到密码时生成**合规随机密码**（首字母大写 + 特殊符号 + ≥8 位），只在 stdout 打印一次、**默认不落盘**；要落盘须显式 `--write-key`（才会写 `<out>/_keys/<包名>.key.txt`） |

- **密钥文件等同于解密凭据**：泄露 = 包可被解开。建议移到安全位置或抄写后删除。
- **忘记密码 = 该包永久不可恢复**（AES-256-GCM，无后门、无恢复通道）。
- 密码**不写进** manifest、不写进包内文档、不写进日志。

---

## 5. 备份范围与排除规则

**分区**

| 分区 | 内容 |
|---|---|
| `00-installer` | DSH 客户端安装包（空机恢复前提；**豁免 L4 大二进制规则**） |
| `01-dsh-home` | `$DSH_HOME`：配置 / 会话 / 技能 / 规则 / 存储（排除 `node_modules`、`cache`、`plugin-backups`、`rewind-snapshots`、`dsh-runtimes`、`logs`、`telemetry`） |
| `02-workspaces` | 工作区（从 `$DSH_HOME/storages/workspace.json` 自动发现，白名单可勾） |
| `03-hindsight` | `~/.hindsight` 本地目录 + Postgres 逻辑备份（`pg_dump -F c`） |
| `04-docker` | compose / Dockerfile / .env（**镜像不打包**，可由编排重建） |
| `05-plugins` | `plugins-desk-v1` / `plugin-data` / `profiles` 装配清单 |

**排除规则（四层，命中即记入 `manifest.excluded[]`）**

```
L1 视频    扩展名清单 + 魔数双判（裸 .ts 必须命中 MPEG-TS sync 0x47 且 >1MB，防误杀 TypeScript）
L2 依赖    node_modules/ .venv/ venv/ site-packages/ __pycache__/ .pnpm-store/ .gradle/ .nuget/ ...
L3 缓存    dist/ build/ out/ obj/ target/ .next/ .work/ .mimocode/ .cache/ tmp/ _staging/ + *.pyc *.map
L4 模型    runtime/ + *.pth *.pt *.ckpt *.onnx *.safetensors *.gguf + >200MB 的 {.dll .exe .bin .zip .gz .iso}
E8 备份的备份  backup|bak|archive|old|回收站|迁移包|_备份（默认排除，防版本套娃）
例外        GPT-SoVITS/luotianyi-dub-kit/、路径含 train|self|my|finetune 的模型、GPT-SoVITS/*.wav
```

---

## 6. 包结构与命名

```
DSHVAULT_<HOST>_<YYYYMMDD-HHmmss>_<KIND>_<SCOPE>[_pNN].vault      # 主包 + 分卷（默认 4 GiB/卷）
DSHVAULT_<...>.manifest.json                                      # 明文索引（sidecar）：分区表/排除证据/哈希/链
_keys/DSHVAULT_<...>.key.txt                                      # 仅 --write-key 时存在（默认只打印一次、不落盘）
```

包内（解密后）：
```
RESTORE/
  AGENT.md          恢复台账：包清单+校验和 / 分区表 / 排除证据 / 分步动作 / partial 清单
  README.md         人读步骤（含 pg_restore 命令行模板）
  restore.ps1       PowerShell 包装（内部调 vault-restore.mjs）
  vault-restore.mjs 自包含还原器（与 lib/vault/portable-restore.mjs 字节一致，drill 会校验）
  manifest.json     打包期快照（plainHash 为 null —— 该值只能在流结束后回填，见 sidecar）
payload/
  00-installer/ 01-dsh-home/ 02-workspaces/ 03-hindsight/ 04-docker/ 05-plugins/
```

> 校验关系说清：**明文流 sha256** 与**每卷 sha256** 记录在包外 sidecar；包内 `RESTORE/manifest.json` 是打包期快照（其 `plainHash` 恒为 `null`，属设计而非缺失）。

---

## 6.5 加密与凭证（两种模式 · 三个钥匙槽）

**两种模式**

| 模式 | 什么时候用 | 特点 |
|---|---|---|
| **加密**（默认） | 要上传网盘 / 放不可信位置 | 账号+密码派生密钥；**跨机可解**；网盘运营商拿不到内容 |
| **不加密**（`--no-encrypt` / `encrypt:false`） | 只放本机或可信盘 | 头之后就是 gzip，任何工具都能打开；快、不用记密码 |

**三个钥匙槽**（都绑同一把随机数据密钥 DEK，任一把能开即可）

| 槽 | 用在哪 | 备注 |
|---|---|---|
| 账号 + 密码 | **跨机还原**（换电脑的主路径） | 密码规则：首字母大写 + 含特殊符号 + ≥8 位，**打包时就强制** |
| 恢复码 | 忘了账号密码时 | 打包时自动生成、**只显示一次**；丢了 + 忘密码 = 永久打不开 |
| 本机免密（DPAPI） | 本机还原 / 定时任务 | 只在这台电脑的这个 Windows 用户下有效，换机无效 |

**默认行为**：不给密码 → 自动生成合规随机密码 + 自动带恢复码槽 + 本机免密槽，**三者只显示一次、不落盘**（要落盘须显式 `--write-key`）。

**为什么这样设计**：包一旦外流，攻击者能在本地无限次试口令。实测 `scrypt(N=2^17)` 每次尝试约 **177 ms / 134 MB** —— 8 位混合口令在 GPU 集群前仍不够，**请用 ≥12 位随机或 4 个以上不相关单词**。

**命令行示例**

```powershell
# 加密（推荐上传网盘）：账号 + 密码 + 恢复码 + 本机免密
node scripts/core-drop.mjs --out G:\DSH-Backup --account ishii-vault-01 --password 'MyVault#2026' --recovery --local

# 不加密（只放本机）
node scripts/core-drop.mjs --out G:\DSH-Backup --no-encrypt

# 换电脑还原 / 本机免密还原
node RESTORE/vault-restore.mjs --package <包.vault> --account ishii-vault-01 --password 'MyVault#2026' --target D:\恢复到这里
node RESTORE/vault-restore.mjs --package <包.vault> --local --target D:\恢复到这里
```

## 6.6 定时自动备份（daemon-loop）

```jsonc
// 插件配置（默认关闭）
"autoBackup": { "enabled": true, "dailyAt": "03:00", "scope": "all", "outDir": "G:\\DSH-Backup", "prune": true, "keepLast": 7 }
```

- 用**本机免密槽**打包 → 配置里**不需要存密码**
- 当天错过（关机 / 重启）会**补跑一次**；同一天不重复（去重记录 `<state>/schedule.json`）
- `prune:true` 时备份后按滚动策略清理，默认**移入 `_trash`**（可回滚），不硬删

## 6.7 网页面板

- **一键备份区**：加密开关 · 账号 · 密码 · 本机免密 · 输出目录 · 作用域；结果区**醒目显示一次**恢复码 / 自动生成的密码
- **历史区**：校验 / 还原预览 / 还原（支持账号、恢复码、本机免密）；原位还原写前自动把原目录改名 `.bak-<时间戳>`
- 安全：面板 API 只允许**本机回环**访问，拒绝跨站 `Origin`，目录参数限白名单

## 6.8 远端目标（NAS / 网络路径 / WebDAV）

**本地永远是主副本**；推送是"额外一份"，推送失败**不影响备份成立**（结果记在 `manifest.pushTargets`）。

| 目标类型 | 用户要填什么 | 说明 |
|---|---|---|
| **本地目录** | 一个路径（如 `G:\DSH-Backup`） | 就是"输出目录"本身 |
| **网络路径（UNC / 映射盘）** | `\\NAS\share\DSH-Backup` 或 `Z:\DSH-Backup`（+可选用户名/密码） | 与本地目录**填写方式完全一样**；带凭据时用 `net use` 建会话 |
| **WebDAV** | `地址` + `用户名` + `密码` + `远端目录`，如 `https://nas.local:5006/dav/` + `DSH-Backup` | 群晖/威联通/极空间/坚果云/Nextcloud 均自带；纯 node 实现（MKCOL + PUT） |

**凭据安全**：用户名/密码用 **DPAPI**（本机 + 当前 Windows 用户）加密后存 `plugin-data/dsh-vault/targets.json`，**不落明文**；面板读取时**不回传密码**（只标"已存"）。

**面板**：「目标」区可增删目标、逐条「测试连接」（会在目标写一个探针文件）。
**命令行**：
```powershell
# 先在面板/配置里存好目标，然后备份时按名字推送
node scripts/core-drop.mjs --out G:\DSH-Backup --push NAS-WebDAV,家里NAS
```
**工具**：`vault_backup` 加 `pushTargets: ["NAS-WebDAV"]` 即同样效果。

**还没做**：对象存储 S3 兼容、网盘 CLI（BaiduPCS-Go）—— 接口已按"插一个适配器"的方式留好。

## 7. 恢复

```powershell
# 最短路径（任意 Windows + Node 18+，不需要装本插件）
node .\RESTORE\vault-restore.mjs --package .\DSHVAULT_xxx.vault --password "<密码>" --list      # 看包
node .\RESTORE\vault-restore.mjs --package .\DSHVAULT_xxx.vault --password "<密码>" --target D:\vault-out
node .\RESTORE\vault-restore.mjs --package .\DSHVAULT_xxx.vault --password "<密码>" --in-place   # 按分区还原到原位
node .\RESTORE\vault-restore.mjs --package .\DSHVAULT_xxx.vault --password "<密码>" --verify     # 只校验
```

分区 → 落地位置：`00`→手动安装 · `01`→`%USERPROFILE%\.dsh` · `02`→原工作区路径（支持 `--remap C:\X=D:\Y`）· `03`→`~/.hindsight` + `pg_restore` · `04`→项目目录（重建容器）· `05`→随 `01` 生效。

---

## 8. 架构（lib/，全部零依赖）

| 模块 | 职责 |
|---|---|
| `index.js` | 插件入口：注册 6 工具；可选接线 webserver 路由（缺服务自动降级） |
| `vault/paths.js` | `$DSH_HOME` / 工作区发现 / 安装包与编排探测 |
| `vault/io.js` | 稳定读 `stableStat` / walk / sha256 / 原子写 |
| `vault/filter.js` | 四层排除 + `classifyEntry` |
| `vault/importance.js` | 打分与 P0/P1/P2 分层 |
| `vault/tar.js` | 自写 tar（ustar + GNU LongLink）；**按声明 size 精确读取**（防止条目错位）+ 热点文件写前复检 |
| `vault/crypto.js` | scrypt + AES-256-GCM 8 MiB 分块 AEAD；明文头（magic + len + JSON） |
| `vault/pack.js` | 流水线 tar→gzip→加密→分卷→原子落地；manifest；包内 `RESTORE/` 文档生成；staging 自清 |
| `vault/policy.js` | GFS 保留 + 体积上限 + **增量链保护** + `_trash` |
| `vault/portable-restore.mjs` | 随包分发的自包含还原器 |
| `vault/toolkit.js` | 工具定义构造器 + `normalizeParameters`（schema 合规归一化） |
| `server.js` | host HTTP API（8 端点 + job + `confirm` 门控，写操作默认 dry-run）**未在注入态验证** |
| `client.js` | 面板五区（纯 DOM）**未在注态验证** |

---

## 9. 已知限制（诚实清单）

1. **尚未实现**：对象存储 S3 兼容与网盘 CLI（BaiduPCS-Go）—— 接口已按「插一个适配器」预留。
2. **尚未实现**：多备份任务排队与并发上限；定时备份当前串行执行。
3. `EXCLUDED_CAP = 2000`：单分区最多记录 2000 条排除证据（有总数统计，明细截断）。
4. Windows 为主战场；`restore.ps1` 需要 pwsh，其余脚本跨平台可用（路径分隔符已处理）。
5. 还原时的 `03-hindsight` 分区需要目标机有 Docker 才能 `pg_restore`；纯目录（`~/.hindsight`）部分不需要。

---

## 10. 相关文档

- 项目索引与决策记录（ADR-001…012、否决路径、轮次台账）：`I:\DSH 工作区\DSH完美备份计划\AGENT.md`
- 调研（环境实测 / 选型对比 / 架构）：`docs\研究-备份插件调研.md`
- 现状报告：`docs\报告-R4-现状.md` ｜ 真实落地报告：`docs\报告-真实落地-core.md`
