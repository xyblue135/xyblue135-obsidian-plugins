/*
 * xyblue135 · 岗位透镜
 * 类型：xyblue135 开源插件
 * 说明：侧栏图标直接打开面板展示最新报告 MD（渲染 markdown）；主流程「岗位契合度发现」
 *       从技能提炼的技能矩阵（data.refined 定级）反推最适合的岗位方向；可选定向岗位分析
 *       （可粘贴真实 JD）。报告 MD 存储在插件目录 reports/ 内；缺口/学习方向可导出为
 *       收件箱待办。市场数据来自模型知识（非实时），报告内已标注。
 *       网关与技能清单从 skill-miner 的 data.json 只读复用，本插件不存密钥。
 */
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const obsidian_1 = require("obsidian");

const VIEW_TYPE = "xyblue135-job-lens-view";

const DEFAULT_SETTINGS = {
    inbox: "my_blog/00_docs/收件箱",
    skillMinerId: "00_xyblue135-skill-miner",
    lastRole: "",
    history: [],
    reportPaths: [],
    lastReportPath: "",
};

function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
}

/* ---------------- LLM（node https，429/502 自动重试） ---------------- */
function llmChat(base, key, model, messages, timeoutMs) {
    let attempt = 0;
    const once = () => llmChatOnce(base, key, model, messages, timeoutMs);
    const retry = (e) => {
        const msg = String((e && e.message) || "");
        if (/502|429|rate|limit/i.test(msg) && attempt < 2) {
            attempt++;
            return new Promise((r) => setTimeout(r, 3000 * attempt)).then(once).catch(retry);
        }
        throw e;
    };
    return once().catch(retry);
}
function llmChatOnce(base, key, model, messages, timeoutMs) {
    return new Promise((resolve, reject) => {
        const mod = base.startsWith("https") ? require("https") : require("http");
        const url = base.replace(/\/+$/, "") + "/chat/completions";
        const body = JSON.stringify({ model: model || "auto", messages: messages, temperature: 0.3 });
        const req = mod.request(url, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
            timeout: timeoutMs,
        }, (res) => {
            let buf = "";
            res.on("data", (c) => { buf += c; });
            res.on("end", () => {
                try {
                    const d = JSON.parse(buf);
                    if (d.error) return reject(new Error(d.error.message || JSON.stringify(d.error).slice(0, 120)));
                    resolve(String((d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || ""));
                } catch (e) { reject(new Error("网关返回解析失败: " + buf.slice(0, 120))); }
            });
        });
        req.on("timeout", () => req.destroy(new Error("AI 请求超时")));
        req.on("error", reject);
        req.write(body);
        req.end();
    });
}
function extractJson(text) {
    const m = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    const raw = m ? m[1] : text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
    return JSON.parse(raw);
}

