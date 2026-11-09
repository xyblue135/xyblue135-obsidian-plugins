'use strict';

/*
 * xyblue135 · 技能提炼 (00_xyblue135-skill-miner)
 *
 * 从知识库 frontmatter（AI_tags / AI_technical_depth / AI_summary_* / AI_qa）聚合技能矩阵，
 * AI 提炼技术画像与简历素材（可勾选导出），行业雷达，模拟面试（AI_qa 抽题 + AI 评分）。
 * 接口约定与 00_xyblue135-metadata-ai 一致（OpenAI 兼容，Node http/https 直连）。
 *
 * 诚实原则：一切素材必须能追溯到具体文章证据；插件产出「素材库」，简历真实性由使用者把关。
 */

const {
  Plugin, Modal, PluginSettingTab, Setting, Notice, TFile,
  normalizePath, setIcon,
  // 岗位透镜面板用（0.11.0 并入）：自定义视图 + 渲染报告 Markdown
  ItemView, MarkdownRenderer,
} = require('obsidian');
const http = require('http');
const https = require('https');

/* ============================ 常量与默认配置 ============================ */

const BUILTIN_TAG_CANONICAL_LIST = [
  'Linux', 'Prometheus', 'Grafana', 'Docker', 'Kubernetes', 'Nginx', 'MySQL', 'PostgreSQL',
  'Redis', 'MongoDB', 'Git', 'GitHub', 'GitLab', 'Jenkins', 'Ansible', 'Terraform',
  'Python', 'Java', 'JavaScript', 'TypeScript', 'NodeJS', 'React', 'Vue', 'Angular',
  'Spring', 'SpringBoot', 'OpenAI', 'ChatGPT', 'Obsidian', 'Selenium', 'FFmpeg', 'Unity',
  'PyTorch', 'TensorFlow', 'CUDA', 'OpenCV', 'NumPy', 'Pandas', 'ScikitLearn',
  'REST', 'HTTP', 'HTTPS', 'TCP', 'UDP', 'DNS', 'SSH', 'TLS', 'JSON', 'YAML', 'XML',
  'HTML', 'CSS', 'SQL', 'NoSQL', 'API', 'SDK', 'CI', 'CD', 'DevOps', 'MLOps', 'LLM', 'RAG',
  'Nacos', 'Zabbix', 'Loki', 'Promtail', 'SkyWalking',
].join('\n');

const TAG_ALIASES = {
  k8s: 'kubernetes', js: 'javascript', ts: 'typescript', golang: 'go',
  py: 'python', mongo: 'mongodb', postgres: 'postgresql',
};

/* ---------- 方向层（Track）：簇 → 大方向 ---------- */

const TRACK_RULES = [
  ['容器与编排', ['docker', 'kubernetes', 'k8s', 'podman', 'compose', 'harbor', '容器', '镜像', '编排']],
  ['监控与可观测', ['prometheus', 'grafana', 'zabbix', 'loki', 'promtail', 'skywalking', '监控', '告警', '可观测']],
  ['排错与故障处理', ['故障排查', '故障', '排错', '问题定位', 'troubleshoot', 'debug']],
  ['网络与协议', ['网络', '网卡', '抓包', '路由', '交换', '代理', '端口', 'vpn', 'http', 'https', 'tcp', 'udp', 'dns', 'ssh', 'tls', 'wireshark', 'tcpdump', 'nmap']],
  ['数据库与存储', ['mysql', 'postgresql', 'redis', 'mongodb', 'mongo', 'sqlite', '数据库', 'sql', 'nosql', '备份', '存储']],
  ['AI 与 LLM', ['openai', 'chatgpt', 'llm', 'rag', 'agent', 'mcp', '向量', 'embedding', '提示词', 'deepseek', 'claude', 'gemini', '微调', 'ai']],
  ['DevOps 与交付', ['jenkins', 'ansible', 'terraform', 'gitlab', 'github', 'git', 'nacos', 'devops', 'mlops', 'cicd', '部署', '发布', '交付']],
  ['操作系统与环境', ['linux', 'windows', 'macos', 'ubuntu', 'centos', 'debian', 'systemd', '内核', '权限', '文件系统', 'root', 'sudo', '环境']],
  ['开发与脚本', ['python', 'java', 'javascript', 'typescript', 'nodejs', 'shell', 'bash', '脚本', '编程', '正则', '编码', 'c++', 'cpp', 'golang']],
  ['多媒体与兴趣', ['ffmpeg', 'minecraft', 'unity', '游戏', '视频', '音频', '直播', 'obs']],
];

const TRACK_LIST = [
  '操作系统与环境', '容器与编排', '网络与协议', '监控与可观测', '数据库与存储',
  'AI 与 LLM', 'DevOps 与交付', '开发与脚本', '排错与故障处理', '多媒体与兴趣', '其他与兴趣',
];

const TRACK_COLORS = {
  '操作系统与环境': '#5b8def',
  '容器与编排': '#29a599',
  '网络与协议': '#d99a3d',
  '监控与可观测': '#c9553d',
  '数据库与存储': '#8f6ad6',
  'AI 与 LLM': '#d65f8f',
  'DevOps 与交付': '#7f8fa6',
  '开发与脚本': '#4caf7d',
  '排错与故障处理': '#e0705d',
  '多媒体与兴趣': '#b5893c',
  '其他与兴趣': '#9aa0a6',
};

const CATEGORY_COLORS = { '核心技能': '#e05d44', '工具': '#5b8def', '环境': '#9aa0a6', '兴趣': '#d99a3d' };

/** 定级表情：精通 😄 / 熟练 😐 / 了解 😢（略带哭腔）—— 简历附录页与插件技能树 UI 共用。 */
const LEVEL_FACE = { '精通': '😄', '熟练': '😐', '了解': '😢' };

/* ────────────────────────────────────────────────────────────────
 * 主分支（方向）现在支持「动态新增」：
 *   · 上面 11 个是内置种子，颜色固定；
 *   · AI 提炼时可以返回内置之外的新方向名，由 cleanTrackName() 清洗后接受；
 *   · 新方向的颜色按名字稳定哈希到调色板 —— 同名永远同色，重启/重建都不变；
 *   · 名字变体（「容器编排」vs「容器与编排」）由 trackKey() 折叠到同一个分支。
 * ──────────────────────────────────────────────────────────────── */
const TRACK_PALETTE = [
  '#4a7fc1', '#3f9e8f', '#c08a2e', '#b35540', '#7a63c4', '#c25d86',
  '#6b7d8f', '#3f9a6e', '#cf6a55', '#a8813a', '#8a6bb5', '#4f9ec4',
];

/** 稳定字符串哈希（同一名字每次结果一致，保证颜色不闪） */
function hashText(s) {
  let h = 0;
  const t = String(s == null ? '' : s);
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
  return h;
}

/** 方向配色：内置优先，其余按哈希取调色板 */
function trackColor(name) {
  const n = String(name == null ? '' : name).trim();
  if (TRACK_COLORS[n]) return TRACK_COLORS[n];
  if (!n) return '#9aa0a6';
  return TRACK_PALETTE[hashText(n) % TRACK_PALETTE.length];
}

/** 清洗 AI 返回的方向名：去引号空白、限长 12 字、丢掉明显脏值；不合法返回 '' */
function cleanTrackName(raw) {
  const s = String(raw == null ? '' : raw)
    .replace(/^[\s"'“”‘’《》【】]+|[\s"'“”‘’《》【】]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return '';
  if (s.length > 12) return '';
  if (/^(undefined|null|nan|true|false|\[object object\])$/i.test(s)) return '';
  return s;
}

/** 方向名归一化键：忽略空白、标点、以及「与/和/及」，用于折叠同一分支的各种写法 */
function trackKey(name) {
  return String(name == null ? '' : name)
    .toLowerCase()
    .replace(/[\s\u3000_\-·—/\\()（）【】\[\]「」]/g, '')
    .replace(/[与和及]/g, '');
}

/** 把方向名对齐到内置名（若只是写法不同）；对不上就原样返回 */
function canonicalTrack(name) {
  const cleaned = cleanTrackName(name);
  if (!cleaned) return '';
  if (TRACK_COLORS[cleaned]) return cleaned;
  const k = trackKey(cleaned);
  const builtin = TRACK_LIST.find((x) => trackKey(x) === k);
  return builtin || cleaned;
}


/** 簇名 → 方向；中文关键字子串匹配，ASCII 词按词边界匹配。 */
function trackOf(name) {
  const s = String(name || '').toLowerCase();
  for (const [track, kws] of TRACK_RULES) {
    for (const kw of kws) {
      if (/[\u4e00-\u9fff]/.test(kw)) {
        if (s.includes(kw)) return track;
      } else if (new RegExp('(^|[^a-z0-9])' + kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^a-z0-9]|$)', 'i').test(s)) {
        return track;
      }
    }
  }
  return '其他与兴趣';
}

/** 按 refined 结果修正簇的 track 并重算方向汇总。 */
function recomputeTracks(matrix) {
  const map = new Map();
  // 归一化键 → 实际分支名：把「容器编排」「容器与编排」这类变体折叠成一个分支
  const keyToName = new Map();
  for (const c of matrix.clusters) {
    // AI 给的方向名只要合法就保留（可以是内置之外的新分支）；非法/空则退回关键词表
    let name = canonicalTrack(c.track) || trackOf(c.name);
    const k = trackKey(name);
    if (k && keyToName.has(k)) name = keyToName.get(k);
    else if (k) keyToName.set(k, name);
    c.track = name;
    let t = map.get(c.track);
    if (!t) {
      // seen 用于跨簇去重：同一篇笔记带多个标签会进多个簇，不能重复计数
      t = { docCount: 0, seen: new Set(), tokens: 0, depthSum: 0, depthCount: 0, maxDepth: 0, clusters: [], tl: new Map() };
      map.set(c.track, t);
    }
    t.tokens += c.tokens || 0;
    t.depthSum += c.avgDepth * c.count;
    t.depthCount += c.count;
    t.maxDepth = Math.max(t.maxDepth, c.maxDepth);
    t.clusters.push(c.name);
    for (const d of c.docs) {
      if (!d) continue;
      const key = d.path || d.title || '';
      if (key) {
        if (t.seen.has(key)) continue;
        t.seen.add(key);
      }
      t.docCount += 1;
      if (d.ym) t.tl.set(d.ym, (t.tl.get(d.ym) || 0) + 1);
    }
  }
  matrix.tracks = [...map.entries()]
    .map(([name, t]) => ({
      name,
      color: trackColor(name),
      count: t.docCount,
      docCount: t.docCount,
      avgDepth: Math.round(t.depthSum / Math.max(1, t.depthCount)),
      maxDepth: t.maxDepth,
      tokens: t.tokens,
      // 强度改用去重后的篇数，避免多标签文章把方向强度放大、排序失真
      intensity: Math.round(t.docCount * (1 + (t.depthSum / Math.max(1, t.depthCount)) / 100)),
      clusters: t.clusters,
      timeline: [...t.tl.entries()].sort(),
    }))
    .sort((a, b) => b.intensity - a.intensity);
  return matrix.tracks;
}

function applyRefinedTracks(matrix, refined) {
  const lookup = makeNameLookup(matrix.clusters);
  for (const r of refined || []) {
    const c = r ? lookup.get(r.name) : null;
    if (!c) continue;
    // 方向名不再限制在内置枚举里：合法即可用，归一化与配色在 recomputeTracks 里统一处理
    const resolvedTrack = canonicalTrack(r.track);
    if (resolvedTrack) c.track = resolvedTrack;
    // 同时回写 AI 类别，象限图才会按类别着色（原来只回写 track，类别配色永远不生效）
    if (r.category && CATEGORY_COLORS[r.category]) c.category = r.category;
  }
  return recomputeTracks(matrix);
}

const DEFAULT_CLUSTER_HARNESS = [
  '角色：技术技能评审员。',
  '任务：根据技能簇统计（文章数、深度、代表文章），判断类别与熟练级别，并给出简历可用的技能描述。',
  '判断标准：',
  '- category：核心技能（技术主线，文章多且深度高）/ 工具（用得多但属辅助）/ 环境（系统配置类基础）/ 兴趣（娱乐或边缘主题）；',
  '- level：精通（满足任一即达标：均深≥60；或 均深≥50 且 最高深度≥70 且 篇数≥4）/ 熟练（均深≥30 或 篇数≥8，且未达精通）/ 了解（其余）；',
  '- resumeLine：动词开头、包含具体技术点、可直接放进简历「专业技能」栏；',
  '- 诚实优先：数字达标就给精通，不要因为簇小而压级；只有证据不足才降级。',
].join('\n');

const DEFAULT_SYNTH_HARNESS = [
  '角色：资深技术简历顾问。',
  '任务：基于技能矩阵与技能簇分析，生成技术画像与简历素材。',
  '要求：',
  '1. 只依据材料，禁止编造材料中没有的技能、项目或工作经历；',
  '2. resumeBullets 是「专业技能」栏条目：动词开头、具体、可验证，按含金量排序，禁止写成项目经历；',
  '3. traits 描述学习与钻研风格，措辞克制；',
  '4. gaps 指出证据薄弱或深度不足的方向；',
  '5. 全部中文。',
].join('\n');

const DEFAULT_ASK_HARNESS = [
  '角色：技术面试官。',
  '任务：基于给定资料出一道面试题。',
  '要求：针对资料核心概念、原理或实操细节；问题具体、可作答；只输出 JSON。',
].join('\n');

const DEFAULT_GRADE_HARNESS = [
  '角色：严格但友善的技术面试官。',
  '任务：根据参考资料给候选人回答评分。',
  '评分标准：正确性 50%、完整性 30%、条理表达 20%。',
  '要求：',
  '1. score：0-100 整数；',
  '2. comment：不超过 120 字点评，先肯定对的，再指出缺失或错误；',
  '3. keyPoints：回答应覆盖的关键点（最多 5 条）；',
  '4. 只依据参考资料判断，资料未覆盖的内容不扣分；只输出 JSON。',
].join('\n');

const DEFAULT_PULSE_HARNESS = [
  '角色：技术行业分析师，熟悉运维、开发、AI 工具链的生态变化。',
  '任务：评估给定技术方向近一两年的行业现状，给出竞品对比与学习建议。',
  '要求：',
  '1. 基于行业知识诚实作答；不确定的时间用“约”，不确定的事实不要编造；',
  '2. 若提供了联网检索结果，以检索结果为主要依据并优先反映其中信息；',
  '3. 站在“有该方向基础、深度中等的学习者”视角给建议；',
  '4. 全部中文；只输出 JSON。',
].join('\n');

const DEFAULT_PLAN_HARNESS = [
  '角色：个人技术成长顾问。',
  '任务：把薄弱点与行业建议合并成一份去重的学习计划。',
  '要求：',
  '1. priority：P0（直接影响求职）/ P1（明显加分）/ P2（长期储备）；',
  '2. 每条含 item（学什么）、why（为什么）、target（学到什么程度算够）、related（相关技术方向）；',
  '3. 合并重复项，总量 6-12 条；全部中文；只输出 JSON。',
].join('\n');

const DEFAULT_GH_HARNESS = [
  '角色：技术简历项目顾问。',
  '任务：为 GitHub 仓库撰写简历用的一句话介绍。',
  '要求：',
  '1. 只依据仓库提供的信息（名称、描述、语言、topics）提炼，禁止编造功能；',
  '2. 突出解决什么问题、用了什么技术，30-55 字；',
  '3. 全部中文；只输出 JSON。',
].join('\n');

const DEFAULT_RESUME_HARNESS = [
  '角色：资深简历撰稿人。',
  '任务：根据素材（画像定位、技能条目、工作经历、项目、证书）生成 GitHub 风格简历的内容。',
  '要求：',
  '1. 只依据素材撰写，禁止编造未出现的经历、数字或技能；',
  '2. 工作经历 bullets 动词开头、量化优先、每条 20-45 字；',
  '3. 项目描述突出技术栈与解决的问题；',
  '4. bio 为 GitHub 个人主页风格的一句话；positioning 为 50 字内的简历定位语；',
  '5. 全部中文；只输出 JSON。',
].join('\n');

/* 岗位透镜视图 id：沿用原 00_xyblue135-job-lens 的字符串，
   这样 workspace.json 里已存的视图合并后仍能正常恢复。 */
const JOB_LENS_VIEW_TYPE = 'xyblue135-job-lens-view';

/* ---------- 岗位透镜的 LLM 调用（沿用原 job-lens 实现：429/502 自动重试） ----------
   与 AIClient 并存而不复用，是因为这里要求「失败重试 + 90 秒长超时」的独立策略，
   报告类长文本生成对超时更敏感。函数名加 jobLens 前缀，避免与既有 extractJson 冲突。 */
function jobLensChat(base, key, model, messages, timeoutMs) {
  let attempt = 0;
  const once = () => jobLensChatOnce(base, key, model, messages, timeoutMs);
  const retry = (e) => {
    const msg = String((e && e.message) || '');
    if (/502|429|rate|limit/i.test(msg) && attempt < 2) {
      attempt++;
      return new Promise((r) => setTimeout(r, 3000 * attempt)).then(once).catch(retry);
    }
    throw e;
  };
  return once().catch(retry);
}

function jobLensChatOnce(base, key, model, messages, timeoutMs) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(String(base || '').replace(/\/+$/, '') + '/chat/completions'); }
    catch (e) { reject(new Error('AI 接口地址无效：' + base)); return; }
    const mod = url.protocol === 'https:' ? https : http;
    const body = JSON.stringify({ model: model || 'auto', messages: messages, temperature: 0.3 });
    const headers = { 'Content-Type': 'application/json' };
    if (key) headers.Authorization = 'Bearer ' + key;
    const req = mod.request(url, { method: 'POST', headers, timeout: timeoutMs }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try {
          const d = JSON.parse(buf);
          if (d.error) return reject(new Error(d.error.message || JSON.stringify(d.error).slice(0, 120)));
          resolve(String((d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || ''));
        } catch (e) { reject(new Error('网关返回解析失败: ' + buf.slice(0, 120))); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('AI 请求超时')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function jobLensExtractJson(text) {
  const m = String(text || '').match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const s = String(text || '');
  const raw = m ? m[1] : s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1);
  return JSON.parse(raw);
}

const DEFAULT_SETTINGS = {
  baseUrl: 'http://127.0.0.1:31415/v1',
  apiKey: '',
  model: 'auto',
  requestTimeoutSeconds: 180,
  structuredJsonModeEnabled: true,
  jsonRepairEnabled: true,

  folders: 'my_blog/00_docs',
  minDocsPerSkill: 3,
  tagCanonicalList: BUILTIN_TAG_CANONICAL_LIST,
  ignoreTags: '',
  outputFolder: 'my_blog/不受监管的文档/00_暂未分类',

  interviewCount: 5,

  // 岗位透镜（0.11.0 起由原 00_xyblue135-job-lens 并入）
  jobLensInbox: 'my_blog/00_docs/收件箱',

  resumeAppendixEnabled: true,

  searchProvider: 'off',
  searchApiKey: '',

  githubUsername: 'xyblue135',
  repoWhitelist: 'key-sync-enhanced\nQuarkSeleniumKit\nscrcpy-mask-enhanced\nBilibiliDownloader',

  clusterHarness: DEFAULT_CLUSTER_HARNESS,
  synthHarness: DEFAULT_SYNTH_HARNESS,
  askHarness: DEFAULT_ASK_HARNESS,
  gradeHarness: DEFAULT_GRADE_HARNESS,
  pulseHarness: DEFAULT_PULSE_HARNESS,
  planHarness: DEFAULT_PLAN_HARNESS,
  ghHarness: DEFAULT_GH_HARNESS,
  resumeHarness: DEFAULT_RESUME_HARNESS,
};

const CLUSTER_BATCH_SIZE = 12;

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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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

function strArr(v, max) {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => {
      // 兼容对象元素：模型偶尔返回 {"bullet":"…"} / {"trait":"…"} 这类没有 text 字段的对象，
      // 直接 String(x) 会产出 "[object Object]" 并成为勾选键
      if (x && typeof x === 'object') {
        const pick = x.text != null ? x.text
          : x.value != null ? x.value
            : Object.keys(x).filter((k) => typeof x[k] === 'string').map((k) => x[k]).join(' ');
        return String(pick == null ? '' : pick).trim();
      }
      return String(x == null ? '' : x).trim();
    })
    .filter((t) => t && t !== '[object Object]')
    .slice(0, max || 20);
}

/** 勾选键归一化：忽略空白与标点差异，AI 换说法后勾选状态不会静默失效。 */
function selKey(text) {
  return String(text == null ? '' : text)
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。、；：！？,.;:!?"'“”‘’（）()\[\]【】<>《》·\-—_/\\|]/g, '');
}

/** 勾选命中判断：先查归一化键，再退化扫描既有键（兼容旧数据里以原文为键的记录）。 */
function selHit(sel, text) {
  const src = sel && typeof sel === 'object' ? sel : {};
  const k = selKey(text);
  if (!k) return false;
  if (src[k] || src[text]) return true;
  for (const key of Object.keys(src)) {
    if (src[key] && selKey(key) === k) return true;
  }
  return false;
}

/** 勾选稳定键：簇名 + 条目序号，AI 把句子换个说法后勾选状态也不会失效。 */
function stableSelKey(scope, idx) {
  return `${selKey(scope) || '_'}#${idx}`;
}

/** 稳定键优先、旧文本键兜底：任一种命中都算已勾选。 */
function selPicked(sel, scope, idx, text) {
  const src = sel && typeof sel === 'object' ? sel : {};
  if (src[stableSelKey(scope, idx)]) return true;
  return selHit(src, text);
}

/** 删除某个条目的全部勾选键（稳定键与旧文本键一并清掉，避免残留）。 */
function selDel(sel, text) {
  const src = sel && typeof sel === 'object' ? sel : {};
  const k = selKey(text);
  if (!k) return;
  for (const key of Object.keys(src)) if (selKey(key) === k) delete src[key];
}

/** 技能簇名归一化：全角转半角、小写、去空白/下划线/连字符与 +、/ 等分隔符。 */
function normClusterKey(s) {
  return String(s == null ? '' : s)
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, '')
    .toLowerCase()
    .replace(/[\s_\-·、，,。.：:；;()（）\[\]【】'"“”‘’]/g, '')
    .replace(/[+\/&|]+/g, '');
}

/** 名称查找器：全等 → 归一化全等 → 唯一包含匹配，避免模型改写簇名后静默丢簇/丢证据链接。 */
function makeNameLookup(list) {
  const arr = Array.isArray(list) ? list.filter((x) => x && typeof x.name === 'string') : [];
  const exact = new Map(arr.map((x) => [x.name, x]));
  const norm = new Map();
  for (const x of arr) {
    const k = normClusterKey(x.name);
    if (k && !norm.has(k)) norm.set(k, x);
  }
  return {
    get(name) {
      const raw = String(name == null ? '' : name).trim();
      if (!raw) return null;
      if (exact.has(raw)) return exact.get(raw);
      const nk = normClusterKey(raw);
      if (!nk) return null;
      if (norm.has(nk)) return norm.get(nk);
      // 包含匹配兜底：仅当候选唯一时采用，多个候选宁可不配以免张冠李戴
      const cands = arr.filter((x) => {
        const k = normClusterKey(x.name);
        return k && (k.includes(nk) || nk.includes(k));
      });
      return cands.length === 1 ? cands[0] : null;
    },
  };
}

/** 标签规范化：支持「规范名 = 别名1, 别名2」映射行；规范表内取规范大小写；别名归一；未收录保留原样。 */
function buildCanonicalizer(listText) {
  const canon = new Map();   // 规范名小写键 → 规范名
  const aliasMap = new Map(); // 别名小写键 → 规范名
  for (let line of String(listText || '').split('\n')) {
    line = line.trim();
    if (!line) continue;
    const m = line.match(/^(.+?)\s*[=：]\s*(.+)$/);
    if (m && !/^https?:/i.test(m[1]) && m[1].trim()) {
      // 映射行：C++ = CPlusPlus, cplusplus, cpp
      const canonical = m[1].trim().replace(/^#/, '');
      if (!canonical) continue;
      canon.set(canonical.toLowerCase(), canonical);
      for (let a of m[2].split(/[,，、]+/)) {
        a = a.trim().replace(/^#/, '');
        if (a) aliasMap.set(a.toLowerCase(), canonical);
      }
    } else {
      canon.set(line.toLowerCase(), line);
    }
  }
  return function (tag) {
    const t = String(tag || '').trim().replace(/^#/, '');
    if (!t) return '';
    const lc = t.toLowerCase();
    // 优先级：内置语义别名（k8s→Kubernetes）→ 映射行别名（CPlusPlus→C++）→ 规范表精确 → 原样
    const key = TAG_ALIASES[lc] || lc;
    if (canon.has(key)) return canon.get(key);
    if (aliasMap.has(lc)) return aliasMap.get(lc);
    if (canon.has(lc)) return canon.get(lc);
    return t;
  };
}

/** updated 字段 → 'YYYYMM'；支持 14-17 位数字、13 位毫秒、常见日期写法。 */
function parseYearMonth(updated) {
  const s = String(updated || '').trim();
  if (/^\d{14,17}$/.test(s)) return s.slice(0, 6);
  if (/^\d{13}$/.test(s)) {
    const d = new Date(Number(s));
    if (!isNaN(d.getTime())) return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0');
  }
  const m = s.match(/^(\d{4})[-/年](\d{1,2})/);
  if (m) return m[1] + String(Number(m[2])).padStart(2, '0');
  return null;
}

/** 补齐近 12 个月的月份序列。 */
function buildTimeline12(timelinePairs, now) {
  // 防御：兼容 {月份: 数量} 对象、null 或含非法元素的数组，避免 new Map() 抛 "not iterable"
  const pairs = Array.isArray(timelinePairs)
    ? timelinePairs.filter((p) => Array.isArray(p) && p.length >= 2)
    : (timelinePairs && typeof timelinePairs === 'object' ? Object.entries(timelinePairs) : []);
  const map = new Map(pairs);
  const base = now || new Date();
  const out = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(base.getFullYear(), base.getMonth() - i, 1);
    const key = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0');
    out.push([key, map.get(key) || 0]);
  }
  return out;
}

function weightedPick(items) {
  if (!items.length) return null;
  const total = items.reduce((a, b) => a + (b.weight || 1), 0);
  let r = Math.random() * total;
  for (const it of items) {
    r -= it.weight || 1;
    if (r <= 0) return it;
  }
  return items[items.length - 1];
}

/**
 * 聚合技能矩阵：标签归一 → 技能簇统计（篇数/深度/字数/最近更新）+ 全库深度分布 + 月度时间线。
 * records: [{path,title,tags[],depth,tokens,updated,summaryShort,hasQa}]
 */
function aggregateDocs(records, settings) {
  const canon = buildCanonicalizer(settings && settings.tagCanonicalList);
  const ignore = new Set(String((settings && settings.ignoreTags) || '').split('\n').map((x) => x.trim().toLowerCase()).filter(Boolean));
  const minDocs = Math.max(1, Number(settings && settings.minDocsPerSkill) || 3);
  const clusters = new Map();
  const timeline = new Map();
  const depthDist = { 0: 0, 20: 0, 40: 0, 60: 0, 80: 0 };
  let totalTokens = 0;

  // 归一键：规范名小写后去掉空格/下划线/连字符/中点——"ip link"/"ip-link"/"ip_link" 折叠为同一簇；
  // 显示名取先出现者（规范表内标签取规范大小写）。
  const mergeKeyOf = (t) => t.toLowerCase().replace(/[\s\u3000_\-·]+/g, '');
  const seen = new Map();
  const norm = (tag) => {
    const t = canon(tag);
    if (!t) return '';
    const key = mergeKeyOf(t);
    if (seen.has(key)) return seen.get(key);
    seen.set(key, t);
    return t;
  };

  for (const d of records) {
    const ym = parseYearMonth(d.updated) || '';
    for (const rawTag of d.tags) {
      const tag = norm(rawTag);
      if (!tag || ignore.has(tag.toLowerCase())) continue;
      let c = clusters.get(tag);
      if (!c) {
        c = { name: tag, docs: [], depths: [], tokens: 0, last: '' };
        clusters.set(tag, c);
      }
      c.docs.push({ path: d.path, title: d.title, depth: d.depth, summaryShort: d.summaryShort, hasQa: d.hasQa, ym });
      c.depths.push(d.depth);
      c.tokens += d.tokens;
      if (d.updated > c.last) c.last = d.updated;
    }
    if (ym) timeline.set(ym, (timeline.get(ym) || 0) + 1);
    const bucket = Math.min(80, Math.floor((d.depth || 0) / 20) * 20);
    depthDist[bucket]++;
    totalTokens += d.tokens;
  }

  const list = [...clusters.values()]
    .filter((c) => c.docs.length >= minDocs)
    .map((c) => ({
      name: c.name,
      count: c.docs.length,
      avgDepth: Math.round(c.depths.reduce((a, b) => a + b, 0) / c.depths.length),
      maxDepth: Math.max(...c.depths),
      tokens: c.tokens,
      last: c.last,
      track: trackOf(c.name),
      docs: c.docs.slice().sort((a, b) => b.depth - a.depth),
    }))
    .sort((a, b) => b.count * (1 + b.avgDepth / 100) - a.count * (1 + a.avgDepth / 100));

  const result = {
    generatedAt: Date.now(),
    totalDocs: records.length,
    totalTokens,
    depthDist,
    clusters: list,
    timeline: [...timeline.entries()].sort(),
  };
  recomputeTracks(result);
  return result;
}

/**
 * 解析 AI_qa 块标量：多段「专家:/答:」问答，答案按 判断依据/排查·实现思路/关键风险 分节。
 * 返回 [{q, a, basis, approach, risk}]；格式容错（同行问题、序号前缀、全角冒号）。
 */
function parseQaBlocks(raw) {
  if (Array.isArray(raw)) raw = raw.join('\n');
  if (!raw) return [];
  let text = String(raw).replace(/\r/g, '');
  const lines = text.split('\n');
  const indents = lines.filter((l) => l.trim()).map((l) => (l.match(/^\s*/) || [''])[0].length);
  const shift = indents.length ? Math.min(...indents) : 0;
  if (shift > 0) text = lines.map((l) => l.slice(shift)).join('\n');

  const blocks = [];
  const parts = text.split(/^\s*专家\s*[:：]\s*/m);
  for (const part of parts.slice(1)) {
    const idx = part.search(/(?:^|\n)\s*答\s*[:：]/);
    if (idx < 0) continue;
    const q = part.slice(0, idx).trim();
    const answer = part.slice(idx).replace(/^\n?\s*答\s*[:：]\s*/, '').trim();
    if (!q || !answer) continue;
    const sections = { basis: [], approach: [], risk: [] };
    let cur = null;
    for (let line of answer.split('\n')) {
      const t = line.trim().replace(/^[-*•]\s*/, '').replace(/^\d+[.、)]\s*/, '');
      let mm;
      if ((mm = t.match(/^判断依据\s*[:：]?\s*(.*)$/))) {
        cur = 'basis';
        if (mm[1]) sections.basis.push(mm[1]);
      } else if ((mm = t.match(/^(?:排查[\/·／]?实现思路|排查思路|实现思路)\s*[:：]?\s*(.*)$/))) {
        cur = 'approach';
        if (mm[1]) sections.approach.push(mm[1]);
      } else if ((mm = t.match(/^关键风险\s*[:：]?\s*(.*)$/))) {
        cur = 'risk';
        if (mm[1]) sections.risk.push(mm[1]);
      } else if (t && cur) {
        sections[cur].push(t);
      }
    }
    blocks.push({
      q,
      a: answer,
      basis: sections.basis.join(' '),
      approach: sections.approach.join(' '),
      risk: sections.risk.join(' '),
    });
  }
  return blocks;
}

/** 从原文提取 AI_qa 块标量文本（metadataCache 不可用时的兜底）。 */
function extractQaFromRaw(content) {
  const lines = String(content || '').split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (/^AI_qa:\s*\|[-+]?(\s*)$/.test(t)) { start = i + 1; break; }
  }
  if (start < 0) return '';
  const out = [];
  for (let i = start; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '' || /^[ \t]/.test(l)) out.push(l);
    else break;
  }
  return out.join('\n');
}

function timestamp14(d) {
  const t = d || new Date();
  const p = (n, w) => String(n).padStart(w || 2, '0');
  return `${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}${p(t.getHours())}${p(t.getMinutes())}${p(t.getSeconds())}${p(t.getMilliseconds(), 3)}`;
}

function formatDate(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function wikilink(path, title) {
  return `[[${String(path).replace(/\.md$/i, '')}|${title}]]`;
}

function median(arr) {
  const a = (arr || []).slice().sort((x, y) => x - y);
  const n = a.length;
  return n ? (a[Math.floor((n - 1) / 2)] + a[Math.ceil((n - 1) / 2)]) / 2 : 0;
}

/* ============================ 可视化：SVG 生成 ============================ */

function svgWrap(w, h, inner) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="max-width:100%;height:auto">${inner}</svg>`;
}

function svgText(x, y, text, opts) {
  const o = opts || {};
  return `<text x="${x}" y="${y}" font-size="${o.size || 11}" fill="currentColor" opacity="${o.opacity != null ? o.opacity : 0.8}" text-anchor="${o.anchor || 'start'}"${o.weight ? ` font-weight="${o.weight}"` : ''}>${escapeHtml(text)}</text>`;
}

/** 技能象限图：X=平均深度，Y=文章数，气泡=总字数，颜色=类别；中线取中位数。 */
function bubbleQuadrantSVG(matrix, maxClusters) {
  const cs = (matrix.clusters || []).slice(0, maxClusters || 30);
  if (cs.length < 3) return '';
  const W = 660;
  const H = 440;
  const ML = 48;
  const MB = 62;
  const MT = 16;
  const MR = 16;
  const pw = W - ML - MR;
  const ph = H - MB - MT;
  const maxCount = Math.max(...cs.map((c) => c.count));
  const px = (d) => ML + (Math.min(100, Math.max(0, d)) / 100) * pw;
  const py = (n) => MT + ph - (n / maxCount) * ph;
  const maxTokens = Math.max(...cs.map((c) => c.tokens || 1));
  const rad = (c) => 4 + Math.sqrt((c.tokens || 1) / maxTokens) * 13;
  const medX = median(cs.map((c) => c.avgDepth));
  const medY = median(cs.map((c) => c.count));
  const parts = [];
  parts.push(`<line x1="${px(medX).toFixed(1)}" y1="${MT}" x2="${px(medX).toFixed(1)}" y2="${MT + ph}" stroke="currentColor" stroke-dasharray="4 4" opacity="0.3"/>`);
  parts.push(`<line x1="${ML}" y1="${py(medY).toFixed(1)}" x2="${ML + pw}" y2="${py(medY).toFixed(1)}" stroke="currentColor" stroke-dasharray="4 4" opacity="0.3"/>`);
  parts.push(`<line x1="${ML}" y1="${MT + ph}" x2="${ML + pw}" y2="${MT + ph}" stroke="currentColor" opacity="0.45"/>`);
  parts.push(`<line x1="${ML}" y1="${MT}" x2="${ML}" y2="${MT + ph}" stroke="currentColor" opacity="0.45"/>`);
  parts.push(svgText(ML + pw - 6, MT + 13, '主阵地 · 深 × 多', { anchor: 'end', opacity: 0.45 }));
  parts.push(svgText(ML + 6, MT + 13, '广而不深', { opacity: 0.45 }));
  parts.push(svgText(ML + pw - 6, MT + ph - 6, '精钻', { anchor: 'end', opacity: 0.45 }));
  parts.push(svgText(ML + 6, MT + ph - 6, '涉猎', { opacity: 0.45 }));
  for (const v of [0, 25, 50, 75, 100]) {
    parts.push(svgText(px(v).toFixed(1), H - 24, String(v), { size: 10, opacity: 0.5, anchor: 'middle' }));
  }
  for (const v of [0, Math.round(maxCount / 2), maxCount]) {
    parts.push(svgText(ML - 6, (py(v) + 3).toFixed(1), String(v), { size: 10, opacity: 0.5, anchor: 'end' }));
  }
  parts.push(svgText(ML + pw / 2, H - 6, '平均技术深度 →', { anchor: 'middle', opacity: 0.6 }));
  parts.push(`<text x="12" y="${(MT + ph / 2).toFixed(1)}" font-size="11" fill="currentColor" opacity="0.6" text-anchor="middle" transform="rotate(-90 12 ${(MT + ph / 2).toFixed(1)})">文章数 →</text>`);
  const sorted = cs.slice().sort((a, b) => (b.tokens || 0) - (a.tokens || 0));
  for (const c of sorted) {
    const color = CATEGORY_COLORS[c.category] || trackColor(c.track);
    parts.push(`<circle cx="${px(c.avgDepth).toFixed(1)}" cy="${py(c.count).toFixed(1)}" r="${rad(c).toFixed(1)}" fill="${color}" opacity="0.5" stroke="${color}"><title>${escapeHtml(c.name)}：${c.count} 篇 · 均深 ${c.avgDepth}</title></circle>`);
  }
  for (const c of cs.slice(0, 10)) {
    parts.push(svgText(px(c.avgDepth).toFixed(1), (py(c.count) - rad(c) - 4).toFixed(1), c.name, { size: 10, anchor: 'middle', opacity: 0.85 }));
  }
  // 类别图例：仅在 AI 标定过类别时显示，方便对照四色分类
  const catKeys = Object.keys(CATEGORY_COLORS).filter((k) => cs.some((c) => c.category === k));
  if (catKeys.length) {
    const legendY = H - 44;
    let legendX = ML;
    for (const k of catKeys) {
      parts.push(`<rect x="${legendX}" y="${legendY - 8}" width="9" height="9" rx="2" fill="${CATEGORY_COLORS[k]}" opacity="0.75"/>`);
      parts.push(svgText(legendX + 13, legendY, k, { size: 10, opacity: 0.7 }));
      legendX += 13 + k.length * 11 + 16;
    }
  }
  return svgWrap(W, H, parts.join('\n'));
}

/** 强度雷达：Top 6-8 个方向，强度 = 文章数 × (1 + 均深/100)，归一化。 */
function radarSVG(items) {
  const list = (items || []).filter((x) => x && x.value > 0).slice(0, 8);
  if (list.length < 3) return '';
  const W = 440;
  const H = 390;
  const cx = W / 2;
  const cy = H / 2 + 4;
  const R = 128;
  const n = list.length;
  const ang = (i) => (Math.PI * 2 * i) / n - Math.PI / 2;
  const pt = (i, v) => [cx + Math.cos(ang(i)) * R * v, cy + Math.sin(ang(i)) * R * v];
  const pts = (v) => list.map((_, i) => pt(i, v).map((x) => x.toFixed(1)).join(',')).join(' ');
  const parts = [];
  for (const ring of [0.25, 0.5, 0.75, 1]) {
    parts.push(`<polygon points="${pts(ring)}" fill="none" stroke="currentColor" opacity="${ring === 1 ? 0.35 : 0.14}"/>`);
  }
  for (let i = 0; i < n; i++) {
    const [x2, y2] = pt(i, 1);
    parts.push(`<line x1="${cx}" y1="${cy}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="currentColor" opacity="0.12"/>`);
  }
  parts.push(`<polygon points="${list.map((x, i) => pt(i, Math.max(0.05, x.value)).map((v) => v.toFixed(1)).join(',')).join(' ')}" fill="#5b8def" opacity="0.30" stroke="#5b8def" stroke-width="1.5"/>`);
  list.forEach((x, i) => {
    const [px2, py2] = pt(i, Math.max(0.05, x.value));
    parts.push(`<circle cx="${px2.toFixed(1)}" cy="${py2.toFixed(1)}" r="2.5" fill="#5b8def"/>`);
    const [lx, ly] = pt(i, 1.16);
    const anchor = Math.abs(Math.cos(ang(i))) < 0.35 ? 'middle' : Math.cos(ang(i)) > 0 ? 'start' : 'end';
    parts.push(svgText(lx.toFixed(1), (ly + 4).toFixed(1), x.name, { anchor, opacity: 0.85 }));
  });
  return svgWrap(W, H, parts.join('\n'));
}

