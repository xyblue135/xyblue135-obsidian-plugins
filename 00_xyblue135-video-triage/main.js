/*
 * xyblue135 · 视频分诊
 * 类型：xyblue135 开源插件
 * 说明：粘贴 B 站视频链接 → 调用本机 python 跑 triage.py（yt-dlp 字幕 / whisper 转写
 *       → 网关 LLM 要点抽取 → 知识库比对 → 三档判定）→ 值得看的写收件箱笔记，
 *       由「待完成工作台」接管。插件只做编排与 UI，重活全部在外部程序。
 */
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const obsidian_1 = require("obsidian");
const child_process_1 = require("child_process");

const VIEW_TYPE = "xyblue135-video-triage-view";
const DEFAULT_SETTINGS = {
    pythonCmd: "python",
    cookiesBrowser: "",
    model: "small",
    inbox: "my_blog/00_docs/收件箱",
};

/* ---------------- 链接输入 Modal ---------------- */
class TriageModal extends obsidian_1.Modal {
    constructor(app, plugin) {
        super(app);
        this.plugin = plugin;
    }
    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl("h3", { text: "视频分诊" });
        contentEl.createDiv({ cls: "xyvt-hint", text: "每行一个 B 站链接（BV 号或完整 URL），逐条处理。" });
        let ta;
        new obsidian_1.Setting(contentEl)
            .setName("视频链接")
            .addTextArea((t) => {
            ta = t;
            t.inputEl.rows = 4;
            t.inputEl.style.width = "100%";
            t.setValue(this.plugin.getCachedLinks());
        });
        new obsidian_1.Setting(contentEl)
            .setName("B 站 Cookie 来源浏览器")
            .setDesc("拉字幕需要登录态；选你登录了 B 站的浏览器（需已关闭该浏览器或支持读取）")
            .addDropdown((d) => {
            d.addOption("", "不使用（走 whisper 转写）");
            d.addOption("edge", "Edge");
            d.addOption("chrome", "Chrome");
            d.addOption("firefox", "Firefox");
            d.setValue(this.plugin.settings.cookiesBrowser);
            d.onChange(async (v) => { this.plugin.settings.cookiesBrowser = v; await this.plugin.saveSettings(); });
        });
        const btns = contentEl.createDiv({ cls: "xyvt-btns" });
        btns.createEl("button", { cls: "xyvt-btn", text: "开始分诊" }).addEventListener("click", () => {
            const links = ta.getValue().split("\n").map((s) => s.trim()).filter(Boolean);
            if (!links.length) { new obsidian_1.Notice("请先粘贴链接"); return; }
            this.plugin.cacheLinks(ta.getValue());
            this.close();
            this.plugin.runQueue(links);
        });
        btns.createEl("button", { cls: "xyvt-btn xyvt-btn-ghost", text: "取消" }).addEventListener("click", () => this.close());
    }
    onClose() { this.contentEl.empty(); }
}

