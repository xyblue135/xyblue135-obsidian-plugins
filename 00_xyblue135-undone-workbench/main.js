/*
 * xyblue135 · 待完成工作台
 * 类型：xyblue135 开源插件
 * 说明：筛选白名单目录里 status: 🔴 undone 的笔记，逐篇分析缺失项（AI 元数据 /
 *       内容体量 / 搁置时长），引导你一篇一篇处理：打开继续写、联动「AI 元数据」
 *       插件补全、跳转「知识库导航」。刻意不做一键批量完成——status 始终由你
 *       手动改动，本插件只读不写 status，列表通过 metadataCache 实时跟随。
 */
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const obsidian_1 = require("obsidian");

const VIEW_TYPE = "xyblue135-undone-workbench-view";

const DEFAULT_SETTINGS = {
    folders: "my_blog/00_docs",
    staleDays: 90,
    placeholderTokens: 300,
    sort: "updated",
};

const AI_FIELDS = ["AI_tags", "AI_summary_short", "AI_technical_depth", "AI_title"];

function daysSince(u) {
    u = String(u == null ? "" : u);
    if (u.length < 8) return null;
    const d = new Date(Number(u.slice(0, 4)), Number(u.slice(4, 6)) - 1, Number(u.slice(6, 8)));
    if (isNaN(d.getTime())) return null;
    return Math.max(0, Math.round((Date.now() - d.getTime()) / 86400000));
}
function fmtDate(u) {
    u = String(u == null ? "" : u);
    if (u.length >= 8) return u.slice(0, 4) + "-" + u.slice(4, 6) + "-" + u.slice(6, 8);
    return u || "—";
}
function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
}

/* 扫描白名单目录：统计 done/undone + 生成待完成记录（全部读 metadataCache，零文件 IO） */
function buildScan(app, settings) {
    const folders = String(settings.folders || "")
        .split("\n").map((s) => s.trim().replace(/[\\/]+$/, "")).filter(Boolean);
    const undone = [];
    let doneCount = 0, totalCount = 0;
    for (const f of app.vault.getMarkdownFiles()) {
        const root = folders.find((r) => f.path === r || f.path.startsWith(r + "/"));
        if (!root) continue;
        const cache = app.metadataCache.getFileCache(f);
        const fm = cache && cache.frontmatter ? cache.frontmatter : {};
        const status = String(fm.status || "");
        totalCount++;
        if (status.indexOf("undone") >= 0) {
            const rel = f.path.slice(root.length + 1);
            const tags = Array.isArray(fm["AI_tags"]) ? fm["AI_tags"].filter(Boolean) : [];
            const summary = String(fm["AI_summary_short"] || "").trim();
            const depth = fm["AI_technical_depth"];
            const title = Array.isArray(fm["AI_title"]) ? fm["AI_title"].filter(Boolean)[0] || "" : String(fm["AI_title"] || "");
            const tokens = Number(fm["token_count"]) || 0;
            const days = daysSince(fm["updated"]);
            const missing = [];
            if (!tags.length) missing.push("AI_tags");
            if (!summary) missing.push("AI_summary_short");
            if (depth === undefined || depth === null || depth === "") missing.push("AI_technical_depth");
            if (!title) missing.push("AI_title");
            undone.push({
                path: f.path,
                name: f.basename,
                folder: rel.includes("/") ? rel.split("/")[0] : "（根目录）",
                updated: String(fm["updated"] || ""),
                days: days,
                tokens: tokens,
                missing: missing,
                stale: days != null && days >= (Number(settings.staleDays) || 90),
                placeholder: tokens > 0 && tokens < (Number(settings.placeholderTokens) || 300),
            });
        } else if (status.indexOf("done") >= 0) {
            doneCount++;
        }
    }
    return { undone: undone, doneCount: doneCount, totalCount: totalCount };
}

