/*
 * xyblue135 私人 · 元数据补全（原名「文件夹模板笔记」）
 * 类型：xyblue135 私人插件（非公共发布版）
 * 说明：用户可见文案与维护注释已中文化；内部插件 ID 与 data.json 保持不变，以兼容原有设置和数据。
 */
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const obsidian_1 = require("obsidian");

/** 插件自带的默认笔记模板。用户可以在设置页中直接修改。 */
const DEFAULT_TEMPLATE = "---\nstatus: 🟢 done\nvisibility: 🟢 open\nupdated: {{timestamp}}\ntoken_count: 0\nAI_last_verified: \nAI_title: []\nAI_tags: []\nAI_freshness: \nAI_technical_depth: \nAI_freshness_note: \nAI_summary_short: \nAI_summary_long: \nAI_take: \nAI_qa: \n---\n\n";
/** 插件默认设置。首次安装或缺少字段时会使用这些值。 */
const DEFAULT_SETTINGS = {
    // 1.5.0 起「新建模板笔记」入口已移除，menuEmoji / targetFolder 仅作兼容保留：
    // 旧 data.json 里可能仍有这两个键，helper 也还在文件里（虽已无调用方）。
    menuEmoji: "📝",
    noteTemplate: DEFAULT_TEMPLATE,
    targetFolder: "/待分类",
    // ── 审查模式（创建后自动补全）──
    // 只审查这些目录下的 .md（含子目录）。多个目录用逗号分隔；留空表示整个仓库。
    auditFolders: "my_blog/00_docs",
    // 是否在 .md 被创建后自动审查并补全缺失字段。
    auditOnCreate: true,
    // 创建后等待多久再审查（毫秒），给 Obsidian 一点时间完成写入与索引。
    auditDelayMs: 1500,
};
/**
 * xyblue135 私人 · 元数据补全 主插件（原名「文件夹模板笔记」）。
 *
 * 功能（1.5.0 起）：
 * 1. 不再提供新建笔记入口，统一使用 Obsidian 原生的新建方式。
 * 2. 监听 vault 的 create / rename 事件。
 * 3. 仅对白名单目录（默认 00_docs）内的 .md 自动补全缺失的 frontmatter 字段。
 * 4. 字段来自设置页的模板；已有字段的值与顺序一律不动，只追加缺失项。
 * 5. 不依赖 Templater。
 */
