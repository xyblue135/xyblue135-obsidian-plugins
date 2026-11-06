'use strict';

/*
 * xyblue135 · 面试检索 (00_xyblue135-interview-rag)
 *
 * 专为面试场景设计的本地知识库即时检索插件：
 *   OBS 转写 → bridge.py 组句 → rag\query.json → 本插件监听并检索知识库
 *   → 要点式回答 → rag\answer.json → bridge 读到后上悬浮卡。
 *
 * 检索为纯本地加权召回（标题/标签/摘要/正文分词评分），零 API、毫秒级出结果；
 * 可选 AI 精答（OpenAI 兼容网关在线时），失败自动降级本地要点，绝不静默超时；
 * 直答模式（spokenEnabled）：AI 以第一人称口语代替候选人回答，照着说即可。
 * 桥接契约见 D:\obs-interview\交接-RAG握手对接.md：
 *   query.json  = {"id": <毫秒时间戳int>, "question": "..."}
 *   answer.json = {"id": <同id>, "answer": "...", "sources": [{"path","title"}]}
 *              或 {"id": <同id>, "error": "..."}
 *   读取/写入均要求原子性（tmp + rename），UTF-8 无 BOM。
 */

const {
  Plugin, Modal, PluginSettingTab, Setting, Notice, TFile, normalizePath,
} = require('obsidian');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

/* ============================ 常量与默认配置 ============================ */

const DEFAULT_AI_PROMPT = [
  '角色：面试实时知识库助手。',
  '任务：面试官刚提出一个问题，根据提供的知识库资料，给出可以立即口头使用的回答。',
  '要求：',
  '1. 只依据资料，禁止编造；资料不足时明确说明“资料中未找到相关内容”；',
  '2. 中文，3-5 条要点，每条一行，重点先行，总共不超过 300 字；',
  '3. 纯文本输出：不要 Markdown 标记、不要标题符号、不要 [n] 引用编号。',
].join('\n');

/**
 * 「AI 协助」模式下追加在用户提示词后面的补充规则。
 * 动机：本地召回是按字面加权，问「redis 故障怎么处理」常常只召回同名笔记（内容是安装/命令），
 * 严格「只用资料」等于逼模型答非所问或干脆弃答。面试场景宁可给通用工程要点，也要标注来源性质。
 */
const AI_ASSIST_HINT = [
  '补充规则（下面的召回资料可能只与问题字面相关）：',
  '1. 资料里有相关的事实、命令或项目经历就优先用，并说清依据哪件事；',
  '2. 资料与问题无关就整段忽略，不要硬套里面的命令、参数或结论；',
  '3. 问题问「你做过什么 / 用过哪些 / 有哪些经验」时，先从资料里找具体项目实例，用第一人称讲；',
  '4. 资料确实覆盖不到，就直接用通用工程经验回答，宁可给通用要点也不要拒答；',
  '5. 不要写「资料中未找到相关内容」这类开场说明；确实主要靠通用经验时，只在第一行写一次「（资料未覆盖，以下为通用经验）」，不要重复解释。',
].join('\n');

/**
 * 直答模式的系统提示词：让 AI 以第一人称口语代替候选人回答，
 * 悬浮卡上直接是「能照着说的话」，而不是要点列表。
 */
const DEFAULT_SPOKEN_PROMPT = [
  '角色：你就是正在面试的候选人本人，第一人称作答。',
  '任务：面试官刚向你提了一个问题，直接用你自己的口吻回答，让用户可以照着说。',
  '要求：',
  '1. 像真人说话：自然连贯的口语，允许「其实」「简单来说」这类口头语；',
  '2. 禁止分点列表和「首先/其次」式书面结构，禁止 Markdown 符号、禁止 [n] 引用编号；',
  '3. 资料里的事实、命令、项目经历自然融进回答；资料没覆盖的细节不要编造具体数字，用工程常识圆过去；',
  '4. 先给结论再展开，总共 3~5 句、150 字以内，像 30~45 秒的口头回答；',
  '5. 说完自然收住，不要「以上就是我的回答」这类套话。',
].join('\n');

/**
 * 疑问/礼貌类词：对召回没有区分度，却会把「怎么处理」「如何配置」这类无关文档顶上来。
 * 只用于查询侧过滤，不影响建索引时的分词（正文该有的词一个都不能少）。
 */
const QUERY_STOPWORDS = [
  '怎么', '怎样', '如何', '为什', '什么', '哪些', '哪个', '是否', '能否', '可否',
  '请问', '介绍', '一下', '说说', '讲讲', '谈谈', '区别', '以及', '可以', '需要',
  '我们', '你们', '这个', '那个', '就是', '然后', '还有', '那么', '做过',
  '处理', '简单', '一般', '具体', '详细',
];

const DEFAULT_SETTINGS = {
  // ---- 监听与桥接（ragfile）----
  bridgeEnabled: true,
  ragDir: 'D:\\obs-interview\\rag',
  pollMs: 300,               // 轮询 query.json 的间隔（fs.watch 同时在跑，轮询是兜底）
  answerDeadlineMs: 12000,   // 从读到请求到必须写应答的兜底时限（bridge 超时 15s，留余量）

  // ---- 检索与索引 ----
  autoIndexOnStartup: true,
  whitelistFolder: '00_docs,00_agent_for_projects',  // 逗号/换行分隔多个目录
  includeSubfolders: true,
  recallLimit: 50,           // 评分后保留的候选上限
  maxSources: 4,             // 回答/来源里带的笔记条数
  minScore: 6,               // 低于该分的候选不进回答（0 = 不过滤）

  // ---- 评分权重精调 ----
  wStrong: 6,                // 标题/标签/AI摘要 命中权重
  wBody: 1,                  // 正文命中权重
  phraseBonusStrong: 25,     // 整句问题出现在标题/摘要区的加分
  phraseBonusBody: 12,       // 整句问题出现在正文的加分
  hotwordBoost: 8,           // 每命中一个热词的加分（热词=面试领域词，用于抬高相关笔记）

  // ---- 热词 ----
  hotwordsFile: 'D:\\obs-interview\\hotwords.txt',   // 与 bridge 共用，# 开头为注释

  // ---- 回答组装（本地要点）----
  snippetRadius: 60,         // 摘要在命中词附近截取的半径（字符）
  answerTitle: '知识库要点',  // 回答首行前缀，留空则不加
  maxAnswerChars: 600,       // 回答总长上限（悬浮卡 520px 宽，太长看不完）
  showSourcePaths: false,    // 回答正文里是否附笔记路径（来源列表已单独给 bridge）

  // ---- 问题清洗 ----
  minQuestionChars: 4,       // 去除首尾空白后短于该字数的问题直接回错误应答
  noiseRegex: '',            // 多行正则，逐行匹配；命中的问题视为转写噪声，回错误应答

  // ---- AI 精答 / 协助（网关不在线时自动降级本地要点，绝不拖慢应答）----
  aiEnabled: true,
  baseUrl: 'http://127.0.0.1:31415/v1',
  apiKey: '',
  model: 'auto',
  aiTimeoutMs: 10000,        // AI 单次请求超时；须小于 answerDeadlineMs（bridge 侧 15s）
  aiMaxTokens: 0,            // 输出 token 上限，0 = 不限制（默认）。实测调小会让 deepseek 系把思考过程当正文吐出来、
                             //   答案被截成半句，比慢更糟。真要提速请换模型（见「模型」一项的实测表）
  aiContextDocs: 5,          // 喂给 AI 的笔记条数（实测 3 条与 5 条延迟无差别，别再往下砍，砍了只丢引用）
  aiContextCharsPerDoc: 1000, // 单篇喂给 AI 的字符上限（同样不影响耗时，input 便宜、output 贵）
  aiAssist: true,            // 资料弱相关时允许 AI 用通用工程经验补答（关掉即严格「只用资料」）
  aiFallbackLocal: true,     // AI 失败时是否降级为本地要点（false 则直接回错误应答）
  aiSystemPrompt: DEFAULT_AI_PROMPT,

  // ---- 直答模式（代替我回答：第一人称口语，需网关在线）----
  spokenEnabled: false,      // 开启后：直答 →（失败）AI 精答 →（失败）本地要点，逐级降级不静默
  spokenSystemPrompt: DEFAULT_SPOKEN_PROMPT,

  // ---- 界面 ----
  statusBarEnabled: true,
};

const INDEX_VERSION = 1;
const SECTION_MAX_CHARS = 20000;