/* ---------------- 主插件 ---------------- */
class JobLensPlugin extends obsidian_1.Plugin {
    async onload() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
        this.registerView(VIEW_TYPE, (leaf) => new JobLensView(leaf, this));
        const ribbonEl = this.addRibbonIcon("compass", "岗位透镜", () => this.activateView());
        ribbonEl.addClass("xyblue135-ribbon xyblue135-ai");
        this.addCommand({ id: "open", name: "打开岗位透镜面板", callback: () => this.activateView() });
        this.addCommand({ id: "discover", name: "岗位契合度发现（从技能矩阵反推）", callback: () => this.runDiscover("") });
        this.addCommand({ id: "export-todos", name: "导出最近分析的缺口为收件箱待办", callback: () => this.exportTodos() });
        this.addSettingTab(new JobLensSettingTab(this.app, this));
        void this.migrateLegacyReports();
    }
    onunload() { }
    async saveSettings() { await this.saveData(this.settings); }

    /* 旧版报告（求职/岗位透镜/）一次性迁移进插件 reports/ 目录 */
    async migrateLegacyReports() {
        if (this.settings.lastReportPath) return;
        try {
            const legacy = this.app.vault.getMarkdownFiles()
                .filter((f) => f.path.indexOf("求职/岗位透镜/") === 0)
                .sort((a, b) => b.stat.mtime - a.stat.mtime);
            if (!legacy.length) return;
            const dir = obsidian_1.normalizePath(this.manifest.dir + "/reports");
            await this.app.vault.adapter.mkdir(dir).catch(() => {});
            for (const f of legacy) {
                const md = await this.app.vault.read(f);
                await this.app.vault.adapter.write(dir + "/" + f.name, md);
                this.settings.reportPaths = [dir + "/" + f.name].concat(this.settings.reportPaths || []);
            }
            this.settings.lastReportPath = dir + "/" + legacy[0].name;
            await this.saveSettings();
            console.log("[岗位透镜] 已迁移", legacy.length, "份历史报告");
        } catch (e) { /* 迁移失败不阻塞 */ }
    }

    async loadSkillMiner() {
        const raw = await this.app.vault.adapter.read(".obsidian/plugins/" + this.settings.skillMinerId + "/data.json");
        const j = JSON.parse(raw);
        const st = j.settings || {};
        const refined = (j.data && Array.isArray(j.data.refined)) ? j.data.refined : [];
        const inventory = refined.map((r) => r.name + "|" + (r.track || "") + "|" + (r.level || "")).join("\n");
        return { base: st.baseUrl, key: st.apiKey, model: st.model || "auto", inventory: inventory, refinedCount: refined.length };
    }

    async activateView() {
        const { workspace } = this.app;
        let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
        if (!leaf) {
            leaf = workspace.getLeaf("tab");
            await leaf.setViewState({ type: VIEW_TYPE, active: true });
        }
        workspace.revealLeaf(leaf);
    }

    refreshViewIfOpen() {
        const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
        if (leaf && leaf.view && typeof leaf.view.renderLatest === "function") {
            void leaf.view.renderLatest();
        }
    }

    openModal() {
        new JobLensModal(this.app, this).open();
    }

    /* ---------- 主流程：岗位契合度发现（零输入，从矩阵反推） ---------- */
    async discover(preferNote) {
        const sm = await this.loadSkillMiner();
        if (!sm.base || !sm.key) throw new Error("未读到 AI 网关配置（检查技能提炼插件是否运行过）");
        if (!sm.inventory) throw new Error("技能清单为空（先在技能提炼里重建矩阵并完成 AI 提炼）");
        const sys = [
            "你是资深技术招聘顾问，熟悉中国就业市场 2024-2026（注意：市场认知来自训练数据，非实时，结论保守）。",
            "输入：候选人的技能清单（每行 `技能名|方向|定级`，定级来自其知识库证据链）。可能附候选人偏好说明。",
            "任务：反推候选人当前技能组合最适合哪些岗位方向——不是验证某个岗位，而是发现岗位。",
            "要求：",
            "1. 以技能清单为唯一事实来源，只推荐清单能支撑的岗位，宁缺毋滥；",
            "2. 覆盖三类：直接可投（核心技能全占）、补强后强（差1~2个高频技能，说明补什么）、差异化蓝海（稀缺组合，竞争少）；",
            "3. 每个岗位给出 Boss 直聘上实际应该搜的搜索关键词；",
            "4. 薪资给保守区间并注明仅供参考。",
            "只输出 JSON：",
            '{"market_note":"当前市场环境一句话(<=100字)",',
            ' "roles":[{"role":"岗位名","fit":0到100,"tier":"直接可投|补强后强|差异化蓝海","why":"契合理由(引用具体技能簇名)","matching":["核心匹配簇"],"missing_easy":["容易补的小缺口"],"missing_hard":["需大投入的缺口"],"search_keywords":["Boss搜索词"],"salary_hint":"保守区间(仅供参考)"}] (6~10个,按fit降序),',
            ' "advice":"一句话建议(<=80字)"}',
        ].join("\n");
        const user = "【候选人技能清单】\n" + sm.inventory + (preferNote ? "\n\n【候选人偏好】\n" + preferNote : "");
        let out = await llmChat(sm.base, sm.key, sm.model, [
            { role: "system", content: sys },
            { role: "user", content: user },
        ], 90000);
        let data;
        try { data = extractJson(out); } catch (e) {
            out = await llmChat(sm.base, sm.key, sm.model, [
                { role: "system", content: sys + "\n上一次输出无法解析。重新输出，必须是一个合法 JSON 对象。" },
                { role: "user", content: user },
            ], 90000);
            data = extractJson(out);
        }
        data.generatedAt = Date.now();
        data.refinedCount = sm.refinedCount;
        this.settings.history = [{ role: "岗位契合度发现", at: data.generatedAt }].concat(this.settings.history || []).slice(0, 20);
        await this.saveSettings();
        return data;
    }

    /* ---------- 次流程：定向分析指定岗位（可选贴 JD） ---------- */
    async analyze(role, jdText) {
        const sm = await this.loadSkillMiner();
        if (!sm.base || !sm.key) throw new Error("未读到 AI 网关配置（检查技能提炼插件是否运行过）");
        if (!sm.inventory) throw new Error("技能清单为空（先在技能提炼里重建矩阵并完成 AI 提炼）");
        const sys = [
            "你是资深技术招聘顾问，熟悉中国就业市场 2024-2026（注意：市场认知来自训练数据，非实时，结论保守）。",
            "输入：目标岗位描述（可能附真实 JD）+ 候选人技能清单（每行 `技能名|方向|定级`）。",
            "任务：给出该岗位的技能需求画像，并与候选人逐项比对。",
            "只输出 JSON：",
            '{"role_title":"岗位规范名","market_summary":"市场行情一句话(<=120字)",',
            ' "demand":[{"skill":"技能","tier":"核心|常见|加分","note":"典型形态"}] (12~18条,按出现频率排序),',
            ' "match_score":0到100,',
            ' "strong":[{"skill":"","your_level":"","note":"简历可主打"}],',
            ' "gaps":[{"skill":"","market_tier":"","your_level":"无|了解","priority":"P0|P1|P2","why":"","target":""}] (最多10条),',
            ' "overqualified":["市场很少要求但候选人精通"],',
            ' "learning_top5":[{"direction":"","why_market":"","target":"","related":""}] (恰好5条),',
            ' "advice":"(<=80字)"}',
        ].join("\n");
        const user = "【目标岗位】" + role + (jdText ? "\n\n【真实 JD 原文（优先依据它）】\n" + jdText.slice(0, 3000) : "\n（未提供 JD，按市场通用画像分析）")
            + "\n\n【候选人技能清单】\n" + sm.inventory;
        let out = await llmChat(sm.base, sm.key, sm.model, [
            { role: "system", content: sys },
            { role: "user", content: user },
        ], 90000);
        let data;
        try { data = extractJson(out); } catch (e) {
            out = await llmChat(sm.base, sm.key, sm.model, [
                { role: "system", content: sys + "\n上一次输出无法解析。重新输出，必须是一个合法 JSON 对象。" },
                { role: "user", content: user },
            ], 90000);
            data = extractJson(out);
        }
        data.role_input = role;
        data.generatedAt = Date.now();
        data.refinedCount = sm.refinedCount;
        this.settings.lastRole = role;
        this.settings.history = [{ role: role, score: data.match_score, at: data.generatedAt }].concat(this.settings.history || []).slice(0, 20);
        await this.saveSettings();
        return data;
    }

    /* ---------- 报告写入插件目录 reports/ ---------- */
    async saveReportMd(md, kind, role) {
        const dir = obsidian_1.normalizePath(this.manifest.dir + "/reports");
        await this.app.vault.adapter.mkdir(dir).catch(() => {});
        const date = new Date();
        const pad = (n) => String(n).padStart(2, "0");
        const ds = date.getFullYear() + pad(date.getMonth() + 1) + pad(date.getDate()) + "-" + pad(date.getHours()) + pad(date.getMinutes());
        const safe = String(role || "").replace(/[\\/:*?"<>|]/g, "_").slice(0, 40);
        const path = dir + "/" + kind + (safe ? "-" + safe : "") + "-" + ds + ".md";
        await this.app.vault.adapter.write(path, md);
        this.settings.lastReportPath = path;
        this.settings.reportPaths = [path].concat(this.settings.reportPaths || []).slice(0, 30);
        await this.saveSettings();
        this.refreshViewIfOpen();
        return path;
    }

    async buildDiscoverMd(data) {
        const date = new Date(data.generatedAt);
        const pad = (n) => String(n).padStart(2, "0");
        const ds = date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + " " + pad(date.getHours()) + ":" + pad(date.getMinutes());
        const tierIcon = { "直接可投": "✅", "补强后强": "🧱", "差异化蓝海": "💎" };
        let md = "---\ntags: [求职, 岗位发现]\n---\n";
        md += "# 岗位契合度分析（由技能矩阵反推）\n\n";
        md += "> " + ds + " · 数据来源：模型市场知识（非实时）+ 技能矩阵 " + (data.refinedCount || 0) + " 簇 · 按契合度降序\n\n";
        md += "## 市场环境\n" + (data.market_note || "") + "\n\n";
        (data.roles || []).forEach((r) => {
            md += "## " + (tierIcon[r.tier] || "") + " " + r.role + " — 契合度 " + (r.fit == null ? "?" : r.fit) + "/100\n";
            md += "- **契合理由**：" + (r.why || "") + "\n";
            md += "- **匹配簇**：" + (r.matching || []).join("、") + "\n";
            if ((r.missing_easy || []).length) md += "- **小缺口（容易补）**：" + r.missing_easy.join("、") + "\n";
            if ((r.missing_hard || []).length) md += "- **大缺口**：" + r.missing_hard.join("、") + "\n";
            md += "- **Boss 搜索词**：" + (r.search_keywords || []).map((k) => "`" + k + "`").join(" / ") + "\n";
            if (r.salary_hint) md += "- **薪资参考**：" + r.salary_hint + "（仅供参考）\n";
            md += "\n";
        });
        md += "## 建议\n" + (data.advice || "") + "\n";
        return md;
    }

    async buildTargetedMd(data) {
        const date = new Date(data.generatedAt);
        const pad = (n) => String(n).padStart(2, "0");
        const ds = date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + " " + pad(date.getHours()) + ":" + pad(date.getMinutes());
        const tierIcon = { "核心": "🔴 核心", "常见": "🟡 常见", "加分": "🟢 加分" };
        let md = "---\ntags: [求职, 岗位分析]\n---\n";
        md += "# 岗位透镜 · " + (data.role_title || data.role_input) + "\n\n";
        md += "> " + ds + " · 匹配度 **" + (data.match_score == null ? "—" : data.match_score) + "/100** · 模型市场知识（非实时）+ 技能矩阵（" + (data.refinedCount || 0) + " 簇）\n\n";
        md += "## 市场概要\n" + (data.market_summary || "") + "\n\n";
        md += "## 技能需求画像\n" + (data.demand || []).map((x) => "- " + (tierIcon[x.tier] || x.tier) + " **" + x.skill + "** — " + (x.note || "")).join("\n") + "\n\n";
        md += "## ✅ 优势（市场要 + 你强，简历主打）\n" + (data.strong || []).map((x) => "- **" + x.skill + "**（" + (x.your_level || "") + "）— " + (x.note || "")).join("\n") + "\n\n";
        md += "## 🔴 差距（市场要 + 你弱，按优先级）\n" + (data.gaps || []).map((x) => "- **[" + x.priority + "] " + x.skill + "**（市场:" + (x.market_tier || "") + " / 你:" + (x.your_level || "无") + "）— " + (x.why || "") + " → 目标: " + (x.target || "")).join("\n") + "\n\n";
        md += "## 🟡 市场少提但你精通（简历降权）\n" + (data.overqualified || []).map((x) => "- " + x).join("\n") + "\n\n";
        md += "## 🎯 学习方向 Top5\n" + (data.learning_top5 || []).map((x, i) =>
            (i + 1) + ". **" + x.direction + "** — " + (x.why_market || "") + "\n   达标: " + (x.target || "") + (x.related ? "（衔接: " + x.related + "）" : "")).join("\n") + "\n\n";
        md += "## 建议\n" + (data.advice || "") + "\n";
        return md;
    }

    async runDiscover(preferNote) {
        const data = await this.discover(preferNote);
        this._lastData = data;
        const md = await this.buildDiscoverMd(data);
        const path = await this.saveReportMd(md, "岗位契合度分析", "");
        return { path: path, data: data };
    }

    async runTargeted(role, jdText) {
        const data = await this.analyze(role, jdText);
        this._lastData = data;
        const md = await this.buildTargetedMd(data);
        const path = await this.saveReportMd(md, "岗位分析", data.role_title || role);
        return { path: path, data: data };
    }

    /* ---------- 导出缺口/学习方向为收件箱待办 ---------- */
    async exportTodos() {
        const data = this._lastData;
        if (!data) { new obsidian_1.Notice("请先重新运行一次分析（导出依赖本次会话的分析结果）"); return; }
        const inbox = this.settings.inbox;
        await this.app.vault.adapter.mkdir(obsidian_1.normalizePath(inbox)).catch(() => {});
        const now = new Date();
        const pad = (p) => String(p).padStart(2, "0");
        const stamp = "" + now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds()) + "000";
        let tasks = [];
        if (data.learning_top5) {
            for (const x of data.learning_top5) tasks.push({ title: "学习-" + x.direction, why: x.why_market, target: x.target, extra: x.related ? "衔接: " + x.related : "" });
        } else if (data.roles) {
            for (const r of data.roles) {
                if (r.tier === "直接可投") continue;
                for (const g of (r.missing_easy || [])) tasks.push({ title: "补缺-" + r.role + "-" + g, why: "解锁岗位: " + r.role + "（契合度 " + (r.fit == null ? "?" : r.fit) + "）", target: "", extra: "" });
            }
        }
        let n = 0;
        for (const t of tasks) {
            const safe = String(t.title).replace(/[\\/:*?"<>|]/g, "_").slice(0, 50);
            const fm = "---\nstatus: 🔴 undone\nvisibility: 🟢 open\nupdated: " + stamp + "\nsource: 岗位透镜\nAI_tags: [学习计划]\nAI_summary_short: " + String(t.why || "").slice(0, 80) + "\n---\n";
            const body = "# " + t.title + "\n\n> 市场依据: " + (t.why || "") + "\n> 达标标准: " + (t.target || "—") + (t.extra ? "\n> " + t.extra : "") + "\n";
            try {
                await this.app.vault.create(obsidian_1.normalizePath(inbox + "/" + safe + ".md"), fm + body);
                n++;
            } catch (e) { /* 同名跳过 */ }
        }
        new obsidian_1.Notice("已导出 " + n + " 条待办到收件箱（待完成工作台可见）");
    }
}

/* ---------------- 面板视图：直接展示最新报告 MD ---------------- */
class JobLensView extends obsidian_1.ItemView {
    constructor(leaf, plugin) {
        super(leaf);
        this.plugin = plugin;
        this.showPath = null;
    }
    getViewType() { return VIEW_TYPE; }
    getDisplayText() { return "岗位透镜"; }
    getIcon() { return "compass"; }

    async onOpen() {
        this.contentEl.empty();
        this.contentEl.addClass("xyjl-view");
        const bar = this.contentEl.createDiv({ cls: "xyjl-viewbar" });
        this.titleEl = bar.createDiv({ cls: "xyjl-viewtitle", text: "岗位透镜" });
        const actions = bar.createDiv({ cls: "xyjl-viewactions" });
        actions.createEl("button", { cls: "xyjl-btn", text: "＋ 新分析" }).addEventListener("click", () => this.plugin.openModal());
        actions.createEl("button", { cls: "xyjl-btn xyjl-btn-ghost", text: "导出待办" }).addEventListener("click", () => this.plugin.exportTodos());
        actions.createEl("button", { cls: "xyjl-btn xyjl-btn-ghost", text: "刷新" }).addEventListener("click", () => this.renderLatest());
        this.bodyEl = this.contentEl.createDiv({ cls: "xyjl-viewbody" });
        await this.renderLatest();
    }
    async onClose() {
        this.contentEl.empty();
    }

    async renderLatest() {
        const settings = this.plugin.settings;
        this.showPath = settings.lastReportPath || (settings.reportPaths || [])[0] || null;
        await this.renderReport(this.showPath);
    }
    async renderReport(path) {
        this.bodyEl.empty();
        if (!path) {
            this.titleEl.setText("岗位透镜");
            this.bodyEl.createDiv({ cls: "xyjl-hint", text: "还没有分析报告。点击右上角「＋ 新分析」，AI 会从你的技能矩阵反推最适合的岗位方向（需要 AI 网关在线）。" });
            return;
        }
        try {
            const md = await this.app.vault.adapter.read(path);
            const name = path.split("/").pop();
            this.titleEl.setText(name);
            /* 历史报告切换条 */
            const paths = this.plugin.settings.reportPaths || [];
            if (paths.length > 1) {
                const hist = this.bodyEl.createDiv({ cls: "xyjl-history" });
                for (const p of paths.slice(0, 8)) {
                    const n = p.split("/").pop();
                    const b = hist.createEl("button", { cls: "xyjl-histbtn" + (p === path ? " is-active" : ""), text: n });
                    b.addEventListener("click", () => this.renderReport(p));
                }
            }
            const mdBox = this.bodyEl.createDiv({ cls: "xyjl-md" });
            try {
                await obsidian_1.MarkdownRenderer.render(this.app, md, mdBox, path, this);
            } catch (e) {
                mdBox.setText(md);
            }
        } catch (e) {
            this.bodyEl.createDiv({ cls: "xyjl-hint", text: "报告读取失败：" + (e && e.message ? e.message : e) });
        }
    }
}

/* ---------------- 输入 Modal ---------------- */
class JobLensModal extends obsidian_1.Modal {
    constructor(app, plugin) {
        super(app);
        this.plugin = plugin;
    }
    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl("h3", { text: "岗位透镜 · 新分析" });
        contentEl.createDiv({ cls: "xyjl-hint", text: "主分析：从你的技能矩阵反推最适合的岗位方向（零输入）。下方字段全部可选——填了定向岗位则改做定向分析，贴 JD 则优先按 JD。" });
        let roleEl, jdEl, preferEl;
        new obsidian_1.Setting(contentEl).setName("候选人偏好（可选）").addTextArea((t) => {
            preferEl = t;
            t.inputEl.rows = 2;
            t.inputEl.style.width = "100%";
            t.setPlaceholder("如：不想上夜班 / 偏好杭州 / 只想投运维方向");
        });
        new obsidian_1.Setting(contentEl).setName("定向岗位（可选）").addText((t) => {
            roleEl = t;
            t.inputEl.style.width = "100%";
            t.setPlaceholder("如：DevOps 工程师（填了则改做定向分析）");
            t.setValue(this.plugin.settings.lastRole || "");
        });
        new obsidian_1.Setting(contentEl).setName("真实 JD（可选）").addTextArea((t) => {
            jdEl = t;
            t.inputEl.rows = 4;
            t.inputEl.style.width = "100%";
            t.setPlaceholder("粘贴 Boss 等平台的 JD 原文，定向分析时优先依据");
        });
        const btns = contentEl.createDiv({ cls: "xyjl-btns" });
        const runBtn = btns.createEl("button", { cls: "xyjl-btn", text: "开始分析（约 30~60 秒）" });
        runBtn.addEventListener("click", async () => {
            const role = roleEl.getValue().trim();
            const jd = jdEl.getValue().trim();
            const prefer = preferEl.getValue().trim();
            runBtn.disabled = true;
            const isTargeted = !!role;
            runBtn.textContent = isTargeted ? "定向分析中…" : "岗位发现中…";
            try {
                if (isTargeted) await this.plugin.runTargeted(role, jd);
                else await this.plugin.runDiscover(prefer);
                new obsidian_1.Notice("分析完成，报告已更新到面板", 5000);
                this.close();
                this.plugin.activateView();
            } catch (e) {
                new obsidian_1.Notice("分析失败：" + (e && e.message ? e.message : e), 10000);
                runBtn.disabled = false;
                runBtn.textContent = "开始分析（约 30~60 秒）";
            }
        });
        btns.createEl("button", { cls: "xyjl-btn xyjl-btn-ghost", text: "取消" }).addEventListener("click", () => this.close());
    }
    onClose() { this.contentEl.empty(); }
}

/* ---------------- 设置页 ---------------- */
class JobLensSettingTab extends obsidian_1.PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }
    display() {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl("h2", { text: "岗位透镜 · 设置" });
        containerEl.createDiv({ cls: "xyjl-hint", text: "报告 MD 保存在插件目录 reports/ 内；导出的学习待办在下方收件箱目录。" });
        new obsidian_1.Setting(containerEl)
            .setName("收件箱目录")
            .setDesc("缺口导出的待办笔记位置（默认 my_blog/00_docs/收件箱）")
            .addText((t) => t.setValue(this.plugin.settings.inbox).onChange(async (v) => {
                this.plugin.settings.inbox = v.trim() || "my_blog/00_docs/收件箱";
                await this.plugin.saveSettings();
            }));
    }
}

module.exports = JobLensPlugin;
