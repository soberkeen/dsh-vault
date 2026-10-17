// dsh-vault client bundle — settings.section 面板（纯 DOM，零外部依赖）
// 形态照抄本机既有实现：
//   window.__ModuleLoader__.load({ id, factory: (require) => { ... } })
//   （参考 dsh-super-injector/lib/client.js:1-3 / :154-158、dsh-purge/client.js:2-9）
// slot 注册：ctx.slots.inject(slot, () => ctx.slots.register({ name: slot, ... }))
//   （参考 dsh-super-injector/lib/client.js:44-49、scaffold 模板 lib/index.js:7061-7064）
// 必须 export const inject = ["slots"]（apply 用 ctx.slots 的服务注入契约）。
window.__ModuleLoader__.load({
	id: "@soberkeen/dsh-vault",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		// React 由模块协议注入的 require 提供（对照 dsh-prompt-inject/lib/client.js:6）。
		// settings.section 的渲染函数必须返回 React 元素，所以这里必需。
		const React = require("react");
		// client 半边需要 slots + locale 两个服务（对照 skills-manager 的模块内声明：
		//   inject = ["slots","locale"]）。缺 "locale" 时 `ctx.locale` 求值会抛
		//   cannot get property "locale" without inject → 注册竞态失败（"有时出现"的来源）。
		const inject = ["slots", "locale"];
		const API = "/@soberkeen/dsh-vault/api";
		const POLL_MS = 2000;
		// slot 名必须以字面量出现在 register({ name: "..." }) 里——注入器骨架校验
		// （super-injector clientSkeletonProblems，lib/index.js:8516-8524）用正则匹配字面量。

		// ───────────────────────────── 小工具 ─────────────────────────────
		function el(tag, cls, text) {
			const e = document.createElement(tag);
			if (cls) e.className = cls;
			if (text !== undefined) e.textContent = text;
			return e;
		}
		function clear(node) {
			while (node.firstChild) node.removeChild(node.firstChild);
		}
		function lsGet(k, dflt) {
			try {
				const v = window.localStorage.getItem(`dshvault.${k}`);
				return v === null ? dflt : v;
			} catch { return dflt; }
		}
		function lsSet(k, v) {
			try { window.localStorage.setItem(`dshvault.${k}`, String(v)); } catch { /* 存储不可用 */ }
		}
		function ssGet(k, dflt) {
			try {
				const v = window.sessionStorage.getItem(`dshvault.${k}`);
				return v === null ? dflt : v;
			} catch { return dflt; }
		}
		function ssSet(k, v) {
			try { window.sessionStorage.setItem(`dshvault.${k}`, String(v)); } catch { /* 存储不可用 */ }
		}
		function fmtBytes(n) {
			if (!Number.isFinite(n) || n <= 0) return "0 B";
			const u = ["B", "KB", "MB", "GB", "TB"];
			let i = 0;
			let v = n;
			while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
			return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
		}
		function fmtTime(s) {
			if (!s) return "-";
			const d = new Date(s);
			if (Number.isNaN(d.getTime())) return String(s);
			const p = (n) => String(n).padStart(2, "0");
			return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
		}

		const CSS = `
/* ── 基础排版 ───────────────────────────────────────────────────────────
   2026-10-17 视觉重做。原版整块用等宽字体（ui-monospace）配 11~12px：
   中文在等宽栈里会 fallback 到宋体类字体，小字号下笔画糊在一起 —— 这是
   「看不清」的真正原因。改为 UI 无衬线字体栈，字号整体上调一档；
   只有路径 / 包名 / 日志这类内容保留等宽（.dsv-mono 或 .dsv-pre）。 */
.dsv-page{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei UI","Microsoft YaHei","PingFang SC","Hiragino Sans GB",sans-serif;font-size:13px;line-height:1.65;padding:18px 20px;width:100%;max-width:none;box-sizing:border-box;height:100%;overflow:auto;color:var(--theme-text,#e6e6e6);-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums}
.dsv-mono{font-family:ui-monospace,SFMono-Regular,"Cascadia Mono",Consolas,monospace;font-size:.94em}
/* ── 标签页 ───────────────────────────────────────────────────────────── */
.dsv-tabs{display:flex;gap:7px;flex-wrap:wrap;margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid var(--theme-border,#333)}
.dsv-tab{background:transparent;border:1px solid var(--theme-border,#3a3a3a);color:var(--theme-text,#ddd);border-radius:7px;padding:6px 13px;cursor:pointer;font-size:13px;font-family:inherit;transition:background .12s,border-color .12s,color .12s}
.dsv-tab:hover{border-color:var(--theme-accent,#4a9eff);color:var(--theme-text,#fff)}
.dsv-tab.on{background:var(--theme-accent,#4a9eff);border-color:var(--theme-accent,#4a9eff);color:#fff;font-weight:600}
.dsv-tab:focus-visible{outline:2px solid var(--theme-accent,#4a9eff);outline-offset:2px}
/* ── 卡片 ─────────────────────────────────────────────────────────────── */
.dsv-card{border:1px solid var(--theme-border,#333);border-radius:10px;padding:15px 16px;margin-bottom:14px;background:var(--theme-input-bg,rgba(255,255,255,.025));overflow-x:auto}
.dsv-card h4{margin:0 0 12px;font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--theme-text-secondary,#a8a8a8)}
/* ── 表单 ─────────────────────────────────────────────────────────────── */
.dsv-row{display:flex;gap:9px;flex-wrap:wrap;align-items:center;margin:9px 0}
.dsv-input{flex:1;min-width:200px;background:var(--theme-input-bg,#111);color:var(--theme-text,#e6e6e6);border:1px solid var(--theme-border,#3a3a3a);border-radius:7px;padding:8px 11px;font-size:13px;font-family:inherit;transition:border-color .12s}
.dsv-input:focus{outline:none;border-color:var(--theme-accent,#4a9eff)}
.dsv-input::placeholder{color:var(--theme-text-secondary,#8a8a8a)}
/* ── 按钮 ─────────────────────────────────────────────────────────────── */
.dsv-btn{background:var(--theme-accent,#4a9eff);color:#fff;border:1px solid transparent;border-radius:7px;padding:8px 15px;cursor:pointer;font-size:13px;font-family:inherit;font-weight:500;transition:filter .12s,opacity .12s}
.dsv-btn:hover{filter:brightness(1.12)}
.dsv-btn:focus-visible{outline:2px solid var(--theme-accent,#4a9eff);outline-offset:2px}
.dsv-btn.ghost{background:transparent;border:1px solid var(--theme-border,#4a4a4a);color:var(--theme-text,#e6e6e6)}
.dsv-btn.danger{background:transparent;border:1px solid #e05252;color:#ff7a7a}
.dsv-btn.danger:hover{background:rgba(224,82,82,.12)}
.dsv-btn.warn{background:#c47d00;border-color:#c47d00;color:#fff}
.dsv-btn:disabled{opacity:.4;cursor:not-allowed;filter:none}
/* ── 说明文字（字号不低于 12px，回退色不暗于 #a0a0a0 —— 否则 13px 以下不可读）── */
.dsv-muted{color:var(--theme-text-secondary,#a0a0a0);font-size:12px;line-height:1.6}
.dsv-pre{margin:8px 0 0;padding:10px 12px;border-radius:7px;background:var(--theme-input-bg,#0d0d0d);border:1px solid var(--theme-border,#333);white-space:pre-wrap;word-break:break-all;max-height:280px;overflow:auto;font-size:12px;line-height:1.55;font-family:ui-monospace,SFMono-Regular,"Cascadia Mono",Consolas,monospace}
/* ── 表格 ─────────────────────────────────────────────────────────────── */
.dsv-table{width:100%;border-collapse:collapse;font-size:12.5px;table-layout:auto}
.dsv-table th,.dsv-table td{border-bottom:1px solid var(--theme-border,#2f2f2f);padding:9px 10px;text-align:left;vertical-align:top}
.dsv-table th{color:var(--theme-text-secondary,#a8a8a8);font-weight:600;font-size:12px;letter-spacing:.02em;white-space:nowrap}
.dsv-table tr:hover{background:rgba(255,255,255,.035)}
.dsv-table:not(.dsv-kv) td{white-space:nowrap}
.dsv-table:not(.dsv-kv) td:first-child{white-space:normal;word-break:break-all;min-width:170px;font-family:ui-monospace,SFMono-Regular,"Cascadia Mono",Consolas,monospace;font-size:12px}
.dsv-table td:last-child>button{margin:0 5px 5px 0}
/* 键值表（设置页）：首列固定窄宽 + 值列折行 ——
   长说明若走 nowrap 会撑破容器、被右侧裁掉（2026-10-17 实测） */
.dsv-table.dsv-kv{table-layout:fixed}
.dsv-table.dsv-kv td,.dsv-table.dsv-kv th{white-space:normal;word-break:break-word;line-height:1.6}
.dsv-table.dsv-kv td:first-child{width:104px;color:var(--theme-text-secondary,#a8a8a8);font-size:12.5px}
.dsv-table.dsv-kv td+td{width:auto}
/* ── 消息 / 状态徽标 ──────────────────────────────────────────────────── */
.dsv-msg{margin-top:12px;padding:10px 12px;border-radius:7px;border:1px solid var(--theme-border,#333);white-space:pre-wrap;max-height:160px;overflow:auto;font-size:12.5px;line-height:1.6;display:none}
.dsv-msg.err{border-color:#e05252;color:#ff9a9a}
.dsv-pill{display:inline-block;font-size:11.5px;font-weight:600;padding:2px 8px;border-radius:9px;border:1px solid var(--theme-border,#4a4a4a);margin-left:7px}
.dsv-pill.run{color:#f5c542;border-color:#f5c542}
.dsv-pill.done{color:#4ade80;border-color:#4ade80}
.dsv-pill.fail{color:#ff7a7a;border-color:#ff7a7a}
/* ── 折叠块：默认收起，点标题展开（原始日志 / JSON / 排除样本）────────── */
.dsv-fold{margin:8px 0;border:1px solid var(--theme-border,#333);border-radius:7px;background:var(--theme-input-bg,#0d0d0d)}
.dsv-fold>summary{cursor:pointer;padding:9px 11px;font-size:12.5px;color:var(--theme-text-secondary,#a0a0a0);list-style:none}
.dsv-fold>summary:hover{color:var(--theme-text,#e6e6e6)}
.dsv-fold>summary::-webkit-details-marker{display:none}
.dsv-fold>summary::before{content:"▸ ";opacity:.85}
.dsv-fold[open]>summary::before{content:"▾ "}
.dsv-fold[open]>summary{border-bottom:1px solid var(--theme-border,#333)}
.dsv-fold .dsv-pre{border:none;margin:0;border-radius:0 0 7px 7px;background:transparent}
`;

/** 折叠块：默认收起，点标题展开（用于日志 / JSON / 排除样本等大块文本）。 */
function fold(label, node) {
  const d = document.createElement("details");
  d.className = "dsv-fold";
  const s = document.createElement("summary");
  s.textContent = label;
  d.append(s, node);
  return d;
}

		// ───────────────────────────── API ─────────────────────────────
		async function api(path, init) {
			const ctrl = new AbortController();
			const timer = window.setTimeout(() => ctrl.abort(), 120000);
			try {
				const r = await fetch(API + path, Object.assign({
					cache: "no-store",
					credentials: "same-origin",
					signal: ctrl.signal,
				}, init || {}));
				const text = await r.text();
				let data;
				try { data = text ? JSON.parse(text) : null; } catch {
					throw new Error(`${r.status} 非 JSON 响应: ${text.slice(0, 160)}`);
				}
				if (!r.ok) throw new Error((data && (data.error || data.message)) || `${r.status} ${r.statusText}`);
				return data;
			} finally {
				window.clearTimeout(timer);
			}
		}
		const post = (path, body) => api(path, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body || {}),
		});

		// ───────────────────────────── 状态 ─────────────────────────────
		const state = {
			tab: "backup",
			outDir: lsGet("outDir", ""),
			scope: lsGet("scope", "core"),
			includeP1: lsGet("includeP1", "0") === "1",
			encrypt: lsGet("encrypt", "1") === "1",
			account: lsGet("account", ""),
			local: lsGet("local", "1") === "1",
			password: ssGet("password", ""),
			recoveryCode: ssGet("recoveryCode", ""),
			useLocal: lsGet("local", "1") === "1",   // 历史区校验/还原默认复用「本机免密」勾选
			health: null,
			scan: null,
			list: null,
			follow: null,
			job: null,
			prunePreview: null,
			raw: lsGet("raw", "0") === "1",
			log: [],
		};

		function pushLog(line) {
			state.log.push(`[${new Date().toLocaleTimeString()}] ${line}`);
			if (state.log.length > 200) state.log.splice(0, state.log.length - 200);
		}

		// ───────────────────────────── 视图骨架 ─────────────────────────────
		function build() {
			const style = el("style");
			style.textContent = CSS;
			const page = el("div", "dsv-page");
			const title = el("div", "dsv-row");
			title.append(
				el("strong", undefined, "dsh-vault"),
				el("span", "dsv-muted", "加密备份与恢复"),
			);
			const tabs = el("div", "dsv-tabs");
			const TAB_DEFS = [
				["backup", "一键备份"],
				["plan", "计划"],
				["targets", "目标"],
				["history", "历史"],
				["settings", "设置"],
			];
			const body = el("div", "dsv-body");
			const msg = el("div", "dsv-msg");
			const say = (text, isErr) => {
				msg.textContent = text || "";
				msg.style.display = text ? "block" : "none";
				msg.classList.toggle("err", !!isErr);
				if (text) pushLog(`${isErr ? "错误: " : ""}${text}`);
			};
			const ctxObj = { page, body, say, tabs };

			for (const [key, label] of TAB_DEFS) {
				const b = el("button", "dsv-tab", label);
				b.dataset.tab = key;
				b.addEventListener("click", () => {
					state.tab = key;
					renderTabs();
					// ⚠️ 这里**不能**直接调 renderBody() —— 它定义在 build() 之外
					// （VaultPanel 的 useEffect 内），直接引用会抛 ReferenceError，
					// 表现为"标签页点了没反应"（2026-10-17 实测踩到）。
					// 改为通过 ctxObj.onTab 回调（由 VaultPanel 在定义 renderBody 之后赋值）。
					if (typeof ctxObj.onTab === "function") ctxObj.onTab();
				});
				tabs.append(b);
			}
			function renderTabs() {
				for (const b of tabs.children) b.classList.toggle("on", b.dataset.tab === state.tab);
			}
			ctxObj.renderTabs = renderTabs;

			page.append(style, title, tabs, body, msg);
			// ⚠️ 必须返回 **ctxObj 本身**（不是新建字面量）：
			// click 处理器检查的是 ctxObj.onTab，而外层赋值的是 `view.onTab`。
			// 若这里 return 一个新对象，两者不是同一个引用 → ctxObj.onTab 永远 undefined
			// → 点标签页只切高亮、内容不换（2026-10-17 实测踩到）。
			return ctxObj;
		}

		// ───────────────────── 区 1：一键备份 ─────────────────────
		function renderBackup(view, refresh) {
			clear(view.body);
			const card = el("div", "dsv-card");
			card.append(el("h4", undefined, "一键备份（写操作默认 dry-run，需确认才落盘）"));

			const rowScope = el("div", "dsv-row");
			rowScope.append(el("span", "dsv-muted", "范围"));
			for (const [val, lab] of [["core", "core（配置+会话+记忆+安装包）"], ["ws", "ws（工作区）"], ["all", "all（全量）"]]) {
				const radio = el("label", "dsv-muted");
				const input = el("input");
				input.type = "radio";
				input.name = "dsv-scope";
				input.value = val;
				input.checked = state.scope === val;
				input.addEventListener("change", () => { state.scope = val; lsSet("scope", val); });
				radio.append(input, document.createTextNode(` ${lab}`));
				rowScope.append(radio);
			}
			card.append(rowScope);

			const rowP1 = el("div", "dsv-row");
			const p1 = el("input");
			p1.type = "checkbox";
			p1.checked = state.includeP1;
			p1.addEventListener("change", () => { state.includeP1 = p1.checked; lsSet("includeP1", p1.checked ? "1" : "0"); });
			const p1lab = el("label", "dsv-muted");
			p1lab.append(p1, document.createTextNode(" 包含 P1（默认关；勾选后包更大）"));
			rowP1.append(p1lab);
			card.append(rowP1);

			// 加密开关（操作者定：加密 / 不加密两种选项）
			const rowEnc = el("div", "dsv-row");
			const encLab = el("label", "dsv-lab");
			const encCb = el("input");
			encCb.type = "checkbox";
			encCb.checked = state.encrypt !== false;
			encCb.addEventListener("change", () => { state.encrypt = encCb.checked; lsSet("encrypt", encCb.checked ? "1" : "0"); });
			encLab.append(encCb, document.createTextNode(" 加密（取消勾选 = 不加密：谁拿到都能打开，只适合放本机/可信位置）"));
			rowEnc.append(encLab);
			card.append(rowEnc);

			const rowAcct = el("div", "dsv-row");
			const acct = el("input", "dsv-input");
			acct.placeholder = "账号（可不填；账号不是登录，是密钥的一半 —— 知道密码但不知道账号同样解不开）";
			acct.value = state.account || "";
			acct.addEventListener("input", () => { state.account = acct.value; lsSet("account", acct.value); });
			rowAcct.append(acct);
			card.append(rowAcct);

			const rowPwd = el("div", "dsv-row");
			const pwd = el("input", "dsv-input");
			pwd.type = "password";
			pwd.placeholder = "密码（首字母大写 + 含特殊符号 + ≥8 位）；留空 = 自动生成并显示一次";
			pwd.value = state.password;
			pwd.addEventListener("input", () => { state.password = pwd.value; ssSet("password", pwd.value); });
			rowPwd.append(pwd);
			card.append(rowPwd);

			const rowLocal = el("div", "dsv-row");
			const localLab = el("label", "dsv-lab");
			const localCb = el("input");
			localCb.type = "checkbox";
			localCb.checked = state.local !== false;
			localCb.addEventListener("change", () => {
				state.local = localCb.checked;
				state.useLocal = localCb.checked;
				lsSet("local", localCb.checked ? "1" : "0");
			});
			localLab.append(localCb, document.createTextNode(" 本机免密（DPAPI：本机还原不输密码；换台电脑无效）"));
			rowLocal.append(localLab);
			card.append(rowLocal);

			const rowOut = el("div", "dsv-row");
			const out = el("input", "dsv-input");
			out.placeholder = state.outDir || "输出目录（缺省 G:\\DSH-Backup；此处留空 = 用默认）";
			out.value = state.outDir;
			out.addEventListener("input", () => { state.outDir = out.value.trim(); lsSet("outDir", state.outDir); });
			rowOut.append(out);
			card.append(rowOut);

			const rowBtn = el("div", "dsv-row");
			const bPreview = el("button", "dsv-btn ghost", "① 预览（dry-run）");
			const bRun = el("button", "dsv-btn", "② 确认执行备份");
			const bHealth = el("button", "dsv-btn ghost", "刷新状态");
			rowBtn.append(bPreview, bRun, bHealth);
			card.append(rowBtn);

			const jobBox = el("div");
			card.append(jobBox);
			if (state.raw) {
				const pre = el("pre", "dsv-pre");
				pre.textContent = JSON.stringify(state.job ? state.job.result : null, null, 2);
				card.append(fold("查看原始 JSON 结果", pre));
			}
			view.body.append(card);

			const submit = async (confirm) => {
				const willEncrypt = state.encrypt !== false;
				if (willEncrypt && !state.password && !(state.health && state.health.hasPassword) && state.local === false) {
					say("已选加密，但既没填密码也没勾「本机免密」：请填密码，或勾上本机免密（会自动生成密码并显示一次）", true);
					return;
				}
				try {
					say(confirm ? "提交备份执行…" : "提交备份预览…");
					const d = await post("/backup", {
						encrypt: willEncrypt,
						account: state.account || undefined,
						password: state.password || undefined,
						deviceSlot: state.local !== false,
						outDir: state.outDir || undefined,
						scope: state.scope,
						includeP1: state.includeP1,
						confirm: confirm === true,
					});
					state.follow = d.jobId;
					state.job = d.job;
					renderJob(jobBox, refresh);
				} catch (e) {
					say(`备份请求失败: ${e.message}`, true);
				}
			};
			bPreview.addEventListener("click", () => submit(false));
			bRun.addEventListener("click", () => {
				if (!window.confirm("确认执行真实备份（写盘）？未先预览也可直接执行。")) return;
				submit(true);
			});
			bHealth.addEventListener("click", () => { void refresh(); });

			renderJob(jobBox, refresh);
		}

		// ───────────────────── job 进度面板（2s 轮询） ─────────────────────
		function renderJob(host, refresh) {
			clear(host);
			const job = state.job;
			if (!job) {
				host.append(el("div", "dsv-muted", "（暂无任务；提交后此处显示进度日志，2s 轮询）"));
				return;
			}
			const head = el("div", "dsv-row");
			const pill = el("span", `dsv-pill ${job.status === "running" ? "run" : job.status === "done" ? "done" : "fail"}`, job.status);
			head.append(
				el("strong", undefined, `任务 ${job.kind}`),
				pill,
				el("span", "dsv-muted", `${job.dryRun ? "dry-run" : "真执行"} · ${job.seconds === null ? "进行中" : `${job.seconds}s`}`),
			);
			host.append(head);
			const pre = el("pre", "dsv-pre");
			pre.textContent = (job.logs || []).join("\n") || "（等待日志…）";
			host.append(fold(`运行日志（${(job.logs || []).length} 行）`, pre));
			if (job.status !== "running" && job.result !== null && job.result !== undefined) {
				const rr = job.result || {};
				// ⚠️ 恢复码 / 自动生成的密码只在结果里出现一次 —— 必须醒目提示抄下来
				if (rr.recoveryCode || rr.generatedPassword) {
					const box = el("div", "dsv-card");
					box.style.borderColor = "#c9a227";
					if (rr.recoveryCode) box.append(el("div", undefined, `恢复码（仅此一次，请抄到纸上或存进密码管理器）：${rr.recoveryCode}`));
					if (rr.generatedPassword) box.append(el("div", undefined, `自动生成的密码（仅此一次，请抄下）：${rr.generatedPassword}`));
					box.append(el("div", "dsv-muted", "恢复码丢了 + 账号密码忘了 = 这个包永久打不开。"));
					host.append(box);
				}
				if (rr.encrypted === false) {
					host.append(el("div", "dsv-muted", "⚠️ 这是未加密包：任何人都能打开（头之后就是 gzip）。"));
				} else if (rr.cryptoMode) {
					host.append(el("div", "dsv-muted", `加密模式：${rr.cryptoMode}｜钥匙槽：${(rr.keySlots || []).join(" + ")}`));
				}
				const r = el("pre", "dsv-pre");
				r.textContent = JSON.stringify(job.result, null, 2);
				host.append(fold("查看完整结果 JSON", r));
			}
			if (job.error) {
				const e = el("div", "dsv-msg err");
				e.style.display = "block";
				e.textContent = `失败：${job.error}`;
				host.append(e);
			}
			if (job.status !== "running") {
				const again = el("button", "dsv-btn ghost", "刷新结果");
				again.addEventListener("click", () => { void refresh(); });
				host.append(again);
			}
		}

		// ───────────────────── 区 2：计划 ─────────────────────
		function renderPlan(view, refresh) {
			clear(view.body);
			const p = (state.health && state.health.policy) || {};
			const card = el("div", "dsv-card");
			card.append(el("h4", undefined, "备份计划（滚动保留策略）"));
			card.append(el("div", "dsv-muted", "默认手动档：不自动删包。策略仅在「滚动保留」执行时生效（先预览再确认）。"));
			const table = el("table", "dsv-table");
			const head = el("tr");
			head.append(el("th", undefined, "项"), el("th", undefined, "值"));
			table.append(head);
			for (const [k, lab] of [
				["keepLast", "保留最近 N 份"],
				["minKeep", "最小保留数（永不删）"],
				["keepDaily", "按日保留桶"],
				["keepWeekly", "按周保留桶"],
				["keepMonthly", "按月保留桶"],
				["maxTotalGB", "总体积上限（GB）"],
				["trashDir", "本地删除去向"],
				["trashRetentionDays", "暂存保留天数"],
			]) {
				const tr = el("tr");
				tr.append(el("td", undefined, lab), el("td", undefined, String(p[k] === undefined ? "—" : p[k])));
				table.append(tr);
			}
			card.append(table);

			const rowBtn = el("div", "dsv-row");
			const bNow = el("button", "dsv-btn", "立即按计划备份一次");
			const bPrunePreview = el("button", "dsv-btn ghost", "滚动保留预览（dry-run）");
			const bPruneRun = el("button", "dsv-btn danger", "执行滚动保留（需确认）");
			rowBtn.append(bNow, bPrunePreview, bPruneRun);
			card.append(rowBtn);
			view.body.append(card);

			const jobCard = el("div", "dsv-card");
			const jobBox = el("div");
			jobCard.append(el("h4", undefined, "任务进度"), jobBox);
			view.body.append(jobCard);

			bNow.addEventListener("click", async () => {
				if (state.encrypt !== false && !state.password && !(state.health && state.health.hasPassword) && state.local === false) {
					return say("请先在「一键备份」填密码，或勾上「本机免密」", true);
				}
				try {
					say("按计划提交备份（真执行）…");
					const d = await post("/backup", {
						encrypt: state.encrypt !== false,
						account: state.account || undefined,
						password: state.password || undefined,
						deviceSlot: state.local !== false,
						outDir: state.outDir || undefined,
						scope: state.scope,
						includeP1: state.includeP1,
						confirm: true,
					});
					state.follow = d.jobId;
					state.job = d.job;
					renderJob(jobBox, refresh);
				} catch (e) { say(`提交失败: ${e.message}`, true); }
			});
			bPrunePreview.addEventListener("click", async () => {
				try {
					const d = await post("/prune", { dir: state.outDir || undefined, confirm: false });
					state.follow = d.jobId;
					state.job = d.job;
					renderJob(jobBox, refresh);
				} catch (e) { say(`预览失败: ${e.message}`, true); }
			});
			bPruneRun.addEventListener("click", async () => {
				if (!window.confirm("确认执行滚动保留？（默认移入 _trash/，先预览更稳）")) return;
				try {
					const d = await post("/prune", { dir: state.outDir || undefined, confirm: true });
					state.follow = d.jobId;
					state.job = d.job;
					renderJob(jobBox, refresh);
				} catch (e) { say(`执行失败: ${e.message}`, true); }
			});
			renderJob(jobBox, refresh);
		}

		// ───────────────────── 区 3：目标 ─────────────────────
		function renderTargets(view, refresh) {
			clear(view.body);

			// ───────── 远端目标（NAS / 网络路径 / WebDAV）─────────
			const tCard = el("div", "dsv-card");
			tCard.append(el("h4", undefined, "远端目标（NAS / 网络路径 / WebDAV）"));
			tCard.append(el("div", "dsv-muted", "本地目录就是下面那张卡的「输出目录」。这里配置额外的推送目标：网络路径填 \\\\NAS\\share\\DSH-Backup 或 Z:\\DSH-Backup（和本地目录一样）；WebDAV 填地址+用户名+密码。密码用 DPAPI 加密保存，不落明文。"));
			const tBody = el("div");
			tCard.append(tBody);
			view.body.append(tCard);

			const reloadTargets = async () => {
				clear(tBody);
				let data = null;
				try { data = await api("/targets"); } catch (e) { tBody.append(el("div", "dsv-muted", `读取目标失败：${e.message}`)); return; }
				const list = data?.targets ?? [];
				if (list.length > 0) {
					const table = el("table", "dsv-table");
					const head = el("tr");
					head.append(el("th", undefined, "名称"), el("th", undefined, "类型"), el("th", undefined, "目标"), el("th", undefined, "密码"), el("th", undefined, "操作"));
					table.append(head);
					for (const t of list) {
						const tr = el("tr");
						tr.append(
							el("td", undefined, t.name),
							el("td", undefined, t.type === "unc" ? "网络路径" : t.type === "webdav" ? "WebDAV" : "本地"),
							el("td", undefined, t.type === "webdav" ? `${t.url || "—"}${t.remoteDir ? " / " + t.remoteDir : ""}` : (t.dir || "—")),
							el("td", undefined, t.hasSecret ? "已存" : "—"),
						);
						const ops = el("td");
						const bTest = el("button", "dsv-btn ghost", "测试连接");
						bTest.addEventListener("click", async () => {
							say(`测试 ${t.name} …`);
							try {
								const r = await post("/targets/test", { target: t, confirm: true });
								say(r.ok ? `✓ ${t.name} 连通（已在目标里写探针文件）` : `✗ ${t.name}：${(r.errors || []).join("；")}`, !r.ok);
							} catch (e) { say(`测试失败：${e.message}`, true); }
						});
						const bDel = el("button", "dsv-btn danger", "删除");
						bDel.addEventListener("click", async () => {
							if (!window.confirm(`删除目标 ${t.name}？`)) return;
							// 显式点名删除（服务端是 upsert + remove 语义）：不用整表覆盖，
							// 避免"漏传一条就静默删掉别人的目标"（GLM-5.3 审查 B-10）
							try { await post("/targets", { remove: [t.name] }); say(`已删除 ${t.name}`); void reloadTargets(); }
							catch (e) { say(`删除失败：${e.message}`, true); }
						});
						ops.append(bTest, bDel);
						tr.append(ops);
						table.append(tr);
					}
					tBody.append(table);
				} else {
					tBody.append(el("div", "dsv-muted", "（还没配置远端目标；备份只落在本地）"));
				}

				// 添加/更新表单
				const form = el("div");
				const f0 = el("div", "dsv-row");
				const nameI = el("input", "dsv-input"); nameI.placeholder = "名称（如 NAS-WebDAV）";
				const typeS = el("select", "dsv-input");
				for (const [v, lab] of [["unc", "网络路径 / 映射盘"], ["webdav", "WebDAV"], ["local", "本机另一个目录"]]) {
					const o = document.createElement("option"); o.value = v; o.textContent = lab; typeS.append(o);
				}
				f0.append(nameI, typeS);
				const f1 = el("div", "dsv-row");
				const dirI = el("input", "dsv-input"); dirI.placeholder = "路径：\\\\NAS\\share\\DSH-Backup 或 Z:\\DSH-Backup";
				const urlI = el("input", "dsv-input"); urlI.placeholder = "WebDAV 地址：https://nas.local:5006/dav/";
				const remoteI = el("input", "dsv-input"); remoteI.placeholder = "远端目录：DSH-Backup";
				const userI = el("input", "dsv-input"); userI.placeholder = "用户名（可空）";
				const passI = el("input", "dsv-input"); passI.type = "password"; passI.placeholder = "密码（DPAPI 加密保存，不落明文）";
				f1.append(dirI, urlI, remoteI, userI, passI);
				const sync = () => {
					const t = typeS.value;
					dirI.style.display = t === "webdav" ? "none" : "";
					urlI.style.display = remoteI.style.display = t === "webdav" ? "" : "none";
					userI.style.display = passI.style.display = t === "local" ? "none" : "";
				};
				typeS.addEventListener("change", sync);
				const f2 = el("div", "dsv-row");
				const bAdd = el("button", "dsv-btn", "保存目标");
				bAdd.addEventListener("click", async () => {
					const name = (nameI.value || "").trim();
					if (!name) return say("请填名称", true);
					const t = {
						name, type: typeS.value, enabled: true,
						dir: dirI.value.trim(), url: urlI.value.trim(), remoteDir: remoteI.value.trim(),
						user: userI.value.trim(), secret: passI.value,
					};
					try {
						await post("/targets", { targets: [...list.filter((x) => x.name !== name), t] });
						say(`已保存目标 ${name}（推进设置时填它的名字即可）`);
						void reloadTargets();
					} catch (e) { say(`保存失败：${e.message}`, true); }
				});
				f2.append(bAdd);
				form.append(f0, f1, f2);
				tBody.append(form);
				sync();
			};
			void reloadTargets();

			const card = el("div", "dsv-card");
			card.append(el("h4", undefined, "备份目标与扫描预览"));
			const row = el("div", "dsv-row");
			const out = el("input", "dsv-input");
			out.value = state.outDir;
			out.placeholder = "输出目录（留空 = 默认 G:\\DSH-Backup）";
			out.addEventListener("input", () => { state.outDir = out.value.trim(); lsSet("outDir", state.outDir); });
			const bScan = el("button", "dsv-btn", "扫描预览（零副作用）");
			row.append(out, bScan);
			card.append(row);
			const env = state.health;
			card.append(el("div", "dsv-muted", env
				? `DSH_HOME=${env.dshHome} · DSH ${env.install && env.install.version ? env.install.version : "unknown"} · 还原器${env.restoreCli ? "就绪" : "缺失"}`
				: "（未取到运行环境快照）"));
			const wsl = el("div", "dsv-muted");
			wsl.textContent = env && env.workspaces && env.workspaces.length
				? `已注册工作区 ${env.workspaces.length} 个：${env.workspaces.map((w) => w.name).join("、")}`
				: "（未发现工作区注册表）";
			card.append(wsl);
			view.body.append(card);

			const jobCard = el("div", "dsv-card");
			const jobBox = el("div");
			jobCard.append(el("h4", undefined, "任务进度"), jobBox);
			view.body.append(jobCard);

			if (state.scan) {
				const sc = el("div", "dsv-card");
				sc.append(el("h4", undefined, `上次扫描：${state.scan.totalFiles} 文件 / ${state.scan.totalSize}（排除 ${state.scan.excludedCount} 条 / ${fmtBytes(state.scan.excludedBytes)}）`));
				const table = el("table", "dsv-table");
				const head = el("tr");
				for (const h of ["分区", "文件", "体积", "P0", "P1", "排除"]) head.append(el("th", undefined, h));
				table.append(head);
				for (const r of state.scan.reports || []) {
					const tr = el("tr");
					for (const v of [r.label || r.id, r.files, r.size || fmtBytes(r.bytes), r.tier0, r.tier1, r.excluded]) {
						tr.append(el("td", undefined, String(v)));
					}
					table.append(tr);
				}
				sc.append(table);
				const sample = (state.scan.reports || []).flatMap((r) => r.excludedSample || []).slice(0, 12);
				if (sample.length) {
					const pre = el("pre", "dsv-pre");
					pre.textContent = sample.map((e) => `- ${e.rel} — ${fmtBytes(e.size)} — [${e.rule}] ${e.reason}`).join("\n");
					sc.append(fold(`排除样本（前 ${sample.length} 条）`, pre));
				}
				view.body.append(sc);
			}

			bScan.addEventListener("click", async () => {
				try {
					const d = await post("/scan", { scope: state.scope, includeP1: state.includeP1, topExcluded: 15 });
					state.follow = d.jobId;
					state.job = d.job;
					renderJob(jobBox, refresh);
				} catch (e) { say(`扫描失败: ${e.message}`, true); }
			});
			renderJob(jobBox, refresh);
		}

		// ───────────────────── 区 4：历史 ─────────────────────
		function renderHistory(view, refresh) {
			clear(view.body);
			const card = el("div", "dsv-card");
			card.append(el("h4", undefined, "历史备份包"));
			const row = el("div", "dsv-row");
			const bReload = el("button", "dsv-btn ghost", "刷新列表");
			row.append(bReload);
			card.append(row);
			if (!state.list) {
				card.append(el("div", "dsv-muted", "（尚未加载；点「刷新列表」）"));
			} else if (!state.list.count) {
				card.append(el("div", "dsv-muted", `目录 ${state.list.dir} 下没有发现 .vault 包`));
			} else {
				card.append(el("div", "dsv-muted", `${state.list.dir} · ${state.list.count} 个逻辑包 / ${state.list.totalSize}`));
				const table = el("table", "dsv-table");
				const head = el("tr");
				for (const h of ["包名", "时间", "类型", "卷", "体积", "操作"]) head.append(el("th", undefined, h));
				table.append(head);
				for (const g of state.list.groups) {
					const tr = el("tr");
					const main = el("td", undefined, g.key);
					tr.append(main, el("td", undefined, fmtTime(g.createdAt)), el("td", undefined, `${g.kind}/${g.scope}`), el("td", undefined, String(g.parts)), el("td", undefined, g.size));
					const ops = el("td");
					const mk = (label, cls, fn) => {
						const b = el("button", `dsv-btn ${cls}`, label);
						b.style.marginRight = "4px";
						b.addEventListener("click", fn);
						return b;
					};
					const bVerify = mk("校验", "ghost", async () => {
						if (!state.password && !(state.health && state.health.hasPassword) && !state.useLocal) {
							return say("校验需要凭证：填密码，或勾选「用本机免密」", true);
						}
						state.job = { kind: "verify", dryRun: false, status: "running", logs: ["提交校验…"], result: null, seconds: null };
						state.follow = null;
						try {
							const d = await post("/verify", {
								package: g.main,
								account: state.account || undefined,
								password: state.password || undefined,
								local: state.useLocal === true,
							});
							state.follow = d.jobId;
							state.job = d.job;
						} catch (e) { say(`校验失败: ${e.message}`, true); }
						renderJobByState();
					});
					const bList = mk("还原预览", "ghost", async () => {
						try {
							const d = await post("/restore", { package: g.main, confirm: false });
							state.follow = d.jobId;
							state.job = d.job;
							renderJobByState();
						} catch (e) { say(`预览失败: ${e.message}`, true); }
					});
					const bRestore = mk("还原", "danger", async () => {
						const target = window.prompt("解包目标目录（留空 = 原位还原 inPlace）", "");
						if (target === null) return;
						if (!state.password && !(state.health && state.health.hasPassword) && !state.useLocal) {
							return say("还原需要凭证：填密码，或勾选「用本机免密」", true);
						}
						if (!window.confirm(`确认还原 ${g.key}？${target ? `解包到 ${target}` : "原位映射还原（写前会先把原目录改名 .bak-<时间戳>）"}`)) return;
						try {
							const d = await post("/restore", {
								package: g.main,
								account: state.account || undefined,
								password: state.password || undefined,
								local: state.useLocal === true,
								target: target || undefined,
								inPlace: target ? false : true,
								confirm: true,
							});
							state.follow = d.jobId;
							state.job = d.job;
							renderJobByState();
						} catch (e) { say(`还原失败: ${e.message}`, true); }
					});
					ops.append(bVerify, bList, bRestore);
					tr.append(ops);
					table.append(tr);
				}
				card.append(table);
			}
			view.body.append(card);

			const jobCard = el("div", "dsv-card");
			jobCard.append(el("h4", undefined, "任务进度"));
			const jobBox = el("div");
			jobBox.id = "dsv-job-host";
			jobCard.append(jobBox);
			view.body.append(jobCard);
			renderJob(jobBox, refresh);

			bReload.addEventListener("click", async () => {
				try {
					const d = await api(`/list${state.outDir ? `?dir=${encodeURIComponent(state.outDir)}` : ""}`);
					state.list = d;
					renderHistory(view, refresh);
				} catch (e) { say(`列表加载失败: ${e.message}`, true); }
			});
			if (!state.list) {
				void (async () => {
					try {
						const d = await api(`/list${state.outDir ? `?dir=${encodeURIComponent(state.outDir)}` : ""}`);
						state.list = d;
						if (state.tab === "history") renderHistory(view, refresh);
					} catch (e) { say(`列表加载失败: ${e.message}`, true); }
				})();
			}
		}

		// 供历史区（局部重渲染后）刷 job 面板：重渲染整表会丢引用，这里退化为整页刷新
		function renderJobByState() {
			state.pendingRender = true;
		}

		// ───────────────────── 区 5：设置 ─────────────────────
		function renderSettings(view, refresh) {
			clear(view.body);
			const card = el("div", "dsv-card");
			card.append(el("h4", undefined, "设置"));
			const rows = [
				["API 前缀", API],
				["密码来源", "面板输入（sessionStorage：浏览器会话级存储，可能被 Electron 缓存在 profile 里，关闭标签即清）→ DSHVAULT_PASSWORD 环境变量 → 插件 config.password"],
				["密码要求", "首字母大写 · 含特殊符号 · ≥8 位（不合规会在打包时就被拒）"],
				["加密与钥匙槽", "加密：账号密码 + 恢复码 + 本机免密（DPAPI）三个槽，跨机用「账号+密码」｜不加密：谁拿到都能打开，只适合放本机"],
				["账号", "不做要求（可不填；大小写 / 空格 / 全角自动归一）。它不是登录，是密钥的一半"],
				["轮询间隔", `${POLL_MS} ms`],
				["输出目录", state.outDir || "（默认 G:\\DSH-Backup）"],
				["插件版本", (state.health && state.health.version) || "—"],
			];
			// 键值表：加 .dsv-kv 走"首列固定窄宽 + 值列折行"的规则
			// （不加的话长说明会被 nowrap 撑破容器、右侧被裁 —— 2026-10-17 操作者截图指出）
			const table = el("table", "dsv-table dsv-kv");
			for (const [k, v] of rows) {
				const tr = el("tr");
				tr.append(el("td", undefined, k), el("td", undefined, String(v)));
				table.append(tr);
			}
			card.append(table);

			const row = el("div", "dsv-row");
			const rawLab = el("label", "dsv-muted");
			const raw = el("input");
			raw.type = "checkbox";
			raw.checked = state.raw;
			raw.addEventListener("change", () => { state.raw = raw.checked; lsSet("raw", raw.checked ? "1" : "0"); });
			rawLab.append(raw, document.createTextNode(" 显示原始 JSON 结果"));
			const bPwd = el("button", "dsv-btn ghost", "清空本会话密码");
			bPwd.addEventListener("click", () => { state.password = ""; ssSet("password", ""); say("已清空内存中的密码"); });
			const bStore = el("button", "dsv-btn danger", "清空本地存储（目录/范围偏好）");
			bStore.addEventListener("click", () => {
				try {
					window.localStorage.removeItem("dshvault.outDir");
					window.localStorage.removeItem("dshvault.scope");
					window.localStorage.removeItem("dshvault.includeP1");
					window.localStorage.removeItem("dshvault.raw");
				} catch { /* 存储不可用 */ }
				state.outDir = "";
				state.scope = "core";
				state.includeP1 = false;
				state.raw = false;
				say("本地偏好已清空");
				renderSettings(view, refresh);
			});
			const bHealth = el("button", "dsv-btn ghost", "重新读取运行环境");
			bHealth.addEventListener("click", () => { void refresh(); });
			row.append(rawLab, bPwd, bStore, bHealth);
			card.append(row);
			view.body.append(card);
		}

		// ───────────────────────────── apply ─────────────────────────────
		// ── 设置页分区（settings.section）────────────────────────────────────
		// 正确契约（对照本机可用的 dsh-prompt-inject/lib/client.js:392-396）：
		//   slots.register(描述符, 渲染函数)   ← **两个参数**
		//   描述符 = { name, id, order, label }（**没有 component 字段**）
		//   渲染函数必须返回 **React 元素**
		//
		// 2026-10-16 踩过的三个坑（都已在这里绕过）：
		//   ① 注册到 conversation.view → 设置页里永远看不到（分区不在那儿）；
		//   ② 单参数 + component:{render(){return {dispose}}} → 分区出现、但点开**全空白**；
		//   ③ 渲染函数返回原生 DOM → 分区**整个消失**（React 不接受原生节点当元素）。
		// 面板本体仍是命令式 DOM（build() + 各 render* 函数），用一个 React 组件用 ref 挂载它。
		function VaultPanel() {
			const hostRef = React.useRef(null);
			React.useEffect(() => {
				const view = build();
				const host = hostRef.current;
				if (!host) return;
				host.appendChild(view.page);

				let disposed = false;

				const refresh = async () => {
					try {
						state.health = await api("/health");
					} catch (e) {
						view.say(`host API 不可达（${API}）：${e.message}`, true);
					}
					if (state.follow) {
						try {
							const d = await api(`/jobs/${encodeURIComponent(state.follow)}`);
							state.job = d.job;
							if (d.job && d.job.status !== "running") {
								state.follow = null;
								if (d.job.kind === "scan" && d.job.result) state.scan = d.job.result;
								if (d.job.kind === "backup" && d.job.status === "done") {
									try { state.list = await api(`/list${state.outDir ? `?dir=${encodeURIComponent(state.outDir)}` : ""}`); } catch { /* 列表刷新失败不阻塞 */ }
								}
							}
						} catch (e) {
							view.say(`job 轮询失败: ${e.message}`, true);
							state.follow = null;
						}
					}
					renderBody();
				};

				const renderBody = () => {
					view.renderTabs();
					const rerender = () => renderBody();
					if (state.tab === "backup") renderBackup(view, rerender);
					else if (state.tab === "plan") renderPlan(view, rerender);
					else if (state.tab === "targets") renderTargets(view, rerender);
					else if (state.tab === "history") renderHistory(view, rerender);
					else renderSettings(view, rerender);
				};

				renderBody();
				// 标签页点击回调：必须在 renderBody **定义之后**赋值
				// （build() 里的 click 处理器通过 view.onTab 间接调用它，
				//   否则会 ReferenceError → 点标签页没反应）
				view.onTab = () => renderBody();
				void refresh();
				const timer = window.setInterval(() => {
					if (disposed) return;
					if (state.follow) void refresh();
					else if (state.pendingRender) { state.pendingRender = false; renderBody(); }
				}, POLL_MS);

				return () => {                       // React 卸载时清理
					disposed = true;
					window.clearInterval(timer);
				};
			}, []);
			return React.createElement("div", { className: "dsv-host", ref: hostRef });
		}

		// locale 命名空间是**常量字符串** —— 子代理实测 `dsh-client-locale` 的真实签名是
		//   register(ns, localeOrDicts, dict) → 返回 **disposer**，不是命名空间本身。
		// 我此前把返回值当命名空间塞进 descriptor.locale → bind(函数) 查表失败、label 退化成 key。
		const NS = "dsh-vault";

		function apply(ctx) {
			// ① locale 字典（用 ctx.effect 包裹：卸载时回收；对照 skills-manager
			//    `e.effect(() => e.locale.register(Jg, ah))`）
			ctx.effect(() => ctx.locale.register(NS, {
				zh: { title: "备份" },
				en: { title: "Backup" },
			}), "dsh-vault: locale 字典");

			// ② 设置页分区。契约（子代理从内核 ui-renderer / SlotCore 实测）：
			//    · 描述符存进 entry.options 的只有 name/id/order/label/priority —— `icon` 会被丢弃（可省）
			//    · 第 2 参必须是 **React 组件本身**（ui-renderer 组装 props 后渲染 entry.component）
			//    · descriptor.locale 必须与 locale.register 的命名空间一致，否则 label 解析失败
			//    · 直接用 ctx.slots / ctx.locale（已在模块 inject 里声明）——
			//      用 ctx.get 兜底会在服务未就绪时拿到 undefined，造成"有时注册不上"的竞态
			ctx.effect(() => ctx.slots.inject("settings.section", () => ctx.slots.register(
				{
					name: "settings.section",
					id: "dsh-vault-settings",
					order: 60,
					label: () => ctx.locale.bind(NS)("title"),
					locale: NS,
				},
				VaultPanel,
			)), "dsh-vault: settings.section 面板");
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
