# dsh-vault

**English** · [中文](./README.zh-CN.md)

**Encrypted full backup and restore for DSH (DeepSeek Harness)**

[![npm](https://img.shields.io/npm/v/@lingfengmow/dsh-vault.svg)](https://www.npmjs.com/package/@lingfengmow/dsh-vault)
[![install](https://img.shields.io/badge/install-github%3Asoberkeen%2Fdsh--vault-2ea043.svg)](https://github.com/soberkeen/dsh-vault)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)

> Packs **config / sessions / skills / plugins / workspaces / Hindsight memory / the DSH client installer** into
> **encrypted, chunked volumes**, written to a local directory and optionally pushed to a NAS (network share or WebDAV).
> Every package carries a **self-contained restorer** and a recovery ledger inside it, with GFS rotation and optional
> scheduled backups.
>
> **Zero build step · zero external dependencies**: the pure-ESM JavaScript under `lib/` *is* the source and the
> artifact. Only `node:` builtins are used — no 7z, no openssl, no rclone, no npm dependency — so it installs on any
> machine that runs DSH.
>
> Status (2026-10-17): **verified**. Real packages `core` (599 MB) and `full_all` (711 MB) both pass `verify`
> (plaintext hash and per-volume hashes agree) and `restore-drill` (30/30, 31/31). Runs on DSH `0.2.0-rc.2`, with the
> settings panel, all six tools and the HTTP API exercised in a real injected session. Contract **checked against
> `0.2.1-rc.2`** — see [docs/compat-0.2.1-rc.2.md](./docs/compat-0.2.1-rc.2.md) (9 contracts, 8 unchanged, 1 additive).

---

## 1. Install

### From npm (recommended)

```powershell
# Official DSH CLI — maintains dependencies + lockfile + node_modules + profile bundles
& "<DSH install dir>\resources\runtime\cli\bin\dsh.cmd" plugin add "@lingfengmow/dsh-vault"

# Pin a profile when you run more than one
& "<DSH install dir>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "@lingfengmow/dsh-vault"
```

Published as `@lingfengmow/dsh-vault@0.2.0` — 45 files, 532 KB unpacked, `sha1 aa815b930a302d3327a786b9ddfa3e7813958032`.

### From GitHub (equivalent — `lib/` is plain ESM with no build step)

```powershell
& "<DSH install dir>\resources\runtime\cli\bin\dsh.cmd" plugin add github:soberkeen/dsh-vault
& "<DSH install dir>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add github:soberkeen/dsh-vault
```

Then **fully quit DSH and start it again** (not the "restart" button on the crash dialog). A **Backup** entry appears
in the settings sidebar when it worked.

### Local development

```powershell
# Hot injection, no restart (needs dsh-super-injector)
dev_inject_plugin  -dir "<absolute path to this directory>"

# Or write it into the profile (assembled from bundles on restart)
dev_install_package -dir "<absolute path to this directory>" -profile desktop

# Pack a tgz for another machine (no build step; the tgz is the artifact)
npm pack
```

**Requires**: DSH ≥ 0.2.0, Node ≥ 18 (the DSH runtime is enough), pwsh 7 (only for `restore.ps1`).
**Does not require**: 7z / openssl / gpg / rclone / any npm dependency. Docker is used only when backing up Hindsight's
Postgres database (`docker exec … pg_dump`).

### Self-check after installing

```powershell
npm run check                            # syntax gate
node scripts/client-register-test.mjs    # client registration contract, 8 assertions, must be all green
node scripts/health-check.mjs            # 15 runtime checks
```

---

## 2. Six tools (the AI-facing entry points)

| Tool | What it does | Key parameters |
|---|---|---|
| `vault_scan` | Scan and preview by importance tier (P0 must-keep / P1 optional / P2 excluded), **no side effects** | `scope`, `includeP1`, `topExcluded` |
| `vault_backup` | Run an encrypted backup and write it out | `password`, `outDir`, `scope`, `includeP1`, `dryRun` |
| `vault_list` | List historical packages (grouping volumes of one logical package) | `dir` |
| `vault_verify` | Full decrypt plus plaintext/volume hash check (writes nothing) | `package` (required), `password` |
| `vault_restore` | Restore: unpack to `--target`, or restore in place | `package` (required), `password`, `target`, `inPlace`, `only`, `list` |
| `vault_prune` | GFS rotation (dry-run by default, prints the delete list) | `dir`, `apply`, `hardDelete`, `keepLast`, `maxTotalGB` |

> Tool schemas are guarded by `scripts/schema-gate.mjs`: top-level `type:'object'`, `required` a top-level array of
> strings, and **no** boolean `required` inside property nodes. Historically an invalid schema made whole
> DeepSeek/mimo sessions return 400.

---

## 3. Scripts (the command-line entry points, all dependency-free)

```powershell
cd <this directory>

# ── Gates and regressions ─────────────────────────────────────────────────
node scripts/schema-gate.mjs      # tool schema gate (must pass before registering; wired into build.sh) → 6 tools + required semantics PASS
node scripts/policy-test.mjs      # GFS retention unit tests (10 cases: minKeep/keepLast/day-week-month buckets/size cap/chain protection/trash) → 10/10
node scripts/boundary-test.mjs    # boundaries and robustness (11 cases: empty dir/zero bytes/20MiB spanning frames/long paths LongLink/Unicode/multi-volume/missing volume/tampering/wrong password/per-file hashes/corrupt header) → 11/11
node scripts/selftest.mjs "G:\DSH-Backup\_selftest"   # end to end (scan→pack→verify→unpack→negative cases) → 12/12

# ── Real runs ─────────────────────────────────────────────────────────────
node scripts/core-drop.mjs --dry                                  # estimate only (strongly recommended first)
node scripts/core-drop.mjs --out "G:\DSH-Backup"                  # core: config+sessions+memory+installer+plugins+orchestration
node scripts/core-drop.mjs --out "G:\DSH-Backup" --scope all      # also include workspaces (02-workspaces)

# ── Verify and drill ──────────────────────────────────────────────────────
$key = (Get-ChildItem "G:\DSH-Backup\_keys\*.key.txt" | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
$pkg = (Get-ChildItem "G:\DSH-Backup\*.vault" | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
node scripts/verify-drop.mjs --package $pkg --key-file $key           # verify (password read from the key file)
node scripts/verify-drop.mjs --package $pkg --key-file $key --target D:\vault-check   # also unpack to compare
$pw = (Select-String -Path $key -Pattern '^密码：(.+)$').Matches[0].Groups[1].Value.Trim()
node scripts/restore-drill.mjs --package $pkg --password $pw          # clean-machine restore drill (five-way cross-check, no side effects by default)
```

**Build**: `bash scripts/build.sh` — for a zero-build package this only runs the `node --check` syntax gate, the
schema gate and a required-files existence check.

---

## 4. Password and key policy

| Source | Priority | Notes |
|---|---|---|
| `--password <value>` | 1 | Explicit; shows up in the process command line, fine for a one-off local run |
| Env var `DSHVAULT_PASSWORD` (name configurable) | 2 | Suitable for scripts and scheduled jobs |
| Generated automatically | 3 | When `core-drop.mjs` gets no password it generates a **policy-compliant random** one (leading capital + special character + ≥8 chars), prints it once on stdout and **writes it nowhere by default**; pass `--write-key` to persist it to `<out>/_keys/<package>.key.txt` |

- **A key file is a decryption credential**: leaking it means the package can be opened. Move it somewhere safe, or copy
  it down and delete it.
- **A lost password means the package is unrecoverable** (AES-256-GCM, no backdoor, no recovery channel).
- The password is **never** written into the manifest, into documents inside the package, or into logs.

---

## 5. Backup scope and exclusion rules

**Partitions**

| Partition | Contents |
|---|---|
| `00-installer` | The DSH client installer (the prerequisite for restoring onto a bare machine; **exempt from the L4 large-binary rule**) |
| `01-dsh-home` | `$DSH_HOME`: config / sessions / skills / rules / storage (excludes `node_modules`, `cache`, `plugin-backups`, `rewind-snapshots`, `dsh-runtimes`, `logs`, `telemetry`) |
| `02-workspaces` | Workspaces, discovered from `$DSH_HOME/storages/workspace.json`, allow-listed for selection |
| `03-hindsight` | The local `~/.hindsight` directory plus a logical Postgres backup (`pg_dump -F c`) |
| `04-docker` | compose / Dockerfile / .env (**images are not packed**; they can be rebuilt from the orchestration files) |
| `05-plugins` | `plugins-desk-v1` / `plugin-data` / `profiles` assembly manifests |

**Exclusion rules (four layers; every hit is recorded in `manifest.excluded[]`)**

```
L1 video    extension list plus magic-number cross-check (a bare .ts must match the MPEG-TS sync byte 0x47 and be >1MB,
            so TypeScript files are not killed by mistake)
L2 deps     node_modules/ .venv/ venv/ site-packages/ __pycache__/ .pnpm-store/ .gradle/ .nuget/ ...
L3 caches   dist/ build/ out/ obj/ target/ .next/ .work/ .mimocode/ .cache/ tmp/ _staging/ + *.pyc *.map
L4 models   runtime/ + *.pth *.pt *.ckpt *.onnx *.safetensors *.gguf + {.dll .exe .bin .zip .gz .iso} over 200MB
E8 backups of backups  backup|bak|archive|old|回收站|迁移包|_备份 (excluded by default, so versions do not nest)
Exceptions  GPT-SoVITS/luotianyi-dub-kit/, models whose path contains train|self|my|finetune, GPT-SoVITS/*.wav
```

---

## 6. Package layout and naming

```
DSHVAULT_<HOST>_<YYYYMMDD-HHmmss>_<KIND>_<SCOPE>[_pNN].vault      # main package plus volumes (4 GiB per volume by default)
DSHVAULT_<...>.manifest.json                                      # plaintext sidecar index: partition table / exclusion evidence / hashes / chain
_keys/DSHVAULT_<...>.key.txt                                      # only exists with --write-key (default: printed once, never written)
```

Inside the package (after decryption):

```
RESTORE/
  AGENT.md          recovery ledger: package inventory + checksums / partition table / exclusion evidence / step list / partial list
  README.md         human-readable steps (including a pg_restore command template)
  restore.ps1       PowerShell wrapper (calls vault-restore.mjs)
  vault-restore.mjs self-contained restorer (byte-identical to lib/vault/portable-restore.mjs; the drill verifies this)
  manifest.json     snapshot taken at pack time (plainHash is null — that value can only be filled in once the stream ends; see the sidecar)
payload/
  00-installer/ 01-dsh-home/ 02-workspaces/ 03-hindsight/ 04-docker/ 05-plugins/
```

> On the two kinds of checksum: the **plaintext stream sha256** and the **per-volume sha256** live in the sidecar
> outside the package; `RESTORE/manifest.json` inside the package is a pack-time snapshot whose `plainHash` is always
> `null` — that is by design, not a gap.

---

## 6.5 Encryption and credentials (two modes · three key slots)

**Two modes**

| Mode | When to use it | Properties |
|---|---|---|
| **Encrypted** (default) | Uploading to cloud storage, or anywhere untrusted | Key derived from account + password; **opens on another machine**; the storage provider cannot read it |
| **Unencrypted** (`--no-encrypt` / `encrypt:false`) | Local disk or a trusted drive only | gzip right after the header, so any tool opens it; fast and nothing to remember |

**Three key slots** (all bound to the same random data key DEK; any one of them opens the package)

| Slot | Used for | Notes |
|---|---|---|
| Account + password | **Restoring on another machine** (the main path when you change computers) | Password policy: leading capital + special character + ≥8 chars, **enforced at pack time** |
| Recovery code | When the account and password are forgotten | Generated at pack time, **shown once**; losing it plus forgetting the password means the package is gone |
| Local passwordless (DPAPI) | Local restores and scheduled jobs | Valid only for this Windows user on this machine; useless after a move |

**Default behaviour**: with no password supplied it generates a compliant random one, adds a recovery-code slot and a
local passwordless slot, and **shows all three exactly once without writing them anywhere** (persisting requires
`--write-key`).

**Why it is designed this way**: once a package leaves the machine, an attacker can try passwords offline forever.
Measured `scrypt(N=2^17)`: about **177 ms / 134 MB per attempt**. An 8-character mixed password is still not enough
against a GPU cluster — **use ≥12 random characters, or four or more unrelated words**.

**Command-line examples**

```powershell
# Encrypted (recommended before uploading): account + password + recovery code + local passwordless
node scripts/core-drop.mjs --out G:\DSH-Backup --account ishii-vault-01 --password 'MyVault#2026' --recovery --local

# Unencrypted (local only)
node scripts/core-drop.mjs --out G:\DSH-Backup --no-encrypt

# Restore on another machine / restore passwordless on this one
node RESTORE/vault-restore.mjs --package <package.vault> --account ishii-vault-01 --password 'MyVault#2026' --target D:\restore-here
node RESTORE/vault-restore.mjs --package <package.vault> --local --target D:\restore-here
```

## 6.6 Scheduled backups (daemon loop)

```jsonc
// Plugin config (off by default)
"autoBackup": { "enabled": true, "dailyAt": "03:00", "scope": "all", "outDir": "G:\\DSH-Backup", "prune": true, "keepLast": 7 }
```

- Packs with the **local passwordless slot**, so **no password needs to be stored in config**
- A missed day (shutdown / restart) triggers **one catch-up run**; the same day never runs twice (deduplicated in
  `<state>/schedule.json`)
- With `prune:true` the rotation policy runs after the backup and moves deletions to `_trash` by default (reversible),
  never hard-deleting

## 6.7 Web panel

- **One-click backup**: encryption toggle · account · password · local passwordless · output directory · scope; the
  result area **prominently shows** the recovery code / generated password once
- **History**: verify / restore preview / restore (account, recovery code or local passwordless); in-place restore
  renames the existing directory to `.bak-<timestamp>` before writing
- Security: the panel API only answers **loopback** requests, rejects cross-site `Origin`, and restricts directory
  arguments to an allow-list

## 6.8 Remote targets (NAS / network share / WebDAV)

**The local copy is always the primary one**; a push is an extra copy, and a failed push **does not invalidate the
backup** (the outcome is recorded in `manifest.pushTargets`).

| Target type | What the user fills in | Notes |
|---|---|---|
| **Local directory** | A path such as `G:\DSH-Backup` | This is the "output directory" itself |
| **Network share (UNC or mapped drive)** | `\\NAS\share\DSH-Backup` or `Z:\DSH-Backup` (plus optional user/password) | Filled in **exactly** like a local directory; credentials are used to establish a `net use` session |
| **WebDAV** | `address` + `user` + `password` + `remote dir`, e.g. `https://nas.local:5006/dav/` + `DSH-Backup` | Synology / QNAP / Zspace / Nutstore / Nextcloud all provide it; implemented in plain Node (MKCOL + PUT) |

**Credential safety**: user names and passwords are encrypted with **DPAPI** (this machine, this Windows user) before
being stored in `plugin-data/dsh-vault/targets.json` — **never in plaintext**. The panel **never returns the password**
when reading; it only marks the credential as stored.

**Panel**: the Targets tab adds and removes targets and offers a per-target "test connection" (which writes a probe
file to the target).
**Command line**:
```powershell
# Store the target in the panel or config first, then push by name during a backup
node scripts/core-drop.mjs --out G:\DSH-Backup --push NAS-WebDAV,home-nas
```
**Tool**: `vault_backup` with `pushTargets: ["NAS-WebDAV"]` does the same thing.

**Not built yet**: S3-compatible object storage and cloud-drive CLIs (BaiduPCS-Go). The interface is already shaped as
"plug in one adapter".

## 7. Restore

```powershell
# Shortest path (any Windows with Node 18+, plugin does not need to be installed)
node .\RESTORE\vault-restore.mjs --package .\DSHVAULT_xxx.vault --password "<password>" --list      # inspect
node .\RESTORE\vault-restore.mjs --package .\DSHVAULT_xxx.vault --password "<password>" --target D:\vault-out
node .\RESTORE\vault-restore.mjs --package .\DSHVAULT_xxx.vault --password "<password>" --in-place   # restore partitions to their original locations
node .\RESTORE\vault-restore.mjs --package .\DSHVAULT_xxx.vault --password "<password>" --verify     # verify only
```

Partition → destination: `00` → install manually · `01` → `%USERPROFILE%\.dsh` · `02` → original workspace paths
(`--remap C:\X=D:\Y` supported) · `03` → `~/.hindsight` plus `pg_restore` · `04` → project directory (rebuild the
containers) · `05` → takes effect together with `01`.

---

## 8. Architecture (`lib/`, all dependency-free)

| Module | Responsibility |
|---|---|
| `index.js` | Plugin entry: registers the six tools; optionally wires the webserver route (degrades cleanly when the service is absent) |
| `vault/paths.js` | `$DSH_HOME` / workspace discovery / installer and orchestration detection |
| `vault/io.js` | Stable reads `stableStat` / walk / sha256 / atomic writes |
| `vault/filter.js` | Four exclusion layers plus `classifyEntry` |
| `vault/importance.js` | Scoring with P0/P1/P2 tiering |
| `vault/tar.js` | Hand-written tar (ustar + GNU LongLink); **reads exactly the declared size** (so entries cannot drift) plus a re-check of hot files before writing |
| `vault/crypto.js` | scrypt + AES-256-GCM with 8 MiB chunked AEAD; plaintext header (magic + len + JSON) |
| `vault/pack.js` | Pipeline tar → gzip → encrypt → split into volumes → atomic write; manifest; in-package `RESTORE/` document generation; staging cleanup |
| `vault/policy.js` | GFS retention plus size cap plus **incremental-chain protection** plus `_trash` |
| `vault/portable-restore.mjs` | The self-contained restorer shipped inside each package |
| `vault/toolkit.js` | Tool-definition builder plus `normalizeParameters` (schema-compliant normalisation) |
| `server.js` | Host HTTP API (8 endpoints, job tracking, a `confirm` gate; write operations dry-run by default) — **verified in a real injected session** |
| `client.js` | Five-tab panel in plain DOM — **verified in a real injected session** |

---

## 9. Known limitations (an honest list)

1. **Not built**: S3-compatible object storage and cloud-drive CLIs (BaiduPCS-Go). The interface is shaped as "plug in
   one adapter".
2. **Not built**: a queue and a concurrency cap for backup jobs; scheduled backups currently run serially.
3. `EXCLUDED_CAP = 2000`: at most 2000 exclusion records per partition (totals are always reported; the detail list is
   truncated).
4. Windows is the main target; `restore.ps1` needs pwsh, while the rest of the scripts are cross-platform (path
   separators are handled).
5. Restoring the `03-hindsight` partition needs Docker on the target machine for `pg_restore`; the plain directory part
   (`~/.hindsight`) does not.

---

## 10. Related documents

- Compatibility with `0.2.1-rc.2` (contract-by-contract): [`docs/compat-0.2.1-rc.2.md`](./docs/compat-0.2.1-rc.2.md)
- Release process and the npm 404 post-mortem: [`docs/RELEASING.md`](./docs/RELEASING.md)