function sortRecords(records, mode) {
    const r = records.slice();
    if (mode === "tokens") r.sort((a, b) => (a.tokens || Infinity) - (b.tokens || Infinity));
    else if (mode === "path") r.sort((a, b) => a.path.localeCompare(b.path));
    else r.sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
    return r;
}

/* ---------------- 主视图 ---------------- */
class WorkbenchView extends obsidian_1.ItemView {
    constructor(leaf, plugin) {
        super(leaf);
        this.plugin = plugin;
        this.records = [];
        this.selected = null;
        this._evtTimer = null;
    }
    getViewType() { return VIEW_TYPE; }
    getDisplayText() { return "待完成工作台"; }
    getIcon() { return "list-todo"; }

    async onOpen() {
        const el = this.contentEl;
        el.empty();
        el.addClass("xyu-root");

        const bar = el.createDiv({ cls: "xyu-chips" });
        this.chipsEl = bar;

        const bar2 = el.createDiv({ cls: "xyu-toolbar" });
        this.sortEl = bar2.createEl("select", { cls: "xyu-sort", attr: { "aria-label": "排序方式" } });
        [["updated", "按最近更新"], ["tokens", "按内容最少（速赢优先）"], ["path", "按路径"]].forEach(([v, label]) => {
            this.sortEl.createEl("option", { value: v, text: label });
        });
        this.sortEl.value = this.plugin.settings.sort;
        this.sortEl.addEventListener("change", () => {
            this.plugin.settings.sort = this.sortEl.value;
            this.plugin.saveSettings();
            this.renderList();
        });
        this.refreshBtn = bar2.createEl("button", { cls: "xyu-btn xyu-btn-ghost", text: "重新扫描" });
        this.refreshBtn.addEventListener("click", () => this.refresh(true));

        const body = el.createDiv({ cls: "xyu-body" });
        this.listEl = body.createDiv({ cls: "xyu-list" });
        this.listEl.setAttribute("role", "list");
        this.detailEl = body.createDiv({ cls: "xyu-detail" });
        this.detailEl.addEventListener("click", (ev) => {
            const t = ev.target;
            const act = t.closest("[data-act]");
            if (act) this.runAction(act.getAttribute("data-act"));
        });

        /* 笔记保存后（status 手动改掉 / 元数据变化）列表实时跟随 */
        this.registerEvent(this.app.metadataCache.on("changed", () => {
            clearTimeout(this._evtTimer);
            this._evtTimer = setTimeout(() => this.refresh(false), 2000);
        }));

        await this.refresh(true);
    }

    async onClose() {
        clearTimeout(this._evtTimer);
        this.contentEl.empty();
    }

    async refresh(pickFirst) {
        const scan = buildScan(this.app, this.plugin.settings);
        this.records = sortRecords(scan.undone, this.plugin.settings.sort);
        const rate = scan.totalCount ? Math.round((scan.doneCount / scan.totalCount) * 1000) / 10 : 0;
        const staleN = this.records.filter((r) => r.stale).length;
        this.chipsEl.innerHTML =
            '<span class="xyu-chip xyu-chip-hot">待完成 ' + this.records.length + '</span>' +
            '<span class="xyu-chip">完成率 ' + rate + '%</span>' +
            '<span class="xyu-chip">搁置 ' + (Number(this.plugin.settings.staleDays) || 90) + ' 天以上 ' + staleN + '</span>' +
            '<span class="xyu-chip xyu-chip-hint">status 由你手动改动，这里实时跟随</span>';
        if (pickFirst || !this.records.some((r) => r.path === this.selected)) {
            this.selected = this.records.length ? this.records[0].path : null;
        }
        this.renderList();
        this.renderDetail();
    }

