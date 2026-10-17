# dsh-vault × DSH 0.2.1-rc.2 兼容性核查

核查日期：2026-10-17
核查方式：从 npm registry 拉取 0.2.1-rc.2 与 0.2.0-rc.2 两版全部相关包，解包后对 `.d.ts` 类型契约逐文件 diff，对照 vault 源码里实际调用点判定。
零副作用：只下载到 `%TEMP%\dshcompat-200644`，未安装、未改 profile、未动现役环境。

## 版本现状

| 项 | 值 |
|---|---|
| 本机现役 | `0.2.0-rc.2`（npm `latest`） |
| 新版 | `0.2.1-rc.2`（npm `next`）；`0.2.1-alpha.5`（`alpha`） |
| 本机 app.asar | 115.7 MB，2026-10-13 19:09 |
| cordis | `~4.0.5`（两版相同） |

## 结论（一句话）

**vault 在 0.2.1-rc.2 上兼容，不需要改代码。** 唯一新增机制是 Host release 一致性校验，它作用于「页面 ↔ Host」而不是第三方插件，对 vault 无影响，但会让「Host 升级后页面没刷新」表现为整体不加载。

## 逐项契约核对

| 契约 | vault 用法 | 0.2.1-rc.2 状态 | 判定 |
|---|---|---|---|
| `settings.section` slot | `slots.register({name:"settings.section", id, order, label, locale}, Component)` | `dsh-client-ui-settings/lib/types/client/contract/slots.d.ts` **新旧逐字节相同**；`SettingsSectionOwnerProps = { close: () => void }` 未变 | ✅ 兼容 |
| `slots.register(...)` 签名 | 2 参（options, component） | 两个重载都在；options **仅新增** `inline?: true`（可选） | ✅ 兼容 |
| `SlotLabel` | 传 `() => string` | `string \| (() => string)`，未变 | ✅ 兼容 |
| `ctx.slots` / `SlotMap` | 读 `ctx.slots.inject` 语法 | `SlotMap` 仍是空接口 + declaration merging，未变 | ✅ 兼容 |
| `__ModuleLoader__.load` | `{ id, factory: (require) => {...} }` | `ClientModuleLoader` / `ClientModuleCreateOptions` / `ClientModuleRecord` 类型全部保留 | ✅ 兼容 |
| `locale.register(ns, dicts)` | `("dsh-vault", {zh, en})` | `@deepseek-ai/dsh-client-locale` 两版 d.ts **0 行差异**（33 KB → 33 KB） | ✅ 兼容 |
| `ctx.tools.register(def)` | 6 个工具，`ToolDefinition` | `register(definition: ToolDefinition): () => void` **签名一字未改**（旧 L636 / 新 L637） | ✅ 兼容 |
| `ctx.webServer` 路由 | `-p` 前缀挂 `/api/*` | 110 行 diff，**纯增量**：新增 `TlsConfig{certFile, privateKeyFile}` 与 HTTPS 监听，旧调用路径不变 | ✅ 兼容 |
| `ctx.logger` / `ctx.effect` | 10 次 / 7 次 | cordis `~4.0.5` 两版一致 | ✅ 兼容 |
| `cordis.patch.yml` insert 格式 | `- insert: [{id, name}]` | bundle patch 机制未改 | ✅ 兼容 |

## 0.2.1 的真实变化（与 vault 无关的部分）

### 1. 新增 Host release 一致性校验（`@deepseek-ai/dsh-client-modules`）

```ts
export interface WebBootRelease {
    version: string;      // Release version label
    commit?: string;      // Source commit fixed in when the Host was built
}
export declare function readRelease(wire: unknown): WebBootRelease | undefined;

// Entries 上新增三个成员
get releaseChange(): ObservableSnapshot<ClientReleaseChange | undefined>;
dismissRelease(): void;
private readonly release;    // "Admits only Host graphs of the page's boot release."
```

原文注释（关键约束）：

> The release is compared before the rest of the graph is validated: a graph of another release, including one whose format this page cannot read, is not applied and `releaseChange` announces it.

含义：**页面（boot 时的 client bundle）与 Host（服务端进程）release 不一致时，整个 boot graph 不被应用**。

影响范围：**Host ↔ page**，不是 per-plugin。vault 是 module 不是 graph，不参与该校验。

运维含义：**DSH 升级后必须硬刷新页面（Ctrl+R）**，否则旧页面会拒绝新版 Host 的 graph，表现为「插件全都不见了」。

### 2. `ToolPresentationMode` 去掉 `'both'`

```diff
- export type ToolPresentationMode = 'native' | 'ptc' | 'both';
+ export type ToolPresentationMode = 'native' | 'ptc';
```

vault 的 6 个工具都没声明 `presentationMode`，走默认 native，不受影响。

### 3. `dsh-tools` 新增 `meta?: JsonValue` 与 `ptc-calls.d.ts`