/** 方向条形图：按强度排序，条长=文章数。 */
function trackBarsSVG(matrix) {
  const ts = matrix.tracks || [];
  if (!ts.length) return '';
  const rowH = 30;
  const W = 640;
  const ML = 128;
  const MR = 170;
  const H = ts.length * rowH + 14;
  const maxCount = Math.max(...ts.map((t) => t.count));
  const pw = W - ML - MR;
  const parts = [];
  ts.forEach((t, i) => {
    const y = 7 + i * rowH;
    const bw = Math.max(3, (t.count / maxCount) * pw);
    parts.push(svgText(ML - 8, y + 15, t.name, { anchor: 'end' }));
    parts.push(`<rect x="${ML}" y="${y + 4}" width="${bw.toFixed(1)}" height="18" rx="3" fill="${trackColor(t.name)}" opacity="0.8"><title>${escapeHtml(t.name)}：${t.count} 篇 · 均深 ${t.avgDepth} · 强度 ${t.intensity}</title></rect>`);
    parts.push(svgText(ML + pw + 6, y + 17, `${t.count} 篇 · 均深 ${t.avgDepth} · 强度 ${t.intensity}`, { size: 10, opacity: 0.65 }));
  });
  return svgWrap(W, H, parts.join('\n'));
}

/** 12 个月堆叠时间线：按方向堆叠。 */
function timelineStackedSVG(matrix) {
  const months = buildTimeline12(matrix.timeline);
  const ts = (matrix.tracks || []).filter((t) => t.timeline && t.timeline.length);
  if (!ts.length) return '';
  const W = 660;
  const H = 252;
  const ML = 34;
  const MB = 30;
  const MT = 40;
  const pw = W - ML - 14;
  const ph = H - MB - MT;
  const tlMaps = ts.map((t) => new Map(t.timeline));
  const totals = months.map(([m]) => tlMaps.reduce((a, mp) => a + (mp.get(m) || 0), 0));
  const maxT = Math.max(1, ...totals);
  const bw = pw / months.length;
  const parts = [];
  let lx = ML;
  let ly = 8;
  for (const t of ts) {
    if (lx + t.name.length * 11 + 30 > W) { lx = ML; ly += 15; }
    parts.push(`<rect x="${lx}" y="${ly}" width="9" height="9" rx="2" fill="${trackColor(t.name)}"/>`);
    parts.push(svgText(lx + 13, ly + 8.5, t.name, { size: 10, opacity: 0.75 }));
    lx += 13 + t.name.length * 11 + 16;
  }
  months.forEach(([m], i) => {
    let yTop = MT + ph;
    for (let k = 0; k < ts.length; k++) {
      const v = tlMaps[k].get(m) || 0;
      if (!v) continue;
      const hh = (v / maxT) * ph;
      yTop -= hh;
      parts.push(`<rect x="${(ML + i * bw + 2).toFixed(1)}" y="${yTop.toFixed(1)}" width="${Math.max(1, bw - 4).toFixed(1)}" height="${hh.toFixed(1)}" fill="${trackColor(ts[k].name)}" opacity="0.85"><title>${escapeHtml(ts[k].name)} ${m}：${v} 篇</title></rect>`);
    }
    parts.push(svgText((ML + i * bw + bw / 2).toFixed(1), H - 16, m.slice(2), { size: 9, opacity: 0.55, anchor: 'middle' }));
    if (totals[i]) parts.push(svgText((ML + i * bw + bw / 2).toFixed(1), (yTop - 4).toFixed(1), String(totals[i]), { size: 9, opacity: 0.65, anchor: 'middle' }));
  });
  parts.push(`<line x1="${ML}" y1="${MT + ph}" x2="${W - 14}" y2="${MT + ph}" stroke="currentColor" opacity="0.3"/>`);
  return svgWrap(W, H, parts.join('\n'));
}


/* ============================ 简历生成（版式 D · GitHub 风格） ============================ */

/** 常见语言 → GitHub Linguist 配色；未收录按名字哈希取稳定色。 */
const LANG_COLORS = {
  Python: '#3572A5', JavaScript: '#f1e05a', TypeScript: '#3178c6', Shell: '#89e051',
  Rust: '#dea584', 'C++': '#f34b7d', C: '#555555', Java: '#b07219', HTML: '#e34c26',
  CSS: '#563d7c', Vue: '#41b883', Go: '#00ADD8', Dockerfile: '#384d54', Lua: '#000080',
  'C#': '#178600', Kotlin: '#A97BFF', PHP: '#4F5D95', Ruby: '#701516', Swift: '#F05138',
  PowerShell: '#012456', 'Vim script': '#199f4b', 'Jupyter Notebook': '#DA5B0B', Batchfile: '#C1F12E',
};

function langColor(lang) {
  const l = String(lang || '').trim();
  if (LANG_COLORS[l]) return LANG_COLORS[l];
  const palette = ['#8b949e', '#5b8def', '#4caf7d', '#d99a3d', '#c9553d', '#8f6ad6'];
  return palette[hashText(l) % palette.length];
}