class FolderTemplateNotePlugin extends obsidian_1.Plugin {
    constructor() {
        super(...arguments);
        this.settings = { ...DEFAULT_SETTINGS };
    }
    /** 插件加载时执行。 */
    async onload() {
        await this.loadSettings();
        // 注册插件设置页：元数据模板 + 审查白名单。
        // （1.5.0 起不再有「菜单 Emoji」和「快捷入口目标文件夹」两项。）
        this.addSettingTab(new FolderTemplateNoteSettingTab(this.app, this));
        this.addRibbonIcon("clipboard-check", "元数据补全 · 设置", () => { this.app.setting.open(); this.app.setting.openTabById("00_xyblue135-docs-template"); }).addClass("xyblue135-ribbon xyblue135-tool");
        // 1.5.0：移除「新建模板笔记」的两个入口（左侧 ribbon 图标 + 文件夹右键菜单项）。
        // 新建笔记完全走 Obsidian 原生方式，由下面的 create / rename 事件负责补 frontmatter。
        // 旧的 NoteNameModal / createTemplateNote / resolveTargetFolder 保留在文件内但已无调用方。
        // ─────────────────────────────────────────────────────────────
        // 审查模式：用 Obsidian 自带方式新建笔记，
        // 创建后由本插件检查 frontmatter，只追加缺失的模板字段。
        // ─────────────────────────────────────────────────────────────
        this.pendingAudits = new Map();
        this.registerEvent(this.app.vault.on("create", (file) => {
            if (this.settings.auditOnCreate !== true) {
                return;
            }
            if (!(file instanceof obsidian_1.TFile)) {
                return;
            }
            if (String(file.extension || "").toLowerCase() !== "md") {
                return;
            }
            if (!this.isInAuditScope(file)) {
                return;
            }
            this.scheduleAudit(file);
        }));
        // Obsidian 新建笔记后常紧接一次重命名（未命名.md → 真实标题）。
        // 定时器以文件对象为键，重命名后仍指向同一篇笔记，这里只是提前重新排队。
        this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
            if (!(file instanceof obsidian_1.TFile)) {
                return;
            }
            if (String(file.extension || "").toLowerCase() !== "md") {
                return;
            }
            if (this.pendingAudits && this.pendingAudits.has(file)) {
                this.scheduleAudit(file);
                return;
            }
            // 已经存在于白名单之外的笔记被移进来时，也顺手补一次。
            if (this.settings.auditOnCreate === true && this.isInAuditScope(file)) {
                if (!oldPath || !this.isInAuditScope({ path: oldPath })) {
                    this.scheduleAudit(file);
                }
            }
        }));
        // 手动补全当前笔记（便于给快捷键绑定）。
        this.addCommand({
            id: "audit-current-note",
            name: "审查并补全当前笔记的模板字段",
            checkCallback: (checking) => {
                const file = this.app.workspace.getActiveFile();
                const eligible = !!(file && String(file.extension || "").toLowerCase() === "md" && this.isInAuditScope(file));
                if (!eligible) {
                    return false;
                }
                if (!checking) {
                    void this.auditAndFill(file, { notify: true });
                }
                return true;
            },
        });
        // 批量补全白名单内全部笔记（修复历史遗留的无元数据笔记）。
        this.addCommand({
            id: "audit-whitelist-notes",
            name: "审查并补全白名单内全部笔记",
            callback: () => {
                void this.runBulkAudit();
            },
        });
    }
    /** 插件卸载时清理尚未执行的审查定时器，并把待写入的设置落盘。 */
    onunload() {
        if (this.pendingAudits) {
            for (const entry of this.pendingAudits.values()) {
                window.clearTimeout(entry.timer);
            }
            this.pendingAudits.clear();
        }
        // 设置页的文本框是防抖保存的，卸载 / 重载前必须补一次落盘。
        void this.flushSave();
    }
    /**
     * 从 data.json 中读取插件设置。
     *
     * 旧版本只有 menuEmoji，没有 noteTemplate。
     * Object.assign 会自动给旧配置补上默认模板，因此升级不会丢失原设置。
     */
    async loadSettings() {
        const saved = (await this.loadData());
        const hasValidMenuEmoji = typeof saved?.menuEmoji === "string";
        const hasValidNoteTemplate = typeof saved?.noteTemplate === "string";
        const hasValidTargetFolder = typeof saved?.targetFolder === "string";
        this.settings = Object.assign({}, DEFAULT_SETTINGS, saved ?? {});
        // 防止用户手动修改 data.json 后出现非字符串值。
        if (!hasValidMenuEmoji) {
            this.settings.menuEmoji = DEFAULT_SETTINGS.menuEmoji;
        }
        if (!hasValidNoteTemplate) {
            this.settings.noteTemplate = DEFAULT_TEMPLATE;
        }
        if (!hasValidTargetFolder) {
            this.settings.targetFolder = DEFAULT_SETTINGS.targetFolder;
        }
        // 审查模式的新字段：类型不对或缺失时回退到默认值。
        const hasValidAuditFolders = typeof saved?.auditFolders === "string";
        const hasValidAuditDelay = Number.isFinite(Number(saved?.auditDelayMs)) && Number(saved?.auditDelayMs) > 0;
        if (!hasValidAuditFolders) {
            this.settings.auditFolders = DEFAULT_SETTINGS.auditFolders;
        }
        this.settings.auditOnCreate = saved?.auditOnCreate !== false;
        if (!hasValidAuditDelay) {
            this.settings.auditDelayMs = DEFAULT_SETTINGS.auditDelayMs;
        }
        // 首次安装或从旧版本升级时，把缺少的默认字段真正写入 data.json。
        // 这样设置页显示的内容与插件实际保存的数据始终保持一致。
        if (!hasValidMenuEmoji || !hasValidNoteTemplate || !hasValidTargetFolder || !hasValidAuditFolders || !hasValidAuditDelay) {
            await this.saveSettings();
        }
    }
    /**
     * 保存插件设置到 data.json。
     * 串成 promise 链串行执行，避免设置页快速点击时多次 saveData 交叉覆盖。
     */
    async saveSettings() {
        this.saveChain = (this.saveChain || Promise.resolve())
            .catch(() => { })
            .then(() => this.saveData(this.settings))
            .catch((error) => {
            console.error("[xyblue135 私人·文件夹模板笔记] 保存设置失败：", error);
            new obsidian_1.Notice("保存设置失败，请查看开发者控制台日志");
        });
        return this.saveChain;
    }
    /** 防抖保存：文本框每敲一个字符都写一次 data.json 太浪费，这里合并成一次。 */
    queueSave(delay = 600) {
        if (this.saveTimer) {
            window.clearTimeout(this.saveTimer);
        }
        this.saveTimer = window.setTimeout(() => {
            this.saveTimer = null;
            void this.saveSettings();
        }, delay);
    }
    /** 立刻把待保存的设置落盘（关闭设置页 / 卸载插件时调用）。 */
    async flushSave() {
        if (this.saveTimer) {
            window.clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
        await this.saveSettings();
    }
    /** 把元数据模板恢复成插件自带的默认预设。 */
    async resetTemplate() {
        this.settings.noteTemplate = DEFAULT_TEMPLATE;
        await this.flushSave();
    }
    /**
     * 读取要在图标上显示的 Emoji。
     * 来自设置中的 menuEmoji；若留空则回退到默认 📝，保证图标永远有内容。
     */
    getMenuEmoji() {
        const emoji = this.settings.menuEmoji.trim();
        return emoji || "📝";
    }
    /**
     * 根据设置生成菜单 / 弹窗标题。
     * Emoji 现在作为图标显示，所以标题这里只保留文字“新建模板笔记”，避免重复。
     */
    getMenuTitle() {
        return "新建模板笔记";
    }
    /**
     * 生成左侧 ribbon 图标的悬停提示。
     * 提示里带上当前的目标文件夹路径，让用户一眼看清笔记会创建到哪里。
     */
    getRibbonTooltip() {
        const target = this.getDisplayTargetPath();
        return `新建模板笔记（快捷入口 → ${target}）`;
    }
    /**
     * 把设置中的目标文件夹路径整理成展示用的字符串。
     * 空 / “/” / “.” 都视为仓库根目录，展示为 “/”。
     */
    getDisplayTargetPath() {
        const raw = (this.settings.targetFolder || "").trim();
        if (!raw || raw === "/" || raw === ".") {
            return "/";
        }
        const normalized = (0, obsidian_1.normalizePath)(raw);
        return normalized.startsWith("/") ? normalized : `/${normalized}`;
    }
    /**
     * 解析“状态栏快捷入口”要使用的目标文件夹。
     *
     * - 文件夹已存在：直接返回。
     * - 目标路径是个文件（不是文件夹）：报错并返回 null。
     * - 文件夹不存在：自动创建（支持多级路径），再返回。
     * - 路径为空 / “/” / “.”：返回仓库根目录。
     */
    async resolveTargetFolder() {
        const raw = (this.settings.targetFolder || "").trim();
        if (!raw || raw === "/" || raw === ".") {
            return this.app.vault.getRoot();
        }
        const normalized = (0, obsidian_1.normalizePath)(raw);
        const existing = this.app.vault.getAbstractFileByPath(normalized);
        if (existing instanceof obsidian_1.TFolder) {
            return existing;
        }
        if (existing) {
            new obsidian_1.Notice(`目标路径不是文件夹，无法创建笔记：${normalized}`);
            return null;
        }
        try {
            await this.app.vault.createFolder(normalized);
        }
        catch (error) {
            console.error("[xyblue135 私人·文件夹模板笔记] 创建目标文件夹失败：", error);
            new obsidian_1.Notice(`创建目标文件夹失败：${normalized}`);
            return null;
        }
        const created = this.app.vault.getAbstractFileByPath(normalized);
        if (!(created instanceof obsidian_1.TFolder)) {
            new obsidian_1.Notice(`目标文件夹解析失败：${normalized}`);
            return null;
        }
        return created;
    }
    /** 在指定文件夹中创建一篇带模板内容的新笔记。 */
    async createTemplateNote(folder, rawName) {
        const filename = this.normalizeNoteName(rawName);
        if (!filename) {
            new obsidian_1.Notice("请输入有效的笔记名称");
            return;
        }
        // 创建文件前先检查文件名是否合法，避免 Windows 下出现创建失败。
        const validationError = this.validateNoteName(filename);
        if (validationError) {
            new obsidian_1.Notice(validationError);
            return;
        }
        // 拼接目标 Markdown 文件路径。
        const path = (0, obsidian_1.normalizePath)(folder.path ? `${folder.path}/${filename}.md` : `${filename}.md`);
        // 已存在同名文件时不覆盖原文件。
        if (this.app.vault.getAbstractFileByPath(path)) {
            new obsidian_1.Notice(`文件已经存在：${path}`);
            return;
        }
        // 根据当前文件夹、文件名和时间渲染用户在设置中保存的模板。
        const content = this.renderTemplate(folder, filename);
        try {
            const file = await this.app.vault.create(path, content);
            // 创建成功后立即打开新笔记。
            await this.app.workspace.getLeaf(false).openFile(file);
            new obsidian_1.Notice(`已创建：${file.path}`);
        }
        catch (error) {
            console.error("[xyblue135 私人·文件夹模板笔记] 创建模板笔记失败：", error);
            new obsidian_1.Notice("创建模板笔记失败，请查看开发者控制台日志");
        }
    }
    /**
     * 清理用户输入的笔记名。
     * 如果用户手动输入了 .md，则自动去掉扩展名，避免生成 xxx.md.md。
     */
    normalizeNoteName(rawName) {
        let name = rawName.trim();
        if (name.toLowerCase().endsWith(".md")) {
            name = name.slice(0, -3).trim();
        }
        return name;
    }
    /** 检查笔记文件名是否包含 Windows 不允许使用的字符或保留名称。 */
    validateNoteName(name) {
        if (!name || name === "." || name === "..") {
            return "请输入有效的笔记名称";
        }
        if (/[\\/:*?"<>|]/.test(name)) {
            return '文件名不能包含 \\ / : * ? " < > |';
        }
        if (/[. ]$/.test(name)) {
            return "文件名不能以句点或空格结尾";
        }
        const windowsReserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
        if (windowsReserved.test(name)) {
            return "该文件名是 Windows 保留名称，请换一个名称";
        }
        return null;
    }
    /**
     * 渲染设置页中保存的模板。
     *
     * 当前支持：
     * {{folder}}    当前文件夹名称
     * {{filename}}  新笔记文件名（不含 .md）
     * {{path}}      当前文件夹路径
     * {{datetime}}  当前日期时间，格式 YYYY-MM-DDTHH
     * {{date}}      当前日期，格式 YYYY-MM-DD
     * {{time}}      当前时间，格式 HH:mm
     * {{timestamp}} 17 位时间戳，格式 yyyyMMddHHmmssSSS（如 20240118021618010）
     *
     * 未识别的 {{变量}} 会原样保留，方便以后扩展。
     */
    renderTemplate(folder, filename) {
        // 如果是在仓库根目录创建，则使用 Vault 名称作为 folder。
        const folderName = folder.path ? folder.name : this.app.vault.getName();
        const now = (0, obsidian_1.moment)();
        const variables = {
            folder: folderName,
            filename,
            path: folder.path,
            datetime: now.format("YYYY-MM-DDTHH"),
            date: now.format("YYYY-MM-DD"),
            time: now.format("HH:mm"),
            timestamp: now.format("YYYYMMDDHHmmssSSS"),
        };
        return this.settings.noteTemplate.replace(/\{\{(folder|filename|path|datetime|date|time|timestamp)\}\}/g, (_match, key) => this.toYamlString(variables[key] ?? ""));
    }
    /**
     * 把普通字符串转换成安全的 YAML 字符串。
     * 例如文件夹名称中包含冒号、# 等特殊字符时，也不容易破坏 Frontmatter。
     *
     * 因此模板里写 summary: {{folder}} 即可，不需要自己再给变量套引号。
     */
    toYamlString(value) {
        return JSON.stringify(value);
    }
    // ─────────────────────────────────────────────────────────────────
    // 审查 / 补全逻辑
    // ─────────────────────────────────────────────────────────────────
    /**
     * 解析设置里的审查白名单目录（支持逗号或换行分隔，自动去掉首尾斜杠与 ./）。
     * 统一转成小写，保证 Windows 上大小写不一致时仍能命中（Vault 路径实际不区分大小写）。
     */
    getAuditRoots() {
        return String(this.settings.auditFolders || "")
            .split(/[,，\n]/)
            .map((item) => item.trim())
            .filter(Boolean)
            .map((item) => (0, obsidian_1.normalizePath)(item).replace(/^\.\//, "").replace(/^\/+|\/+$/g, "").toLowerCase())
            .filter(Boolean);
    }
    /** 判断某个笔记是否在审查白名单内；白名单留空表示整个仓库。 */
    isInAuditScope(file) {
        const roots = this.getAuditRoots();
        if (!roots.length) {
            return true;
        }
        const path = (0, obsidian_1.normalizePath)(String(file && file.path ? file.path : ""))
            .replace(/^\/+/, "")
            .toLowerCase();
        return roots.some((root) => path === root || path.startsWith(`${root}/`));
    }
    /** 找到正在显示指定笔记的 Markdown 视图（没打开时返回 null）。 */
    getOpenMarkdownView(file) {
        const leaves = this.app.workspace.getLeavesOfType("markdown");
        for (const leaf of leaves) {
            const view = leaf && leaf.view;
            if (view && view.file && view.file.path === file.path && view.editor) {
                return view;
            }
        }
        return null;
    }
    /**
     * 笔记创建后延迟审查，避免与 Obsidian 的写入 / 索引过程抢跑。
     * 定时器以「文件对象」为键而不是路径：新建笔记常在几百毫秒内被重命名，
     * 用路径做键会在重命名后重新建一个定时器，导致旧定时器白跑一趟。
     */
    scheduleAudit(file, attempt = 0) {
        const previous = this.pendingAudits.get(file);
        if (previous) {
            window.clearTimeout(previous.timer);
        }
        const delay = Math.max(300, Number(this.settings.auditDelayMs) || 1500);
        const timer = window.setTimeout(() => {
            this.pendingAudits.delete(file);
            void this.runScheduledAudit(file, attempt);
        }, delay);
        this.pendingAudits.set(file, { timer, attempt });
    }
    /** 定时器到点后的实际动作：对象仍在才继续；正在输入时最多顺延 8 轮。 */
    async runScheduledAudit(file, attempt) {
        const latest = this.app.vault.getAbstractFileByPath(file.path);
        if (!(latest instanceof obsidian_1.TFile)) {
            // 不再静默返回：批量新建后立刻删除 / 改名时能看出这一步是被跳过的，而不是「补全没生效」。
            console.warn("[xyblue135 私人·文件夹模板笔记] 定时审查找不到文件，已跳过：", file.path);
            return;
        }
        // 用户正在这篇笔记里打字、且 frontmatter 还没写全时先让一轮，
        // 避免把编辑器缓冲区里的新内容覆盖掉。
        // 但「刚新建、编辑器里还是空的」不算打字：那正是最该补字段的时刻，
        // 否则会一轮轮顺延，用户必须切到别的笔记再切回来才补得上。
        if (attempt < 8 && this.getOpenMarkdownView(latest) && !this.isTemplateComplete(latest) && !this.isEditorEffectivelyEmpty(latest)) {
            this.scheduleAudit(latest, attempt + 1);
            return;
        }
        await this.auditAndFill(latest, { notify: true, silentWhenClean: true });
    }
    /** 编辑器里的内容是否已经写全模板字段（用于决定还要不要让一轮）。 */
    isTemplateComplete(file) {
        const fields = this.buildTemplateFields(file);
        if (!fields.length) {
            return true;
        }
        const view = this.getOpenMarkdownView(file);
        if (!view) {
            return false;
        }
        const split = this.splitFrontmatter(view.editor.getValue());
        const keys = new Set(split ? split.keys : []);
        return fields.every((field) => keys.has(field.key));
    }
    /**
     * 编辑器里的这篇笔记是否还是「空壳」（内容全是空白）。
     *
     * Obsidian 原生新建笔记会立刻在编辑器里打开它，此时缓冲区是空的。
     * 而 runScheduledAudit 里「正在输入就顺延」的保护会误伤这种情形，
     * 导致必须切走到别的笔记再切回来（视图已关闭）才补得上 frontmatter。
     * 这里把「空缓冲区」单独排除，让新建的空笔记在第一次定时器到点时就补全。
     */
    isEditorEffectivelyEmpty(file) {
        const view = this.getOpenMarkdownView(file);
        if (!view) {
            return true;
        }
        return String(view.editor.getValue() ?? "").trim() === "";
    }
    /**
     * 审查单篇笔记并补全缺失的模板字段。
     *
     * 原则：
     * 1. 只追加模板里存在、而笔记里缺失的字段，绝不改写已有字段的值与顺序。
     * 2. 已有值即使是空字符串也不动（视为用户有意留空）。
     * 3. 完全没有 frontmatter 的笔记，则把整块模板 frontmatter 补在正文最前面。
     * 4. 笔记正在编辑器里打开时，改编辑器缓冲区（而不是磁盘），
     *    否则会和 Obsidian 尚未落盘的输入互相覆盖。
     */
    async auditAndFill(file, options = {}) {
        const notify = options.notify === true;
        const silentWhenClean = options.silentWhenClean === true;
        const fields = this.buildTemplateFields(file);
        if (!fields.length) {
            if (notify) {
                new obsidian_1.Notice("模板里没有可用的 frontmatter 字段，请先在设置中完善模板");
            }
            return { added: 0, createdBlock: false };
        }
        let added = 0;
        let createdBlock = false;
        let unclosed = false;
        try {
            const view = this.getOpenMarkdownView(file);
            if (view) {
                const buffer = view.editor.getValue();
                const result = this.mergeTemplateFields(buffer, fields);
                if (result.unclosed) {
                    unclosed = true;
                }
                else if (result.insert) {
                    added = result.added;
                    createdBlock = result.createdBlock;
                    const pos = this.offsetToEditorPos(buffer, result.insert.offset);
                    view.editor.replaceRange(result.insert.text, pos);
                }
            }
            else {
                await this.app.vault.process(file, (data) => {
                    const result = this.mergeTemplateFields(data, fields);
                    if (result.unclosed) {
                        unclosed = true;
                        return data;
                    }
                    if (!result.insert) {
                        return data;
                    }
                    added = result.added;
                    createdBlock = result.createdBlock;
                    return `${data.slice(0, result.insert.offset)}${result.insert.text}${data.slice(result.insert.offset)}`;
                });
            }
        }
        catch (error) {
            console.error("[xyblue135 私人·文件夹模板笔记] 审查 / 补全失败：", file.path, error);
            if (notify) {
                new obsidian_1.Notice(`补全失败：${file.path}`);
            }
            return { added: 0, createdBlock: false, error };
        }
        if (unclosed && notify) {
            new obsidian_1.Notice(`frontmatter 没有闭合，已跳过：${file.basename}`);
        }
        if (notify && !unclosed) {
            if (added > 0) {
                new obsidian_1.Notice(createdBlock
                    ? `已补全元数据块：${file.basename}`
                    : `已补全 ${added} 个元数据字段：${file.basename}`);
            }
            else if (!silentWhenClean) {
                new obsidian_1.Notice("该笔记的模板字段已完整，无需补全");
            }
        }
        return { added, createdBlock, unclosed };
    }
    /**
     * 纯函数：把模板字段合并进一段文本。
     *
     * 只计算出「插入位置」和「要插入的文本」，其余内容（BOM、行尾、正文）保持原样，
     * 这样同一套逻辑既能作用于磁盘内容（vault.process），也能作用于编辑器缓冲区。
     *
     * @returns {{added:number, createdBlock:boolean, insert:{offset:number,text:string}|null, unclosed:boolean}}
     */
    mergeTemplateFields(text, fields) {
        const source = String(text ?? "");
        const eol = /\r\n/.test(source) ? "\r\n" : "\n";
        const split = this.splitFrontmatter(source);
        if (!split) {
            // 只有开头的 --- 却没有闭合 ---：用户正写到一半，不能硬塞整块模板。
            if (/^\uFEFF?---[ \t]*(?:\r?\n|$)/.test(source)) {
                return { added: 0, createdBlock: false, insert: null, unclosed: true };
            }
            return {
                added: fields.length,
                createdBlock: true,
                insert: { offset: 0, text: this.buildFrontmatterBlock(fields, eol) },
                unclosed: false,
            };
        }
        const existing = new Set(split.keys);
        const missing = fields.filter((field) => !existing.has(field.key));
        if (!missing.length) {
            return { added: 0, createdBlock: false, insert: null, unclosed: false };
        }
        const lines = missing.map((field) => this.formatFieldLine(field).replace(/\n/g, eol));
        const joined = lines.join(eol);
        // body 为空（空 frontmatter 块 --- 紧跟 ---）时，插入点就在开头的 --- 之后，
        // 此时换行要补在字段后面，否则会拼出 `AI_qa:---`。
        const bodyEmpty = split.body.trim().length === 0;
        return {
            added: missing.length,
            createdBlock: false,
            insert: {
                offset: bodyEmpty ? split.prefix.length : split.prefix.length + split.body.length,
                text: bodyEmpty ? `${joined}${eol}` : `${eol}${joined}`,
            },
            unclosed: false,
        };
    }
    /** 把字符偏移量换算成编辑器坐标（CodeMirror 用行 / 列定位）。 */
    offsetToEditorPos(text, offset) {
        const safe = Math.max(0, Math.min(offset, text.length));
        const before = text.slice(0, safe);
        const lastBreak = before.lastIndexOf("\n");
        return { line: (before.match(/\n/g) || []).length, ch: safe - lastBreak - 1 };
    }
    /**
     * 单行字段：有值写 `key: value`，空的写 `key:`。
     *
     * 值的第一行本身带缩进（多行列表 `- a`、嵌套 map `a: 1`）时不能和 key 写在同一行，
     * 否则会拼出 `tags:   - a` 这种 YAML 解析不了的写法，必须让它在下一行开始。
     */
    formatFieldLine(field) {
        if (!field.text) {
            return `${field.key}:`;
        }
        if (/^[ \t]/.test(field.text)) {
            return `${field.key}:\n${field.text}`;
        }
        return `${field.key}: ${field.text}`;
    }
    /** 批量审查白名单内的全部笔记（先弹确认框）。 */
    async runBulkAudit() {
        const roots = this.getAuditRoots();
        const files = this.app.vault.getMarkdownFiles().filter((file) => this.isInAuditScope(file));
        if (!files.length) {
            new obsidian_1.Notice("白名单目录内没有 Markdown 笔记");
            return;
        }
        const scopeText = roots.length ? roots.join("、") : "整个仓库";
        new AuditConfirmModal(this.app, `将审查 ${files.length} 篇笔记（${scopeText}）。只会追加缺失的 frontmatter 字段，不改动已有字段的值、顺序与正文。建议先在 Git 中提交当前改动，便于回滚。`, async () => {
            let changed = 0;
            let fieldsAdded = 0;
            let blocksCreated = 0;
            const startedAt = Date.now();
            for (const file of files) {
                const result = await this.auditAndFill(file, { notify: false });
                if (result.added > 0) {
                    changed += 1;
                    fieldsAdded += result.added;
                    if (result.createdBlock) {
                        blocksCreated += 1;
                    }
                }
            }
            const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
            new obsidian_1.Notice(`审查完成：共 ${files.length} 篇，补全 ${changed} 篇（新增 ${fieldsAdded} 个字段，新建元数据块 ${blocksCreated} 篇），耗时 ${seconds}s`, 8000);
        }).open();
    }
    /**
     * 把设置里的模板解析成 [{key, text}] 形式的字段列表（变量已渲染）。
     *
     * 解析时按「缩进续行」整体取字段，因此模板里写块标量（| / >）、多行列表、
     * 嵌套 map 都不会把字段拆坏（旧版只认单行，续行会被静默丢弃）。
     */
    buildTemplateFields(file) {
        const template = String(this.settings.noteTemplate || "");
        const match = template.match(/^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
        const body = match ? match[1] : "";
        if (!body.trim()) {
            return [];
        }
        const parent = file.parent;
        const now = (0, obsidian_1.moment)();
        const variables = {
            folder: parent && parent.path ? parent.name : this.app.vault.getName(),
            filename: file.basename,
            path: parent ? parent.path : "",
            datetime: now.format("YYYY-MM-DDTHH"),
            date: now.format("YYYY-MM-DD"),
            time: now.format("HH:mm"),
            timestamp: now.format("YYYYMMDDHHmmssSSS"),
        };
        const variablePattern = /\{\{(folder|filename|path|datetime|date|time|timestamp)\}\}/g;
        const fields = [];
        const seen = new Set();
        const lines = body.split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
            const fieldMatch = lines[index].match(/^([A-Za-z0-9_\-\u4e00-\u9fa5]+):(.*)$/);
            if (!fieldMatch) {
                continue;
            }
            const key = fieldMatch[1];
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            const rawValue = fieldMatch[2].trim();
            // 收集属于这个字段的缩进续行（块标量 / 多行列表 / 嵌套 map）。
            const continuation = [];
            while (index + 1 < lines.length && /^[ \t]+\S/.test(lines[index + 1])) {
                index += 1;
                continuation.push(lines[index]);
            }
            if (continuation.length || /^[|>][+-]?$/.test(rawValue)) {
                const rendered = continuation
                    .map((line) => line.replace(variablePattern, (_all, name) => variables[name] ?? ""))
                    .join("\n");
                fields.push({ key, text: rawValue ? `${rawValue}\n${rendered}` : rendered });
                continue;
            }
            // 整个值就是一个变量时，按字符串整体转义，避免时间戳被当成天文数字。
            const variableOnly = rawValue.match(/^\{\{(folder|filename|path|datetime|date|time|timestamp)\}\}$/);
            if (variableOnly) {
                fields.push({ key, text: this.toYamlString(variables[variableOnly[1]] ?? "") });
                continue;
            }
            const rendered = rawValue.replace(variablePattern, (_all, name) => variables[name] ?? "");
            fields.push({ key, text: this.toYamlText(this.parseYamlScalar(rendered)) });
        }
        return fields;
    }
    /** 把模板里的一小段文本还原成合适的 JS 值（数组 / 数字 / 布尔 / 字符串）。 */
    parseYamlScalar(text) {
        const raw = String(text ?? "").trim();
        if (!raw) {
            return "";
        }
        // 纯数字自己处理：YAML 会把 17 位时间戳解析成浮点并丢掉精度。
        if (/^-?\d+$/.test(raw)) {
            return String(Number(raw)) === raw ? Number(raw) : raw;
        }
        // 其余交给 Obsidian 自带的 YAML 解析器，日期、布尔、列表、引号字符串都按
        // YAML 规则处理，与「右键新建笔记」写出的结果保持一致。
        // 含 # 的值不交给它，免得被当成行内注释截断。
        if (raw.indexOf("#") === -1) {
            try {
                const parsed = (0, obsidian_1.parseYaml)(`value: ${raw}`);
                if (parsed && Object.prototype.hasOwnProperty.call(parsed, "value")) {
                    const value = parsed.value;
                    if (value instanceof Date) {
                        return raw.replace(/^['"]/, "").replace(/['"]$/, "");
                    }
                    if (value !== undefined) {
                        return value;
                    }
                }
            }
            catch (error) {
                // YAML 解析失败时走下面的手工兜底。
            }
        }
        if (/^'(.*)'$/.test(raw)) {
            return raw.slice(1, -1);
        }
        return raw;
    }
    /** 把 JS 值写回 YAML 文本；空值写成 `key:`，保持与原模板一致。 */
    toYamlText(value) {
        if (value === null || value === undefined) {
            return "";
        }
        if (Array.isArray(value) || typeof value === "object") {
            return JSON.stringify(value);
        }
        if (typeof value === "number" || typeof value === "boolean") {
            return String(value);
        }
        const text = String(value);
        if (!text.trim()) {
            return "";
        }
        // 形如日期的字符串必须加引号，否则 YAML 会把它解析成 Date。
        if (/^\d{4}-\d{2}-\d{2}(?:[T ].*)?$/.test(text)) {
            return JSON.stringify(text);
        }
        // 像数字但不是规范数字（如 0123）也必须加引号，否则前导零会丢。
        if (/^-?\d+(?:\.\d+)?$/.test(text) && String(Number(text)) !== text) {
            return JSON.stringify(text);
        }
        if (/^[A-Za-z0-9\u4e00-\u9fa5][A-Za-z0-9\u4e00-\u9fa5 _\-./]*$/.test(text)) {
            return text;
        }
        return JSON.stringify(text);
    }
    /** 生成一整块 frontmatter（用于完全没有元数据的笔记）。 */
    buildFrontmatterBlock(fields, eol = "\n") {
        const lines = fields.map((field) => this.formatFieldLine(field).replace(/\n/g, eol));
        return `---${eol}${lines.join(eol)}${eol}---${eol}${eol}`;
    }
    /**
     * 拆出笔记的 frontmatter。
     * 返回 { prefix, body, suffix, rest, keys }，无法识别时返回 null。
     */
    splitFrontmatter(data) {
        const text = String(data ?? "");
        // BOM 归到 prefix 里：这样 mergeTemplateFields 计算偏移量时不会把它算丢。
        const match = text.match(/^(\uFEFF?---[ \t]*\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))/);
        if (match) {
            const body = match[2];
            return {
                prefix: match[1],
                body,
                suffix: match[3],
                rest: text.slice(match[0].length),
                keys: this.collectFrontmatterKeys(body),
            };
        }
        // 空 frontmatter 块（--- 紧跟 ---）单独处理，避免被当成「没有 frontmatter」。
        const emptyBlock = text.match(/^(\uFEFF?---[ \t]*\r?\n)(---[ \t]*(?:\r?\n|$))/);
        if (emptyBlock) {
            return {
                prefix: emptyBlock[1],
                body: "",
                // 补一个换行，保证插入的字段与闭合的 --- 不在同一行。
                suffix: `\n${emptyBlock[2]}`,
                rest: text.slice(emptyBlock[0].length),
                keys: [],
            };
        }
        return null;
    }
    /** 收集 frontmatter 里的一级字段名（模板里的字段都是平铺的）。 */
    collectFrontmatterKeys(body) {
        const keys = [];
        for (const line of String(body || "").split(/\r?\n/)) {
            const keyMatch = line.match(/^([A-Za-z0-9_\-\u4e00-\u9fa5]+):/);
            if (keyMatch) {
                keys.push(keyMatch[1]);
            }
        }
        return keys;
    }
}
exports.default = FolderTemplateNotePlugin;
/** 批量补全前的确认弹窗。 */
class AuditConfirmModal extends obsidian_1.Modal {
    constructor(app, message, onConfirm) {
        super(app);
        this.message = message;
        this.onConfirm = onConfirm;
    }
    onOpen() {
        this.titleEl.setText("审查并补全元数据");
        this.contentEl.createEl("p", { text: this.message });
        new obsidian_1.Setting(this.contentEl)
            .addButton((button) => {
            button.setButtonText("取消").onClick(() => this.close());
        })
            .addButton((button) => {
            button
                .setButtonText("开始补全")
                .setCta()
                .onClick(() => {
                this.close();
                void this.onConfirm();
            });
        });
    }
    onClose() {
        this.contentEl.empty();
    }
}
/** 新建模板笔记时用于输入文件名的弹窗。 */
class NoteNameModal extends obsidian_1.Modal {
    constructor(app, folder, modalTitle, onSubmit) {
        super(app);
        this.folder = folder;
        this.modalTitle = modalTitle;
        this.onSubmit = onSubmit;
        /** 用户当前输入的笔记名称。 */
        this.noteName = "";
        /** 防止连续按回车或连续点击“创建”导致重复提交。 */
        this.submitting = false;
    }
    /** 弹窗打开时构建界面。 */
    onOpen() {
        this.titleEl.setText(this.modalTitle);
        const targetPath = this.folder.path || "/";
        new obsidian_1.Setting(this.contentEl)
            .setName("笔记名称")
            .setDesc(`创建到：${targetPath}`)
            .addText((text) => {
            text
                .setPlaceholder("例如：Selenium 基础")
                .onChange((value) => {
                this.noteName = value;
            });
            text.inputEl.addClass("xyblue135-template-note-name-input");
            // 在输入框中按回车即可直接创建笔记。
            text.inputEl.addEventListener("keydown", (event) => {
                // 输入法正在组合中文时，不把 Enter 当成提交操作。
                if (event.key === "Enter" && !event.isComposing) {
                    event.preventDefault();
                    void this.submit();
                }
            });
            // 弹窗打开后自动把焦点放进输入框。
            window.setTimeout(() => text.inputEl.focus(), 0);
        });
        new obsidian_1.Setting(this.contentEl).addButton((button) => {
            button
                .setButtonText("创建")
                .setCta()
                .onClick(() => {
                void this.submit();
            });
        });
    }
    /** 弹窗关闭时清理 DOM。 */
    onClose() {
        this.contentEl.empty();
    }
    /** 提交用户输入的笔记名称。 */
    async submit() {
        if (this.submitting) {
            return;
        }
        const name = this.noteName.trim();
        if (!name) {
            new obsidian_1.Notice("请输入笔记名称");
            return;
        }
        this.submitting = true;
        this.close();
        try {
            await this.onSubmit(name);
        }
        finally {
            this.submitting = false;
        }
    }
}
/** 插件设置页。 */
class FolderTemplateNoteSettingTab extends obsidian_1.PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }
    /** 关闭设置页时把防抖中的修改立刻落盘。 */
    hide() {
        void this.plugin.flushSave();
    }
    /** 渲染插件设置界面。 */
    display() {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl("h2", { text: "xyblue135 私人 · 元数据补全" });
        containerEl.createEl("p", {
            text: "用 Obsidian 原生方式新建笔记后，本插件会自动给白名单目录里的 .md 补上缺失的模板字段。",
            cls: "setting-item-description",
        });
        containerEl.createEl("h3", { text: "笔记元数据模板" });
        containerEl.createEl("p", {
            text: "下面就是当前实际使用的模板。修改后会自动保存；以后新建的笔记都会使用这里的内容。",
            cls: "setting-item-description",
        });
        new obsidian_1.Setting(containerEl)
            .setName("模板内容")
            .setDesc("默认是插件预设。支持 {{folder}}、{{filename}}、{{path}}、{{datetime}}、{{date}}、{{time}}、{{timestamp}}（17 位时间戳 yyyyMMddHHmmssSSS）。变量外不要额外加引号。")
            .addTextArea((textArea) => {
            textArea
                .setPlaceholder(DEFAULT_TEMPLATE)
                .setValue(this.plugin.settings.noteTemplate)
                .onChange(async (value) => {
                // 输入过程用防抖保存，避免每敲一个字符就写一次 data.json。
                this.plugin.settings.noteTemplate = value;
                this.plugin.queueSave();
            });
            textArea.inputEl.rows = 16;
            textArea.inputEl.addClass("xyblue135-template-note-template-input");
        })
            .addButton((button) => {
            button
                .setButtonText("恢复默认模板")
                .setWarning()
                .onClick(async () => {
                await this.plugin.resetTemplate();
                new obsidian_1.Notice("已恢复默认元数据模板");
                // 重新渲染设置页，让文本框立刻显示恢复后的模板。
                this.display();
            });
        });
        const variablesEl = containerEl.createDiv({
            cls: "xyblue135-template-note-variable-help",
        });
        variablesEl.createEl("strong", { text: "可用变量：" });
        variablesEl.createEl("code", {
            text: "{{folder}}  {{filename}}  {{path}}  {{datetime}}  {{date}}  {{time}}  {{timestamp}}",
        });
        containerEl.createEl("h3", { text: "审查与自动补全" });
        containerEl.createEl("p", {
            text: "用 Obsidian 自带方式新建 .md 时，插件会在下面这些目录里检查 frontmatter，只追加缺失的模板字段（不覆盖已有值，也不动正文）。即使误点了「新建笔记」，元数据也会自动补齐。",
            cls: "setting-item-description",
        });
        new obsidian_1.Setting(containerEl)
            .setName("审查白名单目录")
            .setDesc("多个目录用逗号分隔，自动包含子目录；留空表示整个仓库。例如：my_blog/00_docs, my_blog/00_暂未分类/待分类")
            .addText((text) => {
            text
                .setPlaceholder("my_blog/00_docs")
                .setValue(this.plugin.settings.auditFolders)
                .onChange(async (value) => {
                this.plugin.settings.auditFolders = value;
                this.plugin.queueSave();
            });
        });
        new obsidian_1.Setting(containerEl)
            .setName("新建笔记后自动补全")
            .setDesc("关闭后只保留手动命令与右键创建，不再自动审查新笔记。")
            .addToggle((toggle) => {
            toggle
                .setValue(this.plugin.settings.auditOnCreate !== false)
                .onChange(async (value) => {
                this.plugin.settings.auditOnCreate = value;
                this.plugin.queueSave();
            });
        });
        new obsidian_1.Setting(containerEl)
            .setName("补全延迟（毫秒）")
            .setDesc("新建后等待多久再检查，默认 1500，下限 300，小于 300 的值不会生效。慢慢打字时若发现补全太早，可调大到 3000。")
            .addText((text) => {
            // 输入过程中只接受合法值；非法值留到失焦时再回滚并提示，
            // 否则刚敲下第一个数字（如 3）就会被立刻弹回 1500，输入框等于不可编辑。
            const commit = (value) => {
                const parsed = Number(String(value).trim());
                if (Number.isFinite(parsed) && parsed >= 300) {
                    this.plugin.settings.auditDelayMs = Math.round(parsed);
                    this.plugin.queueSave();
                    return true;
                }
                return false;
            };
            text
                .setPlaceholder("1500")
                .setValue(String(this.plugin.settings.auditDelayMs))
                .onChange((value) => {
                commit(value);
            });
            text.inputEl.addEventListener("blur", () => {
                if (commit(text.inputEl.value)) {
                    return;
                }
                text.setValue(String(this.plugin.settings.auditDelayMs));
                new obsidian_1.Notice(`补全延迟需为不小于 300 的整数（毫秒），已恢复为 ${this.plugin.settings.auditDelayMs}`);
            });
        });
        new obsidian_1.Setting(containerEl)
            .setName("批量补全历史笔记")
            .setDesc("扫描白名单内所有笔记，给缺少 frontmatter 字段的旧笔记补齐。执行前会先弹出确认框，建议先提交 Git。")
            .addButton((button) => {
            button
                .setButtonText("开始批量审查")
                .setWarning()
                .onClick(() => {
                void this.plugin.runBulkAudit();
            });
        });
    }
}

// Obsidian 插件入口需要直接导出插件类。
module.exports = exports.default;