纯增量。`ToolDefinition` 的 `meta` 是可选字段，vault 未使用。

### 4. `createRunCodeTool` 签名变更

```diff
- createRunCodeTool(registry: ToolRuntime, options: RunCodeBridgeOptions): ToolDefinition
+ createRunCodeTool(registry: ToolRuntime, options: RunCodeBridgeOptions, ctx: Context): ToolDefinition
```

内部 API，vault 不调用。

### 5. settings 内部 config-form 重构（`@deepseek-ai/dsh-client-ui-settings`）

```diff
- mode: 'host' | 'memory';
- status: 'idle' | 'loading' | 'ready' | 'unavailable';
- constructor(ctx, spec, mirror, persistence: 'host'|'memory', schema)
+ constructor(ctx, spec, mirror, schema)
```

`persistence` 与 `unavailable` 状态整体移除，改为由 `remote.$host` 推导。vault 不碰 config-form（只用 settings.section 挂自己的面板），不受影响。

### 6. `dsh-web-app` 新增 `webApp` 服务与 `--public-url` / `--trusted-host` / TLS

```ts
export interface WebApp {
    getAdvertisedUrl(): string;
}
declare module '@deepseek-ai/cordis' {
    interface Context { webApp: WebApp; }
}
```

新增服务，纯增量。vault 不读 `webApp`。

## 行为验证建议（按风险从低到高）

### A. 保持现状（推荐）

留在 `0.2.0-rc.2`。契约层面已证明兼容，但没有跑过真实 0.2.1 运行时，等 `0.2.1` 进 `latest` 再升。

### B. 独立 profile 试装（验证充分，不影响现役）

```powershell
$env:DSH_PROFILE = 'compat021'
& 'I:\DSH-Official\resources\runtime\cli\bin\dsh.cmd' --profile compat021 web --port 19399
```

在 19399 上装 vault（`dev_inject_plugin` 或手补 bundles），看设置里「备份」是否出现、六个工具是否可调。

代价：要复制一份 profile 配置；收益：现役环境零风险。

### C. 直接升 `next`（最快，可回滚）

```powershell
cd 'I:\DSH-Official'
# 备份现役
Copy-Item 'C:\Users\sober\.dsh\profiles\desktop\package.json' "$env:TEMP\package.json.bak-0.2.0"
# 升（DSH 桌面版用自带更新器，或替换 app.asar）
```

升级后**必须 Ctrl+R 硬刷新**（见上面 §1 的 release 校验），否则页面会拒绝新 Host。

回滚：恢复 `package.json` + 装回旧 app.asar。

## 已知不确定项

1. **`ctx.webServer` 的 110 行 diff 没逐行读完**，只确认新增 TLS 部分；旧 `route()` 调用路径在两版都存在（vault 的 `/api/health` 在 0.2.0 实测 200，新版本未实测）。
2. **没有在真实 0.2.1 运行时跑过 vault**，以上全部是**类型契约级**判定。运行时行为差异（例如 slots 渲染顺序、locale 解析时机）只能实测。
3. **`dsh-client-ui-settings` 的 `lib/client.js`（56.4 KB）未逐行比对**，只比了类型声明。

## 核查命令（可复现）

```powershell
$tmp = Join-Path $env:TEMP ("dshcompat-" + (Get-Date -Format 'HHmmss'))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
Push-Location $tmp
# 逐包下载两版
foreach ($spec in @(
  'dsh-client-ui-settings|0.2.1-rc.2','dsh-client-ui-settings|0.2.0-rc.2',
  'dsh-client-ui-slots|0.2.1-rc.2','dsh-client-ui-slots|0.2.0-rc.2',
  'dsh-client-modules|0.2.1-rc.2','dsh-client-modules|0.2.0-rc.2',
  'dsh-client-locale|0.2.1-rc.2','dsh-client-locale|0.2.0-rc.2',
  'dsh-tools|0.2.1-rc.2','dsh-tools|0.2.0-rc.2',
  'dsh-host-webserver|0.2.1-rc.2','dsh-host-webserver|0.2.0-rc.2',
  'dsh-web-app|0.2.1-rc.2','dsh-web-app|0.2.0-rc.2'
)) {
  $p,$v = $spec -split '\|'
  npm pack "@deepseek-ai/$p@$v" --silent | Out-Null
  $dir = "$p-" + ($v -replace '\.','_')
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  tar -xzf "deepseek-ai-$p-$v.tgz" -C $dir
}
# 关键契约文件逐个 diff（空输出 = 无差异）
Compare-Object (Get-Content 'dsh-client-ui-settings-0_2_0-rc_2\package\lib\types\client\contract\slots.d.ts') `
               (Get-Content 'dsh-client-ui-settings-0_2_1-rc_2\package\lib\types\client\contract\slots.d.ts')
```