/* ============================ 通用工具 ============================ */

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/** 分词：英文/数字按词，中日文按二元组；全部小写。 */
function tokenize(text) {
  const s = String(text || '').toLowerCase();
  const terms = [];
  const ascii = s.match(/[a-z0-9_+#.\-]{2,}/g) || [];
  for (const w of ascii) terms.push(w);
  const runs = s.match(/[\u4e00-\u9fff\u3040-\u30ff]{2,}/g) || [];
  for (const run of runs) {
    if (run.length <= 4) terms.push(run);
    for (let i = 0; i < run.length - 1; i++) terms.push(run.slice(i, i + 2));
  }
  return terms;
}

/**
 * 查询侧分词：先把疑问/礼貌词从原串里「挖掉」再切二元组。
 * 动机：直接 tokenize 会把「故障怎么处理」切成 故障/障怎/怎么/么处/处理，
 * 其中「障怎」「么处」这类跨词碎片 df 极低、idf 反而最高，最容易把无关笔记顶上来；
 * 而「怎么/处理」本身没有区分度，会把「怎么配置」类文章全部拉进来。
 * 兜底：过滤后一个词都不剩就退回原始分词，避免短问题直接查空。
 */
function queryTerms(text) {
  const s = String(text || '').toLowerCase();
  const out = [];
  const push = (t) => { if (t && !out.includes(t)) out.push(t); };
  for (const w of s.match(/[a-z0-9_+#.\-]{2,}/g) || []) push(w);
  let masked = s;
  for (const w of QUERY_STOPWORDS) {
    if (masked.includes(w)) masked = masked.split(w).join('\n');
  }
  for (const run of masked.match(/[\u4e00-\u9fff\u3040-\u30ff]{2,}/g) || []) {
    if (run.length <= 4) push(run);
    for (let i = 0; i < run.length - 1; i++) push(run.slice(i, i + 2));
  }
  return out.length ? out : tokenize(text);
}

function countOccurrences(hay, needle) {
  if (!hay || !needle) return 0;
  let n = 0;
  let i = hay.indexOf(needle);
  while (i >= 0) {
    n++;
    i = hay.indexOf(needle, i + needle.length);
  }
  return n;
}

/** FNV-1a 32 位哈希，用于文件内容变更检测。 */
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** 摘要净化：链接只留文字、去掉表格/代码/加粗符号，悬浮卡纯文本可读。 */
function sanitizeSnippet(t) {
  return String(t)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[|`*_>#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 在段落中围绕首个命中词取一段摘要。 */
function makeSnippet(section, terms, radius) {
  radius = radius || 60;
  if (!section || !section.t) return '';
  const t = sanitizeSnippet(section.t);
  const tl = t.toLowerCase();
  let pos = -1;
  for (const term of terms || []) {
    const i = tl.indexOf(term);
    if (i >= 0 && (pos < 0 || i < pos)) pos = i;
  }
  if (pos < 0) pos = 0;
  const start = Math.max(0, pos - radius);
  return t.slice(start, start + radius * 2).trim();
}

function toStr(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return '';
}

function toList(v) {
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (typeof v === 'string' && v.trim()) return [v.trim()];
  return [];
}

function normalizeTags(fm) {
  const raw = [].concat(toList(fm && fm.AI_tags), toList(fm && fm.tags));
  const out = [];
  const seen = new Set();
  for (let t of raw) {
    t = t.trim().replace(/^#/, '');
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
    if (out.length >= 10) break;
  }
  return out;
}

/** metadataCache 不可用时的极简 frontmatter 解析（只取标量与列表）。 */
function parseFrontmatterFallback(content) {
  const lines = content.split(/\r?\n/);
  if (!lines.length || lines[0].trim() !== '---') return { fm: null, bodyStart: 0 };
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { end = i; break; }
  }
  if (end < 0) return { fm: null, bodyStart: 0 };
  const fm = {};
  let cur = null;
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    const kv = line.match(/^([A-Za-z0-9_\-]+):\s*(.*)$/);
    if (kv && !/^\s/.test(line)) {
      cur = kv[1];
      let v = kv[2].trim();
      if (v === '') {
        fm[cur] = [];
      } else if (v.startsWith('[') && v.endsWith(']')) {
        fm[cur] = v.slice(1, -1).split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
      } else {
        fm[cur] = v.replace(/^["']|["']$/g, '');
      }
      continue;
    }
    const li = line.match(/^\s+-\s*(.*)$/);
    if (li && cur) {
      const v = li[1].trim().replace(/^["']|["']$/g, '');
      if (!Array.isArray(fm[cur])) fm[cur] = [];
      if (v) fm[cur].push(v);
    }
  }
  return { fm, bodyStart: end + 1 };
}

function safeRegExp(src) {
  try { return new RegExp(src); } catch (e) {
    console.warn('[面试检索] 无效正则，已跳过:', src);
    return null;
  }
}

/* ============================ 本地召回索引 ============================ */

function recomputeDerived(doc) {
  doc.strongText = [
    doc.title || '',
    toList(doc.aiTitles).join(' '),
    (doc.tags || []).join(' '),
    doc.summaryShort || '',
    doc.summaryLong || '',
  ].join('\n');
  doc.bodyText = (doc.sections || []).map((s) => s.t).join('\n');
  // 小写副本随文档缓存一次，检索时不再全库重建
  doc._lcStrong = doc.strongText.toLowerCase();
  doc._lcBody = doc.bodyText.toLowerCase();
  return doc;
}

function serializeDoc(doc) {
  return {
    path: doc.path,
    hash: doc.hash,
    title: doc.title,
    tags: doc.tags,
    aiTitles: doc.aiTitles,
    summaryShort: doc.summaryShort,
    summaryLong: doc.summaryLong,
    maxDepth: doc.maxDepth || 0,
    sections: doc.sections,
    // 兜底解析标记（仅在元数据缓存未就绪时写入），下次同步时强制重解析
    fmFallback: doc.fmFallback === true ? true : undefined,
  };
}

class RecallIndex {
  constructor(plugin) {
    this.plugin = plugin;
    this.docs = new Map();
    this.status = { state: 'idle', done: 0, total: 0 };
    this._saveTimer = null;
    this._modTimer = null;
    this._modQueue = new Set();
    this._busy = false;
    this._pending = null;
    this._saving = null;
  }

  inScope(path) {
    const s = this.plugin.settings;
    const folders = String(s.whitelistFolder || '').split(/[,，\n]/)
      .map((x) => x.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))
      .filter(Boolean);
    if (!folders.length) return false;
    return folders.some((folder) => {
      if (!s.includeSubfolders) {
        return path.startsWith(folder + '/') && !path.slice(folder.length + 1).includes('/');
      }
      return path.startsWith(folder + '/');
    });
  }

  indexFilePath() {
    return normalizePath(this.plugin.manifest.dir + '/index.json');
  }

  async load() {
    try {
      const raw = await this.plugin.app.vault.adapter.read(this.indexFilePath());
      const data = JSON.parse(raw);
      if (Number(data.version) !== INDEX_VERSION
        || (data.whitelist || '') !== (this.plugin.settings.whitelistFolder || '')) {
        this.docs.clear();
        return false;
      }
      this.docs.clear();
      for (const f of data.files || []) {
        if (!f || typeof f.path !== 'string') continue;
        this.docs.set(f.path, recomputeDerived(f));
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  saveIndexDebounced() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this.saveNow().catch((e) => {
        new Notice('面试检索：索引保存失败 ' + ((e && e.message) || e), 8000);
      });
    }, 3000);
  }

  saveNow() {
    // 串行化：同一时刻只允许一次写入，后到的调用排在前一次之后
    const run = (this._saving || Promise.resolve()).then(() => this._writeSnapshot());
    this._saving = run.then(() => {}, () => {});
    return run;
  }

  async _writeSnapshot() {
    const data = {
      version: INDEX_VERSION,
      whitelist: this.plugin.settings.whitelistFolder || '',
      builtAt: Date.now(),
      files: [...this.docs.values()].map(serializeDoc),
    };
    const target = this.indexFilePath();
    const text = JSON.stringify(data);
    const adapter = this.plugin.app.vault.adapter;
    const tmp = target + '.tmp';
    // 先写临时文件再改名，避免写入中途被打断留下截断的 JSON
    await adapter.write(tmp, text);
    if (typeof adapter.rename === 'function') {
      try {
        await adapter.rename(tmp, target);
        return;
      } catch (e) {
        console.warn('面试检索：临时文件改名失败，改为直接写入 index.json', e);
      }
    }
    await adapter.write(target, text);
    try { await adapter.remove(tmp); } catch (e) { /* 临时文件清理失败可忽略 */ }
  }

  async clearCache() {
    clearTimeout(this._saveTimer);
    this.docs.clear();
    try { await this.plugin.app.vault.adapter.remove(this.indexFilePath()); } catch (e) { /* 可能不存在 */ }
    this.plugin.refreshStatusBar();
  }

  /** 扫描白名单目录，增量补齐/更新/删除文档条目。 */
  async reconcile() {
    // 已有同步在跑：复用同一个 Promise，调用方 await 到的是真实结果而不是空跑
    if (this._busy) return this._pending || { added: 0, updated: 0, total: this.docs.size };
    this._busy = true;
    this._pending = this._reconcileOnce();
    try {
      return await this._pending;
    } finally {
      this._busy = false;
      this._pending = null;
    }
  }

  async _reconcileOnce() {
    const app = this.plugin.app;
    const files = app.vault.getMarkdownFiles().filter((f) => this.inScope(f.path));
    this.status = { state: 'building', done: 0, total: files.length };
    this.plugin.refreshStatusBar();
    const keep = new Set();
    let added = 0;
    let updated = 0;
    for (const f of files) {
      keep.add(f.path);
      const existing = this.docs.get(f.path);
      // 兜底解析的条目强制重解析：等元数据缓存就绪后修正标签/AI 摘要
      let need = !existing || existing.fmFallback === true;
      let content = null;
      if (!need) {
        content = await app.vault.cachedRead(f);
        if (fnv1a(content) !== existing.hash) need = true;
      }
      if (need) {
        if (content === null) content = await app.vault.cachedRead(f);
        const doc = await this.parseDoc(f, content);
        this.docs.set(f.path, doc);
        if (existing) updated++; else added++;
      }
      this.status.done++;
      if (this.status.done % 25 === 0 || this.status.done === this.status.total) this.plugin.refreshStatusBar();
    }
    for (const p of [...this.docs.keys()]) {
      if (!keep.has(p)) this.docs.delete(p);
    }
    this.status = { state: 'ready', done: files.length, total: files.length };
    this.plugin.refreshStatusBar();
    return { added, updated, total: files.length };
  }

  async parseDoc(file, content) {
    const lines = content.split(/\r?\n/);
    let fm = null;
    let bodyStart = 0;
    let cacheReady = false;
    let fmFallback = false;
    try {
      const fc = this.plugin.app.metadataCache.getFileCache(file);
      if (fc) cacheReady = true;
      if (fc && fc.frontmatterPosition && fc.frontmatterPosition.end) {
        fm = fc.frontmatter || null;
        bodyStart = fc.frontmatterPosition.end.line + 1;
      }
    } catch (e) { /* 缓存不可用时走兜底 */ }
    if (!fm || !bodyStart) {
      const fb = parseFrontmatterFallback(content);
      if (!fm) fm = fb.fm;
      if (!bodyStart) bodyStart = fb.bodyStart;
      // 元数据缓存还没解析完 → 标记兜底，下次 reconcile 强制重解析
      const hasFmText = /^\uFEFF?---[ \t]*\r?\n/.test(content);
      fmFallback = !cacheReady || (!fm && hasFmText);
    }

    // 按标题切分章节；跟踪代码围栏，避免把代码块里的 “# 注释” 误判为标题。
    const sections = [];
    const hPath = new Array(6).fill(undefined);
    let cur = { h: '', l: bodyStart, lines: [] };
    let inFence = false;
    let fenceMark = '';
    let fenceLen = 0;
    const flush = () => {
      const t = cur.lines.join('\n').trim();
      if (t && t.length <= SECTION_MAX_CHARS) sections.push({ h: cur.h, t, l: cur.l });
      else if (t && t.length > SECTION_MAX_CHARS) sections.push({ h: cur.h, t: t.slice(0, SECTION_MAX_CHARS), l: cur.l });
    };
    for (let i = Math.min(bodyStart, lines.length); i < lines.length; i++) {
      const line = lines[i];
      const fm2 = line.match(/^\s{0,3}(`{3,}|~{3,})/);
      if (fm2) {
        const mark = fm2[1][0];
        const len = fm2[1].length;
        if (!inFence) { inFence = true; fenceMark = mark; fenceLen = len; }
        else if (mark === fenceMark && len >= fenceLen) { inFence = false; }
        cur.lines.push(line);
        continue;
      }
      if (!inFence) {
        const hm = line.match(/^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/);
        if (hm) {
          flush();
          const lvl = hm[1].length;
          for (let j = lvl - 1; j < 6; j++) hPath[j] = undefined;
          hPath[lvl - 1] = hm[2];
          cur = { h: hPath.filter(Boolean).join(' / ').slice(0, 120), l: i, lines: [] };
          continue;
        }
      }
      cur.lines.push(line);
    }
    flush();

    const doc = {
      path: file.path,
      hash: fnv1a(content),
      mtime: (file.stat && file.stat.mtime) || 0,
      title: file.basename,
      tags: normalizeTags(fm),
      aiTitles: toList(fm && fm.AI_title).slice(0, 5),
      summaryShort: toStr(fm && fm.AI_summary_short).slice(0, 400),
      summaryLong: toStr(fm && fm.AI_summary_long).slice(0, 1200),
      maxDepth: Math.max(0, Math.round(Number(fm && fm.AI_technical_depth) || 0)),
      sections,
      fmFallback: fmFallback ? true : undefined,
    };
    return recomputeDerived(doc);
  }

  async updateFile(file) {
    if (!this.inScope(file.path)) return;
    const content = await this.plugin.app.vault.cachedRead(file);
    this.docs.set(file.path, await this.parseDoc(file, content));
    this.saveIndexDebounced();
  }

  removeFile(path) {
    if (this.docs.delete(path)) this.saveIndexDebounced();
  }

  renameFile(oldPath, file) {
    const d = this.docs.get(oldPath);
    // 改名/移动后已不在白名单目录内：直接移出索引
    if (!this.inScope(file.path)) {
      if (d) { this.docs.delete(oldPath); this.saveIndexDebounced(); }
      return;
    }
    if (d) {
      this.docs.delete(oldPath);
      d.path = file.path;
      d.title = file.basename;
      recomputeDerived(d);
      this.docs.set(file.path, d);
      this.saveIndexDebounced();
    } else if (this.inScope(file.path)) {
      this.scheduleUpdate(file);
    }
  }

  scheduleUpdate(file) {
    if (this._busy) return;
    this._modQueue.add(file);
    clearTimeout(this._modTimer);
    this._modTimer = setTimeout(() => {
      const q = [...this._modQueue];
      this._modQueue.clear();
      (async () => {
        for (const f of q) {
          try { await this.updateFile(f); } catch (e) { /* 单文件失败不阻塞 */ }
        }
      })();
    }, 1500);
  }

  bestSection(doc, terms) {
    if (!doc.sections || !doc.sections.length) return null;
    let best = null;
    let bestScore = -1;
    for (const s of doc.sections) {
      const hl = (s.h || '').toLowerCase();
      const tl = s.t.toLowerCase();
      let c = 0;
      for (const t of terms) c += countOccurrences(tl, t) + 3 * countOccurrences(hl, t);
      if (c > bestScore) { bestScore = c; best = s; }
    }
    return best;
  }

  /**
   * 取与查询最相关的 k 个段落（AI 上下文用）。
   * 标题命中权重远高于正文：笔记结构乱时（首段是「挂载卷的位置」这种），
   * 只按词频挑段会把真正讲「bridge/host 网络」的段落挤掉。
   */
  topSections(doc, terms, k = 3) {
    if (!doc.sections || !doc.sections.length) return [];
    const scored = doc.sections.map((s) => {
      const hl = (s.h || '').toLowerCase();
      const tl = s.t.toLowerCase();
      let c = 0;
      for (const t of terms) c += 6 * countOccurrences(hl, t) + countOccurrences(tl, t);
      return { s, c };
    });
    scored.sort((a, b) => b.c - a.c);
    const out = [];
    for (const it of scored) {
      if (out.length >= k) break;
      if (it.c > 0) out.push(it.s);
    }
    if (!out.length) out.push(doc.sections[0]);
    return out;
  }

  /**
   * 本地加权召回：IDF 加权词频（强文本/正文权重分开可调）
   * + 整句短语加分 + 热词加分。返回 [{doc, score, hits, section}]，按分高到低。
   */
  search(query, hotwords) {
    const s = this.plugin.settings;
    const q = String(query || '').trim();
    if (!q || this.docs.size === 0) return [];
    const docsArr = [...this.docs.values()];
    const N = docsArr.length;
    const terms = queryTerms(q).slice(0, 24);
    const phrase = q.toLowerCase().replace(/\s+/g, '');

    const strongCache = docsArr.map((d) => (d._lcStrong != null ? d._lcStrong : (d.strongText || '').toLowerCase()));
    const bodyCache = docsArr.map((d) => (d._lcBody != null ? d._lcBody : (d.bodyText || '').toLowerCase()));
    const scores = new Float64Array(N);
    const hitCount = new Uint8Array(N);

    const wStrong = Number(s.wStrong) || 0;
    const wBody = Number(s.wBody) || 0;
    if (wStrong < 0 || wBody < 0) { /* 负权重无意义，按 0 处理 */ }

    for (const term of terms) {
      let df = 0;
      const cs = new Uint32Array(N);
      const cb = new Uint32Array(N);
      for (let i = 0; i < N; i++) {
        const a = countOccurrences(strongCache[i], term);
        const b = countOccurrences(bodyCache[i], term);
        cs[i] = a;
        cb[i] = b;
        if (a || b) df++;
      }
      if (!df) continue;
      // idf 封顶：极稀有词（含跨词边界碎片）原本 idf 能到 6+，会把一两篇无关笔记直接顶到第一
      const idf = Math.min(Math.log(1 + N / df), 3.5);
      const damp = df > N * 0.7 ? 0.25 : 1;   // 太常见的词降权
      for (let i = 0; i < N; i++) {
        // 词频取对数：长文（命令手册、菜谱式笔记）不再靠堆词频霸榜
        const w = Math.log1p(cs[i]) * Math.max(0, wStrong) + Math.log1p(cb[i]) * Math.max(0, wBody);
        if (w) {
          scores[i] += w * idf * damp;
          hitCount[i]++;
        }
      }
    }
    if (phrase && phrase.length >= 2) {
      const ps = Math.max(0, Number(s.phraseBonusStrong) || 0);
      const pb = Math.max(0, Number(s.phraseBonusBody) || 0);
      for (let i = 0; i < N; i++) {
        if (strongCache[i].includes(phrase)) scores[i] += ps;
        else if (bodyCache[i].includes(phrase)) scores[i] += pb;
      }
    }
    // 热词加权：命中面试领域词的笔记整体抬分
    const boost = Math.max(0, Number(s.hotwordBoost) || 0);
    const hws = (hotwords || [])
      .map((h) => String(h).toLowerCase())
      .filter((h) => h.length >= 2);
    if (boost && hws.length) {
      for (let i = 0; i < N; i++) {
        let n = 0;
        for (const hw of hws) {
          if (strongCache[i].includes(hw) || bodyCache[i].includes(hw)) n++;
        }
        if (n) scores[i] += n * boost;
      }
    }

    const minScore = Math.max(0, Number(s.minScore) || 0);
    const limit = Math.max(1, Number(s.recallLimit) || 50);
    const idx = docsArr
      .map((_, i) => i)
      .filter((i) => scores[i] > 0 && scores[i] >= minScore)
      .sort((a, b) => scores[b] - scores[a])
      .slice(0, limit);

    return idx.map((i) => {
      const doc = docsArr[i];
      return {
        doc,
        score: Math.round(scores[i]),
        hits: hitCount[i],
        section: this.bestSection(doc, terms),
      };
    });
  }
}

/* ============================ AI 客户端（可选精答用） ============================ */

class AIClient {
  constructor(plugin) {
    this.plugin = plugin;
  }

  /**
   * 非流式 chat/completions，短超时（面试等不起长响应）。
   * 网关不在线/超时/返回异常都会 reject，由调用方决定降级。
   * 429（网关多模型都被限流）会等 1.3s 重试一次——总耗时仍在 aiTimeoutMs 之内，抢回来就不必降级。
   */
  async chat(messages, opts = {}) {
    const timeoutMs = Math.max(1000, Number(opts.timeoutMs) || 10000);
    const t0 = Date.now();
    try {
      return await this.chatOnce(messages, opts, timeoutMs);
    } catch (e) {
      const msg = String((e && e.message) || '');
      const rateLimited = /429|rate.?limit/i.test(msg);
      const left = timeoutMs - (Date.now() - t0);
      if (!rateLimited || left < 3000) throw e;
      await new Promise((r) => setTimeout(r, 1300));
      return this.chatOnce(messages, opts, Math.max(1500, timeoutMs - (Date.now() - t0)));
    }
  }

  chatOnce(messages, opts = {}, timeoutMs = 10000) {
    const s = this.plugin.settings;
    return new Promise((resolve, reject) => {
      let url;
      try {
        url = new URL(String(s.baseUrl || '').replace(/\/+$/, '') + '/chat/completions');
      } catch (e) {
        reject(new Error('API 地址无效：' + s.baseUrl));
        return;
      }
      const mod = url.protocol === 'https:' ? https : http;
      const headers = { 'Content-Type': 'application/json' };
      if (s.apiKey) headers.Authorization = 'Bearer ' + s.apiKey;
      const capTokens = Number(opts.maxTokens || s.aiMaxTokens || 0);
      const payload = JSON.stringify(Object.assign({
        model: s.model || 'auto',
        messages,
        temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.2,
        stream: false,
      }, capTokens > 0 ? { max_tokens: Math.max(60, Math.round(capTokens)) } : {}));

      let settled = false;
      const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };
      const req = mod.request(url, { method: 'POST', headers, timeout: timeoutMs }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            if (res.statusCode >= 400) throw new Error('API 返回 ' + res.statusCode + '：' + String(body).slice(0, 200));
            const content = data && data.choices && data.choices[0] && data.choices[0].message
              ? data.choices[0].message.content : null;
            if (typeof content !== 'string') throw new Error('响应缺少 choices[0].message.content');
            done(resolve, content);
          } catch (e) {
            done(reject, e);
          }
        });
        res.on('error', (e) => done(reject, e));
      });
      req.on('timeout', () => req.destroy(new Error('AI 请求超时（' + Math.round(timeoutMs / 1000) + 's）')));
      req.on('error', (e) => done(reject, e));
      req.write(payload);
      req.end();
    });
  }
}