/** 手动补充条目（kind: 基本信息/证书/教育背景/工作经历/项目/其他）→ profile 字段。 */
function parseProfileFromManual(manual) {
  const out = {};
  for (const it of manual || []) {
    if (!it || it.kind !== '基本信息') continue;
    const m = String(it.text || '').match(/^(姓名|电话|邮箱|所在城市|城市|求职意向|GitHub|域名网站|域名|学历)\s*[:：]\s*(.+)$/);
    if (!m) continue;
    const key = m[1];
    const val = m[2].trim();
    if (key === '姓名') out.name = val;
    else if (key === '电话') out.phone = val;
    else if (key === '邮箱') out.email = val;
    else if (key === '所在城市' || key === '城市') out.city = val;
    else if (key === '求职意向') out.goal = val;
    else if (key === 'GitHub') out.github = val.replace(/^https?:\/\/(www\.)?github\.com\//i, '').replace(/\/+$/, '');
    else if (key === '域名网站' || key === '域名') out.domain = val;
    else if (key === '学历') out.education = val;
  }
  return out;
}

function manualByKind(manual, kind) {
  return (manual || []).filter((it) => it && it.kind === kind && String(it.text || '').trim()).map((it) => String(it.text).trim());
}

/** repo 语言 → GitHub 风格色点。 */
function renderReposHtml(repos, ghLines, repoIcon) {
  const list = (repos || []).slice(0, 6);
  if (!list.length) return '';
  const icon = repoIcon || '';
  return list.map((r) => {
    const line = (ghLines && ghLines[r.name]) || r.description || '';
    const stars = Number(r.stargazers_count) > 0 ? ` <span>· ${r.stargazers_count} stars</span>` : '';
    return `<div class="repo">
          <div class="repo-name">
            ${icon}
            <a href="${escapeHtml(r.html_url || `https://github.com/${r.full_name || r.name}`)}">${escapeHtml(r.name)}</a><span class="pub">Public</span>
          </div>
          <p>${escapeHtml(line)}</p>
          <div class="repo-meta"><i class="dot" style="background:${langColor(r.language)}"></i>${escapeHtml(r.language || 'Other')}${stars}</div>
        </div>`;
  }).join('\n        ');
}

/** 汇总各仓库语言字节数 → 技术侧重 lang-bar + legend。 */
function renderLangHtml(langStats, sideNote) {
  const entries = Object.entries(langStats || {}).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 4);
  if (!entries.length) return '';
  const total = entries.reduce((a, b) => a + b[1], 0);
  const bars = entries.map(([, v]) => `<i style="width:${Math.max(6, Math.round((v / total) * 100))}%;background:${langColor('')}"></i>`)
    .join('');
  const legend = entries.map(([k, v]) => `<span><i class="dot" style="background:${langColor(k)}"></i> <b>${escapeHtml(k)}</b> ${Math.round((v / total) * 100)}%</span>`).join('\n            ');
  return `<div class="lang-bar">${bars}</div>
          <div class="legend">
            ${legend}
          </div>
          <div class="side-note">${escapeHtml(sideNote || '按仓库语言字节数汇总。')}</div>`;
}

function renderMetaHtml(profile, metaIcons) {
  const icon = (i) => (metaIcons && metaIcons[i]) || '';
  const spans = [];
  if (profile.city) spans.push(`<span>${icon(0)}${escapeHtml(profile.city)}${profile.goal ? ' · 可接受异地' : ''}</span>`);
  if (profile.email) spans.push(`<span>${icon(1)}${escapeHtml(profile.email)}</span>`);
  if (profile.domain) spans.push(`<span>${icon(2)}${escapeHtml(profile.domain)}</span>`);
  if (profile.github) spans.push(`<span>${icon(3)}<a href="https://github.com/${escapeHtml(profile.github)}">github.com/${escapeHtml(profile.github)}</a></span>`);
  if (profile.phone) spans.push(`<span>${escapeHtml(profile.phone)}</span>`);
  return spans.join('\n          ');
}

function renderWorkHtml(work) {
  return (work || []).map((w) => `<div class="entry">
            <div class="entry-head"><strong>${escapeHtml(w.company || '')}</strong><span>${escapeHtml(w.title || '')}</span></div>
            <ul>
              ${(w.bullets || []).map((b) => `<li>${escapeHtml(b)}</li>`).join('\n              ')}
            </ul>
          </div>`).join('\n          ');
}

function renderProjectsHtml(projects) {
  return (projects || []).map((p) => `<div class="proj">
            <b>${escapeHtml(p.name || '')}</b> <span style="font-size:7.4pt;color:#57606a">${escapeHtml(p.tech || '')}</span>
            <p>${escapeHtml(p.desc || '')}</p>
          </div>`).join('\n          ');
}

function renderKeywordsHtml(kws) {
  return (kws || []).slice(0, 12).map((k) => `<span>${escapeHtml(k)}</span>`).join('');
}

function renderEduHtml(eduText) {
  const t = String(eduText || '').trim();
  if (!t) return '<b style="color:#24292f;font-size:8.4pt">（待补充教育背景）</b>';
  const parts = t.split(/[｜|]/).map((x) => x.trim()).filter(Boolean);
  const school = parts.shift() || t;
  return `<b style="color:#24292f;font-size:8.4pt">${escapeHtml(school)}</b><br>\n          ${escapeHtml(parts.join(' · '))}`;
}

/** 读取 templates/ 下的模板资产（进程内缓存）。 */
async function loadResumeTemplate(plugin) {
  if (plugin._resumeTpl) return plugin._resumeTpl;
  const base = normalizePath(plugin.manifest.dir + '/templates');
  const adapter = plugin.app.vault.adapter;
  const tpl = await adapter.read(normalizePath(base + '/resume-d-github.template.html'));
  const avatar = (await adapter.read(normalizePath(base + '/avatar.txt'))).trim();
  let icons = {};
  try { icons = JSON.parse(await adapter.read(normalizePath(base + '/octicons.json'))); } catch (e) { icons = { metaIcons: [], repoIcon: '' }; }
  plugin._resumeTpl = { tpl, avatar, metaIcons: icons.metaIcons || [], repoIcon: icons.repoIcon || '' };
  return plugin._resumeTpl;
}

/** 填充版式 D 模板生成完整简历 HTML。content 各字段缺失时给出安全占位。 */
function fillResumeTemplate(tplSet, content) {
  const c = content || {};
  return tplSet.tpl
    .replace(/\{\{AVATAR\}\}/g, tplSet.avatar || '')
    .replace(/\{\{NAME\}\}/g, escapeHtml(c.name || '（待填写姓名）'))
    .replace(/\{\{HANDLE\}\}/g, escapeHtml(c.handle || ''))
    .replace(/\{\{DEGREE\}\}/g, escapeHtml(c.degree || ''))
    .replace(/\{\{GITHUB_USER\}\}/g, escapeHtml(c.githubUser || ''))
    .replace(/\{\{GITHUB_URL\}\}/g, escapeHtml(c.githubUrl || '#'))
    .replace(/\{\{BIO\}\}/g, c.bio || '')
    .replace(/\{\{META\}\}/g, c.metaHtml || '')
    .replace(/\{\{MAIN\}\}/g, c.mainHtml || '')
    .replace(/\{\{REPOS\}\}/g, c.reposHtml || '')
    .replace(/\{\{LANG\}\}/g, c.langHtml || '')
    .replace(/\{\{EDU\}\}/g, c.eduHtml || '')
    .replace(/\{\{NEXT_GUIDE\}\}/g, c.nextGuideHtml || '');
}

/** 简历附录页：全量技能树（方向 → 簇，三栏树状、小字号填满 A4），随矩阵动态更新。 */
function buildSkillAppendixHtml(matrix, refined) {
  if (!matrix || !matrix.tracks) return '';
  const tracksAll = matrix.tracks.slice();
  if (!tracksAll.length) return '';
  const refMap = makeNameLookup(refined || []);
  const maxI = Math.max(...tracksAll.map((t) => t.intensity), 1);

  const tracksHtml = tracksAll.map((t) => {
    const cs = (matrix.clusters || []).filter((c) => c.track === t.name)
      .sort((a, b) => b.count * (1 + b.avgDepth / 100) - a.count * (1 + a.avgDepth / 100));
    const rows = cs.map((c) => {
      const r = refMap.get(c.name) || {};
      const face = LEVEL_FACE[r.level] || '';
      return `<div class="xyap-cluster"><span class="xyap-face">${face}</span><b>${escapeHtml(c.name)}</b><span>${c.count}篇 · 均${c.avgDepth}</span></div>`;
    }).join('');
    const barW = Math.max(3, Math.round((t.intensity / maxI) * 100));
    return `<div class="xyap-track">
        <div class="xyap-track-head"><b>${escapeHtml(t.name)}</b><span>${t.count}篇 · 均${t.avgDepth} · 强${t.intensity}</span></div>
        <div class="xyap-bar"><i style="width:${barW}%"></i></div>
        <div class="xyap-clusters">${rows}</div>
      </div>`;
  }).join('\n');

  const dateStr = formatDate(Date.now());
  return `<div class="page xyap-page">
  <style>
    .xyap-page { background:#fff; padding:8mm 10mm; box-sizing:border-box; }
    .xyap-head { display:flex; align-items:baseline; gap:4mm; border-bottom:2px solid #24292f; padding-bottom:1.6mm; margin-bottom:2.4mm; }
    .xyap-head b { font-size:13pt; color:#24292f; }
    .xyap-head span { color:#8b949e; font-size:7.5pt; margin-left:auto; }
    .xyap-legend { font-size:6.8pt; color:#57606a; margin-bottom:2.6mm; }
    .xyap-legend i { width:2mm; height:2mm; border-radius:50%; display:inline-block; margin:0 0.8mm 0 2.5mm; }
    .xyap-tree { column-count:3; column-gap:5mm; }
    .xyap-track { break-inside:avoid; margin-bottom:3.2mm; }
    .xyap-track-head { display:flex; justify-content:space-between; align-items:baseline; gap:1.5mm; }
    .xyap-track-head b { font-size:8.2pt; color:#24292f; }
    .xyap-track-head span { font-size:6.3pt; color:#57606a; white-space:nowrap; }
    .xyap-bar { height:1.6mm; background:#eaeef2; border-radius:0.8mm; overflow:hidden; margin:0.8mm 0 1mm; }
    .xyap-bar i { display:block; height:100%; background:#24292f; border-radius:0.8mm; }
    .xyap-clusters { border-left:1px solid #d0d7de; margin-left:1.2mm; padding-left:1.8mm; }
    .xyap-cluster { display:flex; align-items:center; gap:1.4mm; padding:0.45mm 0; line-height:1.25; }
    .xyap-cluster b { font-size:7.2pt; font-weight:600; color:#24292f; }
    .xyap-cluster span { font-size:6.3pt; color:#57606a; white-space:nowrap; }
    .xyap-face { font-size:10pt; display:inline-block; width:4.6mm; text-align:center; flex:0 0 4.6mm; }
    .xyap-note { font-size:6.3pt; color:#8b949e; margin-top:2.4mm; line-height:1.5; border-top:1px solid #d0d7de; padding-top:1.6mm; }
  </style>
  <div class="xyap-head"><b>技能树</b><span>Skill Tree · ${dateStr}</span></div>
  <div class="xyap-legend">表情 = AI 定级：😄 精通　😐 熟练　😢 了解　·　行格式：簇名 · 篇数 · 平均深度（0-100）　·　条形 = 方向强度（篇数 × 深度加权）</div>
  <div class="xyap-tree">${tracksHtml}</div>
  <div class="xyap-note">数据来源：知识库 ${matrix.totalDocs} 篇已整理笔记（status: done），共 ${matrix.clusters.length} 个技能簇、${tracksAll.length} 个方向，由「xyblue135 · 技能提炼」按标签聚合生成，随知识库动态更新。完整证据链见《个人技能画像》。</div>
</div>`;
}

/** 简历第 1 页左侧垂直引导带：淡蓝渐变色带 + 大号下行箭头 + 竖排文字，纵贯正文区高度。 */
function renderNextGuideHtml() {
  const arrow = '<svg width="5mm" height="30mm" viewBox="0 0 20 120" style="display:block"><path d="M10 6 V102" fill="none" stroke="#0969da" stroke-width="3.2" stroke-linecap="round"/><path d="M2.5 92 L10 112 L17.5 92" fill="none" stroke="#0969da" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  return `<style>
    .xyguide-band { position:absolute; left:1.5mm; top:0; bottom:0; width:8.5mm; border-radius:4mm;
      background:linear-gradient(180deg, rgba(9,105,218,0) 0%, rgba(9,105,218,0.08) 35%, rgba(9,105,218,0.18) 100%);
      display:flex; flex-direction:column; align-items:center; justify-content:flex-end; padding-bottom:5mm; gap:2.5mm; }
    .xyguide-band svg { display:block; }
    .xyguide-vtext { writing-mode:vertical-rl; font-size:8pt; font-weight:700; color:#0969da; letter-spacing:1.6px; }
  </style>
  <div class="xyguide-band">${arrow}<div class="xyguide-vtext">下一页 · 技能树全景</div></div>`;
}

/* ============================ 笔记与导出生成 ============================ */

/** 0.10.0：技能簇「可写简历」判定——画像技能树覆盖段与缺口导入共用一套口径。 */
function judgeCluster(c, r) {
  const level = r.level || '';
  const count = Number(c.count) || 0;
  if (level === '精通') return { bucket: 'yes', label: '✅ 能写' };
  if (level === '熟练') return count >= 3 ? { bucket: 'yes', label: '✅ 能写' } : { bucket: 'weak', label: '⚠️ 证据偏少' };
  if (level === '了解') return { bucket: 'weak', label: '⚠️ 了解级，谨慎写' };
  return count >= 5 ? { bucket: 'weak', label: '⚠️ 待 AI 定级' } : { bucket: 'no', label: '❌ 证据不足' };
}

function buildProfileNote(matrix, refined, synth, pulse, plan, gh, localProjects) {
  const refMap = makeNameLookup(refined || []);
  // 归一化 synth：旧版本缓存或被手动改过的 data.json 可能缺字段，避免整篇画像生成抛 TypeError
  const syn = synth || {};
  const bullets = Array.isArray(syn.resumeBullets) ? syn.resumeBullets : [];
  const traits = Array.isArray(syn.traits) ? syn.traits : [];
  const gaps = Array.isArray(syn.gaps) ? syn.gaps : [];
  const interviewFocus = Array.isArray(syn.interviewFocus) ? syn.interviewFocus : [];
  const dateStr = formatDate(matrix.generatedAt);
  const out = [];
  out.push('---');
  out.push('status: 🟢 done');
  out.push('visibility: 🟢 open');
  out.push(`updated: ${timestamp14()}`);
  out.push('tags:');
  out.push('  - 个人画像');
  out.push('---');
  out.push('');
  out.push('# 个人技能画像');
  out.push('');
  out.push(`> 由「xyblue135 · 技能提炼」于 ${dateStr} 生成，基于 ${matrix.totalDocs} 篇文章、${matrix.clusters.length} 个技能簇。素材均可追溯到具体文章，简历取舍由本人把关。`);
  out.push('');
  if (synth) {
    out.push('## 一句话定位');
    out.push('');
    out.push(synth.selfPositioning || '（未生成）');
    out.push('');
    out.push('## 技术方向画像');
    out.push('');
    out.push(synth.directionProfile || '（未生成）');
    out.push('');
  }
  // 0.9.0：技能清单改为按技能树结构（方向 → 簇）输出，并给出「可写简历」判定，
  // 一眼看出哪些技能树的点能写上、哪些证据不足需要补笔记。
  const tracksAll = (matrix.tracks || []).slice().sort((a, b) => (b.intensity || 0) - (a.intensity || 0));
  const resumeReady = { yes: 0, weak: 0, no: 0 };
  const verdictOf = (c, r) => {
    const v = judgeCluster(c, r);
    resumeReady[v.bucket] += 1;
    return v.label;
  };
  const trackSections = [];
  for (const t of tracksAll) {
    const cs = (matrix.clusters || []).filter((c) => c.track === t.name)
      .sort((a, b) => (b.count * (1 + b.avgDepth / 100)) - (a.count * (1 + a.avgDepth / 100)));
    if (!cs.length) continue;
    const lines = [`### ${t.name}（${t.count} 篇 · 强度 ${t.intensity}）`, ''];
    lines.push('| 技能簇 | 可写 | 级别 | 类别 | 文章数 | 均深 | 最近更新 |', '|---|---|---|---|---|---|---|');
    for (const c of cs) {
      const r = refMap.get(c.name) || {};
      lines.push(`| ${c.name} | ${verdictOf(c, r)} | ${r.level || '—'} | ${r.category || '—'} | ${c.count} | ${c.avgDepth} | ${c.last ? parseYearMonth(c.last) || '' : ''} |`);
    }
    lines.push('');
    trackSections.push(lines);
  }
  out.push('## 技能树覆盖（方向 → 簇）');
  out.push('');
  out.push(`> 共 ${tracksAll.length} 个方向、${matrix.clusters.length} 个技能簇：✅ 可写 ${resumeReady.yes} · ⚠️ 待补强 ${resumeReady.weak} · ❌ 证据不足 ${resumeReady.no}。判定 = AI 定级 × 证据量（文章数/深度）；想点亮某个点就补对应主题的 status: 🟢 done 笔记再重建矩阵。`);
  out.push('');
  for (const lines of trackSections) out.push(...lines);
  if (bullets.length) {
    out.push('## 简历技能条目（全部备选）');
    out.push('');
    for (const b of bullets) {
      const txt = String((b && b.text) || b || '').trim();
      if (!txt) continue;
      out.push(`- [ ] ${txt}${b && b.cluster ? `　*（${b.cluster}）*` : ''}`);
    }
    out.push('');
    out.push(`> 勾选版见 [[${'简历素材'}]]（在插件中勾选后导出）。`);
    out.push('');
  }
  if (traits.length) {
    out.push('## 钻研风格（AI 推断，仅供参考）');
    out.push('');
    for (const t of traits) out.push(`- ${t}`);
    out.push('');
  }
  if (gaps.length) {
    out.push('## 薄弱点');
    out.push('');
    for (const t of gaps) out.push(`- ${t}`);
    out.push('');
  }
  if (interviewFocus.length) {
    out.push('## 面试突击建议');
    out.push('');
    for (const t of interviewFocus) out.push(`- ${t}`);
    out.push('');
  }
  if (pulse && pulse.generatedAt && pulse.tracks && Object.keys(pulse.tracks).length) {
    out.push(`## 行业雷达（生成于 ${formatDate(pulse.generatedAt)}）`);
    out.push('');
    out.push(`> 数据来源：${pulse.source || '模型知识'}。行业判断有时效性，重要决策请核对最新信息。`);
    out.push('');
    for (const t of matrix.tracks || []) {
      const p = pulse.tracks[t.name];
      if (!p) continue;
      out.push(`### ${t.name} · 热度 ${p.hotness}/10 · ${p.status || ''}`);
      out.push('');
      if (p.summary) { out.push(p.summary); out.push(''); }
      if (p.advice) { out.push(`**对我的建议**：${p.advice}`); out.push(''); }
      if (p.replacements && p.replacements.length) {
        out.push('**竞品 / 替代格局**：');
        out.push('');
        for (const r of p.replacements) out.push(`- ${r.name}（${r.relation}）：${r.note}`);
        out.push('');
      }
      if (p.recentChanges && p.recentChanges.length) {
        out.push('**近期变动**：');
        out.push('');
        for (const rc of p.recentChanges) out.push(`- ${rc.when} ${rc.event}${rc.impact ? `（${rc.impact}）` : ''}`);
        out.push('');
      }
      if (p.learnNext && p.learnNext.length) {
        out.push(`**补课清单**：${p.learnNext.map((x) => `${x.priority} ${x.item}`).join('；')}`);
        out.push('');
      }
    }
  }
  if (plan && plan.generatedAt && plan.items && plan.items.length) {
    out.push(`## 学习计划（生成于 ${formatDate(plan.generatedAt)}）`);
    out.push('');
    for (const it of plan.items) {
      out.push(`- [ ] **${it.priority} ${it.item}** — ${it.why}${it.target ? `（目标：${it.target}）` : ''}${it.related ? `　*[${it.related}]*` : ''}`);
    }
    out.push('');
  }
  if (Array.isArray(localProjects) && localProjects.length) {
    out.push('## GitHub 项目（本地仓库笔记 · 00_agent_for_projects）');
    out.push('');
    for (const r of localProjects) {
      const push = r.pushedAt && /^\d{14,17}$/.test(r.pushedAt)
        ? ` · 推送 ${r.pushedAt.slice(0, 4)}-${r.pushedAt.slice(4, 6)}-${r.pushedAt.slice(6, 8)}` : '';
      const fork = r.upstream ? ` · fork ← ${r.upstream}` : '';
      const link = r.html_url ? `[${r.name}](${r.html_url})` : r.name;
      out.push(`- ${link}${fork}${push} — ${r.description || '（无 AI_summary_short）'}${r.freshness ? `（${r.freshness}）` : ''}`);
    }
    out.push('');
  } else if (gh && Array.isArray(gh.repos) && gh.repos.length) {
    out.push(`## GitHub 项目（${gh.username || 'xyblue135'}）`);
    out.push('');
    for (const r of gh.repos) {
      const line = (gh.lines && gh.lines[r.name]) || r.description || '';
      out.push(`- [${r.name}](${r.html_url || `https://github.com/${gh.username || ''}/${r.name}`}) — ${line}${r.language ? `（${r.language}${Number(r.stargazers_count) ? ` · ${r.stargazers_count} stars` : ''}）` : ''}${r.error ? ' ⚠ 拉取失败' : ''}`);
    }
    out.push('');
  }
  out.push('## 学习时间线（近 12 个月文章数）');
  out.push('');
  const tl = buildTimeline12(matrix.timeline);
  const maxC = Math.max(1, ...tl.map((x) => x[1]));
  for (const [ym, count] of tl) {
    const bar = '█'.repeat(Math.max(count ? 1 : 0, Math.round((count / maxC) * 20)));
    out.push(`- ${ym} ${bar} ${count}`);
  }
  out.push('');
  out.push('## 证据索引（按技能簇，每簇取深度最高的 8 篇）');
  out.push('');
  for (const c of matrix.clusters.slice(0, 15)) {
    out.push(`### ${c.name}（${c.count} 篇，均深 ${c.avgDepth}）`);
    out.push('');
    for (const d of c.docs.slice(0, 8)) out.push(`- ${wikilink(d.path, d.title)}　深度 ${d.depth}`);
    out.push('');
  }
  out.push('---');
  out.push('');
  out.push('**诚实提醒**：本笔记全部条目来自知识库学习记录，能证明「学了什么、钻研多深」，不能替代真实项目经历。写简历时请与本人实际经历核对后再使用。');
  out.push('');
  return out.join('\n');
}

function buildResumeExport(matrix, refined, synth, selectedBullets, selectedTraits) {
  const refMap = makeNameLookup(refined || []);
  const clusterByName = makeNameLookup(matrix.clusters);
  const out = [];
  out.push(`# 简历素材`);
  out.push('');
  out.push(`> 从《个人技能画像》勾选导出于 ${formatDate(Date.now())}。每条附证据文章，用于回忆细节与面试前复习。`);
  out.push('');
  if (synth && synth.selfPositioning) {
    out.push('## 自我定位（可直接用于自我介绍开头）');
    out.push('');
    out.push(synth.selfPositioning);
    out.push('');
  }
  if (synth && synth.directionProfile) {
    out.push('## 技术方向画像');
    out.push('');
    out.push(synth.directionProfile);
    out.push('');
  }
  const rawBullets = Array.isArray(synth && synth.resumeBullets) ? synth.resumeBullets : [];
  const bullets = rawBullets
    .map((b) => (b && typeof b === 'object' ? b : { text: String(b == null ? '' : b) }))
    .filter((b, i) => selPicked(selectedBullets, b.cluster, i, b.text));
  if (bullets.length) {
    out.push('## 技能条目（已勾选）');
    out.push('');
    const groups = new Map();
    for (const b of bullets) {
      const key = (refMap.get(b.cluster) || {}).category || '其他';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(b);
    }
    for (const [cat, arr] of groups) {
      out.push(`### ${cat}`);
      out.push('');
      for (const b of arr) {
        const c = clusterByName.get(b.cluster);
        const ev = c ? `${c.count} 篇，均深 ${c.avgDepth}` : '';
        const links = c && c.docs.length ? ` 证据：${wikilink(c.docs[0].path, c.docs[0].title)}${c.docs[1] ? ` 等 ${c.count} 篇` : ''}` : '';
        out.push(`- ${b.text}${ev ? `　*（${ev}）*` : ''}${links}`);
      }
      out.push('');
    }
  }
  const traits = (Array.isArray(synth && synth.traits) ? synth.traits : []).filter((t, i) => selPicked(selectedTraits, '_trait', i, t));
  if (traits.length) {
    out.push('## 风格特质（AI 推断，仅供参考）');
    out.push('');
    for (const t of traits) out.push(`- ${t}`);
    out.push('');
  }
  out.push('---');
  out.push('');
  out.push('**使用提醒**：技能条目描述的是「知识储备水平」，面试前请结合真实项目经历准备具体案例（STAR：情境-任务-行动-结果）。');
  out.push('');
  return out.join('\n');
}

/* ============================ AI 客户端 ============================ */

class AIClient {
  constructor(plugin) {
    this.plugin = plugin;
  }

  get s() {
    return this.plugin.settings;
  }

  request(payload, { timeoutMs } = {}) {
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
      const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
      if (this.s.apiKey) headers.Authorization = 'Bearer ' + this.s.apiKey;
      let settled = false;
      const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };
      const req = mod.request(url, { method: 'POST', headers, timeout: timeoutMs }, (res) => {
        if (res.statusCode >= 400) {
          let errBody = '';
          // 错误体统一由这里 settle：超过 2000 字符时立即 settle 并停止累积，
          // 不再 res.destroy()（掐断流会导致既不 end 也不 error，Promise 永不 settle）
          const failWithBody = () => done(reject, new Error('API 返回 ' + res.statusCode + '：' + errBody.slice(0, 300)));
          res.setEncoding('utf8');
          res.on('data', (c) => {
            if (settled) return;
            errBody += c;
            if (errBody.length > 2000) {
              failWithBody();
              res.resume(); // 丢弃剩余数据，等流自然结束
            }
          });
          res.on('end', failWithBody);
          res.on('error', failWithBody);
          // 兜底：连接被关闭/中断时同样 settle，保证恰好一次
          res.on('close', failWithBody);
          return;
        }
        let body = '';
        res.setEncoding('utf8');
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
        // 兜底：响应流被提前关闭（无 end/error）时也保证 settle 一次
        res.on('close', () => done(reject, new Error('API 连接中断')));
      });
      req.on('timeout', () => req.destroy(new Error('请求超时（' + Math.round(timeoutMs / 1000) + 's）')));
      req.on('error', (e) => done(reject, e));
      req.write(JSON.stringify(payload));
      req.end();
    });
  }

  async chat(messages, opts = {}) {
    const payload = {
      model: this.s.model || 'auto',
      messages,
      temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.3,
      stream: false,
    };
    if (opts.jsonMode && this.s.structuredJsonModeEnabled) payload.response_format = { type: 'json_object' };
    return this.request(payload, { timeoutMs: opts.timeoutMs });
  }

  /** 分批分析技能簇 → { list: [{name, category, level, resumeLine, summary}], failed: [簇名], unmatched: [未匹配名称] } */
  async refineClusters(matrix, onProgress, opts) {
    const s = this.s;
    const clusters = matrix.clusters;
    // 断点续跑：retryOnly 时复用上一轮已完成的结果，只重跑失败/缺失的簇
    const prev = opts && Array.isArray(opts.prev) ? opts.prev.filter((r) => r && typeof r.name === 'string') : [];
    const prevNames = new Set(prev.map((r) => r.name));
    const retryOnly = !!(opts && opts.retryOnly) && prevNames.size > 0;
    const out = retryOnly ? prev.slice() : [];
    const pending = retryOnly ? clusters.filter((c) => !prevNames.has(c.name)) : clusters.slice();
    const failed = [];
    const unmatched = [];
    // 已有方向清单：内置 11 个 + 当前矩阵里已经出现过的动态方向，喂给模型鼓励复用、抑制碎分支。
    // 注意：这个数组会随批次「长大」——每批新造的方向立刻并入，后续批次才能复用。
    // 否则各批次互相看不见，会各自发明「硬件与外设」「硬件与设备」这类近似重复方向。
    const knownTracks = [...new Set([
      ...TRACK_LIST,
      ...clusters.map((c) => canonicalTrack(c.track)).filter(Boolean),
    ])];
    for (let i = 0; i < pending.length; i += CLUSTER_BATCH_SIZE) {
      const batch = pending.slice(i, i + CLUSTER_BATCH_SIZE);
      const lines = batch.map((c) => {
        const tops = c.docs.slice(0, 4).map((d) => `    - 《${d.title}》深度${d.depth}`).join('\n');
        return `- ${c.name}：${c.count} 篇，平均深度 ${c.avgDepth}，最高 ${c.maxDepth}\n  代表文章：\n${tops}`;
      });
      const spec = [
        '【输出格式（必须严格遵守）】',
        '只输出 JSON，禁止解释文字与代码块标记：',
        '{"clusters":[{"name":"技能簇原名","track":"技术方向名","category":"核心技能|工具|环境|兴趣","level":"精通|熟练|了解","resumeLine":"动词开头的简历技能描述，不超过40字","summary":"这个方向会什么，不超过80字"}]}',
        `【已有方向】${knownTracks.join('、')}`,
        'track 规则：优先从【已有方向】里选最贴切的一个并逐字复制；只有该技能确实不属于任何已有方向时，才新建一个 2-6 个字的粗粒度方向名（如「嵌入式开发」「云原生平台」），禁止为单个具体工具新建方向。',
        '必须覆盖输入的每一个技能簇，name 逐字复制。',
      ].join('\n');
      // 单批失败不再拖垮整体：重试 1 次后记入 failed，已成功的批次结果全部保留
      let arr = null;
      let lastErr = null;
      for (let attempt = 0; attempt < 2 && !arr; attempt++) {
        try {
          const content = await this.chat(
            [{ role: 'system', content: s.clusterHarness }, { role: 'user', content: `【技能簇统计】\n${lines.join('\n')}\n\n${spec}` }],
            { temperature: 0.2, jsonMode: true }
          );
          const parsed = extractJson(content, s.jsonRepairEnabled);
          const got = Array.isArray(parsed && parsed.clusters) ? parsed.clusters : [];
          if (!got.length) throw new Error('批次未返回 clusters');
          arr = got;
        } catch (e) {
          arr = null;
          lastErr = e;
        }
      }
      const progressIdx = Math.min(clusters.length - pending.length + i + CLUSTER_BATCH_SIZE, clusters.length);
      if (!arr) {
        for (const c of batch) failed.push(c.name);
        if (onProgress) onProgress(progressIdx, clusters.length, '批次失败：' + ((lastErr && lastErr.message) || '未知错误'));
        continue;
      }
      // 本批新造的方向并入清单，供后续批次复用（抑制近似重复方向）
      for (const r of arr) {
        const t = canonicalTrack(r && r.track);
        if (t && !knownTracks.includes(t)) knownTracks.push(t);
      }
      const byName = new Map(batch.map((c) => [c.name, c]));
      // 归一化 + 唯一包含匹配：模型把「K8s」写成「Kubernetes」之类也不至于整簇丢失
      const byNorm = new Map();
      for (const c of batch) {
        const k = normClusterKey(c.name);
        if (k && !byNorm.has(k)) byNorm.set(k, c);
      }
      const matchCluster = (rawName) => {
        const key = String(rawName == null ? '' : rawName).trim();
        if (!key) return null;
        const hit = byName.get(key) || byNorm.get(normClusterKey(key));
        if (hit) return hit;
        const nk = normClusterKey(key);
        if (!nk) return null;
        const cands = batch.filter((x) => {
          const k = normClusterKey(x.name);
          return k && (k.includes(nk) || nk.includes(k));
        });
        return cands.length === 1 ? cands[0] : null;
      };
      let matched = 0;
      const covered = new Set();
      for (const r of arr) {
        const key = r && typeof r.name === 'string' ? r.name.trim() : '';
        const c = matchCluster(key);
        if (!c) {
          if (key) unmatched.push(key);
          continue;
        }
        matched++;
        covered.add(c.name);
        out.push({
          name: c.name,
          track: canonicalTrack(r.track) || trackOf(c.name),
          category: String(r.category || '').trim() || '工具',
          level: String(r.level || '').trim() || '了解',
          resumeLine: String(r.resumeLine || '').trim().slice(0, 80),
          summary: String(r.summary || '').trim().slice(0, 160),
        });
      }
      // 批内没被任何返回项覆盖的簇也记入 failed：部分匹配时不会静默丢掉剩下的簇，
      // 下次断点续跑还能补上
      for (const c of batch) if (!covered.has(c.name) && !failed.includes(c.name)) failed.push(c.name);
      // 整批一条都没对上：同样按失败处理，避免静默丢簇
      if (!matched) {
        if (onProgress) onProgress(progressIdx, clusters.length, '批次名称全部未匹配');
        continue;
      }
      if (onProgress) onProgress(progressIdx, clusters.length);
    }
    return { list: out, failed, unmatched };
  }

  /** 汇总画像 → {selfPositioning, directionProfile, resumeBullets, traits, gaps, interviewFocus} */
  async synthesize(matrix, refined) {
    const s = this.s;
    const matrixLookup = makeNameLookup(matrix.clusters);
    const cl = refined.map((r) => {
      const m = matrixLookup.get(r.name);
      return `${r.category}｜${r.level}｜${r.name}（${m ? m.count : 0} 篇，均深 ${m ? m.avgDepth : 0}）：${r.resumeLine || r.summary || ''}`;
    }).join('\n');
    const dd = Object.entries(matrix.depthDist).map(([k, v]) => `${k}-${k + 19}档:${v}`).join('，');
    const tl = buildTimeline12(matrix.timeline).map(([m, c]) => `${m.slice(2)}月:${c}`).join(' ');
    const spec = [
      '【输出格式（必须严格遵守）】',
      '只输出 JSON：',
      '{"selfPositioning":"第一人称一句话定位，不超过50字","directionProfile":"技术方向画像，2-3句","resumeBullets":[{"text":"简历技能条目","cluster":"所属技能簇名"}],"traits":[{"text":"钻研风格"}],"gaps":[{"text":"薄弱点"}],"interviewFocus":[{"text":"突击建议"}]}',
      'resumeBullets 20-40 条按含金量排序（每个有定级的技能簇尽量各出一条，不要只挑头部）；traits 3-5 条；gaps 3-5 条；interviewFocus 3-5 条。',
      '禁止编造材料中没有的技能；禁止写项目经历。',
    ].join('\n');
    const user = [
      `【知识库总体】${matrix.totalDocs} 篇技术笔记，约 ${Math.round(matrix.totalTokens / 10000)} 万字符；深度分布：${dd}`,
      `【近 12 个月每月文章数】${tl}`,
      `【技能簇（已完成分类定级）】\n${cl}`,
      '',
      spec,
    ].join('\n');
    const content = await this.chat(
      [{ role: 'system', content: s.synthHarness }, { role: 'user', content: user }],
      { temperature: 0.3, jsonMode: true }
    );
    const parsed = extractJson(content, s.jsonRepairEnabled);
    const bullets = (Array.isArray(parsed && parsed.resumeBullets) ? parsed.resumeBullets : [])
      .map((b) => {
        const raw = b && typeof b === 'object'
          ? (b.text != null ? b.text : b.value != null ? b.value : b.bullet != null ? b.bullet : '')
          : b;
        return {
          text: String(raw == null ? '' : raw).trim().slice(0, 80),
          cluster: String((b && typeof b === 'object' && (b.cluster || b.name)) || '').trim(),
        };
      })
      .filter((b) => b.text && b.text !== '[object Object]').slice(0, 40);
    return {
      selfPositioning: String((parsed && parsed.selfPositioning) || '').trim().slice(0, 100),
      directionProfile: String((parsed && parsed.directionProfile) || '').trim().slice(0, 400),
      resumeBullets: bullets,
      traits: strArr(parsed && parsed.traits, 5),
      gaps: strArr(parsed && parsed.gaps, 5),
      interviewFocus: strArr(parsed && parsed.interviewFocus, 5),
    };
  }

  /** 出题（库内素材不足时兜底）。 */
  async makeQuestion(clusterName, material) {
    const s = this.s;
    const spec = '【输出格式】只输出 JSON：{"question":"一道具体的面试题"}';
    const content = await this.chat(
      [{ role: 'system', content: s.askHarness }, { role: 'user', content: `【考察方向】${clusterName}\n【资料】\n${material}\n\n${spec}` }],
      { temperature: 0.5, jsonMode: true }
    );
    const parsed = extractJson(content, s.jsonRepairEnabled);
    return String((parsed && parsed.question) || '').trim() || `请谈谈你在 ${clusterName} 方面的实践经验。`;
  }

  /** 阅卷 → {score, comment, keyPoints} */
  async gradeAnswer(question, answer, material) {
    const s = this.s;
    const spec = [
      '【输出格式（必须严格遵守）】',
      '只输出 JSON：{"score":0到100整数,"comment":"不超过120字的点评","keyPoints":["应覆盖的关键点"]}',
      'keyPoints 最多 5 条。',
    ].join('\n');
    const content = await this.chat(
      [{ role: 'system', content: s.gradeHarness }, { role: 'user', content: `【题目】\n${question}\n\n【我的回答】\n${answer}\n\n【参考资料】\n${material}\n\n${spec}` }],
      { temperature: 0.2, jsonMode: true }
    );
    const parsed = extractJson(content, s.jsonRepairEnabled);
    return {
      score: Math.max(0, Math.min(100, Math.round(Number(parsed && parsed.score) || 0))),
      comment: String((parsed && parsed.comment) || '').trim().slice(0, 300),
      keyPoints: (Array.isArray(parsed && parsed.keyPoints) ? parsed.keyPoints : []).map((x) => String(x).trim()).filter(Boolean).slice(0, 5),
    };
  }

  /** 通用 JSON POST（用于搜索适配器）。 */
  httpJson(urlStr, bodyObj, extraHeaders) {
    return new Promise((resolve, reject) => {
      let url;
      try {
        url = new URL(urlStr);
      } catch (e) {
        reject(new Error('地址无效：' + urlStr));
        return;
      }
      const mod = url.protocol === 'https:' ? https : http;
      const headers = Object.assign({ 'Content-Type': 'application/json' }, extraHeaders || {});
      let settled = false;
      const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };
      const req = mod.request(url, { method: 'POST', headers, timeout: 30000 }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          // 先判状态码再解析：4xx/5xx 返回 HTML 或空体时，也要给出真实的 HTTP 原因
          if (res.statusCode >= 400) {
            let msg = String(body || '').trim();
            try {
              const d = JSON.parse(body);
              msg = (d && (d.error || d.message || d.detail)) || msg;
            } catch (e) { /* 非 JSON 错误体，保留原文 */ }
            if (!msg) msg = '空响应';
            done(reject, new Error('HTTP ' + res.statusCode + '：' + String(msg).slice(0, 200)));
            return;
          }
          if (!String(body || '').trim()) {
            done(reject, new Error('HTTP ' + res.statusCode + '：空响应'));
            return;
          }
          try {
            done(resolve, JSON.parse(body));
          } catch (e) {
            done(reject, new Error('响应解析失败：' + String(body).slice(0, 200)));
          }
        });
        res.on('error', (e) => done(reject, e));
        // 兜底：连接被提前关闭时也保证 settle 一次
        res.on('close', () => done(reject, new Error('搜索请求连接中断')));
      });
      req.on('timeout', () => req.destroy(new Error('搜索请求超时')));
      req.on('error', (e) => done(reject, e));
      req.write(JSON.stringify(bodyObj));
      req.end();
    });
  }

  /** 搜索适配器：Tavily / Serper；未配置返回空数组。 */
  async webSearch(query) {
    const s = this.s;
    try {
      if (s.searchProvider === 'tavily' && s.searchApiKey) {
        const d = await this.httpJson('https://api.tavily.com/search', { api_key: s.searchApiKey, query, max_results: 5 });
        return (d.results || []).map((r) => `${(r && r.title) || ''}：${String((r && r.content) || '').slice(0, 220)}`).filter((x) => x.length > 3);
      }
      if (s.searchProvider === 'serper' && s.searchApiKey) {
        const d = await this.httpJson('https://google.serper.dev/search', { q: query }, { 'X-API-KEY': s.searchApiKey });
        return (d.organic || []).map((r) => `${(r && r.title) || ''}：${String((r && r.snippet) || '').slice(0, 220)}`).filter((x) => x.length > 3);
      }
    } catch (e) {
      throw new Error(`联网搜索失败（${s.searchProvider}）：${e.message}`);
    }
    return [];
  }

  /** 行业雷达：按方向批量生成行业卡片。 */
  async pulseForTracks(trackInfos, onProgress, searchEnabled) {
    const s = this.s;
    const out = {};
    for (let i = 0; i < trackInfos.length; i++) {
      const t = trackInfos[i];
      let searchTxt = '';
      if (searchEnabled) {
        try {
          const rs = await this.webSearch(`${t.name} 技术栈 发展趋势 替代方案`);
          if (rs.length) searchTxt = `【联网检索结果（作为主要依据）】\n${rs.map((r, k) => `${k + 1}. ${r}`).join('\n')}\n`;
        } catch (e) {
          searchTxt = `（联网检索不可用：${e.message}；请改用模型知识并如实标注不确定性）\n`;
        }
      }
      const cl = t.clusters.map((c) => `${c.name}（${c.count} 篇，均深 ${c.avgDepth}）`).join('、');
      const spec = [
        '【输出格式（必须严格遵守）】',
        '只输出 JSON：',
        '{"status":"活跃上升|平稳|降温|被替代中","hotness":1到10整数,"summary":"该方向近1-2年行业趋势，80字内","replacements":[{"name":"竞品或替代技术","relation":"竞争|互补|升级替代","note":"30字内对比"}],"recentChanges":[{"when":"约20XX年","event":"大事件","impact":"对该方向使用者意味着什么，30字内"}],"advice":"结合我的深度给的具体建议，60字内","learnNext":[{"item":"补充学习项","why":"理由","priority":"P0|P1|P2"}]}',
        'replacements 2-4 条；recentChanges 1-3 条；learnNext 2-4 条。',
      ].join('\n');
      const content = await this.chat(
        [{ role: 'system', content: s.pulseHarness }, { role: 'user', content: `【技术方向】${t.name}\n【我掌握的技能】${cl}\n${searchTxt}\n${spec}` }],
        { temperature: 0.4, jsonMode: true }
      );
      const parsed = extractJson(content, s.jsonRepairEnabled);
      out[t.name] = {
        status: String((parsed && parsed.status) || '').trim().slice(0, 12),
        hotness: Math.max(1, Math.min(10, Math.round(Number(parsed && parsed.hotness) || 5))),
        summary: String((parsed && parsed.summary) || '').trim().slice(0, 200),
        advice: String((parsed && parsed.advice) || '').trim().slice(0, 200),
        replacements: (Array.isArray(parsed && parsed.replacements) ? parsed.replacements : [])
          .map((r) => ({
            name: String((r && r.name) || '').trim().slice(0, 40),
            relation: String((r && r.relation) || '相关').trim().slice(0, 10),
            note: String((r && r.note) || '').trim().slice(0, 80),
          })).filter((r) => r.name).slice(0, 4),
        recentChanges: (Array.isArray(parsed && parsed.recentChanges) ? parsed.recentChanges : [])
          .map((r) => ({
            when: String((r && r.when) || '').trim().slice(0, 20),
            event: String((r && r.event) || '').trim().slice(0, 90),
            impact: String((r && r.impact) || '').trim().slice(0, 90),
          })).filter((r) => r.event).slice(0, 3),
        learnNext: (Array.isArray(parsed && parsed.learnNext) ? parsed.learnNext : [])
          .map((r) => ({
            item: String((r && r.item) || '').trim().slice(0, 60),
            why: String((r && r.why) || '').trim().slice(0, 90),
            priority: String((r && r.priority) || 'P1').trim().slice(0, 2),
          })).filter((r) => r.item).slice(0, 4),
      };
      if (onProgress) onProgress(i + 1, trackInfos.length);
    }
    return out;
  }

  /** 通用 GET JSON（GitHub API 等；需 User-Agent）。 */
  httpGetJson(urlStr, extraHeaders) {
    return new Promise((resolve, reject) => {
      let url;
      try {
        url = new URL(urlStr);
      } catch (e) {
        reject(new Error('地址无效：' + urlStr));
        return;
      }
      const mod = url.protocol === 'https:' ? https : http;
      const headers = Object.assign({
        'User-Agent': 'obsidian-xyblue135-skill-miner',
        Accept: 'application/vnd.github+json',
      }, extraHeaders || {});
      let settled = false;
      const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };
      const req = mod.request(url, { method: 'GET', headers, timeout: 30000 }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            if (res.statusCode >= 400) throw new Error('HTTP ' + res.statusCode + (data && data.message ? '：' + data.message : ''));
            done(resolve, data);
          } catch (e) {
            done(reject, e instanceof Error ? e : new Error(String(e)));
          }
        });
        res.on('error', (e) => done(reject, e));
        res.on('close', () => done(reject, new Error('连接中断')));
      });
      req.on('timeout', () => req.destroy(new Error('请求超时')));
      req.on('error', (e) => done(reject, e));
      req.end();
    });
  }

  /** 拉取白名单仓库元数据 + 语言字节数。失败的单个仓库保留占位（含 error 说明）。 */
  async fetchGithubRepos(username, whitelist) {
    const names = String(whitelist || '').split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 12);
    if (!names.length) throw new Error('仓库白名单为空，请在设置中配置');
    const out = [];
    for (const name of names) {
      try {
        const r = await this.httpGetJson(`https://api.github.com/repos/${encodeURIComponent(username)}/${encodeURIComponent(name)}`);
        let languages = {};
        try { languages = await this.httpGetJson(`https://api.github.com/repos/${encodeURIComponent(username)}/${encodeURIComponent(name)}/languages`); } catch (e) { /* 语言接口失败不阻塞 */ }
        out.push({
          name: r.name || name,
          full_name: r.full_name || `${username}/${name}`,
          html_url: r.html_url || `https://github.com/${username}/${name}`,
          description: String(r.description || '').trim(),
          language: r.language || '',
          stargazers_count: Number(r.stargazers_count) || 0,
          topics: Array.isArray(r.topics) ? r.topics.slice(0, 6) : [],
          pushed_at: String(r.pushed_at || ''),
          languages,
        });
      } catch (e) {
        out.push({
          name, full_name: `${username}/${name}`, html_url: `https://github.com/${username}/${name}`,
          description: '', language: '', stargazers_count: 0, topics: [], pushed_at: '',
          languages: {}, error: String(e.message || e).slice(0, 120),
        });
      }
    }
    return out;
  }

  /** 为仓库生成简历用一句话介绍 → {lines: {repoName: text}}。 */
  async ghEnhanceRepos(repos) {
    const s = this.s;
    const list = (repos || []).slice(0, 8);
    if (!list.length) return { lines: {} };
    const lines = list.map((r) => `- ${r.name}（语言：${r.language || '未知'}${Number(r.stargazers_count) ? `，${r.stargazers_count} stars` : ''}）：${r.description || '（无描述）'}${r.topics && r.topics.length ? ` · topics: ${r.topics.join('/')}` : ''}`);
    const spec = [
      '【输出格式（必须严格遵守）】',
      '只输出 JSON：{"lines":{"仓库名":"一句话简历介绍"}}',
      '必须覆盖输入的每一个仓库，键为仓库名原文；每条 30-55 字，突出解决什么问题与使用的核心技术。',
    ].join('\n');
    const content = await this.chat(
      [{ role: 'system', content: s.ghHarness }, { role: 'user', content: `【GitHub 仓库清单】\n${lines.join('\n')}\n\n${spec}` }],
      { temperature: 0.3, jsonMode: true }
    );
    const parsed = extractJson(content, s.jsonRepairEnabled);
    const raw = parsed && typeof parsed.lines === 'object' && parsed.lines ? parsed.lines : {};
    const out = {};
    for (const r of list) {
      const v = raw[r.name] != null ? raw[r.name] : (parsed && Array.isArray(parsed.lines) ? (parsed.lines.find((x) => x && x.name === r.name) || {}).line : null);
      out[r.name] = String(v == null ? '' : v).trim().slice(0, 120) || r.description || '';
    }
    return { lines: out };
  }

  /** 简历内容生成 → {bio, positioning, goal, work[], projects[], keywords[]}。 */
  async buildResumeContent(materials) {
    const s = this.s;
    const m = materials || {};
    const user = [
      m.positioning ? `【画像定位】\n${m.positioning}` : '',
      m.bullets && m.bullets.length ? `【技能条目（按含金量排序）】\n${m.bullets.map((b) => '- ' + b).join('\n')}` : '',
      m.work && m.work.length ? `【工作经历原始素材】\n${m.work.map((w, i) => `-- 素材 ${i + 1} --\n${w}`).join('\n')}` : '',
      m.projects && m.projects.length ? `【项目原始素材】\n${m.projects.map((w, i) => `-- 项目 ${i + 1} --\n${w}`).join('\n')}` : '',
      m.repos && m.repos.length ? `【GitHub 仓库（简历「Popular repositories」栏）】\n${m.repos.map((r) => `- ${r.name}：${r.description || ''}（${r.language || '未知'}）`).join('\n')}` : '',
      m.certs && m.certs.length ? `【用户主动提供的证书（简历中必须体现）】\n${m.certs.map((c) => '- ' + c).join('\n')}` : '',
      m.goal ? `【求职意向】\n${m.goal}` : '',
      '',
      '【输出格式（必须严格遵守）】',
      '只输出 JSON：',
      '{"bio":"GitHub 主页风格一句话（不超过60字）","positioning":"简历定位语（50字内，可与画像定位融合）","goal":"目标方向一句话（合并求职意向）","work":[{"company":"公司或场景名","title":"职位/角色","bullets":["动词开头的经历条目"]}],"projects":[{"name":"项目名","tech":"技术栈","desc":"30-60字描述"}],"keywords":["技能关键词8-12个"]}',
      'work 按素材整理成 1-3 段经历，每段 4-7 条 bullets；projects 合并素材中的项目与 GitHub 仓库要点，3-6 个；禁止编造素材外的经历与数字。',
    ].filter(Boolean).join('\n\n');
    const content = await this.chat(
      [{ role: 'system', content: s.resumeHarness }, { role: 'user', content: user }],
      { temperature: 0.3, jsonMode: true }
    );
    const parsed = extractJson(content, s.jsonRepairEnabled);
    const normWork = (Array.isArray(parsed && parsed.work) ? parsed.work : [])
      .map((w) => ({
        company: String((w && w.company) || '').trim().slice(0, 60),
        title: String((w && w.title) || '').trim().slice(0, 60),
        bullets: (Array.isArray(w && w.bullets) ? w.bullets : []).map((b) => String(b == null ? '' : b).trim().slice(0, 80)).filter(Boolean).slice(0, 8),
      })).filter((w) => w.company);
    const normProjects = (Array.isArray(parsed && parsed.projects) ? parsed.projects : [])
      .map((p) => ({
        name: String((p && p.name) || '').trim().slice(0, 40),
        tech: String((p && p.tech) || '').trim().slice(0, 60),
        desc: String((p && p.desc) || '').trim().slice(0, 120),
      })).filter((p) => p.name);
    return {
      bio: String((parsed && parsed.bio) || '').trim().slice(0, 120),
      positioning: String((parsed && parsed.positioning) || '').trim().slice(0, 120),
      goal: String((parsed && parsed.goal) || '').trim().slice(0, 80),
      work: normWork,
      projects: normProjects,
      keywords: (Array.isArray(parsed && parsed.keywords) ? parsed.keywords : []).map((x) => String(x == null ? '' : x).trim()).filter(Boolean).slice(0, 12),
    };
  }

  /** 学习计划合成。 */
  async buildPlan(ctxText) {
    const s = this.s;
    const spec = [
      '【输出格式（必须严格遵守）】',
      '只输出 JSON：',
      '{"items":[{"item":"学什么","why":"为什么，50字内","priority":"P0|P1|P2","target":"学到什么程度算够，40字内","related":"相关技术方向"}]}',
      'items 6-12 条按优先级排序，合并重复项。',
    ].join('\n');
    const content = await this.chat(
      [{ role: 'system', content: s.planHarness }, { role: 'user', content: `【我的画像与缺口材料】\n${ctxText}\n\n${spec}` }],
      { temperature: 0.3, jsonMode: true }
    );
    const parsed = extractJson(content, s.jsonRepairEnabled);
    return (Array.isArray(parsed && parsed.items) ? parsed.items : [])
      .map((x) => ({
        item: String((x && x.item) || '').trim().slice(0, 80),
        why: String((x && x.why) || '').trim().slice(0, 120),
        priority: String((x && x.priority) || 'P1').trim().slice(0, 2),
        target: String((x && x.target) || '').trim().slice(0, 80),
        related: String((x && x.related) || '').trim().slice(0, 30),
      })).filter((x) => x.item).slice(0, 12);
  }
}

/* ============================ 主面板 ============================ */

const SK_TABS = [
  ['overview', '总览'],
  ['tree', '技能树'],
  ['resume', '简历素材'],
  ['gh', 'GitHub 项目'],
  ['cvgen', '简历生成'],
  ['pulse', '行业雷达'],
  ['plan', '学习计划'],
];

class SkillMinerModal extends Modal {
  constructor(plugin) {
    super(plugin.app);
    this.plugin = plugin;
  }

  onOpen() {
    this.modalEl.addClass('xysk-modal');
    this._busy = false;
    this.tab = 'overview';
    this.expandedTracks = new Set();
    this.expandedClusters = new Set();
    this._lastCard = null;
    const content = this.contentEl;
    content.empty();

    const header = el('div', 'xysk-header');
    header.appendChild(el('div', 'xysk-title', '技能提炼 · 个人画像'));
    this.statsEl = el('div', 'xysk-stats');
    header.appendChild(this.statsEl);
    content.appendChild(header);

    const nav = el('div', 'xysk-tabs');
    this.tabBtns = {};
    for (const [key, label] of SK_TABS) {
      const btn = el('button', 'xysk-tab', label);
      btn.onclick = () => this.switchTab(key);
      this.tabBtns[key] = btn;
      nav.appendChild(btn);
    }
    content.appendChild(nav);

    this.bodyEl = el('div', 'xysk-tabbody');
    content.appendChild(this.bodyEl);
    this.switchTab('overview');
  }

  setStatus(t) {
    if (this.statusEl) this.statusEl.textContent = t;
  }

  switchTab(key) {
    this.tab = key;
    for (const k of Object.keys(this.tabBtns)) this.tabBtns[k].toggleClass('is-active', k === key);
    this.renderTab();
  }

  renderTab() {
    this.bodyEl.empty();
    this.statusEl = null;
    const m = this.plugin.matrix;
    this.statsEl.textContent = m
      ? `矩阵：${m.totalDocs} 篇（仅 status: done）· ${m.clusters.length} 簇 · ${(m.tracks || []).length} 方向 · 生成于 ${formatDate(m.generatedAt)}`
      : '尚未构建技能矩阵';
    if (this.tab === 'overview') this.renderOverview();
    else if (this.tab === 'tree') this.renderTree();
    else if (this.tab === 'resume') this.renderResume();
    else if (this.tab === 'gh') this.renderGh();
    else if (this.tab === 'cvgen') this.renderCvgen();
    else if (this.tab === 'pulse') this.renderPulse();
    else if (this.tab === 'plan') this.renderPlan();
  }

  /* ---------- 总览：图表 ---------- */

  renderOverview() {
    const b = this.bodyEl;
    const m = this.plugin.matrix;

    const actions = el('div', 'xysk-actions');
    this.btnMatrix = el('button', '', '重建矩阵');
    this.btnRefine = el('button', 'mod-cta', 'AI 提炼画像');
    this.btnInterview = el('button', '', '模拟面试');
    this.btnNote = el('button', '', '打开画像笔记');
    actions.append(this.btnMatrix, this.btnRefine, this.btnInterview, this.btnNote);
    this.statusEl = el('div', 'xysk-status', '');
    actions.appendChild(this.statusEl);
    b.appendChild(actions);

    this.btnMatrix.onclick = () => this.runMatrix();
    this.btnRefine.onclick = () => this.runRefine();
    this.btnInterview.onclick = () => new InterviewModal(this.plugin).open();
    this.btnNote.onclick = () => this.openProfileNote();

    if (!m) {
      b.appendChild(el('div', 'xysk-status', '先点击「重建矩阵」扫描知识库，再「AI 提炼画像」生成定级与条目。'));
      return;
    }
    const maxIntensity = m.tracks && m.tracks.length ? m.tracks[0].intensity : 1;
    const charts = [
      ['技能象限图（横轴 = 平均深度，纵轴 = 文章数，气泡 = 总字数，颜色 = AI 类别）', bubbleQuadrantSVG(m)],
      ['方向强度雷达（强度 = 文章数 × 深度加权）', radarSVG((m.tracks || []).slice(0, 8).map((t) => ({ name: t.name, value: t.intensity / Math.max(1, maxIntensity) })))],
      ['方向条形图（方向 → 技能簇的归属）', trackBarsSVG(m)],
      ['近 12 个月学习时间线（按方向堆叠，看升温与降温）', timelineStackedSVG(m)],
    ];
    for (const [title, svg] of charts) {
      if (!svg) continue;
      const box = el('div', 'xysk-section xysk-chart');
      box.appendChild(el('div', 'xysk-section-title', title));
      const holder = el('div', '');
      holder.innerHTML = svg;
      box.appendChild(holder);
      b.appendChild(box);
    }
    if (!this.plugin.data.synth) {
      b.appendChild(el('div', 'xysk-status', '提示：完成「AI 提炼画像」后，象限图的颜色分类（核心技能 / 工具 / 环境 / 兴趣）会由 AI 标定。'));
    }
  }

  /* ---------- 技能树 + 技能卡片 ---------- */

  renderTree() {
    const b = this.bodyEl;
    const m = this.plugin.matrix;
    if (!m) {
      b.appendChild(el('div', 'xysk-status', '请先重建矩阵'));
      return;
    }
    const toolbar = el('div', 'xysk-actions');
    const btnExpand = el('button', '', '全部展开');
    const btnCollapse = el('button', '', '全部收起');
    toolbar.append(btnExpand, btnCollapse);
    b.appendChild(toolbar);
    // 动态分支的碎片化提示：内置 11 个之外由 AI 新建的方向统计
    const customTracks = (m.tracks || []).filter((t) => !TRACK_COLORS[t.name]);
    if (customTracks.length > 5) {
      b.appendChild(el('div', 'xysk-status', `AI 新建了 ${customTracks.length} 个方向（${customTracks.map((t) => t.name).join('、')}）。若觉得太碎，可重新跑一次「AI 提炼」让模型复用已有方向，或合并对应标签。`));
    }
    btnExpand.onclick = () => {
      for (const t of m.tracks) this.expandedTracks.add(t.name);
      this.renderTab();
    };
    btnCollapse.onclick = () => {
      this.expandedTracks.clear();
      this.expandedClusters.clear();
      this.renderTab();
    };

    const refMap = makeNameLookup(this.plugin.data.refined || []);
    const tree = el('div', 'xysk-tree');
    for (const t of m.tracks) {
      const open = this.expandedTracks.has(t.name);
      const tRow = el('div', 'xysk-tree-row');
      const dot = el('span', 'xysk-dot');
      dot.style.background = t.color || trackColor(t.name);
      tRow.appendChild(dot);
      tRow.appendChild(el('span', '', `${open ? '▾' : '▸'} ${t.name}`));
      tRow.appendChild(el('span', 'xysk-bullet-meta', `${t.count} 篇 · 均深 ${t.avgDepth} · 强度 ${t.intensity}`));
      tRow.onclick = () => {
        if (open) this.expandedTracks.delete(t.name);
        else this.expandedTracks.add(t.name);
        this.renderTab();
      };
      tree.appendChild(tRow);
      if (!open) continue;
      const child = el('div', 'xysk-tree-child');
      for (const c of m.clusters.filter((x) => x.track === t.name)) {
        const r = refMap.get(c.name) || {};
        const cOpen = this.expandedClusters.has(c.name);
        const cRow = el('div', 'xysk-tree-row');
        cRow.appendChild(el('span', '', `${cOpen ? '▾' : '▸'} ${c.name}`));
        if (r.level) {
          const face = el('span', 'xysk-emoji', LEVEL_FACE[r.level] || '🙂');
          face.title = `AI 定级：${r.level}`;
          cRow.appendChild(face);
        }
        cRow.appendChild(el('span', 'xysk-bullet-meta', `${c.count} 篇 · 均${c.avgDepth}`));
        const searchBtn = el('a', 'xysk-evidence', '🔍');
        searchBtn.title = `在 AI 检索中搜索「${c.name}」`;
        searchBtn.onclick = (ev) => {
          ev.stopPropagation();
          this.plugin.searchInAISearch(c.name);
        };
        cRow.appendChild(searchBtn);
        cRow.onclick = (ev) => {
          if (ev.target === searchBtn) return;
          this._lastCard = c;
          if (cOpen) this.expandedClusters.delete(c.name);
          else this.expandedClusters.add(c.name);
          this.renderTab();
        };
        child.appendChild(cRow);
        if (cOpen) {
          // 展开时列出全部证据文章（不再截断）。长列表放进独立滚动区，避免撑高面板。
          const docBox = el('div', 'xysk-tree-docs');
          for (const doc of c.docs) {
            const dRow = el('div', 'xysk-tree-doc', `· ${doc.title}（深度 ${doc.depth}）`);
            dRow.title = doc.path;
            dRow.onclick = () => this.plugin.openDoc(doc.path);
            docBox.appendChild(dRow);
          }
          child.appendChild(docBox);
        }
      }
      tree.appendChild(child);
    }
    b.appendChild(tree);

    this.cardEl = el('div', 'xysk-section');
    b.appendChild(this.cardEl);
    if (this._lastCard) this.showCard(this._lastCard);
    else this.cardEl.appendChild(el('div', 'xysk-status', '点击任意技能簇查看详情卡片：统计 / AI 定级 / 行业解读 / 证据文章'));
  }

  showCard(c) {
    if (!this.cardEl || !c) return;
    const sec = this.cardEl;
    sec.empty();
    const head = el('div', 'xysk-section-title');
    head.appendChild(el('span', '', `${c.name} · ${c.track}`));
    const searchBtn = el('a', 'xysk-evidence', '🔍 AI 检索');
    searchBtn.onclick = () => this.plugin.searchInAISearch(c.name);
    head.appendChild(searchBtn);
    sec.appendChild(head);
    sec.appendChild(el('div', 'xysk-kv', `${c.count} 篇 · 平均深度 ${c.avgDepth} · 最高 ${c.maxDepth} · 约 ${Math.round((c.tokens || 0) / 1000)}k 字 · 最近更新 ${c.last ? parseYearMonth(c.last) || '-' : '-'}`));
    const r = makeNameLookup(this.plugin.data.refined || []).get(c.name);
    if (r) {
      sec.appendChild(el('div', 'xysk-kv', `AI 定级：${LEVEL_FACE[r.level] || ''} ${r.level} · ${r.category}`));
      if (r.resumeLine) sec.appendChild(el('div', 'xysk-kv', `简历条目：${r.resumeLine}`));
      if (r.summary) sec.appendChild(el('div', 'xysk-kv', r.summary));
    }
    const pulse = this.plugin.data.pulse;
    const p = pulse && pulse.tracks ? pulse.tracks[c.track] : null;
    if (p) {
      sec.appendChild(el('div', 'xysk-kv', `行业：${p.status || ''} · 热度 ${p.hotness}/10（${formatDate(pulse.generatedAt)}）`));
      if (p.advice) sec.appendChild(el('div', 'xysk-kv', `建议：${p.advice}`));
      if (p.replacements && p.replacements.length) {
        sec.appendChild(el('div', 'xysk-kv', '竞品：' + p.replacements.map((x) => `${x.name}（${x.relation}）`).join('、')));
      }
    }
    sec.appendChild(el('b', 'xysk-kv', `证据文章（共 ${c.count} 篇，按深度排序）`));
    // 全部列出；条数多时由 .xysk-card-docs 自己滚动。
    const cardDocs = el('div', 'xysk-card-docs');
    for (const doc of c.docs) {
      const link = el('a', 'xysk-evidence', `${doc.title}（深度 ${doc.depth}）`);
      link.style.display = 'block';
      link.title = doc.path;
      link.onclick = () => this.plugin.openDoc(doc.path);
      cardDocs.appendChild(link);
    }
    sec.appendChild(cardDocs);
  }

  /* ---------- 简历素材 ---------- */

  renderResume() {
    const b = this.bodyEl;
    const d = this.plugin.data;
    const secB = el('div', 'xysk-section');
    secB.appendChild(el('div', 'xysk-section-title', '简历技能条目（勾选后导出）'));
    const bullets = Array.isArray(d.synth && d.synth.resumeBullets) ? d.synth.resumeBullets : [];
    if (!bullets.length) secB.appendChild(el('div', 'xysk-status', 'AI 提炼后生成'));
    // 归一化查找：AI 返回的 bullet.cluster 与本地簇名不完全相同时也能挂上证据
    const clusterLookup = makeNameLookup(this.plugin.matrix ? this.plugin.matrix.clusters : []);
    // 「全选 / 全不选」+ 已选计数：条目多时逐条手点太累。
    // items: [{ cb, scope, bi, text }]，sel: selectedBullets 或 selectedTraits
    const makeBulkBar = (items, sel) => {
      const bar = el('div', 'xysk-actions');
      const cnt = el('span', 'xysk-status', '');
      const refresh = () => {
        const n = items.filter((it) => selPicked(sel, it.scope, it.bi, it.text)).length;
        cnt.textContent = `已选 ${n} / ${items.length}`;
      };
      const btnAll = el('button', '', '全选');
      const btnNone = el('button', '', '全不选');
      btnAll.onclick = async () => {
        for (const it of items) {
          sel[stableSelKey(it.scope, it.bi)] = true;
          const tk = selKey(it.text);
          if (tk) sel[tk] = true;
          it.cb.checked = true;
        }
        refresh();
        await this.plugin.saveAll();
      };
      btnNone.onclick = async () => {
        for (const it of items) {
          delete sel[stableSelKey(it.scope, it.bi)];
          selDel(sel, it.text);
          it.cb.checked = false;
        }
        refresh();
        await this.plugin.saveAll();
      };
      bar.append(btnAll, btnNone, cnt);
      return { bar, refresh };
    };
    const bItems = [];
    const bRows = []; // 先攒行，再把批量操作条插到最前面
    for (let bi = 0; bi < bullets.length; bi++) {
      const bl = bullets[bi] && typeof bullets[bi] === 'object' ? bullets[bi] : { text: String(bullets[bi] == null ? '' : bullets[bi]) };
      const row = el('label', 'xysk-bullet');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      // 稳定键用「簇名#序号」；旧数据以句子文本为键，回退命中后顺手补写稳定键
      const bkey = stableSelKey(bl.cluster, bi);
      if (!d.selectedBullets[bkey] && selHit(d.selectedBullets, bl.text)) d.selectedBullets[bkey] = true;
      cb.checked = !!d.selectedBullets[bkey];
      cb.onchange = async () => {
        if (cb.checked) {
          d.selectedBullets[bkey] = true;
          // 同时记文本指纹：AI 下次调整条目顺序时序号键会指错，文本键还能命中
          const tk = selKey(bl.text);
          if (tk) d.selectedBullets[tk] = true;
        }
        else { delete d.selectedBullets[bkey]; selDel(d.selectedBullets, bl.text); }
        bSeq.refresh();
        await this.plugin.saveAll();
      };
      row.append(cb, el('span', 'xysk-bullet-text', bl.text));
      const c = clusterLookup.get(bl.cluster);
      if (bl.cluster) {
        row.appendChild(el('span', 'xysk-bullet-meta', `${bl.cluster}${c ? ` · ${c.count} 篇 均深${c.avgDepth}` : ''}`));
      }
      bItems.push({ cb, scope: bl.cluster, bi, text: bl.text });
      bRows.push(row);
    }
    const bSeq = makeBulkBar(bItems, d.selectedBullets);
    if (bItems.length) secB.appendChild(bSeq.bar);
    for (const r of bRows) secB.appendChild(r);
    bSeq.refresh();
    b.appendChild(secB);

    const secT = el('div', 'xysk-section');
    secT.appendChild(el('div', 'xysk-section-title', '风格特质（AI 推断，仅供参考）'));
    const traits = Array.isArray(d.synth && d.synth.traits) ? d.synth.traits : [];
    if (!traits.length) secT.appendChild(el('div', 'xysk-status', 'AI 提炼后生成'));
    const tItems = [];
    const tRows = [];
    for (let ti = 0; ti < traits.length; ti++) {
      const t = traits[ti];
      const row = el('label', 'xysk-bullet');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      // 特质是纯文本没有簇名，稳定键用固定前缀 + 序号
      const tkey = stableSelKey('_trait', ti);
      if (!d.selectedTraits[tkey] && selHit(d.selectedTraits, t)) d.selectedTraits[tkey] = true;
      cb.checked = !!d.selectedTraits[tkey];
      cb.onchange = async () => {
        if (cb.checked) {
          d.selectedTraits[tkey] = true;
          const tk = selKey(t);
          if (tk) d.selectedTraits[tk] = true;
        }
        else { delete d.selectedTraits[tkey]; selDel(d.selectedTraits, t); }
        tSeq.refresh();
        await this.plugin.saveAll();
      };
      row.append(cb, el('span', 'xysk-bullet-text', t));
      tItems.push({ cb, scope: '_trait', bi: ti, text: t });
      tRows.push(row);
    }
    const tSeq = makeBulkBar(tItems, d.selectedTraits);
    if (tItems.length) secT.appendChild(tSeq.bar);
    for (const r of tRows) secT.appendChild(r);
    tSeq.refresh();
    b.appendChild(secT);

    const foot = el('div', 'xysk-actions');
    const btnExport = el('button', 'mod-cta', '导出简历素材.md');
    btnExport.onclick = () => this.exportResume();
    foot.appendChild(btnExport);
    foot.appendChild(el('span', 'xysk-status', '导出文件只含勾选项，每条附证据文章链接'));
    b.appendChild(foot);
  }

  /* ---------- 行业雷达 ---------- */

  renderPulse() {
    const b = this.bodyEl;
    const d = this.plugin.data;
    const m = this.plugin.matrix;

    const head = el('div', 'xysk-actions');
    this.btnPulse = el('button', 'mod-cta', d.pulse ? '刷新行业雷达' : '生成行业雷达');
    head.appendChild(this.btnPulse);
    this.statusEl = el('span', 'xysk-status', '');
    head.appendChild(this.statusEl);
    b.appendChild(head);

    const searchOn = this.plugin.settings.searchProvider !== 'off' && this.plugin.settings.searchApiKey;
    b.appendChild(el('div', 'xysk-status', searchOn
      ? `联网检索已启用（${this.plugin.settings.searchProvider}），行业判断会参考最新搜索结果`
      : '当前使用模型知识（未联网，注意时效）；可在设置中接入 Tavily / Serper 搜索 API 获得实时信息'));
    if (!m) {
      b.appendChild(el('div', 'xysk-status', '请先重建矩阵'));
      return;
    }
    if (!d.pulse) {
      b.appendChild(el('div', 'xysk-status', '为每个技术方向生成行业卡片：发展状态 / 热度 / 竞品与替代格局 / 近期变动 / 对我的建议 / 补课清单。只发送方向名与统计数字，不发笔记内容。'));
      return;
    }
    const stale = Date.now() - d.pulse.generatedAt > 7 * 86400 * 1000;
    b.appendChild(el('div', 'xysk-status', (stale ? '⚠ 已超过 7 天，建议刷新　·　' : '') + `生成于 ${formatDate(d.pulse.generatedAt)} · 来源：${d.pulse.source || '模型知识'}`));
    const missing = [];
    for (const t of m.tracks || []) {
      const p = d.pulse.tracks[t.name];
      if (!p) { missing.push(t.name); continue; }
      const card = el('div', 'xysk-trackcard');
      const h4 = el('h4', '');
      const tdot = el('span', 'xysk-dot');
      tdot.style.background = t.color || trackColor(t.name);
      h4.appendChild(tdot);
      h4.appendChild(el('span', '', t.name));
      const hot = el('span', 'xysk-hotbar');
      for (let i = 1; i <= 10; i++) hot.appendChild(el('i', i <= p.hotness ? 'on' : ''));
      h4.appendChild(hot);
      if (p.status) h4.appendChild(el('span', 'xysk-status-chip', p.status));
      card.appendChild(h4);
      if (p.summary) card.appendChild(el('div', 'xysk-kv', p.summary));
      if (p.advice) card.appendChild(el('div', 'xysk-kv', `💡 ${p.advice}`));
      if (p.replacements && p.replacements.length) {
        const kv = el('div', 'xysk-kv');
        kv.appendChild(el('b', '', '竞品 / 替代格局：'));
        for (const r of p.replacements) kv.appendChild(el('div', '', `· ${r.name}（${r.relation}）—— ${r.note}`));
        card.appendChild(kv);
      }
      if (p.recentChanges && p.recentChanges.length) {
        const kv = el('div', 'xysk-kv');
        kv.appendChild(el('b', '', '近期变动：'));
        for (const rc of p.recentChanges) kv.appendChild(el('div', '', `· ${rc.when} ${rc.event}${rc.impact ? `（${rc.impact}）` : ''}`));
        card.appendChild(kv);
      }
      if (p.learnNext && p.learnNext.length) {
        const kv = el('div', 'xysk-kv');
        kv.appendChild(el('b', '', '补课：'));
        for (const x of p.learnNext) {
          const line = el('div', '');
          line.appendChild(el('span', `xysk-chip-p xysk-pri-${x.priority}`, x.priority));
          line.appendChild(el('span', '', ` ${x.item} —— ${x.why}`));
          kv.appendChild(line);
        }
        card.appendChild(kv);
      }
      b.appendChild(card);
    }
    if (missing.length) {
      b.appendChild(el('div', 'xysk-status', `${missing.length} 个方向还没有行业数据（${missing.join('、')}），点上方「刷新行业雷达」补齐`));
    }
    this.btnPulse.onclick = () => this.runPulse();
  }

  async runPulse() {
    if (this._busy) return;
    this._busy = true;
    this.btnPulse.disabled = true;
    try {
      await this.plugin.refreshPulse((i, n) => this.setStatus(`行业分析 ${i}/${n}…`));
      this.renderTab();
      new Notice('行业雷达已更新并写入画像笔记');
    } catch (e) {
      new Notice('行业雷达失败：' + e.message, 8000);
      this.setStatus('失败');
    } finally {
      this._busy = false;
      this.btnPulse.disabled = false;
    }
  }

  /* ---------- 学习计划 ---------- */

  renderPlan() {
    const b = this.bodyEl;
    const d = this.plugin.data;
    const head = el('div', 'xysk-actions');
    const btn = el('button', 'mod-cta', d.plan ? '重新生成学习计划' : '生成学习计划');
    btn.onclick = () => this.runPlan();
    head.appendChild(btn);
    const btnGap = el('button', '', '从技能树缺口导入候选');
    btnGap.onclick = () => this.runGapImport();
    head.appendChild(btnGap);
    this.statusEl = el('span', 'xysk-status', '');
    head.appendChild(this.statusEl);
    b.appendChild(head);
    b.appendChild(el('div', 'xysk-status', '计划由「画像薄弱点 + 行业雷达补课建议」合成，按 P0/P1/P2 排序。素材越全（先跑画像 / 雷达），计划越准。'));
    const plan = d.plan;
    if (!plan || !plan.items || !plan.items.length) return;
    b.appendChild(el('div', 'xysk-status', `生成于 ${formatDate(plan.generatedAt)}，勾选完成状态会保存`));
    for (const it of plan.items) {
      const row = el('label', 'xysk-bullet');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!d.planDone[it.item];
      cb.onchange = async () => {
        if (cb.checked) d.planDone[it.item] = true;
        else delete d.planDone[it.item];
        await this.plugin.saveAll();
        this.renderTab();
      };
      const txt = el('span', 'xysk-bullet-text');
      const line1 = el('div', '');
      line1.appendChild(el('span', `xysk-chip-p xysk-pri-${it.priority}`, it.priority));
      line1.appendChild(el('span', ` ${it.item}`));
      txt.appendChild(line1);
      txt.appendChild(el('div', 'xysk-bullet-meta', `${it.why || ''}${it.target ? ` · 目标：${it.target}` : ''}${it.related ? ` · [${it.related}]` : ''}`));
      row.append(cb, txt);
      b.appendChild(row);
    }
  }

  async runGapImport() {
    if (this._busy) return;
    this._busy = true;
    this.setStatus('导入技能树缺口候选中…');
    try {
      const n = await this.plugin.importGapCandidates();
      this.renderTab();
      new Notice(n ? `已导入 ${n} 条缺口候选并写入画像笔记` : '没有新的缺口候选（或已达候选上限）');
    } catch (e) {
      new Notice('缺口导入失败：' + e.message, 8000);
      this.setStatus('失败');
    } finally {
      this._busy = false;
    }
  }

  async runPlan() {
    if (this._busy) return;
    this._busy = true;
    this.setStatus('合成学习计划中…');
    try {
      await this.plugin.makePlan();
      this.renderTab();
      new Notice('学习计划已生成并写入画像笔记');
    } catch (e) {
      new Notice('学习计划失败：' + e.message, 8000);
      this.setStatus('失败');
    } finally {
      this._busy = false;
    }
  }

  /* ---------- GitHub 项目 ---------- */

  renderGh() {
    const b = this.bodyEl;
    const d = this.plugin.data;
    const s = this.plugin.settings;

    const head = el('div', 'xysk-actions');
    this.btnGhFetch = el('button', 'mod-cta', d.ghRepos ? '重新拉取仓库' : '拉取 GitHub 仓库');
    this.btnGhEnhance = el('button', '', 'AI 生成项目一句话');
    this.btnGhEnhance.disabled = !(d.ghRepos && d.ghRepos.length);
    head.append(this.btnGhFetch, this.btnGhEnhance);
    this.statusEl = el('span', 'xysk-status', '');
    head.appendChild(this.statusEl);
    b.appendChild(head);
    b.appendChild(el('div', 'xysk-status', `账号 ${s.githubUsername} · 白名单：${String(s.repoWhitelist || '').split('\n').filter(Boolean).join('、')}（可在设置中修改；只发送仓库名到 GitHub API）`));

    // 0.9.0：本地仓库笔记（00_agent_for_projects）为主数据源——一个仓库一篇 md，14 键元数据。
    const notes = this.plugin.loadProjectNotes();
    b.appendChild(el('div', 'xysk-section-title', `本地项目笔记（00_agent_for_projects · ${notes.length} 篇）`));
    if (!notes.length) {
      b.appendChild(el('div', 'xysk-status', '该目录还没有仓库笔记：一个仓库一篇 md，frontmatter 写 repo / upstream / pushed_at + AI 14 键。'));
    } else {
      for (const r of notes) {
        const card = el('div', 'xysk-trackcard');
        const h4 = el('h4', '');
        h4.appendChild(el('span', '', r.name));
        if (r.upstream) h4.appendChild(el('span', 'xysk-status-chip', `fork ← ${r.upstream}`));
        if (r.freshness) h4.appendChild(el('span', 'xysk-status-chip', r.freshness));
        if (r.pushedAt && /^\d{14,17}$/.test(r.pushedAt)) {
          h4.appendChild(el('span', 'xysk-status-chip', `推送 ${r.pushedAt.slice(0, 4)}-${r.pushedAt.slice(4, 6)}-${r.pushedAt.slice(6, 8)}`));
        }
        card.appendChild(h4);
        if (r.description) card.appendChild(el('div', 'xysk-kv', `💡 ${r.description}`));
        if (r.tags.length) card.appendChild(el('div', 'xysk-kv', r.tags.map((t) => '#' + t).join(' ')));
        if (r.html_url) {
          const a = el('a', 'xysk-evidence', r.html_url);
          a.onclick = () => this.plugin.openExternal(r.html_url);
          card.appendChild(a);
        }
        b.appendChild(card);
      }
    }

    const repos = d.ghRepos || [];
    if (!repos.length) {
      b.appendChild(el('div', 'xysk-status', '拉取后缓存仓库描述 / 语言 / stars 到本地，AI 生成的一句话介绍会用于简历「Popular repositories」栏并写入画像。'));
    } else {
      b.appendChild(el('div', 'xysk-status', `拉取于 ${formatDate(d.ghReposAt || Date.now())}${d.ghEnhanced ? ' · AI 一句话已生成' : ''}`));
      for (const r of repos) {
        const card = el('div', 'xysk-trackcard');
        const h4 = el('h4', '');
        h4.appendChild(el('span', '', r.name));
        if (r.language) {
          const dot = el('span', 'xysk-dot');
          dot.style.background = langColor(r.language);
          h4.appendChild(dot);
          h4.appendChild(el('span', 'xysk-status-chip', r.language));
        }
        if (Number(r.stargazers_count)) h4.appendChild(el('span', 'xysk-status-chip', `★ ${r.stargazers_count}`));
        card.appendChild(h4);
        const line = d.ghEnhanced && d.ghEnhanced.lines ? d.ghEnhanced.lines[r.name] : '';
        if (line) card.appendChild(el('div', 'xysk-kv', `💡 ${line}`));
        if (r.description) card.appendChild(el('div', 'xysk-kv', r.description));
        if (r.error) card.appendChild(el('div', 'xysk-kv xysk-error', '拉取失败：' + r.error));
        if (r.html_url) {
          const a = el('a', 'xysk-evidence', r.html_url);
          a.onclick = () => this.plugin.openExternal(r.html_url);
          card.appendChild(a);
        }
        b.appendChild(card);
      }
    }
    this.btnGhFetch.onclick = () => this.runGhFetch();
    this.btnGhEnhance.onclick = () => this.runGhEnhance();
  }

  async runGhFetch() {
    if (this._busy) return;
    this._busy = true;
    this.btnGhFetch.disabled = true;
    this.setStatus('拉取 GitHub 仓库中…');
    try {
      const repos = await this.plugin.refreshGithub();
      this.renderTab();
      const fail = repos.filter((r) => r.error).length;
      new Notice(fail ? `已拉取 ${repos.length} 个仓库（${fail} 个失败）` : `已拉取 ${repos.length} 个仓库`);
    } catch (e) {
      new Notice('GitHub 拉取失败：' + e.message, 8000);
      this.setStatus('失败');
    } finally {
      this._busy = false;
      this.btnGhFetch.disabled = false;
    }
  }

  async runGhEnhance() {
    if (this._busy) return;
    this._busy = true;
    this.btnGhEnhance.disabled = true;
    this.setStatus('AI 生成项目一句话中…');
    try {
      await this.plugin.enhanceGithub();
      this.renderTab();
      new Notice('项目一句话已生成并写入画像');
    } catch (e) {
      new Notice('AI 增强失败：' + e.message, 8000);
      this.setStatus('失败');
    } finally {
      this._busy = false;
      this.btnGhEnhance.disabled = false;
    }
  }

  /* ---------- 简历生成 + 手动补充 ---------- */

  renderCvgen() {
    const b = this.bodyEl;
    const d = this.plugin.data;
    const manual = d.manual || [];
    const kinds = ['基本信息', '证书', '教育背景', '工作经历', '项目', '其他'];

    const secAdd = el('div', 'xysk-section');
    secAdd.appendChild(el('div', 'xysk-section-title', '手动补充（简历必含素材暂存区）'));
    secAdd.appendChild(el('div', 'xysk-status', '证书、教育、工作经历等知识库里没有的内容在这里暂存，生成简历时作为必含素材交给 AI；首次已预填你的基本信息与三本证书。'));
    const rowAdd = el('div', 'xysk-actions');
    const kindSel = el('select', 'dropdown');
    for (const k of kinds) kindSel.appendChild(new Option(k, k));
    const txt = el('input', 'xyais-input');
    txt.placeholder = '例如：HCIP 证书（华为数通方向）或 工作经历：公司 · 职位 · 做了什么';
    const btnAdd = el('button', '', '添加');
    rowAdd.append(kindSel, txt, btnAdd);
    secAdd.appendChild(rowAdd);
    b.appendChild(secAdd);
    btnAdd.onclick = async () => {
      const v = txt.value.trim();
      if (!v) { new Notice('请输入内容'); return; }
      d.manual = d.manual || [];
      d.manual.push({ id: 'm' + Date.now() + Math.floor(Math.random() * 1000), kind: kindSel.value, text: v });
      await this.plugin.saveAll();
      this.renderTab();
    };

    for (const k of kinds) {
      const items = manual.filter((it) => it.kind === k);
      if (!items.length) continue;
      const sec = el('div', 'xysk-section');
      sec.appendChild(el('div', 'xysk-section-title', `${k}（${items.length}）`));
      for (const it of items) {
        const row = el('div', 'xysk-bullet');
        const body = el('span', 'xysk-bullet-text');
        body.textContent = it.text;
        body.style.whiteSpace = 'pre-wrap';
        row.appendChild(body);
        const del = el('a', 'xysk-evidence', '删除');
        del.onclick = async () => {
          d.manual = (d.manual || []).filter((x) => x.id !== it.id);
          await this.plugin.saveAll();
          this.renderTab();
        };
        row.appendChild(del);
        sec.appendChild(row);
      }
      b.appendChild(sec);
    }

    const apRow = el('div', 'xysk-actions');
    const apCb = document.createElement('input');
    apCb.type = 'checkbox';
    apCb.checked = this.plugin.settings.resumeAppendixEnabled !== false;
    apCb.onchange = async () => {
      this.plugin.settings.resumeAppendixEnabled = apCb.checked;
      await this.plugin.saveAll();
    };
    apRow.append(apCb, el('span', 'xysk-status', '附带「技能树」页（简历第 2 页：方向 → 簇全量树状速览，三栏小字号）'));
    b.appendChild(apRow);

    const foot = el('div', 'xysk-actions');
    this.btnResume = el('button', 'mod-cta', d.resume ? '重新生成简历' : '生成简历（GitHub 风格 HTML）');
    foot.appendChild(this.btnResume);
    this.statusEl = el('span', 'xysk-status', '');
    foot.appendChild(this.statusEl);
    b.appendChild(foot);
    if (d.resume && d.resume.path) {
      const line = el('div', 'xysk-status', `上次生成：${formatDate(d.resume.generatedAt)} → ${d.resume.path}`);
      const openBtn = el('button', '', '在浏览器打开');
      openBtn.onclick = () => this.plugin.openResumeFile();
      foot.appendChild(openBtn);
      b.appendChild(line);
    }
    this.btnResume.onclick = () => this.runCvgen();
  }

  async runCvgen() {
    if (this._busy) return;
    this._busy = true;
    this.btnResume.disabled = true;
    try {
      const r = await this.plugin.generateResume((msg) => this.setStatus(msg));
      this.renderTab();
      new Notice('简历已生成：' + r.path + '（可直接用浏览器打开打印为 PDF）', 10000);
    } catch (e) {
      new Notice('简历生成失败：' + e.message, 10000);
      this.setStatus('失败');
    } finally {
      this._busy = false;
      this.btnResume.disabled = false;
    }
  }

  /* ---------- 公共动作 ---------- */

  async runMatrix() {
    if (this._busy) return;
    this._busy = true;
    this.btnMatrix.disabled = true;
    this.setStatus('扫描知识库中…');
    try {
      await this.plugin.rebuildMatrix(false);
      this._lastCard = null;
      this.renderTab();
      this.setStatus('');
    } catch (e) {
      new Notice('矩阵构建失败：' + e.message, 8000);
      this.setStatus('失败');
    } finally {
      this._busy = false;
      this.btnMatrix.disabled = false;
    }
  }

  async runRefine() {
    if (this._busy) return;
    this._busy = true;
    this.btnRefine.disabled = true;
    try {
      if (!this.plugin.matrix) await this.plugin.rebuildMatrix(true);
      const d = this.plugin.data;
      // 上一轮存在失败批次时走断点续跑：复用已成功的簇，只补跑失败的
      const retryOnly = Array.isArray(d.refineFailed) && d.refineFailed.length > 0;
      const res = await this.plugin.client.refineClusters(
        this.plugin.matrix,
        (i, n, msg) => this.setStatus(`AI 簇分析 ${i}/${n}…${msg ? `（${msg}）` : ''}`),
        { prev: d.refined || [], retryOnly }
      );
      const refined = Array.isArray(res) ? res : (res && res.list) || [];
      const failed = (res && res.failed) || [];
      const unmatched = (res && res.unmatched) || [];
      // 失败簇名落盘，供下次断点续跑
      d.refineFailed = failed;
      if (!refined.length) throw new Error(`未得到有效的技能簇分析结果（${failed.length} 个簇未完成，可重试）`);
      this.setStatus('AI 汇总画像中…');
      const synth = await this.plugin.client.synthesize(this.plugin.matrix, refined);
      d.refined = refined;
      d.synth = synth;
      applyRefinedTracks(this.plugin.matrix, refined);
      await this.plugin.saveAll();
      await this.plugin.writeProfileNote();
      this.renderTab();
      if (failed.length || unmatched.length) {
        const bits = [];
        if (failed.length) bits.push(`${failed.length} 个技能簇未完成（批次失败或未被返回覆盖）`);
        if (unmatched.length) bits.push(`${unmatched.length} 个返回名称未匹配到本地簇：${unmatched.slice(0, 3).join('、')}`);
        this.setStatus(`完成 ${refined.length} 簇，${bits.join('；')}`);
        new Notice(`画像已写入，但${bits.join('；')}；再次点击「AI 提炼画像」只补跑未完成部分`, 12000);
      } else {
        this.setStatus('完成，画像笔记已写入');
        new Notice('技能画像已生成并写入《个人技能画像》');
      }
    } catch (e) {
      new Notice('AI 提炼失败：' + e.message, 8000);
      this.setStatus('失败');
    } finally {
      this._busy = false;
      this.btnRefine.disabled = false;
    }
  }

  async exportResume() {
    const d = this.plugin.data;
    const m = this.plugin.matrix;
    if (!m) {
      new Notice('请先重建矩阵');
      return;
    }
    const hasSel = Object.keys(d.selectedBullets || {}).length || Object.keys(d.selectedTraits || {}).length;
    if (!hasSel) {
      new Notice('请先勾选要导出的条目');
      return;
    }
    try {
      const md = buildResumeExport(m, d.refined || [], d.synth || null, d.selectedBullets || {}, d.selectedTraits || {});
      const path = await this.plugin.writeNote('简历素材', md);
      new Notice('已导出：' + path);
    } catch (e) {
      new Notice('导出失败：' + e.message, 8000);
    }
  }

  async openProfileNote() {
    const path = await this.plugin.notePath('个人技能画像');
    const f = this.plugin.app.vault.getAbstractFileByPath(path);
    if (!f) {
      new Notice('画像笔记尚未生成，请先「AI 提炼画像」');
      return;
    }
    const leaf = this.plugin.app.workspace.getLeaf('tab');
    await leaf.openFile(f);
  }
}

/* ============================ 模拟面试 ============================ */

class InterviewModal extends Modal {
  constructor(plugin) {
    super(plugin.app);
    this.plugin = plugin;
    this.history = [];
    this.current = null;
  }

  onOpen() {
    this.modalEl.addClass('xysk-modal');
    const content = this.contentEl;
    content.empty();

    const header = el('div', 'xysk-header');
    header.appendChild(el('div', 'xysk-title', '模拟面试'));
    content.appendChild(header);

    const controls = el('div', 'xysk-actions');
    this.clusterSel = el('select', 'dropdown');
    this.refreshClusters();
    this.btnDraw = el('button', 'mod-cta', '抽题');
    controls.append(this.clusterSel, this.btnDraw);
    this.statusEl = el('span', 'xysk-status', '');
    controls.appendChild(this.statusEl);
    content.appendChild(controls);

    this.qEl = el('div', 'xysk-interview-q', '选择方向后点击「抽题」。优先从库内 AI_qa 题库按技术深度加权抽取，库内没有题目时由 AI 现场出题。');
    content.appendChild(this.qEl);

    this.answerEl = el('textarea', 'xysk-interview-answer');
    this.answerEl.placeholder = '在这里作答…（Ctrl+Enter 提交评分）';
    this.answerEl.hide();
    content.appendChild(this.answerEl);

    const row = el('div', 'xysk-actions');
    this.btnGrade = el('button', 'mod-cta', '提交评分');
    this.btnGrade.hide();
    this.btnNext = el('button', '', '下一题');
    this.btnNext.hide();
    row.append(this.btnGrade, this.btnNext);
    content.appendChild(row);

    this.gradeEl = el('div', 'xysk-grade');
    this.gradeEl.hide();
    content.appendChild(this.gradeEl);

    this.historyEl = el('div', 'xysk-history');
    content.appendChild(this.historyEl);

    this.btnDraw.onclick = () => this.drawQuestion();
    this.btnNext.onclick = () => this.drawQuestion();
    this.btnGrade.onclick = () => this.submitGrade();
    this.answerEl.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); this.submitGrade(); }
    });
  }

  setStatus(t) {
    this.statusEl.textContent = t;
  }

  refreshClusters() {
    this.clusterSel.empty();
    this.clusterSel.appendChild(new Option('方向：全部', ''));
    const m = this.plugin.matrix;
    if (m) for (const c of m.clusters.slice(0, 40)) this.clusterSel.appendChild(new Option('方向：' + c.name, c.name));
  }

  async drawQuestion() {
    if (this._busy) return;
    this._busy = true;
    this.btnDraw.disabled = true;
    try {
      if (!this.plugin.matrix) {
        this.setStatus('先构建矩阵…');
        await this.plugin.rebuildMatrix(true);
        this.refreshClusters();
      }
      this.setStatus('抽题中…');
      this.gradeEl.hide();
      this.gradeEl.empty();
      const picked = await this.pickDocWithQa();
      let block = null;
      let doc = picked ? picked.doc : null;
      let aiMade = false;
      if (picked) {
        const file = this.plugin.app.vault.getAbstractFileByPath(picked.doc.path);
        let raw = '';
        try { raw = await this.plugin.app.vault.cachedRead(file); } catch (e) { /* 忽略 */ }
        const fc = this.plugin.app.metadataCache.getFileCache(file);
        const fm = (fc && fc.frontmatter) || {};
        const blocks = parseQaBlocks(fm.AI_qa || extractQaFromRaw(raw));
        if (blocks.length) block = blocks[Math.floor(Math.random() * blocks.length)];
      }
      if (!block) {
        this.setStatus('库内无题，AI 出题中…');
        const cluster = this.clusterSel.value || '综合技术';
        const mat = this.materialForCluster(cluster);
        const q = await this.plugin.client.makeQuestion(cluster, mat);
        block = { q, a: '', basis: '', approach: '', risk: '' };
        doc = null;
        aiMade = true;
      }
      this.current = { doc, block, aiMade };
      this.qEl.textContent = `Q${this.history.length + 1}：${block.q}`;
      this.answerEl.value = '';
      this.answerEl.show();
      this.btnGrade.show();
      this.btnNext.show();
      this.setStatus(doc ? `来源：《${doc.title}》（深度 ${doc.depth}）` : 'AI 生成题');
    } catch (e) {
      new Notice('抽题失败：' + e.message, 8000);
      this.setStatus('失败');
    } finally {
      this._busy = false;
      this.btnDraw.disabled = false;
    }
  }

  materialForCluster(clusterName) {
    const m = this.plugin.matrix;
    const cl = m && m.clusters.find((c) => c.name === clusterName);
    if (!cl) return '（无特定资料，考察通用能力）';
    return cl.docs.slice(0, 3).map((d) => `《${d.title}》：${d.summaryShort || ''}`).join('\n');
  }

  async pickDocWithQa() {
    const m = this.plugin.matrix;
    const pool = [];
    for (const c of m.clusters) {
      if (this.clusterSel.value && c.name !== this.clusterSel.value) continue;
      for (const d of c.docs) {
        if (!d.hasQa) continue;
        pool.push({ doc: Object.assign({}, d, { cluster: c.name }), weight: 10 + (d.depth || 0) });
      }
    }
    if (!pool.length) return null;
    return weightedPick(pool);
  }

  async submitGrade() {
    if (this._busy || !this.current) return;
    const ans = this.answerEl.value.trim();
    if (!ans) { new Notice('请先作答'); return; }
    this._busy = true;
    this.btnGrade.disabled = true;
    this.setStatus('AI 阅卷中…');
    try {
      const b = this.current.block;
      const mat = [];
      if (b.basis) mat.push('判断依据：' + b.basis);
      if (b.approach) mat.push('排查/实现思路：' + b.approach);
      if (b.risk) mat.push('关键风险：' + b.risk);
      const summary = this.current.doc ? this.current.doc.summaryShort : '';
      const material = [
        this.current.doc ? `来自文章《${this.current.doc.title}》` : '（AI 生成题，无原文）',
        summary ? `摘要：${summary}` : '',
        mat.join('\n'),
      ].filter(Boolean).join('\n');
      const r = await this.plugin.client.gradeAnswer(b.q, ans, material);
      this.history.push({ q: b.q, score: r.score, doc: this.current.doc });
      this.renderGrade(r);
      this.renderHistory();
      this.setStatus(`已答 ${this.history.length}/${this.plugin.settings.interviewCount} 题`);
      if (this.history.length >= this.plugin.settings.interviewCount) {
        const avg = Math.round(this.history.reduce((a, x) => a + x.score, 0) / this.history.length);
        new Notice(`本轮模拟面试完成：平均 ${avg} 分（${this.history.length} 题）`);
      }
    } catch (e) {
      new Notice('阅卷失败：' + e.message, 8000);
      this.setStatus('阅卷失败');
    } finally {
      this._busy = false;
      this.btnGrade.disabled = false;
    }
  }

  renderGrade(r) {
    const elx = this.gradeEl;
    elx.empty();
    elx.show();
    const head = el('div', '');
    head.appendChild(el('span', 'xysk-grade-score', `${r.score} 分`));
    head.appendChild(el('span', '', r.comment));
    elx.appendChild(head);
    if (r.keyPoints.length) {
      const sec = el('div', 'xysk-grade-section');
      sec.appendChild(el('span', 'xysk-grade-label', '应覆盖要点：'));
      sec.appendChild(el('span', '', r.keyPoints.join('；')));
      elx.appendChild(sec);
    }
  }

  renderHistory() {
    this.historyEl.empty();
    this.historyEl.appendChild(el('span', '', '本组成绩：'));
    this.history.forEach((h, i) => {
      const cls = h.score >= 80 ? 'good' : h.score >= 60 ? 'mid' : 'bad';
      const chip = el('span', cls, `Q${i + 1} ${h.score}`);
      chip.title = h.q;
      chip.style.cursor = 'default';
      this.historyEl.appendChild(chip);
    });
  }
}

