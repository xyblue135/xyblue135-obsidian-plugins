'use strict';

/*
 * xyblue135 · AI 检索 (00_xyblue135-ai-search)
 *
 * 两阶段检索：本地召回（标题/标签/摘要/正文分词评分，零 API 成本）
 *           + AI 精排（chat/completions，与 00_xyblue135-metadata-ai 同一套接口约定）
 * 可选流式 AI 问答（RAG）：取精排前列文章的相关段落作为资料，回答带 [n] 引用。
 *
 * 1.0.0 起并入原 00_xyblue135-interview-rag：面试模式复用同一份索引与同一个 baseUrl/apiKey，
 * 以 iv* 前缀的设置独立控制评分权重/模型/超时，并保留 ragfile 文件握手（query.json / answer.json）。
 *
 * HTTP 走 Node 原生 http/https（与 metadata-ai 相同），无 CORS 限制，支持 SSE 流式。
 */

const {
  Plugin, Modal, PluginSettingTab, Setting, Notice, TFile,
  MarkdownRenderer, Component, setIcon, normalizePath,
} = require('obsidian');
const http = require('http');
const https = require('https');
// 面试模式的 ragfile 桥接走本地文件（与 OBS 侧 bridge.py 的握手契约，不能用网络端口）
const fs = require('fs');
const path = require('path');

/* ============================ 常量与默认配置 ============================ */

const DEFAULT_RERANK_HARNESS = [
  '角色：知识库检索精排助手。',
  '任务：根据用户问题，对候选文章按与问题的相关度重新排序，并给出简短理由。',
  '要求：',
  '1. 优先考虑与问题主题、关键词、技术栈直接相关的文章，摘要与标签是重要依据；',
  '2. 与问题无关的候选直接丢弃，宁缺毋滥；',
  '3. 不确定相关性的候选排在后面或丢弃。',
].join('\n');

const DEFAULT_QA_HARNESS = [
  '角色：知识库问答助手。',
  '任务：仅根据提供的资料回答用户问题。',
  '要求：',
  '1. 答案必须来自资料，禁止编造；资料不足时明确说明“资料中未找到相关内容”；',
  '2. 使用中文，重点先行，条理清晰，控制在 500 字以内；',
  '3. 引用资料时在对应句末标注 [编号]，编号对应资料前的标记；',
  '4. 涉及命令、配置时直接给出代码片段。',
].join('\n');

const RERANK_FORMAT_SPEC = [
  '【输出格式（必须严格遵守）】',
  '只输出一个 JSON 对象，禁止输出解释文字、前后缀或 Markdown 代码块标记：',
  '{"results":[{"path":"候选列表中的 path 原文","score":0到100的整数,"reason":"不超过30字的相关理由"}]}',
  '按相关度从高到低排序，最多返回 10 条；path 必须逐字复制候选列表中的 path 字段，禁止修改或编造。',
].join('\n');

/* ==================== 面试模式常量（1.0.0 由原 00_xyblue135-interview-rag 并入） ==================== */