/* ============================ 回答组装 ============================ */

/**
 * 按长度裁剪但尽量切在句子/行边界：硬 slice 会把答案断在「否则 AOF 会覆盖掉要」这种半句上，
 * 悬浮卡里看着像出错。优先回退到 cap 之前的最后一个句末标点或换行，实在找不到才硬截。
 */
function smartClip(text, cap) {
  const s = String(text || '');
  if (s.length <= cap) return s;
  const head = s.slice(0, cap);
  const m = head.match(/^[\s\S]*[。！？；\n]/);
  if (m && m[0].trim().length >= Math.min(120, cap * 0.5)) return m[0].trim();
  return head.slice(0, Math.max(0, cap - 1)) + '…';
}

/**
 * 本地要点回答：前 N 条命中各出一行「【标题】命中词附近摘要」。
 * 零 API、毫秒级；悬浮卡直接可读。
 */
function buildLocalAnswer(question, hits, settings) {
  if (!hits.length) return '知识库中未找到相关内容。';
  const terms = queryTerms(question).slice(0, 12);
  const lines = [];
  const n = Math.max(1, Number(settings.maxSources) || 4);
  for (let i = 0; i < hits.length && i < n; i++) {
    const h = hits[i];
    const snip = makeSnippet(h.section, terms, settings.snippetRadius)
      || h.doc.summaryShort || (h.doc.summaryLong || '').slice(0, 120) || '';
    lines.push((i + 1) + '. 【' + h.doc.title + '】' + snip);
    if (settings.showSourcePaths) lines.push('   └ ' + h.doc.path);
  }
  let out = (settings.answerTitle ? settings.answerTitle + '：\n' : '') + lines.join('\n');
  const cap = Math.max(100, Number(settings.maxAnswerChars) || 600);
  return smartClip(out, cap);
}

