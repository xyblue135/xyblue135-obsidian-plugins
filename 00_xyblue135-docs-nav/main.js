/*
 * xyblue135 · 知识库导航
 * 类型：xyblue135 开源插件
 * 说明：用四种交互视图（树状图 / 旭日图 / 矩形树图 / 标签星图）浏览白名单目录（默认 00_docs）。
 *       数据实时扫描笔记 frontmatter（AI_tags / AI_technical_depth / token_count 等），
 *       颜色映射技术深度，面积映射 Token 量；点击节点查看元数据并可直接打开笔记。
 *       图表库 ECharts 位于 lib/echarts.min.js，本地加载，无需联网。
 */
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const obsidian_1 = require("obsidian");

const VIEW_TYPE = "xyblue135-docs-nav-view";

const DEFAULT_SETTINGS = {
    rootFolder: "00_docs",
    topTags: 60,
    cooccurMin: 2,
    minDocsPerSkill: 3,
    skillRadial: false,
};

/* viridis 色带（10 个锚点），用于技术深度 0→100 的连续映射 */
const VIRIDIS = [
    [68, 1, 84], [72, 40, 120], [62, 73, 137], [49, 104, 142], [38, 130, 142],
    [31, 158, 137], [53, 183, 121], [110, 206, 88], [181, 222, 43], [253, 231, 37],
];
function depthColor(t) {
    const v = Math.max(0, Math.min(100, t || 0));
    const x = (v / 100) * (VIRIDIS.length - 1);
    const i = Math.min(VIRIDIS.length - 2, Math.floor(x));
    const f = x - i;
    const a = VIRIDIS[i], b = VIRIDIS[i + 1];
    return "rgb(" + Math.round(a[0] + (b[0] - a[0]) * f) + "," + Math.round(a[1] + (b[1] - a[1]) * f) + "," + Math.round(a[2] + (b[2] - a[2]) * f) + ")";
}
function depthColorAlpha(t, op) {
    return depthColor(t).replace("rgb(", "rgba(").replace(")", "," + op + ")");
}

/* ---------------- 技能树（与「xyblue135 · 技能提炼」同口径） ----------------
 * 方向映射表、簇聚合口径与配色取自姊妹插件 00_xyblue135-skill-miner（同一作者维护），
 * 运行时还会读取其 data.json 的 refined / tagCanonicalList / ignoreTags，
 * 让两边的技能树方向与 AI 定级保持一致；读不到时自动降级为关键词方向。 */

const TRACK_RULES = [
    ["容器与编排", ["docker", "kubernetes", "k8s", "podman", "compose", "harbor", "容器", "镜像", "编排"]],
    ["监控与可观测", ["prometheus", "grafana", "zabbix", "loki", "promtail", "skywalking", "监控", "告警", "可观测"]],
    ["排错与故障处理", ["故障排查", "故障", "排错", "问题定位", "troubleshoot", "debug"]],
    ["网络与协议", ["网络", "网卡", "抓包", "路由", "交换", "代理", "端口", "vpn", "http", "https", "tcp", "udp", "dns", "ssh", "tls", "wireshark", "tcpdump", "nmap"]],
    ["数据库与存储", ["mysql", "postgresql", "redis", "mongodb", "mongo", "sqlite", "数据库", "sql", "nosql", "备份", "存储"]],
    ["AI 与 LLM", ["openai", "chatgpt", "llm", "rag", "agent", "mcp", "向量", "embedding", "提示词", "deepseek", "claude", "gemini", "微调", "ai"]],
    ["DevOps 与交付", ["jenkins", "ansible", "terraform", "gitlab", "github", "git", "nacos", "devops", "mlops", "cicd", "部署", "发布", "交付"]],
    ["操作系统与环境", ["linux", "windows", "macos", "ubuntu", "centos", "debian", "systemd", "内核", "权限", "文件系统", "root", "sudo", "环境"]],
    ["开发与脚本", ["python", "java", "javascript", "typescript", "nodejs", "shell", "bash", "脚本", "编程", "正则", "编码", "c++", "cpp", "golang"]],
    ["多媒体与兴趣", ["ffmpeg", "minecraft", "unity", "游戏", "视频", "音频", "直播", "obs"]],
];

const TRACK_COLORS = {
    "操作系统与环境": "#5b8def",
    "容器与编排": "#29a599",
    "网络与协议": "#d99a3d",
    "监控与可观测": "#c9553d",
    "数据库与存储": "#8f6ad6",
    "AI 与 LLM": "#d65f8f",
    "DevOps 与交付": "#7f8fa6",
    "开发与脚本": "#4caf7d",
    "排错与故障处理": "#e0705d",
    "多媒体与兴趣": "#b5893c",
    "其他与兴趣": "#9aa0a6",
};

const LEVEL_FACE = { "精通": "😄", "熟练": "😐", "了解": "😢" };

const TRACK_PALETTE = [
    "#4a7fc1", "#3f9e8f", "#c08a2e", "#b35540", "#7a63c4", "#c25d86",
    "#6b7d8f", "#3f9a6e", "#cf6a55", "#a8813a", "#8a6bb5", "#4f9ec4",
];