    renderList() {
        this.listEl.empty();
        this.refreshBtn.setText("重新扫描");
        if (!this.records.length) {
            this.listEl.innerHTML = '<div class="xyu-empty">🎉 白名单里没有 status: undone 的笔记。</div>';
            return;
        }
        for (const r of this.records) {
            const item = this.listEl.createDiv({ cls: "xyu-item" + (r.path === this.selected ? " is-active" : "") });
            item.setAttribute("role", "listitem");
            item.createDiv({ cls: "xyu-item-title", text: r.name });
            const chips = item.createDiv({ cls: "xyu-item-chips" });
            chips.createSpan({ cls: "xyu-badge", text: r.folder });
            chips.createSpan({ cls: "xyu-badge", text: fmtDate(r.updated) + (r.days == null ? "" : " · " + r.days + "天前") });
            if (r.missing.length) chips.createSpan({ cls: "xyu-badge xyu-badge-warn", text: "缺 " + r.missing.length + " 项元数据" });
            if (r.placeholder) chips.createSpan({ cls: "xyu-badge xyu-badge-warn", text: "疑似占位 " + r.tokens + " tk" });
            if (r.stale) chips.createSpan({ cls: "xyu-badge xyu-badge-stale", text: "搁置" + r.days + "天" });
            item.addEventListener("click", () => {
                this.selected = r.path;
                for (const n of Array.from(this.listEl.children)) n.removeClass("is-active");
                item.addClass("is-active");
                this.renderDetail();
            });
        }
    }

    current() {
        return this.records.find((r) => r.path === this.selected) || null;
    }

    renderDetail() {
        const r = this.current();
        this.detailEl.empty();
        if (!r) {
            this.detailEl.innerHTML = '<span class="xyu-hint">左侧选择一篇待完成笔记。</span>';
            return;
        }
        const head = this.detailEl.createDiv({ cls: "xyu-detail-title", text: r.name });
        head.setAttribute("data-tooltip", r.path);
        this.detailEl.createDiv({ cls: "xyu-detail-path" }).createEl("code", { text: r.path });

        /* 完成清单：这篇还差什么 */
        this.detailEl.createDiv({ cls: "xyu-guide-head", text: "完成清单" });
        const guide = this.detailEl.createDiv({ cls: "xyu-guide" });
        if (r.missing.length) {
            const g = guide.createDiv({ cls: "xyu-guide-row" });
            g.createSpan({ cls: "xyu-gbox", text: "▢" });
            g.createSpan({ text: "AI 元数据缺 " + r.missing.join(" / ") });
        } else {
            const g = guide.createDiv({ cls: "xyu-guide-row" });
            g.createSpan({ cls: "xyu-gbox xyu-gok", text: "☑" });
            g.createSpan({ text: "AI 元数据齐全" });
        }
        if (r.placeholder) {
            const g = guide.createDiv({ cls: "xyu-guide-row" });
            g.createSpan({ cls: "xyu-gbox", text: "▢" });
            g.createSpan({ text: "内容只有 " + r.tokens + " tokens，疑似占位笔记，继续补正文" });
        } else if (r.tokens > 0) {
            const g = guide.createDiv({ cls: "xyu-guide-row" });
            g.createSpan({ cls: "xyu-gbox xyu-gok", text: "☑" });
            g.createSpan({ text: "内容体量 " + r.tokens + " tokens" });
        }
        if (r.stale) {
            const g = guide.createDiv({ cls: "xyu-guide-row" });
            g.createSpan({ cls: "xyu-gbox", text: "▢" });
            g.createSpan({ text: "已搁置 " + r.days + " 天，先确认内容是否还有效" });
        }
        this.detailEl.createDiv({ cls: "xyu-hint" }).setText(
            "处理完一篇后，把笔记里的 status 改成 🟢 done，它就会自动从这份清单里消失。");

        /* 动作区 */
        const acts = this.detailEl.createDiv({ cls: "xyu-actions" });
        acts.createEl("button", { cls: "xyu-btn", text: "① 打开笔记继续写", attr: { "data-act": "open" } });
        if (r.missing.length) {
            acts.createEl("button", { cls: "xyu-btn xyu-btn-ghost", text: "② 打开并生成 AI 元数据", attr: { "data-act": "ai" } });
        }
        acts.createEl("button", { cls: "xyu-btn xyu-btn-ghost", text: "在导航图中查看", attr: { "data-act": "nav" } });
        acts.createEl("button", { cls: "xyu-btn xyu-btn-ghost", text: "下一篇 →", attr: { "data-act": "next" } });
    }