/* ============================ 设置页 ============================ */

class SkillMinerSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { contentEl } = this;
    contentEl.empty();
    const s = this.plugin.settings;

    new Setting(contentEl).setName('API 接口').setHeading();
    new Setting(contentEl).setName('API Base URL').setDesc('OpenAI 兼容接口，与 AI 元数据插件一致')
      .addText((t) => t.setValue(s.baseUrl).onChange(async (v) => { s.baseUrl = v.trim(); await this.plugin.saveAll(); }));
    new Setting(contentEl).setName('API Key').setDesc('本地网关通常可留空')
      .addText((t) => {
        t.inputEl.type = 'password';
        t.setValue(s.apiKey).onChange(async (v) => { s.apiKey = v.trim(); await this.plugin.saveAll(); });
      });
    new Setting(contentEl).setName('模型')
      .addText((t) => t.setValue(s.model).onChange(async (v) => { s.model = v.trim(); await this.plugin.saveAll(); }));
    new Setting(contentEl).setName('JSON 模式（response_format）')
      .addToggle((t) => t.setValue(s.structuredJsonModeEnabled).onChange(async (v) => { s.structuredJsonModeEnabled = v; await this.plugin.saveAll(); }));
    new Setting(contentEl).setName('JSON 修复')
      .addToggle((t) => t.setValue(s.jsonRepairEnabled).onChange(async (v) => { s.jsonRepairEnabled = v; await this.plugin.saveAll(); }));

    new Setting(contentEl).setName('提炼范围').setHeading();
    new Setting(contentEl).setName('参与提炼的目录').setDesc('每行一个，只统计这些目录下 status: done 的文章 frontmatter（undone / 空状态不计入）')
      .addTextArea((t) => {
        t.inputEl.style.height = '60px';
        t.setValue(s.folders).onChange(async (v) => { s.folders = v; await this.plugin.saveAll(); });
      });
    new Setting(contentEl).setName('技能簇最小文章数').setDesc('少于该数的标签不作为技能簇（过滤噪声）')
      .addSlider((t) => t.setLimits(1, 10, 1).setValue(s.minDocsPerSkill).setDynamicTooltip()
        .onChange(async (v) => { s.minDocsPerSkill = v; await this.plugin.saveAll(); }));
    new Setting(contentEl).setName('标签规范表').setDesc('一行一个规范标签；也支持映射行「规范名 = 别名1, 别名2」（如 C++ = CPlusPlus, cplusplus），知识库里的旧写法会自动归到规范名下')
      .addTextArea((t) => {
        t.inputEl.style.height = '120px';
        t.setValue(s.tagCanonicalList).onChange(async (v) => { s.tagCanonicalList = v; await this.plugin.saveAll(); });
      });
    new Setting(contentEl).setName('忽略标签').setDesc('一行一个，不参与统计')
      .addTextArea((t) => {
        t.inputEl.style.height = '60px';
        t.setValue(s.ignoreTags).onChange(async (v) => { s.ignoreTags = v; await this.plugin.saveAll(); });
      });
    new Setting(contentEl).setName('输出目录').setDesc('画像笔记与简历素材的存放位置')
      .addText((t) => t.setValue(s.outputFolder).onChange(async (v) => { s.outputFolder = v.trim(); await this.plugin.saveAll(); }));

    new Setting(contentEl).setName('GitHub 项目').setHeading();
    new Setting(contentEl).setName('GitHub 用户名')
      .setDesc('简历与画像中「Popular repositories」的数据来源')
      .addText((t) => t.setValue(s.githubUsername).onChange(async (v) => { s.githubUsername = v.trim(); await this.plugin.saveAll(); }));
    new Setting(contentEl).setName('仓库白名单')
      .setDesc('每行一个仓库名；「GitHub 项目」页只拉取这些仓库（公开仓库，无需 Token）')
      .addTextArea((t) => {
        t.inputEl.style.height = '80px';
        t.setValue(s.repoWhitelist).onChange(async (v) => { s.repoWhitelist = v; await this.plugin.saveAll(); });
      });

    new Setting(contentEl).setName('行业雷达数据源').setHeading();
    new Setting(contentEl).setName('联网搜索')
      .setDesc('关闭 = 仅用模型知识（自动标注时效）；接入 Tavily / Serper（均有免费额度）后，行业雷达会先联网检索再总结，获得实时信息')
      .addDropdown((t) => t.addOption('off', '关闭（仅模型知识）').addOption('tavily', 'Tavily').addOption('serper', 'Serper（Google）')
        .setValue(s.searchProvider).onChange(async (v) => { s.searchProvider = v; await this.plugin.saveAll(); }));
    new Setting(contentEl).setName('搜索 API Key').setDesc('只在启用搜索提供商时需要；仅用于发送技能方向名称进行检索')
      .addText((t) => {
        t.inputEl.type = 'password';
        t.setValue(s.searchApiKey).onChange(async (v) => { s.searchApiKey = v.trim(); await this.plugin.saveAll(); });
      });

    new Setting(contentEl).setName('模拟面试').setHeading();
    new Setting(contentEl).setName('每轮题数')
      .addSlider((t) => t.setLimits(3, 10, 1).setValue(s.interviewCount).setDynamicTooltip()
        .onChange(async (v) => { s.interviewCount = v; await this.plugin.saveAll(); }));

    new Setting(contentEl).setName('岗位透镜').setHeading();
    new Setting(contentEl).setName('收件箱目录')
      .setDesc('「导出待办」把学习方向 / 技能缺口写成待办笔记的位置。分析报告存在本插件目录的 reports/ 内（不入 git），面板右上角可新分析 / 导出待办。')
      .addText((t) => t.setValue(s.jobLensInbox).onChange(async (v) => {
        s.jobLensInbox = v.trim() || DEFAULT_SETTINGS.jobLensInbox;
        await this.plugin.saveAll();
      }));

    new Setting(contentEl).setName('AI 提示词（Harness）').setHeading();
    const harness = (name, key, def, height) => {
      new Setting(contentEl).setName(name)
        .addTextArea((t) => {
          t.inputEl.style.width = '100%';
          t.inputEl.style.height = height || '100px';
          t.setValue(s[key]).onChange(async (v) => { s[key] = v; await this.plugin.saveAll(); });
        })
        .addExtraButton((b) => b.setIcon('rotate-ccw').setTooltip('恢复默认')
          .onClick(async () => { s[key] = def; await this.plugin.saveAll(); this.display(); }));
    };
    harness('技能簇分析提示词', 'clusterHarness', DEFAULT_CLUSTER_HARNESS);
    harness('画像汇总提示词', 'synthHarness', DEFAULT_SYNTH_HARNESS);
    harness('出题提示词', 'askHarness', DEFAULT_ASK_HARNESS, '70px');
    harness('阅卷提示词', 'gradeHarness', DEFAULT_GRADE_HARNESS);
    harness('行业雷达提示词', 'pulseHarness', DEFAULT_PULSE_HARNESS);
    harness('学习计划提示词', 'planHarness', DEFAULT_PLAN_HARNESS, '70px');
    harness('GitHub 一句话提示词', 'ghHarness', DEFAULT_GH_HARNESS, '70px');
    harness('简历生成提示词', 'resumeHarness', DEFAULT_RESUME_HARNESS);
  }
}