function hashText(s) {
    let h = 0;
    const t = String(s == null ? "" : s);
    for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
    return h;
}
function trackColor(name) {
    const n = String(name == null ? "" : name).trim();
    if (TRACK_COLORS[n]) return TRACK_COLORS[n];
    if (!n) return "#9aa0a6";
    return TRACK_PALETTE[hashText(n) % TRACK_PALETTE.length];
}
function trackKey(name) {
    return String(name == null ? "" : name)
        .toLowerCase()
        .replace(/[\s\u3000_\-·—/\\()（）【】\[\]「」]/g, "")
        .replace(/[与和及]/g, "");
}
function canonicalTrack(name) {
    const s = String(name == null ? "" : name).replace(/^[\s"'“”‘’《》【】]+|[\s"'“”‘’《》【】]+$/g, "").replace(/\s+/g, " ").trim();
    if (!s || s.length > 12 || /^(undefined|null|nan|true|false|\[object object\])$/i.test(s)) return "";
    if (TRACK_COLORS[s]) return s;
    const k = trackKey(s);
    for (const builtin of Object.keys(TRACK_COLORS)) {
        if (trackKey(builtin) === k) return builtin;
    }
    return s;
}
function trackOf(name) {
    const s = String(name || "").toLowerCase();
    for (const [track, kws] of TRACK_RULES) {
        for (const kw of kws) {
            if (/[\u4e00-\u9fff]/.test(kw)) {
                if (s.includes(kw)) return track;
            } else if (new RegExp("(^|[^a-z0-9])" + kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "([^a-z0-9]|$)", "i").test(s)) {
                return track;
            }
        }
    }
    return "其他与兴趣";
}
/* 归一键：小写后去掉空白/下划线/连字符/中点，"ip link"/"ip-link" 折叠为同一簇 */
function mergeKeyOf(t) {
    return String(t == null ? "" : t).toLowerCase().replace(/[\s\u3000_\-·]+/g, "");
}
/* 名称查找器：全等 → 归一化全等 → 唯一包含（与技能提炼的匹配策略一致） */
function makeNameLookup(items) {
    const exact = new Map();
    const norm = new Map();
    const all = [];
    for (const it of items) {
        if (!it || !it.name) continue;
        all.push(it);
        exact.set(it.name, it);
        const k = mergeKeyOf(it.name);
        if (!norm.has(k)) norm.set(k, it);
    }
    return {
        get(name) {
            if (exact.has(name)) return exact.get(name);
            const k = mergeKeyOf(name);
            if (norm.has(k)) return norm.get(k);
            if (!name) return null;
            const hits = all.filter((x) => x.name.includes(name) || String(name).includes(x.name));
            return hits.length === 1 ? hits[0] : null;
        },
    };
}
/* 技能矩阵：标签归一 → 技能簇（篇数/均深/最近更新/方向），仅统计 status: done，与技能提炼同口径 */
function buildSkillMatrix(tree, settings, linkage) {
    const done = [];
    const eachNote = (node, cb) => { node.notes.forEach(cb); node.folders.forEach((s) => eachNote(s, cb)); };
    eachNote(tree, (m) => {
        /* 与技能提炼同口径：仅统计 status: 🟢 done；注意 "undone" 也包含 "done"，需显式排除 */
        const s = String(m.s);
        if (s.indexOf("done") >= 0 && s.indexOf("undone") < 0) done.push(m);
    });
    const canon = (t) => linkage.canonical.get(String(t).toLowerCase()) || t;
    const ignore = linkage.ignore;
    const clusters = new Map();
    const seen = new Map();
    for (const m of done) {
        for (const raw of m.t) {
            let t = canon(String(raw).trim());
            const key = mergeKeyOf(t);
            if (!key) continue;
            if (seen.has(key)) t = seen.get(key);
            else seen.set(key, t);
            if (ignore.has(t.toLowerCase())) continue;
            let c = clusters.get(key);
            if (!c) {
                c = { name: t, docs: [], depths: [], tokens: 0, last: "" };
                clusters.set(key, c);
            }
            c.docs.push({ p: m.p, ti: m.ti || m.n, d: m.d, v: m.v, t: m.t });
            c.depths.push(m.d);
            c.tokens += m.v;
            if (String(m.u) > c.last) c.last = String(m.u);
        }
    }
    const minDocs = Math.max(1, Number(settings.minDocsPerSkill) || 3);
    const list = [...clusters.values()]
        .filter((c) => c.docs.length >= minDocs)
        .map((c) => ({
            name: c.name,
            count: c.docs.length,
            avgDepth: Math.round(c.depths.reduce((a, b) => a + b, 0) / c.depths.length),
            tokens: c.tokens,
            last: c.last,
            track: trackOf(c.name),
            docs: c.docs.slice().sort((a, b) => b.d - a.d),
        }))
        .sort((a, b) => b.count * (1 + b.avgDepth / 100) - a.count * (1 + a.avgDepth / 100));
    if (linkage.refined.length) {
        const lookup = makeNameLookup(linkage.refined);
        for (const c of list) {
            const r = lookup.get(c.name);
            if (r) {
                c.track = canonicalTrack(r.track) || c.track;
                c.category = r.category || "";
                c.level = r.level || "";
                c.resumeLine = r.resumeLine || "";
                c.summary = r.summary || "";
            }
        }
    }
    return { clusters: list, doneDocs: done.length };
}

function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
}
function fmtDate(u) {
    u = String(u == null ? "" : u);
    if (u.length >= 8) return u.slice(0, 4) + "-" + u.slice(4, 6) + "-" + u.slice(6, 8);
    return u || "—";
}
function fmtWan(n) {
    return n >= 10000 ? (n / 10000).toFixed(1) + " 万" : String(n || 0);
}

/* ---------------- 数据构建：扫描 frontmatter ---------------- */
function toArr(v) {
    if (Array.isArray(v)) return v.filter(Boolean).map(String);
    if (typeof v === "string" && v.trim()) return [v.trim()];
    return [];
}
function buildData(app, settings, linkage) {
    const root = settings.rootFolder.replace(/[\\/]+$/, "");
    const rootFolder = app.vault.getAbstractFileByPath(root);
    const tree = { n: root, p: "", folders: new Map(), notes: [] };
    if (rootFolder instanceof obsidian_1.TFolder) {
        const walk = (folder, parentNode, prefix) => {
            for (const child of folder.children) {
                if (child instanceof obsidian_1.TFolder) {
                    const key = child.name;
                    let sub = parentNode.folders.get(key);
                    if (!sub) {
                        sub = { n: child.name, p: prefix ? prefix + "/" + child.name : child.name, folders: new Map(), notes: [] };
                        parentNode.folders.set(key, sub);
                    }
                    walk(child, sub, sub.p);
                } else if (child instanceof obsidian_1.TFile && child.extension === "md") {
                    const cache = app.metadataCache.getFileCache(child);
                    const fm = cache && cache.frontmatter ? cache.frontmatter : {};
                    const tags = toArr(fm["AI_tags"]).slice(0, 6);
                    const titles = toArr(fm["AI_title"]);
                    parentNode.notes.push({
                        n: child.basename,
                        p: child.path,
                        v: Number(fm["token_count"]) || 0,
                        d: Math.round(Number(fm["AI_technical_depth"]) || 0),
                        f: String(fm["AI_freshness"] || ""),
                        s: String(fm["status"] || ""),
                        vi: String(fm["visibility"] || ""),
                        u: String(fm["updated"] || ""),
                        t: tags,
                        ti: titles.length ? titles[0].slice(0, 80) : "",
                        sm: String(fm["AI_summary_short"] || "").slice(0, 180),
                    });
                }
            }
        };
        walk(rootFolder, tree, "");
    }

    /* 递归聚合：篇数 / token 总量 / 平均技术深度 */
    const agg = (node) => {
        let notes = 0, toks = 0, dsum = 0, dn = 0;
        for (const m of node.notes) {
            notes++; toks += m.v; dsum += m.d; dn++;
        }
        for (const sub of node.folders.values()) {
            const a = agg(sub);
            notes += a.n; toks += a.t; dsum += a.d * a.dn; dn += a.dn;
        }
        node._n = notes; node._t = toks;
        node._d = dn ? Math.round(dsum / dn) : 0;
        return { n: notes, t: toks, d: node._d, dn: dn };
    };
    agg(tree);

    /* 转成 ECharts 树结构 */
    const toTN = (node) => {
        const o = { name: node.n, p: root + "/" + node.p, _n: node._n, _t: node._t, _d: node._d };
        const kids = [];
        for (const sub of node.folders.values()) kids.push(toTN(sub));
        /* 叶子节点必须显式映射 name / value，ECharts 树与矩形树图依赖这两个字段 */
        for (const m of node.notes) {
            kids.push({
                name: m.n, p: m.p, value: m.v, d: m.d, f: m.f, s: m.s, vi: m.vi,
                ti: m.ti, sm: m.sm, t: m.t, u: m.u,
            });
        }
        if (kids.length) o.children = kids;
        return o;
    };
    const full = toTN(tree);

    /* 标签索引与共现 */
    const tagNotes = {};
    const tagCount = {};
    const cooccur = new Map();
    const eachNote = (node, cb) => {
        node.notes.forEach(cb);
        node.folders.forEach((sub) => eachNote(sub, cb));
    };
    eachNote(tree, (m) => {
        const seen = [];
        for (const tg of m.t) {
            if (seen.indexOf(tg) < 0) seen.push(tg);
            if (!tagNotes[tg]) tagNotes[tg] = [];
            tagNotes[tg].push(m);
            tagCount[tg] = (tagCount[tg] || 0) + 1;
        }
        for (let i = 0; i < seen.length; i++)
            for (let j = i + 1; j < seen.length; j++) {
                const key = seen[i] < seen[j] ? seen[i] + "\u0000" + seen[j] : seen[j] + "\u0000" + seen[i];
                cooccur.set(key, (cooccur.get(key) || 0) + 1);
            }
    });
    const top = Object.keys(tagCount)
        .sort((a, b) => tagCount[b] - tagCount[a])
        .slice(0, settings.topTags);
    const tagSet = new Set(top);
    const edges = [];
    for (const [key, w] of cooccur) {
        const pair = key.split("\u0000");
        if (w >= settings.cooccurMin && tagSet.has(pair[0]) && tagSet.has(pair[1]))
            edges.push({ s: pair[0], t: pair[1], w: w });
    }
    edges.sort((a, b) => b.w - a.w);

    /* 总览统计 */
    let stAll = 0, stTodo = 0, stStale = 0, stTok = 0;
    eachNote(tree, (m) => {
        stAll++; stTok += m.v;
        if (m.s.indexOf("undone") >= 0) stTodo++;
        if (m.f.indexOf("过时") >= 0) stStale++;
    });
    return {
        full: full, tagNotes: tagNotes,
        graph: { tags: top.map((t) => ({ t: t, c: tagCount[t] })), e: edges },
        stats: { all: stAll, todo: stTodo, stale: stStale, tok: stTok },
        rootLabel: root,
        skill: buildSkillMatrix(tree, settings, linkage || { refined: [], canonical: new Map(), ignore: new Set() }),
    };
}

/* ---------------- 主视图 ---------------- */
class NavView extends obsidian_1.ItemView {
    constructor(leaf, plugin) {
        super(leaf);
        this.plugin = plugin;
        this.chart = null;
        this.data = null;
        this.curView = "skill";
        this.q = "";
        this.CAPTIONS = {
            skill: "与「技能提炼」同口径（仅 status: done）· 分支配色 = 方向 · 😄精通 😐熟练 😢了解 · 点击簇看定级与代表笔记",
            tree: "颜色 = 技术深度（0→100）· 半透明 = 未完成 · 滚轮缩放 · 点击展开/收起目录",
            sun: "环层 = 目录层级 · 扇区大小 = Token 量 · 颜色 = 技术深度",
            map: "面积 = Token 量 · 颜色 = 技术深度 · 点击下钻，面包屑返回",
            tag: "节点大小 = 标签出现篇数 · 连线 = 同篇共现 · 点击标签看相关笔记",
        };
    }
    getViewType() { return VIEW_TYPE; }
    getDisplayText() { return "知识库导航图"; }
    getIcon() { return "git-fork"; }

    async onOpen() {
        const el = this.contentEl;
        el.empty();
        el.addClass("xy-nav-root");

        /* 工具行：统计 + 搜索 + 刷新 */
        const bar = el.createDiv({ cls: "xy-nav-bar" });
        this.chipsEl = bar.createDiv({ cls: "xy-nav-chips" });
        const right = bar.createDiv({ cls: "xy-nav-bar-right" });
        this.qEl = right.createEl("input", {
            cls: "xy-nav-search",
            type: "search",
            attr: { placeholder: "搜索 名称 / AI标题 / 标签", "aria-label": "搜索笔记" },
        });
        this.refreshBtn = right.createEl("button", { cls: "xy-nav-btn", text: "重新扫描" });

        /* 视图页签 */
        const tabs = el.createDiv({ cls: "xy-nav-tabs" });
        this.tabBtns = {};
        const defs = [["skill", "技能树"], ["tree", "树状图"], ["sun", "旭日图"], ["map", "矩形树图"], ["tag", "标签星图"]];
        for (const [id, label] of defs) {
            const b = tabs.createEl("button", { cls: "xy-nav-tab", text: label });
            b.addEventListener("click", () => { this.curView = id; this.syncTabs(); this.render(); });
            this.tabBtns[id] = b;
        }
        this.captionEl = tabs.createDiv({ cls: "xy-nav-caption" });
        /* 技能树专属：横向 / 径向布局切换 */
        this.layoutBtn = tabs.createEl("button", {
            cls: "xy-nav-tab xy-nav-layout-btn",
            text: this.plugin.settings.skillRadial ? "布局：径向" : "布局：横向",
        });
        this.layoutBtn.addEventListener("click", async () => {
            this.plugin.settings.skillRadial = !this.plugin.settings.skillRadial;
            await this.plugin.saveSettings();
            this.layoutBtn.setText(this.plugin.settings.skillRadial ? "布局：径向" : "布局：横向");
            if (this.curView === "skill") this.render();
        });

        /* 图表（左）+ 常驻详情栏（右） */
        const body = el.createDiv({ cls: "xy-nav-body" });
        const mainCol = body.createDiv({ cls: "xy-nav-main" });
        this.chartEl = mainCol.createDiv({ cls: "xy-nav-chart" });
        this.chartEl.setAttribute("role", "img");
        this.chartEl.setAttribute("aria-label", "知识库交互导航图");
        this.detailEl = body.createDiv({ cls: "xy-nav-detail" });

        this.qEl.addEventListener("input", () => {
            clearTimeout(this._qTimer);
            this._qTimer = setTimeout(() => { this.q = this.qEl.value.trim().toLowerCase(); this.render(); }, 260);
        });
        this.refreshBtn.addEventListener("click", async () => {
            this.refreshBtn.disabled = true;
            this.refreshBtn.setText("扫描中…");
            await this.rescan();
            this.refreshBtn.disabled = false;
            this.refreshBtn.setText("重新扫描");
            this.render();
        });
        this.detailEl.addEventListener("click", (ev) => {
            const t = ev.target;
            const cmd = t.closest("[data-cmd]");
            if (cmd) {
                const id = cmd.getAttribute("data-cmd");
                try {
                    this.app.commands.executeCommandById(id);
                } catch (e) {
                    new obsidian_1.Notice("未找到技能提炼插件（可能未安装或未启用）");
                }
                return;
            }
            const open = t.closest("[data-open]");
            if (open) {
                const f = this.app.vault.getAbstractFileByPath(open.getAttribute("data-open"));
                if (f instanceof obsidian_1.TFile) this.app.workspace.getLeaf("tab").openFile(f);
                return;
            }
            const cp = t.closest("[data-copy]");
            if (cp) {
                const txt = cp.getAttribute("data-copy");
                const done = () => { const o = cp.textContent; cp.textContent = "已复制 ✓"; setTimeout(() => { cp.textContent = o; }, 1400); };
                this.copyText(txt, done);
            }
        });

        /* 主题变化时重绘 */
        this.registerEvent(this.app.workspace.on("css-change", () => { this.resolveTheme(); this.render(); }));

        await this.rescan();
        try {
            await this.ensureEcharts();
            this.chart = echarts.init(this.chartEl);
            /* 图表节点点击 → 详情栏（此前缺失导致所有视图点击无反应） */
            this.chart.on("click", (p) => {
                const d = p.data;
                if (d) this.showDetail(d);
            });
        } catch (e) {
            this.chartEl.setText("图表库初始化失败：" + (e && e.message ? e.message : e) + "（lib/echarts.min.js 可能损坏，请重装插件）");
            return;
        }
        this.resolveTheme();
        this._ro = new ResizeObserver(() => { if (this.chart) this.chart.resize(); });
        this._ro.observe(this.chartEl);
        try {
            this.syncTabs();
            this.render();
        } catch (e) {
            this.chartEl.setText("首屏渲染失败：" + (e && e.message ? e.message : e));
        }
    }

    copyText(txt, ok) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(txt).then(ok, () => this.copyTextFallback(txt, ok));
        } else this.copyTextFallback(txt, ok);
    }
    copyTextFallback(txt, ok) {
        try {
            const ta = document.createElement("textarea");
            ta.value = txt;
            ta.style.position = "fixed";
            ta.style.opacity = "0";
            document.body.appendChild(ta);
            ta.select();
            document.execCommand("copy");
            document.body.removeChild(ta);
            ok();
        } catch (e) { /* 复制失败时静默 */ }
    }

    async onClose() {
        if (this._ro) this._ro.disconnect();
        if (this.chart) { this.chart.dispose(); this.chart = null; }
        this.contentEl.empty();
    }

    async rescan() {
        /* 读取技能提炼的数据：AI 定级 / 方向修正 / 标签规范表（未安装时静默降级） */
        const linkage = { refined: [], canonical: new Map(), ignore: new Set() };
        try {
            const raw = await this.app.vault.adapter.read(".obsidian/plugins/00_xyblue135-skill-miner/data.json");
            const j = JSON.parse(raw);
            if (j && j.data && Array.isArray(j.data.refined)) linkage.refined = j.data.refined;
            const st = j && j.settings ? j.settings : {};
            String(st.tagCanonicalList || "").split("\n").map((x) => x.trim()).filter(Boolean)
                .forEach((t) => linkage.canonical.set(t.toLowerCase(), t));
            String(st.ignoreTags || "").split("\n").map((x) => x.trim().toLowerCase()).filter(Boolean)
                .forEach((t) => linkage.ignore.add(t));
        } catch (e) { /* 技能提炼未安装或未运行过时无联动数据 */ }
        this.data = buildData(this.app, this.plugin.settings, linkage);
        const s = this.data.stats;
        this.chipsEl.innerHTML =
            '<span class="xy-nav-chip">' + esc(this.data.rootLabel) + '</span>' +
            '<span class="xy-nav-chip">文章 ' + s.all + '</span>' +
            '<span class="xy-nav-chip">总 Token ' + fmtWan(s.tok) + '</span>' +
            '<span class="xy-nav-chip">未完成 ' + s.todo + '</span>' +
            '<span class="xy-nav-chip">部分过时 ' + s.stale + '</span>' +
            '<span class="xy-nav-chip">技能簇 ' + this.data.skill.clusters.length + '</span>';
    }

    syncTabs() {
        for (const id of Object.keys(this.tabBtns)) {
            this.tabBtns[id].toggleClass("is-active", id === this.curView);
        }
        this.captionEl.setText(this.CAPTIONS[this.curView]);
        this.layoutBtn.style.display = this.curView === "skill" ? "" : "none";
    }

    ensureEcharts() {
        if (window.echarts) return Promise.resolve();
        if (this._echartsPromise) return this._echartsPromise;
        this._echartsPromise = new Promise((resolve, reject) => {
            const script = document.createElement("script");
            script.src = this.app.vault.adapter.getResourcePath(this.plugin.manifest.dir + "/lib/echarts.min.js");
            script.onload = () => resolve();
            script.onerror = () => reject(new Error("lib/echarts.min.js 加载失败"));
            document.head.appendChild(script);
        });
        return this._echartsPromise;
    }

    resolveTheme() {
        const cs = getComputedStyle(document.body);
        const v = (n) => cs.getPropertyValue(n).trim();
        this.TH = {
            fg: v("--text-normal"), mutedFg: v("--text-muted"),
            border: v("--background-modifier-border"), card: v("--background-primary"),
            pop: v("--background-secondary"), s1: v("--interactive-accent"),
        };
    }

    /* ---------- 树构建与过滤 ---------- */
    noteMatch(m, q) {
        if (!q) return true;
        const nm = String(m.name == null ? "" : m.name).toLowerCase();
        if (nm.indexOf(q) >= 0) return true;
        if (m.ti && m.ti.toLowerCase().indexOf(q) >= 0) return true;
        for (const tg of m.t) if (tg.toLowerCase().indexOf(q) >= 0) return true;
        return false;
    }
    filterTN(node, q) {
        if (!node.children) return this.noteMatch(node, q) ? node : null;
        const kept = [];
        for (const c of node.children) {
            const fc = this.filterTN(c, q);
            if (fc) kept.push(fc);
        }
        if (!kept.length) return null;
        const o = {}; for (const k of Object.keys(node)) if (k !== "children") o[k] = node[k];
        o.children = kept;
        return o;
    }
    treeForView(q) {
        if (!q) return this.data.full;
        const f = this.filterTN(this.data.full, q);
        return f || { name: "（无匹配）", p: "", _n: 0, _t: 0, _d: 0 };
    }
    paint(node) {
        if (node.children) {
            node.itemStyle = { color: depthColorAlpha(node._d, 0.45), borderColor: this.TH.card, borderWidth: 1 };
            node.children.forEach((c) => this.paint(c));
        } else {
            const undone = String(node.s).indexOf("undone") >= 0;
            node.itemStyle = {
                color: depthColor(node.d || 0),
                opacity: undone ? 0.38 : 0.95,
                borderColor: this.TH.card, borderWidth: 1,
            };
        }
        return node;
    }
    leafLabel(n) { return n == null ? "" : (n.length > 30 ? n.slice(0, 29) + "…" : n); }

    /* ---------- 提示与样式 ---------- */
    badges(d) {
        let h = "";
        for (const x of [d.s, d.vi, d.f]) if (x) h += '<span class="xy-nav-badge">' + esc(x) + "</span>";
        return h;
    }
    fmtTip(p) {
        const d = p.data || {};
        if (d.isTag) {
            const notes = this.data.tagNotes[d.name] || [];
            return "<b>" + esc(d.name) + "</b> · " + notes.length + " 篇";
        }
        if (d.isSkillRoot) {
            return "<b>技能树</b> · " + d._n + " 篇 done · " + d._m + " 个技能簇";
        }
        if (d.isSkillTrack) {
            return "<b>" + esc(d.name) + "</b> · " + d._m + " 簇 · " + d._n + " 篇";
        }
        if (d.isMore) {
            return "点击查看簇详情";
        }
        if (d.isSkillCluster) {
            const face = LEVEL_FACE[d._lv] || "";
            let h = "<b>" + (face ? face + " " : "") + esc(d.name) + "</b> · " + d._cnt + " 篇 · 均深 " + d._d;
            if (d._cat) h += " · " + esc(d._cat);
            if (d._resume) h += '<br><span style="opacity:.75">' + esc(d._resume) + "</span>";
            return h;
        }
        if (d.children) {
            return "<b>" + esc(d.name) + "</b><br>" + d._n + " 篇 · " + fmtWan(d._t) + " tokens · 平均深度 " + d._d +
                '<br><span style="opacity:.7">' + esc(d.p) + "</span>";
        }
        let h = "<b>" + esc(d.ti || d.name) + "</b><br>" +
            "深度 " + (d.d == null ? "—" : d.d) + " · " + (d.v || 0) + " tokens · 更新 " + fmtDate(d.u) + "<br>" + this.badges(d);
        if (d.t && d.t.length) h += "<br>标签: " + esc(d.t.slice(0, 6).join(" / "));
        if (d.sm) h += '<br><span style="opacity:.75">' + esc(d.sm.length > 140 ? d.sm.slice(0, 139) + "…" : d.sm) + "</span>";
        h += '<br><span style="opacity:.6">' + esc(d.p) + "</span>";
        return h;
    }
    tipStyle() {
        return {
            confine: true, backgroundColor: this.TH.pop, borderWidth: 1,
            borderColor: this.TH.border, padding: [8, 10],
            textStyle: { color: this.TH.fg, fontSize: 12 },
            extraCssText: "max-width:420px;white-space:normal;box-shadow:none;",
        };
    }

    /* ---------- 四种视图 ---------- */
    treeOption(q) {
        const data = this.paint(JSON.parse(JSON.stringify(this.treeForView(q))));
        const TH = this.TH;
        return {
            tooltip: Object.assign({}, this.tipStyle(), { formatter: (p) => this.fmtTip(p) }),
            textStyle: { color: TH.fg },
            series: [{
                type: "tree", data: [data], orient: "LR", roam: true,
                top: 8, bottom: 8, left: 24, right: 220,
                symbol: "circle",
                symbolSize: (val, params) => {
                    const d = params.data;
                    if (d.children) return 9;
                    return Math.min(20, 4 + Math.sqrt(d.value || 0) / 3);
                },
                expandAndCollapse: !q,
                initialTreeDepth: q ? -1 : 2,
                lineStyle: { color: TH.border, width: 1 },
                label: {
                    position: "right", distance: 4, fontSize: 11, color: TH.fg,
                    formatter: (p) => {
                        const d = p.data;
                        if (d.children) return d.name + " · " + d._n;
                        return this.leafLabel(d.name);
                    },
                },
                leaves: { label: { position: "right", distance: 4, fontSize: 11, color: TH.mutedFg } },
                emphasis: { focus: "descendant", itemStyle: { borderWidth: 2 } },
                blur: { itemStyle: { opacity: 0.35 }, label: { opacity: 0.4 } },
                animationDuration: 350,
            }],
        };
    }
    sunOption(q) {
        const data = this.paint(JSON.parse(JSON.stringify(this.treeForView(q))));
        const TH = this.TH;
        return {
            tooltip: Object.assign({}, this.tipStyle(), { formatter: (p) => this.fmtTip(p) }),
            textStyle: { color: TH.fg },
            series: [{
                type: "sunburst", data: [data], radius: [24, "94%"], center: ["50%", "50%"],
                sort: null, roam: false,
                itemStyle: { borderColor: TH.card, borderWidth: 1 },
                label: { rotate: "radial", minAngle: 6, fontSize: 11, color: TH.fg, overflow: "truncate", width: 90 },
                emphasis: { focus: "ancestor", label: { fontSize: 12 } },
                blur: { itemStyle: { opacity: 0.4 }, label: { opacity: 0.45 } },
            }],
        };
    }
    mapOption(q) {
        const data = this.paint(JSON.parse(JSON.stringify(this.treeForView(q))));
        const TH = this.TH;
        return {
            tooltip: Object.assign({}, this.tipStyle(), { formatter: (p) => this.fmtTip(p) }),
            textStyle: { color: TH.fg },
            series: [{
                type: "treemap", data: [data], leafDepth: 2, roam: false, visibleMin: 180,
                nodeClick: "zoomToNode",
                breadcrumb: {
                    show: true, bottom: 0, height: 22,
                    itemStyle: { color: TH.pop, borderColor: TH.border, textStyle: { color: TH.fg } },
                },
                label: { fontSize: 11, color: TH.fg, overflow: "truncate", formatter: (p) => this.leafLabel(p.name) },
                upperLabel: { show: true, height: 18, fontSize: 11, color: TH.fg, overflow: "truncate" },
                itemStyle: { borderColor: TH.card, borderWidth: 1, gapWidth: 1 },
                levels: [{ itemStyle: { gapWidth: 2, borderWidth: 1 } }, { itemStyle: { gapWidth: 1 } }],
            }],
        };
    }
    tagOption(q) {
        const TH = this.TH;
        const nodes = this.data.graph.tags.map((t) => ({
            name: t.t, isTag: true, value: t.c,
            symbolSize: Math.min(46, 9 + Math.sqrt(t.c) * 3.4),
            label: { show: t.c >= 8, fontSize: 11, color: TH.fg },
            itemStyle: { color: TH.s1, opacity: 0.85 },
        }));
        const links = this.data.graph.e.map((e) => ({
            source: e.s, target: e.t, w: e.w,
            lineStyle: { width: Math.min(6, e.w), opacity: 0.3, color: TH.mutedFg },
        }));
        if (q) {
            for (const n of nodes) {
                const hit = n.name.toLowerCase().indexOf(q) >= 0;
                n.itemStyle = { color: TH.s1, opacity: hit ? 0.95 : 0.15 };
                n.label = { show: true, fontSize: 11, color: TH.fg, opacity: hit ? 1 : 0.25 };
            }
            for (const l of links) {
                const hit = l.source.toLowerCase().indexOf(q) >= 0 || l.target.toLowerCase().indexOf(q) >= 0;
                l.lineStyle.opacity = hit ? 0.5 : 0.06;
            }
        }
        return {
            tooltip: Object.assign({}, this.tipStyle(), { formatter: (p) => this.fmtTip(p) }),
            textStyle: { color: TH.fg },
            series: [{
                type: "graph", layout: "force", roam: true, draggable: true,
                data: nodes, links: links,
                force: { repulsion: 240, edgeLength: [46, 150], gravity: 0.09, friction: 0.2 },
                emphasis: { focus: "adjacency", label: { fontSize: 12 } },
                blur: { itemStyle: { opacity: 0.35 }, label: { opacity: 0.4 }, lineStyle: { opacity: 0.1 } },
                scaleLimit: { min: 0.4, max: 4 },
            }],
        };
    }

    /* ---------- 技能树视图（方向 → 技能簇 → 代表笔记） ---------- */
    skillOption(q) {
        const TH = this.TH;
        let clusters = this.data.skill.clusters;
        if (q) {
            clusters = clusters.filter((c) =>
                mergeKeyOf(c.name).indexOf(mergeKeyOf(q)) >= 0 ||
                c.docs.some((d) => this.noteMatch({ name: d.ti, ti: d.ti, t: d.t }, q)));
        }
        const trackMap = new Map();
        for (const c of clusters) {
            let t = trackMap.get(c.track);
            if (!t) {
                t = { name: c.track, clusters: [], count: 0 };
                trackMap.set(c.track, t);
            }
            t.clusters.push(c);
            t.count += c.count;
        }
        const tracks = [...trackMap.values()].sort((a, b) => b.count - a.count);
        const TOP_DOCS = 6;
        const root = {
            name: "技能树", isSkillRoot: true, _n: this.data.skill.doneDocs, _m: clusters.length,
            itemStyle: { color: TH.mutedFg },
            children: tracks.map((t) => ({
                name: t.name, isSkillTrack: true, _n: t.count, _m: t.clusters.length,
                itemStyle: { color: trackColor(t.name) },
                children: t.clusters.map((c) => {
                    const matched = q ? c.docs.filter((d) => this.noteMatch({ name: d.ti, ti: d.ti, t: d.t }, q)) : null;
                    const shown = (matched && matched.length ? matched : c.docs).slice(0, TOP_DOCS);
                    const kids = shown.map((d) => ({
                        name: d.ti || d.p.split("/").pop().replace(/\.md$/, ""),
                        p: d.p, ti: d.ti, d: d.d, v: d.v, t: d.t,
                        itemStyle: { color: depthColor(d.d || 0) },
                    }));
                    const rest = c.docs.length - shown.length;
                    if (rest > 0) {
                        kids.push({
                            name: "…还有 " + rest + " 篇", isMore: true, ref: c.name,
                            itemStyle: { color: TH.border },
                        });
                    }
                    return {
                        name: c.name, isSkillCluster: true, track: c.track, raw: c,
                        _cnt: c.count, _d: c.avgDepth, _lv: c.level || "", _cat: c.category || "",
                        _resume: c.resumeLine || "", _sum: c.summary || "", _last: c.last,
                        value: c.count,
                        itemStyle: { color: trackColor(c.track), opacity: 0.62 },
                        children: kids,
                    };
                }),
            })),
        };
        const radial = !!this.plugin.settings.skillRadial;
        const labelFormatter = (p) => {
            const d = p.data;
            if (d.isSkillRoot) return "技能树 · " + d._n + " 篇 done · " + d._m + " 簇";
            if (d.isSkillTrack) return d.name + " · " + d._m + " 簇 · " + d._n + " 篇";
            if (d.isSkillCluster) {
                const face = LEVEL_FACE[d._lv] || "";
                return (face ? face + " " : "") + d.name + " · " + d._cnt + " 篇 · 均深 " + d._d;
            }
            return this.leafLabel(d.name);
        };
        const series = {
            type: "tree", data: [root],
            layout: radial ? "radial" : "LR",
            roam: true,
            top: radial ? 30 : 8, bottom: radial ? 30 : 8, left: radial ? 60 : 24, right: radial ? 60 : 260,
            symbol: "circle",
            symbolSize: (val, params) => {
                const d = params.data;
                if (d.isSkillRoot) return 12;
                if (d.isSkillTrack) return 11;
                if (d.isSkillCluster) return Math.min(18, 6 + Math.sqrt(d._cnt || 1) * 1.5);
                if (d.isMore) return 5;
                return Math.min(14, 4 + Math.sqrt(d.value || 0) / 3.5);
            },
            expandAndCollapse: !q,
            initialTreeDepth: q ? -1 : 1,
            lineStyle: { color: TH.border, width: 1 },
            label: radial
                ? { fontSize: 11, color: TH.fg, formatter: labelFormatter }
                : { position: "right", distance: 4, fontSize: 11, color: TH.fg, formatter: labelFormatter },
            leaves: {
                label: radial
                    ? { fontSize: 11, color: TH.mutedFg }
                    : { position: "right", distance: 4, fontSize: 11, color: TH.mutedFg },
            },
            emphasis: { focus: "descendant", itemStyle: { borderWidth: 2 } },
            /* 悬停时只轻微压暗其余节点，避免大面积消失看不清上下文 */
            blur: { itemStyle: { opacity: 0.35 }, label: { opacity: 0.4 } },
            animationDuration: 350,
        };
        if (!radial) series.orient = "LR";
        return {
            tooltip: Object.assign({}, this.tipStyle(), { formatter: (p) => this.fmtTip(p) }),
            textStyle: { color: TH.fg },
            series: [series],
        };
    }

    render() {
        if (!this.chart || !this.data) return;
        const q = this.q;
        let opt;
        if (this.curView === "skill") opt = this.skillOption(q);
        else if (this.curView === "tree") opt = this.treeOption(q);
        else if (this.curView === "sun") opt = this.sunOption(q);
        else if (this.curView === "map") opt = this.mapOption(q);
        else opt = this.tagOption(q);
        this.chart.setOption(opt, { notMerge: true });
        this.captionEl.setText(this.CAPTIONS[this.curView]);
    }

    /* ---------- 详情面板 ---------- */
    noteHtml(d) {
        let h = '<div class="xy-nav-detail-head">';
        h += '<div class="xy-nav-detail-main">';
        h += '<div class="xy-nav-detail-title">' + esc(d.ti || d.name) + "</div>";
        h += '<div class="xy-nav-detail-path"><code>' + esc(d.p) + "</code></div>";
        h += '<div class="xy-nav-detail-row">' + this.badges(d) +
            '<span class="xy-nav-badge">深度 ' + (d.d == null ? "—" : d.d) + "</span>" +
            '<span class="xy-nav-badge">' + (d.v || 0) + " tokens</span>" +
            '<span class="xy-nav-badge">更新 ' + fmtDate(d.u) + "</span></div>";
        if (d.t && d.t.length)
            h += '<div class="xy-nav-detail-row">' + d.t.map((t) => '<span class="xy-nav-badge">' + esc(t) + "</span>").join("") + "</div>";
        if (d.sm) h += '<div class="xy-nav-detail-sm">' + esc(d.sm) + "</div>";
        h += "</div>";
        h += '<div class="xy-nav-detail-actions">' +
            '<button type="button" class="xy-nav-btn" data-open="' + esc(d.p) + '">打开笔记</button>' +
            '<button type="button" class="xy-nav-btn xy-nav-btn-ghost" data-copy="' + esc(d.p) + '">复制路径</button>' +
            "</div></div>";
        return h;
    }
    folderHtml(d) {
        return '<div class="xy-nav-detail-title">📁 ' + esc(d.name) + "</div>" +
            '<div class="xy-nav-detail-path"><code>' + esc(d.p) + "</code></div>" +
            '<div class="xy-nav-detail-row">' +
            '<span class="xy-nav-badge">' + d._n + " 篇</span>" +
            '<span class="xy-nav-badge">' + fmtWan(d._t) + " tokens</span>" +
            '<span class="xy-nav-badge">平均深度 ' + d._d + "</span></div>";
    }
    tagHtml(name) {
        const notes = this.data.tagNotes[name] || [];
        let h = '<div class="xy-nav-detail-title">🏷 ' + esc(name) + " · " + notes.length + " 篇</div>";
        h += '<div class="xy-nav-detail-path">点击笔记名直接打开：</div>';
        for (const n of notes.slice(0, 8)) {
            h += '<div class="xy-nav-noterow"><a class="xy-nav-link" role="button" data-open="' + esc(n.p) + '">' + esc(n.ti || n.n) + "</a>" +
                '<span class="xy-nav-notehint">深度 ' + (n.d == null ? "—" : n.d) + " · " + (n.v || 0) + " tk</span></div>";
        }
        return h;
    }
    clusterHtml(c) {
        const face = LEVEL_FACE[c.level] || "";
        let h = '<div class="xy-nav-detail-title">' + (face ? face + " " : "") + esc(c.name) + " · " + c.count + " 篇</div>";
        h += '<div class="xy-nav-detail-row">' +
            '<span class="xy-nav-badge">方向：' + esc(c.track) + "</span>" +
            (c.category ? '<span class="xy-nav-badge">' + esc(c.category) + "</span>" : "") +
            '<span class="xy-nav-badge">均深 ' + c.avgDepth + "</span>" +
            '<span class="xy-nav-badge">最近更新 ' + fmtDate(c.last) + "</span></div>";
        if (c.resumeLine) h += '<div class="xy-nav-detail-sm"><b>简历句：</b>' + esc(c.resumeLine) + "</div>";
        if (c.summary) h += '<div class="xy-nav-detail-sm">' + esc(c.summary) + "</div>";
        h += '<div style="margin-top:8px;"><button type="button" class="xy-nav-btn" data-cmd="00_xyblue135-skill-miner:open-skill-miner">在技能提炼中打开</button></div>';
        h += '<div class="xy-nav-detail-path" style="margin-top:8px;">代表笔记（点击直接打开）：</div>';
        for (const n of (c.docs || []).slice(0, 10)) {
            h += '<div class="xy-nav-noterow"><a class="xy-nav-link" role="button" data-open="' + esc(n.p) + '">' + esc(n.ti || n.p) + "</a>" +
                '<span class="xy-nav-notehint">深度 ' + (n.d == null ? "—" : n.d) + "</span></div>";
        }
        return h;
    }
    trackHtml(t) {
        let h = '<div class="xy-nav-detail-title">方向：' + esc(t.name) + " · " + t.clusters.length + " 簇 · " + t.count + " 篇</div>";
        h += '<div class="xy-nav-detail-path">技能簇：</div>';
        for (const c of t.clusters.slice(0, 16)) {
            const face = LEVEL_FACE[c.level] || "";
            h += '<div class="xy-nav-noterow"><span>' + (face ? face + " " : "") + esc(c.name) + "</span>" +
                '<span class="xy-nav-notehint">' + c.count + " 篇 · 均深 " + c.avgDepth + "</span></div>";
        }
        return h;
    }
    showDetail(d) {
        if (!d) { this.detailEl.innerHTML = '<span class="xy-nav-hint">点击图中任意节点查看详情并打开笔记。</span>'; return; }
        if (d.isSkillRoot) {
            const sk = this.data.skill;
            const tracks = new Set(sk.clusters.map((c) => c.track));
            this.detailEl.innerHTML =
                '<div class="xy-nav-detail-title">📊 技能树总览</div>' +
                '<div class="xy-nav-detail-row">' +
                '<span class="xy-nav-badge">' + sk.doneDocs + " 篇 done</span>" +
                '<span class="xy-nav-badge">' + sk.clusters.length + " 个技能簇</span>" +
                '<span class="xy-nav-badge">' + tracks.size + " 个方向</span></div>" +
                '<div class="xy-nav-detail-sm">与「技能提炼」同口径聚合（标签 → 簇，≥' + this.plugin.settings.minDocsPerSkill + ' 篇成簇）。点击方向分支展开技能簇，点击簇查看定级与代表笔记。</div>';
        } else if (d.isTag) this.detailEl.innerHTML = this.tagHtml(d.name);
        else if (d.isSkillCluster) {
            const c = d.raw || {
                name: d.name, count: d._cnt, avgDepth: d._d, track: d.track,
                category: d._cat, level: d._lv, resumeLine: d._resume, summary: d._sum, last: d._last, docs: [],
            };
            this.detailEl.innerHTML = this.clusterHtml(c);
        } else if (d.isMore) {
            const c = this.data.skill.clusters.find((x) => x.name === d.ref);
            this.detailEl.innerHTML = c ? this.clusterHtml(c) : '<span class="xy-nav-hint">簇不存在，请重新扫描。</span>';
        } else if (d.isSkillTrack) {
            const clusters = (d.children || []).filter((x) => x.isSkillCluster).map((x) => x.raw).filter(Boolean);
            this.detailEl.innerHTML = this.trackHtml({ name: d.name, clusters: clusters, count: d._n });
        } else if (d.children) this.detailEl.innerHTML = this.folderHtml(d);
        else this.detailEl.innerHTML = this.noteHtml(d);
    }
}