/* ============================ ragfile 桥接 ============================ */

class RagBridge {
  constructor(plugin) {
    this.plugin = plugin;
    this.lastId = 0;
    this.timer = null;
    this.watcher = null;
    this.checking = false;
    this.rerun = false;
    this.stopped = true;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    const dir = this.plugin.settings.ragDir;
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* 已存在/不可建则靠后续容错 */ }
    // 开机时已存在的旧请求视为已处理：bridge 15s 就放弃了，答陈年问题没有意义
    const cur = this.readQuery();
    if (cur && Number.isFinite(cur.id)) this.lastId = cur.id;
    try {
      // persistent:false → 不阻止进程退出；监听失败也不影响轮询兜底
      this.watcher = fs.watch(dir, { persistent: false }, () => this.scheduleCheck());
    } catch (e) {
      console.warn('[面试检索] fs.watch 不可用，仅用轮询:', e.message);
      this.watcher = null;
    }
    const ms = Math.max(100, Number(this.plugin.settings.pollMs) || 300);
    this.timer = setInterval(() => this.scheduleCheck(), ms);
    this.scheduleCheck();
    console.log('[面试检索] ragfile 监听已启动:', dir);
  }

  stop() {
    this.stopped = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.watcher) {
      try { this.watcher.close(); } catch (e) { /* 忽略 */ }
      this.watcher = null;
    }
    console.log('[面试检索] ragfile 监听已停止');
  }

  queryPath() { return path.join(this.plugin.settings.ragDir, 'query.json'); }
  answerPath() { return path.join(this.plugin.settings.ragDir, 'answer.json'); }

  /** 读请求；文件缺失/读到半截 JSON 时返回 null，下个 tick 再试。 */
  readQuery() {
    try {
      return JSON.parse(fs.readFileSync(this.queryPath(), 'utf8'));
    } catch (e) {
      return null;
    }
  }

  /** 应答原子写：先写 .tmp 再改名；JSON.stringify + utf8 = UTF-8 无 BOM。 */
  writeAnswer(obj) {
    const a = this.answerPath();
    const tmp = a + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
    fs.renameSync(tmp, a);
  }

  /** 合并触发：watch 回调/轮询/处理完毕后再次触发共用；同一段时间只跑一次。 */
  scheduleCheck() {
    if (this.stopped) return;
    if (this.checking) { this.rerun = true; return; }
    this.checking = true;
    Promise.resolve()
      .then(() => this.check())
      .catch((e) => console.warn('[面试检索] 监听循环异常:', e))
      .finally(() => {
        this.checking = false;
        if (this.rerun && !this.stopped) {
          this.rerun = false;
          this.scheduleCheck();
        } else {
          this.rerun = false;
        }
      });
  }

  async check() {
    const q = this.readQuery();
    if (!q || typeof q.id !== 'number' || q.id === this.lastId) return;
    const question = typeof q.question === 'string' ? q.question : '';
    this.lastId = q.id;   // 先记 id 再处理：处理中来了新请求靠 rerun 再查一次
    const t0 = Date.now();
    let payload;
    try {
      const r = await this.withDeadline(
        Promise.resolve(this.plugin.processQuery(question)),
        Math.max(2000, Number(this.plugin.settings.answerDeadlineMs) || 10000));
      payload = { id: q.id, answer: r.answer, sources: r.sources || [] };
    } catch (e) {
      payload = { id: q.id, error: String((e && e.message) || e) };
    }
    try {
      this.writeAnswer(payload);
    } catch (e) {
      console.error('[面试检索] answer.json 写入失败:', e);
      return;
    }
    const dt = Date.now() - t0;
    console.log(`[面试检索] query#${q.id} 已应答（${dt}ms）${payload.error ? ' error=' + payload.error : ''}`);
    if (typeof this.plugin.onBridgeAnswer === 'function') {
      try { this.plugin.onBridgeAnswer(q, payload, dt); } catch (e) { /* 界面刷新失败不影响桥接 */ }
    }
  }

  /** 兜底时限：超时直接回错误应答，绝不静默（bridge 会傻等 15 秒）。 */
  withDeadline(promise, ms) {
    return new Promise((resolve, reject) => {
      let timer = null;
      let done = false;
      const finish = (fn, v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        fn(v);
      };
      timer = setTimeout(() => finish(reject, new Error('处理超时（' + ms + 'ms）')), ms);
      promise.then(
        (v) => finish(resolve, v),
        (e) => finish(reject, e));
    });
  }
}