/* ============================ 插件入口 ============================ */

class SkillMinerPlugin extends Plugin {
  async onload() {
    await this.loadAll();
    this.client = new AIClient(this);
    this.matrix = null;

    this.addRibbonIcon('briefcase', '技能提炼', () => this.openPanel())
      .addClass('xyblue135-ribbon', 'xyblue135-ai');
    this.addCommand({ id: 'open-skill-miner', name: '打开技能提炼', callback: () => this.openPanel() });
    this.addCommand({ id: 'rebuild-skill-matrix', name: '重建技能矩阵', callback: () => this.rebuildMatrix(false) });
    this.addCommand({ id: 'start-interview', name: '开始模拟面试', callback: () => new InterviewModal(this).open() });

    /* ── 岗位透镜（原 00_xyblue135-job-lens，0.11.0 并入本插件）──
       视图 id 与命令语义保持原样，只是命令 id 加了 job-lens- 前缀。 */
    this.registerView(JOB_LENS_VIEW_TYPE, (leaf) => new JobLensView(leaf, this));
    const jlRibbon = this.addRibbonIcon('compass', '岗位透镜', () => this.activateView());
    jlRibbon.addClass('xyblue135-ribbon', 'xyblue135-ai');
    this.addCommand({ id: 'job-lens-open', name: '岗位透镜：打开面板', callback: () => this.activateView() });
    this.addCommand({ id: 'job-lens-discover', name: '岗位透镜：岗位契合度发现（从技能矩阵反推）', callback: () => { void this.runDiscover(''); } });
    this.addCommand({ id: 'job-lens-export-todos', name: '岗位透镜：导出最近分析的缺口为收件箱待办', callback: () => { void this.exportTodos(); } });
    this.app.workspace.onLayoutReady(() => { void this.migrateLegacyJobLens(); });

    this.addSettingTab(new SkillMinerSettingTab(this.app, this));

    // 启动时静默构建技能矩阵（纯本地，秒级），AI 结果从 data.json 缓存读取
    this.app.workspace.onLayoutReady(() => {
      this.rebuildMatrix(true).catch(() => {});
    });
    // 品牌分组标记（见 snippets/xyblue135-brand.css）
    const __brandEl = document.querySelector('.side-dock-ribbon-action[aria-label="' + '技能提炼' + '"]');
    if (__brandEl) __brandEl.addClass('xyblue135-ribbon', 'xyblue135-ai');
  }