/* ---------------- 主插件 ---------------- */
class VideoTriagePlugin extends obsidian_1.Plugin {
    async onload() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
        this._queue = [];
        this._running = false;
        const ribbonEl = this.addRibbonIcon("monitor-play", "视频分诊", () => this.openModal());
        ribbonEl.addClass("xyblue135-ribbon", "xyblue135-ai");
        this.addCommand({ id: "open", name: "打开视频分诊", callback: () => this.openModal() });
        this.addCommand({ id: "triage-clipboard", name: "分诊剪贴板里的视频链接", callback: () => {
            navigator.clipboard.readText().then((t) => {
                const links = t.split(/\s+/).map((s) => s.trim()).filter((s) => /bilibili|BV/i.test(s));
                if (!links.length) { new obsidian_1.Notice("剪贴板里没有 B 站链接"); return; }
                this.runQueue(links);
            }, () => new obsidian_1.Notice("无法读取剪贴板"));
        } });
        this.addSettingTab(new VideoTriageSettingTab(this.app, this));
    }
    onunload() { }
    async saveSettings() { await this.saveData(this.settings); }
    getCachedLinks() { try { return this._lastLinks || ""; } catch (e) { return ""; } }
    cacheLinks(v) { this._lastLinks = v; }

    openModal() {
        new TriageModal(this.app, this).open();
    }

    runQueue(links) {
        this._queue = this._queue.concat(links);
        if (this._running) return;
        this._running = true;
        void this.pump();
    }
    async pump() {
        let idx = 0;
        while (this._queue.length) {
            const url = this._queue.shift();
            idx++;
            await this.runOne(url, idx);
        }
        this._running = false;
        new obsidian_1.Notice("视频分诊全部完成，收件箱笔记见「待完成工作台」", 6000);
    }
    runOne(url, idx) {
        return new Promise((resolve) => {
            const script = obsidian_1.normalizePath(this.manifest.dir + "/triage.py");
            const vault = (this.app.vault.adapter).getBasePath();
            const args = [script, "--url", url, "--vault", vault,
                "--inbox", this.settings.inbox, "--model", this.settings.model];
            if (this.settings.cookiesBrowser) args.push("--cookies-from-browser", this.settings.cookiesBrowser);
            let notice = new obsidian_1.Notice("[" + idx + "] 分诊启动中: " + url, 0);
            let lastStage = "";
            let tail = "";
            const child = (0, child_process_1.spawn)(this.settings.pythonCmd, args, { cwd: this.manifest.dir });
            const onFinish = (code, err) => {
                notice.hide();
                if (code === 0) {
                    new obsidian_1.Notice("[" + idx + "] 完成: " + url, 5000);
                } else {
                    new obsidian_1.Notice("[" + idx + "] 失败(码 " + code + "): " + (err || tail).slice(-200), 10000);
                }
                resolve();
            };
            child.stdout.on("data", (d) => {
                const lines = String(d).split("\n").filter(Boolean);
                for (const line of lines) {
                    tail = line;
                    const m = line.match(/^\[triage:(\w+)\]\s*(.*)$/);
                    if (m) {
                        notice.setMessage("[" + idx + "] " + STAGE_ZH[m[1]] + " " + (m[2] || "").slice(0, 60));
                    }
                }
            });
            child.stderr.on("data", (d) => { tail = String(d).split("\n").slice(-1)[0] || tail; });
            child.on("error", (e) => {
                notice.hide();
                new obsidian_1.Notice("启动 python 失败：" + e.message + "（请到设置里把 Python 路径改为完整路径）", 12000);
                resolve();
            });
            child.on("close", (code) => onFinish(code, null));
        });
    }
}

const STAGE_ZH = {
    cfg: "配置", sub: "字幕/转写", asr: "whisper 转写", llm: "AI 分析",
    match: "知识库比对", done: "完成",
};

/* ---------------- 设置页 ---------------- */
class VideoTriageSettingTab extends obsidian_1.PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }
    display() {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl("h2", { text: "视频分诊 · 设置" });
        new obsidian_1.Setting(containerEl)
            .setName("Python 路径")
            .setDesc("启动失败时改为完整路径，如 D:\\4environment\\python\\WPy64-312101b4\\python\\python.exe")
            .addText((t) => t.setValue(this.plugin.settings.pythonCmd).onChange(async (v) => {
                this.plugin.settings.pythonCmd = v.trim() || "python";
                await this.plugin.saveSettings();
            }));
        new obsidian_1.Setting(containerEl)
            .setName("B 站 Cookie 来源浏览器")
            .setDesc("edge / chrome / firefox；留空则不走字幕、直接 whisper 转写")
            .addText((t) => t.setValue(this.plugin.settings.cookiesBrowser).onChange(async (v) => {
                this.plugin.settings.cookiesBrowser = v.trim().toLowerCase();
                await this.plugin.saveSettings();
            }));
        new obsidian_1.Setting(containerEl)
            .setName("whisper 模型")
            .setDesc("small（推荐）/ base / medium；首次使用会自动下载")
            .addText((t) => t.setValue(this.plugin.settings.model).onChange(async (v) => {
                this.plugin.settings.model = v.trim() || "small";
                await this.plugin.saveSettings();
            }));
        new obsidian_1.Setting(containerEl)
            .setName("收件箱目录")
            .setDesc("值得看的视频笔记写入位置（默认 my_blog/00_docs/收件箱）")
            .addText((t) => t.setValue(this.plugin.settings.inbox).onChange(async (v) => {
                this.plugin.settings.inbox = v.trim() || "my_blog/00_docs/收件箱";
                await this.plugin.saveSettings();
            }));
    }
}

module.exports = VideoTriagePlugin;
