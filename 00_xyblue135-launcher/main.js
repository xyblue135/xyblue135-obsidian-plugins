/*
 * xyblue135 · 启动台
 * 类型：xyblue135 开源插件
 * 说明：Raycast 式插件启动台——侧栏高亮图标或快捷键唤起居中浮层：
 *   · 顶部搜索框实时过滤，Enter 直达选中项，方向键移动选择；
 *   · 卡片网格一行 4 个：自研插件点击直达主功能（真实命令），小齿轮进设置；
 *   · 全部已启用插件自动发现（含社区插件），分区展示，搜索时平铺；
 *   · 纯入口面板：不操控侧边栏，不做任何分组/排序/隐藏。
 */
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const obsidian_1 = require("obsidian");

const HUB_LABEL = "打开启动台";
const SELF_ID = "00_xyblue135-launcher";

/* 自研插件注册表：icon=lucide 图标, group=分区, open=主入口命令id, openLabel=主按钮文案 */
const PLUGIN_REGISTRY = [
    { name: "AI 检索", id: "00_xyblue135-ai-search", icon: "search", group: "AI 学习·面试", openLabel: "打开检索", open: "00_xyblue135-ai-search:open-ai-search" },
    { name: "AI 元数据", id: "00_xyblue135-metadata-ai", icon: "tags", group: "AI 学习·面试", openLabel: "待更新面板", open: "00_xyblue135-metadata-ai:open-pending-notes-dashboard" },
    { name: "视频分诊", id: "00_xyblue135-video-triage", icon: "monitor-play", group: "AI 学习·面试", openLabel: "打开面板", open: "00_xyblue135-video-triage:open" },
    { name: "待完成工作台", id: "00_xyblue135-undone-workbench", icon: "list-todo", group: "AI 学习·面试", openLabel: "打开工作台", open: "00_xyblue135-undone-workbench:open" },
    { name: "归档推荐", id: "00_xyblue135-docs-archiver", icon: "archive", group: "AI 学习·面试", openLabel: "归档当前笔记", open: "00_xyblue135-docs-archiver:archive-current-note" },
    { name: "知识库导航图", id: "00_xyblue135-docs-nav", icon: "git-fork", group: "AI 学习·面试", openLabel: "打开导航图", open: "00_xyblue135-docs-nav:open" },
    { name: "技能提炼", id: "00_xyblue135-skill-miner", icon: "briefcase", group: "AI 学习·面试", openLabel: "打开面板", open: "00_xyblue135-skill-miner:open-skill-miner" },
    { name: "岗位透镜", id: "00_xyblue135-job-lens", icon: "compass", group: "AI 学习·面试", openLabel: "打开面板", open: "00_xyblue135-job-lens:open" },
    { name: "面试耳返控制台", id: "00_xyblue135-interview-rag", icon: "graduation-cap", group: "AI 学习·面试", openLabel: "打开控制台", open: "00_xyblue135-interview-rag:interview-test-search" },
    { name: "元数据补全", id: "00_xyblue135-docs-template", icon: "clipboard-check", group: "工具", openLabel: "批量审查", open: "00_xyblue135-docs-template:audit-whitelist-notes" },
    { name: "Token 统计", id: "00_xyblue135-char-count-updater", icon: "hash", group: "工具", openLabel: null, open: null },
    { name: "附件镜像", id: "00_xyblue135-mirror", icon: "images", group: "工具", openLabel: "检查重名", open: "00_xyblue135-mirror:check-duplicate-notes" },
    { name: "文件 Logo", id: "00_xyblue135-docs-logo", icon: "sticker", group: "工具", openLabel: "重载白名单", open: "00_xyblue135-docs-logo:reload-whitelist-and-icons" },
    { name: "文件夹隐藏", id: "00_xyblue135-files-hider", icon: "eye-off", group: "工具", openLabel: null, open: null },
    { name: "图片缩放", id: "00_xyblue135-image-zoom", icon: "zoom-in", group: "工具", openLabel: null, open: null },
    { name: "主题", id: "00_xyblue135-theme", icon: "palette", group: "工具", openLabel: null, open: null },
];

/* ---------------- 启动台浮层 ---------------- */
class LauncherModal extends obsidian_1.Modal {
    constructor(app, plugin) {
        super(app);
        this.plugin = plugin;
        this.selected = 0;
        this.visible = [];
    }
    onOpen() {
        const { contentEl, modalEl } = this;
        modalEl.addClass("xylaunch-modal");
        contentEl.empty();
        contentEl.addClass("xylaunch-content");

        this.searchEl = contentEl.createEl("input", {
            cls: "xylaunch-search",
            type: "search",
            attr: { placeholder: "搜索插件…（Enter 打开选中项，方向键选择）", "aria-label": "搜索插件" },
        });
        this.resultEl = contentEl.createDiv({ cls: "xylaunch-results" });

        this.items = this.collectItems();
        this.renderSections(this.items);

        this.searchEl.addEventListener("input", () => {
            this.selected = 0;
            const q = this.searchEl.value.trim().toLowerCase();
            if (!q) {
                this.renderSections(this.items);
            } else {
                const hits = this.items.filter((x) => x.search.indexOf(q) >= 0);
                this.renderFlat(hits, "搜索结果（" + hits.length + "）");
            }
        });
        this.searchEl.addEventListener("keydown", (ev) => {
            if (ev.key === "ArrowDown" || ev.key === "ArrowRight") {
                ev.preventDefault();
                this.moveSelection(1);
            } else if (ev.key === "ArrowUp" || ev.key === "ArrowLeft") {
                ev.preventDefault();
                this.moveSelection(-1);
            } else if (ev.key === "Enter") {
                ev.preventDefault();
                const item = this.visible[this.selected] || this.visible[0];
                if (item) this.launch(item);
            }
        });
        this.searchEl.focus();
    }
    onClose() {
        this.contentEl.empty();
    }