  openPanel() {
    new SkillMinerModal(this).open();
  }

  async loadAll() {
    const raw = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, raw.settings || {});
    this.data = Object.assign({
      selectedBullets: {}, selectedTraits: {},
      pulse: null, plan: null, planDone: {},
      manual: null, ghRepos: null, ghEnhanced: null, resume: null,
      // 岗位透镜的状态（0.11.0 由原 job-lens 并入，配置项只有 settings.jobLensInbox）
      jobLens: { lastRole: '', history: [], reportPaths: [], lastReportPath: '' },
    }, raw.data || {});
    this.seedManual();
    // 兼容旧缓存：把「以句子原文为键」的勾选状态迁成归一化稳定键
    this.migrateSelectionKeys();
    if (this.settings.tagCanonicalList === BUILTIN_TAG_CANONICAL_LIST) {
      await this.importCanonicalList();
    }
  }

  /** 旧数据迁移：勾选键从句子原文改为归一化稳定键，已有勾选保持不变。 */
  migrateSelectionKeys() {
    const d = this.data || {};
    for (const field of ['selectedBullets', 'selectedTraits']) {
      const src = d[field];
      if (!src || typeof src !== 'object') { d[field] = {}; continue; }
      const next = {};
      for (const k of Object.keys(src)) {
        if (!src[k]) continue;
        const nk = selKey(k);
        if (nk) next[nk] = true;
      }
      d[field] = next;
    }
  }

  /** 清理失效勾选键：条目已不在当前 synth 里就丢弃，避免 data.json 键无限累积。 */
  pruneSelectionKeys() {
    const d = this.data || {};
    const syn = d.synth || {};
    const prune = (field, list, scope) => {
      const arr = Array.isArray(list) ? list : [];
      if (!arr.length) return; // 无当前条目时不清空，避免误删用户勾选
      const keep = new Set();
      arr.forEach((x, i) => {
        const obj = x && typeof x === 'object' ? x : null;
        keep.add(stableSelKey(obj ? obj.cluster : scope, i));
        // 旧文本键在用户下一次勾选前仍然有效，一并保留，不算失效键
        const k = selKey(obj ? obj.text : x);
        if (k) keep.add(k);
      });
      const src = d[field] && typeof d[field] === 'object' ? d[field] : {};
      const next = {};
      for (const k of Object.keys(src)) if (src[k] && keep.has(k)) next[k] = true;
      d[field] = next;
    };
    prune('selectedBullets', syn.resumeBullets, '');
    prune('selectedTraits', syn.traits, '_trait');
  }

  async saveAll() {
    this.pruneSelectionKeys();
    await this.saveData({ settings: this.settings, data: this.data });
  }

  /** 首次启动：从 AI 元数据插件导入标签规范表。 */
  async importCanonicalList() {
    try {
      const p = this.manifest.dir.replace(/00_xyblue135-skill-miner$/, '00_xyblue135-metadata-ai') + '/data.json';
      const raw = await this.app.vault.adapter.read(normalizePath(p));
      const d = JSON.parse(raw);
      const s = d.settings || d;
      const list = typeof s.technicalTagCanonicalList === 'string' ? s.technicalTagCanonicalList.trim() : '';
      if (list) this.settings.tagCanonicalList = list;
    } catch (e) { /* 保留内置默认 */ }
  }

  folderList() {
    return this.settings.folders.split('\n')
      .map((x) => x.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))
      .filter(Boolean);
  }

  async collectDocRecords() {
    const app = this.app;
    const folders = this.folderList();
    const files = app.vault.getMarkdownFiles().filter((f) => folders.some((fo) => fo && f.path.startsWith(fo + '/')));
    const records = [];
    for (const f of files) {
      let fm = null;
      try {
        const fc = app.metadataCache.getFileCache(f);
        fm = fc && fc.frontmatter;
      } catch (e) { /* 忽略 */ }
      if (!fm) continue;
      // 只统计 status: done 的笔记（2026-10-26 用户确定）。
      // 技能矩阵 → 简历素材 / 行业雷达 / 学习计划 全部走这条采集，
      // 因此 undone（草稿、未整理、AI 未处理）不会再混进统计与画像。
      // 0.9.0：status 值内嵌状态灯（🟢 done / 🔴 undone）——比较前剥掉灯再判断。
      const status = String(fm.status == null ? '' : fm.status).trim().replace(/^[🟢🔴🟡]\s*/u, '').toLowerCase();
      if (status !== 'done') continue;
      const tagList = [].concat(
        Array.isArray(fm.AI_tags) ? fm.AI_tags : typeof fm.AI_tags === 'string' && fm.AI_tags ? [fm.AI_tags] : [],
        Array.isArray(fm.tags) ? fm.tags : []
      );
      records.push({
        path: f.path,
        title: f.basename,
        tags: tagList.map(String),
        depth: Math.max(0, Math.round(Number(fm.AI_technical_depth) || 0)),
        tokens: Math.max(0, Math.round(Number(fm.token_count) || 0)),
        updated: String(fm.updated || ''),
        summaryShort: String(fm.AI_summary_short || '').slice(0, 120),
        hasQa: !!fm.AI_qa,
      });
    }
    return records;
  }

  async rebuildMatrix(silent) {
    const records = await this.collectDocRecords();
    this.matrix = aggregateDocs(records, this.settings);
    this.data.matrixMeta = {
      generatedAt: this.matrix.generatedAt,
      totalDocs: this.matrix.totalDocs,
      clusters: this.matrix.clusters.length,
    };
    // 复用缓存的 AI 结果，重启后象限图的类别配色与方向归属不回退
    if (Array.isArray(this.data.refined) && this.data.refined.length) {
      applyRefinedTracks(this.matrix, this.data.refined);
    }
    await this.saveAll();
    if (!silent) new Notice(`技能矩阵完成：${records.length} 篇文章，${this.matrix.clusters.length} 个技能簇`);
    return this.matrix;
  }

  async notePath(name) {
    const folder = this.settings.outputFolder || '';
    return folder ? normalizePath(`${folder}/${name}.md`) : normalizePath(`${name}.md`);
  }

  async writeNote(name, content) {
    const path = await this.notePath(name);
    const folder = this.settings.outputFolder || '';
    if (folder) {
      const existing = this.app.vault.getAbstractFileByPath(folder);
      if (!existing) await this.app.vault.createFolder(folder);
    }
    const f = this.app.vault.getAbstractFileByPath(path);
    if (f instanceof TFile) await this.app.vault.modify(f, content);
    else await this.app.vault.create(path, content);
    return path;
  }

  async writeProfileNote() {
    if (!this.matrix) return '';
    const md = buildProfileNote(
      this.matrix,
      this.data.refined || [],
      this.data.synth || null,
      this.data.pulse || null,
      this.data.plan || null,
      { username: this.settings.githubUsername, repos: this.data.ghRepos || [], lines: (this.data.ghEnhanced && this.data.ghEnhanced.lines) || {} },
      this.loadProjectNotes()
    );
    return this.writeNote('个人技能画像', md);
  }

  /** 手动补充条目预填：个人信息（来自 00_AI_for_jianli/files/个人信息.txt）+ 三本证书 + 经历/项目素材。 */
  seedManual() {
    if (Array.isArray(this.data.manual) && this.data.manual.length) return;
    this.data.manual = [
      { id: 'seed-name', kind: '基本信息', text: '姓名：吕世轩' },
      { id: 'seed-phone', kind: '基本信息', text: '电话：15831192160' },
      { id: 'seed-mail', kind: '基本信息', text: '邮箱：xyblue135@gmail.com' },
      { id: 'seed-city', kind: '基本信息', text: '所在城市：河北石家庄（可接受异地：成都）' },
      { id: 'seed-goal', kind: '基本信息', text: '求职意向：云原生运维 / 网络安全运维 / AI 工程运维' },
      { id: 'seed-gh', kind: '基本信息', text: 'GitHub：xyblue135' },
      { id: 'seed-domain', kind: '基本信息', text: '域名网站：xyblue.co' },
      { id: 'seed-edu', kind: '教育背景', text: '张家口学院｜网络工程专业｜本科｜2020 年毕业' },
      { id: 'seed-cert-1', kind: '证书', text: '普通话证书' },
      { id: 'seed-cert-2', kind: '证书', text: '计算机二级证书' },
      { id: 'seed-cert-3', kind: '证书', text: 'HCIP 证书（华为数通方向）' },
      { id: 'seed-work-1', kind: '工作经历', text: '上海欣诺通信技术股份有限公司（运营商乙方）· 网络安全技术支持\n运营商流量安全监测分析与处置，DPI 设备约 150 台服务器，通过工信部安全考核（通过省份不足 10 个）\n出差河北全省地市核心机房：扩容、监督施工上架、openEuler 系统初始化，推动 CentOS → openEuler 批量迁移\n与任子行 / 绿盟 / 启明星辰对接：旧设备重做、核心路由器链路交接、光功率掉速定位\nPython/Shell + crontab 采集流量 → Prometheus + Pushgateway + Grafana 可视化 + Alertmanager 邮件告警\n结合 7 天流量可视化推动扩容与网元分流；排查网卡降速（100GE→10G）、RAID 故障、网线不良\nADB + Python 手机网元自动化并编写教程交付运营商；SSH 跳板机安全策略校验维护' },
      { id: 'seed-work-2', kind: '工作经历', text: '村委会（离职后兼职）· 数据管理员\nExcel 台账批量清洗与逻辑校验，纠正重名与元数据错误并规范化建库\n基于腾讯云 OCR 开发手机端拍照录入与串流方案，调用腾讯 API 校验银行卡开户号\n为村委会人员开发低门槛操作工具与便携脚本' },
      { id: 'seed-proj-1', kind: '项目', text: '自建游戏服务器（Linux，日活 20+）：Nginx IPv4/IPv6 双栈分流，多渠道引流（B 站为主）；Prometheus + Grafana 监控 + 邮箱告警；高延迟自愈重启、日志轮转、定时备份与版本回滚' },
      { id: 'seed-proj-2', kind: '项目', text: '游戏数据 API 站点：Node.js 接口服务，配合 OCR 完成数据采集' },
      { id: 'seed-proj-3', kind: '项目', text: '个人基础设施与 AI 实践：Debian + Cloudflare + Nginx 反向代理（xyblue.co）；Ollama / RAG；YOLO / TensorRT 推理部署；FFmpeg / NVENC 硬件编码' },
    ];
  }

  /** 0.9.0：读取 00_agent_for_projects 的仓库笔记（frontmatter: repo/upstream/pushed_at + AI 14 键）。 */
  loadProjectNotes() {
    const folder = 'my_blog/00_agent_for_projects';
    const root = this.app.vault.getAbstractFileByPath(folder);
    if (!root || !Array.isArray(root.children)) return [];
    return root.children
      .filter((f) => f instanceof TFile && f.extension === 'md')
      .map((f) => {
        const fm = this.app.metadataCache.getFileCache(f)?.frontmatter || {};
        const repo = String(fm.repo || '').trim();
        const name = repo ? (repo.split('/')[1] || repo) : f.basename;
        return {
          name,
          repo: repo || `${this.settings.githubUsername}/${f.basename}`,
          upstream: String(fm.upstream || '').trim(),
          pushedAt: String(fm.pushed_at || '').trim(),
          description: String(fm.AI_summary_short || '').trim(),
          freshness: String(fm.AI_freshness || '').trim(),
          tags: [].concat(Array.isArray(fm.AI_tags) ? fm.AI_tags : []),
          html_url: repo ? `https://github.com/${repo}` : '',
          fromNote: true,
        };
      });
  }

  /** 0.10.0：把技能树覆盖判定里的 ⚠️/❌ 簇转成学习计划候选（本地规则，不调 AI）。 */
  async importGapCandidates() {
    if (!this.matrix) throw new Error('请先重建技能矩阵');
    const refMap = makeNameLookup(this.data.refined || []);
    const trackIntensity = new Map((this.matrix.tracks || []).map((t) => [t.name, t.intensity || 0]));
    const existing = (this.data.plan && Array.isArray(this.data.plan.items)) ? this.data.plan.items : [];
    const have = new Set(existing.map((it) => String(it.item || '')));
    const gaps = [];
    for (const c of this.matrix.clusters || []) {
      const v = judgeCluster(c, refMap.get(c.name) || {});
      if (v.bucket === 'yes') continue;
      gaps.push({ c, v, intensity: trackIntensity.get(c.track) || 0 });
    }
    // ❌ 证据不足优先，其次按方向强度、文章数排
    gaps.sort((a, b) => ((b.v.bucket === 'no') - (a.v.bucket === 'no')) || (b.intensity - a.intensity) || (b.c.count - a.c.count));
    const added = [];
    for (const g of gaps) {
      if (existing.length + added.length >= 40) break;
      const item = `${g.c.name} 补强（${g.c.count} 篇 · 均深 ${g.c.avgDepth}）`;
      if (have.has(item)) continue;
      have.add(item);
      added.push({
        priority: g.v.bucket === 'no' ? 'P1' : 'P2',
        item,
        why: `技能树覆盖判定「${g.v.label}」（方向：${g.c.track || '未归类'}）`,
        target: '补 3 篇该主题的 status: 🟢 done 笔记并重建矩阵',
        related: (g.c.docs && g.c.docs[0] && g.c.docs[0].title) || '',
      });
    }
    if (!added.length) return 0;
    this.data.plan = this.data.plan || { generatedAt: Date.now(), source: '技能树缺口导入', items: [] };
    if (!Array.isArray(this.data.plan.items)) this.data.plan.items = [];
    this.data.plan.items.push(...added);
    await this.saveAll();
    await this.writeProfileNote();
    return added.length;
  }

  async refreshGithub() {
    const repos = await this.client.fetchGithubRepos(this.settings.githubUsername, this.settings.repoWhitelist);
    this.data.ghRepos = repos;
    this.data.ghReposAt = Date.now();
    await this.saveAll();
    await this.writeProfileNote();
    return repos;
  }

  async enhanceGithub() {
    if (!Array.isArray(this.data.ghRepos) || !this.data.ghRepos.length) throw new Error('请先拉取仓库数据');
    const r = await this.client.ghEnhanceRepos(this.data.ghRepos);
    this.data.ghEnhanced = { generatedAt: Date.now(), lines: r.lines };
    await this.saveAll();
    await this.writeProfileNote();
    return this.data.ghEnhanced;
  }

  /** 简历生成：素材汇总 → AI 撰写 → 版式 D HTML → 写入库内。 */
  async generateResume(onProgress) {
    if (!Array.isArray(this.data.manual) || !this.data.manual.length) this.seedManual();
    const profile = parseProfileFromManual(this.data.manual);
    if (!profile.name) throw new Error('手动补充中缺少「姓名：×××」的基本信息条目');
    const syn = this.data.synth || {};
    // 0.9.0：项目素材优先取 00_agent_for_projects 本地笔记（AI_summary_short 比上游描述更贴本人）。
    const localProjects = this.loadProjectNotes();
    const repos = localProjects.length
      ? localProjects.map((r) => ({ name: r.name, description: r.description, language: '', html_url: r.html_url }))
      : (Array.isArray(this.data.ghRepos) ? this.data.ghRepos : []);
    const ghLines = (this.data.ghEnhanced && this.data.ghEnhanced.lines) || {};
    const materials = {
      positioning: syn.selfPositioning || '',
      bullets: (syn.resumeBullets || []).map((b) => (b && b.text) || '').filter(Boolean).slice(0, 20),
      work: manualByKind(this.data.manual, '工作经历'),
      projects: manualByKind(this.data.manual, '项目'),
      repos: repos.map((r) => ({ name: r.name, description: ghLines[r.name] || r.description || '', language: r.language || '' })),
      certs: manualByKind(this.data.manual, '证书'),
      goal: profile.goal || '',
    };
    if (onProgress) onProgress('AI 撰写简历内容…');
    const content = await this.client.buildResumeContent(materials);
    if (onProgress) onProgress('渲染版式 D（GitHub 风格）HTML…');
    const tplSet = await loadResumeTemplate(this);

    const goalText = content.goal || profile.goal || '';
    const certs = manualByKind(this.data.manual, '证书');
    const mainHtml = [
      `<h3>你好，我是${escapeHtml(profile.name)}</h3>`,
      `<blockquote>${escapeHtml(content.positioning || syn.selfPositioning || '')}</blockquote>`,
      `<p>目标方向：<strong>${escapeHtml(goalText.split(/[、，,\/]+/).map((x) => x.trim()).filter(Boolean).join('</strong> · <strong>'))}</strong>${repos.length ? `。GitHub 开源与自建项目 ${repos.length} 个，另有知识库 ${this.matrix ? this.matrix.totalDocs : 0} 篇实践笔记沉淀。` : '。'}</p>`,
      certs.length ? `<p style="margin:1.2mm 0 0">证书：<strong>${certs.map((c) => escapeHtml(c)).join('</strong> · <strong>')}</strong></p>` : '',
      content.work.length ? `<h3>工作经历</h3>\n          ${renderWorkHtml(content.work)}` : '',
      content.projects.length ? `<h3>项目与自建服务</h3>\n          ${renderProjectsHtml(content.projects)}` : '',
      content.keywords.length ? `<div class="kw">${renderKeywordsHtml(content.keywords)}</div>` : '',
    ].filter(Boolean).join('\n          ');

    const reposHtml = renderReposHtml(repos, ghLines, tplSet.repoIcon);
    const langStats = {};
    for (const r of repos) {
      for (const [lang, bytes] of Object.entries(r.languages || {})) {
        langStats[lang] = (langStats[lang] || 0) + Number(bytes || 0);
      }
    }
    const langHtml = renderLangHtml(langStats);
    const eduText = manualByKind(this.data.manual, '教育背景')[0] || profile.education || '';
    const degree = (profile.education || '').split(/[｜|]/).slice(1).map((x) => x.trim()).filter(Boolean).join(' · ');

    let html = fillResumeTemplate(tplSet, {
      name: profile.name,
      handle: profile.github || this.settings.githubUsername,
      degree,
      githubUser: profile.github || this.settings.githubUsername,
      githubUrl: `https://github.com/${profile.github || this.settings.githubUsername}`,
      bio: escapeHtml(content.bio || '').replace(/\n/g, '<br>'),
      metaHtml: renderMetaHtml(profile, tplSet.metaIcons),
      mainHtml,
      reposHtml,
      langHtml,
      eduHtml: renderEduHtml(eduText),
      nextGuideHtml: renderNextGuideHtml(this.matrix),
    });
    // 附录页：全量技能树（简历第 2 页），矩阵存在且开关开启时附带
    if (this.settings.resumeAppendixEnabled !== false && this.matrix) {
      const appendix = buildSkillAppendixHtml(this.matrix, this.data.refined || []);
      if (appendix) html = html.replace('</body>', appendix + '\n</body>');
    }
    // 简历是 HTML 交付物：必须以 .html 落盘（writeNote 固定 .md，这里单独写）
    const folder = this.settings.outputFolder || '';
    const htmlPath = normalizePath(folder ? `${folder}/简历-${profile.name}-${formatDate(Date.now())}.html` : `简历-${profile.name}-${formatDate(Date.now())}.html`);
    if (folder) {
      const existingFolder = this.app.vault.getAbstractFileByPath(folder);
      if (!existingFolder) await this.app.vault.createFolder(folder);
    }
    const existingFile = this.app.vault.getAbstractFileByPath(htmlPath);
    if (existingFile instanceof TFile) await this.app.vault.modify(existingFile, html);
    else await this.app.vault.create(htmlPath, html);
    const path = htmlPath;
    this.data.resume = { generatedAt: Date.now(), path, name: profile.name };
    await this.saveAll();
    return { path, content };
  }

  openResumeFile() {
    const p = this.data.resume && this.data.resume.path;
    if (!p) { new Notice('尚未生成简历'); return; }
    try {
      const electron = require('electron');
      const nodePath = require('path');
      let full = p;
      try { full = nodePath.join(this.app.vault.adapter.basePath, p); } catch (e) { full = p; }
      if (electron.shell && electron.shell.openPath) {
        electron.shell.openPath(full).then((r) => { if (r) new Notice('打开失败：' + r); });
      } else if (electron.shell && electron.shell.openExternal) {
        electron.shell.openExternal('file:///' + full.replace(/\\/g, '/'));
      }
    } catch (e) {
      new Notice('打开失败：' + e.message, 8000);
    }
  }

  openExternal(url) {
    try {
      const electron = require('electron');
      if (electron.shell) electron.shell.openExternal(url);
      else window.open(url);
    } catch (e) { window.open(url); }
  }

  /** 行业雷达：按方向生成行业卡片，缓存于 data.pulse。 */
  async refreshPulse(onProgress) {
    if (!this.matrix) await this.rebuildMatrix(true);
    const tracks = this.matrix.tracks.filter((t) => t.name !== '其他与兴趣');
    if (!tracks.length) throw new Error('没有可分析的技术方向');
    const searchOn = this.settings.searchProvider !== 'off' && !!this.settings.searchApiKey;
    const infos = tracks.map((t) => ({
      name: t.name,
      clusters: this.matrix.clusters.filter((c) => c.track === t.name).map((c) => ({ name: c.name, count: c.count, avgDepth: c.avgDepth })),
    }));
    const tracksOut = await this.client.pulseForTracks(infos, onProgress, searchOn);
    this.data.pulse = {
      generatedAt: Date.now(),
      source: searchOn ? `模型知识 + ${this.settings.searchProvider} 联网检索` : '模型知识（未联网，注意时效）',
      tracks: tracksOut,
    };
    await this.saveAll();
    await this.writeProfileNote();
    return this.data.pulse;
  }

  /** 学习计划：薄弱点 + 行业补课 + 市场缺口 → P0/P1/P2。 */
  async makePlan() {
    const parts = [];
    const synth = this.data.synth;
    if (synth && synth.gaps && synth.gaps.length) {
      parts.push('【画像薄弱点】\n' + synth.gaps.map((g) => '- ' + g).join('\n'));
    }
    const pulse = this.data.pulse;
    if (pulse && pulse.tracks) {
      const ln = [];
      for (const [track, p] of Object.entries(pulse.tracks)) {
        for (const x of p.learnNext || []) ln.push(`- [${x.priority}] ${x.item} — ${x.why}（${track}）`);
      }
      if (ln.length) parts.push('【行业雷达补课建议】\n' + ln.join('\n'));
    }
    if (!parts.length) throw new Error('没有可用的计划素材：请先完成「AI 提炼画像」或「行业雷达」');
    const items = await this.client.buildPlan(parts.join('\n\n'));
    this.data.plan = { generatedAt: Date.now(), items };
    await this.saveAll();
    await this.writeProfileNote();
    return this.data.plan;
  }

  async openDoc(path) {
    if (!path) return;
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile)) { new Notice('文件不存在：' + path); return; }
    const leaf = this.app.workspace.getLeaf('tab');
    await leaf.openFile(f);
  }

  searchInAISearch(clusterName) {
    const p = this.app.plugins.plugins['00_xyblue135-ai-search'];
    if (p && typeof p.openSearchWithQuery === 'function') {
      p.openSearchWithQuery(clusterName);
    } else {
      new Notice('未安装或未启用「xyblue135 · AI 检索」，无法联动');
    }
  }

  /* ==================== 岗位透镜（原 00_xyblue135-job-lens，0.11.0 并入） ====================
     与原版的差异：
       1. 不再跨插件读 data.json —— 技能清单直接取本插件已算好的 this.data.refined，
          网关配置直接用本插件 settings，少一层 IO、少一处「未读到网关配置」的报错；
       2. 状态（历史/报告路径）存 this.data.jobLens，配置只有 settings.jobLensInbox；
       3. reports 目录跟随本插件（.gitignore 里已忽略各插件的 reports 目录）。 */

  jobLensState() {
    if (!this.data.jobLens || typeof this.data.jobLens !== 'object') {
      this.data.jobLens = { lastRole: '', history: [], reportPaths: [], lastReportPath: '' };
    }
    const s = this.data.jobLens;
    if (!Array.isArray(s.history)) s.history = [];
    if (!Array.isArray(s.reportPaths)) s.reportPaths = [];
    if (typeof s.lastRole !== 'string') s.lastRole = '';
    if (typeof s.lastReportPath !== 'string') s.lastReportPath = '';
    return s;
  }

  jobLensInventory() {
    const refined = (this.data && Array.isArray(this.data.refined)) ? this.data.refined : [];
    return {
      inventory: refined.map((r) => r.name + '|' + (r.track || '') + '|' + (r.level || '')).join('\n'),
      refinedCount: refined.length,
    };
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(JOB_LENS_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getLeaf('tab');
      await leaf.setViewState({ type: JOB_LENS_VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  refreshViewIfOpen() {
    const leaf = this.app.workspace.getLeavesOfType(JOB_LENS_VIEW_TYPE)[0];
    if (leaf && leaf.view && typeof leaf.view.renderLatest === 'function') {
      void leaf.view.renderLatest();
    }
  }

  openJobLensModal() {
    new JobLensModal(this.app, this).open();
  }

  async callJobLensLLM(sys, user) {
    const base = this.settings.baseUrl;
    if (!base) throw new Error('未配置 AI 接口地址（设置 → 技能提炼 → API Base URL）');
    const msgs = [{ role: 'system', content: sys }, { role: 'user', content: user }];
    let out = await jobLensChat(base, this.settings.apiKey, this.settings.model, msgs, 90000);
    try {
      return jobLensExtractJson(out);
    } catch (e) {
      out = await jobLensChat(base, this.settings.apiKey, this.settings.model,
        [{ role: 'system', content: sys + '\n上一次输出无法解析。重新输出，必须是一个合法 JSON 对象。' }, { role: 'user', content: user }],
        90000);
      return jobLensExtractJson(out);
    }
  }

  /* 主流程：岗位契合度发现（零输入，从矩阵反推） */
  async discover(preferNote) {
    const sm = this.jobLensInventory();
    if (!sm.inventory) throw new Error('技能清单为空（先在本插件里重建技能矩阵并完成 AI 提炼）');
    const sys = [
      '你是资深技术招聘顾问，熟悉中国就业市场 2024-2026（注意：市场认知来自训练数据，非实时，结论保守）。',
      '输入：候选人的技能清单（每行 `技能名|方向|定级`，定级来自其知识库证据链）。可能附候选人偏好说明。',
      '任务：反推候选人当前技能组合最适合哪些岗位方向——不是验证某个岗位，而是发现岗位。',
      '要求：',
      '1. 以技能清单为唯一事实来源，只推荐清单能支撑的岗位，宁缺毋滥；',
      '2. 覆盖三类：直接可投（核心技能全占）、补强后强（差1~2个高频技能，说明补什么）、差异化蓝海（稀缺组合，竞争少）；',
      '3. 每个岗位给出 Boss 直聘上实际应该搜的搜索关键词；',
      '4. 薪资给保守区间并注明仅供参考。',
      '只输出 JSON：',
      '{"market_note":"当前市场环境一句话(<=100字)",',
      ' "roles":[{"role":"岗位名","fit":0到100,"tier":"直接可投|补强后强|差异化蓝海","why":"契合理由(引用具体技能簇名)","matching":["核心匹配簇"],"missing_easy":["容易补的小缺口"],"missing_hard":["需大投入的缺口"],"search_keywords":["Boss搜索词"],"salary_hint":"保守区间(仅供参考)"}] (6~10个,按fit降序),',
      ' "advice":"一句话建议(<=80字)"}',
    ].join('\n');
    const user = '【候选人技能清单】\n' + sm.inventory + (preferNote ? '\n\n【候选人偏好】\n' + preferNote : '');
    const data = await this.callJobLensLLM(sys, user);
    const st = this.jobLensState();
    data.generatedAt = Date.now();
    data.refinedCount = sm.refinedCount;
    st.history = [{ role: '岗位契合度发现', at: data.generatedAt }].concat(st.history || []).slice(0, 20);
    await this.saveAll();
    return data;
  }

  /* 次流程：定向分析指定岗位（可选贴 JD） */
  async analyze(role, jdText) {
    const sm = this.jobLensInventory();
    if (!sm.inventory) throw new Error('技能清单为空（先在本插件里重建技能矩阵并完成 AI 提炼）');
    const sys = [
      '你是资深技术招聘顾问，熟悉中国就业市场 2024-2026（注意：市场认知来自训练数据，非实时，结论保守）。',
      '输入：目标岗位描述（可能附真实 JD）+ 候选人技能清单（每行 `技能名|方向|定级`）。',
      '任务：给出该岗位的技能需求画像，并与候选人逐项比对。',
      '只输出 JSON：',
      '{"role_title":"岗位规范名","market_summary":"市场行情一句话(<=120字)",',
      ' "demand":[{"skill":"技能","tier":"核心|常见|加分","note":"典型形态"}] (12~18条,按出现频率排序),',
      ' "match_score":0到100,',
      ' "strong":[{"skill":"","your_level":"","note":"简历可主打"}],',
      ' "gaps":[{"skill":"","market_tier":"","your_level":"无|了解","priority":"P0|P1|P2","why":"","target":""}] (最多10条),',
      ' "overqualified":["市场很少要求但候选人精通"],',
      ' "learning_top5":[{"direction":"","why_market":"","target":"","related":""}] (恰好5条),',
      ' "advice":"(<=80字)"}',
    ].join('\n');
    const user = '【目标岗位】' + role + (jdText ? '\n\n【真实 JD 原文（优先依据它）】\n' + jdText.slice(0, 3000) : '\n（未提供 JD，按市场通用画像分析）')
      + '\n\n【候选人技能清单】\n' + sm.inventory;
    const data = await this.callJobLensLLM(sys, user);
    const st = this.jobLensState();
    data.role_input = role;
    data.generatedAt = Date.now();
    data.refinedCount = sm.refinedCount;
    st.lastRole = role;
    st.history = [{ role: role, score: data.match_score, at: data.generatedAt }].concat(st.history || []).slice(0, 20);
    await this.saveAll();
    return data;
  }

  /* 报告写入插件目录 reports/ */
  async saveReportMd(md, kind, role) {
    const st = this.jobLensState();
    const dir = normalizePath(this.manifest.dir + '/reports');
    await this.app.vault.adapter.mkdir(dir).catch(() => {});
    const date = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const ds = date.getFullYear() + pad(date.getMonth() + 1) + pad(date.getDate()) + '-' + pad(date.getHours()) + pad(date.getMinutes());
    const safe = String(role || '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
    const path = dir + '/' + kind + (safe ? '-' + safe : '') + '-' + ds + '.md';
    await this.app.vault.adapter.write(path, md);
    st.lastReportPath = path;
    st.reportPaths = [path].concat(st.reportPaths || []).slice(0, 30);
    await this.saveAll();
    this.refreshViewIfOpen();
    return path;
  }

  jobLensStamp(ts) {
    const date = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
  }

  async buildDiscoverMd(data) {
    const ds = this.jobLensStamp(data.generatedAt);
    const tierIcon = { '直接可投': '✅', '补强后强': '🧱', '差异化蓝海': '💎' };
    let md = '---\ntags: [求职, 岗位发现]\n---\n';
    md += '# 岗位契合度分析（由技能矩阵反推）\n\n';
    md += '> ' + ds + ' · 数据来源：模型市场知识（非实时）+ 技能矩阵 ' + (data.refinedCount || 0) + ' 簇 · 按契合度降序\n\n';
    md += '## 市场环境\n' + (data.market_note || '') + '\n\n';
    (data.roles || []).forEach((r) => {
      md += '## ' + (tierIcon[r.tier] || '') + ' ' + r.role + ' — 契合度 ' + (r.fit == null ? '?' : r.fit) + '/100\n';
      md += '- **契合理由**：' + (r.why || '') + '\n';
      md += '- **匹配簇**：' + (r.matching || []).join('、') + '\n';
      if ((r.missing_easy || []).length) md += '- **小缺口（容易补）**：' + r.missing_easy.join('、') + '\n';
      if ((r.missing_hard || []).length) md += '- **大缺口**：' + r.missing_hard.join('、') + '\n';
      md += '- **Boss 搜索词**：' + (r.search_keywords || []).map((k) => '`' + k + '`').join(' / ') + '\n';
      if (r.salary_hint) md += '- **薪资参考**：' + r.salary_hint + '（仅供参考）\n';
      md += '\n';
    });
    md += '## 建议\n' + (data.advice || '') + '\n';
    return md;
  }

  async buildTargetedMd(data) {
    const ds = this.jobLensStamp(data.generatedAt);
    const tierIcon = { '核心': '🔴 核心', '常见': '🟡 常见', '加分': '🟢 加分' };
    let md = '---\ntags: [求职, 岗位分析]\n---\n';
    md += '# 岗位透镜 · ' + (data.role_title || data.role_input) + '\n\n';
    md += '> ' + ds + ' · 匹配度 **' + (data.match_score == null ? '—' : data.match_score) + '/100** · 模型市场知识（非实时）+ 技能矩阵（' + (data.refinedCount || 0) + ' 簇）\n\n';
    md += '## 市场概要\n' + (data.market_summary || '') + '\n\n';
    md += '## 技能需求画像\n' + (data.demand || []).map((x) => '- ' + (tierIcon[x.tier] || x.tier) + ' **' + x.skill + '** — ' + (x.note || '')).join('\n') + '\n\n';
    md += '## ✅ 优势（市场要 + 你强，简历主打）\n' + (data.strong || []).map((x) => '- **' + x.skill + '**（' + (x.your_level || '') + '）— ' + (x.note || '')).join('\n') + '\n\n';
    md += '## 🔴 差距（市场要 + 你弱，按优先级）\n' + (data.gaps || []).map((x) => '- **[' + x.priority + '] ' + x.skill + '**（市场:' + (x.market_tier || '') + ' / 你:' + (x.your_level || '无') + '）— ' + (x.why || '') + ' → 目标: ' + (x.target || '')).join('\n') + '\n\n';
    md += '## 🟡 市场少提但你精通（简历降权）\n' + (data.overqualified || []).map((x) => '- ' + x).join('\n') + '\n\n';
    md += '## 🎯 学习方向 Top5\n' + (data.learning_top5 || []).map((x, i) =>
      (i + 1) + '. **' + x.direction + '** — ' + (x.why_market || '') + '\n   达标: ' + (x.target || '') + (x.related ? '（衔接: ' + x.related + '）' : '')).join('\n') + '\n\n';
    md += '## 建议\n' + (data.advice || '') + '\n';
    return md;
  }

  async runDiscover(preferNote) {
    const data = await this.discover(preferNote);
    this._jobLensLastData = data;
    const md = await this.buildDiscoverMd(data);
    const path = await this.saveReportMd(md, '岗位契合度分析', '');
    return { path: path, data: data };
  }

  async runTargeted(role, jdText) {
    const data = await this.analyze(role, jdText);
    this._jobLensLastData = data;
    const md = await this.buildTargetedMd(data);
    const path = await this.saveReportMd(md, '岗位分析', data.role_title || role);
    return { path: path, data: data };
  }

  /* 导出缺口/学习方向为收件箱待办 */
  async exportTodos() {
    const data = this._jobLensLastData;
    if (!data) { new Notice('请先重新运行一次分析（导出依赖本次会话的分析结果）'); return; }
    const inbox = this.settings.jobLensInbox || DEFAULT_SETTINGS.jobLensInbox;
    await this.app.vault.adapter.mkdir(normalizePath(inbox)).catch(() => {});
    const now = new Date();
    const pad = (p) => String(p).padStart(2, '0');
    const stamp = '' + now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds()) + '000';
    const tasks = [];
    if (data.learning_top5) {
      for (const x of data.learning_top5) tasks.push({ title: '学习-' + x.direction, why: x.why_market, target: x.target, extra: x.related ? '衔接: ' + x.related : '' });
    } else if (data.roles) {
      for (const r of data.roles) {
        if (r.tier === '直接可投') continue;
        for (const g of (r.missing_easy || [])) tasks.push({ title: '补缺-' + r.role + '-' + g, why: '解锁岗位: ' + r.role + '（契合度 ' + (r.fit == null ? '?' : r.fit) + '）', target: '', extra: '' });
      }
    }
    let n = 0;
    for (const t of tasks) {
      const safe = String(t.title).replace(/[\\/:*?"<>|]/g, '_').slice(0, 50);
      const fm = '---\nstatus: 🔴 undone\nvisibility: 🟢 open\nupdated: ' + stamp + '\nsource: 岗位透镜\nAI_tags: [学习计划]\nAI_summary_short: ' + String(t.why || '').slice(0, 80) + '\n---\n';
      const body = '# ' + t.title + '\n\n> 市场依据: ' + (t.why || '') + '\n> 达标标准: ' + (t.target || '—') + (t.extra ? '\n> ' + t.extra : '') + '\n';
      try {
        await this.app.vault.create(normalizePath(inbox + '/' + safe + '.md'), fm + body);
        n++;
      } catch (e) { /* 同名跳过 */ }
    }
    new Notice('已导出 ' + n + ' 条待办到收件箱（待完成工作台可见）');
  }

  /* 一次性迁移：旧 job-lens 插件的 data.json 状态 + reports/*.md */
  async migrateLegacyJobLens() {
    const st = this.jobLensState();
    if (st.migratedFromLegacy) return;
    const legacyDir = '.obsidian/plugins/00_xyblue135-job-lens';
    let legacy = null;
    try {
      legacy = JSON.parse(await this.app.vault.adapter.read(legacyDir + '/data.json'));
    } catch (e) { /* 旧插件已删，跳过 */ }

    const newDir = normalizePath(this.manifest.dir + '/reports');
    const pathMap = {};
    try {
      await this.app.vault.adapter.mkdir(newDir).catch(() => {});
      const listing = await this.app.vault.adapter.list(legacyDir + '/reports').catch(() => null);
      for (const f of ((listing && listing.files) || [])) {
        const name = String(f).split('/').pop();
        const md = await this.app.vault.adapter.read(f).catch(() => null);
        if (md == null) continue;
        const target = newDir + '/' + name;
        await this.app.vault.adapter.write(target, md).catch(() => {});
        pathMap[f] = target;
      }
    } catch (e) { /* 迁移失败不阻塞加载 */ }

    if (legacy) {
      if (typeof legacy.inbox === 'string' && legacy.inbox.trim()
        && (!this.settings.jobLensInbox || this.settings.jobLensInbox === DEFAULT_SETTINGS.jobLensInbox)) {
        this.settings.jobLensInbox = legacy.inbox.trim();
      }
      if (typeof legacy.lastRole === 'string') st.lastRole = legacy.lastRole;
      if (Array.isArray(legacy.history)) st.history = legacy.history.slice(0, 20);
      const remap = (p) => {
        if (!p) return '';
        if (pathMap[p]) return pathMap[p];
        const name = String(p).split('/').pop();
        const hit = Object.values(pathMap).find((t) => String(t).split('/').pop() === name);
        return hit || '';
      };
      st.reportPaths = (Array.isArray(legacy.reportPaths) ? legacy.reportPaths : [])
        .map(remap).filter(Boolean).slice(0, 30);
      st.lastReportPath = remap(legacy.lastReportPath) || st.reportPaths[0] || '';
    }
    st.migratedFromLegacy = true;
    await this.saveAll();
  }

  onunload() {
    // 事件由 registerEvent 自动清理
    // 岗位透镜视图随插件卸载自动关闭，这里显式 detach 避免残留空 leaf
    try {
      this.app.workspace.getLeavesOfType(JOB_LENS_VIEW_TYPE).forEach((leaf) => leaf.detach());
    } catch (e) { /* 忽略 */ }
  }
}

/* ==================== 岗位透镜：面板视图 + 输入 Modal ==================== */

class JobLensView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.showPath = null;
  }
  getViewType() { return JOB_LENS_VIEW_TYPE; }
  getDisplayText() { return '岗位透镜'; }
  getIcon() { return 'compass'; }

  async onOpen() {
    this.contentEl.empty();
    this.contentEl.addClass('xyjl-view');
    const bar = this.contentEl.createDiv({ cls: 'xyjl-viewbar' });
    this.titleEl = bar.createDiv({ cls: 'xyjl-viewtitle', text: '岗位透镜' });
    const actions = bar.createDiv({ cls: 'xyjl-viewactions' });
    actions.createEl('button', { cls: 'xyjl-btn', text: '＋ 新分析' }).addEventListener('click', () => this.plugin.openJobLensModal());
    actions.createEl('button', { cls: 'xyjl-btn xyjl-btn-ghost', text: '导出待办' }).addEventListener('click', () => { void this.plugin.exportTodos(); });
    actions.createEl('button', { cls: 'xyjl-btn xyjl-btn-ghost', text: '刷新' }).addEventListener('click', () => { void this.renderLatest(); });
    this.bodyEl = this.contentEl.createDiv({ cls: 'xyjl-viewbody' });
    await this.renderLatest();
  }
  async onClose() {
    this.contentEl.empty();
  }

  async renderLatest() {
    const st = this.plugin.jobLensState();
    this.showPath = st.lastReportPath || (st.reportPaths || [])[0] || null;
    await this.renderReport(this.showPath);
  }

  async renderReport(path) {
    this.bodyEl.empty();
    if (!path) {
      this.titleEl.setText('岗位透镜');
      this.bodyEl.createDiv({ cls: 'xyjl-hint', text: '还没有分析报告。点击右上角「＋ 新分析」，AI 会从你的技能矩阵反推最适合的岗位方向（需要 AI 网关在线）。' });
      return;
    }
    try {
      const md = await this.app.vault.adapter.read(path);
      const name = path.split('/').pop();
      this.titleEl.setText(name);
      const paths = this.plugin.jobLensState().reportPaths || [];
      if (paths.length > 1) {
        const hist = this.bodyEl.createDiv({ cls: 'xyjl-history' });
        for (const p of paths.slice(0, 8)) {
          const n = p.split('/').pop();
          const b = hist.createEl('button', { cls: 'xyjl-histbtn' + (p === path ? ' is-active' : ''), text: n });
          b.addEventListener('click', () => { void this.renderReport(p); });
        }
      }
      const mdBox = this.bodyEl.createDiv({ cls: 'xyjl-md' });
      try {
        await MarkdownRenderer.render(this.app, md, mdBox, path, this);
      } catch (e) {
        mdBox.setText(md);
      }
    } catch (e) {
      this.bodyEl.createDiv({ cls: 'xyjl-hint', text: '报告读取失败：' + (e && e.message ? e.message : e) });
    }
  }
}

class JobLensModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: '岗位透镜 · 新分析' });
    contentEl.createDiv({ cls: 'xyjl-hint', text: '主分析：从你的技能矩阵反推最适合的岗位方向（零输入）。下方字段全部可选——填了定向岗位则改做定向分析，贴 JD 则优先按 JD。' });
    let roleEl, jdEl, preferEl;
    new Setting(contentEl).setName('候选人偏好（可选）').addTextArea((t) => {
      preferEl = t;
      t.inputEl.rows = 2;
      t.inputEl.style.width = '100%';
      t.setPlaceholder('如：不想上夜班 / 偏好杭州 / 只想投运维方向');
    });
    new Setting(contentEl).setName('定向岗位（可选）').addText((t) => {
      roleEl = t;
      t.inputEl.style.width = '100%';
      t.setPlaceholder('如：DevOps 工程师（填了则改做定向分析）');
      t.setValue(this.plugin.jobLensState().lastRole || '');
    });
    new Setting(contentEl).setName('真实 JD（可选）').addTextArea((t) => {
      jdEl = t;
      t.inputEl.rows = 4;
      t.inputEl.style.width = '100%';
      t.setPlaceholder('粘贴 Boss 等平台的 JD 原文，定向分析时优先依据');
    });
    const btns = contentEl.createDiv({ cls: 'xyjl-btns' });
    const runBtn = btns.createEl('button', { cls: 'xyjl-btn', text: '开始分析（约 30~60 秒）' });
    runBtn.addEventListener('click', async () => {
      const role = roleEl.getValue().trim();
      const jd = jdEl.getValue().trim();
      const prefer = preferEl.getValue().trim();
      runBtn.disabled = true;
      const isTargeted = !!role;
      runBtn.textContent = isTargeted ? '定向分析中…' : '岗位发现中…';
      try {
        if (isTargeted) await this.plugin.runTargeted(role, jd);
        else await this.plugin.runDiscover(prefer);
        new Notice('分析完成，报告已更新到面板', 5000);
        this.close();
        void this.plugin.activateView();
      } catch (e) {
        new Notice('分析失败：' + (e && e.message ? e.message : e), 10000);
        runBtn.disabled = false;
        runBtn.textContent = '开始分析（约 30~60 秒）';
      }
    });
    btns.createEl('button', { cls: 'xyjl-btn xyjl-btn-ghost', text: '取消' }).addEventListener('click', () => this.close());
  }
  onClose() { this.contentEl.empty(); }
}

module.exports = SkillMinerPlugin;
module.exports.__internal = {
  buildCanonicalizer, parseYearMonth, buildTimeline12, weightedPick, judgeCluster,
  aggregateDocs, parseQaBlocks, extractQaFromRaw,
  buildProfileNote, buildResumeExport, extractJson, AIClient,
  trackOf, trackColor, canonicalTrack, recomputeTracks, applyRefinedTracks, median,
  makeNameLookup, normClusterKey,
  bubbleQuadrantSVG, radarSVG, trackBarsSVG, timelineStackedSVG,
  parseProfileFromManual, manualByKind, renderReposHtml, renderLangHtml, renderMetaHtml,
  renderWorkHtml, renderProjectsHtml, renderKeywordsHtml, renderEduHtml,
  fillResumeTemplate, loadResumeTemplate, langColor, buildSkillAppendixHtml,
  renderNextGuideHtml, LEVEL_FACE,
  DEFAULT_SETTINGS,
};