/* ============================ 测试弹窗（不依赖 bridge 调参用） ============================ */

class InterviewTestModal extends Modal {
  constructor(plugin) {
    super(plugin.app);
    this.plugin = plugin;
  }

  onOpen() {
    this.modalEl.addClass('xivr-modal');
    const content = this.contentEl;
    content.empty();

    content.appendChild(el('h3', '', '面试检索控制台'));
    this.statusEl = el('div', 'xivr-hint');
    content.appendChild(this.statusEl);
    this.refreshStatusLine();

    const s = this.plugin.settings;
    new Setting(contentEl)
      .setName('直答模式（代替我回答）')
      .setDesc('开启后 AI 以第一人称口语代替你回答，悬浮卡上直接是能照着说的话；网关离线自动退回要点')
      .addToggle((t) => t.setValue(s.spokenEnabled).onChange(async (v) => {
        s.spokenEnabled = v; await this.plugin.saveSettings(); this.plugin.refreshStatusBar(); this.refreshStatusLine();
      }));
    new Setting(contentEl)
      .setName('ragfile 监听（接收 bridge 转写提问）')
      .setDesc('面试时保持开启；关掉后 bridge 的问题将无人应答（15s 超时上错误卡）')
      .addToggle((t) => t.setValue(s.bridgeEnabled).onChange(async (v) => {
        s.bridgeEnabled = v; await this.plugin.saveSettings();
        if (v) this.plugin.bridge.start(); else this.plugin.bridge.stop();
        this.plugin.refreshStatusBar(); this.refreshStatusLine();
      }));

    content.appendChild(el('div', 'xivr-hint',
      '—— 试一试：模拟面试官提问，走和 bridge 完全相同的管线（召回 → 组装 → 来源）——'));

    this.inputEl = el('input', 'xivr-input');
    this.inputEl.type = 'text';
    this.inputEl.placeholder = '输入面试官会问的问题，如：请介绍一下 Docker 的网络模式？';
    content.appendChild(this.inputEl);

    this.resultEl = el('div', 'xivr-result');
    content.appendChild(this.resultEl);

    this.inputEl.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        this.run(this.inputEl.value);
      }
    });
    setTimeout(() => this.inputEl.focus(), 50);
  }

  /** 控制台顶部状态行：随开关即时刷新。 */
  refreshStatusLine() {
    if (!this.statusEl) return;
    const s = this.plugin.settings;
    const on = s.bridgeEnabled && this.plugin.bridge && !this.plugin.bridge.stopped;
    this.statusEl.textContent = (on ? '● 监听中' : '○ 监听已停')
      + ' · 索引 ' + (this.plugin.index ? this.plugin.index.docs.size : 0) + ' 篇'
      + ' · 直答' + (s.spokenEnabled ? '开' : '关');
  }

  async run(raw) {
    const q = String(raw || '').trim();
    const box = this.resultEl;
    box.empty();
    if (!q) return;
    const t0 = Date.now();
    box.appendChild(el('div', 'xivr-meta', '检索中…'));
    try {
      const r = await this.plugin.processQuery(q);
      const dt = Date.now() - t0;
      box.empty();
      const usedMap = { spoken: '直答（第一人称）', ai: 'AI 精答', local: '本地要点' };
      const used = usedMap[(this.plugin._lastDebug && this.plugin._lastDebug.used) || 'local'];
      const hitN = this.plugin._lastDebug && this.plugin._lastDebug.hits ? this.plugin._lastDebug.hits.length : 0;
      box.appendChild(el('div', 'xivr-meta', `${used} · 召回 ${hitN} 条 · ${dt}ms`));
      box.appendChild(el('div', '', r.answer));
      const src = el('div', 'xivr-src', r.sources.length
        ? '来源：' + r.sources.map((s) => s.title).join('；')
        : '来源：（无命中）');
      box.appendChild(src);
    } catch (e) {
      box.empty();
      box.appendChild(el('div', 'xivr-error', '失败：' + ((e && e.message) || e)));
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

/* ============================ 设置页 ============================ */

class InterviewSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { contentEl } = this;
    contentEl.empty();
    const s = this.plugin.settings;
    const save = async () => { await this.plugin.saveSettings(); };

    new Setting(contentEl).setName('监听与桥接（ragfile）').setHeading();
    new Setting(contentEl)
      .setName('启用 ragfile 监听')
      .setDesc('监听 rag 目录的 query.json 并写 answer.json 应答 bridge')
      .addToggle((t) => t.setValue(s.bridgeEnabled).onChange(async (v) => {
        s.bridgeEnabled = v;
        await save();
        if (v) this.plugin.bridge.start(); else this.plugin.bridge.stop();
        this.plugin.refreshStatusBar();
      }));
    new Setting(contentEl)
      .setName('rag 目录')
      .setDesc('bridge 写 query.json / 读 answer.json 的目录（与 bridge_config.json 的 rag.dir 一致）')
      .addText((t) => t.setValue(s.ragDir).onChange(async (v) => { s.ragDir = v.trim(); await save(); }));
    new Setting(contentEl)
      .setName('轮询间隔（毫秒）')
      .setDesc('轮询 query.json 的间隔；fs.watch 同时在跑，这只是兜底。300ms 约等于最坏 0.3s 延迟')
      .addText((t) => t.setValue(String(s.pollMs)).onChange(async (v) => {
        const n = Number(v);
        if (Number.isFinite(n) && n >= 100) { s.pollMs = Math.round(n); await save(); }
      }));
    new Setting(contentEl)
      .setName('应答兜底时限（毫秒）')
      .setDesc('从读到请求到必须写应答的硬时限，超时回错误应答。bridge 超时 15s，建议 ≤10000')
      .addText((t) => t.setValue(String(s.answerDeadlineMs)).onChange(async (v) => {
        const n = Number(v);
        if (Number.isFinite(n) && n >= 2000) { s.answerDeadlineMs = Math.round(n); await save(); }
      }));

    new Setting(contentEl).setName('检索与索引').setHeading();
    new Setting(contentEl)
      .setName('启动时自动同步索引')
      .setDesc('Obsidian 启动后自动比对白名单目录，增量更新索引')
      .addToggle((t) => t.setValue(s.autoIndexOnStartup).onChange(async (v) => { s.autoIndexOnStartup = v; await save(); }));
    new Setting(contentEl)
      .setName('白名单目录')
      .setDesc('只检索这些目录下的笔记（逗号分隔多个）；修改后点下方「重建索引」')
      .addText((t) => t.setValue(s.whitelistFolder).onChange(async (v) => { s.whitelistFolder = v.trim(); await save(); }));
    new Setting(contentEl)
      .setName('包含子目录')
      .addToggle((t) => t.setValue(s.includeSubfolders).onChange(async (v) => { s.includeSubfolders = v; await save(); }));
    new Setting(contentEl)
      .setName('召回候选上限')
      .setDesc('评分后保留的候选数；回答只取前「来源条数」条')
      .addSlider((t) => t.setLimits(10, 100, 5).setValue(s.recallLimit).setDynamicTooltip()
        .onChange(async (v) => { s.recallLimit = v; await save(); }));
    new Setting(contentEl)
      .setName('来源条数')
      .setDesc('回答要点条数 / answer.json 里 sources 的条数（bridge 取前 5 条显示）')
      .addSlider((t) => t.setLimits(1, 8, 1).setValue(s.maxSources).setDynamicTooltip()
        .onChange(async (v) => { s.maxSources = v; await save(); }));
    new Setting(contentEl)
      .setName('最低分数门槛')
      .setDesc('低于该分的候选视为不相关直接丢弃（0 = 不过滤）；调大可减少答非所问')
      .addSlider((t) => t.setLimits(0, 60, 2).setValue(s.minScore).setDynamicTooltip()
        .onChange(async (v) => { s.minScore = v; await save(); }));

    new Setting(contentEl).setName('评分权重精调').setHeading();
    new Setting(contentEl)
      .setName('强文本权重（标题/标签/摘要）')
      .setDesc('命中标题、标签、AI 摘要时的每词权重；面试场景建议 4-10')
      .addSlider((t) => t.setLimits(0, 15, 1).setValue(s.wStrong).setDynamicTooltip()
        .onChange(async (v) => { s.wStrong = v; await save(); }));
    new Setting(contentEl)
      .setName('正文权重')
      .setDesc('命中正文时的每词权重；过大容易让长文霸榜，建议 1-3')
      .addSlider((t) => t.setLimits(0, 6, 1).setValue(s.wBody).setDynamicTooltip()
        .onChange(async (v) => { s.wBody = v; await save(); }));
    new Setting(contentEl)
      .setName('整句命中加分（强文本）')
      .setDesc('问题整句出现在标题/摘要区的额外加分')
      .addSlider((t) => t.setLimits(0, 60, 5).setValue(s.phraseBonusStrong).setDynamicTooltip()
        .onChange(async (v) => { s.phraseBonusStrong = v; await save(); }));
    new Setting(contentEl)
      .setName('整句命中加分（正文）')
      .setDesc('问题整句出现在正文时的额外加分')
      .addSlider((t) => t.setLimits(0, 40, 2).setValue(s.phraseBonusBody).setDynamicTooltip()
        .onChange(async (v) => { s.phraseBonusBody = v; await save(); }));
    new Setting(contentEl)
      .setName('热词加分')
      .setDesc('每命中一个热词给整篇笔记加的分（热词=当前面试领域词，抬高相关笔记）')
      .addSlider((t) => t.setLimits(0, 30, 1).setValue(s.hotwordBoost).setDynamicTooltip()
        .onChange(async (v) => { s.hotwordBoost = v; await save(); }));
    new Setting(contentEl)
      .setName('热词文件路径')
      .setDesc('与 bridge 共用的 hotwords.txt；# 开头为注释，改动即时生效')
      .addText((t) => t.setValue(s.hotwordsFile).onChange(async (v) => { s.hotwordsFile = v.trim(); await save(); }));

    new Setting(contentEl).setName('回答组装（本地要点）').setHeading();
    new Setting(contentEl)
      .setName('摘要半径（字符）')
      .setDesc('每条要点围绕首个命中词前后各取多少字符；60 ≈ 每条 120 字')
      .addSlider((t) => t.setLimits(30, 150, 10).setValue(s.snippetRadius).setDynamicTooltip()
        .onChange(async (v) => { s.snippetRadius = v; await save(); }));
    new Setting(contentEl)
      .setName('回答前缀')
      .setDesc('回答首行前缀，留空则不加（悬浮卡上靠它区分检索结果和转写原文）')
      .addText((t) => t.setValue(s.answerTitle).onChange(async (v) => { s.answerTitle = v.trim(); await save(); }));
    new Setting(contentEl)
      .setName('回答总长上限（字符）')
      .setDesc('超出截断；悬浮卡 520px 宽，建议 400-800')
      .addSlider((t) => t.setLimits(200, 1500, 50).setValue(s.maxAnswerChars).setDynamicTooltip()
        .onChange(async (v) => { s.maxAnswerChars = v; await save(); }));
    new Setting(contentEl)
      .setName('要点里附笔记路径')
      .setDesc('打开后每条要点下多一行路径（来源列表本来就单独传给 bridge）')
      .addToggle((t) => t.setValue(s.showSourcePaths).onChange(async (v) => { s.showSourcePaths = v; await save(); }));

    new Setting(contentEl).setName('问题清洗').setHeading();
    new Setting(contentEl)
      .setName('最短问题字数')
      .setDesc('去空白后短于该字数的请求直接回错误应答（挡住转写碎片）')
      .addSlider((t) => t.setLimits(0, 12, 1).setValue(s.minQuestionChars).setDynamicTooltip()
        .onChange(async (v) => { s.minQuestionChars = v; await save(); }));
    new Setting(contentEl)
      .setName('噪声正则（每行一个）')
      .setDesc('命中的问题视为转写幻觉/噪声，回错误应答。例：^by bwd6$|^啊哈$|^叻+$')
      .addTextArea((t) => {
        t.inputEl.style.width = '100%';
        t.inputEl.style.height = '80px';
        t.setValue(s.noiseRegex).onChange(async (v) => { s.noiseRegex = v; await save(); });
      });

    new Setting(contentEl).setName('直答模式（代替我回答）').setHeading();
    new Setting(contentEl)
      .setName('启用直答模式')
      .setDesc('开启后 AI 以第一人称口语代替你回答面试官，悬浮卡上直接是能照着说的话；'
        + '需要网关在线，失败自动退回「AI 精答 → 本地要点」，不会拖慢应答')
      .addToggle((t) => t.setValue(s.spokenEnabled).onChange(async (v) => {
        s.spokenEnabled = v; await save(); this.plugin.refreshStatusBar();
      }));
    new Setting(contentEl)
      .setName('直答提示词')
      .setDesc('控制「像人说话」的程度：长短、口头语、是否坦承不熟的部分都在这里调')
      .addTextArea((t) => {
        t.inputEl.style.width = '100%';
        t.inputEl.style.height = '140px';
        t.setValue(s.spokenSystemPrompt).onChange(async (v) => { s.spokenSystemPrompt = v; await save(); });
      })
      .addExtraButton((b) => b.setIcon('rotate-ccw').setTooltip('恢复默认')
        .onClick(async () => { s.spokenSystemPrompt = DEFAULT_SPOKEN_PROMPT; await save(); this.display(); }));

    new Setting(contentEl).setName('AI 精答 / 协助').setHeading();
    new Setting(contentEl)
      .setName('启用 AI 精答')
      .setDesc('网关在线时用 AI 把召回资料组织成口头回答；不在线自动降级本地要点，不影响应答速度')
      .addToggle((t) => t.setValue(s.aiEnabled).onChange(async (v) => { s.aiEnabled = v; await save(); }));
    new Setting(contentEl)
      .setName('AI 协助（资料弱相关时用通用经验补齐）')
      .setDesc('打开：召回资料只当参考，资料与问题无关就忽略、改由 AI 用通用工程经验作答并标注；'
        + '关闭：严格只用资料，资料不足时只回「资料中未找到」')
      .addToggle((t) => t.setValue(s.aiAssist).onChange(async (v) => { s.aiAssist = v; await save(); }));
    new Setting(contentEl)
      .setName('API Base URL')
      .setDesc('OpenAI 兼容接口地址（与 ai-search 同款网关即可）')
      .addText((t) => t.setValue(s.baseUrl).onChange(async (v) => { s.baseUrl = v.trim(); await save(); }));
    new Setting(contentEl)
      .setName('API Key')
      .setDesc('本地网关通常可留空')
      .addText((t) => {
        t.inputEl.type = 'password';
        t.setValue(s.apiKey).onChange(async (v) => { s.apiKey = v.trim(); await save(); });
      });
    new Setting(contentEl)
      .setName('模型')
      .setDesc('实测四道题（redis 故障 / kafka 丢消息 / 性能优化 / JVM 内存模型）：cndeepseek-v4-flash 平均 5.2s、390~555 字、内容最完整（默认）· cnminimax-m3 4.7s、220~365 字 · cnhy3 4.4s、180~290 字最省字但偏浅 · cnglm-5.3-flash 与 cnkimi-k2.8-preview 8s 以上别用 · auto 当前路由到 deepseek-v4.1（7s 左右，偏慢）')
      .addText((t) => t.setValue(s.model).onChange(async (v) => { s.model = v.trim(); await save(); }));
    new Setting(contentEl)
      .setName('AI 超时（毫秒）')
      .setDesc('必须小于应答兜底时限，否则超时的 AI 回答来不及上卡；到点自动降级本地要点')
      .addText((t) => t.setValue(String(s.aiTimeoutMs)).onChange(async (v) => {
        const n = Number(v);
        if (Number.isFinite(n) && n >= 1000) { s.aiTimeoutMs = Math.round(n); await save(); }
      }));
    new Setting(contentEl)
      .setName('输出上限（token，0=不限）')
      .setDesc('⚠️ 一般留 0。网关不流式返回，把它调小并不会让答案变快，反而会让部分模型把思考过程当正文吐出来、答案断在半句（实测 deepseek 系必现）。要提速就换模型')
      .addSlider((t) => t.setLimits(0, 1200, 40).setValue(s.aiMaxTokens).setDynamicTooltip()
        .onChange(async (v) => { s.aiMaxTokens = v; await save(); }));
    new Setting(contentEl)
      .setName('AI 资料条数')
      .setDesc('喂给 AI 的笔记条数（实测 3 条与 5 条延迟无差别，砍它只丢引用不省时间）')
      .addSlider((t) => t.setLimits(3, 10, 1).setValue(s.aiContextDocs).setDynamicTooltip()
        .onChange(async (v) => { s.aiContextDocs = v; await save(); }));
    new Setting(contentEl)
      .setName('单篇资料字符上限')
      .addSlider((t) => t.setLimits(500, 3000, 100).setValue(s.aiContextCharsPerDoc).setDynamicTooltip()
        .onChange(async (v) => { s.aiContextCharsPerDoc = v; await save(); }));
    new Setting(contentEl)
      .setName('AI 失败降级本地要点')
      .setDesc('关闭后 AI 失败直接回错误应答（卡片显示失败原因）')
      .addToggle((t) => t.setValue(s.aiFallbackLocal).onChange(async (v) => { s.aiFallbackLocal = v; await save(); }));
    new Setting(contentEl)
      .setName('AI 精答提示词')
      .setDesc('「AI 协助」打开时会在这段提示词后面自动追加一段「资料弱相关怎么办」的补充规则')
      .addTextArea((t) => {
        t.inputEl.style.width = '100%';
        t.inputEl.style.height = '140px';
        t.setValue(s.aiSystemPrompt).onChange(async (v) => { s.aiSystemPrompt = v; await save(); });
      })
      .addExtraButton((b) => b.setIcon('rotate-ccw').setTooltip('恢复默认')
        .onClick(async () => { s.aiSystemPrompt = DEFAULT_AI_PROMPT; await save(); this.display(); }));

    new Setting(contentEl).setName('界面与维护').setHeading();
    new Setting(contentEl)
      .setName('显示状态栏')
      .setDesc('状态栏显示监听状态与索引篇数，点击打开测试弹窗')
      .addToggle((t) => t.setValue(s.statusBarEnabled).onChange(async (v) => {
        s.statusBarEnabled = v; await save(); this.plugin.refreshStatusBar();
      }));
    new Setting(contentEl)
      .setName('重建索引')
      .setDesc('全量重新扫描白名单目录并解析 frontmatter 与章节')
      .addButton((b) => b.setButtonText('立即重建').onClick(async () => {
        new Notice('面试检索：开始重建索引…');
        await this.plugin.rebuildIndex();
      }));
    new Setting(contentEl)
      .setName('清除索引缓存')
      .setDesc('删除插件目录下的 index.json 并清空内存索引')
      .addButton((b) => b.setButtonText('清除').onClick(async () => {
        await this.plugin.index.clearCache();
        new Notice('面试检索：索引缓存已清除');
      }));
  }
}