    collectItems() {
        const regById = {};
        for (const item of PLUGIN_REGISTRY) regById[item.id] = item;
        const manifests = (this.app.plugins && this.app.plugins.manifests) || {};
        const enabled = (this.app.plugins && this.app.plugins.enabledPlugins) || new Set();
        /* enabledPlugins 是 Set：Object.keys 会拿到空数组，必须用 has() 判断 */
        const isEnabled = (id) => (typeof enabled.has === "function") ? enabled.has(id) : !!enabled[id];
        const items = [];
        for (const id of Object.keys(manifests)) {
            if (id === SELF_ID) continue;
            if (!isEnabled(id)) continue;
            const mf = manifests[id];
            if (!mf) continue;
            const reg = regById[id];
            items.push({
                id: id,
                name: cleanName(mf.name),
                version: mf.version || "",
                icon: reg ? reg.icon : "puzzle",
                open: reg ? reg.open : null,
                openLabel: reg ? reg.openLabel : "设置",
                group: reg ? reg.group : "其他插件",
                search: (mf.name + " " + id + " " + (reg ? reg.group : "其他")).toLowerCase(),
            });
        }
        if (!items.length) {
            /* 永远不再出现"神秘空白"：数据异常时给出明确提示 */
            items.push({ id: "__empty__", name: "未发现已启用的插件", version: "", icon: "info", open: null, openLabel: null, group: "其他插件", search: "" });
        }
        return items;
    }

    cleanName(name) {
        /* 去掉 "xyblue135 ·" / "xyblue135 私人 ·" 前缀，卡片名更干净 */
        return String(name || "").replace(/^xyblue135( 私人)?\s*·\s*/, "");
    }

    cardEl(item) {
        const card = createDiv({ cls: "xylaunch-card" });
        card.addEventListener("click", () => this.launch(item));
        const iconBox = card.createDiv({ cls: "xylaunch-card-icon" });
        obsidian_1.setIcon(iconBox, item.icon);
        card.createDiv({ cls: "xylaunch-card-name", text: item.name, attr: { title: item.name } });
        const gear = card.createDiv({ cls: "xylaunch-card-gear", attr: { "aria-label": item.name + " 设置", title: "设置" } });
        obsidian_1.setIcon(gear, "settings");
        gear.addEventListener("click", (ev) => {
            ev.stopPropagation();
            this.plugin.openPluginSettings(item.id);
            this.close();
        });
        card.__item = item;
        return card;
    }

    renderSections(items) {
        this.resultEl.empty();
        this.visible = [];
        const sections = [
            { name: "AI 学习·面试", items: items.filter((x) => x.group === "AI 学习·面试") },
            { name: "工具", items: items.filter((x) => x.group === "工具") },
            { name: "其他插件", items: items.filter((x) => x.group === "其他插件") },
        ];
        for (const sec of sections) {
            if (!sec.items.length) continue;
            this.resultEl.createDiv({ cls: "xylaunch-section", text: sec.name });
            const grid = this.resultEl.createDiv({ cls: "xylaunch-grid" });
            for (const item of sec.items) {
                const card = this.cardEl(item);
                grid.appendChild(card);
                this.visible.push(card);
            }
        }
        this.updateSelection();
    }

    renderFlat(items, title) {
        this.resultEl.empty();
        this.visible = [];
        this.resultEl.createDiv({ cls: "xylaunch-section", text: title });
        const grid = this.resultEl.createDiv({ cls: "xylaunch-grid" });
        for (const item of items) {
            const card = this.cardEl(item);
            grid.appendChild(card);
            this.visible.push(card);
        }
        this.updateSelection();
    }

    updateSelection() {
        this.visible.forEach((card, i) => card.toggleClass("is-selected", i === this.selected));
    }
    moveSelection(delta) {
        if (!this.visible.length) return;
        this.selected = (this.selected + delta + this.visible.length) % this.visible.length;
        this.updateSelection();
        const card = this.visible[this.selected];
        if (card && card.scrollIntoView) card.scrollIntoView({ block: "nearest" });
    }
    launch(item) {
        this.close();
        this.plugin.openPlugin(item);
    }
}

/* ---------------- 主插件 ---------------- */
class LauncherPlugin extends obsidian_1.Plugin {
    async onload() {
        const ribbonEl = this.addRibbonIcon("rocket", HUB_LABEL, () => this.openLauncher());
        ribbonEl.addClass("xyblue135-ribbon xyblue135-hub");
        this.addCommand({ id: "open", name: "打开启动台", callback: () => this.openLauncher() });
    }
    onunload() { }
    openLauncher() {
        new LauncherModal(this.app, this).open();
    }
    openPluginSettings(id) {
        this.app.setting.open();
        setTimeout(() => {
            try { this.app.setting.openTabById(id); } catch (e) { /* 忽略 */ }
        }, 150);
    }
    openPlugin(item) {
        if (item.open) {
            try {
                this.app.commands.executeCommandById(item.open);
                return;
            } catch (e) { /* 命令不存在则回退设置 */ }
        }
        this.openPluginSettings(item.id);
    }
}

module.exports = LauncherPlugin;