const DEFAULT_IV_AI_PROMPT = [
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
const IV_ASSIST_HINT = [
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
const DEFAULT_IV_SPOKEN_PROMPT = [
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
  baseUrl: 'http://127.0.0.1:31415/v1',
  apiKey: '',
  model: 'auto',
  requestTimeoutSeconds: 180,
  structuredJsonModeEnabled: true,
  jsonRepairEnabled: true,

  whitelistFolder: 'my_blog/00_docs',
  includeSubfolders: true,
  localRecallLimit: 50,

  embeddingEnabled: false,
  embeddingModel: 'auto',
  embeddingBatchSize: 16,

  rerankEnabled: true,
  rerankShowLimit: 10,

  qaEnabled: true,
  qaContextDocs: 6,
  qaContextCharsPerDoc: 1200,

  autoIndexOnStartup: true,
  incrementalUpdateEnabled: true,
  statusBarEnabled: true,
  autoRebuildHours: 0,

  rerankHarness: DEFAULT_RERANK_HARNESS,
  qaHarness: DEFAULT_QA_HARNESS,

  /* ---- 面试模式（1.0.0 由原 00_xyblue135-interview-rag 并入，统一 iv 前缀）----
     与主检索共用同一份索引与 baseUrl/apiKey，但模型、超时、评分权重独立 ——
     面试要「毫秒级 + 字面准」，与日常检索的取舍不同。 */

  // 监听与桥接（OBS 转写 → bridge.py → query.json / answer.json）
  ivBridgeEnabled: true,
  ivRagDir: 'D:\\obs-interview\\rag',
  ivPollMs: 300,
  ivAnswerDeadlineMs: 12000,

  // 召回
  ivRecallLimit: 50,
  ivMaxSources: 4,
  ivMinScore: 6,

  // 评分权重（与合并前的 6 / 1 / 25 / 12 默认值一致）
  ivWStrong: 6,
  ivWBody: 1,
  ivPhraseBonusStrong: 25,
  ivPhraseBonusBody: 12,
  ivHotwordBoost: 8,
  ivHotwordsFile: 'D:\\obs-interview\\hotwords.txt',

  // 回答组装（本地要点）
  ivSnippetRadius: 60,
  ivAnswerTitle: '知识库要点',
  ivMaxAnswerChars: 600,
  ivShowSourcePaths: false,

  // 问题清洗
  ivMinQuestionChars: 4,
  ivNoiseRegex: '',

  // AI 精答
  ivAiEnabled: true,
  ivModel: 'auto',
  ivTimeoutMs: 10000,
  ivMaxTokens: 0,
  ivContextDocs: 5,
  ivContextCharsPerDoc: 1000,
  // 命名与旧插件的 aiAssist / aiFallbackLocal / aiSystemPrompt 一一对应，
  // 迁移时只需 'iv' + 首字母大写，不必维护例外表
  ivAiAssist: true,
  ivAiFallbackLocal: true,
  ivAiSystemPrompt: DEFAULT_IV_AI_PROMPT,

  // 直答模式
  ivSpokenEnabled: false,
  ivSpokenSystemPrompt: DEFAULT_IV_SPOKEN_PROMPT,
  ivSpokenPromptPresets: null,
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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

/**
 * 查询侧分词（面试模式用）：先把疑问/礼貌词从原串里「挖掉」再切二元组。
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

/** 用户填的噪声正则可能写错，单行失败只跳过该行，不能让整个应答链挂掉。 */
function safeRegExp(src) {
  try {
    return new RegExp(src);
  } catch (e) {
    console.warn('[AI 检索] 无效正则，已跳过:', src);
    return null;
  }
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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function highlight(frag, terms) {
  let out = escapeHtml(frag);
  const esc = (terms || [])
    .filter((t) => t && t.length >= 2)
    .slice(0, 12)
    .sort((a, b) => b.length - a.length)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (esc.length) {
    try {
      out = out.replace(new RegExp('(' + esc.join('|') + ')', 'gi'), '<mark>$1</mark>');
    } catch (e) { /* 正则异常时退回纯文本 */ }
  }
  return out;
}

/** 摘要净化：链接只留文字、去掉表格/代码/加粗符号（面试卡片要能直接照着念）。 */
function sanitizeSnippet(t) {
  return String(t)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[|`*_>#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 在段落中围绕首个命中词取一段摘要。
 * plain=true 时先净化 Markdown 标记——面试回答是给人念的，不能带 `|` 和反引号；
 * 检索面板保持原样（它自己做高亮渲染，净化会吃掉行内代码的视觉区分）。
 */
function makeSnippet(section, terms, radius = 70, plain = false) {
  if (!section || !section.t) return '';
  const t = plain ? sanitizeSnippet(section.t) : section.t.replace(/\s+/g, ' ');
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

/** 余弦相似度（用于语义向量召回）。 */
function cosineSim(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
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
      if (!Array.isArray(fm[cur])) fm[cur] = fm[cur] ? [String(fm[cur])] : [];
      if (v) fm[cur].push(v);
    }
  }
  return { fm, bodyStart: end + 1 };
}

/** 从 AI 返回文本中提取 JSON（容忍代码块围栏与前后缀）。 */
function extractJson(text, jsonRepairEnabled) {
  let t = String(text || '').trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(t); } catch (e) { /* 继续 */ }
  if (jsonRepairEnabled) {
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a >= 0 && b > a) {
      try { return JSON.parse(t.slice(a, b + 1)); } catch (e) { /* 继续 */ }
    }
  }
  throw new Error('无法从 AI 返回中解析出 JSON');
}

function matchCandidate(byPath, byBase, raw) {
  if (!raw || typeof raw !== 'string') return null;
  let p = raw.trim();
  if (byPath.has(p)) return byPath.get(p);
  p = p.replace(/^\.\//, '').replace(/^\/+/, '').replace(/\.md$/i, '');
  if (byPath.has(p)) return byPath.get(p);
  if (byPath.has(p + '.md')) return byPath.get(p + '.md');
  const base = p.split('/').pop().toLowerCase();
  return byBase.get(base) || null;
}

/* ============================ 索引 ============================ */

function recomputeDerived(doc) {
  doc.strongText = [
    doc.title || '',
    toList(doc.aiTitles).join(' '),
    (doc.tags || []).join(' '),
    doc.summaryShort || '',
    doc.summaryLong || '',
  ].join('\n');
  doc.bodyText = (doc.sections || []).map((s) => s.t).join('\n');
  // 小写副本随文档缓存一次，避免每次按键都把全库重新小写化（2.7）
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
    vector: Array.isArray(doc.vector) ? doc.vector : null,
    sections: doc.sections,
    // 兜底解析标记（仅在元数据缓存未就绪时写入），下次同步时强制重解析（2.3）
    fmFallback: doc.fmFallback === true ? true : undefined,
  };
}

class SearchIndex {
  constructor(plugin) {
    this.plugin = plugin;
    this.docs = new Map();
    this.status = { state: 'idle', done: 0, total: 0 };
    this._saveTimer = null;
    this._modTimer = null;
    this._modQueue = new Set();
    this._busy = false;
    this._pending = null;   // 正在运行的 reconcile 的 Promise，供并发调用复用（2.1）
    this._saving = null;    // 保存串行化队列尾（2.5）
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
      if (Number(data.version) !== INDEX_VERSION || (data.whitelist || '') !== (this.plugin.settings.whitelistFolder || '')) {
        this.docs.clear();
        return false;
      }
      this.docs.clear();
      const indexModel = data.embeddingModel || '';
      for (const f of data.files || []) {
        if (!f || typeof f.path !== 'string') continue;
        // 向量与模型绑定：模型不一致或缺失时丢弃旧向量，待 ensureVectors 重建
        if (Array.isArray(f.vector) && indexModel && indexModel === this.plugin.settings.embeddingModel) {
          f.vectorOk = true;
        } else {
          f.vector = null;
        }
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
        // 保存失败不再静默吞掉，否则用户只会看到索引莫名变 0 篇（2.5）
        new Notice('AI 检索：索引保存失败 ' + ((e && e.message) || e), 8000);
      });
    }, 3000);
  }

  saveNow() {
    // 串行化：同一时刻只允许一次写入，后到的调用排在前一次之后，避免并发写坏 index.json（2.5）
    const run = (this._saving || Promise.resolve()).then(() => this._writeSnapshot());
    this._saving = run.then(() => {}, () => {});
    return run;
  }

  async _writeSnapshot() {
    const data = {
      version: INDEX_VERSION,
      whitelist: this.plugin.settings.whitelistFolder || '',
      embeddingModel: this.plugin.settings.embeddingModel || '',
      builtAt: Date.now(),
      files: [...this.docs.values()].map(serializeDoc),
    };
    const target = this.indexFilePath();
    const text = JSON.stringify(data);
    const adapter = this.plugin.app.vault.adapter;
    const tmp = target + '.tmp';
    // 先写临时文件再改名，避免写入中途被打断留下截断的 JSON（2.5）
    await adapter.write(tmp, text);
    if (typeof adapter.rename === 'function') {
      try {
        await adapter.rename(tmp, target);
        return;
      } catch (e) {
        // 个别适配器无法覆盖已存在的目标文件：退回直接写入，避免索引一直保存不上（2.5）
        console.warn('AI 检索：临时文件改名失败，改为直接写入 index.json', e);
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
    // 已有同步在跑：复用同一个 Promise，调用方 await 到的是真实结果而不是空跑（2.1）
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
      // 兜底解析的条目强制重解析：等元数据缓存就绪后修正标签/AI 摘要（2.3）
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
      // 元数据缓存还没解析完 → 标记兜底，下次 reconcile 强制重解析（2.3）
      // 缓存对象存在但 frontmatter 尚未填充（正在解析）也算未就绪，否则缺字段的结果会被 hash 固化
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
        // ATX 闭合序列前必须有空白，否则“学习 C#”“F# 管道”这类标题会被截断（2.9）
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
      vector: null,
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
    // 改名/移动后已不在白名单目录内：直接移出索引，避免继续被检索命中（2.10）
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
    if (!this.plugin.settings.incrementalUpdateEnabled || this._busy) return;
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

  /** 命中段落挑选。headerWeight>0 时标题命中额外加权（面试模式用 3，与合并前一致）。 */
  bestSection(doc, terms, headerWeight = 0) {
    if (!doc.sections || !doc.sections.length) return null;
    let best = null;
    let bestScore = -1;
    for (const s of doc.sections) {
      const tl = s.t.toLowerCase();
      const hl = headerWeight ? (s.h || '').toLowerCase() : '';
      let c = 0;
      for (const t of terms) c += countOccurrences(tl, t) + headerWeight * countOccurrences(hl, t);
      if (c > bestScore) { bestScore = c; best = s; }
    }
    return best;
  }

  /** 取最相关的前 k 段（面试模式组装 AI 上下文用；标题命中权重高于正文）。 */
  /**
   * 取最相关的 k 段（喂给 AI 做资料）。标题命中按 6 倍权。
   * 一段都没命中时退回首段——宁可给点上下文，也不要空资料。
   */
  topSections(doc, terms, k = 3) {
    if (!doc.sections || !doc.sections.length) return [];
    const scored = doc.sections.map((s) => {
      const hl = (s.h || '').toLowerCase();
      const tl = String(s.t || '').toLowerCase();
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

  topTags(limit) {
    const c = new Map();
    for (const d of this.docs.values()) {
      for (const t of d.tags || []) c.set(t, (c.get(t) || 0) + 1);
    }
    return [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit || 60).map((e) => e[0]);
  }

  /** 构建/补齐全库语义向量（可选功能，失败时置 _embFailed 并抛出）。 */
  async ensureVectors(onProgress) {
    if (!this.plugin.settings.embeddingEnabled) return 0;
    if (this._embFailed) return 0;
    const pending = [...this.docs.values()].filter((d) => !Array.isArray(d.vector));
    if (!pending.length) return 0;
    const bs = Math.max(1, Number(this.plugin.settings.embeddingBatchSize) || 16);
    let done = 0;
    for (let i = 0; i < pending.length; i += bs) {
      const batch = pending.slice(i, i + bs);
      const inputs = batch.map((d) => ((d.strongText || '') + '\n' + (d.bodyText || '').slice(0, 1500)).slice(0, 4000));
      let vecs;
      try {
        vecs = await this.plugin.client.embeddings(inputs);
      } catch (e) {
        this._embFailed = true;
        throw new Error('Embedding 不可用：' + e.message);
      }
      for (let j = 0; j < batch.length; j++) batch[j].vector = Array.isArray(vecs[j]) ? vecs[j] : null;
      done += batch.length;
      if (onProgress) onProgress(done, pending.length);
      this.saveIndexDebounced();
      if (i + bs < pending.length) await sleep(300);
    }
    return done;
  }

  async queryVector(query) {
    const q = String(query || '').trim();
    if (!q) return null;
    if (this._qvecCache && this._qvecCache.q === q) return this._qvecCache.v;
    const vecs = await this.plugin.client.embeddings([q]);
    const v = vecs && vecs[0];
    if (!Array.isArray(v)) throw new Error('embedding 返回异常');
    this._qvecCache = { q, v };
    return v;
  }

  applyFilter(docsArr, filter) {
    if (!filter || (!filter.tag && !filter.minDepth)) return docsArr;
    const tagLc = (filter.tag || '').toLowerCase();
    const minD = Number(filter.minDepth) || 0;
    return docsArr.filter((d) =>
      (!tagLc || (d.tags || []).some((t) => String(t).toLowerCase() === tagLc))
      && (d.maxDepth || 0) >= minD);
  }

  /** 本地两阶段召回的第一阶段：加权词频评分（strongText 权重高，正文权重低）。 */
  /**
   * 本地关键词评分检索。
   *
   * opts（可选，面试模式用）：{ terms, wStrong, wBody, phraseBonusStrong, phraseBonusBody,
   *   hotwords: string[], hotwordBoost, minScore, idfCap, logTf }
   * 不传 opts 时用本插件一贯的默认权重与线性词频，行为与合并前完全一致。
   * 面试模式传 logTf + idfCap=3.5：长文（命令手册式笔记）不靠堆词频霸榜，
   * 稀有词（含跨词边界碎片）也不会把一两篇无关笔记顶到第一。
   */
  searchLocal(query, limit, filter, opts) {
    const q = String(query || '').trim();
    if (!q || this.docs.size === 0) return [];
    const o = opts || {};
    const wStrong = Number.isFinite(Number(o.wStrong)) ? Number(o.wStrong) : 6;
    const wBody = Number.isFinite(Number(o.wBody)) ? Number(o.wBody) : 1;
    const bonusStrong = Number.isFinite(Number(o.phraseBonusStrong)) ? Number(o.phraseBonusStrong) : 25;
    const bonusBody = Number.isFinite(Number(o.phraseBonusBody)) ? Number(o.phraseBonusBody) : 12;
    const minScore = Math.max(0, Number(o.minScore) || 0);
    const idfCap = Number(o.idfCap) > 0 ? Number(o.idfCap) : Infinity;
    const logTf = !!o.logTf;

    const docsArr = this.applyFilter([...this.docs.values()], filter);
    const N = docsArr.length;
    const terms = Array.isArray(o.terms) && o.terms.length
      ? o.terms.slice(0, 24)
      : [...new Set(tokenize(q))].slice(0, 24);
    const phrase = q.toLowerCase().replace(/\s+/g, '');

    // 直接用 parseDoc/recomputeDerived 缓存好的小写副本，不再每次按键重建全库副本（2.7）
    const strongCache = docsArr.map((d) => (d._lcStrong != null ? d._lcStrong : (d.strongText || '').toLowerCase()));
    const bodyCache = docsArr.map((d) => (d._lcBody != null ? d._lcBody : (d.bodyText || '').toLowerCase()));
    const scores = new Float64Array(N);
    const hitCount = new Uint8Array(N);

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
      const idf = Math.min(Math.log(1 + N / df), idfCap);
      const damp = df > N * 0.7 ? 0.25 : 1;
      for (let i = 0; i < N; i++) {
        const w = logTf
          ? Math.log1p(cs[i]) * Math.max(0, wStrong) + Math.log1p(cb[i]) * Math.max(0, wBody)
          : cs[i] * wStrong + cb[i] * wBody;
        if (w) {
          scores[i] += w * idf * damp;
          hitCount[i]++;
        }
      }
    }
    if (phrase && phrase.length >= 2) {
      for (let i = 0; i < N; i++) {
        if (strongCache[i].includes(phrase)) scores[i] += bonusStrong;
        else if (bodyCache[i].includes(phrase)) scores[i] += bonusBody;
      }
    }
    // 面试模式的热词加权：命中领域词的笔记整体抬分
    const hotwords = Array.isArray(o.hotwords) ? o.hotwords : null;
    const hotBoost = Math.max(0, Number(o.hotwordBoost) || 0);
    if (hotwords && hotwords.length && hotBoost) {
      const hws = hotwords.map((h) => String(h).toLowerCase()).filter((h) => h.length >= 2);
      for (let i = 0; i < N; i++) {
        let n = 0;
        for (const hw of hws) {
          if (strongCache[i].includes(hw) || bodyCache[i].includes(hw)) n++;
        }
        if (n) scores[i] += n * hotBoost;
      }
    }

    const idx = docsArr
      .map((_, i) => i)
      .filter((i) => scores[i] > 0 && scores[i] >= minScore)
      .sort((a, b) => scores[b] - scores[a])
      .slice(0, limit || 50);

    return idx.map((i) => {
      const doc = docsArr[i];
      return {
        doc,
        score: Math.round(scores[i]),
        hits: hitCount[i],
        section: this.bestSection(doc, terms, Number(o.headerWeight) || 0),
      };
    });
  }

  /**
   * 混合检索：关键词评分 + 可选语义向量召回，RRF 融合排序。
   * 返回 { results, semantic }；embedding 关闭或不可用时退回纯关键词结果。
   */
  async searchHybrid(query, limit, filter) {
    // 只在需要退回关键词时才算一次，避免同一查询扫全库两遍（2.7）
    const kwFallback = () => ({ results: this.searchLocal(query, limit, filter), semantic: false });
    if (!this.plugin.settings.embeddingEnabled || this._embFailed) return kwFallback();
    let qvec = null;
    try {
      qvec = await this.queryVector(query);
    } catch (e) {
      return kwFallback();
    }
    if (!qvec) return kwFallback();

    const terms = [...new Set(tokenize(query))].slice(0, 12);
    const pool = this.searchLocal(query, Math.max((limit || 50) * 4, 200), filter);
    const sem = this.applyFilter([...this.docs.values()], filter)
      .filter((d) => Array.isArray(d.vector) && d.vector.length === qvec.length)
      .map((d) => ({ doc: d, sim: cosineSim(qvec, d.vector) }))
      .filter((s) => s.sim > 0.2)
      .sort((a, b) => b.sim - a.sim)
      .slice(0, 100);

    const score = new Map();
    const semMap = new Map();
    pool.forEach((r, i) => score.set(r.doc.path, (score.get(r.doc.path) || 0) + 1 / (60 + i)));
    sem.forEach((s, i) => {
      score.set(s.doc.path, (score.get(s.doc.path) || 0) + 1 / (60 + i));
      semMap.set(s.doc.path, s.sim);
    });

    const base = new Map();
    pool.forEach((r) => base.set(r.doc.path, r));
    for (const s of sem) {
      if (!base.has(s.doc.path)) {
        base.set(s.doc.path, { doc: s.doc, score: 0, hits: 0, section: this.bestSection(s.doc, terms) });
      }
    }

    const results = [...score.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit || 50)
      .map(([path, rrf]) => Object.assign({}, base.get(path), { rrf, sem: semMap.get(path) || 0 }));
    return { results, semantic: true };
  }
}

/* ============================ AI 客户端 ============================ */

class AIClient {
  constructor(plugin) {
    this.plugin = plugin;
  }

  get s() {
    return this.plugin.settings;
  }

  buildPayload(messages, opts) {
    const payload = {
      model: this.s.model || 'auto',
      messages,
      temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.3,
      stream: !!opts.stream,
    };
    if (opts.jsonMode && this.s.structuredJsonModeEnabled && !opts.stream) {
      payload.response_format = { type: 'json_object' };
    }
    return payload;
  }

  /** 面试模式用：一次性问答，返回正文字符串。可覆盖模型与超时（面试要快，模型往往与主检索不同）。 */
  chat(messages, opts = {}) {
    const payload = this.buildPayload(messages, { temperature: opts.temperature });
    if (opts.model) payload.model = opts.model;
    // 0 = 不限制：网关不流式返回，调小只会让部分模型把思考过程当正文吐出来
    const maxTokens = Number(opts.maxTokens) || 0;
    if (maxTokens > 0) payload.max_tokens = Math.round(maxTokens);
    return this.request(payload, { timeoutMs: opts.timeoutMs });
  }

  /** Node 原生 http/https 请求（与 metadata-ai 相同方式，无 CORS 限制）。 */
  request(payload, { onDelta, timeoutMs } = {}) {
    timeoutMs = timeoutMs || Math.max(5, Number(this.s.requestTimeoutSeconds) || 180) * 1000;
    return new Promise((resolve, reject) => {
      let url;
      try {
        url = new URL(this.s.baseUrl.replace(/\/+$/, '') + '/chat/completions');
      } catch (e) {
        reject(new Error('API 地址无效：' + this.s.baseUrl));
        return;
      }
      const mod = url.protocol === 'https:' ? https : http;
      const headers = {
        'Content-Type': 'application/json',
        'Accept': onDelta ? 'text/event-stream' : 'application/json',
      };
      if (this.s.apiKey) headers.Authorization = 'Bearer ' + this.s.apiKey;

      let settled = false;
      const done = (fn, val) => { if (!settled) { settled = true; fn(val); } };

      const req = mod.request(url, { method: 'POST', headers, timeout: timeoutMs }, (res) => {
        if (res.statusCode >= 400) {
          let errBody = '';
          res.setEncoding('utf8');
          const fail = () => done(reject, new Error('API 返回 ' + res.statusCode + '：' + errBody.slice(0, 300)));
          res.on('data', (c) => {
            errBody += c;
            // 超长错误页（如 Nginx 的 502/504 HTML）要立即结算并停止读取：
            // res.destroy() 之后不会再有 end/error 事件，Promise 会永远 pending，把界面上的 busy 锁死
            if (errBody.length > 2000) { fail(); res.resume(); }
          });
          res.on('end', fail);
          res.on('error', fail);
          return;
        }
        // http.request 不跟随跳转：3xx 直接报错，否则会读到空 body 静默无结果（2.2）
        if (res.statusCode >= 300) {
          res.setEncoding('utf8');
          res.resume();
          res.on('end', () => done(reject, new Error('API 返回重定向 ' + res.statusCode + '，请检查 Base URL：' + this.s.baseUrl)));
          res.on('error', () => done(reject, new Error('API 返回重定向 ' + res.statusCode + '，请检查 Base URL：' + this.s.baseUrl)));
          return;
        }
        res.setEncoding('utf8');
        if (onDelta) {
          let buf = '';
          let full = '';
          let raw = '';   // 非 SSE 响应兜底用：仅在还没收到增量时留存原始文本
          const handleLine = (rawLine) => {
            const line = String(rawLine).trim();
            if (!line.startsWith('data:')) return;
            const data = line.slice(5).trim();
            if (!data || data === '[DONE]') return;
            try {
              const j = JSON.parse(data);
              const delta = j.choices && j.choices[0] && j.choices[0].delta ? j.choices[0].delta.content : null;
              if (delta) { full += delta; onDelta(delta, full); }
            } catch (e) { /* 忽略无法解析的 SSE 行 */ }
          };
          res.on('data', (chunk) => {
            if (!full) raw += chunk;
            buf += chunk;
            let idx;
            while ((idx = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, idx);
              buf = buf.slice(idx + 1);
              handleLine(line);
            }
          });
          res.on('end', () => {
            // 最后一行可能没有换行符结尾，补处理一次（2.2）
            if (buf) { handleLine(buf); buf = ''; }
            if (full) { done(resolve, full); return; }
            // 网关忽略 stream:true 直接回普通 JSON 时，从 message.content 兜底取正文（2.2）
            const text = raw.trim();
            if (text) {
              try {
                const j = JSON.parse(text);
                const content = j && j.choices && j.choices[0] && j.choices[0].message
                  ? j.choices[0].message.content : null;
                if (typeof content === 'string' && content) { done(resolve, content); return; }
              } catch (e) { /* 不是 JSON，继续报错 */ }
            }
            done(reject, new Error('响应不是 SSE 事件流，且不含 message.content（请检查 Base URL 与网关是否支持 stream）'));
          });
          res.on('error', (e) => done(reject, e));
        } else {
          let body = '';
          res.on('data', (c) => { body += c; });
          res.on('end', () => {
            try {
              const data = JSON.parse(body);
              const content = data && data.choices && data.choices[0] && data.choices[0].message
                ? data.choices[0].message.content : null;
              if (typeof content !== 'string') throw new Error('响应缺少 choices[0].message.content');
              done(resolve, content);
            } catch (e) {
              done(reject, new Error('解析 API 响应失败：' + String(body).slice(0, 200)));
            }
          });
          res.on('error', (e) => done(reject, e));
        }
      });
      req.on('timeout', () => req.destroy(new Error('请求超时（' + Math.round(timeoutMs / 1000) + 's）')));
      req.on('error', (e) => done(reject, e));
      req.write(JSON.stringify(payload));
      req.end();
    });
  }

  async chat(messages, opts = {}) {
    return this.request(this.buildPayload(messages, opts), { timeoutMs: opts.timeoutMs });
  }

  async chatStream(messages, opts, onDelta) {
    return this.request(this.buildPayload(messages, Object.assign({}, opts, { stream: true })), { onDelta, timeoutMs: opts && opts.timeoutMs });
  }

  /** OpenAI 兼容 /embeddings：入参字符串数组，返回向量数组（顺序对应）。 */
  embeddings(inputs) {
    let url;
    try {
      url = new URL(this.s.baseUrl.replace(/\/+$/, '') + '/embeddings');
    } catch (e) {
      return Promise.reject(new Error('API 地址无效：' + this.s.baseUrl));
    }
    const mod = url.protocol === 'https:' ? https : http;
    const headers = { 'Content-Type': 'application/json' };
    if (this.s.apiKey) headers.Authorization = 'Bearer ' + this.s.apiKey;
    const payload = JSON.stringify({ model: this.plugin.settings.embeddingModel || 'auto', input: inputs });
    const timeoutMs = Math.max(5, Number(this.s.requestTimeoutSeconds) || 180) * 1000;
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };
      const req = mod.request(url, { method: 'POST', headers, timeout: timeoutMs }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            if (res.statusCode >= 400) throw new Error((data && data.error && data.error.message) || 'HTTP ' + res.statusCode);
            const arr = (data.data || []).map((x) => x.embedding);
            if (!Array.isArray(arr) || arr.length !== inputs.length) throw new Error('embedding 返回数量不匹配');
            done(resolve, arr);
          } catch (e) {
            done(reject, e);
          }
        });
        res.on('error', (e) => done(reject, e));
      });
      req.on('timeout', () => req.destroy(new Error('embedding 请求超时')));
      req.on('error', (e) => done(reject, e));
      req.write(payload);
      req.end();
    });
  }

  /** AI 精排：把候选列表交给模型重排，返回 [{cand, score, reason}]。 */
  async rerank(query, candidates) {
    const s = this.s;
    const lines = candidates.map((c, i) => {
      const summary = (c.doc.summaryShort || c.doc.summaryLong.slice(0, 100) || '').slice(0, 150);
      return `${i + 1}. path: ${c.doc.path}\n   标题: ${c.doc.title}\n   标签: ${c.doc.tags.join('、') || '无'}\n   摘要: ${summary || '无'}`;
    });
    const user = `【用户问题】\n${query}\n\n【候选文章】（共 ${candidates.length} 条）\n${lines.join('\n')}\n\n${RERANK_FORMAT_SPEC}`;
    const content = await this.chat(
      [{ role: 'system', content: s.rerankHarness }, { role: 'user', content: user }],
      { temperature: 0, jsonMode: true }
    );
    const parsed = extractJson(content, s.jsonRepairEnabled);
    const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed && parsed.results) ? parsed.results : [];
    const byPath = new Map(candidates.map((c) => [c.doc.path, c]));
    const byBase = new Map(candidates.map((c) => [c.doc.title.toLowerCase(), c]));
    const ranked = [];
    const seen = new Set();
    for (const r of arr) {
      const cand = matchCandidate(byPath, byBase, r && r.path);
      if (!cand || seen.has(cand)) continue;
      seen.add(cand);
      ranked.push({
        cand,
        score: Math.max(0, Math.min(100, Math.round(Number(r.score) || 0))),
        reason: String((r && r.reason) || '').slice(0, 80),
      });
    }
    ranked.sort((a, b) => b.score - a.score);
    return ranked;
  }

  /** 组装问答资料块：[n]《标题》（路径）+ 相关章节片段。 */
  buildQaBlocks(sources, charsPerDoc) {
    const blocks = [];
    for (const r of sources) {
      const parts = [];
      if (r.doc.sections.length) {
        const intro = r.doc.sections[0];
        const best = r.section && r.section !== intro ? r.section : null;
        parts.push(intro);
        if (best) parts.push(best);
      }
      let text = parts.map((p) => (p.h ? '【' + p.h + '】\n' : '') + p.t).join('\n……\n').trim();
      if (!text) text = r.doc.summaryShort || r.doc.summaryLong || '（无正文）';
      text = text.slice(0, charsPerDoc);
      blocks.push(`[${blocks.length + 1}] 《${r.doc.title}》（${r.doc.path}）\n${text}`);
    }
    return blocks;
  }

  async answer(question, blocks) {
    const user = `【资料】\n${blocks.join('\n\n')}\n\n【用户问题】\n${question}`;
    return this.chat(
      [{ role: 'system', content: this.s.qaHarness }, { role: 'user', content: user }],
      { temperature: 0.3 }
    );
  }
}

/* ============================ 检索弹窗 ============================ */

class AISearchModal extends Modal {
  constructor(plugin) {
    super(plugin.app);
    this.plugin = plugin;
  }

  onOpen() {
    this.modalEl.addClass('xyais-search-modal');
    this.component = new Component();
    this.component.load();
    this.results = [];
    this.reranked = false;
    this._busy = false;
    this._qaBusy = false;
    this._seq = 0;
    this.semanticUsed = false;

    const content = this.contentEl;
    content.empty();

    this.inputEl = el('input', 'xyais-input');
    this.inputEl.type = 'text';
    this.inputEl.placeholder = '输入问题或关键词…（Enter=AI 精排，Ctrl+Enter=AI 问答）';

    const toolbar = el('div', 'xyais-toolbar');
    this.statusEl = el('span', 'xyais-status', `本地索引 ${this.plugin.index.docs.size} 篇`);
    this.btnRebuild = el('button', 'xyais-icon-btn');
    setIcon(this.btnRebuild, 'refresh-cw');
    this.btnRebuild.setAttribute('aria-label', '重建索引');
    this.btnRerank = el('button', 'mod-cta', 'AI 精排');
    this.btnQa = el('button', '', 'AI 回答');
    if (!this.plugin.settings.rerankEnabled) this.btnRerank.hide();
    if (!this.plugin.settings.qaEnabled) this.btnQa.hide();
    toolbar.append(this.statusEl, this.btnRebuild, this.btnRerank, this.btnQa);

    this.answerEl = el('div', 'xyais-answer');
    this.answerEl.hide();
    this.filterEl = el('div', 'xyais-filters');
    this.tagSelect = el('select', 'dropdown');
    this.depthSelect = el('select', 'dropdown');
    this.tagSelect.onchange = () => this.localSearch();
    this.depthSelect.onchange = () => this.localSearch();
    this.refreshFilterOptions();
    this.resultsEl = el('div', 'xyais-results');
    const footer = el('div', 'xyais-footer', 'Enter：AI 精排　·　Ctrl+Enter：AI 问答　·　点击结果打开文章并跳转章节　·　Esc：关闭');

    content.append(this.inputEl, toolbar, this.filterEl, this.answerEl, this.resultsEl, footer);

    this.btnRerank.onclick = () => this.runRerank();
    this.btnQa.onclick = () => this.runQa();
    this.btnRebuild.onclick = async () => {
      this.setStatus('重建索引中…');
      await this.plugin.rebuildIndex(true);
      this.setStatus(`本地索引 ${this.plugin.index.docs.size} 篇`);
      this.refreshFilterOptions();
      this.localSearch();
    };

    // 防抖定时器挂在实例上，便于精排/关闭时取消（2.4、2.6）
    this._debTimer = null;
    this._lastLocalQuery = '';
    this.inputEl.addEventListener('input', () => {
      clearTimeout(this._debTimer);
      this._debTimer = setTimeout(() => this.localSearch(), 220);
    });
    this.inputEl.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        if (ev.ctrlKey || ev.metaKey) this.runQa();
        else this.runRerank();
      }
    });

    if (this.plugin.lastQuery) this.inputEl.value = this.plugin.lastQuery;
    setTimeout(() => this.inputEl.focus(), 50);
    this.localSearch();

    // 语义向量懒构建：开启开关但索引里还没有向量时，后台补建
    if (this.plugin.settings.embeddingEnabled && this.plugin.index.docs.size) {
      const anyVec = [...this.plugin.index.docs.values()].some((d) => Array.isArray(d.vector));
      if (!anyVec && !this.plugin.index._embFailed) {
        this.setStatus('语义向量构建中…');
        this.plugin.index.ensureVectors((d, n) => this.setStatus(`语义向量构建中 ${d}/${n}…`))
          .then(() => {
            this.setStatus(`本地索引 ${this.plugin.index.docs.size} 篇`);
            this.localSearch();
          })
          .catch((e) => {
            new Notice('AI 检索：' + e.message + '（已退回关键词检索）', 8000);
            this.setStatus('语义不可用，已退回关键词检索');
          });
      }
    }
  }

  onClose() {
    clearTimeout(this._debTimer);
    this.plugin.lastQuery = this.inputEl ? this.inputEl.value : '';
    if (this.component) this.component.unload();
  }

  setStatus(text) {
    if (this.statusEl) this.statusEl.textContent = text;
  }

  currentTerms() {
    return [...new Set(tokenize(this.inputEl ? this.inputEl.value : ''))].slice(0, 12);
  }

  refreshFilterOptions() {
    if (!this.tagSelect || !this.depthSelect) return;
    this.tagSelect.empty();
    this.tagSelect.appendChild(new Option('标签：全部', ''));
    for (const t of this.plugin.index.topTags(60)) this.tagSelect.appendChild(new Option('标签：' + t, t));
    this.depthSelect.empty();
    for (const pair of [['深度：全部', '0'], ['深度 ≥20', '20'], ['深度 ≥40', '40'], ['深度 ≥60', '60']]) {
      this.depthSelect.appendChild(new Option(pair[0], pair[1]));
    }
    this.filterEl.style.display = this.plugin.index.docs.size ? '' : 'none';
  }

  getFilters() {
    return {
      tag: this.tagSelect ? this.tagSelect.value : '',
      minDepth: this.depthSelect ? Number(this.depthSelect.value) || 0 : 0,
    };
  }

  async localSearch() {
    const q = this.inputEl.value.trim();
    this.reranked = false;
    this.answerEl.hide();
    this.answerEl.empty();
    if (!q) {
      this.results = [];
      this._lastLocalQuery = '';
      this.resultsEl.empty();
      this.resultsEl.appendChild(el('div', 'xyais-empty', '输入关键词或自然语言问题开始检索'));
      return;
    }
    const seq = ++this._seq;
    this.setStatus('检索中…');
    let out;
    try {
      out = await this.plugin.index.searchHybrid(q, this.plugin.settings.localRecallLimit, this.getFilters());
    } catch (e) {
      if (seq !== this._seq) return;
      out = { results: this.plugin.index.searchLocal(q, this.plugin.settings.localRecallLimit, this.getFilters()), semantic: false };
    }
    // 输入已变化或已有更新的检索/精排结果时丢弃本次结果，避免覆盖新问题（2.4）
    if (seq !== this._seq || q !== (this.inputEl ? this.inputEl.value.trim() : '')) return;
    this.results = out.results;
    this._lastLocalQuery = q;
    this.semanticUsed = out.semantic;
    this.renderResults();
    this.setStatus(`${out.semantic ? '语义+关键词融合召回' : '本地召回'} ${this.results.length} 条 · Enter 进行 AI 精排`);
  }

  renderResults() {
    this.resultsEl.empty();
    if (!this.results.length) {
      if (this.inputEl.value) this.resultsEl.appendChild(el('div', 'xyais-empty', '没有匹配的文章'));
      return;
    }
    for (const r of this.results) this.resultsEl.appendChild(this.buildRow(r));
  }

  buildRow(r) {
    const row = el('div', 'xyais-row');
    const main = el('div', 'xyais-row-title');
    if (r.aiScore != null) {
      const b = el('span', 'xyais-ai-badge', 'AI');
      b.title = r.reason ? 'AI 理由：' + r.reason : 'AI 精排结果';
      main.appendChild(b);
    }
    if (r.sem && r.sem >= 0.45 && r.aiScore == null) {
      const sb = el('span', 'xyais-ai-badge xyais-sem-badge', '语义');
      sb.title = '语义相似度 ' + Math.round(r.sem * 100) + '%';
      main.appendChild(sb);
    }
    main.appendChild(el('span', '', r.doc.title));
    // 0.3.3：结果行带状态灯/时效灯——渲染时读 metadataCache，索引结构无需改动。
    const vfile = this.plugin.app.vault.getAbstractFileByPath(r.doc.path);
    const vfm = vfile ? (this.plugin.app.metadataCache.getFileCache(vfile)?.frontmatter || null) : null;
    if (vfm) {
      const stripLight = (s) => String(s ?? '').trim().replace(/^[🟢🔴🟡⚪]\s*/u, '').toLowerCase();
      const status = stripLight(vfm.status);
      if (status) {
        const chip = el('span', 'xyais-chip xyais-light-chip', status === 'done' ? '🟢' : status === 'undone' ? '🔴' : '⚪');
        chip.title = `status: ${String(vfm.status || '').trim()}`;
        main.appendChild(chip);
      }
      const fresh = String(vfm.AI_freshness || '').trim();
      if (fresh) {
        const chip2 = el('span', 'xyais-chip xyais-light-chip', fresh.slice(0, 2));
        chip2.title = `AI_freshness: ${fresh}`;
        main.appendChild(chip2);
      }
    }
    main.appendChild(el('span', 'xyais-score', String(r.aiScore != null ? r.aiScore : (r.sem && !r.score ? Math.round(r.sem * 100) + '%' : r.score))));
    row.appendChild(main);
    row.appendChild(el('div', 'xyais-row-path', r.doc.path));
    if (r.doc.tags.length) {
      const tags = el('div', 'xyais-row-tags');
      for (const t of r.doc.tags.slice(0, 8)) tags.appendChild(el('span', 'xyais-chip', t));
      row.appendChild(tags);
    }
    const terms = this.currentTerms();
    // 纯元数据笔记（正文为空、内容全在 frontmatter 的 AI 摘要里）没有 section，
    // 不能因此把结果行渲染成空白——用摘要兜底，否则看起来就像「索引是空的」。
    let snippet = makeSnippet(r.section, terms);
    if (!snippet) snippet = (r.doc.summaryShort || r.doc.summaryLong || '').slice(0, 160);
    if (snippet) {
      const sn = el('div', 'xyais-row-snippet');
      sn.innerHTML = highlight(snippet, terms);
      row.appendChild(sn);
    }
    if (r.section && r.section.h) row.appendChild(el('div', 'xyais-row-path', '§ ' + r.section.h));
    if (r.reason) row.appendChild(el('div', 'xyais-row-reason', '💡 ' + r.reason));
    row.onclick = () => this.openResult(r);
    return row;
  }

  async runRerank() {
    if (this._busy) return;
    const q = this.inputEl.value.trim();
    if (!q) { new Notice('请先输入检索内容'); return; }
    if (!this.plugin.settings.rerankEnabled) { new Notice('AI 精排已在设置中关闭'); return; }
    if (!this.plugin.index.docs.size) { new Notice('索引为空：点工具栏 🔄 重建，或设置页底部「重建索引」'); return; }
    // 先取消待触发的防抖检索，并确保候选属于自己的查询（2.4）
    clearTimeout(this._debTimer);
    if (!this.results.length || this._lastLocalQuery !== q) await this.localSearch();
    // localSearch 期间输入可能又变了（它自己会提前返回），此时 q 与候选都已过期，不要再发精排请求（2.4）
    if (q !== (this.inputEl ? this.inputEl.value.trim() : '')) return;
    if (this.results.length < 2) { new Notice('本地候选不足，无需精排'); return; }

    this._busy = true;
    this.btnRerank.disabled = true;
    this.btnRerank.textContent = '精排中…';
    try {
      const ranked = await this.plugin.client.rerank(q, this.results);
      // 精排期间输入被改动：丢弃这次结果，避免把旧候选的排序贴到新问题上（2.4）
      if (q !== (this.inputEl ? this.inputEl.value.trim() : '')) {
        this.setStatus('输入已变化，已忽略过期的精排结果');
        return;
      }
      const used = new Set();
      const hits = [];
      for (const r of ranked) {
        const c = r.cand;
        if (used.has(c)) continue;
        used.add(c);
        c.reason = r.reason;
        c.aiScore = r.score;
        hits.push(c);
      }
      const rest = this.results.filter((c) => !used.has(c));
      const show = this.plugin.settings.rerankShowLimit;
      this.results = hits.slice(0, show).concat(rest).slice(0, Math.max(show, 15));
      this.reranked = hits.length > 0;
      // 作废仍在飞行中的本地检索，避免它回来后整片覆盖 AI 排序（2.4）
      this._seq++;
      this.renderResults();
      this.setStatus(hits.length
        ? `AI 精排完成：${hits.length} 条命中 · 点击结果打开文章`
        : 'AI 精排无有效结果，已保留本地排序');
      if (!hits.length) new Notice('AI 未返回有效结果，已保留本地排序');
    } catch (e) {
      new Notice('AI 精排失败：' + e.message, 8000);
      this.setStatus('AI 精排失败（已保留本地结果）');
    } finally {
      this._busy = false;
      this.btnRerank.disabled = false;
      this.btnRerank.textContent = 'AI 精排';
    }
  }

  async runQa() {
    if (this._qaBusy) return;
    const s = this.plugin.settings;
    const q = this.inputEl.value.trim();
    if (!q) { new Notice('请先输入问题'); return; }
    if (!s.qaEnabled) { new Notice('AI 问答已在设置中关闭'); return; }
    if (!this.plugin.index.docs.size) { new Notice('索引为空：点工具栏 🔄 重建，或设置页底部「重建索引」'); return; }

    this._qaBusy = true;
    this.btnQa.disabled = true;
    this.btnQa.textContent = '生成中…';
    try {
      if (!this.results.length || this._lastLocalQuery !== q) await this.localSearch();
      if (!this.results.length) { new Notice('没有找到相关文章，无法回答'); return; }
      if (!this.reranked && s.rerankEnabled && this.results.length >= 2) await this.runRerank();

      const sources = this.results.slice(0, s.qaContextDocs);
      const blocks = this.plugin.client.buildQaBlocks(sources, s.qaContextCharsPerDoc);

      this.answerEl.empty();
      this.answerEl.show();
      const head = el('div', 'xyais-answer-title');
      head.appendChild(el('span', '', 'AI 回答'));
      const spin = el('span', 'xyais-status', '生成中… 0s');
      head.appendChild(spin);
      const bodyMd = el('div', 'xyais-answer-body');
      const srcRow = el('div', 'xyais-sources');
      this.answerEl.append(head, bodyMd, srcRow);

      const t0 = Date.now();
      const timer = setInterval(() => { spin.textContent = `生成中… ${Math.round((Date.now() - t0) / 1000)}s`; }, 1000);

      let acc = '';
      let lastRender = 0;
      let rendering = false;
      const renderNow = async (force) => {
        if (rendering) return;
        if (!force && Date.now() - lastRender < 900) return;
        rendering = true;
        lastRender = Date.now();
        try { await this.renderMarkdownSafe(acc, bodyMd); } finally { rendering = false; }
      };
      const waitRender = async () => { while (rendering) await sleep(60); };

      // 请求 try/catch 只包 chatStream：后处理（引用装饰、来源标签）出错不应抹掉已生成的回答（2.8）
      let final = '';
      try {
        final = await this.plugin.client.chatStream(
          [
            { role: 'system', content: s.qaHarness },
            { role: 'user', content: `【资料】\n${blocks.join('\n\n')}\n\n【用户问题】\n${q}` },
          ],
          { temperature: 0.3 },
          (delta, full) => { acc = full; void renderNow(false); }
        );
      } catch (e) {
        clearInterval(timer);
        spin.textContent = '失败';
        const errEl = el('div', 'xyais-error', 'AI 请求失败：' + e.message);
        bodyMd.empty();
        bodyMd.appendChild(errEl);
        return;
      }
      if (!acc && final) acc = final;
      clearInterval(timer);
      await waitRender();
      await renderNow(true);
      await waitRender();
      spin.textContent = `完成（${Math.round((Date.now() - t0) / 1000)}s）`;
      try {
        this.decorateCitations(bodyMd, sources);
      } catch (e) {
        console.warn('AI 检索：引用装饰失败', e);
      }
      for (let i = 0; i < sources.length; i++) {
        try {
          const chip = el('a', 'xyais-source-chip', `[${i + 1}] ${sources[i].doc.title}`);
          chip.onclick = () => this.openResult(sources[i]);
          srcRow.appendChild(chip);
        } catch (e) {
          console.warn('AI 检索：来源标签渲染失败', e);
        }
      }
    } finally {
      this._qaBusy = false;
      this.btnQa.disabled = false;
      this.btnQa.textContent = 'AI 回答';
    }
  }

  async renderMarkdownSafe(md, container) {
    container.empty();
    try {
      if (MarkdownRenderer && typeof MarkdownRenderer.render === 'function') {
        await MarkdownRenderer.render(this.plugin.app, md, container, '', this.component);
      } else {
        await MarkdownRenderer.renderMarkdown(md, container, '', this.component);
      }
    } catch (e) {
      container.textContent = md;
    }
  }

  /** 把 [n] 文本替换为可点击引用。 */
  decorateCitations(rootEl, sources) {
    const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT);
    const targets = [];
    while (walker.nextNode()) {
      if (/\[\d+\]/.test(walker.currentNode.textContent)) targets.push(walker.currentNode);
    }
    for (const node of targets) {
      // DOM 可能已被 Markdown 渲染替换，parentNode 为空时跳过而不是抛错（2.8）
      if (!node.parentNode) continue;
      const frag = document.createDocumentFragment();
      const parts = node.textContent.split(/(\[\d+\])/g);
      for (const part of parts) {
        const m = part.match(/^\[(\d+)\]$/);
        if (m) {
          const n = Number(m[1]);
          const a = el('a', 'xyais-cite', `[${n}]`);
          const src = sources[n - 1];
          if (src) a.onclick = () => this.openResult(src);
          frag.appendChild(a);
        } else if (part) {
          frag.appendChild(document.createTextNode(part));
        }
      }
      node.parentNode.replaceChild(frag, node);
    }
  }

  async openResult(r) {
    const file = this.plugin.app.vault.getAbstractFileByPath(r.doc.path);
    if (!(file instanceof TFile)) { new Notice('文件不存在：' + r.doc.path); return; }
    this.close();
    const leaf = this.plugin.app.workspace.getLeaf(false);
    await leaf.openFile(file);
    const view = leaf.view;
    if (!r.section || !view || typeof view.getViewType !== 'function' || view.getViewType() !== 'markdown') return;
    // 索引里的行号可能已过期：按当前内容用标题重新定位，并夹到文件长度内（2.11）
    let line = Number.isInteger(r.section.l) ? r.section.l : 0;
    try {
      const lines = (await this.plugin.app.vault.cachedRead(file)).split(/\r?\n/);
      if (lines.length) {
        const head = String(r.section.h || '').split(' / ').pop();
        if (head) {
          const idx = lines.findIndex((l) => l.trim().endsWith(head));
          if (idx >= 0) line = idx;
        }
        line = Math.max(0, Math.min(line, lines.length - 1));
      }
    } catch (e) { /* 读不到内容时沿用索引行号 */ }
    try {
      // 只在源码模式操作 editor；预览模式走 ephemeralState 跳转（2.11）
      if (typeof view.getMode === 'function' && view.getMode() === 'source' && view.editor) {
        view.editor.setCursor({ line, ch: 0 });
        view.editor.scrollIntoView({ from: { line: Math.max(0, line - 2), ch: 0 }, to: { line: line + 2, ch: 0 } }, true);
      } else if (typeof leaf.setEphemeralState === 'function') {
        leaf.setEphemeralState({ line, scroll: line });
      }
    } catch (e) { /* 跳转失败不影响打开 */ }
  }
}

/* ============================ 面试模式（1.0.0 由 interview-rag 并入） ============================ */

/**
 * 按长度裁剪但尽量切在句子/行边界：硬 slice 会把答案断在「否则 AOF 会覆盖掉要」这种半句上，
 * 悬浮卡里看着像出错。优先回退到 cap 之前的最后一个句末标点或换行，实在找不到才硬截。
 */
function ivSmartClip(text, cap) {
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
function ivBuildLocalAnswer(question, hits, s) {
  if (!hits.length) return '知识库中未找到相关内容。';
  const terms = queryTerms(question).slice(0, 12);
  const lines = [];
  const n = Math.max(1, Number(s.ivMaxSources) || 4);
  for (let i = 0; i < hits.length && i < n; i++) {
    const h = hits[i];
    // plain=true：去掉 Markdown 标记，卡片上的句子要能直接照着念
    const snip = makeSnippet(h.section, terms, Number(s.ivSnippetRadius) || 60, true)
      || h.doc.summaryShort || (h.doc.summaryLong || '').slice(0, 120) || '';
    lines.push((i + 1) + '. 【' + h.doc.title + '】' + snip);
    if (s.ivShowSourcePaths) lines.push('   └ ' + h.doc.path);
  }
  const out = (s.ivAnswerTitle ? s.ivAnswerTitle + '：\n' : '') + lines.join('\n');
  const cap = Math.max(100, Number(s.ivMaxAnswerChars) || 600);
  return ivSmartClip(out, cap);
}

/**
 * ragfile 桥接：监听 OBS 侧 bridge.py 写的 query.json，把 answer.json 写回去。
 *
 * 桥接契约见 D:\obs-interview\交接-RAG握手对接.md：
 *   query.json  = {"id": <毫秒时间戳int>, "question": "..."}
 *   answer.json = {"id": <同id>, "answer": "...", "sources": [{"path","title"}]}
 *              或 {"id": <同id>, "error": "..."}
 *   读取/写入均要求原子性（tmp + rename），UTF-8 无 BOM。
 *
 * ⚠️ 这段是与外部 Python 程序的握手协议，任何字段名/编码/原子写方式都不要改。
 */
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
    const dir = this.plugin.settings.ivRagDir;
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* 已存在/不可建则靠后续容错 */ }
    // 开机时已存在的旧请求视为已处理：bridge 15s 就放弃了，答陈年问题没有意义
    const cur = this.readQuery();
    if (cur && Number.isFinite(cur.id)) this.lastId = cur.id;
    try {
      // persistent:false → 不阻止进程退出；监听失败也不影响轮询兜底
      this.watcher = fs.watch(dir, { persistent: false }, () => this.scheduleCheck());
    } catch (e) {
      console.warn('[AI 检索] fs.watch 不可用，仅用轮询:', e.message);
      this.watcher = null;
    }
    const ms = Math.max(100, Number(this.plugin.settings.ivPollMs) || 300);
    // fs.watch 已就绪时，轮询只是兜底（watch 会立刻触发 scheduleCheck），
    // 没必要仍按 pollMs 全速跑——默认 300ms 等于每秒 3 次 readFileSync 空转。
    // 监听失败时才退回 pollMs 的原始节奏。
    const effectiveMs = this.watcher ? Math.max(ms, 2000) : ms;
    this.timer = setInterval(() => this.scheduleCheck(), effectiveMs);
    this.scheduleCheck();
    console.log(`[AI 检索] ragfile 监听已启动: ${dir}（轮询 ${effectiveMs}ms${this.watcher ? '，watch 为主' : '，仅轮询'}）`);
  }

  stop() {
    this.stopped = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.watcher) {
      try { this.watcher.close(); } catch (e) { /* 忽略 */ }
      this.watcher = null;
    }
    console.log('[AI 检索] ragfile 监听已停止');
  }

  queryPath() { return path.join(this.plugin.settings.ivRagDir, 'query.json'); }
  answerPath() { return path.join(this.plugin.settings.ivRagDir, 'answer.json'); }

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
      .catch((e) => console.warn('[AI 检索] 监听循环异常:', e))
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
        Promise.resolve(this.plugin.ivProcessQuery(question)),
        Math.max(2000, Number(this.plugin.settings.ivAnswerDeadlineMs) || 10000));
      payload = { id: q.id, answer: r.answer, sources: r.sources || [] };
    } catch (e) {
      payload = { id: q.id, error: String((e && e.message) || e) };
    }
    try {
      this.writeAnswer(payload);
    } catch (e) {
      console.error('[AI 检索] answer.json 写入失败:', e);
      return;
    }
    const dt = Date.now() - t0;
    console.log(`[AI 检索] query#${q.id} 已应答（${dt}ms）${payload.error ? ' error=' + payload.error : ''}`);
    if (typeof this.plugin.ivOnBridgeAnswer === 'function') {
      try { this.plugin.ivOnBridgeAnswer(q, payload, dt); } catch (e) { /* 界面刷新失败不影响桥接 */ }
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

/* ============ 面试控制台（不依赖 bridge 调参/试答用） ============ */

class IvTestModal extends Modal {
  constructor(plugin) {
    super(plugin.app);
    this.plugin = plugin;
  }

  onOpen() {
    this.modalEl.addClass('xivr-modal');
    const content = this.contentEl;
    content.empty();

    content.appendChild(el('h3', '', '面试问答控制台'));
    this.statusEl = el('div', 'xivr-hint');
    content.appendChild(this.statusEl);
    this.refreshStatusLine();

    const s = this.plugin.settings;
    new Setting(contentEl)
      .setName('直答模式（代替我回答）')
      .setDesc('开启后 AI 以第一人称口语代替你回答，悬浮卡上直接是能照着说的话；网关离线自动退回要点')
      .addToggle((t) => t.setValue(s.ivSpokenEnabled).onChange(async (v) => {
        s.ivSpokenEnabled = v; await this.plugin.saveSettings(); this.plugin.refreshStatusBar(); this.refreshStatusLine();
      }));
    new Setting(contentEl)
      .setName('ragfile 监听（接收 bridge 转写提问）')
      .setDesc('面试时保持开启；关掉后 bridge 的问题将无人应答（15s 超时上错误卡）')
      .addToggle((t) => t.setValue(s.ivBridgeEnabled).onChange(async (v) => {
        s.ivBridgeEnabled = v; await this.plugin.saveSettings();
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
    const on = s.ivBridgeEnabled && this.plugin.bridge && !this.plugin.bridge.stopped;
    this.statusEl.textContent = (on ? '● 监听中' : '○ 监听已停')
      + ' · 索引 ' + (this.plugin.index ? this.plugin.index.docs.size : 0) + ' 篇'
      + ' · 直答' + (s.ivSpokenEnabled ? '开' : '关');
  }

  async run(raw) {
    const q = String(raw || '').trim();
    const box = this.resultEl;
    box.empty();
    if (!q) return;
    const t0 = Date.now();
    box.appendChild(el('div', 'xivr-meta', '检索中…'));
    try {
      const r = await this.plugin.ivProcessQuery(q);
      const dt = Date.now() - t0;
      box.empty();
      const usedMap = { spoken: '直答（第一人称）', ai: 'AI 精答', local: '本地要点' };
      const used = usedMap[(this.plugin._ivDebug && this.plugin._ivDebug.used) || 'local'];
      const hitN = this.plugin._ivDebug && this.plugin._ivDebug.hits ? this.plugin._ivDebug.hits.length : 0;
      box.appendChild(el('div', 'xivr-meta', `${used} · 召回 ${hitN} 条 · ${dt}ms`));
      box.appendChild(el('div', '', r.answer));
      box.appendChild(el('div', 'xivr-src', r.sources.length
        ? '来源：' + r.sources.map((s) => s.title).join('；')
        : '来源：（无命中）'));
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

class AISearchSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { contentEl } = this;
    contentEl.empty();
    const s = this.plugin.settings;
    let ivDetails = null;   // 面试段折叠容器，在下方创建；导航按钮靠它跳转

    /* 两段设置加起来 50+ 项，给个跳转，省得靠滚轮找 */
    const navBar = contentEl.createDiv('xyas-nav');
    const jumpBtn = navBar.createEl('button', { text: '↓ 面试问答设置', cls: 'xyas-nav-btn' });
    jumpBtn.onclick = () => {
      if (!ivDetails) return;
      ivDetails.open = true;
      ivDetails.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };

    new Setting(contentEl).setName('API 接口').setHeading();
    new Setting(contentEl)
      .setName('API Base URL')
      .setDesc('OpenAI 兼容接口地址，与 AI 元数据插件保持一致')
      .addText((t) => t.setValue(s.baseUrl).onChange(async (v) => { s.baseUrl = v.trim(); await this.plugin.saveSettings(); }));
    new Setting(contentEl)
      .setName('API Key')
      .setDesc('本地网关通常可留空')
      .addText((t) => {
        t.inputEl.type = 'password';
        t.setValue(s.apiKey).onChange(async (v) => { s.apiKey = v.trim(); await this.plugin.saveSettings(); });
      });
    new Setting(contentEl)
      .setName('模型')
      .setDesc('与 AI 元数据插件使用同一个模型路由')
      .addText((t) => t.setValue(s.model).onChange(async (v) => { s.model = v.trim(); await this.plugin.saveSettings(); }));
    new Setting(contentEl)
      .setName('请求超时（秒）')
      .addText((t) => t.setValue(String(s.requestTimeoutSeconds)).onChange(async (v) => {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) { s.requestTimeoutSeconds = Math.round(n); await this.plugin.saveSettings(); }
      }));
    new Setting(contentEl)
      .setName('JSON 模式（response_format）')
      .setDesc('精排请求附带 response_format: json_object；若网关不支持请关闭')
      .addToggle((t) => t.setValue(s.structuredJsonModeEnabled).onChange(async (v) => { s.structuredJsonModeEnabled = v; await this.plugin.saveSettings(); }));
    new Setting(contentEl)
      .setName('JSON 修复')
      .setDesc('AI 返回的 JSON 混入前后缀时自动截取花括号内容重试')
      .addToggle((t) => t.setValue(s.jsonRepairEnabled).onChange(async (v) => { s.jsonRepairEnabled = v; await this.plugin.saveSettings(); }));

    new Setting(contentEl).setName('检索').setHeading();
    new Setting(contentEl)
      .setName('白名单目录')
      .setDesc('只检索这些目录下的文章（默认 my_blog/00_docs，支持逗号分隔多个）；修改后请点击下方“重建索引”')
      .addText((t) => t.setValue(s.whitelistFolder).onChange(async (v) => { s.whitelistFolder = v.trim(); await this.plugin.saveSettings(); }));
    new Setting(contentEl)
      .setName('包含子目录')
      .addToggle((t) => t.setValue(s.includeSubfolders).onChange(async (v) => { s.includeSubfolders = v; await this.plugin.saveSettings(); }));
    new Setting(contentEl)
      .setName('本地召回候选数')
      .setDesc('进入 AI 精排的本地候选上限')
      .addSlider((t) => t.setLimits(10, 100, 5).setValue(s.localRecallLimit).setDynamicTooltip()
        .onChange(async (v) => { s.localRecallLimit = v; await this.plugin.saveSettings(); }));
    new Setting(contentEl)
      .setName('语义向量召回（Embedding）')
      .setDesc('开启后调用 /embeddings 构建向量并与关键词融合排序；网关不支持时自动退回关键词检索。切换模型或重建索引后向量会重算')
      .addToggle((t) => t.setValue(s.embeddingEnabled).onChange(async (v) => {
        s.embeddingEnabled = v;
        this.plugin.index._embFailed = false;
        await this.plugin.saveSettings();
      }));
    new Setting(contentEl)
      .setName('Embedding 模型')
      .setDesc('与聊天模型可以不同；改后旧向量自动失效并重建')
      .addText((t) => t.setValue(s.embeddingModel).onChange(async (v) => { s.embeddingModel = v.trim(); await this.plugin.saveSettings(); }));
    new Setting(contentEl)
      .setName('Embedding 批量大小')
      .addSlider((t) => t.setLimits(4, 64, 4).setValue(s.embeddingBatchSize).setDynamicTooltip()
        .onChange(async (v) => { s.embeddingBatchSize = v; await this.plugin.saveSettings(); }));
    new Setting(contentEl)
      .setName('AI 精排')
      .setDesc('Enter 时调用模型对候选重排')
      .addToggle((t) => t.setValue(s.rerankEnabled).onChange(async (v) => { s.rerankEnabled = v; await this.plugin.saveSettings(); }));
    new Setting(contentEl)
      .setName('AI 精排展示条数')
      .addSlider((t) => t.setLimits(5, 20, 1).setValue(s.rerankShowLimit).setDynamicTooltip()
        .onChange(async (v) => { s.rerankShowLimit = v; await this.plugin.saveSettings(); }));

    new Setting(contentEl).setName('AI 问答').setHeading();
    new Setting(contentEl)
      .setName('启用 AI 问答')
      .setDesc('基于精排前列文章的相关章节做流式问答，回答带可点击引用')
      .addToggle((t) => t.setValue(s.qaEnabled).onChange(async (v) => { s.qaEnabled = v; await this.plugin.saveSettings(); }));
    new Setting(contentEl)
      .setName('问答引用文章数')
      .addSlider((t) => t.setLimits(3, 10, 1).setValue(s.qaContextDocs).setDynamicTooltip()
        .onChange(async (v) => { s.qaContextDocs = v; await this.plugin.saveSettings(); }));
    new Setting(contentEl)
      .setName('单篇片段字符上限')
      .addSlider((t) => t.setLimits(500, 3000, 100).setValue(s.qaContextCharsPerDoc).setDynamicTooltip()
        .onChange(async (v) => { s.qaContextCharsPerDoc = v; await this.plugin.saveSettings(); }));

    new Setting(contentEl).setName('AI 提示词（Harness）').setHeading();
    new Setting(contentEl)
      .setName('精排提示词')
      .setDesc('只描述角色与排序要求；输出格式由插件自动附加，无需在提示词中规定')
      .addTextArea((t) => {
        t.inputEl.style.width = '100%';
        t.inputEl.style.height = '120px';
        t.setValue(s.rerankHarness).onChange(async (v) => { s.rerankHarness = v; await this.plugin.saveSettings(); });
      })
      .addExtraButton((b) => b.setIcon('rotate-ccw').setTooltip('恢复默认')
        .onClick(async () => { s.rerankHarness = DEFAULT_RERANK_HARNESS; await this.plugin.saveSettings(); this.display(); }));
    new Setting(contentEl)
      .setName('问答提示词')
      .addTextArea((t) => {
        t.inputEl.style.width = '100%';
        t.inputEl.style.height = '120px';
        t.setValue(s.qaHarness).onChange(async (v) => { s.qaHarness = v; await this.plugin.saveSettings(); });
      })
      .addExtraButton((b) => b.setIcon('rotate-ccw').setTooltip('恢复默认')
        .onClick(async () => { s.qaHarness = DEFAULT_QA_HARNESS; await this.plugin.saveSettings(); this.display(); }));

    new Setting(contentEl).setName('索引').setHeading();
    new Setting(contentEl)
      .setName('启动时自动同步索引')
      .setDesc('打开 Obsidian 后自动比对白名单目录，增量更新索引')
      .addToggle((t) => t.setValue(s.autoIndexOnStartup).onChange(async (v) => { s.autoIndexOnStartup = v; await this.plugin.saveSettings(); }));
    new Setting(contentEl)
      .setName('文件修改时增量更新')
      .setDesc('监听文件变更，延迟 1.5 秒后更新对应索引条目')
      .addToggle((t) => t.setValue(s.incrementalUpdateEnabled).onChange(async (v) => { s.incrementalUpdateEnabled = v; await this.plugin.saveSettings(); }));
    new Setting(contentEl)
      .setName('显示状态栏')
      .setDesc('状态栏显示索引篇数，点击打开检索')
      .addToggle((t) => t.setValue(s.statusBarEnabled).onChange(async (v) => { s.statusBarEnabled = v; await this.plugin.saveSettings(); this.plugin.refreshStatusBar(); }));
    new Setting(contentEl)
      .setName('重建索引')
      .setDesc('全量重新扫描白名单目录并解析 frontmatter 与章节')
      .addButton((b) => b.setButtonText('立即重建').onClick(async () => {
        new Notice('AI 检索：开始重建索引…');
        await this.plugin.rebuildIndex(true);
      }));
    new Setting(contentEl)
      .setName('定期重建索引（小时）')
      .setDesc('每隔 N 小时自动做一次全量比对重建，未变文件复用已有向量；0 = 关闭。最小 0.1（约 6 分钟），改动后立即生效')
      .addText((t) => t.setValue(String(this.plugin.settings.autoRebuildHours ?? 0)).onChange(async (v) => {
        const n = Number(v);
        this.plugin.settings.autoRebuildHours = Number.isFinite(n) && n >= 0.1 ? n : 0;
        await this.plugin.saveSettings();
        this.plugin.armPeriodicRebuild();
      }));
    new Setting(contentEl)
      .setName('清除索引缓存')
      .setDesc('删除插件目录下的 index.json 并清空内存索引')
      .addButton((b) => b.setButtonText('清除').onClick(async () => {
        await this.plugin.index.clearCache();
        new Notice('AI 检索：索引缓存已清除');
      }));

    /* ==================== 面试模式（1.0.0 由 interview-rag 并入） ====================
       这一段本身有 6 组 36 项。默认折叠，否则改「API / 白名单」得先滚过整个面试参数。 */
    ivDetails = contentEl.createEl('details', { cls: 'xyas-iv-section' });
    const ivSummary = ivDetails.createEl('summary', { cls: 'xyas-iv-summary' });
    ivSummary.createEl('span', { text: '面试问答设置', cls: 'xyas-iv-title' });
    ivSummary.createEl('span', {
      text: '桥接 · 召回权重 · 直答 · 模型（共用上方的 baseUrl / apiKey）',
      cls: 'xyas-iv-hint',
    });
    const ivEl = ivDetails.createEl('div', { cls: 'xyas-iv-body' });

    ivEl.createEl('h4', { text: '监听与桥接' });
    ivEl.createEl('p', {
      cls: 'xyas-iv-note',
      text: '面试问答与上面的 AI 检索共用同一份索引、同一个 baseUrl / apiKey（只填一次），'
        + '但模型、超时、评分权重各自独立——面试要「毫秒级 + 字面准」，与日常检索取舍不同。',
    });
    new Setting(ivEl)
      .setName('启用 ragfile 监听')
      .setDesc('监听 rag 目录的 query.json 并写 answer.json 应答 bridge')
      .addToggle((t) => t.setValue(s.ivBridgeEnabled).onChange(async (v) => {
        s.ivBridgeEnabled = v;
        await this.plugin.saveSettings();
        if (v) this.plugin.bridge.start(); else this.plugin.bridge.stop();
        this.plugin.refreshStatusBar();
      }));
    new Setting(ivEl)
      .setName('rag 目录')
      .setDesc('bridge 写 query.json / 读 answer.json 的目录（与 bridge_config.json 的 rag.dir 一致）')
      .addText((t) => t.setValue(s.ivRagDir).onChange(async (v) => { s.ivRagDir = v.trim(); await this.plugin.saveSettings(); }));
    new Setting(ivEl)
      .setName('轮询间隔（毫秒）')
      .setDesc('轮询 query.json 的间隔；fs.watch 同时在跑，这只是兜底。300ms 约等于最坏 0.3s 延迟')
      .addText((t) => t.setValue(String(s.ivPollMs)).onChange(async (v) => {
        const n = Number(v);
        if (Number.isFinite(n) && n >= 100) { s.ivPollMs = Math.round(n); await this.plugin.saveSettings(); }
      }));
    new Setting(ivEl)
      .setName('应答兜底时限（毫秒）')
      .setDesc('从读到请求到必须写应答的硬时限，超时回错误应答。bridge 超时 15s，建议 ≤10000')
      .addText((t) => t.setValue(String(s.ivAnswerDeadlineMs)).onChange(async (v) => {
        const n = Number(v);
        if (Number.isFinite(n) && n >= 2000) { s.ivAnswerDeadlineMs = Math.round(n); await this.plugin.saveSettings(); }
      }));
    new Setting(ivEl)
      .setName('打开面试控制台')
      .setDesc('模拟面试官提问，走和 bridge 完全相同的管线（召回 → 组装 → 来源），不用真开面试')
      .addButton((b) => b.setButtonText('打开').onClick(() => this.plugin.ivOpenConsole()));

    new Setting(ivEl).setName('召回与权重').setHeading();
    new Setting(ivEl)
      .setName('召回候选上限')
      .setDesc('评分后保留的候选数；回答只取前「来源条数」条')
      .addSlider((t) => t.setLimits(10, 100, 5).setValue(s.ivRecallLimit).setDynamicTooltip()
        .onChange(async (v) => { s.ivRecallLimit = v; await this.plugin.saveSettings(); }));
    new Setting(ivEl)
      .setName('来源条数')
      .setDesc('回答要点条数 / answer.json 里 sources 的条数（bridge 取前 5 条显示）')
      .addSlider((t) => t.setLimits(1, 8, 1).setValue(s.ivMaxSources).setDynamicTooltip()
        .onChange(async (v) => { s.ivMaxSources = v; await this.plugin.saveSettings(); }));
    new Setting(ivEl)
      .setName('最低分数门槛')
      .setDesc('低于该分的候选视为不相关直接丢弃（0 = 不过滤）；调大可减少答非所问')
      .addSlider((t) => t.setLimits(0, 60, 2).setValue(s.ivMinScore).setDynamicTooltip()
        .onChange(async (v) => { s.ivMinScore = v; await this.plugin.saveSettings(); }));
    new Setting(ivEl)
      .setName('强文本权重（标题/标签/摘要）')
      .setDesc('命中标题、标签、AI 摘要时的每词权重；面试场景建议 4-10')
      .addSlider((t) => t.setLimits(0, 15, 1).setValue(s.ivWStrong).setDynamicTooltip()
        .onChange(async (v) => { s.ivWStrong = v; await this.plugin.saveSettings(); }));
    new Setting(ivEl)
      .setName('正文权重')
      .setDesc('命中正文时的每词权重；过大容易让长文霸榜，建议 1-3')
      .addSlider((t) => t.setLimits(0, 6, 1).setValue(s.ivWBody).setDynamicTooltip()
        .onChange(async (v) => { s.ivWBody = v; await this.plugin.saveSettings(); }));
    new Setting(ivEl)
      .setName('整句命中加分（强文本）')
      .setDesc('问题整句出现在标题/摘要区的额外加分')
      .addSlider((t) => t.setLimits(0, 60, 5).setValue(s.ivPhraseBonusStrong).setDynamicTooltip()
        .onChange(async (v) => { s.ivPhraseBonusStrong = v; await this.plugin.saveSettings(); }));
    new Setting(ivEl)
      .setName('整句命中加分（正文）')
      .setDesc('问题整句出现在正文时的额外加分')
      .addSlider((t) => t.setLimits(0, 40, 2).setValue(s.ivPhraseBonusBody).setDynamicTooltip()
        .onChange(async (v) => { s.ivPhraseBonusBody = v; await this.plugin.saveSettings(); }));
    new Setting(ivEl)
      .setName('热词加分')
      .setDesc('每命中一个热词给整篇笔记加的分（热词=当前面试领域词，抬高相关笔记）')
      .addSlider((t) => t.setLimits(0, 30, 1).setValue(s.ivHotwordBoost).setDynamicTooltip()
        .onChange(async (v) => { s.ivHotwordBoost = v; await this.plugin.saveSettings(); }));
    new Setting(ivEl)
      .setName('热词文件路径')
      .setDesc('与 bridge 共用的 hotwords.txt；# 开头为注释，改动即时生效')
      .addText((t) => t.setValue(s.ivHotwordsFile).onChange(async (v) => { s.ivHotwordsFile = v.trim(); await this.plugin.saveSettings(); }));

    new Setting(ivEl).setName('回答组装（本地要点）').setHeading();
    new Setting(ivEl)
      .setName('摘要半径（字符）')
      .setDesc('每条要点围绕首个命中词前后各取多少字符；60 ≈ 每条 120 字')
      .addSlider((t) => t.setLimits(30, 150, 10).setValue(s.ivSnippetRadius).setDynamicTooltip()
        .onChange(async (v) => { s.ivSnippetRadius = v; await this.plugin.saveSettings(); }));
    new Setting(ivEl)
      .setName('回答前缀')
      .setDesc('回答首行前缀，留空则不加（悬浮卡上靠它区分检索结果和转写原文）')
      .addText((t) => t.setValue(s.ivAnswerTitle).onChange(async (v) => { s.ivAnswerTitle = v.trim(); await this.plugin.saveSettings(); }));
    new Setting(ivEl)
      .setName('回答总长上限（字符）')
      .setDesc('超出截断；悬浮卡 520px 宽，建议 400-800')
      .addSlider((t) => t.setLimits(200, 1500, 50).setValue(s.ivMaxAnswerChars).setDynamicTooltip()
        .onChange(async (v) => { s.ivMaxAnswerChars = v; await this.plugin.saveSettings(); }));
    new Setting(ivEl)
      .setName('要点里附笔记路径')
      .setDesc('打开后每条要点下多一行路径（来源列表本来就单独传给 bridge）')
      .addToggle((t) => t.setValue(s.ivShowSourcePaths).onChange(async (v) => { s.ivShowSourcePaths = v; await this.plugin.saveSettings(); }));

    new Setting(ivEl).setName('问题清洗').setHeading();
    new Setting(ivEl)
      .setName('最短问题字数')
      .setDesc('去空白后短于该字数的请求直接回错误应答（挡住转写碎片）')
      .addSlider((t) => t.setLimits(0, 12, 1).setValue(s.ivMinQuestionChars).setDynamicTooltip()
        .onChange(async (v) => { s.ivMinQuestionChars = v; await this.plugin.saveSettings(); }));
    new Setting(ivEl)
      .setName('噪声正则（每行一个）')
      .setDesc('命中的问题视为转写幻觉/噪声，回错误应答。例：^by bwd6$|^啊哈$|^叻+$')
      .addTextArea((t) => {
        t.inputEl.style.width = '100%';
        t.inputEl.style.height = '80px';
        t.setValue(s.ivNoiseRegex).onChange(async (v) => { s.ivNoiseRegex = v; await this.plugin.saveSettings(); });
      });

    new Setting(ivEl).setName('直答模式（代替我回答）').setHeading();
    new Setting(ivEl)
      .setName('启用直答模式')
      .setDesc('开启后 AI 以第一人称口语代替你回答面试官，悬浮卡上直接是能照着说的话；'
        + '需要网关在线，失败自动退回「AI 精答 → 本地要点」，不会拖慢应答')
      .addToggle((t) => t.setValue(s.ivSpokenEnabled).onChange(async (v) => {
        s.ivSpokenEnabled = v; await this.plugin.saveSettings(); this.plugin.refreshStatusBar();
      }));
    new Setting(ivEl)
      .setName('直答提示词')
      .setDesc('控制「像人说话」的程度：长短、口头语、是否坦承不熟的部分都在这里调'
        + (s.ivSpokenPromptPresets ? '；已注册风格命令：' + Object.keys(s.ivSpokenPromptPresets).join(' / ') : ''))
      .addTextArea((t) => {
        t.inputEl.style.width = '100%';
        t.inputEl.style.height = '140px';
        t.setValue(s.ivSpokenSystemPrompt).onChange(async (v) => { s.ivSpokenSystemPrompt = v; await this.plugin.saveSettings(); });
      })
      .addExtraButton((b) => b.setIcon('rotate-ccw').setTooltip('恢复默认')
        .onClick(async () => { s.ivSpokenSystemPrompt = DEFAULT_IV_SPOKEN_PROMPT; await this.plugin.saveSettings(); this.display(); }));

    new Setting(ivEl).setName('AI 精答').setHeading();
    new Setting(ivEl)
      .setName('启用 AI 精答')
      .setDesc('网关在线时用 AI 把召回资料组织成口头回答；不在线自动降级本地要点，不影响应答速度')
      .addToggle((t) => t.setValue(s.ivAiEnabled).onChange(async (v) => { s.ivAiEnabled = v; await this.plugin.saveSettings(); }));
    new Setting(ivEl)
      .setName('AI 协助（资料弱相关时用通用经验补齐）')
      .setDesc('打开：召回资料只当参考，资料与问题无关就忽略、改由 AI 用通用工程经验作答并标注；'
        + '关闭：严格只用资料，资料不足时只回「资料中未找到」')
      .addToggle((t) => t.setValue(s.ivAiAssist).onChange(async (v) => { s.ivAiAssist = v; await this.plugin.saveSettings(); }));
    new Setting(ivEl)
      .setName('面试用模型')
      .setDesc('与上面主检索的模型分开填：面试要快、要短。实测 cndeepseek-v4-flash 平均 5.2s、内容最完整；'
        + 'cnminimax-m3 4.7s 偏短；cnhy3 4.4s 最省字但偏浅；cnglm-5.3-flash 与 cnkimi-k2.8-preview 8s 以上别用')
      .addText((t) => t.setValue(s.ivModel).onChange(async (v) => { s.ivModel = v.trim(); await this.plugin.saveSettings(); }));
    new Setting(ivEl)
      .setName('AI 超时（毫秒）')
      .setDesc('必须小于应答兜底时限，否则超时的 AI 回答来不及上卡；到点自动降级本地要点')
      .addText((t) => t.setValue(String(s.ivTimeoutMs)).onChange(async (v) => {
        const n = Number(v);
        if (Number.isFinite(n) && n >= 1000) { s.ivTimeoutMs = Math.round(n); await this.plugin.saveSettings(); }
      }));
    new Setting(ivEl)
      .setName('输出上限（token，0=不限）')
      .setDesc('⚠️ 一般留 0。网关不流式返回，把它调小并不会让答案变快，反而会让部分模型把思考过程当正文吐出来、答案断在半句（实测 deepseek 系必现）。要提速就换模型')
      .addSlider((t) => t.setLimits(0, 1200, 40).setValue(s.ivMaxTokens).setDynamicTooltip()
        .onChange(async (v) => { s.ivMaxTokens = v; await this.plugin.saveSettings(); }));
    new Setting(ivEl)
      .setName('AI 资料条数')
      .setDesc('喂给 AI 的笔记条数（实测 3 条与 5 条延迟无差别，砍它只丢引用不省时间）')
      .addSlider((t) => t.setLimits(3, 10, 1).setValue(s.ivContextDocs).setDynamicTooltip()
        .onChange(async (v) => { s.ivContextDocs = v; await this.plugin.saveSettings(); }));
    new Setting(ivEl)
      .setName('单篇资料字符上限')
      .addSlider((t) => t.setLimits(500, 3000, 100).setValue(s.ivContextCharsPerDoc).setDynamicTooltip()
        .onChange(async (v) => { s.ivContextCharsPerDoc = v; await this.plugin.saveSettings(); }));
    new Setting(ivEl)
      .setName('AI 失败降级本地要点')
      .setDesc('关闭后 AI 失败直接回错误应答（卡片显示失败原因）')
      .addToggle((t) => t.setValue(s.ivAiFallbackLocal).onChange(async (v) => { s.ivAiFallbackLocal = v; await this.plugin.saveSettings(); }));
    new Setting(ivEl)
      .setName('AI 精答提示词')
      .setDesc('「AI 协助」打开时会在这段提示词后面自动追加一段「资料弱相关怎么办」的补充规则')
      .addTextArea((t) => {
        t.inputEl.style.width = '100%';
        t.inputEl.style.height = '140px';
        t.setValue(s.ivAiSystemPrompt).onChange(async (v) => { s.ivAiSystemPrompt = v; await this.plugin.saveSettings(); });
      })
      .addExtraButton((b) => b.setIcon('rotate-ccw').setTooltip('恢复默认')
        .onClick(async () => { s.ivAiSystemPrompt = DEFAULT_IV_AI_PROMPT; await this.plugin.saveSettings(); this.display(); }));
  }
}

/* ============================ 插件入口 ============================ */

class AISearchPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.index = new SearchIndex(this);
    this.client = new AIClient(this);
    this.bridge = new RagBridge(this);
    this.lastQuery = '';
    this._rebuilding = false;
    this._unloaded = false;
    this._ivDebug = null;      // 最近一次面试问答的调试信息（控制台显示召回条数/降级路径）
    this.lastAnswer = null;    // 最近一次 bridge 应答（控制台展示用）

    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.onclick = () => this.openSearch();
    this.refreshStatusBar();

    // 品牌分组标记（见 snippets/xyblue135-brand.css）
    // 用 addRibbonIcon 的返回值直接打类：比 querySelector 按 aria-label 二次查找可靠
    // （那边一旦改了图标文案就静默失效）。
    this.addRibbonIcon('search', 'AI 检索', () => this.openSearch())
      .addClass('xyblue135-ribbon xyblue135-ai');
    this.addCommand({
      id: 'open-ai-search',
      name: '打开 AI 检索',
      callback: () => this.openSearch(),
    });
    this.addRibbonIcon('graduation-cap', '面试问答控制台', () => this.ivOpenConsole())
      .addClass('xyblue135-ribbon xyblue135-ai');
    this.addCommand({
      id: 'rebuild-ai-search-index',
      name: '重建检索索引',
      callback: () => this.rebuildIndex(true),
    });

    /* ---- 面试模式命令（原 interview-rag 的 4 条 + 风格预设）---- */
    this.addCommand({
      id: 'iv-open-console',
      name: '面试问答：打开控制台（模拟提问试答）',
      callback: () => this.ivOpenConsole(),
    });
    this.addCommand({
      id: 'iv-rebuild-index',
      name: '面试问答：重建索引（与 AI 检索共用同一份）',
      callback: () => this.rebuildIndex(true),
    });
    this.addCommand({
      id: 'iv-toggle-bridge',
      name: '面试问答：开/关 ragfile 监听',
      callback: async () => {
        this.settings.ivBridgeEnabled = !this.settings.ivBridgeEnabled;
        await this.saveSettings();
        if (this.settings.ivBridgeEnabled) this.bridge.start(); else this.bridge.stop();
        this.refreshStatusBar();
        new Notice('AI 检索：面试监听已' + (this.settings.ivBridgeEnabled ? '开启' : '关闭'));
      },
    });
    this.addCommand({
      id: 'iv-toggle-spoken',
      name: '面试问答：开/关 直答模式（第一人称代替回答）',
      callback: () => this.ivToggleSpoken(),
    });
    // 面试风格预设：ivSpokenPromptPresets 里的每个键注册一条切换命令（可盲绑热键）
    const __styles = this.settings.ivSpokenPromptPresets || null;
    if (__styles && typeof __styles === 'object') {
      for (const __name of Object.keys(__styles)) {
        this.addCommand({
          id: 'iv-style-' + __name,
          name: '面试风格 → ' + __name,
          callback: async () => {
            this.settings.ivSpokenSystemPrompt = __styles[__name];
            await this.saveSettings();
            new Notice('面试风格已切换: ' + __name, 3000);
          },
        });
      }
    }

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

    this.addSettingTab(new AISearchSettingTab(this.app, this));
    this.armPeriodicRebuild();

    // 启动同步：等元数据缓存就绪后再全量比对，否则兜底解析结果会被 hash 固化（2.3）
    const runStartupSync = async () => {
      if (this._unloaded) return;
      if (this.settings.autoIndexOnStartup) {
        await this.index.load();
        await this.index.reconcile();
        await this.index.saveNow();
      } else {
        await this.index.load();
      }
      if (this._unloaded) return;
      // 索引就绪后才开 ragfile 监听：否则启动瞬间来的提问会查到空索引直接回「未找到」
      if (this.settings.ivBridgeEnabled) this.bridge.start();
      this.refreshStatusBar();
      if (this.settings.embeddingEnabled) {
        this.index.ensureVectors((d, n) => this.refreshStatusBar(`语义索引 ${d}/${n}`))
          .then(() => this.refreshStatusBar())
          .catch((e) => new Notice('AI 检索：' + e.message + '（已退回关键词检索）', 8000));
      }
    };
    this.app.workspace.onLayoutReady(() => {
      // 布局就绪前插件可能已被停用：不要再向已卸载的实例注册监听、也不要跑整库同步（2.6）
      if (this._unloaded) return;
      const mc = this.app.metadataCache;
      if (this.settings.autoIndexOnStartup && mc && mc.inProgress) {
        // 缓存仍在解析：等 resolved 事件后再跑首次同步（registerEvent 负责卸载时清理）
        let started = false;
        const start = () => { if (started) return; started = true; void runStartupSync(); };
        const ref = mc.on('resolved', () => { mc.offref(ref); start(); });
        this.registerEvent(ref);
        // 兜底：万一 resolved 事件没触发，60 秒后仍然执行，避免启动同步彻底不跑
        this.registerInterval(window.setTimeout(start, 60000));
        return;
      }
      void runStartupSync();
    });
  }

  onunload() {
    // 事件由 registerEvent 自动清理；这里清掉自建的定时器，避免卸载后仍写盘/刷新视图（2.6）
    this._unloaded = true;
    if (this.bridge) this.bridge.stop();
    if (this.index) {
      clearTimeout(this.index._saveTimer);
      clearTimeout(this.index._modTimer);
      this.index._modQueue.clear();
    }
  }

  // 定期重建：按小时数挂定时器；非 force 的 rebuildIndex 走 reconcile 全量比对，
  // 未变文件复用已有向量，代价远低于手动 force 重建。改动设置后重新挂载。
  armPeriodicRebuild() {
    if (this._rebuildInterval) {
      window.clearInterval(this._rebuildInterval);
      this._rebuildInterval = null;
    }
    const hours = Number(this.settings.autoRebuildHours);
    if (!Number.isFinite(hours) || hours < 0.1) return;
    this._rebuildInterval = this.registerInterval(window.setInterval(() => {
      if (this._unloaded || this._rebuilding) return;
      new Notice('AI 检索：定期重建索引…');
      void this.rebuildIndex(false);
    }, Math.round(hours * 3600 * 1000)));
  }

  openSearch() {
    new AISearchModal(this).open();
  }

  /** 供其他插件（如技能提炼）联动：带初始关键词打开检索。 */
  openSearchWithQuery(query) {
    this.lastQuery = String(query || '');
    new AISearchModal(this).open();
  }

  /* ---------------- 面试模式（原 interview-rag 的能力） ---------------- */

  ivOpenConsole() {
    new IvTestModal(this).open();
  }

  /** 直答模式开关：命令面板与设置页共用。 */
  async ivToggleSpoken() {
    this.settings.ivSpokenEnabled = !this.settings.ivSpokenEnabled;
    await this.saveSettings();
    this.refreshStatusBar();
    new Notice('AI 检索：直答模式已'
      + (this.settings.ivSpokenEnabled ? '开启（AI 以第一人称代答）' : '关闭'));
  }

  /** bridge 应答完成后的界面回调（由 RagBridge 调用）。 */
  ivOnBridgeAnswer(q, payload, ms) {
    this.lastAnswer = { question: q.question, payload, ms };
    this.refreshStatusBar();
    if (payload.error) new Notice('AI 检索：' + payload.error, 5000);
  }

  /**
   * 完整问答管线：清洗 → 本地召回 → （可选）直答/AI 精答 → 组装。
   * bridge 与控制台共用；抛错时由 RagBridge 转成错误应答。
   */
  async ivProcessQuery(question) {
    const s = this.settings;
    const q = String(question || '').trim();
    if (q.length < Math.max(0, Number(s.ivMinQuestionChars) || 0)) {
      throw new Error('问题太短（' + q.length + ' 字），已忽略');
    }
    const noise = String(s.ivNoiseRegex || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    for (const line of noise) {
      const re = safeRegExp(line);
      if (re && re.test(q)) throw new Error('噪声问题已过滤（匹配 ' + line + '）');
    }

    const hotwords = this.ivLoadHotwords();
    const hits = this.index.searchLocal(q, Math.max(1, Number(s.ivRecallLimit) || 50), null, {
      // 查询侧先挖掉疑问/礼貌词：否则「障怎」「么处」这类跨词碎片 idf 最高，最容易被顶上来
      terms: queryTerms(q),
      wStrong: s.ivWStrong,
      wBody: s.ivWBody,
      phraseBonusStrong: s.ivPhraseBonusStrong,
      phraseBonusBody: s.ivPhraseBonusBody,
      hotwords,
      hotwordBoost: s.ivHotwordBoost,
      minScore: s.ivMinScore,
      idfCap: 3.5,
      logTf: true,
      headerWeight: 3,
    });
    this._ivDebug = { question: q, hits, used: 'local' };

    let answer = null;
    if (s.ivSpokenEnabled) {
      // 直答模式：第一人称口语代替回答；失败自动落回下面的要点链，绝不静默
      try {
        answer = await this.ivSpokenAnswer(q, hits);
        this._ivDebug.used = 'spoken';
      } catch (e) {
        console.warn('[AI 检索] 直答失败，降级要点模式:', e.message);
        new Notice('AI 检索：直答不可用，已退回要点模式', 4000);
      }
    }
    if (!answer && s.ivAiEnabled) {
      try {
        answer = await this.ivAiAnswer(q, hits);
        this._ivDebug.used = 'ai';
      } catch (e) {
        console.warn('[AI 检索] AI 回答失败，降级本地要点:', e.message);
        if (!s.ivAiFallbackLocal) throw new Error('AI 回答失败：' + e.message);
        new Notice('AI 检索：AI 不可用，已用本地要点作答', 4000);
      }
    }
    if (!answer) answer = ivBuildLocalAnswer(q, hits, s);

    const sources = hits.slice(0, Math.max(1, Number(s.ivMaxSources) || 4))
      .map((h) => ({ path: h.doc.path, title: h.doc.title }));
    return { answer, sources };
  }

  /**
   * AI 精答：召回资料块 → 短超时 chat。失败由调用方降级本地要点。
   * ivAiAssist 打开时，资料只当参考——本地召回是按字面加权的，问「redis 故障怎么处理」常常
   * 只召回到安装/命令类同名笔记，此时让模型忽略无关资料、用通用工程经验作答才有用。
   */
  async ivAiAnswer(question, hits) {
    const s = this.settings;
    const assist = s.ivAiAssist !== false;
    if (!hits.length && !assist) throw new Error('知识库未找到相关内容，无法 AI 作答');
    const blocks = this.ivBuildContextBlocks(question, hits);
    const sys = assist
      ? String(s.ivAiSystemPrompt || '') + '\n\n' + IV_ASSIST_HINT
      : String(s.ivAiSystemPrompt || '');
    const user = (blocks.length
      ? '【资料】（可能只与本问题字面相关，自己判断是否可用）\n' + blocks.join('\n\n')
      : '【资料】（本次召回无相关笔记，请直接用通用工程经验回答）')
      + '\n\n【面试官问题】\n' + question;
    const content = await this.client.chat(
      [{ role: 'system', content: sys }, { role: 'user', content: user }],
      {
        temperature: 0.2,
        timeoutMs: Number(s.ivTimeoutMs) || 10000,
        model: s.ivModel || undefined,
        maxTokens: s.ivMaxTokens,
      });
    const out = String(content || '').trim();
    if (!out) throw new Error('AI 返回为空');
    return ivSmartClip(out, Math.max(100, Number(s.ivMaxAnswerChars) || 600));
  }

  /** 组装 AI 上下文资料块（ivAiAnswer 与 ivSpokenAnswer 共用）。 */
  ivBuildContextBlocks(question, hits) {
    const s = this.settings;
    const docsN = Math.max(1, Number(s.ivContextDocs) || 5);
    const perDoc = Math.max(200, Number(s.ivContextCharsPerDoc) || 1000);
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
   * 提示词独立可调（ivSpokenSystemPrompt）；温度略高换自然度；失败由 ivProcessQuery 降级要点链。
   */
  async ivSpokenAnswer(question, hits) {
    const s = this.settings;
    const assist = s.ivAiAssist !== false;
    if (!hits.length && !assist) throw new Error('知识库未找到相关内容，无法直答');
    const blocks = this.ivBuildContextBlocks(question, hits);
    const sys = String(s.ivSpokenSystemPrompt || DEFAULT_IV_SPOKEN_PROMPT)
      + (assist ? '\n\n' + IV_ASSIST_HINT : '');
    const user = (blocks.length
      ? '【资料】（可能只与本问题字面相关，自己判断是否可用）\n' + blocks.join('\n\n')
      : '【资料】（本次召回无相关笔记，请直接用通用工程经验回答）')
      + '\n\n【面试官问题】\n' + question;
    const content = await this.client.chat(
      [{ role: 'system', content: sys }, { role: 'user', content: user }],
      {
        temperature: 0.4,
        timeoutMs: Number(s.ivTimeoutMs) || 10000,
        model: s.ivModel || undefined,
        maxTokens: s.ivMaxTokens,
      });
    const out = String(content || '').trim();
    if (!out) throw new Error('AI 返回为空');
    return ivSmartClip(out, Math.max(100, Number(s.ivMaxAnswerChars) || 600));
  }

  /** 热词读取：# 开头为注释；按 mtime 缓存，文件改动即时生效。 */
  ivLoadHotwords() {
    const file = String(this.settings.ivHotwordsFile || '').trim();
    if (!file) return [];
    try {
      const st = fs.statSync(file);
      if (this._ivHwCache && this._ivHwCache.mtime === st.mtimeMs) return this._ivHwCache.words;
      const words = fs.readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'));
      this._ivHwCache = { mtime: st.mtimeMs, words };
      return words;
    } catch (e) {
      return [];
    }
  }

  async rebuildIndex(force) {
    // 与 reconcile 互斥：正在跑同步时不允许 clear()+saveNow()，否则会把空索引写进 index.json（2.1）
    if (this._rebuilding || (this.index && this.index._busy)) { new Notice('AI 检索：正在索引中，请稍后再试'); return; }
    this._rebuilding = true;
    try {
      if (force) this.index.docs.clear();
      this.index._embFailed = false;
      const r = await this.index.reconcile();
      await this.index.saveNow();
      if (this.settings.embeddingEnabled) {
        new Notice('AI 检索：正在构建语义向量…');
        await this.index.ensureVectors();
        await this.index.saveNow();
      }
      new Notice(`AI 检索：索引完成，共 ${r.total} 篇（新增 ${r.added}，更新 ${r.updated}）`);
    } catch (e) {
      new Notice('AI 检索：索引失败 — ' + e.message, 8000);
    } finally {
      this._rebuilding = false;
    }
  }

  refreshStatusBar(extraText) {
    if (!this.statusBarEl) return;
    const st = this.index ? this.index.status : { state: 'idle' };
    if (!this.settings.statusBarEnabled) {
      this.statusBarEl.setText('');
      this.statusBarEl.style.display = 'none';
      return;
    }
    this.statusBarEl.style.display = '';
    // 面试模式的状态并进同一个状态栏：合并后不该再多占一格
    let iv = '';
    if (this.settings.ivBridgeEnabled) {
      iv = (this.bridge && !this.bridge.stopped) ? ' · 监听中' : ' · 监听已停';
    }
    if (this.settings.ivSpokenEnabled) iv += ' · 直答';
    if (st.state === 'building') this.statusBarEl.setText(`AI 检索：索引中 ${st.done}/${st.total}`);
    else if (extraText) this.statusBarEl.setText('AI 检索：' + extraText);
    else this.statusBarEl.setText(`AI 检索：${this.index ? this.index.docs.size : 0} 篇${iv}`);
  }

  async loadSettings() {
    const raw = (await this.loadData()) || {};
    await this.migrateLegacyInterviewRag(raw);
    this.settings = Object.assign({}, DEFAULT_SETTINGS, raw);
  }

  /**
   * 把原 00_xyblue135-interview-rag/data.json 的设置搬成 iv* 前缀（1.0.0 合并时用）。
   * 旧键与 iv 键一一对应（iv + 首字母大写），只有 baseUrl / apiKey / 白名单 / 状态栏开关
   * 是两边共用的，不搬——它们本来就该只有一份。
   * 幂等：只填当前为空的值，写完打 migratedFromInterviewRag 标记，重跑不再动。
   */
  async migrateLegacyInterviewRag(raw) {
    if (raw.migratedFromInterviewRag) return;
    const shared = new Set([
      'baseUrl', 'apiKey', 'whitelistFolder', 'includeSubfolders',
      'autoIndexOnStartup', 'statusBarEnabled',
    ]);
    // 少数几个旧键在合并时去掉了冗余的 ai 前缀（ivTimeoutMs 比 ivAiTimeoutMs 好读）
    const alias = {
      aiTimeoutMs: 'ivTimeoutMs',
      aiMaxTokens: 'ivMaxTokens',
      aiContextDocs: 'ivContextDocs',
      aiContextCharsPerDoc: 'ivContextCharsPerDoc',
    };
    let legacy = null;
    try {
      const dir = this.manifest && this.manifest.dir;
      // 旧插件目录与本插件同父级；用 manifest.dir 推导，避免依赖 configDir 的写法
      const file = path.join(path.dirname(dir || ''), '00_xyblue135-interview-rag', 'data.json');
      legacy = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      return;   // 旧目录已删（正常情况）→ 什么都不用做
    }
    let n = 0;
    for (const key of Object.keys(legacy || {})) {
      if (shared.has(key)) continue;
      const target = alias[key] || ('iv' + key.charAt(0).toUpperCase() + key.slice(1));
      if (!(target in DEFAULT_SETTINGS)) continue;
      if (raw[target] !== undefined && raw[target] !== '' && raw[target] !== null) continue;
      raw[target] = legacy[key];
      n++;
    }
    raw.migratedFromInterviewRag = true;
    if (n) await this.saveData(raw);
    if (n) console.log('[AI 检索] 已从旧 interview-rag 迁移 ' + n + ' 项面试设置');
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

module.exports = AISearchPlugin;
module.exports.__internal = {
  tokenize, queryTerms, safeRegExp, countOccurrences, fnv1a, escapeHtml, highlight, makeSnippet,
  sanitizeSnippet, parseFrontmatterFallback, extractJson, matchCandidate, normalizeTags,
  recomputeDerived, serializeDoc, SearchIndex, AIClient, cosineSim,
  RagBridge, IvTestModal, ivSmartClip, ivBuildLocalAnswer,
  DEFAULT_SETTINGS, DEFAULT_IV_AI_PROMPT, IV_ASSIST_HINT, DEFAULT_IV_SPOKEN_PROMPT,
};