/* ============================ 插件入口 ============================ */

class InterviewRagPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.index = new RecallIndex(this);
    this.client = new AIClient(this);
    this.bridge = new RagBridge(this);
    this._rebuilding = false;
    this._unloaded = false;
    this.lastAnswer = null;     // 最近一次真实应答（测试弹窗展示用）
    this._lastDebug = null;     // 最近一次 processQuery 的调试信息

    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.onclick = () => this.openTestModal();
    this.refreshStatusBar();

    this.addRibbonIcon('graduation-cap', '面试检索控制台', () => this.openTestModal());
    this.addCommand({
      id: 'interview-test-search',
      name: '打开面试检索控制台',
      callback: () => this.openTestModal(),
    });
    // 品牌分组标记（见 snippets/xyblue135-brand.css）
    const __brandEl = document.querySelector('.side-dock-ribbon-action[aria-label="' + '面试检索控制台' + '"]');
    if (__brandEl) __brandEl.addClass('xyblue135-ribbon xyblue135-ai');

    // 面试风格预设： spokenPromptPresets 里的每个键注册一条切换命令（可盲绑热键）
    const __stylePresets = this.settings.spokenPromptPresets || null;
    if (__stylePresets) {
      for (const __styleName of Object.keys(__stylePresets)) {
        this.addCommand({
          id: 'interview-style-' + __styleName,
          name: '面试风格 → ' + __styleName,
          callback: async () => {
            this.settings.spokenSystemPrompt = __stylePresets[__styleName];
            await this.saveSettings();
            new Notice('面试风格已切换: ' + __styleName, 3000);
          },
        });
      }
    }
    this.addCommand({
      id: 'interview-rebuild-index',
      name: '重建面试检索索引',
      callback: () => this.rebuildIndex(),
    });
    this.addCommand({
      id: 'interview-toggle-bridge',
      name: '开/关 ragfile 监听',
      callback: async () => {
        this.settings.bridgeEnabled = !this.settings.bridgeEnabled;
        await this.saveSettings();
        if (this.settings.bridgeEnabled) this.bridge.start(); else this.bridge.stop();
        this.refreshStatusBar();
        new Notice('面试检索：监听已' + (this.settings.bridgeEnabled ? '开启' : '关闭'));
      },
    });
    this.addCommand({
      id: 'interview-toggle-spoken',
      name: '开/关 直答模式（第一人称代替回答）',
      callback: () => this.toggleSpoken(),
    });

    this.registerEvent(this.app.vault.on('modify', (f) => {
      if (f instanceof TFile && f.extension === 'md') this.index.scheduleUpdate(f);
    }));
    this.registerEvent(this.app.vault.on('create', (f) => {
      if (f instanceof TFile && f.extension === 'md') this.index.scheduleUpdate(f);
    }));
    this.registerEvent(this.app.vault.on('delete', (f) => {
      if (f instanceof TFile) this.index.removeFile(f.path);
    }));
    this.registerEvent(this.app.vault.on('rename', (f, oldPath) => {
      if (f instanceof TFile) this.index.renameFile(oldPath, f);
    }));

    this.addSettingTab(new InterviewSettingTab(this.app, this));

    // 先把已保存的索引读进内存并启动监听（查询随时可能来），再等布局就绪做全量同步
    await this.index.load();
    if (this.settings.bridgeEnabled && !this._unloaded) this.bridge.start();
    this.refreshStatusBar();

    this.app.workspace.onLayoutReady(() => {
      if (this._unloaded) return;
      void this.startupSync();
    });
  }

  async startupSync() {
    try {
      if (this.settings.autoIndexOnStartup) {
        await this.index.reconcile();
        await this.index.saveNow();
      }
    } catch (e) {
      console.warn('[面试检索] 启动同步失败:', e);
    }
    this.refreshStatusBar();
  }

  onunload() {
    this._unloaded = true;
    if (this.bridge) this.bridge.stop();
    if (this.index) {
      clearTimeout(this.index._saveTimer);
      clearTimeout(this.index._modTimer);
      this.index._modQueue.clear();
    }
  }

  openTestModal() {
    new InterviewTestModal(this).open();
  }

  /** 直答模式开关：命令面板与设置页共用。 */
  async toggleSpoken() {
    this.settings.spokenEnabled = !this.settings.spokenEnabled;
    await this.saveSettings();
    this.refreshStatusBar();
    new Notice('面试检索：直答模式已' + (this.settings.spokenEnabled ? '开启（AI 以第一人称代答）' : '关闭'));
  }

  /** bridge 应答完成后的界面回调（由 RagBridge 调用）。 */
  onBridgeAnswer(q, payload, ms) {
    this.lastAnswer = { question: q.question, payload, ms };
    this.refreshStatusBar();
    if (payload.error) new Notice('面试检索：' + payload.error, 5000);
  }

  /**
   * 完整问答管线：清洗 → 本地召回 → （可选）AI 精答 → 组装。
   * bridge 与测试弹窗共用；抛错时由 RagBridge 转成错误应答。
   */
  async processQuery(question) {
    const s = this.settings;
    const q = String(question || '').trim();
    if (q.length < Math.max(0, Number(s.minQuestionChars) || 0)) {
      throw new Error('问题太短（' + q.length + ' 字），已忽略');
    }
    const noise = String(s.noiseRegex || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    for (const line of noise) {
      const re = safeRegExp(line);
      if (re && re.test(q)) throw new Error('噪声问题已过滤（匹配 ' + line + '）');
    }

    const hotwords = this.loadHotwords();
    const hits = this.index.search(q, hotwords);
    this._lastDebug = { question: q, hits, used: 'local' };

    let answer = null;
    if (s.spokenEnabled) {
      // 直答模式：第一人称口语代替回答；失败自动落回下面的要点链，绝不静默
      try {
        answer = await this.spokenAnswer(q, hits);
        this._lastDebug.used = 'spoken';
      } catch (e) {
        console.warn('[面试检索] 直答失败，降级要点模式:', e.message);
        new Notice('面试检索：直答不可用，已退回要点模式', 4000);
      }
    }
    if (!answer && s.aiEnabled) {
      try {
        answer = await this.aiAnswer(q, hits);
        this._lastDebug.used = 'ai';
      } catch (e) {
        console.warn('[面试检索] AI 回答失败，降级本地要点:', e.message);
        if (!s.aiFallbackLocal) throw new Error('AI 回答失败：' + e.message);
        new Notice('面试检索：AI 不可用，已用本地要点作答', 4000);
      }
    }
    if (!answer) answer = buildLocalAnswer(q, hits, s);

    const sources = hits.slice(0, Math.max(1, Number(s.maxSources) || 4))
      .map((h) => ({ path: h.doc.path, title: h.doc.title }));
    return { answer, sources };
  }

  /**
   * AI 精答：召回资料块 → 短超时 chat。失败由调用方降级本地要点。
   * aiAssist 打开时，资料只当参考——本地召回是按字面加权的，问「redis 故障怎么处理」常常
   * 只召回到安装/命令类同名笔记，此时让模型忽略无关资料、用通用工程经验作答才有用。
   */
  async aiAnswer(question, hits) {
    const s = this.settings;
    const assist = s.aiAssist !== false;
    if (!hits.length && !assist) throw new Error('知识库未找到相关内容，无法 AI 作答');
    const blocks = this.buildContextBlocks(question, hits);
    const sys = assist ? String(s.aiSystemPrompt || '') + '\n\n' + AI_ASSIST_HINT : String(s.aiSystemPrompt || '');
    const user = (blocks.length
      ? '【资料】（可能只与本问题字面相关，自己判断是否可用）\n' + blocks.join('\n\n')
      : '【资料】（本次召回无相关笔记，请直接用通用工程经验回答）')
      + '\n\n【面试官问题】\n' + question;
    const content = await this.client.chat(
      [{ role: 'system', content: sys }, { role: 'user', content: user }],
      { temperature: 0.2, timeoutMs: Number(s.aiTimeoutMs) || 10000 });
    const out = String(content || '').trim();
    if (!out) throw new Error('AI 返回为空');
    const cap = Math.max(100, Number(s.maxAnswerChars) || 600);
    return smartClip(out, cap);
  }

  /** 组装 AI 上下文资料块（aiAnswer 与 spokenAnswer 共用）。 */
  buildContextBlocks(question, hits) {
    const s = this.settings;
    const docsN = Math.max(1, Number(s.aiContextDocs) || 5);
    const perDoc = Math.max(200, Number(s.aiContextCharsPerDoc) || 1000);
    const qterms = queryTerms(question).slice(0, 24);
    return hits.slice(0, docsN).map((h, i) => {
      let text = '';
      // 取最相关的 3 段：命中段 + 标题命中段，比只给「首段 + 命中段」更能覆盖到真正的答案段
      const picked = this.index.topSections(h.doc, qterms, 3);
      if (picked.length) {
        text = picked.map((p) => (p.h ? '【' + p.h + '】\n' : '') + p.t).join('\n……\n');
      }
      if (!text) text = h.doc.summaryShort || h.doc.summaryLong || '';
      text = text.slice(0, perDoc);
      return '[' + (i + 1) + '] 《' + h.doc.title + '》（' + h.doc.path + '）\n' + text;
    });
  }

  /**
   * 直答模式：以第一人称口语代替候选人回答，照着说即可。
   * 提示词独立可调（spokenSystemPrompt）；温度略高换自然度；失败由 processQuery 降级要点链。
   */
  async spokenAnswer(question, hits) {
    const s = this.settings;
    const assist = s.aiAssist !== false;
    if (!hits.length && !assist) throw new Error('知识库未找到相关内容，无法直答');
    const blocks = this.buildContextBlocks(question, hits);
    const sys = String(s.spokenSystemPrompt || DEFAULT_SPOKEN_PROMPT)
      + (assist ? '\n\n' + AI_ASSIST_HINT : '');
    const user = (blocks.length
      ? '【资料】（可能只与本问题字面相关，自己判断是否可用）\n' + blocks.join('\n\n')
      : '【资料】（本次召回无相关笔记，请直接用通用工程经验回答）')
      + '\n\n【面试官问题】\n' + question;
    const content = await this.client.chat(
      [{ role: 'system', content: sys }, { role: 'user', content: user }],
      { temperature: 0.4, timeoutMs: Number(s.aiTimeoutMs) || 10000 });
    const out = String(content || '').trim();
    if (!out) throw new Error('AI 返回为空');
    const cap = Math.max(100, Number(s.maxAnswerChars) || 600);
    return smartClip(out, cap);
  }

  /** 热词读取：# 开头为注释；按 mtime 缓存，文件改动即时生效。 */
  loadHotwords() {
    const file = String(this.settings.hotwordsFile || '').trim();
    if (!file) return [];
    try {
      const st = fs.statSync(file);
      if (this._hwCache && this._hwCache.mtime === st.mtimeMs) return this._hwCache.words;
      const words = fs.readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'));
      this._hwCache = { mtime: st.mtimeMs, words };
      return words;
    } catch (e) {
      return [];
    }
  }

  async rebuildIndex() {
    if (this._rebuilding || (this.index && this.index._busy)) {
      new Notice('面试检索：正在索引中，请稍后再试');
      return;
    }
    this._rebuilding = true;
    try {
      this.index.docs.clear();
      const r = await this.index.reconcile();
      await this.index.saveNow();
      new Notice('面试检索：索引完成，共 ' + r.total + ' 篇（新增 ' + r.added + '，更新 ' + r.updated + '）');
    } catch (e) {
      new Notice('面试检索：索引失败 — ' + e.message, 8000);
    } finally {
      this._rebuilding = false;
    }
  }

  refreshStatusBar() {
    if (!this.statusBarEl) return;
    if (!this.settings.statusBarEnabled) {
      this.statusBarEl.setText('');
      this.statusBarEl.style.display = 'none';
      return;
    }
    this.statusBarEl.style.display = '';
    const on = this.settings.bridgeEnabled && this.bridge && !this.bridge.stopped;
    const n = this.index ? this.index.docs.size : 0;
    this.statusBarEl.setText('面试检索：' + (on ? '监听中' : '已停') + ' · ' + n + ' 篇'
      + (this.settings.spokenEnabled ? ' · 直答' : ''));
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) || {});
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

module.exports = InterviewRagPlugin;
module.exports.__internal = {
  tokenize, queryTerms, countOccurrences, fnv1a, makeSnippet, normalizeTags,
  parseFrontmatterFallback, recomputeDerived, serializeDoc,
  RecallIndex, RagBridge, AIClient, buildLocalAnswer, DEFAULT_SETTINGS, DEFAULT_AI_PROMPT, AI_ASSIST_HINT,
  DEFAULT_SPOKEN_PROMPT,
};