    async runAction(act) {
        const r = this.current();
        if (!r) return;
        if (act === "open" || act === "ai") {
            const f = this.app.vault.getAbstractFileByPath(r.path);
            if (!(f instanceof obsidian_1.TFile)) { new obsidian_1.Notice("文件不存在：" + r.path); return; }
            await this.app.workspace.getLeaf("tab").openFile(f);
            if (act === "ai") {
                setTimeout(() => {
                    try {
                        this.app.commands.executeCommandById("00_xyblue135-metadata-ai:generate-summary-and-tags");
                    } catch (e) {
                        new obsidian_1.Notice("未找到 AI 元数据插件（可能未安装或未启用）");
                    }
                }, 600);
            }
        } else if (act === "nav") {
            try {
                this.app.commands.executeCommandById("00_xyblue135-docs-nav:open");
            } catch (e) {
                new obsidian_1.Notice("未找到知识库导航插件（可能未安装或未启用）");
            }
        } else if (act === "next") {
            const i = this.records.findIndex((x) => x.path === this.selected);
            const next = this.records[(i + 1) % this.records.length];
            if (next) {
                this.selected = next.path;
                this.renderList();
                this.renderDetail();
            }
        }
    }
}

/* ---------------- 设置页 ---------------- */
class WorkbenchSettingTab extends obsidian_1.PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }
    display() {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl("h2", { text: "待完成工作台 · 设置" });
        new obsidian_1.Setting(containerEl)
            .setName("白名单目录")
            .setDesc("每行一个目录，只统计这些目录里的笔记")
            .addTextArea((t) => {
                t.setValue(this.plugin.settings.folders).onChange(async (v) => {
                    this.plugin.settings.folders = v.trim() || "my_blog/00_docs";
                    await this.plugin.saveSettings();
                });
                t.inputEl.rows = 3;
                t.inputEl.style.width = "100%";
            });
        new obsidian_1.Setting(containerEl)
            .setName("搁置阈值（天）")
            .setDesc("超过这么多天没更新的待完成笔记标记为「搁置」（30–365，默认 90）")
            .addSlider((s) => s.setLimits(30, 365, 5).setValue(this.plugin.settings.staleDays).setDynamicTooltip()
                .onChange(async (v) => { this.plugin.settings.staleDays = v; await this.plugin.saveSettings(); }));
        new obsidian_1.Setting(containerEl)
            .setName("占位笔记阈值（tokens）")
            .setDesc("内容低于该 token 数的待完成笔记提示「疑似占位」（100–1000，默认 300）")
            .addSlider((s) => s.setLimits(100, 1000, 50).setValue(this.plugin.settings.placeholderTokens).setDynamicTooltip()
                .onChange(async (v) => { this.plugin.settings.placeholderTokens = v; await this.plugin.saveSettings(); }));
    }
}

/* ---------------- 插件入口 ---------------- */
class UndoneWorkbenchPlugin extends obsidian_1.Plugin {
    async onload() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
        this.registerView(VIEW_TYPE, (leaf) => new WorkbenchView(leaf, this));
        const ribbonEl = this.addRibbonIcon("list-todo", "待完成工作台", () => this.activateView());
        ribbonEl.addClass("xyblue135-ribbon xyblue135-ai");
        this.addCommand({ id: "open", name: "打开待完成工作台", callback: () => this.activateView() });
        this.addSettingTab(new WorkbenchSettingTab(this.app, this));
    }
    onunload() { }
    async saveSettings() {
        await this.saveData(this.settings);
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
}

module.exports = UndoneWorkbenchPlugin;