/* ---------------- 设置页 ---------------- */
class DocsNavSettingTab extends obsidian_1.PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }
    display() {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl("h2", { text: "知识库导航 · 设置" });
        new obsidian_1.Setting(containerEl)
            .setName("白名单目录")
            .setDesc("只扫描该目录下的 Markdown 笔记（默认 00_docs）")
            .addText((t) => t.setValue(this.plugin.settings.rootFolder).onChange(async (v) => {
                this.plugin.settings.rootFolder = v.trim() || "00_docs";
                await this.plugin.saveSettings();
            }));
        new obsidian_1.Setting(containerEl)
            .setName("技能树 · 成簇阈值")
            .setDesc("一个标签至少出现在多少篇 done 笔记里才算技能簇（1–10，默认 3，与技能提炼的「每技能最少文章数」一致）")
            .addSlider((s) => s.setLimits(1, 10, 1).setValue(this.plugin.settings.minDocsPerSkill).setDynamicTooltip()
                .onChange(async (v) => { this.plugin.settings.minDocsPerSkill = v; await this.plugin.saveSettings(); }));
        new obsidian_1.Setting(containerEl)
            .setName("标签星图 · 标签数量上限")
            .setDesc("按出现篇数取前 N 个标签（20–120，默认 60）")
            .addSlider((s) => s.setLimits(20, 120, 5).setValue(this.plugin.settings.topTags).setDynamicTooltip()
                .onChange(async (v) => { this.plugin.settings.topTags = v; await this.plugin.saveSettings(); }));
        new obsidian_1.Setting(containerEl)
            .setName("标签星图 · 共现阈值")
            .setDesc("两个标签至少在同一篇笔记共现多少次才画连线（1–5，默认 2）")
            .addSlider((s) => s.setLimits(1, 5, 1).setValue(this.plugin.settings.cooccurMin).setDynamicTooltip()
                .onChange(async (v) => { this.plugin.settings.cooccurMin = v; await this.plugin.saveSettings(); }));
    }
}

/* ---------------- 插件入口 ---------------- */
class DocsNavPlugin extends obsidian_1.Plugin {
    async onload() {
        await this.loadSettings();
        this.registerView(VIEW_TYPE, (leaf) => new NavView(leaf, this));
        const ribbonEl = this.addRibbonIcon("git-fork", "知识库导航图", () => this.activateView());
        ribbonEl.addClass("xyblue135-ribbon xyblue135-ai");
        this.addCommand({ id: "open", name: "打开知识库导航图", callback: () => this.activateView() });
        this.addSettingTab(new DocsNavSettingTab(this.app, this));
    }
    onunload() { }
    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }
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

module.exports = DocsNavPlugin;
