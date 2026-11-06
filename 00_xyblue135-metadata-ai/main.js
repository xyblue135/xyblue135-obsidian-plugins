/*
 * xyblue135 私人 · AI 元数据
 * 类型：xyblue135 私人插件（非公共发布版）
 * 说明：用户可见文案与维护注释已中文化；内部插件 ID 与 data.json 保持不变，以兼容原有设置和数据。
 */
/*
 * xyblue135-AI-Metadata for Obsidian
 * Author: xyblue135
 * v0.7.0
 *
 * Features:
 * - Inline AI buttons beside summary_short / summary_long / tags / technical_depth only for the root /00_docs whitelist.
 * - Up to N technically weighted tags (default cap 7), values only (no hierarchy); fewer valid tags are accepted.
 * - Maintains a local-only tag catalog from Markdown files under 00_docs/ (never sent to AI).
 * - Canonicalizes tag casing locally: existing Vault spelling first, built-in/editable technical spellings as fallback.
 * - Keeps only essential persistent state: optional per-field fingerprints and error diagnostics.
 * - Sequential API queue with a visible timeout (default 180s) and request gap (default 30s).
 * - Auto-refresh countdown starts only after the whole update cycle has finished.
 * - Folder-scoped pending dashboard with per-note previews, scope-drift protection, and stoppable sequential sync.
 * - JSON-mode structured replies, optional local JSON repair, one automatic structured-output retry, and raw-output diagnostics.
 * - Desktop status-bar progress/countdown while AI work is running.
 * - Editable/disableable harness constraints in Settings.
 */
const {
  Modal,
  Notice,
  parseYaml,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  setIcon,
  // 模板骨架（1.30 由原 00_xyblue135-docs-template 并入）需要这两个
  normalizePath,
  moment,
} = require("obsidian");

const DEFAULT_SUMMARY_SHORT_HARNESS = [
  "语言：中文。",
  "用途：生成 summary_short，用于文章列表、搜索结果、悬浮预览和快速识别主题。",
  "形式：只输出一个自然、完整的单句摘要，不换行。",
  "内容：优先保留核心对象或技术主题、核心问题，以及最主要的解决方案、结论或知识点；保留最有辨识度的技术名词和关键参数，但不要展开完整排查过程。",
  "表达：必须是自然中文，不要写成电报体、日志体、参数串或关键词堆砌；不要为了压缩大量使用 /、+、→ 等符号代替正常语言关系。",
  "不要使用‘本文介绍了’、‘这篇文章讲了’、‘这篇笔记主要是’等套话；不要 Markdown、标题、引号或前后解释。",
  "长度：不得超过 {{summaryShortMaxChars}} 个字符；正文信息充足时，尽量使用上限的 70%～90%，但不要为了凑长度加入重复信息。",
].join("\n");

const DEFAULT_SUMMARY_LONG_HARNESS = [
  "语言：中文。",
  "用途：生成 summary_long，用于理解整篇文章结构，并服务于 AI 分类、技术含量判断、搜索、相关文章推荐、RAG 和文章排序。",
  "形式：输出一段自然、完整的内容摘要，可使用 2～3 个完整句子，但不要换行。",
  "目标：生成‘文章内容总览’，而不是最终结论、技术速记或参数清单；读者只阅读摘要，就应大致知道文章的背景问题、关键排查或分析过程、主要技术方案、涉及的重要技术点，以及最终结论、限制或待验证问题。",
  "内容要求：正文中存在时，应尽可能覆盖核心对象/背景问题、关键实验或测试数据、判断依据与因果关系、最终技术方案、关键参数/组件/接口/算法/工具，以及重要注意事项、风险、限制、异常现象或待验证问题。",
  "不要只写‘问题 + 最终方案’；如果正文包含排查、测试、选型、实现和风险分析，应尽量把这些阶段都压缩进摘要。",
  "优先保留具有检索价值和技术辨识度的具体信息，例如型号、技术名词、接口名称、关键数值、测试结果、核心模块和异常现象；不要用‘进行了测试’‘采用相关方法’等模糊概括替代具体内容。",
  "表达：使用自然、完整、连贯的中文叙述，不要写成电报体、日志体、关键词堆叠或参数串；避免大量使用 /、+、→ 等符号代替正常语言关系。允许使用‘针对……’‘通过……发现……’‘进一步……’‘同时……’等连接方式。",
  "不要使用‘本文介绍了’、‘这篇文章介绍了’、‘这篇笔记讲了’等空泛开场；不要 Markdown、标题、引号或前后解释。",
  "长度：不得超过 {{summaryLongMaxChars}} 个字符；正文信息充足时，尽量使用上限的 75%～95%；如果内容过多，优先压缩措辞，而不是删除关键技术阶段。",
  "禁止输出类似‘设备故障，测试A/B得出结论；使用模块X、Y完成改造，信号Z待验证’这种高度压缩的技术速记，必须改写成自然的文章概述。",
].join("\n");

const LEGACY_TAGS_HARNESS_V042 = [
  "标签只保留 value，不使用 skill/Linux、domain/云计算 这类层级前缀。",
  "按与笔记内容的相关性给候选标签分配 weight，weight 越高越重要。",
  "优先复用标签目录中已有的稳定标签；同等相关时优先复用出现频率更高的标签。",
  "避免同义词、近义重复和过度宽泛的标签。",
  "请给出足够候选项，插件会按 weight 从高到低取前 {{maxTags}} 个。",
].join("\n");

const LEGACY_TAGS_HARNESS_V050 = [
  "最多输出 {{maxTags}} 个互不重复的标签 value；优先质量，不要为了凑数量加入泛化、重复或低信息量标签；不得使用 skill/Linux、domain/云计算 这类层级前缀。",
  "weight 主要表示‘技术专有性 + 对检索这篇笔记的区分度’，不是泛泛的主题相关度。",
  "具体技术实体优先高权重：软件/工具、框架、库、协议、API、算法、数据结构、数据库、系统组件、具体文件或媒体格式等，应优先于宽泛动作或用途词。",
  "当具体技术词和泛化概念表达相近时，具体技术词必须明显更高。例如 FFmpeg≈0.98，视频转码≈0.72，格式转换≈0.45；不要让‘格式转换’这类泛词压过 FFmpeg。",
  "建议权重层级：核心具体技术 0.90~1.00；具体机制/算法/协议/格式 0.80~0.94；明确任务或领域 0.60~0.79；泛化动作/用途 0.30~0.59。",
  "优先复用标签目录中的稳定标签，但复用频率只是同等质量时的次级因素，不能为了复用高频泛词而舍弃更具体的技术标签。",
  "避免同义词、近义重复、上下位概念重复占位；在最多 {{maxTags}} 个标签内尽量覆盖不同的高信息量技术维度。",
].join("\n");

const DEFAULT_TAGS_HARNESS = [
  "最多输出 {{maxTags}} 个互不重复的标签 value；优先质量，不要为了凑数量加入泛化、重复或低信息量标签；不得使用 skill/Linux、domain/云计算 这类层级前缀。",
  "weight 主要表示‘技术专有性 + 对检索这篇笔记的区分度’，不是泛泛的主题相关度。",
  "具体技术实体优先高权重：软件/工具、框架、库、协议、API、算法、数据结构、数据库、系统组件、具体文件或媒体格式等，应优先于宽泛动作或用途词。",
  "当具体技术词和泛化概念表达相近时，具体技术词必须明显更高。例如 FFmpeg≈0.98，视频转码≈0.72，格式转换≈0.45；不要让‘格式转换’这类泛词压过 FFmpeg。",
  "建议权重层级：核心具体技术 0.90~1.00；具体机制/算法/协议/格式 0.80~0.94；明确任务或领域 0.60~0.79；泛化动作/用途 0.30~0.59。",
  "避免同义词、近义重复、上下位概念重复占位；在最多 {{maxTags}} 个标签内尽量覆盖不同的高信息量技术维度。",
].join("\n");

const DEFAULT_TECHNICAL_DEPTH_HARNESS = `你是一名技术内容评审员。请完整阅读下面提供的技术文章全文，对文章本身的“技术深度（technical_depth）”进行评分。

## 评分目标

technical_depth 衡量的是：

文章本身涉及的技术机制深度、工程实现复杂度、系统复杂度、分析验证强度以及所需前置知识密度。

它不是：

* 文章写得好不好
* 文章字数多少
* 教程是否详细
* 对某个特定读者来说难不难
* 文章是否有很多代码、命令或截图
* 文章是否有很多专业术语

因此：

一篇非常详细的软件安装教程、命令大全、工具使用说明，即使有上万字，也可能只有 10～35 分。

一篇只有两三千字，但真正分析了协议、内核、编译器、数据库内部机制、分布式一致性、性能瓶颈或复杂故障根因的文章，可以达到 60～85 分。

## 总分

technical_depth 为 0～100 的整数。

不要根据当前文章集合进行归一化。

不要把“当前最难文章”强行设置为 100。

100 分代表固定的专家级/研究级技术深度，因此绝大多数普通技术博客都不应该达到 90 分以上。

## 五个评分维度

### 1. 机制深度：0～28 分

判断文章是否真正解释“为什么”和“内部如何工作”。

重点包括：

* 底层原理
* 内部机制
* 数据结构
* 算法
* 协议
* 内核行为
* 调度机制
* 编译过程
* 存储机制
* 网络机制
* 分布式机制
* 数据流或控制流
* 源码级行为

仅告诉读者“执行什么命令”“在哪里点击”“修改什么配置”，不能获得高机制分。

### 2. 工程实现：0～24 分

判断文章是否包含真实、有复杂度的技术实现。

重点包括：

* 多组件协作
* 完整部署
* 架构搭建
* 编译
* 二次开发
* 复杂配置
* 自动化
* 系统集成
* 源码修改
* 性能调优
* 工程取舍

注意：

大量复制粘贴命令并不等于工程复杂度高。

单纯安装软件、配置环境变量、启动服务、修改少量配置文件，应限制在较低分数。

### 3. 分析与验证：0～19 分

判断文章是否形成真正的技术分析闭环。

例如：

现象
→ 收集证据
→ 提出假设
→ 日志/抓包/性能指标/源码分析
→ 排除错误方向
→ 定位根因
→ 修改方案
→ 再次验证

以下内容可以提高本项评分：

* benchmark
* 性能测试
* A/B 对比
* Wireshark
* tcpdump
* perf
* strace
* 日志分析
* 实验
* 指标变化
* 故障复现
* 多方案比较

如果文章只是给出最终解决办法，没有分析过程，本项不要给高分。

### 4. 系统复杂度：0～17 分

判断问题涉及多少技术层次以及它们之间是否存在真实关联。

例如：

应用
→ 中间件
→ 操作系统
→ 网络协议
→ 驱动
→ 硬件

或者：

客户端
→ 网关
→ 服务发现
→ Raft
→ 存储
→ 网络

跨组件、跨系统、跨层分析通常比单一工具的使用具有更高技术深度。

但不要因为文章提到了很多产品名称就自动加分，必须存在实际技术关系。

### 5. 前置知识密度：0～12 分

判断读者真正理解文章需要多少技术基础。

例如需要理解：

* 操作系统
* 网络
* 数据库
* 数据结构
* 编译原理
* 分布式系统
* GPU/CUDA
* 存储
* Linux 内核
* 数学或机器学习理论

单纯因为术语很多，不代表前置知识密度高。

## 分数区间标准

### 0～19：基础信息 / 简单操作

典型内容：

* 单个命令说明
* 软件是什么
* 简单参数说明
* 基础知识点
* 简单问题记录
* UI 操作
* 软件安装步骤

### 20～39：基础技术教程

典型内容：

* 常规 Linux 教程
* Docker 基础操作
* 普通软件部署
* 基本配置
* 常见故障解决
* API 基础使用
* 比较完整但机制较浅的教程

文章可以写得非常完整，但核心仍然是“怎么使用”。

### 40～59：中等技术深度

典型内容：

* 开始解释内部机制
* 多组件配置
* 较复杂部署
* 有一定故障分析
* 比较深入的数据库、Linux、网络、Docker/Kubernetes 教程
* 带有部分原理和验证的工程实践

### 60～74：高级技术

典型内容：

* 系统级故障排查
* 完整性能分析
* 跨组件问题
* 编译与复杂构建
* 分布式系统机制
* 网络底层问题
* 存储内部机制
* 有明显“证据 → 根因 → 修复 → 验证”的分析闭环

### 75～89：深度技术

典型内容：

* 跨多个技术层
* 深入底层机制
* 源码级或协议级分析
* 高复杂度工程实现
* 性能实验充分
* 多种工具联合定位
* 有较强技术取舍分析
* 接近高级工程师/专家经验总结

### 90～99：专家 / 研究级

只有在文章同时具备多数以下特征时使用：

* 很强的机制深度
* 源码或算法层分析
* 高复杂度系统问题
* 严格实验或性能验证
* 多方案比较
* 明确技术权衡
* 较强原创分析
* 对已有方法有改进或新的工程发现

不要因为文章“看起来很厉害”就给 90+。

### 100

极少使用。

代表非常完整的专家级或研究级技术成果，通常已经接近：

* 高质量研究论文
* 极深入的原创系统研究
* 完整架构设计 + 底层实现 + 实验验证
* 对复杂技术问题具有明显原创贡献

普通博客不需要存在 100 分文章。

## 特别需要防止的误判

### 长文章不等于高分

50000 字的命令参考手册，可能只有 25～40 分。

### 代码多不等于高分

大量 Shell、YAML、Docker Compose 或配置文件只是实现步骤时，不应该自动获得高分。

### 安装复杂不等于技术深

“安装了很多依赖、踩了很多环境问题”不代表文章达到高级技术深度。

### 专业术语多不等于高分

必须确认文章真正解释或使用了这些机制。

### 知识类文章写得很好也不等于技术深

如果主要是概念介绍、历史介绍、软件介绍、基础科普，应保持较低到中等评分。

### 短文章也可能高分

如果短文章准确解释了一个非常深入的核心机制，可以获得较高分数。

## 评分要求

阅读全文后再评分，不要只根据标题、摘要或开头判断。

先在内部完成五个维度的判断，然后得到最终 technical_depth。

最终分数必须是整数。

相邻文章之间不必人为拉开差距；如果技术深度相近，可以得到相同分数。

不要为了让分布看起来漂亮而修改分数。

## 输出格式

只输出以下 JSON，不要 Markdown，不要解释，不要添加任何其他文字：

{
"technical_depth": 68,
"mechanism_depth": 20,
"engineering_depth": 17,
"analysis_validation": 13,
"system_complexity": 10,
"prerequisite_density": 8,
"reason": "一句话说明为什么得到这个分数"
}

其中五个维度之和必须严格等于 technical_depth。

reason 控制在 80 个汉字以内，重点说明决定该文章技术深度的主要原因，不要复述标题。

下面是需要评分的文章全文：

{{ARTICLE}}`;

const DEFAULT_TECHNICAL_TAG_CANONICAL_LIST = [
  "Linux",
  "Prometheus",
  "Grafana",
  "Docker",
  "Kubernetes",
  "K8s",
  "Nginx",
  "MySQL",
  "PostgreSQL",
  "Redis",
  "MongoDB",
  "Git",
  "GitHub",
  "GitLab",
  "Jenkins",
  "Ansible",
  "Terraform",
  "Python",
  "Java",
  "JavaScript",
  "TypeScript",
  "NodeJS",
  "React",
  "Vue",
  "Angular",
  "Spring",
  "SpringBoot",
  "OpenAI",
  "ChatGPT",
  "Obsidian",
  "Selenium",
  "FFmpeg",
  "Fluent",
  "Unity",
  "YOLO",
  "PyTorch",
  "TensorFlow",
  "CUDA",
  "OpenCV",
  "NumPy",
  "Pandas",
  "ScikitLearn",
  "REST",
  "HTTP",
  "HTTPS",
  "TCP",
  "UDP",
  "DNS",
  "SSH",
  "TLS",
  "JSON",
  "YAML",
  "XML",
  "HTML",
  "CSS",
  "SQL",
  "NoSQL",
  "API",
  "SDK",
  "CI",
  "CD",
  "DevOps",
  "MLOps",
  "LLM",
  "RAG",
  "Nacos",
  "Zabbix",
  "Loki",
  "Promtail",
  "SkyWalking",
].join("\n");

const DEFAULT_QA_HARNESS = `语言：中文。
用途：基于本笔记正文生成 {{maxQuestions}} 道面试题，用于面试自测复习。
形式：输出 Q/A 交替的纯文本，不要 Markdown、代码块、标题或额外解释；每题格式固定为：
Q: <问题>
A: <答案>

每道题之间空一行。问题要具体、有区分度，优先覆盖正文的核心对象、关键技术点、原理机制、配置/排查要点和易错点；答案要精炼、口语化、可直接用于面试作答，不要大段复述原文。不要编造正文没有的内容。`;

const DEFAULT_AI_TITLE_HARNESS = `语言：中文。
用途：基于本笔记正文生成 {{maxItems}} 个参考性文章标题，供用户挑选，并便于后续 RAG 检索。
形式：只输出纯文本标题列表，每行一个标题，不要序号、Markdown 列表符号、代码块、标题或额外解释。
要求：标题要准确反映正文主题与关键信息，风格多样（可包含直述式、设问式、数字式等），彼此区分明显；不要编造正文没有的内容。`;

const DEFAULT_FRESHNESS_HARNESS = `语言：中文。
用途：评估本笔记的技术时效性，生成 AI_freshness（快速结论）与 AI_freshness_note（时效性说明）；AI_last_verified 由插件自动写入本地时间戳，不需要模型输出。
形式：严格按以下两段输出纯文本，不要 Markdown、代码块或额外解释。
第一行：以下三个值三选一，原样输出，不加任何其他文字：
🟢 仍可用
🟡 部分过时
🔴 主体过时
第二行起：时效性说明，不超过 150 字，依次覆盖三点：
1) 主线内容与方法论现在是否仍然成立；
2) 具体哪些点已过时：版本、API、平台规则、默认行为的变化，并给出现在正确的做法；
3) 相关替代品或竞品，注明关系是「已取代」「并行选择」还是「相邻概念」。
要求：只依据正文与确定性高的技术常识判断，不要编造未核实的版本号或时间点；没有过时点就直说「未见明显过时内容」。`;

const DEFAULT_TAKE_HARNESS = `作为该文章所在领域的资深工程师，阅读技术博文，写一段简短客观评价。
评价要点：
- 肯定文章的优点：行文规整、有无错误、对目标读者的价值；
- 指出局限性：文章只停留在概念 / 使用层面，没有深入底层协议、内部机制；
- 语气平实，不带嘲讽，不吹不黑，内行视角，不要长篇大论。`;

// 内容指纹忽略的 frontmatter 键。
// 1) 插件自身管理的 AI_* 字段与旧版 summary/tags 字段：插件自己写入不应触发「正文已变动」。
// 2) token_count：由 00_xyblue135-char-count-updater 在正文变化后延迟（debounce 5 秒）写入的派生字段。
//    它若参与指纹，会出现「编辑后 5 秒内触发 AI → 基线里 token_count 还是旧值 → 5 秒后它被更新」
//    的误报：正文其实没变，却被判定为变动。它由正文推导而来，忽略它不会漏掉任何真实的正文改动。
const FINGERPRINT_IGNORED_KEYS = [
  "summary",
  "summary_short",
  "summary_long",
  "tags",
  "technical_depth",
  "take",
  "qa",
  "AI_summary_short",
  "AI_summary_long",
  "AI_tags",
  "AI_technical_depth",
  "AI_take",
  "AI_qa",
  "AI_title",
  "AI_last_verified",
  "AI_freshness",
  "AI_freshness_note",
  "position",
  "token_count",
];

// 10 个 AI 元数据键(前 7 个可 AI 生成 + 时效性三键),顺序固定,全插件唯一的一份顺序定义。
// 与插件文档化的字段顺序一致：AI_title → AI_tags → AI_summary_short → AI_summary_long
// → AI_technical_depth → AI_take → AI_qa。
// 批量识别用它判断"缺失 / 已有内容"，CSV 导出用它决定列顺序。
const METADATA_KINDS = [
  "ai_title",
  "tags",
  "summary_short",
  "summary_long",
  "technical_depth",
  "take",
  "qa",
  "freshness",
  "freshness_note",
  "last_verified",
];

// v0.8.0：格式校验覆盖的字段 = 10 个 AI 字段 + 4 个工作流字段（14 键全量）。
// 巡检/✓ 校验按钮/设置页都按这个列表走；METADATA_KINDS 保持只有 10 个 AI 字段，
// 批量生成、缺失补全、CSV 的既有行为完全不受影响（工作流字段不给 ✨ 生成按钮）。
const FORMAT_CHECK_KINDS = [...METADATA_KINDS, "status", "visibility", "updated", "token_count"];

// ==================== 格式校验（纯本地正则，与提示词完全分开） ====================
// 设计约束：
// 1) 只做校验，不调用 AI、不写盘、不改数据；结果只弹窗展示。
// 2) 每个字段一组正则，一行一条，**全部匹配**才算通过（可用 /表达式/标志 语法）。
// 3) 以 # 开头的行是注释，方便把「校验目标 / 期望格式」写在规则里对照提示词。
// 4) 正则完全由用户在设置页维护，与 Harness（提示词）是两套独立配置。
// 校验目标由代码固定，并会写进设置页各模块的说明里：
//   ai_title / tags            → 数组每项占一行拼接（不 trim、不加 "- " 前缀）
//   summary_short/long/take/qa → 字段原始字符串（多行块标量含换行）
//   technical_depth            → 字段值的字符串形式
const FORMAT_CHECK_TARGETS = {
  ai_title: "AI_title 数组的每一项占一行拼接（不加 \"- \" 前缀、不额外 trim）",
  tags: "AI_tags 数组的每一项占一行拼接（不加 \"- \" 前缀、不额外 trim）",
  summary_short: "AI_summary_short 的原始字符串",
  summary_long: "AI_summary_long 的原始字符串",
  technical_depth: "AI_technical_depth 值的字符串形式",
  take: "AI_take 的原始字符串（多行块标量按原样，含换行）",
  qa: "AI_qa 的原始字符串（多行块标量按原样，含换行）",
  freshness: "AI_freshness 的原始字符串（三选一：🟢 仍可用 / 🟡 部分过时 / 🔴 主体过时）",
  freshness_note: "AI_freshness_note 的原始字符串（多行块标量按原样，含换行）",
  last_verified: "AI_last_verified 的原始字符串（17 位时间戳 YYYYMMDDhhmmssSSS）",
  status: "status 的原始字符串（🟢 done / 🔴 undone，灯内嵌）",
  visibility: "visibility 的原始字符串（🟢 open / 🔴 unopen，灯内嵌）",
  updated: "updated 的原始字符串（17 位时间戳 YYYYMMDDhhmmssSSS）",
  token_count: "token_count 的字符串形式（非负整数）",
};

// 「缺失元数据补全 / 顺序修正」子模块用的元数据顺序。
// 一行一个 frontmatter 键；补全会按这个顺序插入缺失字段，顺序巡检也按它判断对错。
// 只处理本插件的 AI_ 字段，status / visibility / updated / token_count 等键一律不动。
const DEFAULT_METADATA_KEY_ORDER = [
  "AI_last_verified",
  "AI_title",
  "AI_tags",
  "AI_freshness",
  "AI_technical_depth",
  "AI_freshness_note",
  "AI_summary_short",
  "AI_summary_long",
  "AI_take",
  "AI_qa",
].join("\n");

const DEFAULT_FORMAT_CHECKS = {
  ai_title: {
    enabled: true,
    rules: [
      "# 校验目标：AI_title 数组每一项占一行拼接",
      // 1.1：行数与 DEFAULT_AI_TITLE_HARNESS 的 {{maxItems}}（默认 aiTitleMaxItems=5）对齐。
      // 只校验「行数与空行」，不再强制《》包裹、也不再禁止列表符号：
      // 那两条容易与用户自己的标题提示词/示例（如「- 《标题一》」）冲突，造成系统性误报。
      "# 与提示词 {{maxItems}}（默认 5 条）对齐：1~5 行，每行一个非空标题，不允许多余空行",
      "/^[^\\n]+(?:\\n[^\\n]+){0,4}$/",
    ].join("\n"),
  },
  tags: {
    enabled: true,
    rules: [
      "# 校验目标：AI_tags 数组每一项占一行拼接",
      // 1.1：数量上限与设置项 maxTags 默认值 7 对齐
      "# 数量 1~7 个（与设置 maxTags 默认值 7 对齐），每个标签非空",
      "/^[^\\n]+(?:\\n[^\\n]+){0,6}$/",
    ].join("\n"),
  },
  summary_short: {
    enabled: true,
    rules: [
      "# 校验目标：AI_summary_short 原始字符串",
      "# 不超过 100 字符",
      "/^[\\s\\S]{0,100}$/",
    ].join("\n"),
  },
  summary_long: {
    enabled: true,
    rules: [
      "# 校验目标：AI_summary_long 原始字符串",
      "# 不超过 300 字符",
      "/^[\\s\\S]{0,300}$/",
    ].join("\n"),
  },
  technical_depth: {
    enabled: true,
    rules: [
      "# 校验目标：AI_technical_depth 值的字符串形式",
      "# 0~100 的整数",
      "/^(?:100|[1-9]?\\d)$/",
    ].join("\n"),
  },
  take: {
    enabled: true,
    rules: [
      "# 校验目标：AI_take 原始字符串",
      // 1.1：DEFAULT_TAKE_HARNESS 未要求首行标注，删掉与提示词矛盾的「必须首行标注」规则
      "# 默认提示词未要求首行标注，这里不校验首行；整体不超过 200 字符",
      "/^[\\s\\S]{0,200}$/",
    ].join("\n"),
  },
  qa: {
    enabled: true,
    rules: [
      "# 校验目标：AI_qa 原始字符串",
      // 1.1：改用 DEFAULT_QA_HARNESS 明确要求的 Q:/A: 结构，替换旧版「专家:/答:」
      "# 与 DEFAULT_QA_HARNESS 的 Q/A 格式对齐：第一行必须是「Q: 」开头",
      "/^Q: /",
      "# 至少存在一行以「A: 」开头的答案行",
      "/^A: /m",
    ].join("\n"),
  },
  freshness: {
    enabled: true,
    rules: [
      "# 校验目标：AI_freshness 原始字符串",
      "# 必须是三选一(🟢 仍可用 / 🟡 部分过时 / 🔴 主体过时),整行精确匹配",
      "/^🟢 仍可用$|^🟡 部分过时$|^🔴 主体过时$/",
    ].join("\n"),
  },
  freshness_note: {
    enabled: true,
    rules: [
      "# 校验目标：AI_freshness_note 原始字符串",
      "# 不超过 300 字符",
      "/^[\\s\\S]{0,300}$/",
    ].join("\n"),
  },
  last_verified: {
    enabled: true,
    rules: [
      "# 校验目标：AI_last_verified 原始字符串",
      "# 必须是 17 位时间戳 YYYYMMDDhhmmssSSS（与 updated 字段同风格）",
      "/^\\d{17}$/",
    ].join("\n"),
  },
  status: {
    enabled: true,
    rules: [
      "# 校验目标：status 的原始字符串",
      "# 库内约定取值：🟢 done（完成）/ 🔴 undone（未完成）——灯内嵌在值里，与 AI_freshness 同风格；空值按 empty 类计入",
      "/^🟢 done$|^🔴 undone$/",
    ].join("\n"),
  },
  visibility: {
    enabled: true,
    rules: [
      "# 校验目标：visibility 的原始字符串",
      "# 库内约定取值：🟢 open（公开）/ 🔴 unopen（未公开）——灯内嵌在值里",
      "/^🟢 open$|^🔴 unopen$/",
    ].join("\n"),
  },
  updated: {
    enabled: true,
    rules: [
      "# 校验目标：updated 的原始字符串",
      "# 17 位时间戳 YYYYMMDDhhmmssSSS（与 AI_last_verified 同口径）",
      "/^\\d{17}$/",
    ].join("\n"),
  },
  token_count: {
    enabled: true,
    rules: [
      "# 校验目标：token_count 的字符串形式",
      "# 非负整数（0 或正整数）",
      "/^\\d+$/",
    ].join("\n"),
  },
};

// 1.1：旧版默认校验规则（与默认 Harness 自相矛盾的那一套）。
// 仅用于一次性迁移：只有某个字段的 rules 与这里逐字相等，才说明用户从未改过它，
// 才允许替换成新版默认值；用户自己写过的规则一律不动。
const LEGACY_FORMAT_CHECK_RULES = {
  ai_title: [
    "# 校验目标：AI_title 数组每一项占一行拼接",
    "# 恰好 3 行；每行必须被《》完整包裹；不允许多余空行",
    "/^(?:《[^\\n《》]+》\\n){2}《[^\\n《》]+》$/",
  ].join("\n"),
  tags: [
    "# 校验目标：AI_tags 数组每一项占一行拼接",
    "# 数量 1~5 个，每个标签非空",
    "/^[^\\n]+(?:\\n[^\\n]+){0,4}$/",
  ].join("\n"),
  take: [
    "# 校验目标：AI_take 原始字符串",
    "# 第一条：第一行必须是该标注，不允许别的词",
    "/^【AI锐评 仅供参考 可能出错】\\n/",
    "# 第二条：整体不超过 200 字符",
    "/^[\\s\\S]{0,200}$/",
  ].join("\n"),
  qa: [
    "# 校验目标：AI_qa 原始字符串",
    "# 第一条：第一行必须是「专家:」",
    "/^专家:\\n/",
    "# 第二条：第三行必须是空行",
    "/^(?:[^\\n]*\\n){2}\\n/",
    "# 第三条：第四行必须以「答:」开头",
    "/^(?:[^\\n]*\\n){3}答:/",
  ].join("\n"),
};

// 设置结构版本号：1 = 格式校验规则已与 Harness 输出格式对齐（见 onload 里的一次性迁移）。
const SETTINGS_VERSION_FORMAT_CHECKS_ALIGNED = 1;

// 1.1：这些字段迁移校验规则时会「换一种输出结构」，因此只有提示词仍是默认值时才迁移。
// 其余字段（ai_title / tags / take）的新规则只是放宽了行数上限，不会产生新的误报，可以无条件迁移。
const FORMAT_CHECK_MIGRATION_REQUIRES_DEFAULT_HARNESS = {
  qa: "qaHarness",
};

/* ==================== 模板骨架（1.30 由原 00_xyblue135-docs-template 并入） ====================
   作用：新建 / 移入白名单目录的笔记，自动补齐缺失的 frontmatter 字段。
   与 AI 生成的区别：这里**纯静态、不调 AI**，只补「键」，值取模板里的默认值。
   合并原因：字段清单原本在 docs-template 的设置里、字段顺序在 AI 元数据的设置里，
   同一套 schema 定义两处；而且本插件 sidecar 的 create 监听（延迟 2500ms）本来就在
   等 docs-template 先跑完，是一处隐式跨插件依赖，合并后变成内部调用。 */
const DEFAULT_TEMPLATE_TEXT = [
  "---",
  "status: 🟢 done",
  "visibility: 🟢 open",
  "updated: {{timestamp}}",
  "token_count: 0",
  "AI_last_verified: ",
  "AI_title: []",
  "AI_tags: []",
  "AI_freshness: ",
  "AI_technical_depth: ",
  "AI_freshness_note: ",
  "AI_summary_short: ",
  "AI_summary_long: ",
  "AI_take: ",
  "AI_qa: ",
  "---",
  "",
  "",
].join("\n");

const DEFAULT_SETTINGS = {
  // 1.1：设置结构版本，用于只跑一次「旧默认校验规则 → 新默认校验规则」迁移。
  settingsVersion: SETTINGS_VERSION_FORMAT_CHECKS_ALIGNED,
  baseUrl: "http://192.168.3.101:3001/v1",
  apiKey: "",
  model: "auto",
  whitelistFolder: "my_blog/00_docs",
  // 0.9.0：时效复检阈值（天）——AI_last_verified 超过该天数进入复检清单；0 = 关闭年龄检测。
  recheckAgeDays: 90,
  // 0.9.0：定期巡检间隔（小时）——后台跑 14 键格式巡检并弹 Notice 摘要；0 = 关闭。
  autoInspectionHours: 0,
  summaryShortMaxChars: 100,
  summaryShortMaxCharsEnabled: true,
  summaryLongMaxChars: 300,
  summaryLongMaxCharsEnabled: true,
  summaryMarkdownCleanupEnabled: false,
  contentFingerprintEnabled: false,
  maxTags: 7,
  autoUpdateEnabled: false,
  autoUpdateMinutes: 60,
  statusDoneOnlyEnabled: false,
  requestTimeoutSeconds: 180,
  requestIntervalSeconds: 30,
  experimentalCombinedRequestEnabled: false,
  feedMetadataToAiEnabled: false,
  // 全局：是否把文章标题喂给 AI。默认开启（与旧行为一致：各字段提示词原本就带标题行）。
  feedTitleToAiEnabled: true,
  // 每次生成前先把本次要生成的字段清空（保留 frontmatter 键本身，只把值置空）。
  // 默认开启：用户习惯先手动建好空属性行再用 ✨ 逐项生成，清空可避免旧值残留。
  clearFieldsBeforeRunEnabled: true,
  structuredJsonModeEnabled: true,
  jsonRepairEnabled: true,
  statusBarEnabled: true,
  summaryShortHarnessEnabled: true,
  summaryLongHarnessEnabled: true,
  tagsHarnessEnabled: true,
  technicalDepthHarnessEnabled: true,
  tagCaseNormalizationEnabled: true,
  technicalTagCanonicalList: DEFAULT_TECHNICAL_TAG_CANONICAL_LIST,
  summaryShortHarness: DEFAULT_SUMMARY_SHORT_HARNESS,
  summaryLongHarness: DEFAULT_SUMMARY_LONG_HARNESS,
  tagsHarness: DEFAULT_TAGS_HARNESS,
  technicalDepthHarness: DEFAULT_TECHNICAL_DEPTH_HARNESS,
  takeHarnessEnabled: true,
  takeHarness: DEFAULT_TAKE_HARNESS,
  qaHarnessEnabled: true,
  qaMaxQuestions: 5,
  qaMaxQuestionsEnabled: false,
  qaHarness: DEFAULT_QA_HARNESS,
  aiTitleHarnessEnabled: true,
  aiTitleMaxItems: 5,
  aiTitleMaxItemsEnabled: true,
  aiTitleHarness: DEFAULT_AI_TITLE_HARNESS,
  freshnessHarnessEnabled: true,
  freshnessHarness: DEFAULT_FRESHNESS_HARNESS,
  // 格式校验配置（纯本地正则，与上面的 Harness 提示词分开存放，互不影响）。
  // 结构见 DEFAULT_FORMAT_CHECKS：{ [kind]: { enabled, rules } }
  formatChecks: DEFAULT_FORMAT_CHECKS,
  // 日志与报错（设置页「目录更新管理 → 日志与报错」）
  logMaxEntries: 300,
  logRetentionDays: 3,
  // 「缺失元数据补全 / 顺序修正」的元数据顺序（一行一个键）
  metadataKeyOrder: DEFAULT_METADATA_KEY_ORDER,
  // 方案B:AI_* 十键外置存储(00_metadata 平铺)。开启后存取都走 sidecar 文件,
  // 正文 frontmatter 只留工作流键(status/visibility/updated/token_count)。
  // 路径是 vault 根相对：文章下沉到 my_blog/ 后必须带前缀，
  // 否则 sidecar 会写到两个仓库之外（vault 根），既不进备份也搜不到。
  sidecarModeEnabled: false,
  metadataStoreFolder: "my_blog/00_metadata",

  // ── 模板骨架（1.30 由原 00_xyblue135-docs-template 并入）──
  // 新建 / 移入白名单目录的 .md 会自动补齐这里列出、而笔记里缺失的 frontmatter 字段。
  // 已有字段的值与顺序一律不动，只追加缺失项。纯静态，不调 AI。
  templateNote: DEFAULT_TEMPLATE_TEXT,
  // 模板作用范围：只处理这些目录下的 .md（含子目录）。逗号或换行分隔；留空 = 整个仓库。
  templateAuditFolders: "my_blog/00_docs",
  templateAuditOnCreate: true,
  templateAuditDelayMs: 1500,
};

const DEFAULT_STATE = {
  files: {},
  // 仅运行期缓存：Tag Catalog 每次启动后从 Vault 重建，不再持久化到 data.json。
  tagCatalog: {},
  // 运行日志（含报错）。持久化到 data.json，长度受 settings.logMaxEntries 限制，
  // 并按 settings.logRetentionDays 定期清理。内容只包含插件自己的错误与摘要，不含正文。
  logs: [],
};

class EmptyNoteBodyError extends Error {
  constructor(message = "笔记正文为空", fingerprint = "") {
    super(message);
    this.name = "EmptyNoteBodyError";
    this.code = "EMPTY_BODY";
    this.fingerprint = fingerprint;
  }
}

class StructuredOutputError extends Error {
  constructor(message, rawOutput = "", extra = {}) {
    super(message);
    this.name = "StructuredOutputError";
    this.code = "STRUCTURED_OUTPUT";
    this.rawOutput = String(rawOutput || "");
    this.repairAttempted = extra.repairAttempted === true;
    this.repairSucceeded = extra.repairSucceeded === true;
    this.repairedText = String(extra.repairedText || "");
    this.attempts = Array.isArray(extra.attempts) ? extra.attempts : [];
  }
}

class TaskCancelledError extends Error {
  constructor(message = "任务已由用户停止") {
    super(message);
    this.name = "TaskCancelledError";
    this.code = "TASK_CANCELLED";
  }
}

class FileLeftScopeError extends Error {
  constructor(path, folder) {
    super(`任务执行期间文件已移出当前识别目录：${path}`);
    this.name = "FileLeftScopeError";
    this.code = "FILE_LEFT_SCOPE";
    this.path = path;
    this.folder = folder;
  }
}

// 正文在生成期间发生变动。分为两种时机：
// - 发请求之前发现（本次 API 调用没有发出去，不消耗额度）；
// - 请求返回之后发现（结果已生成但不再写入）。
class SourceChangedError extends Error {
  constructor(message = "笔记正文已变动，本次 API 请求未发出", fingerprint = "") {
    super(message);
    this.name = "SourceChangedError";
    this.code = "SOURCE_CHANGED";
    this.fingerprint = fingerprint;
  }
}

// ==================== 极简 ZIP 打包器（store：只打包、不压缩） ====================
// Obsidian 没有内置压缩库，这里手写一个最小可用的 ZIP 写入器：
// 本地文件头 + 文件数据 + 中央目录 + EOCD；压缩方法固定为 0（store），
// 文件名用 UTF-8（通用标志位 bit 11），因此中文目录/文件名（如 00_docs_白名单）在
// Windows 资源管理器、macOS 归档工具、7-Zip 里都能正常显示。
// 不压缩的原因：实现最简单、速度最快、不需要任何第三方依赖，体积约等于原文总和。
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ZIP 用的是 MS-DOS 时间格式（秒按 2 秒精度存储）。
function zipDosDateTime(date) {
  const d = date instanceof Date ? date : new Date();
  const year = Math.max(1980, d.getFullYear());
  return {
    time: ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | ((Math.floor(d.getSeconds() / 2)) & 0x1F),
    date: (((year - 1980) & 0x7F) << 9) | (((d.getMonth() + 1) & 0x0F) << 5) | (d.getDate() & 0x1F),
  };
}

// entries: [{ name: "sub/a.md", data: Uint8Array }] → Uint8Array（完整 zip 字节）
function buildZipArchive(entries) {
  const encoder = new TextEncoder();
  const { time, date } = zipDosDateTime(new Date());
  const chunks = [];
  const central = [];
  let offset = 0;
  const write = (bytes) => {
    chunks.push(bytes);
    offset += bytes.length;
  };

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const data = entry.data;
    const crc = crc32(data);
    const localOffset = offset;

    const header = new Uint8Array(30 + nameBytes.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true); // 本地文件头签名
    view.setUint16(4, 20, true); // 解压所需版本 2.0
    view.setUint16(6, 0x0800, true); // 通用标志位：文件名是 UTF-8
    view.setUint16(8, 0, true); // 压缩方法 0 = store
    view.setUint16(10, time, true);
    view.setUint16(12, date, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, data.length, true); // 压缩后大小
    view.setUint32(22, data.length, true); // 原始大小
    view.setUint16(26, nameBytes.length, true);
    view.setUint16(28, 0, true); // 扩展字段长度
    header.set(nameBytes, 30);
    write(header);
    write(data);

    central.push({ nameBytes, crc, size: data.length, offset: localOffset });
  }

  const centralStart = offset;
  for (const item of central) {
    const record = new Uint8Array(46 + item.nameBytes.length);
    const view = new DataView(record.buffer);
    view.setUint32(0, 0x02014b50, true); // 中央目录签名
    view.setUint16(4, 20, true); // 创建版本
    view.setUint16(6, 20, true); // 解压所需版本
    view.setUint16(8, 0x0800, true);
    view.setUint16(10, 0, true);
    view.setUint16(12, time, true);
    view.setUint16(14, date, true);
    view.setUint32(16, item.crc, true);
    view.setUint32(20, item.size, true);
    view.setUint32(24, item.size, true);
    view.setUint16(28, item.nameBytes.length, true);
    view.setUint16(30, 0, true); // 扩展字段长度
    view.setUint16(32, 0, true); // 注释长度
    view.setUint16(34, 0, true); // 起始磁盘号
    view.setUint16(36, 0, true); // 内部属性
    view.setUint32(38, 0, true); // 外部属性
    view.setUint32(42, item.offset, true); // 对应本地文件头的偏移
    record.set(item.nameBytes, 46);
    write(record);
  }
  const centralSize = offset - centralStart;

  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true); // EOCD 签名
  eocdView.setUint16(4, 0, true);
  eocdView.setUint16(6, 0, true);
  eocdView.setUint16(8, central.length, true);
  eocdView.setUint16(10, central.length, true);
  eocdView.setUint32(12, centralSize, true);
  eocdView.setUint32(16, centralStart, true);
  eocdView.setUint16(20, 0, true);
  write(eocd);

  const out = new Uint8Array(offset);
  let cursor = 0;
  for (const chunk of chunks) {
    out.set(chunk, cursor);
    cursor += chunk.length;
  }
  return out;
}

function formatByteSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

module.exports = class AiMetadataPlugin extends Plugin {
  async onload() {
    const saved = (await this.loadData()) || {};
    // v0.1 将设置直接存储在根级；v0.2 改为 {settings, state} 结构。
    const savedSettings = saved.settings || saved;
    const savedState = saved.state || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, savedSettings);

    /* 模板骨架的定时器表：以「文件对象」为键而不是路径 ——
       新建笔记常在几百毫秒内被重命名，用路径做键会在重命名后重新排队，旧定时器白跑一趟。 */
    this.templateAudits = new Map();

    // v0.6.0：从单 summary 升级为 summary_short + summary_long。
    // 旧 summaryMaxChars <= 140 时视为“短摘要长度”；>= 180 时视为“长摘要长度”。
    // 不自动改写 Vault 内原有 summary 字段，避免升级时静默批量改笔记；新流程会维护两个新字段。
    const legacySummaryMaxChars = Number(savedSettings.summaryMaxChars);
    if (savedSettings.summaryShortMaxChars === undefined) {
      this.settings.summaryShortMaxChars = Number.isFinite(legacySummaryMaxChars) && legacySummaryMaxChars >= 40 && legacySummaryMaxChars <= 140
        ? legacySummaryMaxChars
        : DEFAULT_SETTINGS.summaryShortMaxChars;
    }
    if (savedSettings.summaryLongMaxChars === undefined) {
      this.settings.summaryLongMaxChars = Number.isFinite(legacySummaryMaxChars) && legacySummaryMaxChars >= 180
        ? Math.min(1000, legacySummaryMaxChars)
        : DEFAULT_SETTINGS.summaryLongMaxChars;
    }
    // 只在"从未保存过该 Harness"时补默认值。
    // 关键：不能用 falsy 判断。用户可能刻意把某个 Prompt 清空（表示不要这段约束），
    // 空字符串是有效配置，不能在下次启动时被静默改回默认值 —— 那会让人以为
    // "提示词改动要重启才生效"，实际是重启把它改回去了。
    const harnessWasSaved = (key) => Object.prototype.hasOwnProperty.call(savedSettings, key)
      && savedSettings[key] !== null
      && savedSettings[key] !== undefined;

    this.settings.summaryShortHarnessEnabled = true;
    this.settings.summaryLongHarnessEnabled = true;
    if (!harnessWasSaved("summaryShortHarness")) this.settings.summaryShortHarness = DEFAULT_SUMMARY_SHORT_HARNESS;
    if (!harnessWasSaved("summaryLongHarness")) this.settings.summaryLongHarness = DEFAULT_SUMMARY_LONG_HARNESS;
    delete this.settings.summaryMaxChars;
    delete this.settings.summaryHarness;
    delete this.settings.summaryHarnessEnabled;
    // v0.4.4 移除旧版“手动批量数量”数值控制项。
    delete this.settings.manualBatchSize;
    // 仅升级仍保持 v0.4.2 / v0.5.0 默认值的 Harness；如果用户已自定义，则原样保留。
    if (!harnessWasSaved("tagsHarness")
      || savedSettings.tagsHarness === LEGACY_TAGS_HARNESS_V042
      || savedSettings.tagsHarness === LEGACY_TAGS_HARNESS_V050) {
      this.settings.tagsHarness = DEFAULT_TAGS_HARNESS;
    }
    this.settings.tagsHarnessEnabled = true;
    if (!savedSettings.technicalTagCanonicalList) {
      this.settings.technicalTagCanonicalList = DEFAULT_TECHNICAL_TAG_CANONICAL_LIST;
    }
    // v0.7.0：新增 technical_depth。只新增默认评分 Prompt，不改写既有文章。
    this.settings.technicalDepthHarnessEnabled = true;
    if (!harnessWasSaved("technicalDepthHarness")) this.settings.technicalDepthHarness = DEFAULT_TECHNICAL_DEPTH_HARNESS;
    this.settings.takeHarnessEnabled = true;
    if (!harnessWasSaved("takeHarness")) this.settings.takeHarness = DEFAULT_TAKE_HARNESS;
    this.settings.qaHarnessEnabled = true;
    if (!harnessWasSaved("qaHarness")) this.settings.qaHarness = DEFAULT_QA_HARNESS;
    this.settings.aiTitleHarnessEnabled = true;
    if (!harnessWasSaved("aiTitleHarness")) this.settings.aiTitleHarness = DEFAULT_AI_TITLE_HARNESS;
    this.settings.freshnessHarnessEnabled = true;
    if (!harnessWasSaved("freshnessHarness")) this.settings.freshnessHarness = DEFAULT_FRESHNESS_HARNESS;
    // 格式校验配置：逐字段与默认值合并填充。
    // 不能整体覆盖 —— 旧 data.json 没有 formatChecks，或缺其中几个字段，
    // 整体覆盖会让缺失项变成 undefined，后面读写 rules 就会炸。
    this.settings.formatChecks = this.mergeFormatChecks(savedSettings.formatChecks);
    // 1.1：一次性迁移「默认校验规则与默认 Harness 互相矛盾」的旧配置。
    // 旧版 data.json 已把矛盾的那一套规则持久化下来，只改 DEFAULT_FORMAT_CHECKS 不会生效。
    // 这里只在 rules 与旧默认值逐字相等时替换，用户自定义过的规则绝不覆盖。
    const savedSettingsVersion = Number.isFinite(Number(savedSettings.settingsVersion))
      ? Number(savedSettings.settingsVersion)
      : 0;
    if (savedSettingsVersion < SETTINGS_VERSION_FORMAT_CHECKS_ALIGNED) {
      const migratedKinds = [];
      const skippedKinds = [];
      for (const kind of METADATA_KINDS) {
        const legacyRules = LEGACY_FORMAT_CHECK_RULES[kind];
        const config = this.settings.formatChecks[kind];
        if (!legacyRules || !config || config.rules !== legacyRules) continue;
        // 结构性变化的字段（qa 从「专家:/答:」改成「Q:/A:」）只在提示词也还是默认值时才迁移：
        // 用户若自己把 qa 提示词定为「专家:/答:」结构，强行换规则会制造新的系统性误报。
        const harnessKey = FORMAT_CHECK_MIGRATION_REQUIRES_DEFAULT_HARNESS[kind];
        if (harnessKey && this.settings[harnessKey] !== DEFAULT_SETTINGS[harnessKey]) {
          skippedKinds.push(this.fieldKeyForKind(kind));
          continue;
        }
        config.rules = DEFAULT_FORMAT_CHECKS[kind].rules;
        migratedKinds.push(this.fieldKeyForKind(kind));
      }
      this.settings.settingsVersion = SETTINGS_VERSION_FORMAT_CHECKS_ALIGNED;
      if (migratedKinds.length) {
        // 此刻 this.state 与定时器尚未初始化，只能用 console 记录
        console.info(`[metadata-ai] 已把默认格式校验规则升级为与 Harness 输出格式一致的版本：${migratedKinds.join("、")}`);
      }
      if (skippedKinds.length) {
        console.info(`[metadata-ai] 以下字段的提示词已被自定义，保留原校验规则（未自动改写）：${skippedKinds.join("、")}`);
      }
    }
    // 结构化合并请求已下线：强制关闭合并、内容指纹与摘要 Markdown 清理；自动更新改为逐字段单个请求。
    this.settings.experimentalCombinedRequestEnabled = false;
    this.settings.contentFingerprintEnabled = false;
    this.settings.summaryMarkdownCleanupEnabled = false;
    this.state = Object.assign({}, DEFAULT_STATE);
    this.state.files = this.loadPersistedFileState(savedState.files || {});
    // Tag Catalog 只存在于当前运行内存中，避免普通编辑/Tag 扫描反复改写 data.json。
    this.state.tagCatalog = {};
    // 运行日志：从磁盘恢复 → 按保留天数清理。这里先只做恢复与清理，
    // 不追加「启动」记录：scheduleStateSave() 依赖的 this.saveTimer 还没初始化。
    this.state.logs = Array.isArray(savedState.logs)
      ? savedState.logs.filter((entry) => entry && typeof entry === "object").slice(-2000)
      : [];
    this.pruneLogs();
    // 记录原始磁盘内容签名；首次 saveAllData() 会自动清理旧版运行状态字段。
    this.lastPersistedDataSignature = JSON.stringify(saved);
    // saveAllData 的串行化状态（写盘中的 Promise 与脏标记），必须在首次 saveAllData() 之前初始化。
    this.savePromise = null;
    this.saveDirty = false;

    // v0.6.0：旧版 lastSummaryHash 不再代表两个新摘要字段，统一移除，避免把旧 summary 误判为双摘要均已完成。
    for (const record of Object.values(this.state.files)) {
      if (!record || typeof record !== "object") continue;
      delete record.lastSummaryHash;
    }

    // v0.5.6：内容指纹识别改为可选功能。关闭时删除旧版持久化 hash 标记，
    // 让数据库不再依赖内容指纹。
    if (this.settings.contentFingerprintEnabled !== true) {
      this.clearPersistentFingerprintMarkers();
    }
    // v0.6.1：无论 fingerprint 是否开启，都执行一次轻量迁移。
    // 旧版 tagCatalog / updateLog / lastChangedAt 等运行状态会从 data.json 中清除；
    // 若迁移前后内容完全一致，则 saveAllData() 会自动跳过落盘。
    await this.saveAllData();

    this.observer = null;
    this.injectTimer = null;
    this.catalogTimer = null;
    this.saveTimer = null;
    this.autoTimeoutId = null;
    this.nextAutoRunAt = 0;
    this.autoRunning = false;
    this.cycleMode = null;
    this.autoRunController = null;
    this.fileBusy = new Set();
    // 按文件串行化 AI 写入用的互斥链（见 withAiWrite）
    this.aiWriteLocks = new Map();
    this.unloading = false;
    this.lifecycleToken = 1;
    this.apiQueue = Promise.resolve();
    this.lastApiCompletedAt = 0;
    this.activeHttpRequests = new Set();
    this.manualFolderRun = null;
    this.inspectionRun = null;
    this.gapRun = null;
    this.runtimeStatus = { mode: "idle" };
    this.lastCycleSummary = "";

    // 计时器已就绪，现在可以安全地写日志了。
    this.appendLog("info", `插件已加载（v${this.manifest && this.manifest.version ? this.manifest.version : "?"}）；日志上限 ${this.settings.logMaxEntries} 条，保留 ${this.settings.logRetentionDays} 天`);

    this.statusBarItem = this.addStatusBarItem();
    if (this.statusBarItem) {
      this.statusBarItem.addClass("ai-metadata-statusbar");
      this.statusBarItem.addEventListener("click", () => {
        new Notice(this.getStatusBarTooltip(), 5000);
      });
    }
    this.statusTickerId = window.setInterval(() => this.refreshStatusBar(), 1000);
    this.registerInterval(this.statusTickerId);
    this.refreshStatusBar();

    this.addSettingTab(new AiMetadataSettingTab(this.app, this));
    this.addRibbonIcon("tags", "AI 元数据 · 待更新面板", () => this.openPendingNotesDashboard()).addClass("xyblue135-ribbon xyblue135-ai");

    this.addCommand({
      id: "generate-summary",
      name: "为当前 00_docs 笔记生成长摘要 AI_summary_long",
      callback: () => void this.generateForActiveFile("summary_long"),
    });
    this.addCommand({
      id: "generate-summary-short",
      name: "为当前 00_docs 笔记生成短摘要 AI_summary_short",
      callback: () => void this.generateForActiveFile("summary_short"),
    });
    this.addCommand({
      id: "generate-both-summaries",
      name: "为当前 00_docs 笔记同时生成短摘要和长摘要",
      callback: () => void this.generateForActiveFile("summaries"),
    });
    this.addCommand({
      id: "generate-tags",
      name: "为当前 00_docs 笔记生成加权标签",
      callback: () => void this.generateForActiveFile("tags"),
    });
    this.addCommand({
      id: "generate-technical-depth",
      name: "为当前 00_docs 笔记评估技术深度 AI_technical_depth",
      callback: () => void this.generateForActiveFile("technical_depth"),
    });
    this.addCommand({
      id: "generate-take",
      name: "为当前 00_docs 笔记生成客观评价 AI_take",
      callback: () => void this.generateForActiveFile("take"),
    });
    this.addCommand({
      id: "generate-qa",
      name: "为当前 00_docs 笔记生成面试问答 AI_qa",
      callback: () => void this.generateForActiveFile("qa"),
    });
    this.addCommand({
      id: "generate-title",
      name: "为当前 00_docs 笔记生成参考标题 AI_title",
      callback: () => void this.generateForActiveFile("ai_title"),
    });
    this.addCommand({
      id: "generate-freshness",
      name: "为当前 00_docs 笔记评估时效性 AI_freshness（同时写 AI_freshness_note / AI_last_verified）",
      callback: () => void this.generateForActiveFile("freshness"),
    });
    this.addCommand({
      id: "open-metadata-sidecar",
      name: "打开当前文章的元数据 sidecar（00_metadata）",
      callback: async () => {
        const file = this.app.workspace.getActiveFile();
        if (!(file instanceof TFile) || file.extension !== "md" || !this.isWhitelisted(file)) {
          new Notice("xyblue135 私人·AI 元数据：请先打开一个 00_docs 白名单内的 Markdown 笔记");
          return;
        }
        const sidecar = this.sidecarFileFor(file);
        if (!sidecar) {
          new Notice("xyblue135 私人·AI 元数据：该文章还没有 sidecar 文件");
          return;
        }
        await this.app.workspace.getLeaf("tab").openFile(sidecar);
      },
    });
    this.addCommand({
      id: "generate-summary-and-tags",
      name: "为当前 00_docs 笔记生成全部 AI 元数据（10 个字段）",
      callback: () => void this.generateForActiveFile("all"),
    });
    this.addCommand({
      id: "open-pending-notes-dashboard",
      name: "打开待更新元数据笔记面板",
      callback: () => this.openPendingNotesDashboard(),
    });
    this.addCommand({
      id: "open-format-inspection",
      name: "格式巡检：手动巡检一次（正则校验 AI 元数据格式）",
      callback: () => this.openFormatInspection(),
    });
    this.addCommand({
      id: "open-freshness-recheck",
      name: "时效复检：对照 GitHub 仓库活动与核验时间",
      callback: () => this.openFreshnessRecheck(),
    });
    this.armPeriodicInspection();
    this.addCommand({
      id: "open-metadata-gap",
      name: "缺失元数据补全 / 顺序修正：巡检一次",
      callback: () => this.openMetadataGap(),
    });

    /* ── 模板骨架（1.30 由原 00_xyblue135-docs-template 并入）──
       命令 id 沿用原插件的 audit-current-note / audit-whitelist-notes 语义，
       只是换到本插件命名空间下。 */
    this.addCommand({
      id: "template-audit-current-note",
      name: "模板补全：审查并补全当前笔记的模板字段",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const eligible = !!(file && String(file.extension || "").toLowerCase() === "md" && this.isInTemplateScope(file));
        if (!eligible) return false;
        if (!checking) void this.auditTemplateAndFill(file, { notify: true });
        return true;
      },
    });
    this.addCommand({
      id: "template-audit-whitelist-notes",
      name: "模板补全：审查并补全白名单内全部笔记",
      callback: () => { void this.runBulkTemplateAudit(); },
    });

    // 新建 / 移入白名单目录的笔记：延迟一拍补齐缺失字段（给 Obsidian 一点时间完成写入与索引）。
    this.registerEvent(this.app.vault.on("create", (file) => {
      if (this.settings.templateAuditOnCreate !== true) return;
      if (!(file instanceof TFile)) return;
      if (String(file.extension || "").toLowerCase() !== "md") return;
      if (!this.isInTemplateScope(file)) return;
      this.scheduleTemplateAudit(file);
    }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (!(file instanceof TFile)) return;
      if (String(file.extension || "").toLowerCase() !== "md") return;
      if (this.templateAudits && this.templateAudits.has(file)) {
        this.scheduleTemplateAudit(file);
        return;
      }
      if (this.settings.templateAuditOnCreate === true && this.isInTemplateScope(file)) {
        if (!oldPath || !this.isInTemplateScope({ path: oldPath })) this.scheduleTemplateAudit(file);
      }
    }));

    this.app.workspace.onLayoutReady(() => {
      this.layoutReady = true;
      this.startObserver();
      this.scheduleInjection();
      this.scheduleTagCatalogRebuild(250);
      // 1.17：白名单目录写错（大小写不符、多空格、目录不存在）时全插件会静默空转，这里显式提示一次。
      for (const whitelistRoot of this.whitelistRoots()) {
        if (!this.app.vault.getAbstractFileByPath(whitelistRoot)) {
          new Notice(`xyblue135 私人·AI 元数据：白名单目录「${whitelistRoot}」不存在，该目录下的笔记不会被处理；请到设置里核对目录名`, 15000);
        }
      }
    });

    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.scheduleInjection()));
    this.registerEvent(this.app.workspace.on("layout-change", () => this.scheduleInjection()));

    // 方案B:sidecar 生命周期联动 —— 正文 新建/改名/删除 时同步 00_metadata 平铺文件。
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (!this.sidecarModeEnabled()) return;
      if (!(file instanceof TFile) || file.extension !== "md" || !this.isWhitelistedPath(oldPath)) return;
      const oldSidecar = this.sidecarFileForPath(oldPath);
      if (!(oldSidecar instanceof TFile)) return;
      const nextPath = this.sidecarPathFor(file);
      void this.app.fileManager.renameFile(oldSidecar, nextPath)
        .then(() => this.syncSidecarDocKey(file))
        .catch((error) => console.error("[metadata-ai] sidecar 重命名失败", error));
    }));
    this.registerEvent(this.app.vault.on("delete", (file) => {
      if (!this.sidecarModeEnabled()) return;
      if (!(file instanceof TFile) || file.extension !== "md" || !this.isWhitelisted(file)) return;
      const sidecar = this.sidecarFileFor(file);
      if (!sidecar) return;
      void Promise.resolve(this.app.vault.trash(sidecar, true))
        .catch((error) => console.error("[metadata-ai] sidecar 删除失败", error));
    }));
    this.registerEvent(this.app.vault.on("create", (file) => {
      if (!this.layoutReady || !this.sidecarModeEnabled()) return;
      if (!(file instanceof TFile) || file.extension !== "md" || !this.isWhitelisted(file)) return;
      // 延迟一拍：等模板补全把正文 frontmatter 写完；ensureSidecar 幂等。
      window.setTimeout(() => {
        void this.ensureSidecar(file).catch((error) => console.error("[metadata-ai] sidecar 创建失败", error));
      }, 2500);
    }));
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (file instanceof TFile && file.extension === "md" && this.isWhitelisted(file)) {
        // 普通编辑只刷新运行期 Tag Catalog；不记录时间戳/日志，也不写 data.json。
        this.scheduleTagCatalogRebuild(1200);
      }
    }));

    this.registerEvent(this.app.vault.on("create", (file) => {
      if (file instanceof TFile && file.extension === "md" && this.isWhitelisted(file)) {
        this.scheduleTagCatalogRebuild(1200);
      }
    }));

    this.registerEvent(this.app.vault.on("delete", (file) => {
      // 1.16：文件夹删除只会发一次 delete 事件：必须按前缀批量清理，
      // 否则子笔记在 state.files 里的记录会变成永久孤儿（日志页一直列已不存在的路径）。
      const prefix = file && file.path ? file.path : "";
      let removed = false;
      if (prefix) {
        for (const key of Object.keys(this.state.files)) {
          if (key === prefix || key.startsWith(`${prefix}/`)) {
            delete this.state.files[key];
            removed = true;
          }
        }
      }
      if (removed) this.scheduleStateSave();
      this.scheduleTagCatalogRebuild(800);
    }));

    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      // 1.16：文件夹重命名同样只发一次事件：按前缀迁移整棵子树的状态记录，
      // 否则改名后旧路径变孤儿、新路径被当作「未处理」全部重跑。
      const from = oldPath || "";
      const to = file && file.path ? file.path : "";
      let migrated = false;
      if (from && to && from !== to) {
        for (const key of Object.keys(this.state.files)) {
          if (key === from || key.startsWith(`${from}/`)) {
            const nextKey = to + key.slice(from.length);
            this.state.files[nextKey] = this.state.files[key];
            if (nextKey !== key) delete this.state.files[key];
            migrated = true;
          }
        }
      }
      if (migrated) this.scheduleStateSave();
      this.scheduleInjection();
      this.scheduleTagCatalogRebuild(800);
    }));

    // 监听 metadata cache 变化，用于捕获 Obsidian 解析完成后的 Tag 修改。
    if (this.app.metadataCache && typeof this.app.metadataCache.on === "function") {
      this.registerEvent(this.app.metadataCache.on("changed", (file) => {
        if (file instanceof TFile && file.extension === "md" && this.isWhitelisted(file)) {
          this.scheduleTagCatalogRebuild(500);
        }
      }));
    }

    // 「自动生成 AI 信息」右键入口已按要求移除（生成一律走属性行的 ✨ 按钮 / 命令面板）。
  }

  onunload() {
    if (this.observer) this.observer.disconnect();
    this.observer = null;
    if (this.injectTimer !== null) window.clearTimeout(this.injectTimer);
    if (this.catalogTimer !== null) window.clearTimeout(this.catalogTimer);
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
      // 1.3：设置文本改为防抖落盘后，卸载/重载时可能还有一次未执行的保存，这里立刻补一次，
      // 避免「刚改完设置就重载插件」导致改动丢失。
      void this.saveAllData().catch((error) => console.error("[metadata-ai] 卸载前保存失败", error));
    }
    this.unloading = true;
    this.lifecycleToken += 1;
    if (this.autoTimeoutId !== null) window.clearTimeout(this.autoTimeoutId);
    this.autoTimeoutId = null;
    this.nextAutoRunAt = 0;
    if (this.autoRunController) {
      try { this.autoRunController.abort(); } catch (_) {}
      this.autoRunController = null;
    }
    for (const req of this.activeHttpRequests || []) {
      try { req.destroy(new Error("Obsidian/plugin closed")); } catch (_) {}
    }
    if (this.activeHttpRequests) this.activeHttpRequests.clear();
    document.querySelectorAll(".ai-metadata-property-button, .ai-metadata-check-button").forEach((el) => el.remove());
    document.querySelectorAll(".ai-metadata-enabled-row").forEach((el) => el.removeClass("ai-metadata-enabled-row"));
  }

  loadPersistedFileState(savedFiles) {
    const files = {};
    // 内容指纹已下线（contentFingerprintEnabled 在 onload 恒为 false），不再读写各类 last*Hash。
    for (const [path, source] of Object.entries(savedFiles || {})) {
      if (!source || typeof source !== "object") continue;
      const record = {};
      for (const key of ["lastError", "lastErrorType", "lastRawModelOutput"]) {
        if (typeof source[key] === "string" && source[key]) record[key] = source[key];
      }
      if (Object.keys(record).length) files[path] = record;
    }
    return files;
  }

  buildPersistedState() {
    const files = {};
    // 内容指纹已下线（contentFingerprintEnabled 在 onload 恒为 false），不再读写各类 last*Hash。
    for (const [path, source] of Object.entries(this.state.files || {})) {
      if (!source || typeof source !== "object") continue;
      const record = {};
      for (const key of ["lastError", "lastErrorType", "lastRawModelOutput"]) {
        if (typeof source[key] === "string" && source[key]) record[key] = source[key];
      }
      if (Object.keys(record).length) files[path] = record;
    }
    return { files, logs: this.state.logs || [] };
  }

  // 字段 kind ↔ 完成度标志名 ↔ 类别名，三处共用一份映射，避免再出现「漏了 Take / QA」这类不一致。
  completionFlagForKind(kind) {
    const map = {
      ai_title: "titleDone",
      tags: "tagsDone",
      summary_short: "summaryShortDone",
      summary_long: "summaryLongDone",
      technical_depth: "technicalDepthDone",
      take: "takeDone",
      qa: "qaDone",
    };
    return map[kind] || "";
  }

  // 返回该笔记「键不存在」的字段列表（按 METADATA_KINDS 固定顺序）。
  // 1.2：先读磁盘原文解析 frontmatter，再回退 metadataCache。
  // 缓存未就绪时 getFileCache 为 null，若直接用空对象判断，7 项会被当成「全缺」，
  // 随后「运行前清空本次字段」就会把本来完好的 AI_* 覆盖掉（请求失败则永久变空）。
  async getPendingKinds(file) {
    let rawFrontmatter = null;
    try {
      rawFrontmatter = this.parseFrontmatterFromRaw(await this.readAiSourceRaw(file));
    } catch (error) {
      rawFrontmatter = null;
    }
    const completion = this.getMetadataCompletion(file, "", rawFrontmatter);
    return METADATA_KINDS.filter((kind) => !completion[this.completionFlagForKind(kind)]);
  }

  // ==================== 运行日志与报错（设置页「目录更新管理 → 日志与报错」） ====================
  // 只记录插件自身的运行结果与错误摘要，不记录笔记正文。
  // 存储：state.logs（持久化到 data.json），条数受 settings.logMaxEntries 限制，
  // 时间上受 settings.logRetentionDays 限制（超期条目由 pruneLogs() 清理）。

  appendLog(level, message, detail = {}) {
    if (!this.state) return null;
    if (!Array.isArray(this.state.logs)) this.state.logs = [];
    const entry = {
      at: Date.now(),
      level: String(level || "info"),
      message: String(message ?? "").slice(0, 2000),
      file: detail.filePath ? String(detail.filePath) : "",
      phase: detail.phase ? String(detail.phase) : "",
      errorType: detail.errorType ? String(detail.errorType) : "",
      raw: detail.raw ? String(detail.raw).slice(0, 4000) : "",
    };
    this.state.logs.push(entry);
    this.trimLogs();
    if (this.saveTimer !== undefined) this.scheduleStateSave();
    return entry;
  }

  trimLogs() {
    const logs = Array.isArray(this.state?.logs) ? this.state.logs : [];
    const cap = Math.max(20, Math.min(2000, Number(this.settings.logMaxEntries) || 300));
    if (logs.length > cap) logs.splice(0, logs.length - cap);
    return logs.length;
  }

  // 按保留天数清理；返回删除条数。logRetentionDays <= 0 表示不按时间清理。
  pruneLogs() {
    const days = Number(this.settings?.logRetentionDays);
    const logs = Array.isArray(this.state?.logs) ? this.state.logs : [];
    if (!Number.isFinite(days) || days <= 0 || !logs.length) {
      this.trimLogs();
      return 0;
    }
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const kept = logs.filter((entry) => Number(entry && entry.at) >= cutoff);
    const removed = logs.length - kept.length;
    this.state.logs = kept;
    this.trimLogs();
    if (removed && this.saveTimer !== undefined) this.scheduleStateSave();
    return removed;
  }

  clearLogs() {
    const count = Array.isArray(this.state?.logs) ? this.state.logs.length : 0;
    this.state.logs = [];
    if (this.saveTimer !== undefined) this.scheduleStateSave();
    return count;
  }

  formatLogTime(at) {
    const d = new Date(Number(at) || 0);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  // 把一条日志整理成可粘贴的纯文本（供「复制」按钮使用）。
  formatLogEntryForCopy(entry) {
    const lines = [`[${this.formatLogTime(entry && entry.at)}] ${String((entry && entry.level) || "info").toUpperCase()}`];
    const where = [entry && entry.phase, entry && entry.errorType].filter(Boolean).join(" / ");
    if (where) lines.push(`阶段/类型：${where}`);
    if (entry && entry.file) lines.push(`文件：${entry.file}`);
    lines.push(`消息：${String((entry && entry.message) || "")}`);
    if (entry && entry.raw) lines.push("", "模型原始输出：", String(entry.raw));
    return lines.join("\n");
  }

  // 复制到剪贴板（优先 navigator.clipboard，失败则回退到临时 textarea）。
  async copyTextToClipboard(text) {
    const value = String(text ?? "");
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(value);
        return true;
      }
    } catch (_) {
      // 回退方案
    }
    try {
      const area = document.createElement("textarea");
      area.value = value;
      area.setAttribute("style", "position:fixed;left:-9999px;top:0;");
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch (_) {
      return false;
    }
  }

  // 按笔记汇总「上次错误」（来自 state.files，与日志互为补充：
  // 即使日志被清理，每篇笔记的最后一次错误仍然留在这里）。
  getFileErrorSummary() {
    const rows = [];
    for (const [path, record] of Object.entries(this.state?.files || {})) {
      if (!record || typeof record !== "object" || !record.lastError) continue;
      rows.push({
        path,
        lastError: record.lastError,
        lastErrorType: record.lastErrorType || "",
        lastRawModelOutput: record.lastRawModelOutput || "",
      });
    }
    rows.sort((a, b) => a.path.localeCompare(b.path, "zh-CN"));
    return rows;
  }

  getLogStats() {
    const logs = Array.isArray(this.state?.logs) ? this.state.logs : [];
    const byLevel = {};
    for (const entry of logs) {
      const level = String((entry && entry.level) || "info");
      byLevel[level] = (byLevel[level] || 0) + 1;
    }
    return {
      total: logs.length,
      byLevel,
      errors: byLevel.error || 0,
      warns: byLevel.warn || 0,
      fileErrors: this.getFileErrorSummary().length,
      maxEntries: Math.max(20, Math.min(2000, Number(this.settings.logMaxEntries) || 300)),
      retentionDays: Number(this.settings.logRetentionDays) || 0,
    };
  }

  async saveAllData() {
    // 1.3：串行化：同时只允许一个写盘任务。并发调用会把内容标记为“脏”，
    // 由当前任务结束后按最新内容再排一次，避免写入顺序反转导致磁盘留存旧 payload。
    if (this.savePromise) {
      this.saveDirty = true;
      return this.savePromise;
    }
    const payload = { settings: this.settings, state: this.buildPersistedState() };
    const signature = JSON.stringify(payload);
    if (signature === this.lastPersistedDataSignature) return false;
    this.saveDirty = false;
    this.savePromise = this.saveData(payload)
      .then(() => {
        // 写入成功后才回写签名，保证签名与磁盘实际内容一致，不会出现“改完没保存”。
        this.lastPersistedDataSignature = signature;
        return true;
      })
      .finally(() => {
        this.savePromise = null;
        if (this.saveDirty) this.scheduleStateSave(0);
      });
    return this.savePromise;
  }

  scheduleStateSave(delay = 400) {
    // 1.4：卸载/重载过程中不再为已卸载的实例排队写盘任务
    if (this.unloading) return;
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      // 1.4：写盘失败必须显式暴露，不能变成未捕获的 Promise 拒绝
      void this.saveAllData().catch((error) => {
        console.error("[metadata-ai] 保存失败", error);
        new Notice("AI 元数据：设置/状态保存失败，请稍后重试");
      });
    }, delay);
  }


  ensureLifecycleActive() {
    if (this.unloading) throw new Error("插件正在卸载，本次 AI 结果不会写入");
  }

  ensureTaskActive(signal = null) {
    this.ensureLifecycleActive();
    if (signal && signal.aborted) throw new TaskCancelledError();
  }

  isPathInsideFolder(filePath, folderPath) {
    const path = String(filePath || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    const folder = this.normalizeFolderPath(folderPath);
    return !!path && path.startsWith(`${folder}/`);
  }

  assertFileStillInFolder(file, folderPath) {
    const currentPath = file && file.path ? file.path : "";
    const currentFile = currentPath ? this.app.vault.getAbstractFileByPath(currentPath) : null;
    if (!(currentFile instanceof TFile) || currentFile !== file) {
      const error = new Error(`任务执行期间文件已删除或被替换：${currentPath || "未知路径"}`);
      error.code = "FILE_UNAVAILABLE";
      throw error;
    }
    if (!this.isPathInsideFolder(currentPath, folderPath)) {
      throw new FileLeftScopeError(currentPath, this.normalizeFolderPath(folderPath));
    }
  }

  stopPendingFolderRun(folderPath = null) {
    const run = this.manualFolderRun;
    if (!run || !run.controller || run.controller.signal.aborted) return false;
    if (folderPath && this.normalizeFolderPath(folderPath) !== run.folder) return false;
    run.controller.abort();
    this.setRuntimeStatus("stopping", { phase: `停止 ${run.folder}` });
    return true;
  }

  setRuntimeStatus(mode, data = {}) {
    this.runtimeStatus = Object.assign({ mode }, data);
    this.refreshStatusBar();
  }

  formatRemaining(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    if (minutes > 0) return `${minutes}:${String(seconds).padStart(2, "0")}`;
    return `${seconds}s`;
  }

  getStatusBarTooltip() {
    const status = this.runtimeStatus || { mode: "idle" };
    const timeout = Math.max(1, Number(this.settings.requestTimeoutSeconds) || 180);
    const gap = Math.max(0, Number(this.settings.requestIntervalSeconds) || 30);
    const combinedMode = this.settings.experimentalCombinedRequestEnabled === true ? "实验合并：开" : "实验合并：关";
    const lines = [`xyblue135 私人·AI 元数据 · 超时 ${timeout}s · 请求间隔 ${gap}s · ${combinedMode}`];
    if (status.filePath) lines.push(`当前：${status.filePath}`);
    if (status.phase) lines.push(`阶段：${status.phase}`);
    if (this.lastCycleSummary) lines.push(this.lastCycleSummary);
    lines.push("模式：仅手动更新（无自动定时任务）");
    return lines.join("\n");
  }

  refreshStatusBar() {
    if (!this.statusBarItem) return;
    const enabled = this.settings.statusBarEnabled !== false;
    // 每秒 ticker 会反复调到这里：只有显隐状态真的变了才碰 DOM，
    // 否则每秒都 toggleClass 一次是纯浪费（会触发样式重算）。
    if (this._statusHidden !== !enabled) {
      this.statusBarItem.toggleClass("is-hidden", !enabled);
      this._statusHidden = !enabled;
    }
    if (!enabled) {
      this._statusText = null;
      this._statusTooltip = null;
      return;
    }

    const status = this.runtimeStatus || { mode: "idle" };
    let text = "AI：空闲";
    const progress = status.progress && Number.isFinite(status.progress.index)
      ? `${status.progress.index}/${status.progress.total} `
      : "";
    const name = status.filePath ? status.filePath.split("/").pop() : "";

    if (status.mode === "requesting") {
      text = `AI：${progress}${status.phase || "请求"}${name ? ` · ${name}` : ""}`;
    } else if (status.mode === "waiting") {
      const remaining = Math.max(0, Number(status.waitUntil || 0) - Date.now());
      text = `AI：等待 ${this.formatRemaining(remaining)} → ${status.phase || "下一请求"}${name ? ` · ${name}` : ""}`;
    } else if (status.mode === "writing") {
      text = `AI：${progress}写入 ${status.phase || "metadata"}${name ? ` · ${name}` : ""}`;
    } else if (status.mode === "error") {
      text = `AI：失败${name ? ` · ${name}` : ""}`;
    } else if (status.mode === "stopping") {
      text = "AI：正在停止…";
    } else if (this.autoRunning) {
      if (this.cycleMode === "manual-folder") text = "AI：文件夹同步中";
      else if (this.cycleMode === "manual-full") text = "AI：手动扫描处理中";
      else text = "AI：自动扫描中";
    } else {
      text = "AI：仅手动模式";
    }

    // 文本与 tooltip 都没变就不写 DOM。空闲时每秒一次 setText + 两次 setAttribute
    // 会让状态栏持续重排；「等待」模式下剩余秒数在变，仍会照常刷新。
    const tooltip = this.getStatusBarTooltip();
    if (this._statusText === text && this._statusTooltip === tooltip) return;
    this._statusText = text;
    this._statusTooltip = tooltip;

    this.statusBarItem.setText(text);
    this.statusBarItem.setAttribute("aria-label", tooltip);
    this.statusBarItem.setAttribute("title", tooltip);
  }

  async waitForApiGap(context = {}) {
    this.ensureTaskActive(context.abortSignal);
    // 「每次生成完成后到下一个之间的等待时间」统一取全局设置 requestIntervalSeconds（默认 30 秒）。
    // 所有流程（批量识别、单篇补全、✨ 单字段、巡检修复、缺失补全）共用这一个值。
    const gapMs = Math.max(0, Number(this.settings.requestIntervalSeconds) || 0) * 1000;
    if (!this.lastApiCompletedAt || gapMs <= 0) return;
    const waitMs = this.lastApiCompletedAt + gapMs - Date.now();
    if (waitMs <= 0) return;
    const waitUntil = Date.now() + waitMs;
    this.setRuntimeStatus("waiting", { ...context, waitUntil });
    await this.sleep(waitMs, context.abortSignal);
    this.ensureTaskActive(context.abortSignal);
  }

  enqueueApiRequest(task, context = {}) {
    const run = async () => {
      this.ensureTaskActive(context.abortSignal);
      await this.waitForApiGap(context);
      this.ensureTaskActive(context.abortSignal);
      // 间隔等待结束后、请求真正发出之前再校验一次正文指纹。
      // 校验失败会直接抛出：既不发送请求，也不推进 lastApiCompletedAt。
      await this.assertSourceUnchangedBeforeRequest(context);
      this.setRuntimeStatus("requesting", context);
      try {
        return await task();
      } finally {
        this.lastApiCompletedAt = Date.now();
      }
    };
    const result = this.apiQueue.then(run, run);
    this.apiQueue = result.catch(() => undefined);
    return result;
  }

  normalizeWhitelistFolder() {
    return this.whitelistRoots()[0];
  }

  // 多根白名单：逗号/中文逗号/换行分隔（如 00_docs,00_agent_for_projects）。
  whitelistRoots() {
    const roots = String(this.settings.whitelistFolder || "my_blog/00_docs")
      .split(/[,，\n]/)
      .map((item) => item.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""))
      .filter(Boolean);
    return roots.length ? roots : ["my_blog/00_docs"];
  }

  isWhitelisted(file) {
    if (!(file instanceof TFile) || file.extension !== "md") return false;
    // 1.17：Windows 路径不区分大小写，而 file.path 用的是磁盘真实大小写：
    // 统一转小写再比较，避免白名单写成 00_Docs 时整个插件静默空转。
    const path = file.path.toLocaleLowerCase();
    return this.whitelistRoots().some((root) => path.startsWith(`${root.toLocaleLowerCase()}/`));
  }

  getNotesFiles() {
    return this.app.vault.getMarkdownFiles().filter((file) => this.isWhitelisted(file));
  }

  getMetadataStatus(file) {
    // 00_metadata 单点模式:status 在 sidecar frontmatter 里;legacy 模式仍读正文。
    const statusFile = this.sidecarModeEnabled() ? this.sidecarFileFor(file) : file;
    const cache = statusFile ? this.app.metadataCache.getFileCache(statusFile) : null;
    // 1.19：metadataCache 尚未解析完成时是 null：这是「未知」而不是「status 未设置」，
    // 否则开启「仅 status: done」后所有笔记都会被判为未完成。
    if (!cache) return null;
    const value = cache.frontmatter?.status;
    // 0.8.0：值内嵌状态灯（🟢 done / 🔴 undone，与 AI_freshness 同风格）——比较前剥掉灯。
    const stripLight = (s) => String(s ?? "").trim().replace(/^[🟢🔴🟡⚪]\s*/u, "").toLocaleLowerCase("en-US");
    if (Array.isArray(value)) {
      return value.length ? stripLight(value[0]) : "";
    }
    return stripLight(value);
  }

  isRecognitionEligible(file) {
    if (!this.isWhitelisted(file)) return false;
    if (this.settings.statusDoneOnlyEnabled !== true) return true;
    const status = this.getMetadataStatus(file);
    // 1.19：缓存未就绪时先放行，交给 assertRecognitionEligible / 巡检阶段给出明确提示
    if (status === null) return true;
    return status === "done";
  }

  getRecognitionFiles() {
    return this.getNotesFiles().filter((file) => this.isRecognitionEligible(file));
  }

  assertRecognitionEligible(file) {
    if (this.settings.statusDoneOnlyEnabled !== true) return;
    const status = this.getMetadataStatus(file);
    if (status === null) {
      const error = new Error("元数据缓存尚未就绪（Obsidian 还在解析笔记），请稍后重试");
      error.code = "META_CACHE_NOT_READY";
      throw error;
    }
    if (status === "done") return;
    const error = new Error(`文章 status 当前为 ${status || "未设置"}，已按规则跳过`);
    error.code = "STATUS_NOT_DONE";
    throw error;
  }

  startObserver() {
    if (this.observer) return;
    this.observer = new MutationObserver(() => this.scheduleInjection());
    this.observeWorkspace();
    this.register(() => this.observer && this.observer.disconnect());
  }

  scheduleInjection() {
    const now = Date.now();
    // 连续输入时 80ms 防抖会被不断重置，导致 ✨ 按钮长时间不出现：最多等 600ms 就强制执行一次。
    const pendingSince = this.injectPendingSince || now;
    this.injectPendingSince = pendingSince;
    const forceNow = now - pendingSince >= 600;
    if (this.injectTimer !== null) window.clearTimeout(this.injectTimer);
    this.injectTimer = window.setTimeout(() => {
      this.injectTimer = null;
      this.injectPendingSince = 0;
      this.injectButtons();
    }, forceNow ? 0 : 80);
  }

  clearInjectedButtons(scope = null) {
    // 1.20：scope 为空时沿用旧行为的全文档清理；分屏场景由调用方传入具体 leaf。
    const root = scope || document;
    root.querySelectorAll(".ai-metadata-property-button, .ai-metadata-check-button").forEach((el) => el.remove());
    root.querySelectorAll(".ai-metadata-enabled-row").forEach((el) => el.removeClass("ai-metadata-enabled-row"));
  }

  injectButtons() {
    // 1.18：注入本身会改动 DOM 并再次触发 MutationObserver：注入期间先断开，结束后重新观察，
    // 否则每注入一次就再触发一轮全文档扫描（编辑/滚动时表现为周期性卡顿）。
    if (this.observer) this.observer.disconnect();
    try {
      this.injectButtonsIntoActiveLeaf();
    } finally {
      this.observeWorkspace();
    }
  }

  injectButtonsIntoActiveLeaf() {
    const file = this.app.workspace.getActiveFile();
    // 1.20：只看活动 leaf：非白名单文件时只清理活动 leaf 的按钮，
    // 分屏时另一个窗格里已注入的按钮必须保留。
    const scope = document.querySelector(".workspace-leaf.mod-active") || document;
    if (!(file instanceof TFile) || !this.isWhitelisted(file)) {
      if (scope !== document) this.clearInjectedButtons(scope);
      return;
    }
    if (this.sidecarModeEnabled()) {
      scope.querySelectorAll(".ai-metadata-property-button, .ai-metadata-check-button").forEach((el) => el.remove());
      scope.querySelectorAll(".ai-metadata-enabled-row").forEach((el) => el.removeClass("ai-metadata-enabled-row"));
      return; // 00_metadata 单点:文章不注入任何面板,元数据看 sidecar 原生属性
    }

    // 只在活动 leaf 内清理失去宿主行的按钮：原来用 document 全量删除，
    // 分屏时会把另一个窗格里白名单笔记上已注入的按钮一并删掉。
    scope.querySelectorAll(".ai-metadata-property-button, .ai-metadata-check-button").forEach((button) => {
      const row = button.closest(".metadata-property");
      if (!row || !scope.contains(row)) button.remove();
    });
    ["summary_short", "summary_long", "tags", "technical_depth", "take", "qa", "ai_title", "freshness", "freshness_note", "last_verified"].forEach((kind) => {
      const rows = this.findPropertyRows(kind, scope);
      rows.forEach((row) => {
        const aiLabel = kind === "summary_short"
          ? "AI 只生成 AI_summary_short"
          : kind === "summary_long"
            ? "AI 只生成 AI_summary_long"
            : kind === "tags"
              ? "AI 只生成 weighted tags"
              : kind === "technical_depth"
                ? "AI 只评估 AI_technical_depth"
                : kind === "take"
                  ? "AI 只生成客观评价 AI_take"
                  : kind === "qa"
                    ? "AI 只生成面试问答 AI_qa"
                    : kind === "freshness"
                      ? "AI 评估时效性（同时写入 AI_freshness_note 与 AI_last_verified）"
                      : kind === "freshness_note"
                        ? "AI 生成时效性说明 AI_freshness_note（与 AI_freshness / AI_last_verified 同一次生成）"
                        : "AI 只生成参考标题 AI_title";
        row.addClass("ai-metadata-enabled-row");

        // ✨：调用 AI 生成该字段（原行为不变）。
        // v0.7.4：AI_freshness_note 这一行也开放 ✨ 按钮 —— 此前只有 AI_freshness 那行有按钮，
        // 用户反馈「AI_freshness_note 没有 AI 生成按钮」。时效性三键是同一次模型调用产出的，
        // 所以点 note 行的 ✨ 走的就是同一次 Freshness 生成，AI_freshness / AI_freshness_note /
        // AI_last_verified 会一起更新（按钮提示文案已写明，避免误以为是单字段生成）。
        // AI_last_verified 是插件自动写本地时间戳，仍然不给按钮。
        if (kind !== "last_verified" && !row.querySelector(`.ai-metadata-property-button[data-ai-kind="${kind}"]`)) {
          const button = row.createEl("button", {
            cls: "ai-metadata-property-button clickable-icon",
            attr: { "aria-label": aiLabel, "data-ai-kind": kind, type: "button" },
          });
          setIcon(button, "sparkles");
          button.addEventListener("mousedown", (event) => {
            event.preventDefault();
            event.stopPropagation();
          });
          button.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            void this.generateForActiveFile(kind, button);
          });
        }

        // ✓：紧跟在 ✨ 右侧，只做本地正则格式校验 —— 不调用 AI、不写盘、不改数据，只弹窗报告。
        if (!row.querySelector(`.ai-metadata-check-button[data-ai-check-kind="${kind}"]`)) {
          const checkButton = row.createEl("button", {
            cls: "ai-metadata-check-button clickable-icon",
            attr: {
              "aria-label": `格式校验：检查 ${this.fieldKeyForKind(kind)} 是否符合设置里的正则规则（纯本地，不调用 AI）`,
              "data-ai-check-kind": kind,
              type: "button",
            },
          });
          setIcon(checkButton, "shield-check");
          checkButton.addEventListener("mousedown", (event) => {
            event.preventDefault();
            event.stopPropagation();
          });
          checkButton.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            this.checkFormatForActiveFile(kind);
          });
        }
      });
    });

    // v0.8.0：4 个工作流字段（status/visibility/updated/token_count）只上 ✓ 格式校验，不给 ✨ 生成按钮。
    ["status", "visibility", "updated", "token_count"].forEach((kind) => {
      this.findPropertyRows(kind, scope).forEach((row) => {
        row.addClass("ai-metadata-enabled-row");
        if (!row.querySelector(`.ai-metadata-check-button[data-ai-check-kind="${kind}"]`)) {
          const checkButton = row.createEl("button", {
            cls: "ai-metadata-check-button clickable-icon",
            attr: {
              "aria-label": `格式校验：检查 ${this.fieldKeyForKind(kind)} 是否符合设置里的正则规则（纯本地，不调用 AI）`,
              "data-ai-check-kind": kind,
              type: "button",
            },
          });
          setIcon(checkButton, "shield-check");
          checkButton.addEventListener("mousedown", (event) => {
            event.preventDefault();
            event.stopPropagation();
          });
          checkButton.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            this.checkFormatForActiveFile(kind);
          });
        }
      });
    });
  }

  // 1.18：只观察工作区容器，缩小扫描范围；注入期间会临时 disconnect，结束后用它恢复观察。
  observeWorkspace() {
    if (!this.observer) return;
    const root = document.querySelector(".workspace") || document.body;
    this.observer.observe(root, { childList: true, subtree: true });
  }

  fieldKeyForKind(kind) {
    const map = {
      summary_short: "AI_summary_short",
      summary_long: "AI_summary_long",
      tags: "AI_tags",
      technical_depth: "AI_technical_depth",
      take: "AI_take",
      qa: "AI_qa",
      ai_title: "AI_title",
      freshness: "AI_freshness",
      freshness_note: "AI_freshness_note",
      last_verified: "AI_last_verified",
    };
    return map[kind] || kind;
  }

  findPropertyRows(kind, scope = document) {
    const field = this.fieldKeyForKind(kind);
    const direct = Array.from(scope.querySelectorAll(`.metadata-property[data-property-key="${field}"]`));
    if (direct.length > 0) return direct;
    const rows = Array.from(scope.querySelectorAll(".metadata-property"));
    return rows.filter((row) => {
      const keyInput = row.querySelector(".metadata-property-key-input");
      const keyEl = row.querySelector(".metadata-property-key");
      const keyText = (keyInput && keyInput.value) || (keyEl && keyEl.innerText) || "";
      return keyText.trim() === field;
    });
  }

  // ==================== 格式校验（纯本地正则：不调用 AI、不写盘、不改数据） ====================

  // 逐字段与默认值合并，保证任何缺失项都回落到默认规则。
  // 不能整体覆盖 saved：旧 data.json 没有 formatChecks，整体覆盖会让 rules 变成 undefined。
  mergeFormatChecks(saved) {
    const merged = {};
    for (const kind of FORMAT_CHECK_KINDS) {
      const fallback = DEFAULT_FORMAT_CHECKS[kind] || { enabled: false, rules: "" };
      const incoming = (saved && typeof saved === "object") ? saved[kind] : null;
      const hasIncoming = incoming && typeof incoming === "object";
      merged[kind] = {
        enabled: hasIncoming && typeof incoming.enabled === "boolean"
          ? incoming.enabled
          : fallback.enabled !== false,
        rules: hasIncoming && typeof incoming.rules === "string"
          ? incoming.rules
          : fallback.rules,
      };
    }
    return merged;
  }

  getFormatCheckConfig(kind) {
    const config = (this.settings.formatChecks || {})[kind];
    if (config && typeof config === "object") return config;
    return DEFAULT_FORMAT_CHECKS[kind] || { enabled: false, rules: "" };
  }

  // 校验目标：把字段值转成固定形式的文本，正则就作用在这个文本上。
  // 数组字段（AI_title / AI_tags）每项占一行拼接，不加 "- " 前缀、不额外 trim，
  // 这样「每行必须《》包裹」「共几行」都能用普通正则表达。
  // frontmatterOverride：供「二次验证」用磁盘原文解析出的 frontmatter，绕开可能尚未刷新的 metadataCache。
  getFormatCheckTarget(kind, file, frontmatterOverride = null) {
    const fm = frontmatterOverride || this.aiFrontmatter(file);
    const key = this.fieldKeyForKind(kind);
    if (!Object.prototype.hasOwnProperty.call(fm, key)) return { present: false, text: "" };
    const value = fm[key];
    if (kind === "tags" || kind === "ai_title") {
      const items = Array.isArray(value)
        ? value
        : (value === null || value === undefined || value === "" ? [] : [value]);
      return { present: true, text: items.map((item) => String(item ?? "")).join("\n") };
    }
    if (value === null || value === undefined) return { present: true, text: "" };
    return { present: true, text: String(value) };
  }

  // 规则行语法：/表达式/标志（例：/^《.+》$/m）；也允许省略斜杠直接写表达式。
  // 以 # 开头的行是注释；空行忽略。正则本身写错不会抛错，会作为一条「失败」规则报告出来。
  parseFormatCheckRules(rulesText) {
    const rules = [];
    for (const rawLine of String(rulesText ?? "").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const match = /^\/(.*)\/([a-z]*)$/.exec(line);
      try {
        rules.push({ source: line, re: match ? new RegExp(match[1], match[2]) : new RegExp(line) });
      } catch (error) {
        rules.push({ source: line, re: null, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return rules;
  }

  runFormatCheck(kind, file) {
    const config = this.getFormatCheckConfig(kind);
    const target = this.getFormatCheckTarget(kind, file);
    const result = {
      kind,
      fieldKey: this.fieldKeyForKind(kind),
      present: target.present,
      text: target.text,
      targetDescription: FORMAT_CHECK_TARGETS[kind] || "",
      rules: [],
      passed: true,
      skipped: false,
      reason: "",
    };

    if (config.enabled === false) {
      result.skipped = true;
      result.reason = "该字段的格式校验已在设置里关闭";
      return result;
    }
    const rules = this.parseFormatCheckRules(config.rules);
    if (!rules.length) {
      result.skipped = true;
      result.reason = "没有配置任何校验规则";
      return result;
    }
    if (!target.present) {
      result.passed = false;
      result.reason = "字段不存在";
      return result;
    }

    for (const rule of rules) {
      if (!rule.re) {
        result.rules.push({ source: rule.source, ok: false, error: rule.error });
        result.passed = false;
        continue;
      }
      // 带 g / y 标志的正则带 lastIndex 状态，必须归零，否则第二次校验会从上次位置接着匹配。
      rule.re.lastIndex = 0;
      const ok = rule.re.test(target.text);
      rule.re.lastIndex = 0;
      result.rules.push({ source: rule.source, ok });
      if (!ok) result.passed = false;
    }
    return result;
  }

  checkFormatForActiveFile(kind) {
    const file = this.app.workspace.getActiveFile();
    if (!(file instanceof TFile) || file.extension !== "md") {
      new Notice("xyblue135 私人·AI 元数据：请先打开一个 Markdown 笔记");
      return;
    }
    if (!this.isWhitelisted(file)) {
      new Notice(`xyblue135 私人·AI 元数据：仅允许校验 /${this.normalizeWhitelistFolder()} 目录中的 Markdown`);
      return;
    }
    new FormatCheckModal(this.app, this, this.runFormatCheck(kind, file), file).open();
  }

  // ==================== 格式巡检（手动一次；不改数据，只报告） ====================
  // 只巡检白名单目录（并按 status: done 过滤），对 7 个字段跑各模块设置里的正则。
  // 三个类别：
  //   fail    = 字段有内容，但正则不通过（你重点关注的那类）
  //   empty   = 字段存在但值为空
  //   missing = 字段键不存在
  // 修复是「逐项、只改这一个字段」，修完只做一次二次验证，不重复运行。

  // 从磁盘原文解析 frontmatter 里的 7 个 AI 字段（支持普通标量、块标量、块序列、内联数组）。
  // 二次验证必须用磁盘原文：processFrontMatter 写完后 metadataCache 是异步刷新的，
  // 直接读缓存可能拿到旧值，导致「刚修好却报仍不通过」。
  parseAiFieldsFromRaw(raw) {
    const out = {};
    const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(raw || ""));
    if (!block) return out;
    const lines = block[1].split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const kv = /^([A-Za-z0-9_]+)\s*:\s*(.*)$/.exec(lines[i]);
      if (!kv || !kv[1].startsWith("AI_")) continue;
      const key = kv[1];
      const rest = kv[2].trim();
      if (rest === "") {
        // 可能是块序列（后续 "- 项"），也可能是空值
        const items = [];
        for (let k = i + 1; k < lines.length; k += 1) {
          const item = /^\s*-\s+(.*)$/.exec(lines[k]);
          if (!item) break;
          items.push(item[1].trim().replace(/^["']|["']$/g, ""));
        }
        out[key] = items.length ? items : null;
      } else if (/^[|>][-+]?\d*$/.test(rest)) {
        const body = [];
        for (let k = i + 1; k < lines.length; k += 1) {
          if (lines[k].trim() === "") { body.push(""); continue; }
          if (!/^\s/.test(lines[k])) break;
          body.push(lines[k].replace(/^ {2}/, ""));
        }
        while (body.length && body[body.length - 1] === "") body.pop();
        out[key] = body.join("\n");
      } else if (rest.startsWith("[")) {
        try {
          out[key] = JSON.parse(rest);
        } catch (_) {
          // 1.26：YAML 流式数组（如 AI_tags: [Docker, K8s]）不是合法 JSON。
          // 不能把整串塞进 out，否则二次验证会把 "[Docker, K8s]" 当成一个数组项去匹配正则。
          const inner = rest.endsWith("]") ? rest.slice(1, -1) : rest.slice(1);
          out[key] = inner
            .split(",")
            .map((item) => item.trim().replace(/^["']|["']$/g, ""))
            .filter(Boolean);
        }
      } else if (rest === '""' || rest === "''") {
        out[key] = "";
      } else {
        out[key] = rest.replace(/^["']|["']$/g, "");
      }
    }
    return out;
  }

  async runFormatInspection(options = {}) {
    const includeMissing = options.includeMissing !== false;
    const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
    const allFiles = this.getNotesFiles();
    const files = this.settings.statusDoneOnlyEnabled === true
      ? allFiles.filter((file) => this.isRecognitionEligible(file))
      : allFiles;
    const stats = {
      whitelistTotal: allFiles.length,
      scanned: 0,
      statusFiltered: Math.max(0, allFiles.length - files.length),
      statusFilterEnabled: this.settings.statusDoneOnlyEnabled === true,
      pass: 0,
      fail: 0,
      empty: 0,
      missing: 0,
      rulesSkipped: 0,
      filesWithIssue: 0,
      scannedAt: Date.now(),
    };
    const items = [];

    // 性能优化：每个字段的正则只解析一次。
    // 原来是在「每篇 × 每字段」里重复 parseFormatCheckRules → new RegExp，
    // 750 篇 × 7 字段 = 5000+ 次重复编译，这是巡检卡顿的主因。
    const compiled = new Map();
    for (const kind of FORMAT_CHECK_KINDS) {
      const config = this.getFormatCheckConfig(kind);
      if (config.enabled === false) {
        compiled.set(kind, { rules: [], skipped: true });
        continue;
      }
      const rules = this.parseFormatCheckRules(config.rules);
      compiled.set(kind, { rules, skipped: rules.length === 0 });
    }
    const fieldKeys = new Map(FORMAT_CHECK_KINDS.map((kind) => [kind, this.fieldKeyForKind(kind)]));

    for (const file of files) {
      stats.scanned += 1;
      if (onProgress && stats.scanned % 20 === 0) {
        onProgress({ scanned: stats.scanned, total: files.length, path: file.path });
      }
      const fm = this.aiFrontmatter(file);
      const isListField = (kind) => kind === "tags" || kind === "ai_title";
      let issues = 0;

      for (const kind of FORMAT_CHECK_KINDS) {
        const { rules, skipped } = compiled.get(kind);
        if (skipped) { stats.rulesSkipped += 1; continue; }

        const fieldKey = fieldKeys.get(kind);
        const present = Object.prototype.hasOwnProperty.call(fm, fieldKey);
        const raw = fm[fieldKey];
        let text = "";
        if (present) {
          if (isListField(kind)) {
            const list = Array.isArray(raw) ? raw : (raw === null || raw === undefined || raw === "" ? [] : [raw]);
            text = list.map((v) => String(v ?? "")).join("\n");
          } else {
            text = raw === null || raw === undefined ? "" : String(raw);
          }
        }

        if (!present) {
          if (!includeMissing) continue;
          stats.missing += 1; issues += 1;
          items.push({ file, path: file.path, kind, fieldKey, category: "missing", text: "", failedRules: [] });
          continue;
        }
        if (!text.trim()) {
          if (!includeMissing) continue;
          stats.empty += 1; issues += 1;
          items.push({ file, path: file.path, kind, fieldKey, category: "empty", text, failedRules: [] });
          continue;
        }

        const failed = [];
        for (const rule of rules) {
          if (!rule.re) { failed.push(`${rule.source}  ← 正则本身有错：${rule.error}`); continue; }
          rule.re.lastIndex = 0;
          const ok = rule.re.test(text);
          rule.re.lastIndex = 0;
          if (!ok) failed.push(rule.source);
        }
        if (!failed.length) { stats.pass += 1; continue; }
        stats.fail += 1; issues += 1;
        items.push({ file, path: file.path, kind, fieldKey, category: "fail", text, failedRules: failed });
      }
      if (issues) stats.filesWithIssue += 1;
    }
    if (onProgress) onProgress({ scanned: files.length, total: files.length, done: true });
    return { items, stats };
  }

  // 二次验证：从磁盘原文重新解析该字段并重跑一次正则。只做一次，不循环。
  async verifyRepairedItem(item) {
    const config = this.getFormatCheckConfig(item.kind);
    if (config.enabled === false) return { passed: true, skipped: true, reason: "该字段的格式校验已关闭" };
    const rules = this.parseFormatCheckRules(config.rules);
    if (!rules.length) return { passed: true, skipped: true, reason: "没有配置校验规则" };

    const source = this.aiSourceFileFor(item.file);
    if (!source) return { present: false, passed: false, reason: "元数据 sidecar 不存在", text: "" };
    const raw = await this.app.vault.read(source);
    const fm = this.parseAiFieldsFromRaw(raw);
    const target = this.getFormatCheckTarget(item.kind, item.file, fm);
    if (!target.present) return { present: false, passed: false, reason: "修复后字段仍不存在", text: "" };
    if (!target.text.trim()) return { present: true, passed: false, reason: "修复后字段仍为空", text: target.text };

    const failed = [];
    for (const rule of rules) {
      if (!rule.re) { failed.push(`${rule.source}  ← 正则本身有错`); continue; }
      rule.re.lastIndex = 0;
      const ok = rule.re.test(target.text);
      rule.re.lastIndex = 0;
      if (!ok) failed.push(rule.source);
    }
    return {
      present: true,
      passed: failed.length === 0,
      failedRules: failed,
      text: target.text,
      reason: failed.length ? `仍不通过：${failed.length} 条规则未匹配` : "通过",
    };
  }

  // 逐项 AI 修复 + 修完立刻二次验证。修完不再重跑，结果交给用户手动检查。
  async repairInspectionItems(items, onProgress = null) {
    const results = [];
    const controller = new AbortController();
    this.inspectionRun = controller;
    const total = items.length;
    try {
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        const progress = { index: index + 1, total, path: item.path, fieldKey: item.fieldKey };
        if (controller.signal.aborted) {
          results.push({ ...item, stopped: true });
          continue;
        }
        if (typeof onProgress === "function") onProgress({ phase: "processing", ...progress });

        let repairError = "";
        let after = null;
        try {
          this.fileBusy.add(item.path);
          // 只重新生成这一个字段，其它字段完全不动。
          // 请求间隔统一走全局「API 请求间隔」。
          await this.generateSelectedForFile(item.file, [item.kind], "format-repair", null, {
            abortSignal: controller.signal,
            respectStatusFilter: this.settings.statusDoneOnlyEnabled === true,
          });
          // 1.14：二次验证（唯一一次，不重复运行）放进本项的 try 里：
          // 单篇读盘失败只记为该篇失败，不会把整批静默打断。
          after = await this.verifyRepairedItem(item);
        } catch (error) {
          repairError = error instanceof Error ? error.message : String(error);
        } finally {
          this.fileBusy.delete(item.path);
        }

        const row = { ...item, repairError, after, repaired: Boolean(after && after.passed) };
        results.push(row);
        if (typeof onProgress === "function") {
          onProgress({
            phase: repairError ? "error" : (row.repaired ? "success" : "still-failing"),
            ...progress,
            message: repairError || (after && after.reason) || "",
          });
        }
      }
    } finally {
      if (this.inspectionRun === controller) this.inspectionRun = null;
      await this.saveAllData();
    }
    return results;
  }

  stopFormatInspection() {
    if (!this.inspectionRun) return false;
    try { this.inspectionRun.abort(); } catch (_) { /* ignore */ }
    return true;
  }

  // 「本次修复数量」：全选之后只取前 N 项。limit <= 0 或非法值表示不限。
  pickRepairItems(items, limit) {
    const list = Array.isArray(items) ? items : [];
    const n = Number(limit);
    if (!Number.isFinite(n) || n <= 0) return list.slice();
    return list.slice(0, n);
  }

  // ==================== 0.9.0 时效复检 ====================
  // 两类信号，只提示不改数据：
  //   1) 仓库笔记（frontmatter repo/upstream）：拉 GitHub API pushed_at 与 AI_last_verified 比
  //      （结果缓存 1 小时进 state，未认证配额 60 次/小时够用；403 时降级为部分结果）；
  //   2) 全部白名单文章：AI_last_verified 距今超过 recheckAgeDays 天（0 = 关闭年龄检测）。
  async collectRecheckItems() {
    const files = this.getNotesFiles();
    const now = Date.now();
    const items = [];
    let githubBlocked = false;
    const verToMs = (ver) => Number.isFinite(Date.parse(
      `${ver.slice(0, 4)}-${ver.slice(4, 6)}-${ver.slice(6, 8)}T${ver.slice(8, 10)}:${ver.slice(10, 12)}:${ver.slice(12, 14)}Z`
    )) ? Date.parse(`${ver.slice(0, 4)}-${ver.slice(4, 6)}-${ver.slice(6, 8)}T${ver.slice(8, 10)}:${ver.slice(10, 12)}:${ver.slice(12, 14)}Z`) : NaN;
    for (const file of files) {
      const fm = this.aiFrontmatter(file);
      const slugs = [fm.repo, fm.upstream].map((s) => String(s || "").trim()).filter(Boolean);
      if (!slugs.length) continue;
      const ver = String(fm.AI_last_verified || "").trim();
      const verMs = /^\d{17}$/.test(ver) ? verToMs(ver) : NaN;
      for (const slug of slugs) {
        try {
          const pushedAt = await this.fetchGithubPushedAt(slug);
          if (!pushedAt) continue;
          const pushMs = Date.parse(pushedAt);
          if (Number.isFinite(pushMs) && (!Number.isFinite(verMs) || pushMs > verMs)) {
            items.push({
              file,
              urgent: true,
              reason: `仓库 ${slug} 推送于 ${String(pushedAt).slice(0, 10)}，晚于当前核验${Number.isFinite(verMs) ? `（${new Date(verMs).toISOString().slice(0, 10)}）` : "（从未核验）"}`,
            });
          }
        } catch (e) {
          if (String(e.message || "").includes("403")) githubBlocked = true;
        }
        if (githubBlocked) break;
      }
      if (githubBlocked) break;
    }
    if (githubBlocked) {
      new Notice("xyblue135 私人·AI 元数据：GitHub API 限流（未认证 60 次/小时），仓库活动检测只完成了一部分；已缓存的部分下次复用", 8000);
    }
    const days = Number(this.settings.recheckAgeDays);
    if (Number.isFinite(days) && days > 0) {
      const threshold = now - days * 86400000;
      const listed = new Set(items.map((it) => it.file.path));
      for (const file of files) {
        if (listed.has(file.path)) continue;
        const fm = this.aiFrontmatter(file);
        const ver = String(fm.AI_last_verified || "").trim();
        if (!/^\d{17}$/.test(ver)) continue;
        const verMs = verToMs(ver);
        if (Number.isFinite(verMs) && verMs < threshold) {
          items.push({ file, urgent: false, reason: `AI_last_verified 已 ${Math.floor((now - verMs) / 86400000)} 天未更新（阈值 ${days} 天）` });
        }
      }
    }
    items.sort((a, b) => (b.urgent ? 1 : 0) - (a.urgent ? 1 : 0));
    return items.slice(0, 50);
  }

  async fetchGithubPushedAt(slug) {
    const cache = (this.state.githubPushedAt = this.state.githubPushedAt || {});
    const hit = cache[slug];
    if (hit && Date.now() - hit.at < 3600000) return hit.pushed_at;
    const data = await this.githubApiJson(`repos/${slug}`);
    cache[slug] = { at: Date.now(), pushed_at: String(data.pushed_at || "") };
    this.scheduleStateSave();
    return cache[slug].pushed_at;
  }

  githubApiJson(path) {
    return new Promise((resolve, reject) => {
      const req = require("https").get(
        { hostname: "api.github.com", path: `/${path}`, headers: { "User-Agent": "obsidian-metadata-ai", Accept: "application/vnd.github+json" }, timeout: 15000 },
        (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => {
            if (res.statusCode !== 200) {
              reject(new Error(`GitHub API ${res.statusCode}${res.statusCode === 403 ? "（限流）" : ""}`));
              return;
            }
            try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
          });
        }
      );
      req.on("timeout", () => req.destroy(new Error("GitHub API 超时")));
      req.on("error", reject);
    });
  }

  async openFreshnessRecheck() {
    if (this._recheckBusy) { new Notice("xyblue135 私人·AI 元数据：正在复检中，请稍候"); return; }
    this._recheckBusy = true;
    try {
      const items = await this.collectRecheckItems();
      new FreshnessRecheckModal(this.app, this, items).open();
    } catch (e) {
      new Notice("xyblue135 私人·AI 元数据：时效复检失败 — " + e.message, 8000);
    } finally {
      this._recheckBusy = false;
    }
  }

  // ==================== 0.9.0 定期巡检 ====================
  armPeriodicInspection() {
    if (this._inspectInterval) {
      window.clearInterval(this._inspectInterval);
      this._inspectInterval = null;
    }
    const hours = Number(this.settings.autoInspectionHours);
    if (!Number.isFinite(hours) || hours < 0.1) return;
    this._inspectInterval = this.registerInterval(window.setInterval(() => {
      if (this._periodicInspecting) return;
      void this.runPeriodicInspection();
    }, Math.round(hours * 3600 * 1000)));
  }

  async runPeriodicInspection() {
    if (this._periodicInspecting) return;
    this._periodicInspecting = true;
    try {
      const result = await this.runFormatInspection({});
      const s = result.stats || {};
      const issues = (result.items || []).length;
      if (issues > 0) {
        new Notice(`元数据巡检：发现 ${issues} 项待处理（缺 ${s.missing || 0} / 空 ${s.empty || 0} / 格式错 ${s.fail || 0}），用「格式巡检」命令查看`, 10000);
      } else {
        new Notice(`元数据巡检：${s.scanned || 0} 篇全部合格 ✅`);
      }
    } catch (e) {
      // 后台任务静默失败，避免打扰
    } finally {
      this._periodicInspecting = false;
    }
  }

  openFormatInspection() {
    new FormatInspectionModal(this.app, this).open();
  }

  // ==================== 缺失元数据补全 / 顺序修正（子模块） ====================
  // 职责边界：
  //   本模块只管「存不存在」与「顺序对不对」；格式是否合规由「格式巡检」负责。
  //   补全时逐个字段重新生成（只生成缺的那些），补完把 AI 字段按配置顺序摆正。
  //   处理完做一次二次验证，不重复运行。

  // 配置里的元数据顺序（只用 7 个 AI_ 键；非 AI 键与大小写写错的键一律忽略；为空时回落默认顺序）
  getMetadataKeyOrder() {
    const raw = String(this.settings.metadataKeyOrder || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    // 1.13：巡检、补全、二次验证都只认 7 个 AI_ 键：若把 status 等非 AI 键（或 AI_Title 这种
    // 大小写写错的键）留在 order 里，二次验证会永远报「仍缺 N 项」，用户只能反复重跑。
    const configured = raw.filter((key) => this.isAiMetadataKey(key));
    const ignored = raw.filter((key) => !this.isAiMetadataKey(key));
    if (ignored.length && !this.warnedKeyOrderIgnored) {
      this.warnedKeyOrderIgnored = true;
      this.appendLog("warn", `元数据顺序里的非 AI 字段已被忽略：${ignored.join("、")}（只接受 ${DEFAULT_METADATA_KEY_ORDER.split("\n").join("、")}）`, { phase: "元数据顺序" });
    }
    const list = configured.length ? configured : DEFAULT_METADATA_KEY_ORDER.split("\n");
    const seen = new Set();
    const out = [];
    for (const key of list) {
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(key);
    }
    return out;
  }

  isAiMetadataKey(key) {
    return METADATA_KINDS.some((kind) => this.fieldKeyForKind(kind) === key);
  }

  isEmptyMetadataValue(value) {
    if (value === null || value === undefined) return true;
    if (Array.isArray(value)) return !value.some((item) => String(item ?? "").trim() !== "");
    return String(value).trim() === "";
  }

  // ==================== Sidecar 元数据存储（方案B：00_metadata 平铺） ====================
  // 关联方式 = sidecar frontmatter 的 doc 键指向正文路径;重名 basename 加 FNV-1a 哈希后缀。
  // sidecar 文件只承载 AI_* 十键；正文 frontmatter 保留工作流键（status/visibility/updated/token_count）。
  sidecarModeEnabled() {
    return this.settings.sidecarModeEnabled === true;
  }

  metadataStoreFolder() {
    return String(this.settings.metadataStoreFolder || "00_metadata").replace(/^\/+|\/+$/g, "");
  }

  isWhitelistedPath(path) {
    const p = String(path || "").toLocaleLowerCase();
    return this.whitelistRoots().some((root) => p.startsWith(`${root.toLocaleLowerCase()}/`));
  }

  // 平铺命名:basename 唯一 → <名>.md;重名 → <名>__<FNV-1a(path) 前 8 位>.md。
  // 哈希函数与 hashString 一致,迁移脚本用同一算法,保证插件能按候选名找到文件。
  sidecarNameCandidates(path) {
    const base = String(path || "").replace(/\.md$/i, "").split("/").pop() || "untitled";
    return {
      plain: `${base}.md`,
      hashed: `${base}__${this.hashString(path)}.md`,
    };
  }

  // 按 doc 关联键判定归属:先查平铺名再查哈希名;doc 缺失视为无主,可认领。
  sidecarFileForPath(path) {
    const { plain, hashed } = this.sidecarNameCandidates(path);
    for (const name of [plain, hashed]) {
      const abstract = this.app.vault.getAbstractFileByPath(`${this.metadataStoreFolder()}/${name}`);
      if (!(abstract instanceof TFile) || abstract.extension !== "md") continue;
      const doc = this.app.metadataCache.getFileCache(abstract)?.frontmatter?.doc;
      if (!doc || doc === path) return abstract;
    }
    return null;
  }

  sidecarFileFor(file) {
    return this.sidecarFileForPath(file.path);
  }

  // 面板/CSV 的字段展示顺序:跟随设置里的 metadataKeyOrder(缺项按 METADATA_KINDS 固定序补尾部)。
  kindsInConfiguredOrder() {
    const byKey = new Map(METADATA_KINDS.map((kind) => [this.fieldKeyForKind(kind), kind]));
    const out = [];
    for (const key of this.getMetadataKeyOrder()) {
      const kind = byKey.get(key);
      if (kind && !out.includes(kind)) out.push(kind);
    }
    for (const kind of METADATA_KINDS) {
      if (!out.includes(kind)) out.push(kind);
    }
    return out;
  }

  // 创建目标:平铺名空闲或已归本文章时用平铺名,被别的文章占用则退哈希名。
  sidecarPathFor(file) {
    const { plain, hashed } = this.sidecarNameCandidates(file.path);
    const plainAbs = this.app.vault.getAbstractFileByPath(`${this.metadataStoreFolder()}/${plain}`);
    if (!(plainAbs instanceof TFile)) return `${this.metadataStoreFolder()}/${plain}`;
    const doc = this.app.metadataCache.getFileCache(plainAbs)?.frontmatter?.doc;
    if (!doc || doc === file.path) return `${this.metadataStoreFolder()}/${plain}`;
    return `${this.metadataStoreFolder()}/${hashed}`;
  }

  // sidecar 的 doc 关联键与正文当前路径不一致时改写(正文改名后调用)。
  async syncSidecarDocKey(file) {
    const sidecar = this.sidecarFileFor(file);
    if (!sidecar) return;
    const doc = this.app.metadataCache.getFileCache(sidecar)?.frontmatter?.doc;
    if (doc === file.path) return;
    await this.app.fileManager.processFrontMatter(sidecar, (fm) => { fm.doc = file.path; });
  }

  // sidecar 缺失时创建（幂等）：doc 关联键 + 按配置顺序排列的 AI_* 键，值全空。
  async ensureSidecar(file) {
    const existing = this.sidecarFileFor(file);
    if (existing) {
      await this.syncSidecarDocKey(file);
      return this.sidecarFileFor(file) || existing;
    }
    const path = this.sidecarPathFor(file);
    const lines = ["---", `doc: ${file.path}`, "status: ", "visibility: ", "updated: ", "token_count: ", ...this.getMetadataKeyOrder().map((key) => `${key}: `), "---", ""];
    const created = await this.app.vault.create(path, lines.join("\n"));
    return created instanceof TFile ? created : null;
  }

  // AI_* frontmatter 的统一读入口：sidecar 模式读镜像文件的缓存，legacy 模式读正文缓存。
  aiFrontmatter(file) {
    if (!this.sidecarModeEnabled()) {
      return this.app.metadataCache.getFileCache(file)?.frontmatter || {};
    }
    const sidecar = this.sidecarFileFor(file);
    return sidecar ? (this.app.metadataCache.getFileCache(sidecar)?.frontmatter || {}) : {};
  }

  // AI_* 数据的磁盘原文来源：sidecar 模式返回镜像文件（null = 还没建），legacy 返回正文。
  aiSourceFileFor(file) {
    return this.sidecarModeEnabled() ? this.sidecarFileFor(file) : file;
  }

  async readAiSourceRaw(file) {
    const source = this.aiSourceFileFor(file);
    return source ? await this.app.vault.cachedRead(source) : "";
  }

  // 巡检单篇：存在性（缺失 / 空值）+ AI 字段顺序
  checkMetadataPresenceAndOrder(file) {
    const fm = this.aiFrontmatter(file);
    const actualKeys = Object.keys(fm);
    const actualAi = actualKeys.filter((key) => this.isAiMetadataKey(key));
    const order = this.getMetadataKeyOrder();
    const missingKeys = order.filter((key) => !Object.prototype.hasOwnProperty.call(fm, key));
    const emptyKeys = order.filter((key) => Object.prototype.hasOwnProperty.call(fm, key) && this.isEmptyMetadataValue(fm[key]));
    // 顺序正确 = 实际出现的 AI 键，正好等于「按配置顺序过滤出的子序列」
    const expectedAi = order.filter((key) => actualAi.includes(key));
    const orderOk = JSON.stringify(actualAi) === JSON.stringify(expectedAi);
    return { actualKeys, actualAi, expectedAi, order, missingKeys, emptyKeys, orderOk };
  }

  // 本地重排 AI 字段（不调用 AI）：非 AI 键保持原有相对顺序，AI 键按配置顺序
  // 整体挪到原来第一个 AI 键所在的位置；原来没有 AI 键就追加到末尾。
  async fixMetadataKeyOrder(file) {
    const order = this.getMetadataKeyOrder();
    const orderIndex = new Map(order.map((key, index) => [key, index]));
    const orderTarget = this.sidecarModeEnabled() ? await this.ensureSidecar(file) : file;
    if (!orderTarget) return;
    await this.app.fileManager.processFrontMatter(orderTarget, (fm) => {
      const keys = Object.keys(fm);
      const aiKeys = keys.filter((key) => this.isAiMetadataKey(key));
      if (aiKeys.length < 2) return;
      const sortedAi = aiKeys.slice().sort((a, b) => (orderIndex.get(a) ?? 999) - (orderIndex.get(b) ?? 999));
      if (JSON.stringify(aiKeys) === JSON.stringify(sortedAi)) return;
      const firstAi = keys.findIndex((key) => this.isAiMetadataKey(key));
      const nonAi = keys.filter((key) => !this.isAiMetadataKey(key));
      const next = {};
      nonAi.slice(0, firstAi).forEach((key) => { next[key] = fm[key]; });
      sortedAi.forEach((key) => { next[key] = fm[key]; });
      nonAi.slice(firstAi).forEach((key) => { next[key] = fm[key]; });
      Object.keys(fm).forEach((key) => delete fm[key]);
      Object.assign(fm, next);
    });
  }

  async runMetadataGapInspection(options = {}) {
    const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
    const allFiles = this.getNotesFiles();
    const files = this.settings.statusDoneOnlyEnabled === true
      ? allFiles.filter((file) => this.isRecognitionEligible(file))
      : allFiles;
    const stats = {
      whitelistTotal: allFiles.length,
      scanned: 0,
      statusFiltered: Math.max(0, allFiles.length - files.length),
      statusFilterEnabled: this.settings.statusDoneOnlyEnabled === true,
      missingKeys: 0,
      emptyKeys: 0,
      orderIssues: 0,
      complete: 0,
      filesWithIssue: 0,
      scannedAt: Date.now(),
    };
    const items = [];
    for (const file of files) {
      stats.scanned += 1;
      if (onProgress && stats.scanned % 20 === 0) {
        onProgress({ scanned: stats.scanned, total: files.length });
      }
      const check = this.checkMetadataPresenceAndOrder(file);
      const hasIssue = check.missingKeys.length || check.emptyKeys.length || !check.orderOk;
      if (!hasIssue) { stats.complete += 1; continue; }
      stats.missingKeys += check.missingKeys.length;
      stats.emptyKeys += check.emptyKeys.length;
      if (!check.orderOk) stats.orderIssues += 1;
      stats.filesWithIssue += 1;
      items.push({
        file,
        path: file.path,
        missingKeys: check.missingKeys,
        emptyKeys: check.emptyKeys,
        orderIssue: !check.orderOk,
        actualAi: check.actualAi,
        expectedAi: check.expectedAi,
      });
    }
    if (onProgress) onProgress({ scanned: files.length, total: files.length, done: true });
    return { items, stats };
  }

  // 二次验证：直接从磁盘原文判断（metadataCache 写入后是异步刷新的）
  async verifyMetadataGaps(file) {
    const source = this.aiSourceFileFor(file);
    if (!source) {
      const orderAll = this.getMetadataKeyOrder();
      return {
        ok: false,
        missing: orderAll.slice(),
        aiKeysInFile: [],
        expectedAi: [],
        orderOk: true,
        reason: `仍缺 ${orderAll.length} 项`,
      };
    }
    const raw = await this.app.vault.read(source);
    const parsed = this.parseAiFieldsFromRaw(raw);
    const aiKeysInFile = [];
    const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(raw || ""));
    if (block) {
      for (const line of block[1].split(/\r?\n/)) {
        const kv = /^([A-Za-z0-9_]+)\s*:/.exec(line);
        if (kv && this.isAiMetadataKey(kv[1]) && !aiKeysInFile.includes(kv[1])) aiKeysInFile.push(kv[1]);
      }
    }
    const order = this.getMetadataKeyOrder();
    const missing = order.filter((key) => !(key in parsed) || this.isEmptyMetadataValue(parsed[key]));
    const expectedAi = order.filter((key) => aiKeysInFile.includes(key));
    const orderOk = JSON.stringify(aiKeysInFile) === JSON.stringify(expectedAi);
    const ok = missing.length === 0 && orderOk;
    return {
      ok,
      missing,
      aiKeysInFile,
      expectedAi,
      orderOk,
      reason: ok ? "存在性与顺序都正确" : (!missing.length ? "顺序仍不正确" : `仍缺 ${missing.length} 项`),
    };
  }

  // 逐篇：先摆顺序 → 只补缺失/空值的字段 → 再摆一次顺序 → 二次验证（只做一次，不重复运行）
  async fixMetadataGaps(items, onProgress = null) {
    const results = [];
    const controller = new AbortController();
    this.gapRun = controller;
    const total = items.length;
    try {
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        const progress = { index: index + 1, total, path: item.path };
        if (controller.signal.aborted) {
          results.push({ ...item, stopped: true });
          continue;
        }
        if (typeof onProgress === "function") onProgress({ phase: "processing", ...progress });

        let error = "";
        let after = null;
        try {
          this.fileBusy.add(item.path);
          await this.fixMetadataKeyOrder(item.file);
          const needsFill = item.missingKeys.concat(item.emptyKeys);
          const kinds = METADATA_KINDS.filter((kind) => needsFill.includes(this.fieldKeyForKind(kind)));
          if (kinds.length) {
            await this.generateSelectedForFile(item.file, kinds, "metadata-gap-fill", null, {
              abortSignal: controller.signal,
              respectStatusFilter: this.settings.statusDoneOnlyEnabled === true,
            });
          }
          // 新写入的键会追加在末尾，这里再摆一次
          await this.fixMetadataKeyOrder(item.file);
          // 1.14：二次验证放进本项的 try 里：单篇读盘失败只记为该篇失败，不会把整批静默打断。
          after = await this.verifyMetadataGaps(item.file);
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
        } finally {
          this.fileBusy.delete(item.path);
        }

        const row = { ...item, error, after, fixed: Boolean(after && after.ok) };
        results.push(row);
        if (typeof onProgress === "function") {
          onProgress({
            phase: error ? "error" : (row.fixed ? "success" : "still-issue"),
            ...progress,
            message: error || (after && after.reason) || "",
          });
        }
      }
    } finally {
      if (this.gapRun === controller) this.gapRun = null;
      await this.saveAllData();
    }
    return results;
  }

  stopMetadataGapRun() {
    if (!this.gapRun) return false;
    try { this.gapRun.abort(); } catch (_) { /* ignore */ }
    return true;
  }

  openMetadataGap() {
    new MetadataGapModal(this.app, this).open();
  }

  /* ==================== 模板骨架：审查 / 补全（1.30 由原 00_xyblue135-docs-template 并入） ====================
     原则与原插件一致：
       1. 只追加模板里存在、而笔记里缺失的字段，绝不改写已有字段的值与顺序；
       2. 已有值即使是空字符串也不动（视为用户有意留空）；
       3. 完全没有 frontmatter 的笔记，把整块模板 frontmatter 补在正文最前面；
       4. 笔记正在编辑器里打开时改编辑器缓冲区（而不是磁盘），避免与未落盘的输入互相覆盖。 */

  /** 解析模板作用范围（逗号或换行分隔，去掉首尾斜杠与 ./，统一小写以兼容 Windows 大小写）。 */
  getTemplateAuditRoots() {
    return String(this.settings.templateAuditFolders || "")
      .split(/[,，\n]/)
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => normalizePath(item).replace(/^\.\//, "").replace(/^\/+|\/+$/g, "").toLowerCase())
      .filter(Boolean);
  }

  /** 判断某篇笔记是否在模板作用范围内；留空表示整个仓库。 */
  isInTemplateScope(file) {
    const roots = this.getTemplateAuditRoots();
    if (!roots.length) return true;
    const path = normalizePath(String(file && file.path ? file.path : ""))
      .replace(/^\/+/, "")
      .toLowerCase();
    return roots.some((root) => path === root || path.startsWith(`${root}/`));
  }

  /** 找到正在显示指定笔记的 Markdown 视图（没打开时返回 null）。 */
  getTemplateOpenMarkdownView(file) {
    const leaves = this.app.workspace.getLeavesOfType("markdown");
    for (const leaf of leaves) {
      const view = leaf && leaf.view;
      if (view && view.file && view.file.path === file.path && view.editor) return view;
    }
    return null;
  }

  /** 笔记创建后延迟审查，避免与 Obsidian 的写入 / 索引过程抢跑。 */
  scheduleTemplateAudit(file, attempt = 0) {
    if (!this.templateAudits) this.templateAudits = new Map();
    const previous = this.templateAudits.get(file);
    if (previous) window.clearTimeout(previous.timer);
    const delay = Math.max(300, Number(this.settings.templateAuditDelayMs) || 1500);
    const timer = window.setTimeout(() => {
      this.templateAudits.delete(file);
      void this.runScheduledTemplateAudit(file, attempt);
    }, delay);
    this.templateAudits.set(file, { timer, attempt });
  }

  /** 定时器到点后的实际动作：对象仍在才继续；正在输入时最多顺延 8 轮。 */
  async runScheduledTemplateAudit(file, attempt) {
    const latest = this.app.vault.getAbstractFileByPath(file.path);
    if (!(latest instanceof TFile)) {
      console.warn("[metadata-ai] 模板补全：定时器找不到文件，已跳过：", file.path);
      return;
    }
    // 「正在输入就顺延」的保护不能误伤「刚新建、缓冲区还是空的」——那正是最该补字段的时刻。
    if (attempt < 8 && this.getTemplateOpenMarkdownView(latest)
      && !this.isTemplateFieldsComplete(latest) && !this.isEditorEffectivelyEmpty(latest)) {
      this.scheduleTemplateAudit(latest, attempt + 1);
      return;
    }
    await this.auditTemplateAndFill(latest, { notify: true, silentWhenClean: true });
  }

  /** 编辑器里的内容是否已经写全模板字段（用于决定还要不要让一轮）。 */
  isTemplateFieldsComplete(file) {
    const fields = this.buildTemplateFields(file);
    if (!fields.length) return true;
    const view = this.getTemplateOpenMarkdownView(file);
    if (!view) return false;
    const split = this.splitFrontmatter(view.editor.getValue());
    const keys = new Set(split ? split.keys : []);
    return fields.every((field) => keys.has(field.key));
  }

  /** 缓冲区是否还是「空壳」（内容全是空白）。 */
  isEditorEffectivelyEmpty(file) {
    const view = this.getTemplateOpenMarkdownView(file);
    if (!view) return true;
    return String(view.editor.getValue() ?? "").trim() === "";
  }

  /** 审查单篇笔记并补全缺失的模板字段。 */
  async auditTemplateAndFill(file, options = {}) {
    const notify = options.notify === true;
    const silentWhenClean = options.silentWhenClean === true;
    const fields = this.buildTemplateFields(file);
    if (!fields.length) {
      if (notify) new Notice("模板里没有可用的 frontmatter 字段，请先在设置中完善模板");
      return { added: 0, createdBlock: false };
    }
    let added = 0;
    let createdBlock = false;
    let unclosed = false;
    try {
      const view = this.getTemplateOpenMarkdownView(file);
      if (view) {
        const buffer = view.editor.getValue();
        const result = this.mergeTemplateFields(buffer, fields);
        if (result.unclosed) {
          unclosed = true;
        } else if (result.insert) {
          added = result.added;
          createdBlock = result.createdBlock;
          const pos = this.offsetToEditorPos(buffer, result.insert.offset);
          view.editor.replaceRange(result.insert.text, pos);
        }
      } else {
        await this.app.vault.process(file, (data) => {
          const result = this.mergeTemplateFields(data, fields);
          if (result.unclosed) { unclosed = true; return data; }
          if (!result.insert) return data;
          added = result.added;
          createdBlock = result.createdBlock;
          return `${data.slice(0, result.insert.offset)}${result.insert.text}${data.slice(result.insert.offset)}`;
        });
      }
    } catch (error) {
      console.error("[metadata-ai] 模板补全失败：", file.path, error);
      if (notify) new Notice(`补全失败：${file.path}`);
      return { added: 0, createdBlock: false, error };
    }
    if (unclosed && notify) new Notice(`frontmatter 没有闭合，已跳过：${file.basename}`);
    if (notify && !unclosed) {
      if (added > 0) {
        new Notice(createdBlock ? `已补全元数据块：${file.basename}` : `已补全 ${added} 个元数据字段：${file.basename}`);
      } else if (!silentWhenClean) {
        new Notice("该笔记的模板字段已完整，无需补全");
      }
    }
    return { added, createdBlock, unclosed };
  }

  /**
   * 纯函数：把模板字段合并进一段文本。
   * 只计算出「插入位置」和「要插入的文本」，其余内容（BOM、行尾、正文）保持原样，
   * 这样同一套逻辑既能作用于磁盘内容（vault.process），也能作用于编辑器缓冲区。
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
    if (!missing.length) return { added: 0, createdBlock: false, insert: null, unclosed: false };
    const lines = missing.map((field) => this.formatTemplateFieldLine(field).replace(/\n/g, eol));
    const joined = lines.join(eol);
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

  /** 单行字段：有值写 `key: value`，空的写 `key:`。多行值必须从下一行开始。 */
  formatTemplateFieldLine(field) {
    if (!field.text) return `${field.key}:`;
    if (/^[ \t]/.test(field.text)) return `${field.key}:\n${field.text}`;
    return `${field.key}: ${field.text}`;
  }

  /** 批量审查作用范围内的全部笔记（先弹确认框）。 */
  async runBulkTemplateAudit() {
    const roots = this.getTemplateAuditRoots();
    const files = this.app.vault.getMarkdownFiles().filter((file) => this.isInTemplateScope(file));
    if (!files.length) { new Notice("作用目录内没有 Markdown 笔记"); return; }
    const scopeText = roots.length ? roots.join("、") : "整个仓库";
    new TemplateAuditConfirmModal(this.app, `将审查 ${files.length} 篇笔记（${scopeText}）。只会追加缺失的 frontmatter 字段，不改动已有字段的值、顺序与正文。建议先在 Git 中提交当前改动，便于回滚。`, async () => {
      let changed = 0;
      let fieldsAdded = 0;
      let blocksCreated = 0;
      const startedAt = Date.now();
      for (const file of files) {
        const result = await this.auditTemplateAndFill(file, { notify: false });
        if (result.added > 0) {
          changed += 1;
          fieldsAdded += result.added;
          if (result.createdBlock) blocksCreated += 1;
        }
      }
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      new Notice(`审查完成：共 ${files.length} 篇，补全 ${changed} 篇（新增 ${fieldsAdded} 个字段，新建元数据块 ${blocksCreated} 篇），耗时 ${seconds}s`, 8000);
    }).open();
  }

  /**
   * 把设置里的模板解析成 [{key, text}] 形式的字段列表（变量已渲染）。
   * 按「缩进续行」整体取字段，因此块标量（| / >）、多行列表、嵌套 map 都不会被拆坏。
   */
  buildTemplateFields(file) {
    const template = String(this.settings.templateNote || "");
    const match = template.match(/^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
    const body = match ? match[1] : "";
    if (!body.trim()) return [];
    const parent = file.parent;
    const now = moment();
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
      if (!fieldMatch) continue;
      const key = fieldMatch[1];
      if (seen.has(key)) continue;
      seen.add(key);
      const rawValue = fieldMatch[2].trim();
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
      // 整个值就是一个变量时按字符串整体转义，避免时间戳被当成天文数字。
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

  toYamlString(value) {
    return JSON.stringify(value);
  }

  /** 把模板里的一小段文本还原成合适的 JS 值（数组 / 数字 / 布尔 / 字符串）。 */
  parseYamlScalar(text) {
    const raw = String(text ?? "").trim();
    if (!raw) return "";
    // 纯数字自己处理：YAML 会把 17 位时间戳解析成浮点并丢掉精度。
    if (/^-?\d+$/.test(raw)) return String(Number(raw)) === raw ? Number(raw) : raw;
    // 含 # 的值不交给 YAML，免得被当成行内注释截断。
    if (raw.indexOf("#") === -1) {
      try {
        const parsed = parseYaml(`value: ${raw}`);
        if (parsed && Object.prototype.hasOwnProperty.call(parsed, "value")) {
          const value = parsed.value;
          if (value instanceof Date) return raw.replace(/^['"]/, "").replace(/['"]$/, "");
          if (value !== undefined) return value;
        }
      } catch (error) { /* 解析失败走下面的手工兜底 */ }
    }
    if (/^'(.*)'$/.test(raw)) return raw.slice(1, -1);
    return raw;
  }

  /** 把 JS 值写回 YAML 文本；空值写成 `key:`，保持与原模板一致。 */
  toYamlText(value) {
    if (value === null || value === undefined) return "";
    if (Array.isArray(value) || typeof value === "object") return JSON.stringify(value);
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    const text = String(value);
    if (!text.trim()) return "";
    if (/^\d{4}-\d{2}-\d{2}(?:[T ].*)?$/.test(text)) return JSON.stringify(text);
    if (/^-?\d+(?:\.\d+)?$/.test(text) && String(Number(text)) !== text) return JSON.stringify(text);
    if (/^[A-Za-z0-9\u4e00-\u9fa5][A-Za-z0-9\u4e00-\u9fa5 _\-./]*$/.test(text)) return text;
    return JSON.stringify(text);
  }

  /** 生成一整块 frontmatter（用于完全没有元数据的笔记）。 */
  buildFrontmatterBlock(fields, eol = "\n") {
    const lines = fields.map((field) => this.formatTemplateFieldLine(field).replace(/\n/g, eol));
    return `---${eol}${lines.join(eol)}${eol}---${eol}${eol}`;
  }

  /** 拆出笔记的 frontmatter。返回 { prefix, body, suffix, rest, keys }，无法识别时返回 null。 */
  splitFrontmatter(data) {
    const text = String(data ?? "");
    // BOM 归到 prefix 里：这样 mergeTemplateFields 计算偏移量时不会把它算丢。
    const match = text.match(/^(\uFEFF?---[ \t]*\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))/);
    if (match) {
      return {
        prefix: match[1],
        body: match[2],
        suffix: match[3],
        rest: text.slice(match[0].length),
        keys: this.collectFrontmatterKeys(match[2]),
      };
    }
    // 空 frontmatter 块（--- 紧跟 ---）单独处理，避免被当成「没有 frontmatter」。
    const emptyBlock = text.match(/^(\uFEFF?---[ \t]*\r?\n)(---[ \t]*(?:\r?\n|$))/);
    if (emptyBlock) {
      return {
        prefix: emptyBlock[1],
        body: "",
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
      if (keyMatch) keys.push(keyMatch[1]);
    }
    return keys;
  }

  // 设置页各模块说明用：把「校验目标 + 语法 + 当前规则数」讲清楚，方便对照提示词。
  describeFormatCheck(kind) {
    const config = this.getFormatCheckConfig(kind);
    const rules = this.parseFormatCheckRules(config.rules);
    const state = config.enabled === false
      ? "当前状态：已关闭（点 ✓ 会提示跳过）。"
      : rules.length
        ? `当前状态：启用，共 ${rules.length} 条规则，全部匹配才算通过。`
        : "当前状态：启用但没有规则（点 ✓ 会提示跳过）。";
    return [
      "格式校验（纯本地正则，不调用 AI、不写盘、不改数据）。",
      `校验目标：${FORMAT_CHECK_TARGETS[kind] || ""}。`,
      "下面每一行是一条正则，写成 /表达式/标志（例：/^《.+》$/m）；以 # 开头的行是注释；所有正则全部匹配才算通过。",
      // 1.1：明确告知两条配置必须一致
      "注意：校验规则必须与对应模块的「语义约束内容（Harness 提示词）」要求的输出格式保持一致，否则会一直报「格式不通过」；改过提示词后请回来同步这里。",
      "点 Properties 里 ✨ 右侧的 ✓ 按钮，对当前笔记的这一栏执行校验。",
      state,
    ].join("\n");
  }

  async generateForActiveFile(kind, button) {
    const file = this.app.workspace.getActiveFile();
    if (!(file instanceof TFile) || file.extension !== "md") {
      new Notice("xyblue135 私人·AI 元数据：请先打开一个 Markdown 笔记");
      return;
    }
    if (!this.isWhitelisted(file)) {
      new Notice(`xyblue135 私人·AI 元数据：仅允许处理 /${this.normalizeWhitelistFolder()} 目录中的 Markdown`);
      return;
    }
    if (!String(this.settings.apiKey || "").trim()) {
      new Notice("xyblue135 私人·AI 元数据：请先在插件设置里填写 API Key");
      return;
    }
    // 1.28：该笔记正在被别的流程处理时不能静默 return（按钮连转圈都没有），要给出明确提示
    if (this.fileBusy.has(file.path)) {
      new Notice("xyblue135 私人·AI 元数据：该笔记正在处理中，请稍候再点");
      return;
    }

    // v0.4.6：Properties 侧按钮始终保持单字段语义；`kind === "all"` 仍供命令、批量和自动流程使用。
    const effectiveKind = kind;
    const stateButtons = [button];
    const setStateForButtons = (state) => stateButtons.forEach((item) => this.setButtonState(item, state));

    this.fileBusy.add(file.path);
    setStateForButtons("loading");
    try {
      if (effectiveKind === "all") {
        const result = await this.generateAllForFile(file, "manual");
        new Notice("xyblue135 私人·AI 元数据：全部 AI 元数据已更新（10 个字段）");
      } else if (effectiveKind === "summaries") {
        await this.generateSelectedForFile(file, ["summary_short", "summary_long"], "manual");
        new Notice("xyblue135 私人·AI 元数据：AI_summary_short + AI_summary_long 已更新");
      } else {
        const result = await this.generateSingleForFile(file, effectiveKind, "manual");
        if (effectiveKind === "summary_short") new Notice("xyblue135 私人·AI 元数据：AI_summary_short 已更新");
        else if (effectiveKind === "summary_long") new Notice("xyblue135 私人·AI 元数据：AI_summary_long 已更新");
        else if (effectiveKind === "technical_depth") new Notice(`xyblue135 私人·AI 元数据：AI_technical_depth 已更新为 ${result.technicalDepth}`);
        else if (effectiveKind === "take") new Notice("xyblue135 私人·AI 元数据：AI_take 客观评价已更新");
        else if (effectiveKind === "qa") new Notice("xyblue135 私人·AI 元数据：AI_qa 面试问答已更新");
        else if (effectiveKind === "ai_title") new Notice("xyblue135 私人·AI 元数据：AI_title 已生成参考标题");
        else if (effectiveKind === "freshness") new Notice("xyblue135 私人·AI 元数据：时效性已更新（AI_freshness / AI_freshness_note / AI_last_verified）");
        else if (effectiveKind === "freshness_note") new Notice("xyblue135 私人·AI 元数据：时效性说明已更新（AI_freshness_note，AI_freshness / AI_last_verified 同步刷新）");
        else new Notice(`xyblue135 私人·AI 元数据：已写入 ${result.tags.length} 个 AI_tags`);
      }
      setStateForButtons("success");
      window.setTimeout(() => setStateForButtons("idle"), 1200);
      this.scheduleInjection();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const record = this.state.files[file.path] || {};
      if (error && error.code === "EMPTY_BODY") {
        record.lastError = "";
        record.lastErrorType = "";
        record.lastRawModelOutput = "";
        this.state.files[file.path] = record;
        this.scheduleStateSave();
        setStateForButtons("idle");
        new Notice("xyblue135 私人·AI 元数据：跳过，无可分析正文");
        this.appendLog("warn", "跳过：无可分析正文", { filePath: file.path, phase: effectiveKind });
      } else if (error && error.code === "SOURCE_CHANGED") {
        // 请求尚未发出，不算失败，也不写错误记录。
        record.lastError = "";
        record.lastErrorType = "";
        record.lastRawModelOutput = "";
        this.state.files[file.path] = record;
        this.scheduleStateSave();
        setStateForButtons("idle");
        new Notice("xyblue135 私人·AI 元数据：正文已变动，本次 API 请求未发出（未消耗调用），请重新触发", 7000);
        this.appendLog("warn", "正文已变动，本次 API 请求未发出", { filePath: file.path, phase: effectiveKind });
      } else {
        record.lastError = message.slice(0, 1000);
        record.lastErrorType = error && error.code ? String(error.code) : "ERROR";
        record.lastRawModelOutput = error && error.rawOutput ? String(error.rawOutput).slice(0, 16000) : "";
        this.state.files[file.path] = record;
        this.scheduleStateSave();
        // 写入运行日志：设置页「目录更新管理 → 日志与报错」可查看与清理。
        this.appendLog("error", message, {
          filePath: file.path,
          phase: effectiveKind,
          errorType: record.lastErrorType,
          raw: record.lastRawModelOutput,
        });
        setStateForButtons("error");
        this.setRuntimeStatus("error", { filePath: file.path, phase: effectiveKind, message });
        new Notice(`xyblue135 私人·AI 元数据 失败：${message}`, 7000);
        window.setTimeout(() => setStateForButtons("idle"), 1800);
      }
    } finally {
      this.fileBusy.delete(file.path);
      if (!this.autoRunning && !this.unloading) {
        window.setTimeout(() => {
          if (!this.autoRunning && !this.unloading) this.setRuntimeStatus("idle");
        }, 1200);
      }
    }
  }

  async prepareFile(file) {
    const raw = await this.app.vault.cachedRead(file);
    const fingerprint = this.computeSourceFingerprint(raw, file);
    const body = this.stripFrontmatter(raw).trim();
    if (!body) throw new EmptyNoteBodyError("笔记正文为空", fingerprint);
    return { raw, body, fingerprint };
  }

  async generateSingleForFile(file, kind, reason, progress = null, taskContext = {}) {
    return this.generateSelectedForFile(file, [kind], reason, progress, taskContext);
  }

  async generateAllForFile(file, reason, progress = null, taskContext = {}) {
    return this.generateSelectedForFile(file, ["summary_short", "summary_long", "tags", "technical_depth", "take", "qa", "ai_title", "freshness"], reason, progress, taskContext);
  }

  async generateSelectedForFile(file, kinds, reason, progress = null, taskContext = {}) {
    const requested = Array.from(new Set((Array.isArray(kinds) ? kinds : [kinds]).filter((kind) =>
      ["summary_short", "summary_long", "tags", "technical_depth", "take", "qa", "ai_title", "freshness", "freshness_note", "last_verified"].includes(kind))));
    // 时效性三键（AI_freshness / AI_freshness_note / AI_last_verified）是一个整体：
    // 任一键缺失/待生成，都归一化为同一次 Freshness 生成，同时写入三个键。
    if (requested.some((kind) => ["freshness", "freshness_note", "last_verified"].includes(kind))) {
      for (const kind of ["freshness", "freshness_note", "last_verified"]) {
        const idx = requested.indexOf(kind);
        if (idx >= 0) requested.splice(idx, 1);
      }
      requested.push("freshness");
    }
    if (!requested.length) throw new Error("没有可生成的元数据字段");

    const abortSignal = taskContext.abortSignal || null;
    const scopeFolder = taskContext.scopeFolder || "";
    const respectStatusFilter = taskContext.respectStatusFilter === true;
    this.ensureTaskActive(abortSignal);
    if (scopeFolder) this.assertFileStillInFolder(file, scopeFolder);
    if (respectStatusFilter) this.assertRecognitionEligible(file);

    const prepared = await this.prepareFile(file);
    const currentTags = this.settings.feedMetadataToAiEnabled === true ? this.readCurrentTags(file) : [];
    // 安全修复：这里原先会先调用 clearFieldsBeforeRun() 把本次要生成的字段值清空。
    // 那是数据毁灭源——清空发生在请求之前，一旦请求失败、超时或批量任务被中途停止，
    // 字段就永久停留在空值（库里 477 篇空 AI_title、465 篇空 AI_take、462 篇空 AI_qa、
    // 76 篇空 AI_technical_depth 都是这么来的）。
    // 而下面的写入是「全部生成成功后一次性原子写入」，本身就会覆盖旧值，
    // 所以预清空没有任何收益，已移除。字段在生成期间保持原值，失败时也不会被改动。
    // expectedFingerprint 会随 context 一路带进 API 队列：队列等待期间（默认 30 秒请求间隔，
    // 或前一篇笔记仍占用队列时）正文如果已经变动，就在真正发出请求之前终止，
    // 而不是等请求返回后才丢弃结果。
    const context = {
      filePath: file.path,
      reason,
      progress,
      abortSignal,
      expectedFingerprint: prepared.fingerprint,
    };
    let result = {};

    // 合并请求已下线：严格串行逐字段生成；只有全部逻辑结果生成成功后才统一写入，避免半更新。
    if (requested.includes("summary_short")) {
      result.summaryShort = await this.generateSummaryShort(prepared.body, file.basename, context);
      this.ensureTaskActive(abortSignal);
    }
    if (requested.includes("summary_long")) {
      result.summaryLong = await this.generateSummaryLong(prepared.body, file.basename, context);
      this.ensureTaskActive(abortSignal);
    }
    if (requested.includes("tags")) {
      result.weightedTags = await this.generateTags(prepared.body, file.basename, currentTags, context);
      result.tags = result.weightedTags.map((item) => item.value);
    }
    if (requested.includes("technical_depth")) {
      result.technicalDepthResult = await this.generateTechnicalDepth(prepared.body, file.basename, context);
      result.technicalDepth = result.technicalDepthResult.technical_depth;
    }

    if (requested.includes("take")) {
      result.take = await this.generateTake(prepared.body, file.basename, context);
      this.ensureTaskActive(abortSignal);
    }

    if (requested.includes("qa")) {
      result.qa = await this.generateQa(prepared.body, file.basename, context);
      this.ensureTaskActive(abortSignal);
    }

    if (requested.includes("ai_title")) {
      result.title = await this.generateTitle(prepared.body, file.basename, context);
      this.ensureTaskActive(abortSignal);
    }

    if (requested.includes("freshness")) {
      result.freshnessResult = await this.generateFreshness(prepared.body, file.basename, context);
      this.ensureTaskActive(abortSignal);
    }

    if (requested.includes("tags") && !result.tags) {
      result.weightedTags = Array.isArray(result.weightedTags) ? result.weightedTags : [];
      result.tags = result.weightedTags.map((item) => item.value);
    }

    this.ensureLifecycleActive();
    this.ensureTaskActive(abortSignal);
    if (scopeFolder) this.assertFileStillInFolder(file, scopeFolder);
    if (respectStatusFilter) this.assertRecognitionEligible(file);
    await this.assertSourceUnchanged(file, prepared.fingerprint);

    const phase = requested.join(" + ");
    this.setRuntimeStatus("writing", { ...context, phase });
    await this.withAiWrite(file, async () => {
      this.ensureLifecycleActive();
      this.ensureTaskActive(abortSignal);
      if (scopeFolder) this.assertFileStillInFolder(file, scopeFolder);
      if (respectStatusFilter) this.assertRecognitionEligible(file);
      const writeTarget = this.sidecarModeEnabled() ? await this.ensureSidecar(file) : file;
      if (!writeTarget) throw new Error(`无法创建元数据 sidecar 文件：${this.sidecarPathFor(file)}`);
      await this.app.fileManager.processFrontMatter(writeTarget, (frontmatter) => {
        // 安全护栏：绝不把 undefined 写进 frontmatter。
        // Obsidian 的 YAML 序列化会省略值为 undefined 的键，那等于把该属性行整个删除
        // （实测：AI_technical_depth 曾因此被整行删掉）。这里逐个判空后才赋值，
        // 并且只写本次请求涉及的 AI_* 字段，绝不触碰其它任何键。
        const assign = (key, value) => {
          if (value === undefined) return;
          frontmatter[key] = value;
        };
        if (requested.includes("summary_short")) assign("AI_summary_short", result.summaryShort);
        if (requested.includes("summary_long")) assign("AI_summary_long", result.summaryLong);
        if (requested.includes("tags")) assign("AI_tags", result.tags);
        if (requested.includes("technical_depth")) assign("AI_technical_depth", result.technicalDepth);
        if (requested.includes("take")) assign("AI_take", result.take);
        if (requested.includes("qa")) assign("AI_qa", result.qa);
        if (requested.includes("ai_title")) assign("AI_title", result.title);
        if (requested.includes("freshness")) {
          assign("AI_freshness", result.freshnessResult && result.freshnessResult.freshness);
          assign("AI_freshness_note", result.freshnessResult && result.freshnessResult.freshnessNote);
          assign("AI_last_verified", this.todayStamp());
        }
      });
    });

    this.markProcessed(file, prepared.fingerprint, requested);
    this.appendLog("info", `已写入：${requested.join(" + ")}`, { filePath: file.path, phase: requested.join(" + ") });
    if (requested.includes("tags")) this.scheduleTagCatalogRebuild(700);
    return result;
  }

  async readCurrentFingerprint(file) {
    const raw = await this.app.vault.cachedRead(file);
    return this.computeSourceFingerprint(raw, file);
  }

  async assertSourceUnchanged(file, expectedFingerprint) {
    const currentFingerprint = await this.readCurrentFingerprint(file);
    if (currentFingerprint !== expectedFingerprint) {
      throw new SourceChangedError("AI 生成期间笔记正文发生变化，本次结果未写入；下次会重新生成", currentFingerprint);
    }
  }

  // 顺序关键点：请求真正发出之前的最后一次校验。
  // 队列可能已经等待了几十秒（请求间隔 / 其他笔记的任务），这里再确认正文没有变动，
  // 避免为已经过期的正文白花一次 API 调用。没有 expectedFingerprint 的调用
  //（例如「测试 API」、非笔记类请求）直接跳过。
  async assertSourceUnchangedBeforeRequest(context = {}) {
    const expectedFingerprint = context.expectedFingerprint;
    const filePath = context.filePath;
    if (!expectedFingerprint || !filePath) return;

    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) {
      throw new SourceChangedError(`笔记已不存在或已移出目录，本次 API 请求未发出：${filePath}`);
    }
    const currentFingerprint = await this.readCurrentFingerprint(file);
    if (currentFingerprint !== expectedFingerprint) {
      throw new SourceChangedError(`笔记正文在等待 API 请求期间已变动，本次请求未发出，也不会写入元数据；请重新触发：${filePath}`, currentFingerprint);
    }
  }

  // 按文件串行化 AI 写入：同一篇笔记的两条写入流程不能交错（原来这里只是 await fn() 的空壳）。
  async withAiWrite(file, fn) {
    const key = file && file.path ? file.path : "";
    if (!key) return fn();
    if (!this.aiWriteLocks) this.aiWriteLocks = new Map();
    const previous = this.aiWriteLocks.get(key) || Promise.resolve();
    let releaseCurrent = null;
    const current = new Promise((resolve) => { releaseCurrent = resolve; });
    const tail = previous.then(() => current, () => current);
    this.aiWriteLocks.set(key, tail);
    await previous.catch(() => {});
    try {
      return await fn();
    } finally {
      if (releaseCurrent) releaseCurrent();
      // 没有后来者排队时清掉键，避免 Map 随笔记数无限增长
      if (this.aiWriteLocks.get(key) === tail) this.aiWriteLocks.delete(key);
    }
  }

  stripFrontmatter(content) {
    if (!content.startsWith("---")) return content;
    const match = content.match(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n?/);
    return match ? content.slice(match[0].length) : content;
  }

  // 从磁盘原文解析 frontmatter，供 metadataCache 尚未索引该文件时兜底使用。
  // 返回 null 表示没有 frontmatter 或解析失败，调用方应回退到 metadataCache。
  parseFrontmatterFromRaw(raw) {
    const text = String(raw ?? "");
    const match = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|$)/.exec(text);
    if (!match) return null;
    try {
      const parsed = parseYaml(match[1]);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (error) {
      return null;
    }
  }

  // 内容指纹会忽略由 AI 管理的 legacy summary、summary_short、summary_long、tags、technical_depth 行，
  // 以及其它插件自动写入的派生字段（见 FINGERPRINT_IGNORED_KEYS），因此这些写入不会造成误报或循环更新。
  computeSourceFingerprint(raw, file) {
    const body = this.stripFrontmatter(raw).replace(/\r\n/g, "\n").trim();
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
    const sanitized = {};
    Object.keys(fm)
      .filter((key) => !FINGERPRINT_IGNORED_KEYS.includes(key))
      .sort()
      .forEach((key) => {
        sanitized[key] = this.stableClone(fm[key]);
      });
    const source = `${JSON.stringify(sanitized)}\n${body}`;
    return this.hashString(source);
  }

  stableClone(value) {
    if (Array.isArray(value)) return value.map((item) => this.stableClone(item));
    if (value && typeof value === "object") {
      const out = {};
      Object.keys(value).sort().forEach((key) => {
        out[key] = this.stableClone(value[key]);
      });
      return out;
    }
    return value;
  }

  hashString(text) {
    // 使用 FNV-1a 风格的 32 位 hash：只用于变化检测，不用于密码学安全。
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  readCurrentTags(file) {
    const value = this.aiFrontmatter(file).AI_tags;
    return this.normalizeTagList(value);
  }

  normalizeTagList(value) {
    let items = [];
    if (Array.isArray(value)) items = value;
    else if (typeof value === "string") items = value.split(/[\s,]+/);
    return Array.from(new Set(items.map((item) => this.normalizeTagValue(item)).filter(Boolean)));
  }

  getFrontmatterTagItems(value) {
    if (Array.isArray(value)) return value.slice();
    if (typeof value === "string") return value.split(/[\s,]+/).filter((item) => item !== "");
    return [];
  }

  getFlatComparableTagValue(value) {
    return String(value ?? "").trim().replace(/^#/, "");
  }

  normalizeTagValue(tag) {
    const cleaned = String(tag || "").trim().replace(/^#/, "").replace(/^\/+|\/+$/g, "");
    if (!cleaned) return "";
    const parts = cleaned.split("/").map((part) => part.trim()).filter(Boolean);
    return (parts.length ? parts[parts.length - 1] : cleaned).trim();
  }

  // 1.27：只做清洗、保留层级路径（#dev/docker 仍是 dev/docker）。
  // 层级 Tag 一旦被拍平成叶子，dev/docker 与 ops/docker 会在本地索引里合并、计数虚高。
  normalizeTagPath(tag) {
    const cleaned = String(tag || "").trim().replace(/^#/, "")
      .split("/")
      .map((part) => part.trim())
      .filter(Boolean)
      .join("/");
    return cleaned;
  }

  scheduleTagCatalogRebuild(delay = 800) {
    if (this.catalogTimer !== null) window.clearTimeout(this.catalogTimer);
    this.catalogTimer = window.setTimeout(() => {
      this.catalogTimer = null;
      void this.rebuildTagCatalog();
    }, delay);
  }

  async rebuildTagCatalog() {
    // 1.27：用无原型对象当字典，避免 tag 恰好叫 constructor / __proto__ 时命中 Object.prototype
    const catalog = Object.create(null);
    const files = this.getNotesFiles();
    for (const file of files) {
      const cache = this.app.metadataCache.getFileCache(file);
      // 1.27：统计口径保留完整层级路径（拍平只在写入 AI_tags 前做），否则不同父子 tag 会被合并
      const fmTags = this.getFrontmatterTagItems(this.aiFrontmatter(file).AI_tags)
        .map((item) => this.normalizeTagPath(item))
        .filter(Boolean);
      const inlineTags = Array.isArray(cache?.tags)
        ? cache.tags
            .map((item) => this.normalizeTagPath(item.tag))
            .filter(Boolean)
        : [];
      const fileTags = Array.from(new Set([...fmTags, ...inlineTags]));
      for (const tag of fileTags) {
        if (!catalog[tag]) catalog[tag] = { count: 0, files: 0 };
        catalog[tag].count += 1;
        catalog[tag].files += 1;
      }
    }
    // 仅更新内存索引。Tag Catalog 可由 Vault 随时重建，不写入 data.json。
    this.state.tagCatalog = catalog;
    return catalog;
  }

  getTagCatalogEntries(limit = 300) {
    return Object.entries(this.state.tagCatalog || {})
      .map(([value, meta]) => ({ value, count: Number(meta?.count || 0) }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, "zh-CN"))
      .slice(0, limit);
  }

  getTechnicalTagCanonicalMap() {
    const map = new Map();
    const lines = String(this.settings.technicalTagCanonicalList || "").split(/\r?\n/);
    for (const line of lines) {
      const value = this.normalizeTagValue(line);
      if (!value) continue;
      const key = value.toLocaleLowerCase("en-US");
      if (!map.has(key)) map.set(key, value);
    }
    return map;
  }

  // 说明：原先这里还有 getExistingTagCase() / canonicalizeTagCase() 两级「按 Vault 已有写法或
  // 技术词规范表改写 AI 标签」的逻辑，已按要求全部移除 —— AI 给什么 tag 就写什么。
  // 「整理已有 Tag 大小写冲突」这个手动工具仍然保留（它修的是历史数据，不是 AI 刚生成的内容）。

  async getFrontmatterTagCaseConflicts() {
    const grouped = new Map();
    for (const file of this.getNotesFiles()) {
      const cache = this.app.metadataCache.getFileCache(file);
      const tags = this.getFrontmatterTagItems(this.aiFrontmatter(file).AI_tags)
        .map((tag) => this.getFlatComparableTagValue(tag))
        .filter(Boolean);
      for (const tag of new Set(tags)) {
        const key = tag.toLocaleLowerCase("en-US");
        if (!grouped.has(key)) grouped.set(key, new Map());
        const variants = grouped.get(key);
        variants.set(tag, (variants.get(tag) || 0) + 1);
      }
    }

    const technicalMap = this.getTechnicalTagCanonicalMap();
    const conflicts = [];
    for (const [key, variantsMap] of grouped.entries()) {
      if (variantsMap.size < 2) continue;
      const technical = technicalMap.get(key) || "";
      const variants = Array.from(variantsMap.entries())
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => {
          if (b.count !== a.count) return b.count - a.count;
          const aTechnical = technical && a.value === technical ? 1 : 0;
          const bTechnical = technical && b.value === technical ? 1 : 0;
          if (aTechnical !== bTechnical) return bTechnical - aTechnical;
          return a.value.localeCompare(b.value, "zh-CN");
        });
      conflicts.push({
        key,
        target: variants[0].value,
        variants,
        total: variants.reduce((sum, item) => sum + item.count, 0),
      });
    }
    return conflicts.sort((a, b) => b.total - a.total || a.target.localeCompare(b.target, "zh-CN"));
  }

  // 把一组 Tag 按 targetByKey 统一大小写，返回新数组与改动计数（供预览与写入复用）。
  normalizeFrontmatterTagCase(tags, targetByKey) {
    const nextTags = [];
    let changedTags = 0;
    const seenComparable = new Set();
    for (const rawTag of tags) {
      const comparable = this.getFlatComparableTagValue(rawTag);
      if (!comparable) {
        // 与本次整理无关的旧值（例如层级 Tag 或含较多标点的 Tag）保持原样；这里只处理内容相同、仅字母大小写不同的扁平 Tag。
        nextTags.push(rawTag);
        continue;
      }
      const key = comparable.toLocaleLowerCase("en-US");
      const target = targetByKey.get(key);
      if (!target) {
        nextTags.push(rawTag);
        continue;
      }
      if (target !== comparable) changedTags += 1;
      if (seenComparable.has(key)) {
        changedTags += 1;
        continue;
      }
      seenComparable.add(key);
      nextTags.push(target);
    }
    return { nextTags, changedTags };
  }

  async applyFrontmatterTagCaseConflicts(conflicts, onProgress = null) {
    const targetByKey = new Map((Array.isArray(conflicts) ? conflicts : []).map((group) => [group.key, group.target]));
    if (!targetByKey.size) return { changedFiles: 0, changedTags: 0 };

    let changedFiles = 0;
    let changedTags = 0;
    const files = this.getNotesFiles();
    let index = 0;
    for (const file of files) {
      index += 1;
      // 1.15：同一篇正在跑 AI 任务时直接跳过：否则会把刚生成、尚未刷新的标签用旧快照覆盖。
      if (this.fileBusy.has(file.path)) {
        this.appendLog("warn", "该笔记正在运行 AI 任务，已跳过 Tag 大小写整理", { filePath: file.path, phase: "整理 Tag 大小写" });
        if (onProgress) onProgress({ index, total: files.length, filePath: file.path, changed: false });
        continue;
      }
      // 1.15：不信 metadataCache（写入后是异步刷新的）：先读磁盘原文算一遍，再在 processFrontMatter 回调里按当前值重算。
      let currentTags = [];
      try {
        const tagSource = this.aiSourceFileFor(file);
        if (!tagSource) throw new Error("元数据 sidecar 不存在");
        const raw = await this.app.vault.read(tagSource);
        currentTags = this.getFrontmatterTagItems(this.parseAiFieldsFromRaw(raw).AI_tags);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.appendLog("warn", `读取原文失败，已跳过：${message}`, { filePath: file.path, phase: "整理 Tag 大小写" });
        if (onProgress) onProgress({ index, total: files.length, filePath: file.path, changed: false });
        continue;
      }
      if (!currentTags.length) {
        if (onProgress) onProgress({ index, total: files.length, filePath: file.path, changed: false });
        continue;
      }
      const preview = this.normalizeFrontmatterTagCase(currentTags, targetByKey);
      if (!preview.changedTags) {
        if (onProgress) onProgress({ index, total: files.length, filePath: file.path, changed: false });
        continue;
      }

      let fileChangedTags = 0;
      await this.withAiWrite(file, async () => {
        const tagTarget = this.sidecarModeEnabled() ? await this.ensureSidecar(file) : file;
        if (!tagTarget) throw new Error(`无法创建元数据 sidecar 文件：${this.sidecarPathFor(file)}`);
        await this.app.fileManager.processFrontMatter(tagTarget, (frontmatter) => {
          // 在回调里基于「当前值」重算并只替换该字段，避免把期间新增的标签整段覆盖。
          const live = this.getFrontmatterTagItems(frontmatter.AI_tags);
          const result = this.normalizeFrontmatterTagCase(live, targetByKey);
          fileChangedTags = result.changedTags;
          if (result.changedTags) frontmatter.AI_tags = result.nextTags;
        });
      });
      if (!fileChangedTags) {
        if (onProgress) onProgress({ index, total: files.length, filePath: file.path, changed: false });
        continue;
      }
      changedFiles += 1;
      changedTags += fileChangedTags;
      if (onProgress) onProgress({ index, total: files.length, filePath: file.path, changed: true });
    }
    await this.rebuildTagCatalog();
    return { changedFiles, changedTags };
  }

  // 全局开关：是否把文章标题喂给 AI（默认开启）。
  // 各生成字段共用这一处，关闭后所有提示词都不再包含标题行。
  // 返回空字符串时，各提示词数组的 .filter(Boolean) 会自动把它剔除。
  titlePromptLine(title) {
    if (this.settings.feedTitleToAiEnabled === false) return "";
    return `笔记标题：${title}`;
  }

  renderHarness(template) {
    return String(template || "")
      .replaceAll("{{summaryShortMaxChars}}", String(this.settings.summaryShortMaxChars))
      .replaceAll("{{summaryLongMaxChars}}", String(this.settings.summaryLongMaxChars))
      // 兼容用户旧 Harness 中尚未改掉的占位符：默认映射到长摘要长度。
      .replaceAll("{{summaryMaxChars}}", String(this.settings.summaryLongMaxChars))
      .replaceAll("{{maxTags}}", String(this.settings.maxTags))
      .replaceAll("{{maxQuestions}}", String(this.settings.qaMaxQuestions))
      .replaceAll("{{maxItems}}", String(this.settings.aiTitleMaxItems))
      .replaceAll("{{whitelistFolder}}", this.normalizeWhitelistFolder());
  }

  renderTechnicalDepthPrompt(body) {
    const article = String(body || "");
    const rendered = this.renderHarness(this.settings.technicalDepthHarness || DEFAULT_TECHNICAL_DEPTH_HARNESS)
      .replaceAll("{{ARTICLE}}", article);
    // 兜底：用户改 Prompt 时如果把 {{ARTICLE}} 占位符删掉，正文就完全不会发送，
    // 模型只能凭空打分，而且不会报任何错。这里检测不到正文时把正文补在末尾。
    if (article && !rendered.includes(article)) {
      return `${rendered}\n\n文章全文：\n${article}`;
    }
    return rendered;
  }

  // 摘要 Markdown 清理功能已下线（summaryMarkdownCleanupEnabled 在 onload 恒为 false），
  // 原先的图片/代码块/语法清理分支永远不会执行，故退化为直通封装。
  cleanMarkdownForSummary(body) {
    return String(body || "");
  }

  async generateSummaryShort(body, title, context = {}) {
    const summaryBody = this.cleanMarkdownForSummary(body);
    const harness = `\n\n[Summary Short Harness]\n${this.renderHarness(this.settings.summaryShortHarness)}`;
    const system = `你是 Obsidian 知识库的元数据整理助手。${harness}`;
    // 提示词里不再硬编码任何输出限制：字符数上限、格式、是否带字段名全部由 Harness 决定。
    // 这里只保留「本次要生成哪个字段」这一句任务说明，以及正文本身。
    const prompt = [
      this.titlePromptLine(title),
      "请根据以下正文生成 AI_summary_short。",
      "",
      summaryBody,
    ].filter(Boolean).join("\n");

    const raw = await this.chat(system, prompt, { ...context, phase: "Summary Short" });
    // 已按要求移除本地格式处理：不再去引号/换行/多余空格，也不再按字符数截断，模型返回什么就写什么。
    if (!raw) throw new Error("AI 返回了空 summary_short");
    return raw;
  }

  async generateSummaryLong(body, title, context = {}) {
    const summaryBody = this.cleanMarkdownForSummary(body);
    const harness = `\n\n[Summary Long Harness]\n${this.renderHarness(this.settings.summaryLongHarness)}`;
    const system = `你是 Obsidian 知识库的元数据整理助手。${harness}`;
    // 同上：不再硬编码字符数上限与输出格式。
    const prompt = [
      this.titlePromptLine(title),
      "请根据以下正文生成 AI_summary_long。",
      "",
      summaryBody,
    ].filter(Boolean).join("\n");

    const raw = await this.chat(system, prompt, { ...context, phase: "Summary Long" });
    // 已按要求移除本地格式处理：不再去引号/换行/多余空格，也不再按字符数截断，模型返回什么就写什么。
    if (!raw) throw new Error("AI 返回了空 summary_long");
    return raw;
  }

  async generateTags(body, title, currentTags, context = {}) {
    const harness = `\n\n可编辑 Tags Harness：\n${this.renderHarness(this.settings.tagsHarness)}`;
    // 不再注入 TAG_VALUE_SAFETY_PROTOCOL：那是硬编码的标签字符限制，
    // 现在标签的一切规则（数量、字符、权重、层级前缀）都由上面这段 Harness 决定。
    const system = [
      "你是 Obsidian 知识库标签整理助手。",
      harness,
    ].filter(Boolean).join("\n");
    // 同样不再硬编码：标签数量上限、JSON 结构（{"value":..,"weight":..}）、
    // 以及「插件会在本地过滤/去重/排序」这类说明。模型输出成什么样，本地就尽量照收，
    // 解析失败时再由下面的重试与原样落库兜底。
    const basePrompt = [
      this.titlePromptLine(title),
      `当前 tags（已转为 value）：${currentTags.length ? currentTags.join("、") : "无"}`,
      "请根据以下正文生成 AI_tags。",
      "",
      "笔记正文：",
      body,
    ].join("\n");

    const rawAttempts = [];
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const retryHint = attempt === 1 ? "" : "\n\n上一次的输出无法解析出任何结果，请重新输出一次。";
      const text = await this.chat(
        system,
        `${basePrompt}${retryHint}`,
        { ...context, phase: attempt === 1 ? "Tags" : "Tags（重试 1/1）" },
      );
      rawAttempts.push(text);
      try {
        const parsed = this.parseTagsEnvelope(text);
        return this.collectTagValues(parsed.tags);
      } catch (error) {
        const structured = this.asStructuredOutputError(error, text, rawAttempts);
        if (attempt >= 2) throw structured;
        console.warn(`[xyblue135 私人·AI 元数据] Tags 结构化输出失败，自动重试 1 次：${context.filePath || title}`, structured);
        this.appendLog("warn", `Tags 结构化输出失败，自动重试 1 次：${structured.message}`, {
          filePath: context.filePath || title,
          errorType: structured.code || "STRUCTURED_OUTPUT",
          raw: structured.rawOutput,
        });
      }
    }
    throw new StructuredOutputError("Tags 结构化输出失败", rawAttempts.join("\n\n"));
  }

  async generateTechnicalDepth(body, title, context = {}) {
    // 不再硬编码「必须返回 JSON」：你的 technicalDepthHarness 要求只输出整数分，
    // 系统提示词里再要求 JSON 就会互相打架。这里只保留角色说明，输出形态完全交给 Harness。
    const system = "你是技术内容评审员，请严格执行用户提供的 technical_depth 评分标准。";
    // technical_depth 的评分标准（Harness）里没有标题占位符，这里统一补上标题行，
    // 让「喂入文章标题」这个全局开关对各字段都生效。
    const basePrompt = [this.titlePromptLine(title), this.renderTechnicalDepthPrompt(body)].filter(Boolean).join("\n");

    const rawAttempts = [];
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const retryHint = attempt === 1 ? "" : "\n\n上一次的输出无法解析出任何结果，请重新输出一次。";
      const raw = await this.chat(
        system,
        `${basePrompt}${retryHint}`,
        { ...context, phase: attempt === 1 ? "Technical Depth" : "Technical Depth（重试 1/1）" },
      );
      rawAttempts.push(raw);
      try {
        return this.parseTechnicalDepthEnvelope(raw, "Technical Depth");
      } catch (error) {
        const structured = this.asStructuredOutputError(error, raw, rawAttempts);
        if (attempt >= 2) throw structured;
        console.warn(`[xyblue135 私人·AI 元数据] Technical Depth 结构化输出失败，自动重试 1 次：${context.filePath || title}`, structured);
        this.appendLog("warn", `Technical Depth 结构化输出失败，自动重试 1 次：${structured.message}`, {
          filePath: context.filePath || title,
          errorType: structured.code || "STRUCTURED_OUTPUT",
          raw: structured.rawOutput,
        });
      }
    }
    throw new StructuredOutputError("Technical Depth 结构化输出失败", rawAttempts.join("\n\n"));
  }

  async generateQa(body, title, context = {}) {
    const qaBody = this.cleanMarkdownForSummary(body);
    const harness = `\n\n[QA Harness]\n${this.renderHarness(this.settings.qaHarness)}`;
    const system = `你是 Obsidian 知识库的面试出题助手。${harness}`;
    // 不再硬编码「Q: 题目 / A: 答案」的输出格式与题目数量 —— 你的 qaHarness 用的是
    // 「专家: / 空行 / 答:」三段结构，硬编码的 Q/A 说明会直接和它打架。
    const prompt = [
      this.titlePromptLine(title),
      "请根据以下正文生成 AI_qa。",
      "",
      qaBody,
    ].filter(Boolean).join("\n");

    const raw = await this.chat(system, prompt, { ...context, phase: "QA" });
    // 已按要求移除本地格式处理：不再去 ``` 围栏、不再压缩连续空行，模型返回什么就写什么。
    if (!raw) throw new Error("AI 返回了空 qa");
    return raw;
  }

  async generateTake(body, title, context = {}) {
    const takeBody = this.cleanMarkdownForSummary(body);
    const harness = "\n\n[Take Harness]\n" + this.renderHarness(this.settings.takeHarness);
    const system = "你是 Obsidian 知识库的客观评价助手。" + harness;
    const prompt = [
      this.titlePromptLine(title),
      takeBody,
    ].filter(Boolean).join("\n");

    const raw = await this.chat(system, prompt, { ...context, phase: "Take" });
    // 已按要求移除本地格式处理：不再去 ``` 围栏、不再压缩连续空行，模型返回什么就写什么。
    if (!raw) throw new Error("AI 返回了空 take");
    return raw;
  }

  async generateTitle(body, title, context = {}) {
    const titleBody = this.cleanMarkdownForSummary(body);
    const harness = `\n\n[AI Title Harness]\n${this.renderHarness(this.settings.aiTitleHarness)}`;
    const system = `你是 Obsidian 知识库的标题生成助手。${harness}`;
    // 不再硬编码「N 个标题」与「每行一个纯文本标题」—— 你的 aiTitleHarness 要求的是
    // 3 个《》包裹的标题、YAML 形式，硬编码说明会把它带偏。
    const prompt = [
      this.titlePromptLine(title),
      "请根据以下正文生成 AI_title。",
      "",
      titleBody,
    ].filter(Boolean).join("\n");

    const raw = await this.chat(system, prompt, { ...context, phase: "TITLE" });
    return this.extractTitleValues(raw);
  }

  async generateFreshness(body, title, context = {}) {
    const freshnessBody = this.cleanMarkdownForSummary(body);
    const harness = `\n\n[Freshness Harness]\n${this.renderHarness(this.settings.freshnessHarness)}`;
    const system = "你是 Obsidian 知识库的技术时效性评审助手。" + harness;
    const prompt = [
      this.titlePromptLine(title),
      "请根据以下正文生成 AI_freshness 与 AI_freshness_note。",
      "",
      freshnessBody,
    ].filter(Boolean).join("\n");

    const raw = await this.chat(system, prompt, { ...context, phase: "Freshness" });
    return this.parseFreshnessEnvelope(raw);
  }

  // Freshness 输出契约（见 DEFAULT_FRESHNESS_HARNESS）：第一行是三选一结论，第二行起是说明。
  // 这里只做「取得可写入的值」这一步；格式细节交给「格式校验」的正则去警告。
  parseFreshnessEnvelope(text) {
    const lines = String(text ?? "").replace(/\r/g, "").split("\n");
    const firstIdx = lines.findIndex((line) => line.trim() !== "");
    if (firstIdx < 0) throw new Error("AI 返回了空 AI_freshness");
    const first = lines[firstIdx].trim();
    const verdicts = ["🟢 仍可用", "🟡 部分过时", "🔴 主体过时"];
    if (!verdicts.includes(first)) {
      throw new Error(`AI_freshness 第一行必须是三选一（🟢 仍可用 / 🟡 部分过时 / 🔴 主体过时），实际是：${first.slice(0, 40)}`);
    }
    const note = lines.slice(firstIdx + 1).join("\n").trim();
    if (!note) throw new Error("AI 返回了空 AI_freshness_note");
    return { freshness: first, freshnessNote: note };
  }

  // 本地时间戳（非 UTC），写入 AI_last_verified，格式与 updated 字段同风格：YYYYMMDDhhmmssSSS（17 位）。
  todayStamp() {
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, "0");
    const p3 = (n) => String(n).padStart(3, "0");
    return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}${p3(d.getMilliseconds())}`;
  }

  // AI_title 在 frontmatter 里必须是 YAML 列表，所以「把模型输出变成数组」这一步省不掉。
  // 除此之外代码不做任何格式处理：不剥 YAML 根键、不剥 "- "、不剥代码围栏、不删空行、
  // 不删序号、不去引号、不去行尾逗号、不做数量上限。
  // 模型给什么，数组里就是什么；格式是否合格交给「格式校验」的正则去警告，不再由代码猜。
  extractTitleValues(text) {
    const trimmed = String(text ?? "").trim();
    if (!trimmed) throw new Error("AI 返回了空 AI_title");
    // 唯一的结构解包：模型若返回 JSON 数组，取数组本身（数组项就是内容，不做任何改动）
    if (trimmed.startsWith("[")) {
      try {
        const value = JSON.parse(trimmed);
        if (Array.isArray(value)) return value.map((item) => String(item ?? ""));
      } catch (_) {
        // 不是合法 JSON 数组，按行拆
      }
    }
    return trimmed.split(/\r?\n/);
  }

  // 不做任何格式校验，只负责「取得一个可写入的值」，且绝不返回 undefined。
  // technicalDepthHarness 当前要求「仅输出最终得分的整数数字」，所以：
  //   1) 纯数字（68）→ { technical_depth: 68 }
  //   2) JSON 对象（含 technical_depth 或任意字段）→ 原样返回
  //   3) 其它任何内容 → 原样放进 technical_depth 字符串，绝不丢弃、绝不抛错
  // 第 3 条很关键：上层会把 technical_depth 写进 frontmatter，一旦是 undefined，
  // Obsidian 的 YAML 序列化会省略该键，等于把 AI_technical_depth 属性行整个删掉。
  parseTechnicalDepthEnvelope(text, label = "Technical Depth") {
    const trimmed = String(text ?? "").trim();
    if (trimmed !== "" && Number.isFinite(Number(trimmed))) {
      return { technical_depth: Number(trimmed) };
    }
    try {
      const value = this.parseJsonValueWithRepair(text, label);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        // 有 technical_depth 就用它；没有就把模型原始输出写进去（原样保留，交给手动校验发现），
        // 保证本方法永远不会返回 technical_depth = undefined。
        if (value.technical_depth !== undefined) return value;
        return { technical_depth: trimmed };
      }
      if (typeof value === "number") return { technical_depth: value };
    } catch (_) {
      // 落到下面的原样字符串
    }
    return { technical_depth: trimmed };
  }

  // 已按要求移除全部标签改写：不再去开头的 #、不再去层级前缀、不再截断层级标签、
  // 不再统一大小写、不再套用技术词规范表。AI 返回什么 tag，就原样写进 AI_tags。
  // 格式是否合格交给「格式校验」的正则去警告，代码不再做任何猜测。
  // 仅保留一条机械处理：空字符串/纯空白不是内容，写入前丢掉；全空则报错，避免把已有 tags 清空。
  collectTagValues(candidates) {
    const values = [];
    for (const item of (Array.isArray(candidates) ? candidates : [])) {
      const rawValue = typeof item === "string"
        ? item
        : String((item || {}).value ?? (item || {}).tag ?? (item || {}).name ?? "");
      if (!rawValue.trim()) continue;
      values.push(rawValue);
    }
    if (!values.length) throw new StructuredOutputError("AI 没有返回任何可用 tag");
    return values.map((value) => ({ value }));
  }

  stripJsonFences(text) {
    return String(text || "")
      .replace(/^\uFEFF/, "")
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();
  }

  extractJsonValueText(text) {
    const cleaned = this.stripJsonFences(text);
    if (!cleaned) throw new StructuredOutputError("返回内容为空", text);

    // 首先优先解析完整的清理后输出。对 Tags 很重要：
    // 合法的顶层 JSON 数组必须保留最外层的 [ ]。
    try {
      JSON.parse(cleaned);
      return cleaned;
    } catch (_) {
      // 某些 OpenAI 兼容后端即使要求结构化输出，仍会在 JSON 前后夹带说明文字；此时回退到提取第一个可信 JSON 根节点，并保留对象/数组类型。
    }

    const objectStart = cleaned.indexOf("{");
    const arrayStart = cleaned.indexOf("[");
    let start = -1;
    let open = "";
    let close = "";
    if (objectStart >= 0 && (arrayStart < 0 || objectStart < arrayStart)) {
      start = objectStart;
      open = "{";
      close = "}";
    } else if (arrayStart >= 0) {
      start = arrayStart;
      open = "[";
      close = "]";
    }
    if (start < 0) throw new StructuredOutputError("返回格式中没有 JSON 对象或数组", text);

    // 查找与起始符匹配的闭合符，同时正确处理字符串引号内部的括号。
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < cleaned.length; i += 1) {
      const ch = cleaned[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === open) depth += 1;
      else if (ch === close) {
        depth -= 1;
        if (depth === 0) return cleaned.slice(start, i + 1);
      }
    }

    // 如果模型只是漏掉最后一个闭合符，仍保留完整候选文本，
    // 让后续保守修复/错误报告能够准确处理。
    return cleaned.slice(start);
  }

  escapeControlCharsInsideJsonStrings(input) {
    let out = "";
    let inString = false;
    let escaped = false;
    for (let i = 0; i < input.length; i += 1) {
      const ch = input[i];
      if (inString) {
        if (escaped) {
          out += ch;
          escaped = false;
          continue;
        }
        if (ch === "\\") {
          out += ch;
          escaped = true;
          continue;
        }
        if (ch === '"') {
          inString = false;
          out += ch;
          continue;
        }
        if (ch === "\n") { out += "\\n"; continue; }
        if (ch === "\r") { out += "\\r"; continue; }
        if (ch === "\t") { out += "\\t"; continue; }
        const code = ch.charCodeAt(0);
        if (code >= 0 && code < 0x20) {
          out += `\\u${code.toString(16).padStart(4, "0")}`;
          continue;
        }
        out += ch;
        continue;
      }
      if (ch === '"') inString = true;
      out += ch;
    }
    return out;
  }

  transformJsonOutsideStrings(input, transform) {
    let out = "";
    let outside = "";
    let inString = false;
    let escaped = false;
    const flush = () => {
      if (!outside) return;
      out += transform(outside);
      outside = "";
    };
    for (let i = 0; i < input.length; i += 1) {
      const ch = input[i];
      if (inString) {
        out += ch;
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') {
        flush();
        inString = true;
        out += ch;
      } else {
        outside += ch;
      }
    }
    flush();
    return out;
  }

  repairJsonText(input) {
    let text = String(input || "").trim();
    text = this.escapeControlCharsInsideJsonStrings(text);
    // 只修复字符串引号之外的 JSON 语法，避免改写笔记或 Tag 的真实语义。
    text = this.transformJsonOutsideStrings(text, (chunk) => chunk
      .replace(/}\s*(?={)/g, "},")
      .replace(/,\s*([}\]])/g, "$1"));
    return text;
  }

  parseJsonValueWithRepair(text, label = "结构化输出") {
    const candidate = this.extractJsonValueText(text);
    try {
      return JSON.parse(candidate);
    } catch (firstError) {
      if (this.settings.jsonRepairEnabled !== true) {
        throw new StructuredOutputError(
          `${label} JSON 解析失败：${firstError instanceof Error ? firstError.message : String(firstError)}`,
          text,
          { repairAttempted: false },
        );
      }
      const repaired = this.repairJsonText(candidate);
      try {
        const value = JSON.parse(repaired);
        console.info(`[xyblue135 私人·AI 元数据] ${label} 已通过本地 JSON 修复分支恢复。`);
        return value;
      } catch (secondError) {
        throw new StructuredOutputError(
          `${label} JSON 解析失败：${firstError instanceof Error ? firstError.message : String(firstError)}；本地修复后仍失败：${secondError instanceof Error ? secondError.message : String(secondError)}`,
          text,
          { repairAttempted: true, repairSucceeded: false, repairedText: repaired },
        );
      }
    }
  }

  parseJsonObjectWithRepair(text, label = "结构化输出") {
    const value = this.parseJsonValueWithRepair(text, label);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new StructuredOutputError(`${label} 返回格式不是 JSON 对象`, text);
    }
    return value;
  }

  firstArrayField(value, keys) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return { value: null, key: null };
    for (const key of keys) {
      if (Array.isArray(value[key])) return { value: value[key], key };
    }
    return { value: null, key: null };
  }

  // AI_tags 同样是「必须变成列表」的字段，这里只做这一步，不做任何剥离或改写：
  // 不剥 "- " 列表符号、不剥引号、不删空行、不处理 JSONL、不做字符白名单、不做数量上限。
  // 模型返回 JSON（对象里含 tags 数组，或顶层数组）时取数组本身；否则按行拆。
  // 格式是否合格交给「格式校验」的正则，不再由代码猜。
  parseTagsEnvelope(text) {
    const trimmed = String(text ?? "").trim();
    if (!trimmed) throw new StructuredOutputError("Tags 请求没有返回任何内容", text);
    try {
      const value = this.parseJsonValueWithRepair(trimmed, "Tags 请求");
      if (Array.isArray(value)) return { tags: value };
      if (value && typeof value === "object") {
        const tagsField = this.firstArrayField(value, ["tags", "weighted_tags", "weightedTags", "tag_list", "tagList"]);
        if (tagsField.value !== null) return { tags: tagsField.value };
      }
    } catch (_) {
      // 不是 JSON，按行拆
    }
    return { tags: trimmed.split(/\r?\n/) };
  }

  asStructuredOutputError(error, rawOutput, attempts = []) {
    if (error instanceof StructuredOutputError) {
      error.rawOutput = error.rawOutput || String(rawOutput || "");
      error.attempts = attempts.slice();
      if (attempts.length > 1) {
        error.rawOutput = attempts.map((item, index) => `【尝试 ${index + 1}】\n${item}`).join("\n\n");
      }
      return error;
    }
    return new StructuredOutputError(
      error instanceof Error ? error.message : String(error),
      attempts.length > 1
        ? attempts.map((item, index) => `【尝试 ${index + 1}】\n${item}`).join("\n\n")
        : rawOutput,
      { attempts: attempts.slice() },
    );
  }

  requestJsonWithHardTimeout(url, payload, timeoutMs, abortSignal = null, method = "POST") {
    return new Promise((resolve, reject) => {
      if (abortSignal && abortSignal.aborted) {
        reject(new TaskCancelledError());
        return;
      }
      let parsed;
      try {
        parsed = new URL(url);
      } catch (_) {
        reject(new Error(`无效 API URL：${url}`));
        return;
      }

      const transport = parsed.protocol === "https:" ? require("https") : require("http");
      if (!["http:", "https:"].includes(parsed.protocol)) {
        reject(new Error(`不支持的 API 协议：${parsed.protocol}`));
        return;
      }
      const normalizedMethod = String(method || "POST").toUpperCase();
      const hasBody = normalizedMethod !== "GET" && payload !== null && payload !== undefined;
      const body = hasBody ? JSON.stringify(payload) : "";
      const headers = {
        Authorization: `Bearer ${String(this.settings.apiKey || "").trim()}`,
      };
      if (hasBody) {
        headers["Content-Type"] = "application/json";
        headers["Content-Length"] = Buffer.byteLength(body);
      }

      let settled = false;
      let hardTimer = null;
      let abortHandler = null;
      const finish = (fn, value, req) => {
        if (settled) return;
        settled = true;
        if (hardTimer !== null) window.clearTimeout(hardTimer);
        if (abortSignal && abortHandler) abortSignal.removeEventListener("abort", abortHandler);
        if (req && this.activeHttpRequests) this.activeHttpRequests.delete(req);
        fn(value);
      };

      const req = transport.request({
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || undefined,
        path: `${parsed.pathname}${parsed.search}`,
        method: normalizedMethod,
        headers,
      }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try { json = text ? JSON.parse(text) : {}; } catch (_) { json = null; }
          finish(resolve, { status: Number(res.statusCode || 0), text, json, headers: res.headers || {} }, req);
        });
      });

      this.activeHttpRequests.add(req);
      abortHandler = () => req.destroy(new TaskCancelledError());
      if (abortSignal) abortSignal.addEventListener("abort", abortHandler, { once: true });
      hardTimer = window.setTimeout(() => {
        req.destroy(new Error(`API 请求超时（${Math.round(timeoutMs / 1000)} 秒）`));
      }, timeoutMs);
      req.on("error", (error) => finish(reject, error, req));
      if (hasBody) req.write(body);
      req.end();
    });
  }

  async chat(system, user, context = {}) {
    return this.enqueueApiRequest(async () => {
      const baseUrl = String(this.settings.baseUrl || DEFAULT_SETTINGS.baseUrl).replace(/\/+$/, "");
      const timeoutMs = Math.max(1, Number(this.settings.requestTimeoutSeconds) || 180) * 1000;
      // 不再硬编码 response_format=json_object：那是在 API 层强制模型只能输出 JSON，
      // 会与「只输出整数分」「输出 YAML」「逐行文本」等 Harness 直接冲突。
      // 输出形态完全交给各字段的 Harness，本地解析按最宽容的方式兜底。
      const payload = {
        model: String(this.settings.model || "auto").trim() || "auto",
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0.2,
      };
      const response = await this.requestJsonWithHardTimeout(`${baseUrl}/chat/completions`, payload, timeoutMs, context.abortSignal || null);
      this.ensureTaskActive(context.abortSignal);

      if (response.status < 200 || response.status >= 300) {
        const detail = (response.text || "").slice(0, 500) || `HTTP ${response.status}`;
        throw new Error(`API ${response.status}: ${detail}`);
      }
      const data = response.json;
      // 1.10：非 JSON 响应（Base URL 写错、网关返回 HTML 错误页、返回纯文本或 SSE）在 HTTP 200 下也会出现：
      // 此时必须把原始响应体带出来，否则真实原因会被“没有 choices[0].message.content”掩盖。
      if (data === null || typeof data !== "object") {
        const preview = (response.text || "").replace(/\s+/g, " ").trim().slice(0, 200) || "（响应体为空）";
        throw new Error(`API 响应不是 JSON（HTTP ${response.status}）：${preview}`);
      }
      if (data.error && data.error.message) throw new Error(data.error.message);
      const content = data.choices?.[0]?.message?.content;
      if (typeof content === "string") return content.trim();
      if (Array.isArray(content)) {
        return content.map((part) => (part && typeof part.text === "string" ? part.text : "")).join("").trim();
      }
      // 兜底报错也附上响应体片段，便于定位网关/代理问题
      const bodyPreview = (response.text || "").replace(/\s+/g, " ").trim().slice(0, 300);
      throw new Error(`API 返回中没有 choices[0].message.content${bodyPreview ? `：${bodyPreview}` : ""}`);
    }, context);
  }

  // 完成度 = 「键存在 且 有内容」。
  // 注意这与「格式校验」是两件事：这里只判断有没有内容，不做任何格式判断。
  // 之所以把「值为空」也算未完成，是因为待更新面板的职责就是「补充空数据」：
  // 库里存在大量 AI_title: "" / AI_take: "" / AI_technical_depth: 这类空壳，
  // 如果只判断键是否存在，它们会被误判为已完成、在面板上永远看不到。
  getMetadataCompletion(file, fingerprint, frontmatterOverride = null) {
    void fingerprint;
    // 1.2：metadataCache 未就绪（刚启动 / 刚被其它工具或本插件改写）时 getFileCache 返回 null，
    // 若直接用空对象判断，7 个字段会被当成「全缺」，随后「运行前清空本次字段」会把完好的 AI 字段覆盖成空。
    // 因此优先使用调用方从磁盘原文解析出的 frontmatter，解析不到时才回退到 metadataCache。
    const cachedFrontmatter = this.aiFrontmatter(file);
    const fm = frontmatterOverride || cachedFrontmatter;
    const hasKey = (key) => Object.prototype.hasOwnProperty.call(fm, key);
    const hasContent = (key) => {
      if (!hasKey(key)) return false;
      const value = fm[key];
      if (Array.isArray(value)) return value.some((item) => String(item ?? "").trim() !== "");
      if (value === null || value === undefined) return false;
      if (typeof value === "string") return value.trim() !== "";
      // 数字（含 0 分）与布尔都算有内容
      return true;
    };
    return {
      titleDone: hasContent("AI_title"),
      summaryShortDone: hasContent("AI_summary_short"),
      summaryLongDone: hasContent("AI_summary_long"),
      tagsDone: hasContent("AI_tags"),
      technicalDepthDone: hasContent("AI_technical_depth"),
      takeDone: hasContent("AI_take"),
      qaDone: hasContent("AI_qa"),
    };
  }

  clearPersistentFingerprintMarkers() {
    const files = this.state && this.state.files ? this.state.files : {};
    for (const record of Object.values(files)) {
      if (!record || typeof record !== "object") continue;
      delete record.lastSeenSourceHash;
      delete record.lastSummaryHash;
      delete record.lastSummaryShortHash;
      delete record.lastSummaryLongHash;
      delete record.lastTagsHash;
      delete record.lastTechnicalDepthHash;
      delete record.lastTakeHash;
      delete record.lastQaHash;
      delete record.lastTitleHash;
    }
  }

  // 内容指纹已下线（contentFingerprintEnabled 在 onload 恒为 false）：本方法只清除历史 Hash 标记与上次错误信息。
  // 参数 fingerprint / kindOrKinds 保留以兼容既有调用点签名。
  markProcessed(file, fingerprint, kindOrKinds) {
    void fingerprint;
    void kindOrKinds;
    const record = this.state.files[file.path] || {};

    delete record.lastSummaryHash;
    delete record.lastSummaryShortHash;
    delete record.lastSummaryLongHash;
    delete record.lastTagsHash;
    delete record.lastTechnicalDepthHash;
    delete record.lastTakeHash;
    delete record.lastQaHash;
    delete record.lastTitleHash;
    // 成功后只清理真正会被 UI 使用的错误状态；不再保存审计时间、来源、reason、tag scores 或 updateLog。
    record.lastError = "";
    record.lastErrorType = "";
    record.lastRawModelOutput = "";
    this.state.files[file.path] = record;
    this.scheduleStateSave();
  }

  normalizeFolderPath(folderPath) {
    const roots = this.whitelistRoots();
    const root = roots[0];
    const normalized = String(folderPath || root)
      .trim()
      .replace(/\\/g, "/")
      .replace(/^\/+|\/+$/g, "") || root;
    if (roots.some((r) => normalized === r || normalized.startsWith(`${r}/`))) return normalized;
    return root;
  }

  getFolderPathForFile(file) {
    const slash = file.path.lastIndexOf("/");
    return slash >= 0 ? file.path.slice(0, slash) : this.normalizeWhitelistFolder();
  }

  getFilesInFolder(folderPath) {
    const folder = this.normalizeFolderPath(folderPath);
    return this.getRecognitionFiles().filter((file) => {
      const parent = this.getFolderPathForFile(file);
      return parent === folder || parent.startsWith(`${folder}/`);
    });
  }

  makeNotePreview(raw, maxChars = 140) {
    let text = String(raw || "");
    if (text.startsWith("---")) {
      const end = text.indexOf("\n---", 3);
      if (end >= 0) text = text.slice(end + 4);
    }
    text = text
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/[*_~>|]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return text.length > maxChars ? `${text.slice(0, maxChars).trim()}…` : text;
  }

  async inspectMetadataFile(file, includePreview = false) {
    try {
      const raw = await this.app.vault.cachedRead(file);
      // 1.11：内容指纹已下线（contentFingerprintEnabled 恒为 false）：面板不必为每篇再算一次全文哈希。
      const fingerprint = "";
      const record = this.state.files[file.path] || {};
      const body = this.stripFrontmatter(raw).trim();
      const emptyBody = !body;
      // 用磁盘原文解析出的 frontmatter 判断完成度，避免 metadataCache 滞后造成「7 项全缺」误判。
      const rawFrontmatter = this.parseFrontmatterFromRaw(await this.readAiSourceRaw(file));
      const { titleDone, summaryShortDone, summaryLongDone, tagsDone, technicalDepthDone, takeDone, qaDone } = this.getMetadataCompletion(file, fingerprint, rawFrontmatter);
      return {
        file,
        folder: this.getFolderPathForFile(file),
        fingerprint,
        titleDone,
        summaryShortDone,
        summaryLongDone,
        tagsDone,
        technicalDepthDone,
        takeDone,
        qaDone,
        emptyBody,
        pending: !emptyBody && (!titleDone || !summaryShortDone || !summaryLongDone || !tagsDone || !technicalDepthDone || !takeDone || !qaDone),
        preview: includePreview ? (emptyBody ? "（无可分析正文）" : this.makeNotePreview(raw)) : "",
        lastError: emptyBody ? "" : (record.lastError || ""),
        lastErrorType: record.lastErrorType || "",
        lastRawModelOutput: record.lastRawModelOutput || "",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        file,
        folder: this.getFolderPathForFile(file),
        fingerprint: "",
        titleDone: false,
        summaryShortDone: false,
        summaryLongDone: false,
        tagsDone: false,
        technicalDepthDone: false,
        takeDone: false,
        qaDone: false,
        pending: true,
        preview: "读取预览失败",
        lastError: message,
        // 1.25：异常分支也要补齐与成功分支一致的对象形状，否则界面会显示 undefined
        lastErrorType: "READ_FAILED",
        lastRawModelOutput: "",
        emptyBody: false,
      };
    }
  }

  // 1.8：巡检结果缓存：key 为路径，命中条件为 mtime、是否要预览、以及该文件「上次错误」信息完全一致。
  // 这些正是 inspectMetadataFile 结果的全部输入；命中后可直接复用，不再读盘。
  async getCachedInspection(file, includePreview, inspectCache = null) {
    if (!inspectCache) return this.inspectMetadataFile(file, includePreview);
    const record = this.state.files[file.path] || {};
    const stamp = [
      file.mtime,
      includePreview ? 1 : 0,
      record.lastError || "",
      record.lastErrorType || "",
      record.lastRawModelOutput || "",
    ].join("|");
    const cached = inspectCache.get(file.path);
    if (cached && cached.stamp === stamp) return cached.info;
    const info = await this.inspectMetadataFile(file, includePreview);
    inspectCache.set(file.path, { stamp, info });
    return info;
  }

  async getPendingDashboardData(includePreview = true, inspectCache = null) {
    const allFiles = this.getNotesFiles();
    const files = this.settings.statusDoneOnlyEnabled === true
      ? allFiles.filter((file) => this.isRecognitionEligible(file))
      : allFiles;
    const statusFilteredSkipped = Math.max(0, allFiles.length - files.length);
    const infos = [];
    const groups = new Map();
    const root = this.normalizeWhitelistFolder();
    const roots = this.whitelistRoots();
    let pending = 0;
    let done = 0;
    let emptySkipped = 0;

    const ensureGroup = (folder) => {
      if (!groups.has(folder)) {
        groups.set(folder, {
          folder,
          total: 0,
          pending: 0,
          done: 0,
          emptySkipped: 0,
          recursiveTotal: 0,
          recursivePending: 0,
          recursiveDone: 0,
          recursiveEmptySkipped: 0,
          files: [],
        });
      }
      return groups.get(folder);
    };

    for (const groupRoot of roots) ensureGroup(groupRoot);
    for (const file of files) {
      // 1.8：走按 mtime 失效的巡检缓存：面板刷新、补全单篇后只重读真正变化的文件，
      // 避免每补一篇就把整库 Markdown 重新 cachedRead 并跑预览正则（O(n) 热路径）。
      const info = await this.getCachedInspection(file, includePreview, inspectCache);
      infos.push(info);
      if (info.emptyBody) emptySkipped += 1;
      else if (info.pending) pending += 1;
      else done += 1;

      const direct = ensureGroup(info.folder);
      direct.total += 1;
      if (info.emptyBody) direct.emptySkipped += 1;
      else if (info.pending) direct.pending += 1;
      else direct.done += 1;
      direct.files.push(info);

      // 1.11：一次遍历顺手沿祖先链累加 recursive* 计数：原来这里是 groups × infos 的 O(目录数 × 文件数)
      // 双层扫描，文件上千时会明显拖慢面板。
      let cursor = info.folder;
      while (true) {
        const group = ensureGroup(cursor);
        group.recursiveTotal += 1;
        if (info.emptyBody) group.recursiveEmptySkipped += 1;
        else if (info.pending) group.recursivePending += 1;
        else group.recursiveDone += 1;
        if (roots.includes(cursor)) break;
        const ownerRoot = roots.find((r) => cursor === r || cursor.startsWith(`${r}/`)) || roots[0];
        const slash = cursor.lastIndexOf("/");
        const parent = slash >= 0 ? cursor.slice(0, slash) : ownerRoot;
        if (parent !== ownerRoot && !parent.startsWith(`${ownerRoot}/`)) break;
        cursor = parent;
      }
    }

    for (const group of groups.values()) {
      group.files.sort((a, b) => {
        if (a.pending !== b.pending) return a.pending ? -1 : 1;
        return a.file.path.localeCompare(b.file.path, "zh-CN");
      });
    }

    const folders = Array.from(groups.values()).sort((a, b) => {
      if ((a.recursivePending > 0) !== (b.recursivePending > 0)) return a.recursivePending > 0 ? -1 : 1;
      const depthA = a.folder.split("/").length;
      const depthB = b.folder.split("/").length;
      if (depthA !== depthB) return depthA - depthB;
      return a.folder.localeCompare(b.folder, "zh-CN");
    });
    return {
      total: files.length,
      whitelistTotal: allFiles.length,
      statusFilteredSkipped,
      statusFilterEnabled: this.settings.statusDoneOnlyEnabled === true,
      pending,
      done,
      emptySkipped,
      folders,
    };
  }

  openPendingNotesDashboard() {
    new PendingNotesDashboardModal(this.app, this).open();
  }

  // 把 frontmatter 里的值整理成单元格文本。
  // 数组（AI_title / AI_tags）逐项换行；AI_qa 本身是多行块标量，原样保留换行。
  csvCellValue(value) {
    if (value === null || value === undefined) return "";
    if (Array.isArray(value)) {
      return value
        .map((item) => (item === null || item === undefined ? "" : String(item).trim()))
        .filter((item) => item.length > 0)
        .join("\n");
    }
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  }

  // RFC 4180：含逗号、双引号或换行的字段必须用双引号包裹，内部双引号翻倍。
  csvEscapeCell(value) {
    const text = String(value === null || value === undefined ? "" : value);
    if (!/[",\r\n]/.test(text)) return text;
    return `"${text.split("\"").join("\"\"")}"`;
  }

  // 该笔记是否"被识别过"：10 个 AI 字段里至少有一个有内容。
  // 空字符串、空数组都算没内容；AI_technical_depth 的 0 分是有效分数，算有内容。
  hasAnyAiMetadata(file) {
    const frontmatter = this.aiFrontmatter(file);
    return METADATA_KINDS.some((kind) => this.csvCellValue(frontmatter[this.fieldKeyForKind(kind)]) !== "");
  }

  // 导出白名单目录下已被识别过的 Markdown 的 AI 元数据为 CSV，并打包成 ai-metadata-notes.zip：
  // 第一列是笔记标题（文件名去扩展名，比仓库内路径短），随后一列一个元数据字段。
  // 完全没有 AI 元数据的笔记不导出（避免大量空行）。
  async exportMetadataCsv(showNotice = true) {
    const root = this.normalizeWhitelistFolder();
    const allFiles = this.getNotesFiles().slice();
    const files = allFiles.filter((file) => this.hasAnyAiMetadata(file));
    const unrecognized = allFiles.length - files.length;
    // 按标题排序：CSV 第一列就是标题，同名笔记会相邻，重名一眼可见。
    files.sort((a, b) => a.basename.localeCompare(b.basename) || a.path.localeCompare(b.path));

    if (!files.length) {
      if (showNotice) {
        new Notice(allFiles.length
          ? `xyblue135 私人·AI 元数据：${root} 下 ${allFiles.length} 篇笔记都还没有 AI 元数据，暂无可导出的内容`
          : `xyblue135 私人·AI 元数据：${root} 目录下没有 Markdown 文件`, 9000);
      }
      return { path: "", csvName: "", bytes: 0, count: 0, filledCells: 0, unrecognized, duplicateTitles: [] };
    }

    const columns = ["title", ...this.kindsInConfiguredOrder().map((kind) => this.fieldKeyForKind(kind))];
    const lines = [columns.map((name) => this.csvEscapeCell(name)).join(",")];
    let filledCells = 0;
    const titleCounts = new Map();

    for (const file of files) {
      const frontmatter = this.aiFrontmatter(file);
      const values = this.kindsInConfiguredOrder().map((kind) => this.csvCellValue(frontmatter[this.fieldKeyForKind(kind)]));
      filledCells += values.filter((value) => value !== "").length;
      titleCounts.set(file.basename, (titleCounts.get(file.basename) || 0) + 1);
      lines.push([file.basename, ...values].map((cell) => this.csvEscapeCell(cell)).join(","));
    }

    // 第一列只有标题，重名笔记在 CSV 里无法区分。这里统计出来，在提示里明确告知。
    const duplicateTitles = [...titleCounts.entries()].filter(([, count]) => count > 1).map(([title, count]) => ({ title, count }));

    // Excel / WPS 需要 BOM 才能把无 BOM 的 UTF-8 中文认成中文，这里显式加上。
    const csv = "\uFEFF" + lines.join("\r\n") + "\r\n";
    // 导出物统一改成压缩包：zip 里放这一个 CSV，仓库根目录只留 .zip。
    const csvName = "ai-metadata-notes.csv";
    const path = "ai-metadata-notes.zip";
    const written = await this.writeZipToVault(path, [{ name: csvName, data: new TextEncoder().encode(csv) }]);

    if (showNotice) {
      const total = files.length * METADATA_KINDS.length;
      const duplicateNote = duplicateTitles.length
        ? `；注意 ${duplicateTitles.length} 组标题重名（${duplicateTitles.map((item) => `「${item.title}」×${item.count}`).join("、")}），仅凭标题无法区分`
        : "";
      new Notice(`xyblue135 私人·AI 元数据：已导出 ${files.length} 篇已识别笔记 × ${METADATA_KINDS.length} 个字段（已填 ${filledCells}/${total}）${unrecognized ? `；另有 ${unrecognized} 篇无任何 AI 元数据，未导出` : ""}${duplicateNote} → ${path}（内含 ${csvName}，${formatByteSize(written.bytes)}）`, 12000);
    }
    return { path, csvName, bytes: written.bytes, count: files.length, filledCells, unrecognized, duplicateTitles };
  }

  // ==================== 导出白名单内的文章（打包为 zip） ====================
  // 目标：与白名单目录同级的「白名单目录名 + _白名单.zip」（00_docs → 00_docs_白名单.zip）。
  // 内容：白名单目录及其子目录中 frontmatter status: done 的 Markdown，原样打包并保留完整子目录树。
  // 全局强制过滤：不参考「元数据 status 校验」开关，status 不是 done（含未设置）的一律不导出。
  // 包内不压缩（store）：体积约等于原文总和，但速度最快；同名文件在包内天然只有一份，不会残留旧内容。
  getArticleExportZipPath() {
    const root = this.normalizeWhitelistFolder();
    const slash = root.lastIndexOf("/");
    const parent = slash >= 0 ? root.slice(0, slash + 1) : "";
    const base = slash >= 0 ? root.slice(slash + 1) : root;
    return `${parent}${base}_白名单.zip`;
  }

  // 逐层创建目录；已存在则跳过（避免 vault.createFolder 在目录已存在时抛错）。
  async ensureVaultFolder(folderPath) {
    const clean = String(folderPath || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (!clean) return;
    let current = "";
    for (const part of clean.split("/")) {
      if (!part) continue;
      current = current ? `${current}/${part}` : part;
      if (this.app.vault.getAbstractFileByPath(current)) continue;
      try {
        await this.app.vault.createFolder(current);
      } catch (error) {
        if (!this.app.vault.getAbstractFileByPath(current)) throw error;
      }
    }
  }

  // 把 entries 打包成 zip 并写入 Vault（已存在则整体覆盖）。
  // entries: [{ name: "sub/a.md", data: Uint8Array }]
  async writeZipToVault(path, entries) {
    const bytes = buildZipArchive(entries);
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const slash = path.lastIndexOf("/");
    if (slash >= 0) await this.ensureVaultFolder(path.slice(0, slash));
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await this.app.vault.modifyBinary(existing, buffer);
    } else if (existing) {
      throw new Error(`同名路径已被文件夹占用：${path}`);
    } else {
      await this.app.vault.createBinary(path, buffer);
    }
    return { path, bytes: bytes.length, count: entries.length };
  }

  async exportWhitelistArticles(showNotice = true) {
    const root = this.normalizeWhitelistFolder();
    const zipPath = this.getArticleExportZipPath();
    const allFiles = this.getNotesFiles();
    const files = allFiles
      .filter((file) => this.getMetadataStatus(file) === "done")
      .slice()
      .sort((a, b) => a.path.localeCompare(b.path));
    const skipped = allFiles.length - files.length;

    if (!files.length) {
      if (showNotice) {
        new Notice(allFiles.length
          ? `xyblue135 私人·AI 元数据：${root} 下 ${allFiles.length} 篇笔记都不是 status: done，未生成压缩包`
          : `xyblue135 私人·AI 元数据：${root} 目录下没有 Markdown 文件`, 9000);
      }
      return { root, zipPath, count: 0, skipped, bytes: 0, failed: [], exported: [] };
    }

    const encoder = new TextEncoder();
    const entries = [];
    const failed = [];
    for (const file of files) {
      const relative = file.path.slice(root.length + 1);
      if (!relative) continue;
      try {
        const content = await this.app.vault.read(file);
        entries.push({ name: relative, data: encoder.encode(content) });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failed.push({ path: relative, message });
        this.appendLog("error", `导出文章失败：${relative}：${message}`, { filePath: file.path, phase: "导出白名单文章" });
      }
    }

    // 1.9：所有文件都读取失败时 entries 为空：此时绝不能覆盖上一次的成功导出包，
    // 否则一次可用的备份会被一个 0 条记录的 zip 清空。
    if (!entries.length) {
      const reason = failed.length ? `全部 ${failed.length} 篇读取失败` : "没有可导出的内容";
      this.appendLog("error", `导出白名单文章：${reason}，已保留上一次的导出包（未覆盖 ${zipPath}）`, { phase: "导出白名单文章" });
      if (showNotice) {
        new Notice(`xyblue135 私人·AI 元数据：导出失败（${reason}），已保留上一次的导出包；详见运行日志`, 12000);
      }
      return { root, zipPath, count: 0, skipped, bytes: 0, failed, exported: [], error: reason };
    }

    const written = await this.writeZipToVault(zipPath, entries);
    this.appendLog("info", `导出白名单文章：打包 ${entries.length} 篇（${formatByteSize(written.bytes)}），跳过 ${skipped} 篇非 done → ${zipPath}`, { phase: "导出白名单文章" });

    if (showNotice) {
      const parts = [`已把 ${entries.length} 篇 status: done 的文章打包（保留原目录树）→ ${zipPath}（${formatByteSize(written.bytes)}）`];
      if (skipped) parts.push(`跳过 ${skipped} 篇非 done`);
      if (failed.length) parts.push(`失败 ${failed.length} 篇（见运行日志）`);
      new Notice(`xyblue135 私人·AI 元数据：${parts.join("；")}`, 12000);
    }

    return { root, zipPath, count: entries.length, skipped, bytes: written.bytes, failed, exported: entries.map((entry) => entry.name) };
  }

  // 导出 8 个可 AI 生成字段及其提示词（Harness）为 CSV，并打包成 ai-metadata-fields.zip。
  async exportPromptFieldsCsv(showNotice = true) {
    const s = this.settings;
    // 目前共 8 个可 AI 生成的字段（4 个核心元数据 + 3 个增值字段 + 时效性评估）
    const rows = [
      ["summary_short", "短摘要", "summaryShortHarness", s.summaryShortHarness],
      ["summary_long", "长摘要", "summaryLongHarness", s.summaryLongHarness],
      ["tags", "带权重标签", "tagsHarness", s.tagsHarness],
      ["technical_depth", "技术深度评分", "technicalDepthHarness", s.technicalDepthHarness],
      ["take", "锐评", "takeHarness", s.takeHarness],
      ["_qa", "面试问答", "qaHarness", s.qaHarness],
      ["aiTitle", "标题", "aiTitleHarness", s.aiTitleHarness],
      ["freshness", "时效性评估", "freshnessHarness", s.freshnessHarness],
    ];
    const Q = String.fromCharCode(34);
    const esc = (v) => Q + String(v == null ? "" : v).split(Q).join(Q + Q) + Q;
    // 和元数据 CSV 保持一致：带 UTF-8 BOM，Excel / WPS 打开中文才不会乱码。
    const csv = "\uFEFF" + [["field", "label", "setting_key", "prompt"], ...rows]
      .map((row) => row.map(esc).join(","))
      .join("\r\n") + "\r\n";
    const csvName = "ai-metadata-fields.csv";
    const zipPath = "ai-metadata-fields.zip";
    const written = await this.writeZipToVault(zipPath, [{ name: csvName, data: new TextEncoder().encode(csv) }]);
    if (showNotice) {
      new Notice(`xyblue135 私人·AI 元数据：已把 8 个字段的提示词导出为 ${zipPath}（内含 ${csvName}，${formatByteSize(written.bytes)}）`, 9000);
    }
    return { path: zipPath, csvName, bytes: written.bytes, count: rows.length };
  }

  async retrySingleMetadataFile(file, showNotice = true) {
    if (!(file instanceof TFile) || file.extension !== "md" || !this.isWhitelisted(file)) {
      if (showNotice) new Notice("xyblue135 私人·AI 元数据：只能重试白名单目录中的 Markdown");
      return { success: false, message: "文件不在白名单" };
    }
    if (this.autoRunning || this.fileBusy.has(file.path)) {
      if (showNotice) new Notice("xyblue135 私人·AI 元数据：已有任务正在运行，请稍后重试");
      return { success: false, message: "已有任务正在运行" };
    }
    if (!String(this.settings.apiKey || "").trim()) {
      if (showNotice) new Notice("xyblue135 私人·AI 元数据：API Key 为空，无法重试");
      return { success: false, message: "API Key 为空" };
    }
    // 与批量识别保持一致：开启 status 校验时，只有 status: done 的文章才能操作。
    // （之前这里没有检查，导致 undone 的文章也能被这个按钮处理。）
    if (!this.isRecognitionEligible(file)) {
      const rawStatus = this.getMetadataStatus(file);
      const status = rawStatus === null ? "未知（元数据缓存未就绪）" : rawStatus || "未设置";
      if (showNotice) new Notice(`xyblue135 私人·AI 元数据：${file.basename} 的 status 为 ${status}，按规则只处理 status: done 的文章`, 7000);
      return { success: false, skipped: true, message: `status 不是 done（${status}）` };
    }
    // 只补「键不存在」的字段，绝不覆盖已有内容（之前这里调用 generateAllForFile，
    // 会把 7 个字段全部重新生成一遍）。
    const pendingKinds = await this.getPendingKinds(file);
    if (!pendingKinds.length) {
      if (showNotice) new Notice(`xyblue135 私人·AI 元数据：${file.basename} 的全部 AI 字段均已存在，本次不做任何改动`);
      return { success: false, skipped: true, message: "没有缺失字段" };
    }

    if (this.autoTimeoutId !== null) {
      window.clearTimeout(this.autoTimeoutId);
      this.autoTimeoutId = null;
    }
    this.nextAutoRunAt = 0;
    this.autoRunning = true;
    this.cycleMode = "manual-single-retry";
    this.fileBusy.add(file.path);
    try {
      await this.generateSelectedForFile(file, pendingKinds, "manual-retry", { index: 1, total: 1 }, {
        respectStatusFilter: this.settings.statusDoneOnlyEnabled === true,
      });
      await this.saveAllData();
      if (showNotice) new Notice(`xyblue135 私人·AI 元数据：已补全 ${pendingKinds.length} 项：${file.basename}`);
      return { success: true, message: "补全成功" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const record = this.state.files[file.path] || {};
      if (error && error.code === "EMPTY_BODY") {
        record.lastError = "";
        record.lastErrorType = "";
        record.lastRawModelOutput = "";
        this.state.files[file.path] = record;
        await this.saveAllData();
        if (showNotice) new Notice(`xyblue135 私人·AI 元数据：跳过 ${file.basename}：无可分析正文`);
        return { success: false, skipped: true, message: "无可分析正文" };
      }
      if (error && error.code === "SOURCE_CHANGED") {
        record.lastError = "";
        record.lastErrorType = "";
        record.lastRawModelOutput = "";
        this.state.files[file.path] = record;
        await this.saveAllData();
        if (showNotice) new Notice(`xyblue135 私人·AI 元数据：正文已变动，本次 API 请求未发出：${file.basename}`, 7000);
        return { success: false, skipped: true, message: "正文已变动，请求未发出" };
      }
      record.lastError = message.slice(0, 1000);
      record.lastErrorType = error && error.code ? String(error.code) : "ERROR";
      record.lastRawModelOutput = error && error.rawOutput ? String(error.rawOutput).slice(0, 16000) : "";
      this.state.files[file.path] = record;
      await this.saveAllData();
      this.appendLog("error", message, {
        filePath: file.path,
        errorType: record.lastErrorType,
        raw: record.lastRawModelOutput,
      });
      if (showNotice) new Notice(`xyblue135 私人·AI 元数据：重试仍失败：${message}`, 7000);
      return { success: false, message, rawOutput: record.lastRawModelOutput };
    } finally {
      this.fileBusy.delete(file.path);
      this.autoRunning = false;
      this.cycleMode = null;
      if (!this.unloading) {
        this.setRuntimeStatus("idle");
        this.refreshStatusBar();
      }
    }
  }

  async generateAiInfoForFile(file) {
    const result = await this.retrySingleMetadataFile(file, false);
    if (result.success) {
      new Notice(`xyblue135 私人·AI 元数据：已生成 ${file.basename} 的 AI 信息`);
      this.scheduleInjection();
    } else if (result.skipped) {
      // 1.12：不能统一写成「无可分析正文」：status 过滤、7 项已齐全也会走到这里，会误导用户去删正文。
      new Notice(`xyblue135 私人·AI 元数据：跳过 ${file.basename}：${result.message || "未说明原因"}`, 7000);
    } else {
      new Notice(`xyblue135 私人·AI 元数据：未能生成 AI 信息：${result.message}`, 7000);
    }
  }

  async runPendingFolder(folderPath, showNotice = true, onProgress = null) {
    const folder = this.normalizeFolderPath(folderPath);
    const root = this.normalizeWhitelistFolder();
    if (folder === root) {
      if (showNotice) new Notice("xyblue135 私人·AI 元数据：请选择 00_docs 下的具体子文件夹；根目录不提供‘处理全部待更新’入口");
      return null;
    }
    if (this.autoRunning) {
      if (showNotice) new Notice("xyblue135 私人·AI 元数据：已有自动/文件夹同步任务正在运行");
      return null;
    }
    if (!String(this.settings.apiKey || "").trim()) {
      if (showNotice) new Notice("xyblue135 私人·AI 元数据：API Key 为空，无法同步文件夹");
      return null;
    }

    if (this.autoTimeoutId !== null) {
      window.clearTimeout(this.autoTimeoutId);
      this.autoTimeoutId = null;
    }
    this.nextAutoRunAt = 0;
    this.autoRunning = true;
    this.cycleMode = "manual-folder";
    const controller = new AbortController();
    const run = { folder, controller, startedAt: Date.now() };
    this.manualFolderRun = run;
    this.setRuntimeStatus("scanning", { phase: `扫描 ${folder}` });

    const processedFiles = [];
    const failedFiles = [];
    const skippedFiles = [];
    // 7 项都已有内容的笔记不会进入 pendingFiles，也不该出现在任何列表里（否则一个文件夹会刷出上百条）。
    // 只统计数量，用来解释"为什么这篇没动"。
    let alreadyComplete = 0;
    let cancelled = false;
    // 本轮巡检缓存：写过的文件 mtime 会变、自动失效，未变动的文件不必重复 cachedRead。
    const inspectCache = new Map();
    try {
      const candidates = this.getFilesInFolder(folder);
      const pendingFiles = [];
      for (const file of candidates) {
        this.ensureTaskActive(controller.signal);
        const info = await this.getCachedInspection(file, false, inspectCache);
        if (info.emptyBody) {
          skippedFiles.push({ path: file.path, message: "无可分析正文", kind: "empty-body" });
        } else if (info.pending) {
          pendingFiles.push({
            file,
            queuedPath: file.path,
            titleDone: info.titleDone,
            summaryShortDone: info.summaryShortDone,
            summaryLongDone: info.summaryLongDone,
            tagsDone: info.tagsDone,
            technicalDepthDone: info.technicalDepthDone,
            takeDone: info.takeDone,
            qaDone: info.qaDone,
          });
        } else {
          alreadyComplete += 1;
        }
      }

      if (typeof onProgress === "function") onProgress({ phase: "start", folder, total: pendingFiles.length });

      if (!pendingFiles.length) {
        this.lastCycleSummary = `${folder}：没有待更新笔记；已有全部内容 ${alreadyComplete} 篇；跳过无正文 ${skippedFiles.length}`;
        await this.saveAllData();
        if (showNotice) new Notice(`xyblue135 私人·AI 元数据：${folder} 当前没有待更新笔记（${alreadyComplete} 篇全部字段均已有内容，识别不会覆盖已有内容）；无正文跳过 ${skippedFiles.length}`, 9000);
        return { folder, processedFiles, failedFiles, skippedFiles, alreadyComplete, remaining: 0, cancelled: false };
      }

      for (let index = 0; index < pendingFiles.length; index += 1) {
        if (controller.signal.aborted) {
          cancelled = true;
          break;
        }
        this.ensureLifecycleActive();
        const queued = pendingFiles[index];
        const file = queued.file;
        const progress = { index: index + 1, total: pendingFiles.length };

        // v0.5.0 范围漂移保护：队列只是启动时快照，文件当前路径才是最终依据；任务开始后移出所选目录的文件会直接跳过。
        try {
          this.assertFileStillInFolder(file, folder);
          this.assertRecognitionEligible(file);
        } catch (error) {
          const message = error && error.code === "FILE_LEFT_SCOPE"
            ? "任务执行期间文件已移出当前识别目录"
            : error && error.code === "STATUS_NOT_DONE"
              ? "文章 status 已不再是 done，按元数据校验规则跳过"
              : (error instanceof Error ? error.message : String(error));
          const path = file && file.path ? file.path : queued.queuedPath;
          skippedFiles.push({
            path,
            originalPath: queued.queuedPath,
            message,
            kind: error && error.code === "FILE_LEFT_SCOPE"
              ? "moved-out"
              : error && error.code === "STATUS_NOT_DONE"
                ? "status-filtered"
                : "unavailable",
          });
          if (typeof onProgress === "function") onProgress({ phase: "skipped", folder, filePath: path, message, ...progress });
          continue;
        }

        const currentPath = file.path;
        if (typeof onProgress === "function") onProgress({ phase: "processing", folder, filePath: currentPath, ...progress });
        if (this.fileBusy.has(currentPath)) {
          skippedFiles.push({ path: currentPath, message: "文件正在处理中", kind: "busy" });
          if (typeof onProgress === "function") onProgress({ phase: "skipped", folder, filePath: currentPath, message: "文件正在处理中", ...progress });
          continue;
        }
        const busyPath = currentPath;
        this.fileBusy.add(busyPath);
        try {
          const taskContext = {
            abortSignal: controller.signal,
            scopeFolder: folder,
            respectStatusFilter: true,
          };
          // 已有内容的字段不参与本次生成（只补缺失字段）。这里显式记录被跳过的字段，
          // 否则文件会被计入「成功」，而用户关心的那个字段其实一动没动 —— 这正是误导性反馈的来源。
          // 两个列表都按 METADATA_KINDS 的统一顺序输出，和 CSV 导出的列顺序保持一致。
          const doneByKind = {
            ai_title: queued.titleDone,
            tags: queued.tagsDone,
            summary_short: queued.summaryShortDone,
            summary_long: queued.summaryLongDone,
            technical_depth: queued.technicalDepthDone,
            take: queued.takeDone,
            qa: queued.qaDone,
          };
          const missingKinds = METADATA_KINDS.filter((kind) => !doneByKind[kind]);
          const untouchedKinds = METADATA_KINDS.filter((kind) => doneByKind[kind]);
          if (missingKinds.length) {
            await this.generateSelectedForFile(file, missingKinds, "manual-folder", progress, taskContext);
          } else {
            skippedFiles.push({ path: file.path, message: "全部字段均已有内容，未重新生成", kind: "already-complete" });
            continue;
          }
          const regeneratedNames = missingKinds.map((kind) => this.fieldKeyForKind(kind));
          const untouchedNames = untouchedKinds.map((kind) => this.fieldKeyForKind(kind));
          processedFiles.push({ path: file.path, regenerated: regeneratedNames, untouched: untouchedNames });
          // 实时进度行是 nowrap + 省略号，这里只给短摘要；完整字段清单放在结果面板里逐文件列出。
          const successMessage = untouchedNames.length
            ? `已重新生成 ${regeneratedNames.length} 项，另有 ${untouchedNames.length} 项已有内容未重新生成`
            : `已重新生成 ${regeneratedNames.length} 项`;
          if (typeof onProgress === "function") onProgress({ phase: "success", folder, filePath: file.path, message: successMessage, ...progress });
        } catch (error) {
          if (this.unloading) throw error;
          if (controller.signal.aborted || (error && error.code === "TASK_CANCELLED")) {
            cancelled = true;
            if (typeof onProgress === "function") onProgress({ phase: "stopping", folder, filePath: file.path, ...progress });
            break;
          }
          if (error && ["FILE_LEFT_SCOPE", "FILE_UNAVAILABLE", "STATUS_NOT_DONE", "SOURCE_CHANGED"].includes(error.code)) {
            const message = error.code === "FILE_LEFT_SCOPE"
              ? "任务执行期间文件已移出当前识别目录"
              : error.code === "STATUS_NOT_DONE"
                ? "文章 status 已不再是 done，按元数据校验规则跳过"
                : error.code === "SOURCE_CHANGED"
                  ? "正文在等待请求期间已变动，本次请求未发出"
                  : error.message;
            const kind = error.code === "FILE_LEFT_SCOPE"
              ? "moved-out"
              : error.code === "STATUS_NOT_DONE"
                ? "status-filtered"
                : error.code === "SOURCE_CHANGED"
                  ? "source-changed"
                  : "unavailable";
            skippedFiles.push({ path: file.path || queued.queuedPath, originalPath: queued.queuedPath, message, kind });
            if (typeof onProgress === "function") onProgress({ phase: "skipped", folder, filePath: file.path || queued.queuedPath, message, ...progress });
            continue;
          }
          const message = error instanceof Error ? error.message : String(error);
          const recordPath = file.path || queued.queuedPath;
          const record = this.state.files[recordPath] || {};
          if (error && error.code === "EMPTY_BODY") {
            record.lastError = "";
            record.lastErrorType = "";
            record.lastRawModelOutput = "";
            skippedFiles.push({ path: recordPath, message: "无可分析正文", kind: "empty-body" });
            if (typeof onProgress === "function") onProgress({ phase: "skipped", folder, filePath: recordPath, message: "无可分析正文", ...progress });
          } else {
            record.lastError = message.slice(0, 1000);
            record.lastErrorType = error && error.code ? String(error.code) : "ERROR";
            record.lastRawModelOutput = error && error.rawOutput ? String(error.rawOutput).slice(0, 16000) : "";
            failedFiles.push({ path: recordPath, message, rawOutput: record.lastRawModelOutput, errorType: record.lastErrorType });
            if (typeof onProgress === "function") onProgress({ phase: "error", folder, filePath: recordPath, message, ...progress });
            this.setRuntimeStatus("error", { filePath: recordPath, progress, message });
            this.appendLog("error", message, {
              filePath: recordPath,
              errorType: record.lastErrorType,
              raw: record.lastRawModelOutput,
            });
            console.warn(`xyblue135 私人·AI 元数据 folder sync failed: ${recordPath}`, error);
          }
          this.state.files[recordPath] = record;
        } finally {
          this.fileBusy.delete(busyPath);
          if (file && file.path) this.fileBusy.delete(file.path);
        }
      }

      let remaining = 0;
      for (const file of this.getFilesInFolder(folder)) {
        const info = await this.getCachedInspection(file, false, inspectCache);
        if (info.pending) remaining += 1;
      }

      if (cancelled || controller.signal.aborted) {
        cancelled = true;
        if (typeof onProgress === "function") onProgress({ phase: "cancelled", folder, total: pendingFiles.length, processed: processedFiles.length, failed: failedFiles.length, skipped: skippedFiles.length, remaining });
        this.lastCycleSummary = `${folder}：已停止；成功 ${processedFiles.length}，失败 ${failedFiles.length}，跳过 ${skippedFiles.length}，剩余 ${remaining}`;
        await this.saveAllData();
        if (showNotice) new Notice(`xyblue135 私人·AI 元数据：${folder} 已停止；成功 ${processedFiles.length}，失败 ${failedFiles.length}，剩余 ${remaining}`, 7000);
        return { folder, processedFiles, failedFiles, skippedFiles, alreadyComplete, remaining, cancelled: true };
      }

      const totalRegenerated = processedFiles.reduce((sum, item) => sum + ((item && item.regenerated) || []).length, 0);
      const totalUntouched = processedFiles.reduce((sum, item) => sum + ((item && item.untouched) || []).length, 0);

      if (typeof onProgress === "function") onProgress({ phase: "complete", folder, total: pendingFiles.length, processed: processedFiles.length, failed: failedFiles.length, skipped: skippedFiles.length, remaining, regenerated: totalRegenerated, untouched: totalUntouched, alreadyComplete });
      this.lastCycleSummary = `${folder}：成功 ${processedFiles.length}，失败 ${failedFiles.length}，跳过 ${skippedFiles.length}，重新生成 ${totalRegenerated} 项，未重新生成 ${totalUntouched} 项，剩余 ${remaining}`;
      await this.saveAllData();
      if (showNotice) {
        new Notice(`xyblue135 私人·AI 元数据：${folder} 同步完成；成功 ${processedFiles.length}，失败 ${failedFiles.length}，重新生成 ${totalRegenerated} 项${totalUntouched ? `，另有 ${totalUntouched} 项已有内容未重新生成` : ""}${alreadyComplete ? `，${alreadyComplete} 篇已有全部内容未参与` : ""}`, 9000);
      }
      return { folder, processedFiles, failedFiles, skippedFiles, alreadyComplete, remaining, cancelled: false };
    } catch (error) {
      if (controller.signal.aborted || (error && error.code === "TASK_CANCELLED")) {
        cancelled = true;
        let remaining = 0;
        for (const file of this.getFilesInFolder(folder)) {
          const info = await this.getCachedInspection(file, false, inspectCache);
          if (info.pending) remaining += 1;
        }
        if (typeof onProgress === "function") onProgress({ phase: "cancelled", folder, processed: processedFiles.length, failed: failedFiles.length, skipped: skippedFiles.length, remaining });
        this.lastCycleSummary = `${folder}：已停止；成功 ${processedFiles.length}，失败 ${failedFiles.length}，跳过 ${skippedFiles.length}，剩余 ${remaining}`;
        await this.saveAllData();
        if (showNotice) new Notice(`xyblue135 私人·AI 元数据：${folder} 已停止；剩余 ${remaining}`, 7000);
        return { folder, processedFiles, failedFiles, skippedFiles, alreadyComplete, remaining, cancelled: true };
      }
      throw error;
    } finally {
      if (this.manualFolderRun === run) this.manualFolderRun = null;
      this.autoRunning = false;
      this.cycleMode = null;
      if (!this.unloading) {
        this.setRuntimeStatus("idle");
        this.refreshStatusBar();
      }
    }
  }

  sleep(ms, abortSignal = null) {
    return new Promise((resolve, reject) => {
      if (abortSignal && abortSignal.aborted) {
        reject(new TaskCancelledError());
        return;
      }
      let settled = false;
      const timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        if (abortSignal && onAbort) abortSignal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        abortSignal.removeEventListener("abort", onAbort);
        reject(new TaskCancelledError());
      };
      if (abortSignal) abortSignal.addEventListener("abort", onAbort, { once: true });
    });
  }

  setButtonState(button, state) {
    if (!button || !button.isConnected) return;
    button.removeClass("is-loading", "is-success", "is-error");
    if (state === "loading") {
      button.addClass("is-loading");
      setIcon(button, "loader-circle");
      button.setAttribute("aria-label", "AI 生成中…");
    } else if (state === "success") {
      button.addClass("is-success");
      setIcon(button, "check");
      button.setAttribute("aria-label", "AI 生成成功");
    } else if (state === "error") {
      button.addClass("is-error");
      setIcon(button, "circle-alert");
      button.setAttribute("aria-label", "AI 生成失败");
    } else {
      setIcon(button, "sparkles");
      const kind = button.getAttribute("data-ai-kind") || "metadata";
      if (kind === "summary_short") button.setAttribute("aria-label", "AI 只生成 AI_summary_short");
      else if (kind === "summary_long") button.setAttribute("aria-label", "AI 只生成 AI_summary_long");
      else if (kind === "tags") button.setAttribute("aria-label", "AI 只生成 weighted tags");
      else if (kind === "technical_depth") button.setAttribute("aria-label", "AI 只评估 AI_technical_depth");
      else if (kind === "take") button.setAttribute("aria-label", "AI 只生成客观评价 AI_take");
      else if (kind === "qa") button.setAttribute("aria-label", "AI 只生成面试问答 AI_qa");
      else if (kind === "ai_title") button.setAttribute("aria-label", "AI 只生成参考标题 AI_title");
      else button.setAttribute("aria-label", `AI 生成 ${kind}`);
    }
  }

  async testConnection() {
    return this.enqueueApiRequest(async () => {
      const rawBaseUrl = String(this.settings.baseUrl || "").trim().replace(/\/+$/, "");
      const apiKey = String(this.settings.apiKey || "").trim();
      const selectedModel = String(this.settings.model || "auto").trim() || "auto";
      if (!rawBaseUrl) throw new Error("Base URL 为空");
      let parsedBase;
      try { parsedBase = new URL(rawBaseUrl); } catch (_) { throw new Error(`无效 Base URL：${rawBaseUrl}`); }
      if (!["http:", "https:"].includes(parsedBase.protocol)) {
        throw new Error(`Base URL 只支持 http/https：${parsedBase.protocol}`);
      }
      if (!apiKey) throw new Error("API Key 为空");

      const timeoutMs = Math.max(1, Number(this.settings.requestTimeoutSeconds) || 180) * 1000;

      // 阶段 1：低成本的能力/鉴权检查。FreeLLMAPI 等 OpenAI 兼容网关通常提供 GET /models；
      // 用于区分 URL、密钥、模型配置错误和真实的推理/路由故障。
      this.setRuntimeStatus("requesting", { phase: "连接测试：models", reason: "manual-test" });
      const modelsResponse = await this.requestJsonWithHardTimeout(`${rawBaseUrl}/models`, null, timeoutMs, null, "GET");
      if (modelsResponse.status < 200 || modelsResponse.status >= 300) {
        const detail = (modelsResponse.text || "").slice(0, 500) || `HTTP ${modelsResponse.status}`;
        throw new Error(`Models API ${modelsResponse.status}: ${detail}`);
      }
      const modelList = Array.isArray(modelsResponse.json?.data) ? modelsResponse.json.data : null;
      if (!modelList) {
        // 带上响应体片段：JSON 解析失败（HTML 错误页/纯文本）时只看“缺少 data 数组”会误导排查
        const preview = (modelsResponse.text || "").replace(/\s+/g, " ").trim().slice(0, 200) || "（响应体为空）";
        throw new Error(`Models API 返回成功，但缺少 data 数组；该接口可能不是标准 OpenAI-compatible /models：${preview}`);
      }
      const modelIds = modelList
        .map((item) => item && typeof item.id === "string" ? item.id : "")
        .filter(Boolean);
      const isVirtualAutoModel = selectedModel === "auto" || selectedModel.startsWith("auto:");
      if (!isVirtualAutoModel && modelIds.length > 0 && !modelIds.includes(selectedModel)) {
        throw new Error(`模型 ${selectedModel} 不在 /models 返回列表中（当前返回 ${modelIds.length} 个模型）`);
      }

      // 阶段 2：真实端到端推理检查。/models 正常并不代表当前上游 Provider 一定能完成推理。
      this.setRuntimeStatus("requesting", { phase: "连接测试：chat", reason: "manual-test" });
      const payload = {
        model: selectedModel,
        messages: [
          { role: "system", content: "只做 API 连通性测试。" },
          { role: "user", content: "只回复：OK" },
        ],
        temperature: 0,
        max_tokens: 8,
      };
      const chatResponse = await this.requestJsonWithHardTimeout(`${rawBaseUrl}/chat/completions`, payload, timeoutMs);
      if (chatResponse.status < 200 || chatResponse.status >= 300) {
        const detail = (chatResponse.text || "").slice(0, 500) || `HTTP ${chatResponse.status}`;
        throw new Error(`Chat API ${chatResponse.status}: ${detail}`);
      }
      // 非 JSON 响应（网关错误页、纯文本、SSE）在 HTTP 200 下也会出现：必须带出原始响应体
      if (chatResponse.json === null || typeof chatResponse.json !== "object") {
        const preview = (chatResponse.text || "").replace(/\s+/g, " ").trim().slice(0, 200) || "（响应体为空）";
        throw new Error(`Chat API 响应不是 JSON（HTTP ${chatResponse.status}）：${preview}`);
      }
      const data = chatResponse.json || {};
      if (data.error && data.error.message) throw new Error(data.error.message);
      const content = data.choices?.[0]?.message?.content;
      let reply = "";
      if (typeof content === "string") reply = content.trim();
      else if (Array.isArray(content)) {
        reply = content.map((part) => (part && typeof part.text === "string" ? part.text : "")).join("").trim();
      } else {
        const preview = (chatResponse.text || "").replace(/\s+/g, " ").trim().slice(0, 200);
        throw new Error(`Chat API 返回中没有 choices[0].message.content${preview ? `：${preview}` : ""}`);
      }

      return {
        ok: true,
        modelCount: modelIds.length,
        selectedModel,
        modelListed: isVirtualAutoModel ? null : modelIds.includes(selectedModel),
        reply,
        routedVia: String(chatResponse.headers?.["x-routed-via"] || "").trim(),
      };
    }, { phase: "连接测试", reason: "manual-test" });
  }
};

class AiMetadataSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.activeGroup = "api";
    this.groupOrder = ["api", "directory", "logs", "ai_title", "tags", "summary_short", "summary_long", "technical_depth", "take", "qa", "freshness"];
    this.groupLabels = {
      api: "API 连接",
      directory: "目录更新管理",
      logs: "日志与报错",
      ai_title: "参考标题 AI Title",
      tags: "标签 AI Tags",
      summary_short: "短摘要 AI Summary Short",
      summary_long: "长摘要 AI Summary Long",
      technical_depth: "技术深度 AI Technical Depth",
      take: "客观评价 AI Take",
      qa: "面试问答 AI QA",
      freshness: "时效性 AI Freshness",
    };
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("ai-metadata-settings-panel");
    const hero = containerEl.createDiv({ cls: "ai-metadata-settings-hero" });
    const heroText = hero.createDiv({ cls: "ai-metadata-settings-hero-text" });
    heroText.createEl("h2", { text: "xyblue135 私人 · AI 元数据" });
    heroText.createEl("p", {
      text: "更清晰地控制 API、扫描范围、自动识别与本地 Tag 规则。",
      cls: "setting-item-description",
    });
    const heroChips = hero.createDiv({ cls: "ai-metadata-settings-chips" });
    heroChips.createSpan({
      text: this.plugin.settings.statusDoneOnlyEnabled === true ? "扫描：仅 done" : "扫描：全部文章",
      cls: "ai-metadata-settings-chip",
    });
    heroChips.createSpan({
      text: this.plugin.settings.autoUpdateEnabled === true ? "自动更新：开" : "自动更新：关",
      cls: "ai-metadata-settings-chip",
    });
    heroChips.createSpan({
      text: `模型：${this.plugin.settings.model || "auto"}`,
      cls: "ai-metadata-settings-chip",
    });

    containerEl.createEl("h3", { text: "API 连接" });
    new Setting(containerEl)
      .setName("API 基础地址（Base URL）")
      .setDesc("兼容 OpenAI 的 API 基础地址；正常生成请求 /chat/completions，测试连接会先检查 /models。")
      .addText((text) => text.setValue(this.plugin.settings.baseUrl).onChange(async (value) => {
        this.plugin.settings.baseUrl = value.trim();
        this.plugin.scheduleStateSave(400);
      }));

    new Setting(containerEl)
      .setName("API 密钥（API Key）")
      .setDesc("仅保存在当前 Vault 的插件 data.json 中。")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setValue(this.plugin.settings.apiKey).onChange(async (value) => {
          this.plugin.settings.apiKey = value.trim();
          this.plugin.scheduleStateSave(400);
        });
      });

    new Setting(containerEl)
      .setName("模型（Model）")
      .setDesc("代理支持 auto 时可直接使用 auto。")
      .addText((text) => text.setValue(this.plugin.settings.model).onChange(async (value) => {
        this.plugin.settings.model = value.trim() || "auto";
        this.plugin.scheduleStateSave(400);
      }));

    new Setting(containerEl)
      .setName("API 请求超时（秒）")
      .setDesc("默认 180 秒（3 分钟）。每次 API 请求（含全部手动更新：单篇命令、待更新面板逐篇重试、文件夹批量）超过该时间即判定失败且不写入半成品。本插件仅手动更新，无自动定时任务。")
      .addText((text) => {
        text.inputEl.type = "number";
        text.setValue(String(this.plugin.settings.requestTimeoutSeconds)).onChange(async (value) => {
          const next = Number.parseInt(value, 10);
          if (Number.isFinite(next) && next >= 10 && next <= 1800) {
            this.plugin.settings.requestTimeoutSeconds = next;
            await this.plugin.saveAllData();
            this.plugin.refreshStatusBar();
          }
        });
        // 1.24：越界值原本被静默丢弃，输入框显示新值、实际仍用旧值。
        // 在失焦时（而不是每个字符）提示并恢复为实际生效值，避免打断输入。
        text.inputEl.addEventListener("blur", () => {
          const next = Number.parseInt(String(text.inputEl.value).trim(), 10);
          if (Number.isFinite(next) && next >= 10 && next <= 1800) return;
          new Notice(`xyblue135 私人·AI 元数据：超时时间需在 10～1800 秒之间，已恢复为 ${this.plugin.settings.requestTimeoutSeconds} 秒`);
          text.setValue(String(this.plugin.settings.requestTimeoutSeconds));
        });
      });

    new Setting(containerEl)
      .setName("API 请求间隔（秒）")
      .setDesc("默认 30 秒。所有 API 请求进入同一个串行队列，绝不并发；上一请求完成后至少等待该时间才启动下一请求。所有手动更新（单篇命令、待更新面板逐篇重试、文件夹批量识别）都受此节流约束，无法快于此间隔；文件夹批量识别支持中途停止。实验合并模式可把同一篇笔记的多项元数据从多次请求减少为一次。")
      .addText((text) => {
        text.inputEl.type = "number";
        text.setValue(String(this.plugin.settings.requestIntervalSeconds)).onChange(async (value) => {
          const next = Number.parseInt(value, 10);
          if (Number.isFinite(next) && next >= 0 && next <= 600) {
            this.plugin.settings.requestIntervalSeconds = next;
            await this.plugin.saveAllData();
            this.plugin.refreshStatusBar();
          }
        });
        // 1.24：失焦时校验，越界则提示并恢复为实际生效值
        text.inputEl.addEventListener("blur", () => {
          const next = Number.parseInt(String(text.inputEl.value).trim(), 10);
          if (Number.isFinite(next) && next >= 0 && next <= 600) return;
          new Notice(`xyblue135 私人·AI 元数据：请求间隔需在 0～600 秒之间，已恢复为 ${this.plugin.settings.requestIntervalSeconds} 秒`);
          text.setValue(String(this.plugin.settings.requestIntervalSeconds));
        });
      });

    new Setting(containerEl)
      .setName("Beta：批量合并 4 项结构化元数据请求")
      .setDesc("合并结构化请求已下线，由于错误率太高。当前自动更新与生成均改为逐字段单个请求。");

    new Setting(containerEl)
      .setName("测试 API")
      .addButton((button) => button.setButtonText("测试连接").onClick(async () => {
        button.setDisabled(true).setButtonText("测试中…");
        try {
          const result = await this.plugin.testConnection();
          const route = result.routedVia ? `；路由：${result.routedVia}` : "";
          const modelInfo = result.modelListed === false ? "；模型未列出" : "";
          new Notice(`xyblue135 私人·AI 元数据：连接成功；/models ${result.modelCount} 个；模型 ${result.selectedModel}${route}${modelInfo}；返回：${String(result.reply).slice(0, 40)}`, 7000);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          new Notice(`xyblue135 私人·AI 元数据：连接失败：${message}`, 7000);
        } finally {
          button.setDisabled(false).setButtonText("测试连接");
          if (!this.plugin.autoRunning && !this.plugin.unloading) this.plugin.setRuntimeStatus("idle");
        }
      }));

    containerEl.createEl("h3", { text: "内容与 Tag 规则" });

    new Setting(containerEl)
      .setName("是否喂给 AI 元数据信息")
      .setDesc("默认关闭（重要开关）。当前自动更新生成的就是元数据内容本身，不应把已有元数据内容（如 AI_tags）再喂回给 AI，请保持关闭；开启后生成 Tags 时会把已有 AI_tags 发送给 AI。")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.feedMetadataToAiEnabled === true).onChange(async (value) => {
        this.plugin.settings.feedMetadataToAiEnabled = value;
        await this.plugin.saveAllData();
      }));

    new Setting(containerEl)
      .setName("喂入文章标题（全局）")
      .setDesc("默认开启。开启后各字段的提示词都会带上「笔记标题：文件名」这一行，让 AI 知道文章标题。关闭后所有字段的提示词都不再包含标题行（正文本身仍然会发送）。")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.feedTitleToAiEnabled !== false).onChange(async (value) => {
        this.plugin.settings.feedTitleToAiEnabled = value;
        await this.plugin.saveAllData();
        new Notice(`xyblue135 私人·AI 元数据：喂入文章标题已${value ? "开启" : "关闭"}`);
      }));

    new Setting(containerEl)
      .setName("运行前清空本次字段")
      .setDesc("默认开启。每次生成前，先把本次要生成的字段值置空（只清本次请求的字段，其它字段不动），避免旧内容残留。为保证 Properties 里的属性行和 ✨ 按钮不消失，只清空值、不删除字段本身；本来就不存在的字段不会被凭空创建。注意：清空发生在发请求之前，因此如果这次 API 请求失败，该字段会停留在空值，需要重新生成。")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.clearFieldsBeforeRunEnabled !== false).onChange(async (value) => {
        this.plugin.settings.clearFieldsBeforeRunEnabled = value;
        await this.plugin.saveAllData();
        new Notice(`xyblue135 私人·AI 元数据：运行前清空本次字段已${value ? "开启" : "关闭"}`);
      }));

    new Setting(containerEl)
      .setName("白名单目录")
      .setDesc("根目录，支持逗号分隔多个（如 my_blog/00_docs,my_blog/00_agent_for_projects）。这些目录及其子目录中的 .md 显示 AI 图标并参与自动更新。")
      .addText((text) => text.setValue(this.plugin.settings.whitelistFolder).onChange(async (value) => {
        this.plugin.settings.whitelistFolder = value.trim().replace(/^\/+|\/+$/g, "") || "my_blog/00_docs";
        // 1.3：文本输入逐字符触发，改为防抖落盘，避免每次按键都全量写 data.json
        this.plugin.scheduleStateSave(400);
        this.plugin.scheduleInjection();
        this.plugin.scheduleTagCatalogRebuild(100);
      }));

    new Setting(containerEl)
      .setName("导出白名单内的文章")
      .setDesc(`按 00_docs 的结构导出：把白名单目录（${this.plugin.normalizeWhitelistFolder()}）及其子目录中 frontmatter status: done 的文章，原样打包成同级压缩包 ${this.plugin.getArticleExportZipPath()}，包内完整保留子目录树与文件名。`
        + "全局强制按 status 过滤：不看「元数据 status 校验」开关，status 不是 done（含未设置）的一律不导出。"
        + "压缩包每次导出都整体重写，因此包内内容始终等于当前白名单 done 文章的镜像，不会残留已移出范围或已改回 undone 的旧文件；导出为原样复制（含 frontmatter 与正文），不调用 AI、不改动原文。"
        + "包内不压缩（store），体积约等于原文总和，但速度最快。")
      .addButton((button) => button.setCta().setButtonText("导出 zip").onClick(async () => {
        button.setDisabled(true).setButtonText("导出中…");
        try {
          await this.plugin.exportWhitelistArticles();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          new Notice(`xyblue135 私人·AI 元数据：导出失败：${message}`, 8000);
        } finally {
          button.setDisabled(false).setButtonText("导出 zip");
        }
      }));

    const catalogSetting = new Setting(containerEl)
      .setName("本地 Tag 索引")
      .setDesc("从白名单目录内所有 Markdown 的 frontmatter tags + 行内 #tags 建立，只作为本地索引供你查看；不会发送给 AI，因此不会增加 Token。注意：AI 生成的标签已不再做大小写匹配或改写（AI 给什么就写什么）。")
      .addButton((button) => button.setButtonText("重新扫描").onClick(async () => {
        button.setDisabled(true).setButtonText("扫描中…");
        try {
          await this.plugin.rebuildTagCatalog();
          new Notice(`xyblue135 私人·AI 元数据：本地 Tag 索引已更新，共 ${Object.keys(this.plugin.state.tagCatalog || {}).length} 个唯一 value`);
          this.display();
        } finally {
          button.setDisabled(false).setButtonText("重新扫描");
        }
      }));
    const catalogEntries = this.plugin.getTagCatalogEntries(40);
    const catalogDetails = containerEl.createEl("details", { cls: "ai-metadata-settings-details" });
    catalogDetails.createEl("summary", {
      text: `查看本地 Tag 索引（${Object.keys(this.plugin.state.tagCatalog || {}).length} 个唯一 value，显示前 ${Math.min(40, catalogEntries.length)} 个）`,
    });
    catalogDetails.createEl("div", {
      cls: "ai-metadata-tag-catalog-preview",
      text: catalogEntries.length ? catalogEntries.map((x) => `${x.value} ×${x.count}`).join("  ·  ") : "暂无标签，点击“重新扫描”。",
    });
    void catalogSetting;

    new Setting(containerEl)
      .setName("整理已有 Tag 大小写冲突")
      .setDesc("扫描白名单目录中 frontmatter tags 的历史大小写冲突，先预览再统一。只改大小写不同的同名 Tag，不调用 AI；行内 #tag 不会被批量改写。")
      .addButton((button) => button.setButtonText("预览并整理").onClick(() => {
        new TagCaseCleanupModal(this.app, this.plugin).open();
      }));

    containerEl.createEl("h3", { text: "模板骨架（新建笔记自动补字段）" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "这是「一篇笔记该有哪些 frontmatter 字段」的唯一定义处。新建或移入作用目录的 .md 会自动补齐这里列出、而笔记里缺失的字段；"
        + "已有字段的值与顺序一律不动，只追加缺失项。纯静态操作，不调用 AI、不改正文。",
    });
    new Setting(containerEl)
      .setName("Frontmatter 模板")
      .setDesc("写成 --- 包裹的 YAML 块。支持变量：{{folder}} {{filename}} {{path}} {{datetime}} {{date}} {{time}} {{timestamp}}。改完可点下方「审查并补全白名单内全部笔记」给历史笔记补齐。")
      .addTextArea((area) => {
        area.inputEl.rows = 16;
        area.inputEl.style.width = "100%";
        area.inputEl.style.fontFamily = "var(--font-monospace)";
        area.setValue(this.plugin.settings.templateNote || "");
        area.onChange(async (value) => {
          this.plugin.settings.templateNote = value;
          await this.plugin.saveAllData();
        });
      })
      .addExtraButton((button) => button.setIcon("rotate-ccw").setTooltip("恢复默认模板")
        .onClick(async () => {
          this.plugin.settings.templateNote = DEFAULT_TEMPLATE_TEXT;
          await this.plugin.saveAllData();
          this.display();
        }));
    new Setting(containerEl)
      .setName("作用目录")
      .setDesc("只处理这些目录下的 .md（含子目录）。多个目录用逗号或换行分隔；留空 = 整个仓库。")
      .addText((text) => text
        .setPlaceholder("my_blog/00_docs")
        .setValue(this.plugin.settings.templateAuditFolders || "")
        .onChange(async (value) => {
          this.plugin.settings.templateAuditFolders = value;
          await this.plugin.saveAllData();
        }));
    new Setting(containerEl)
      .setName("新建笔记时自动补全")
      .setDesc("关闭后只能手动跑命令补全。观察到的笔记正在输入时会自动顺延，不覆盖你正在写的内容。")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.templateAuditOnCreate !== false)
        .onChange(async (value) => {
          this.plugin.settings.templateAuditOnCreate = value;
          await this.plugin.saveAllData();
        }));
    new Setting(containerEl)
      .setName("补全延迟（毫秒）")
      .setDesc("新建笔记后等多久再审查，给 Obsidian 留出写入与索引的时间。默认 1500。")
      .addText((text) => text
        .setValue(String(this.plugin.settings.templateAuditDelayMs ?? 1500))
        .onChange(async (value) => {
          const parsed = Number(value);
          this.plugin.settings.templateAuditDelayMs = Number.isFinite(parsed) && parsed >= 300 ? parsed : 1500;
          await this.plugin.saveAllData();
        }));

    containerEl.createEl("h3", { text: "界面状态" });
    new Setting(containerEl)
      .setName("显示 AI 状态")
      .setDesc("在 Obsidian 底部状态栏显示当前 双摘要/Tags/Technical Depth 请求、请求间隔等待倒计时、写入阶段和下一次自动检查倒计时。")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.statusBarEnabled !== false).onChange(async (value) => {
        this.plugin.settings.statusBarEnabled = value;
        await this.plugin.saveAllData();
        this.plugin.refreshStatusBar();
      }));

    containerEl.createEl("h3", { text: "扫描与识别" });
    new Setting(containerEl)
      .setName("元数据 status 校验")
      .setDesc("关闭：批量识别白名单中的全部 Markdown。开启：自动扫描、文件夹树统计和文件夹识别只处理 frontmatter 中 status: done 的文章；status: undone、缺少 status 或其他值都跳过。文章内单篇 ✨ 手动生成不受此规则限制。")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.statusDoneOnlyEnabled === true).onChange(async (value) => {
        this.plugin.settings.statusDoneOnlyEnabled = value;
        await this.plugin.saveAllData();
        new Notice(`xyblue135 私人·AI 元数据：批量识别范围已切换为${value ? "仅 status: done" : "全部文章"}`);
        this.display();
      }));

    new Setting(containerEl)
      .setName("待更新笔记 / 文件夹识别")
      .setDesc("打开 Obsidian 式可展开目录树：逐层展开 00_docs 子文件夹，在目标文件夹右侧直接点击“识别”，并查看具体 Markdown、缺失字段和正文预览。识别会包含该文件夹的子文件夹。")
      .addButton((button) => button.setCta().setButtonText("打开文件夹树").onClick(() => {
        this.plugin.openPendingNotesDashboard();
      }));

    new Setting(containerEl)
      .setName("定期巡检（小时）")
      .setDesc("每隔 N 小时后台跑一次 14 键格式巡检并弹 Notice 摘要；0 = 关闭，最小 0.1。改动立即生效")
      .addText((t) => t.setValue(String(this.plugin.settings.autoInspectionHours ?? 0)).onChange(async (v) => {
        const n = Number(v);
        this.plugin.settings.autoInspectionHours = Number.isFinite(n) && n >= 0.1 ? n : 0;
        await this.plugin.saveAllData();
        this.plugin.armPeriodicInspection();
      }));
    new Setting(containerEl)
      .setName("格式巡检（手动一次）")
      .setDesc("扫描白名单目录（开启 status 校验时只含 status: done 的文章）里各 AI 字段的格式，列出「有内容但正则不通过 / 空值 / 字段缺失」的项。"
        + "每条可单独勾选后逐项 AI 修复（每次只重新生成那一个字段），修完立刻做一次二次验证；不会定期自动运行，也不会重复重跑，仍不通过的留给人工检查。")
      .addButton((button) => button.setCta().setButtonText("打开格式巡检").onClick(() => {
        this.plugin.openFormatInspection();
      }));

    // ---------- 缺失元数据补全 / 顺序修正（子模块） ----------
    new Setting(containerEl)
      .setName("缺失元数据补全 / 顺序修正")
      .setDesc("只管「存不存在」与「顺序对不对」（格式是否合规用上面的「格式巡检」）。"
        + "巡检会列出缺失/为空的 AI 字段，以及 AI 字段顺序与下面「元数据顺序」不一致的文章；"
        + "处理时逐篇先摆正顺序 → 只重新生成缺的字段 → 再摆一次顺序 → 做一次二次验证（不重复运行）。非 AI 字段一律不动。")
      .addButton((button) => button.setCta().setButtonText("打开补全面板").onClick(() => {
        this.plugin.openMetadataGap();
      }));

    new Setting(containerEl)
      .setName("元数据顺序（每行一个字段）")
      .setDesc("一行一个 frontmatter 键，默认 10 个 AI 字段（含时效性三键 AI_last_verified / AI_freshness / AI_freshness_note）。补全时会按这个顺序插入缺失字段，顺序巡检也按它判断对错。"
        + "只影响 AI_ 开头的字段（status / visibility / updated / token_count 等键不会被动）。")
      .setClass("ai-metadata-setting-stacked")
      .addTextArea((area) => {
        area.inputEl.rows = 8;
        area.inputEl.addClass("ai-metadata-harness-textarea");
        area.setValue(this.plugin.settings.metadataKeyOrder).onChange(async (value) => {
          this.plugin.settings.metadataKeyOrder = value;
          this.plugin.scheduleStateSave(400);
        });
      })
      .addButton((button) => button.setButtonText("恢复默认顺序").onClick(async () => {
        this.plugin.settings.metadataKeyOrder = DEFAULT_METADATA_KEY_ORDER;
        await this.plugin.saveAllData();
        this.display();
      }));

    // ---------- 日志与报错（独立分组：下拉栏里的「日志与报错」） ----------
    containerEl.createEl("h3", { text: "日志与报错" });
    const logStats = this.plugin.getLogStats();
    new Setting(containerEl)
      .setName("日志与报错")
      .setDesc(
        `当前共 ${logStats.total} 条日志（错误 ${logStats.errors}、警告 ${logStats.warns}），另有 ${logStats.fileErrors} 篇笔记留有「上次错误」。`
        + "日志只记录插件自身的运行结果与错误摘要（失败时附带模型原始输出），不含笔记正文。"
        + "点「查看日志与报错」看详情；「立即清理」按保留天数清理；「清空日志」全部删除。",
      )
      .addButton((button) => button.setCta().setButtonText("查看日志与报错").onClick(() => {
        this.plugin.pruneLogs();
        new LogViewerModal(this.app, this.plugin).open();
      }))
      .addButton((button) => button.setButtonText("立即清理").onClick(async () => {
        const removed = this.plugin.pruneLogs();
        await this.plugin.saveAllData();
        new Notice(`xyblue135 私人·AI 元数据：已按保留 ${logStats.retentionDays} 天清理，删除 ${removed} 条`);
        this.display();
      }))
      .addButton((button) => button.setButtonText("清空日志").onClick(async () => {
        const count = this.plugin.clearLogs();
        await this.plugin.saveAllData();
        new Notice(`xyblue135 私人·AI 元数据：已清空 ${count} 条日志`);
        this.display();
      }));

    new Setting(containerEl)
      .setName("日志条数上限")
      .setDesc("超过上限自动丢弃最早的日志。默认 300，范围 20～2000。改成更小的值会立即截断已有日志。")
      .addText((text) => {
        text.inputEl.type = "number";
        text.setValue(String(this.plugin.settings.logMaxEntries)).onChange(async (value) => {
          const next = Number.parseInt(value, 10);
          if (Number.isFinite(next) && next >= 20 && next <= 2000) {
            this.plugin.settings.logMaxEntries = next;
            this.plugin.trimLogs();
            await this.plugin.saveAllData();
          }
        });
        // 1.24：失焦时校验，越界则提示并恢复为实际生效值
        text.inputEl.addEventListener("blur", () => {
          const next = Number.parseInt(String(text.inputEl.value).trim(), 10);
          if (Number.isFinite(next) && next >= 20 && next <= 2000) return;
          new Notice(`xyblue135 私人·AI 元数据：日志条数上限需在 20～2000 之间，已恢复为 ${this.plugin.settings.logMaxEntries}`);
          text.setValue(String(this.plugin.settings.logMaxEntries));
        });
      });

    new Setting(containerEl)
      .setName("日志保留天数")
      .setDesc("打开日志或点「立即清理」时，自动删除超过该天数的日志。填 0 表示不按时间清理（只受条数上限约束）。默认 3 天。")
      .addText((text) => {
        text.inputEl.type = "number";
        text.setValue(String(this.plugin.settings.logRetentionDays)).onChange(async (value) => {
          const next = Number.parseInt(value, 10);
          if (Number.isFinite(next) && next >= 0 && next <= 365) {
            this.plugin.settings.logRetentionDays = next;
            await this.plugin.saveAllData();
          }
        });
        // 1.24：失焦时校验，越界则提示并恢复为实际生效值
        text.inputEl.addEventListener("blur", () => {
          const next = Number.parseInt(String(text.inputEl.value).trim(), 10);
          if (Number.isFinite(next) && next >= 0 && next <= 365) return;
          new Notice(`xyblue135 私人·AI 元数据：日志保留天数需在 0～365 之间，已恢复为 ${this.plugin.settings.logRetentionDays} 天`);
          text.setValue(String(this.plugin.settings.logRetentionDays));
        });
      });

    new Setting(containerEl)
      .setName("元数据外置存储（00_metadata sidecar）")
      .setDesc("开启后 AI_* 十个键的存取都走 00_metadata/ 下的平铺 sidecar 文件（doc 键关联正文，正文新建/改名/删除自动联动），正文 frontmatter 只保留 status/visibility/updated/token_count 等工作流键；✨/✓ 按钮移入正文顶部注入的「AI 元数据」面板。关闭则回到旧模式（全部存正文 frontmatter）。")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.sidecarModeEnabled === true)
        .onChange(async (value) => {
          this.plugin.settings.sidecarModeEnabled = value;
          await this.plugin.saveAllData();
          this.plugin.scheduleInjection();
          new Notice(value
            ? "已开启 sidecar 模式：AI 元数据改为读写 00_metadata 平铺文件"
            : "已关闭 sidecar 模式：AI 元数据回到正文 frontmatter", 7000);
        }));

    new Setting(containerEl)
      .setName("元数据存储目录")
      .setDesc("sidecar 镜像树的根目录（相对仓库根）。改动后需自行迁移既有文件，插件不会自动搬移。")
      .addText((text) => text.setValue(this.plugin.settings.metadataStoreFolder || "00_metadata").onChange(async (value) => {
        this.plugin.settings.metadataStoreFolder = value.trim().replace(/^\/+|\/+$/g, "") || "00_metadata";
        this.plugin.scheduleStateSave(400);
      }));

    new Setting(containerEl)
      .setName("导出元数据 CSV（zip 包）")
      .setDesc("把白名单目录下已被识别过的 Markdown（10 个字段里至少有一个有内容）导出为压缩包 ai-metadata-notes.zip（保存在仓库根目录），包内是 ai-metadata-notes.csv；完全没有 AI 元数据的笔记不导出。第一列 title 是笔记标题（文件名去扩展名），按标题排序；之后一列一个字段，顺序为 AI_title、AI_tags、AI_summary_short、AI_summary_long、AI_technical_depth、AI_take、AI_qa、AI_freshness、AI_freshness_note、AI_last_verified；未生成的字段留空。数组字段（AI_title / AI_tags）与多行字段（AI_qa）在单元格内保留换行，CSV 带 UTF-8 BOM 以便 Excel 正确显示中文。注意：第一列只有标题，同名笔记在 CSV 中无法区分，导出后的提示会列出重名情况。")
      .addButton((button) => button.setButtonText("导出 zip").onClick(async () => {
        button.setDisabled(true).setButtonText("导出中…");
        try {
          await this.plugin.exportMetadataCsv();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          new Notice(`xyblue135 私人·AI 元数据：导出失败：${message}`, 8000);
        } finally {
          button.setDisabled(false).setButtonText("导出 zip");
        }
      }));

    containerEl.createEl("h3", { text: "高级输出约束" });

    new Setting(containerEl)
      .setName("短摘要语义约束内容")
      .setDesc("改动立即保存，下一次生成就生效，无需重启 Obsidian。")
      .setClass("ai-metadata-setting-stacked")
      .addTextArea((area) => {
        area.inputEl.rows = 8;
        area.inputEl.addClass("ai-metadata-harness-textarea");
        area.setValue(this.plugin.settings.summaryShortHarness).onChange(async (value) => {
          this.plugin.settings.summaryShortHarness = value;
          this.plugin.scheduleStateSave(400);
        });
      });


    new Setting(containerEl)
      .setName("长摘要语义约束内容")
      .setDesc("改动立即保存，下一次生成就生效，无需重启 Obsidian。")
      .setClass("ai-metadata-setting-stacked")
      .addTextArea((area) => {
        area.inputEl.rows = 13;
        area.inputEl.addClass("ai-metadata-harness-textarea");
        area.setValue(this.plugin.settings.summaryLongHarness).onChange(async (value) => {
          this.plugin.settings.summaryLongHarness = value;
          this.plugin.scheduleStateSave(400);
        });
      });

    new Setting(containerEl)
      .setName("标签语义约束内容")
      .setDesc("改动立即保存，下一次生成就生效，无需重启 Obsidian。")
      .setClass("ai-metadata-setting-stacked")
      .addTextArea((area) => {
        area.inputEl.rows = 9;
        area.inputEl.addClass("ai-metadata-harness-textarea");
        area.setValue(this.plugin.settings.tagsHarness).onChange(async (value) => {
          this.plugin.settings.tagsHarness = value;
          this.plugin.scheduleStateSave(400);
        });
      });


    new Setting(containerEl)
      .setName("技术深度评分 Prompt")
      .setClass("ai-metadata-setting-stacked")
      .setDesc("默认即当前 5 维 technical_depth 评分标准。{{ARTICLE}} 是正文占位符，生成时会替换为完整正文；如果被删掉，插件会自动把正文补在提示词末尾（不会静默失效）。清空此项会回退为默认评分标准（空的评分标准无法工作）。改动立即生效，无需重启 Obsidian。")
      .addTextArea((area) => {
        area.inputEl.rows = 22;
        area.inputEl.addClass("ai-metadata-harness-textarea");
        area.setValue(this.plugin.settings.technicalDepthHarness || DEFAULT_TECHNICAL_DEPTH_HARNESS).onChange(async (value) => {
          this.plugin.settings.technicalDepthHarness = value;
          this.plugin.scheduleStateSave(400);
        });
      });


    new Setting(containerEl)
      .setName("客观评价约束内容")
      .setDesc("改动立即保存，下一次生成就生效，无需重启 Obsidian。")
      .setClass("ai-metadata-setting-stacked")
      .addTextArea((area) => {
        area.inputEl.rows = 10;
        area.inputEl.addClass("ai-metadata-harness-textarea");
        area.setValue(this.plugin.settings.takeHarness || DEFAULT_TAKE_HARNESS).onChange(async (value) => {
          this.plugin.settings.takeHarness = value;
          this.plugin.scheduleStateSave(400);
        });
      });

    new Setting(containerEl)
      .setName("面试问答约束内容")
      .setDesc("改动立即保存，下一次生成就生效，无需重启 Obsidian。")
      .setClass("ai-metadata-setting-stacked")
      .addTextArea((area) => {
        area.inputEl.rows = 10;
        area.inputEl.addClass("ai-metadata-harness-textarea");
        area.setValue(this.plugin.settings.qaHarness || DEFAULT_QA_HARNESS).onChange(async (value) => {
          this.plugin.settings.qaHarness = value;
          this.plugin.scheduleStateSave(400);
        });
      });


    new Setting(containerEl)
      .setName("参考标题约束内容")
      .setDesc("改动立即保存，下一次生成就生效，无需重启 Obsidian。")
      .setClass("ai-metadata-setting-stacked")
      .addTextArea((area) => {
        area.inputEl.rows = 9;
        area.inputEl.addClass("ai-metadata-harness-textarea");
        area.setValue(this.plugin.settings.aiTitleHarness || DEFAULT_AI_TITLE_HARNESS).onChange(async (value) => {
          this.plugin.settings.aiTitleHarness = value;
          this.plugin.scheduleStateSave(400);
        });
      });

    new Setting(containerEl)
      .setName("时效性评估约束内容")
      .setDesc("改动立即保存，下一次生成就生效，无需重启 Obsidian。评估会同时写入 AI_freshness（三档结论）、AI_freshness_note（说明）与 AI_last_verified（本地时间戳，自动填写，不需要模型输出）。")
      .setClass("ai-metadata-setting-stacked")
      .addTextArea((area) => {
        area.inputEl.rows = 16;
        area.inputEl.addClass("ai-metadata-harness-textarea");
        area.setValue(this.plugin.settings.freshnessHarness || DEFAULT_FRESHNESS_HARNESS).onChange(async (value) => {
          this.plugin.settings.freshnessHarness = value;
          this.plugin.scheduleStateSave(400);
        });
      });

    new Setting(containerEl)
      .setName('导出字段与提示词 CSV（zip 包）')
      .setDesc('把当前可 AI 生成的 8 个字段及其提示词（Harness）导出为压缩包 ai-metadata-fields.zip（保存在仓库根目录），包内是 ai-metadata-fields.csv（带 UTF-8 BOM），便于备份或审阅。')
      .addButton((button) => button.setButtonText('导出 zip').onClick(async () => {
        button.setDisabled(true).setButtonText('导出中…');
        try {
          await this.plugin.exportPromptFieldsCsv();
        } catch (e) {
          new Notice('xyblue135 私人·AI 元数据：导出失败：' + (e && e.message ? e.message : String(e)));
        } finally {
          button.setDisabled(false).setButtonText('导出 zip');
        }
      }));

    // ---------- 各 AI 模块的格式校验配置（纯本地正则，与上面的提示词分开存放） ----------
    // 这些设置项集中在这里创建，但 decorateSettingsPanel() + _groupKeyForNode()
    // 会把它们分别归入各自 AI 模块的分组卡片，所以 UI 上仍出现在对应模块下面。
    containerEl.createEl("h3", { text: "格式校验（正则）" });
    ["summary_short", "summary_long", "tags", "technical_depth", "take", "qa", "ai_title", "freshness", "freshness_note", "last_verified",
      "status", "visibility", "updated", "token_count"]
      .forEach((kind) => this.addFormatCheckSetting(containerEl, kind));

    this.decorateSettingsPanel(containerEl);
  }

  // 单个 AI 模块的「格式校验」设置项：开关 + 规则 textarea + 恢复默认。
  // 与上面的 Harness（提示词）完全分开存放：Harness 在 settings.xxxHarness，
  // 校验规则在 settings.formatChecks[kind].rules，两者互不影响。
  addFormatCheckSetting(containerEl, kind) {
    const readConfig = () => this.plugin.getFormatCheckConfig(kind);
    // 永远写回 settings.formatChecks[kind] 自己的对象，避免误改默认常量。
    const writeConfig = (patch) => {
      this.plugin.settings.formatChecks[kind] = { ...readConfig(), ...patch };
    };
    const config = readConfig();

    const setting = new Setting(containerEl)
      .setName(`格式校验：${this.plugin.fieldKeyForKind(kind)}`)
      .setClass("ai-metadata-setting-stacked")
      .addToggle((toggle) => toggle
        .setValue(config.enabled !== false)
        .setTooltip("关闭后点 ✓ 按钮会直接提示「已跳过」")
        .onChange(async (value) => {
          writeConfig({ enabled: value });
          await this.plugin.saveAllData();
          this.display();
        }))
      .addButton((button) => button.setButtonText("恢复默认规则").onClick(async () => {
        writeConfig({ enabled: true, rules: DEFAULT_FORMAT_CHECKS[kind].rules });
        await this.plugin.saveAllData();
        this.display();
      }))
      .addTextArea((area) => {
        area.inputEl.rows = 8;
        area.inputEl.addClass("ai-metadata-harness-textarea");
        area.setValue(config.rules).onChange(async (value) => {
          writeConfig({ rules: value });
          this.plugin.scheduleStateSave(400);
        });
      });

    // 1.29：说明文案原本用 join("") 拼成一整段，多句话黏在一起很难扫读；
    // 这里按行拆成独立段落渲染（不依赖 CSS 的 white-space）。
    if (setting.descEl) {
      setting.descEl.empty();
      for (const line of this.plugin.describeFormatCheck(kind).split("\n")) {
        setting.descEl.createEl("div", { text: line });
      }
    }
    return setting;
  }

  decorateSettingsPanel(containerEl) {
    if (typeof this.activeGroup !== "string") this.activeGroup = "api";

    const buckets = {};
    for (const key of this.groupOrder) buckets[key] = [];

    const headings = Array.from(containerEl.querySelectorAll(":scope > h3"));
    for (const heading of headings) {
      if (heading.parentElement !== containerEl) continue;
      const sectionNodes = [];
      let cursor = heading.nextSibling;
      while (cursor) {
        if (cursor instanceof HTMLElement && cursor.tagName === "H3") break;
        const next = cursor.nextSibling;
        if (cursor instanceof HTMLElement) sectionNodes.push(cursor);
        cursor = next;
      }
      for (const node of sectionNodes) {
        buckets[this._groupKeyForNode(node)].push(node);
      }
    }

    const nav = this._buildGroupNav(containerEl);
    const hero = containerEl.querySelector(".ai-metadata-settings-hero");
    if (hero) {
      hero.after(nav);
    } else {
      containerEl.prepend(nav);
    }

    for (const key of this.groupOrder) {
      const groupEl = containerEl.createDiv({ cls: "ai-metadata-settings-card ai-metadata-settings-group" });
      groupEl.setAttribute("data-group", key);
      groupEl.createEl("h3", { text: this.groupLabels[key] });
      for (const node of buckets[key]) groupEl.appendChild(node);
      containerEl.appendChild(groupEl);
    }

    for (const heading of headings) heading.remove();
    this._syncGroupNav(containerEl);
  }

  _groupKeyForNode(node) {
    if (node.matches("details")) {
      const summary = node.querySelector("summary");
      const text = (summary && summary.textContent || "").trim();
      if (text.startsWith("查看本地 Tag 索引")) return "tags";
      return "api";
    }
    const nameEl = node.querySelector(".setting-item-name");
    const name = (nameEl && nameEl.textContent || "").trim();
    const map = {
      "API 基础地址（Base URL）": "api",
      "API 密钥（API Key）": "api",
      "模型（Model）": "api",
      "API 请求超时（秒）": "api",
      "API 请求间隔（秒）": "api",
      "Beta：批量合并 4 项结构化元数据请求": "api",
      "测试 API": "api",
      "是否喂给 AI 元数据信息": "directory",
      "喂入文章标题（全局）": "directory",
      "运行前清空本次字段": "directory",
      "白名单目录": "directory",
      "导出白名单内的文章": "directory",
      "显示 AI 状态": "directory",
      "元数据 status 校验": "directory",
      "待更新笔记 / 文件夹识别": "directory",
      "格式巡检（手动一次）": "directory",
      "缺失元数据补全 / 顺序修正": "directory",
      "元数据顺序（每行一个字段）": "directory",
      "元数据外置存储（00_metadata sidecar）": "directory",
      "元数据存储目录": "directory",
      "导出元数据 CSV（zip 包）": "directory",
      "导出字段与提示词 CSV（zip 包）": "directory",
      "日志与报错": "logs",
      "日志条数上限": "logs",
      "日志保留天数": "logs",
      "本地 Tag 索引": "tags",
      "整理已有 Tag 大小写冲突": "tags",
      "标签语义约束内容": "tags",
      "短摘要语义约束内容": "summary_short",
      "长摘要语义约束内容": "summary_long",
      "技术深度评分 Prompt": "technical_depth",
      "客观评价约束内容": "take",
      "参考标题约束内容": "ai_title",
      "面试问答约束内容": "qa",
      "时效性评估约束内容": "freshness",
      // 各模块的「格式校验：AI_xxx」设置项（逐个显式列出，避免落到默认的 api 分组）
      "格式校验：AI_summary_short": "summary_short",
      "格式校验：AI_summary_long": "summary_long",
      "格式校验：AI_tags": "tags",
      "格式校验：AI_technical_depth": "technical_depth",
      "格式校验：AI_take": "take",
      "格式校验：AI_qa": "qa",
      "格式校验：AI_title": "ai_title",
      "格式校验：AI_freshness": "freshness",
      "格式校验：AI_freshness_note": "freshness",
      "格式校验：AI_last_verified": "freshness",
    };
    return map[name] || "api";
  }

  _buildGroupNav(containerEl) {
    const nav = containerEl.createDiv({ cls: "ai-metadata-settings-nav" });
    const select = nav.createEl("select", { cls: "dropdown" });
    for (const group of this.groupOrder) {
      const option = select.createEl("option", { text: this.groupLabels[group] });
      option.value = group;
    }
    select.value = this.activeGroup;
    select.addEventListener("change", () => {
      this.activeGroup = select.value;
      this._syncGroupNav(containerEl);
    });
    const prevBtn = nav.createEl("button", { text: "上一项" });
    prevBtn.setAttribute("type", "button");
    prevBtn.addEventListener("click", () => this._stepGroup(-1, containerEl));
    const nextBtn = nav.createEl("button", { text: "下一项" });
    nextBtn.setAttribute("type", "button");
    nextBtn.addEventListener("click", () => this._stepGroup(1, containerEl));
    return nav;
  }

  _stepGroup(delta, containerEl) {
    const order = this.groupOrder;
    let index = order.indexOf(this.activeGroup);
    if (index < 0) index = 0;
    index = (index + delta + order.length) % order.length;
    this.activeGroup = order[index];
    this._syncGroupNav(containerEl);
  }

  _syncGroupNav(containerEl) {
    const select = containerEl.querySelector(".ai-metadata-settings-nav select");
    if (select) select.value = this.activeGroup;
    containerEl.querySelectorAll(".ai-metadata-settings-group").forEach((group) => {
      const active = group.getAttribute("data-group") === this.activeGroup;
      group.classList.toggle("is-active", active);
      group.classList.toggle("is-hidden", !active);
    });
  }
}

// 缺失元数据补全 / 顺序修正（子模块）
//   职责：只管「存不存在」与「顺序对不对」（格式是否合规由「格式巡检」负责）。
//   1) 点「巡检一次」→ 扫描白名单目录（开启 status 校验时只含 status: done）：
//      哪些文章的 AI 字段缺失/为空、哪些文章的 AI 字段顺序不符合配置；
//   2) 勾选（或全选 + 「本次处理数量」）后点「补全并排序」：
//      逐篇先本地摆正顺序 → 只重新生成缺的/空的那个字段 → 再摆一次顺序 → 二次验证；
//   3) 不重复运行，仍不合格的留给人工检查。
/** 模板批量补全前的确认弹窗（1.30 由原 docs-template 的 AuditConfirmModal 并入）。 */
class TemplateAuditConfirmModal extends Modal {
  constructor(app, message, onConfirm) {
    super(app);
    this.message = message;
    this.onConfirm = onConfirm;
  }
  onOpen() {
    this.titleEl.setText("审查并补全元数据");
    this.contentEl.createEl("p", { text: this.message });
    new Setting(this.contentEl)
      .addButton((button) => { button.setButtonText("取消").onClick(() => this.close()); })
      .addButton((button) => {
        button.setButtonText("开始补全").setCta().onClick(() => {
          this.close();
          void this.onConfirm();
        });
      });
  }
  onClose() {
    this.contentEl.empty();
  }
}

class MetadataGapModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.data = null;
    this.selected = new Set();
    this.results = null;
    this.busy = false;
    this.progressText = "";
    this.renderLimit = 200;
    this.fixLimit = 10;
    this.itemCheckboxes = [];
    this.fixButtonEl = null;
    this.progressEl = null;
  }

  onOpen() {
    this.modalEl.addClass("ai-metadata-gap-modal");
    this.render();
  }

  onClose() {
    this.contentEl.empty();
  }

  itemKey(item) {
    return item.path;
  }

  render() {
    const { contentEl } = this;
    contentEl.empty();
    this.fixButtonEl = null;
    this.progressEl = null;
    contentEl.createEl("h2", { text: "缺失元数据补全 / 顺序修正" });
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: "巡检「存不存在」与「顺序对不对」：缺失/为空的 AI 字段会被列出来，AI 字段顺序与设置里「元数据顺序」不一致的也会被标出来。"
        + "补全会逐个字段重新生成（只生成缺的那些），并把 AI 字段按配置顺序摆正；非 AI 字段（status 等）一律不动。格式是否合规请用「格式巡检」。",
    });
    const orderText = this.plugin.getMetadataKeyOrder().join(" → ");
    contentEl.createEl("p", { cls: "setting-item-description", text: `当前元数据顺序：${orderText}` });

    const toolbar = contentEl.createDiv({ attr: { style: "display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:6px 0 10px;" } });
    const addButton = (label, fn, cls) => {
      const button = toolbar.createEl("button", { text: label, cls: cls || "" });
      button.addEventListener("click", fn);
      return button;
    };
    addButton("巡检一次", () => void this.runInspection(), "mod-cta");
    this.fixButtonEl = addButton("补全并排序（已选 0，本次 0）", () => void this.runFix(), "");
    addButton("仅修正顺序（不调 AI）", () => void this.runOrderFixOnly(), "");
    addButton("停止", () => {
      if (this.plugin.stopMetadataGapRun()) {
        this.progressText = "正在停止…";
        this.updateProgressUI();
      }
    });
    addButton("全选", () => {
      if (!this.data) return;
      this.data.items.forEach((it) => this.selected.add(this.itemKey(it)));
      this.syncCheckboxes();
      this.updateSelectionUI();
    });
    addButton("全不选", () => {
      this.selected.clear();
      this.syncCheckboxes();
      this.updateSelectionUI();
    });

    const limitWrap = toolbar.createEl("label", { attr: { style: "display:flex;gap:4px;align-items:center;margin-left:4px;" } });
    limitWrap.createSpan({ text: "本次处理数量（0=全部）" });
    const limitInput = limitWrap.createEl("input", { type: "number" });
    limitInput.value = String(this.fixLimit);
    limitInput.setAttribute("style", "width:72px;");
    limitInput.addEventListener("change", () => {
      const next = Number.parseInt(limitInput.value, 10);
      this.fixLimit = Number.isFinite(next) && next >= 0 ? next : 0;
      limitInput.value = String(this.fixLimit);
      this.updateSelectionUI();
    });

    this.progressEl = contentEl.createDiv({ cls: "ai-metadata-pending-loading" });
    this.updateProgressUI();

    if (!this.data) {
      contentEl.createEl("div", { cls: "ai-metadata-pending-empty", text: "点「巡检一次」扫描一次。处理完不会自动重跑，需要时再手动点一次。" });
      return;
    }

    const s = this.data.stats;
    const summary = contentEl.createDiv({ cls: "ai-metadata-pending-summary" });
    summary.createSpan({ text: `巡检 ${s.scanned}/${s.whitelistTotal} 篇` });
    if (s.statusFilterEnabled) summary.createSpan({ text: ` · 状态过滤 ${s.statusFiltered} 篇`, cls: "is-skipped" });
    summary.createSpan({ text: ` · 缺失 ${s.missingKeys} 项`, cls: s.missingKeys ? "is-pending" : "is-done" });
    summary.createSpan({ text: ` · 空值 ${s.emptyKeys} 项` });
    summary.createSpan({ text: ` · 顺序问题 ${s.orderIssues} 篇`, cls: s.orderIssues ? "is-pending" : "is-done" });
    summary.createSpan({ text: ` · 完整 ${s.complete} 篇` });
    summary.createSpan({ text: ` · 涉及 ${s.filesWithIssue} 篇` });

    const totalItems = this.data.items.length;
    contentEl.createEl("h4", { text: `巡检结果（${totalItems} 篇${totalItems > this.renderLimit ? `，下面只显示前 ${this.renderLimit} 篇` : ""}）` });
    if (!totalItems) {
      contentEl.createEl("p", { cls: "setting-item-description", text: "✅ 所有文章的 AI 字段都不缺、顺序也正确。" });
      return;
    }

    const listBox = contentEl.createDiv({
      attr: { style: "max-height:420px;overflow:auto;border:1px solid var(--background-modifier-border);border-radius:6px;padding:6px;" },
    });
    this.itemCheckboxes = [];
    const resultByPath = new Map((this.results || []).map((r) => [r.path, r]));

    for (const item of this.data.items.slice(0, this.renderLimit)) {
      const row = listBox.createDiv({ attr: { style: "padding:5px 6px;border-bottom:1px solid var(--background-modifier-border-hover);font-size:12px;" } });
      const head = row.createEl("div", { attr: { style: "display:flex;gap:8px;align-items:flex-start;" } });
      const box = head.createEl("input", { type: "checkbox" });
      const key = this.itemKey(item);
      box.checked = this.selected.has(key);
      box.addEventListener("change", () => {
        if (box.checked) this.selected.add(key);
        else this.selected.delete(key);
        this.updateSelectionUI();
      });
      this.itemCheckboxes.push({ key, box });

      const wrap = head.createDiv({ attr: { style: "flex:1;min-width:0;" } });
      wrap.createEl("div", { text: item.path, attr: { style: "word-break:break-all;" } });
      if (item.missingKeys.length) {
        wrap.createEl("div", { text: `➖ 缺失：${item.missingKeys.join("、")}`, attr: { style: "color:var(--text-error);margin-top:2px;" } });
      }
      if (item.emptyKeys.length) {
        wrap.createEl("div", { text: `⚠️ 空值：${item.emptyKeys.join("、")}`, attr: { style: "color:var(--text-warning);margin-top:2px;" } });
      }
      if (item.orderIssue) {
        wrap.createEl("div", { text: `🔀 顺序：实际 ${item.actualAi.join(" → ")}`, attr: { style: "margin-top:2px;" } });
        wrap.createEl("div", { text: `　　　应为 ${item.expectedAi.join(" → ")}`, attr: { style: "opacity:0.8;" } });
      }

      const result = resultByPath.get(key);
      if (result) {
        const verdict = result.error
          ? `❌ 处理失败：${result.error}`
          : result.fixed
            // 1.22：「仅修正顺序」并不补字段，文案必须区分，否则用户会以为字段也补齐了
            ? (result.orderOnly ? "✅ 顺序已正确（本次未补字段）" : "✅ 二次验证通过（字段齐全且顺序正确）")
            : `⚠️ 二次验证仍不合格：${(result.after && result.after.reason) || ""}（请人工检查）`;
        wrap.createEl("div", { text: verdict, attr: { style: `margin-top:2px;color:${result.fixed ? "var(--text-success)" : "var(--text-error)"};` } });
        if (result.after && result.after.aiKeysInFile) {
          wrap.createEl("div", { text: `处理后顺序：${result.after.aiKeysInFile.join(" → ")}`, attr: { style: "opacity:0.8;" } });
        }
      }
    }

    if (totalItems > this.renderLimit) {
      const more = contentEl.createEl("button", { text: `显示更多（还有 ${totalItems - this.renderLimit} 篇）` });
      more.addEventListener("click", () => {
        this.renderLimit += 200;
        this.render();
      });
    }

    this.updateSelectionUI();
  }

  updateSelectionUI() {
    const selected = this.data ? this.data.items.filter((it) => this.selected.has(this.itemKey(it))) : [];
    const limit = this.fixLimit > 0 ? Math.min(this.fixLimit, selected.length) : selected.length;
    if (this.fixButtonEl) {
      this.fixButtonEl.setText(`补全并排序（已选 ${selected.length}，本次 ${limit}）`);
      this.fixButtonEl.toggleClass("mod-warning", selected.length > 0);
    }
  }

  syncCheckboxes() {
    for (const entry of this.itemCheckboxes || []) {
      entry.box.checked = this.selected.has(entry.key);
    }
  }

  updateProgressUI() {
    if (!this.progressEl || !this.progressEl.isConnected) return;
    this.progressEl.setText(this.progressText || "");
  }

  async runInspection() {
    if (this.busy) return;
    this.busy = true;
    this.progressText = "正在巡检…";
    this.results = null;
    this.selected.clear();
    this.render();
    try {
      this.data = await this.plugin.runMetadataGapInspection({
        onProgress: (event) => {
          this.progressText = event.done ? `扫描完成：${event.total} 篇` : `正在扫描 ${event.scanned}/${event.total}…`;
          this.updateProgressUI();
        },
      });
    } catch (error) {
      new Notice(`xyblue135 私人·AI 元数据：巡检失败：${error instanceof Error ? error.message : String(error)}`, 8000);
      this.data = null;
    } finally {
      this.busy = false;
      this.progressText = "";
      if (this.contentEl.isConnected) this.render();
    }
  }

  async runFix() {
    if (this.busy || !this.data) return;
    const all = this.data.items.filter((it) => this.selected.has(this.itemKey(it)));
    if (!all.length) {
      new Notice("xyblue135 私人·AI 元数据：请先勾选要处理的文章");
      return;
    }
    const items = this.plugin.pickRepairItems(all, this.fixLimit);
    this.busy = true;
    this.results = null;
    this.progressText = `准备处理 ${items.length} 篇（每次生成后等待 ${this.plugin.settings.requestIntervalSeconds} 秒）…`;
    this.render();
    try {
      this.results = await this.plugin.fixMetadataGaps(items, (event) => {
        this.progressText = `[${event.index}/${event.total}] ${event.path}`
          + (event.phase === "success" ? " · ✅ 二次验证通过"
            : event.phase === "still-issue" ? " · ⚠️ 仍不合格"
              : event.phase === "error" ? " · ❌ 失败" : " · 处理中…");
        this.updateProgressUI();
      });
      const ok = this.results.filter((r) => r.fixed).length;
      const still = this.results.filter((r) => !r.fixed && !r.stopped).length;
      const remaining = all.length - items.length;
      new Notice(`xyblue135 私人·AI 元数据：处理完成 — 二次验证通过 ${ok} 篇，仍需人工检查 ${still} 篇`
        + `${remaining > 0 ? `；本次未处理 ${remaining} 篇（受「本次处理数量」限制）` : ""}（不会自动重跑）`, 11000);
    } catch (error) {
      // 1.5：插件内部抛错（如单篇读盘失败、data.json 写入失败）时明确反馈，避免整批静默中断、用户误以为已完成
      this.results = Array.isArray(this.results) ? this.results : [];
      new Notice("xyblue135 私人·AI 元数据：处理中断：" + (error instanceof Error ? error.message : String(error)), 9000);
    } finally {
      this.busy = false;
      this.progressText = "";
      if (this.contentEl.isConnected) this.render();
    }
  }

  // 只修正顺序：纯本地重排，不调用 AI、不产生费用。
  async runOrderFixOnly() {
    if (this.busy || !this.data) return;
    const targets = this.data.items.filter((it) => this.selected.has(this.itemKey(it)) && it.orderIssue);
    const list = this.plugin.pickRepairItems(targets, this.fixLimit);
    if (!list.length) {
      new Notice("xyblue135 私人·AI 元数据：勾选项里没有「顺序问题」的文章");
      return;
    }
    this.busy = true;
    this.progressText = `正在修正 ${list.length} 篇的顺序…`;
    this.render();
    const results = [];
    try {
      for (const item of list) {
        try {
          await this.plugin.fixMetadataKeyOrder(item.file);
          const after = await this.plugin.verifyMetadataGaps(item.file);
          // 1.22：带上「仅顺序」标记，避免渲染时把「只修了顺序」说成「字段齐全且顺序正确」
          results.push({ ...item, orderOnly: true, after, fixed: after.orderOk });
        } catch (error) {
          results.push({ ...item, error: error instanceof Error ? error.message : String(error), after: null, fixed: false });
        }
      }
      this.results = results;
      const ok = results.filter((r) => r.fixed).length;
      new Notice(`xyblue135 私人·AI 元数据：顺序修正完成 — ${ok}/${results.length} 篇顺序已正确`, 8000);
    } finally {
      this.busy = false;
      this.progressText = "";
      if (this.contentEl.isConnected) this.render();
    }
  }
}

// 格式巡检面板（手动一次）：
//   1) 点「开始巡检」→ 扫描白名单目录（并按 status: done 过滤）里 7 个字段的格式；
//   2) 每条问题前有勾选框，可单独勾选要修的项；
//   3) 点「AI 修复选中项」→ 逐项只重新生成那一个字段 → 立刻做一次二次验证；
//   4) 修完不再重复运行，仍不通过的留给人工检查。
/** 0.9.0：时效复检清单 —— 仓库活动驱动 + 核验年龄兜底，点击直接重跑时效三键。 */
class FreshnessRecheckModal extends Modal {
  constructor(app, plugin, items) {
    super(app);
    this.plugin = plugin;
    this.items = Array.isArray(items) ? items : [];
  }

  onOpen() {
    this.contentEl.empty();
    this.contentEl.createEl("h3", { text: "时效复检清单" });
    this.contentEl.createEl("p", {
      text: "仓库笔记对照 GitHub pushed_at（缓存 1 小时）；文章按 AI_last_verified 年龄兜底。点击条目打开笔记并重跑时效三键（AI_freshness / AI_freshness_note / AI_last_verified）。",
    });
    if (!this.items.length) {
      this.contentEl.createEl("p", { text: "没有需要复检的笔记 🎉" });
      return;
    }
    for (const item of this.items) {
      const row = this.contentEl.createDiv({ cls: "ai-metadata-recheck-row" });
      row.createEl("div", { text: `${item.urgent ? "🔔 " : "🕒 "}${item.file.basename}` });
      row.createEl("div", { text: item.reason, cls: "ai-metadata-recheck-reason" });
      const btn = row.createEl("button", { text: "打开并重新评估时效" });
      btn.addEventListener("click", async () => {
        this.close();
        await this.plugin.app.workspace.getLeaf("tab").openFile(item.file);
        await this.plugin.generateForActiveFile("freshness");
      });
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

class FormatInspectionModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.data = null;
    this.selected = new Set();
    this.repairResults = null;
    // 默认不勾选：格式巡检只关心「有内容但格式不对」，缺失/空值交给「缺失元数据补全」子模块。
    this.includeMissing = false;
    this.busy = false;
    this.progressText = "";
    // 性能相关：结果列表默认只渲染前 200 条（避免上千个 DOM 节点卡死）；
    // 全选之后默认一次只修 10 项，可用界面上的「本次修复数量」随时调整（0 = 全部）。
    this.renderLimit = 200;
    this.repairLimit = 10;
    this.itemCheckboxes = [];
    this.repairButtonEl = null;
    this.progressEl = null;
  }

  onOpen() {
    this.modalEl.addClass("ai-metadata-inspection-modal");
    this.render();
  }

  onClose() {
    this.contentEl.empty();
  }

  itemKey(item) {
    return `${item.path}::${item.kind}`;
  }

  categoryLabel(category) {
    if (category === "fail") return { text: "格式不通过", icon: "❌" };
    if (category === "empty") return { text: "空值", icon: "⚠️" };
    return { text: "字段缺失", icon: "➖" };
  }

  render() {
    const { contentEl } = this;
    contentEl.empty();
    this.repairButtonEl = null;
    this.selectionLabelEl = null;
    this.progressEl = null;
    contentEl.createEl("h2", { text: "格式巡检（手动一次）" });
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: "只巡检白名单目录（开启 status 校验时只含 status: done 的文章），对各 AI 字段执行各模块设置里的「格式校验」正则。"
        + "本操作只读取、不修改任何数据；修复时才写入，且每次只重新生成一个字段。",
    });

    // ---------- 勾选项 ----------
    const options = contentEl.createDiv({ attr: { style: "display:flex;flex-direction:column;gap:4px;margin:6px 0 10px;" } });
    const mkCheck = (label, checked, onChange) => {
      const wrap = options.createEl("label", { attr: { style: "display:flex;gap:6px;align-items:center;cursor:pointer;" } });
      const box = wrap.createEl("input", { type: "checkbox" });
      box.checked = checked;
      box.addEventListener("change", () => onChange(box.checked));
      wrap.createSpan({ text: label });
      return box;
    };
    mkCheck("把「字段缺失 / 空值」也算作问题", this.includeMissing, (v) => {
      this.includeMissing = v;
      this.data = null;
      this.selected.clear();
      this.repairResults = null;
      this.render();
    });
    const statusNote = this.plugin.settings.statusDoneOnlyEnabled === true
      ? "☑ 只巡检 status: done 的文章（来自「元数据 status 校验」设置）"
      : "☐ 未启用 status 校验：将巡检白名单目录里的全部文章";
    options.createEl("div", { cls: "setting-item-description", text: statusNote });

    // ---------- 操作按钮 ----------
    const toolbar = contentEl.createDiv({ attr: { style: "display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px;" } });
    const addButton = (label, fn, cls) => {
      const button = toolbar.createEl("button", { text: label, cls: cls || "" });
      button.addEventListener("click", fn);
      return button;
    };
    addButton("开始巡检", () => void this.runInspection(), "mod-cta");
    this.repairButtonEl = addButton("AI 修复选中项（0）", () => void this.runRepair(), "");
    addButton("停止修复", () => {
      if (this.plugin.stopFormatInspection()) {
        this.progressText = "正在停止…";
        this.updateProgressUI();
      }
    });
    // 全选/全不选只更新计数与按钮文字，不整页重渲染（整页重渲染是巡检卡顿的主因）。
    addButton("全选", () => {
      if (!this.data) return;
      this.data.items.forEach((it) => this.selected.add(this.itemKey(it)));
      this.syncSelectionToCheckboxes();
      this.updateSelectionUI();
    });
    addButton("全不选", () => {
      this.selected.clear();
      this.syncSelectionToCheckboxes();
      this.updateSelectionUI();
    });

    // 数量输入：全选之后只修复前 N 项（0 表示不限）
    const limitWrap = toolbar.createEl("label", { attr: { style: "display:flex;gap:4px;align-items:center;margin-left:4px;" } });
    limitWrap.createSpan({ text: "本次修复数量（0=全部）" });
    const limitInput = limitWrap.createEl("input", { type: "number" });
    limitInput.value = String(this.repairLimit);
    limitInput.setAttribute("style", "width:72px;");
    limitInput.addEventListener("change", () => {
      const next = Number.parseInt(limitInput.value, 10);
      this.repairLimit = Number.isFinite(next) && next >= 0 ? next : 0;
      limitInput.value = String(this.repairLimit);
      this.updateSelectionUI();
    });

    this.progressEl = contentEl.createDiv({ cls: "ai-metadata-pending-loading" });
    this.updateProgressUI();

    // ---------- 巡检结果 ----------
    if (!this.data) {
      contentEl.createEl("div", { cls: "ai-metadata-pending-empty", text: "点「开始巡检」扫描一次。修复后不会自动重跑，需要时再手动点一次。" });
      return;
    }

    const s = this.data.stats;
    const summary = contentEl.createDiv({ cls: "ai-metadata-pending-summary" });
    summary.createSpan({ text: `巡检 ${s.scanned}/${s.whitelistTotal} 篇` });
    if (s.statusFilterEnabled) summary.createSpan({ text: ` · 状态过滤 ${s.statusFiltered} 篇`, cls: "is-skipped" });
    summary.createSpan({ text: ` · 格式不通过 ${s.fail}`, cls: s.fail ? "is-pending" : "is-done" });
    summary.createSpan({ text: ` · 空值 ${s.empty}` });
    summary.createSpan({ text: ` · 缺失 ${s.missing}` });
    summary.createSpan({ text: ` · 通过 ${s.pass}` });
    if (s.rulesSkipped) summary.createSpan({ text: ` · 跳过（无规则/已关闭）${s.rulesSkipped}`, cls: "is-skipped" });
    summary.createSpan({ text: ` · 涉及 ${s.filesWithIssue} 篇` });

    const totalItems = this.data.items.length;
    contentEl.createEl("h4", { text: `巡检结果（${totalItems} 条${totalItems > this.renderLimit ? `，下面只显示前 ${this.renderLimit} 条` : ""}）` });
    if (!totalItems) {
      contentEl.createEl("p", { cls: "setting-item-description", text: "✅ 全部字段都符合各自的正则规则。" });
      return;
    }

    // 性能：默认只渲染前 N 条，避免一次创建上千个 DOM 节点导致卡死。
    const listBox = contentEl.createDiv({
      attr: { style: "max-height:420px;overflow:auto;border:1px solid var(--background-modifier-border);border-radius:6px;padding:6px;" },
    });
    this.itemCheckboxes = [];
    const shown = this.data.items.slice(0, this.renderLimit);
    const resultByKey = new Map((this.repairResults || []).map((r) => [`${r.path}::${r.kind}`, r]));

    for (const item of shown) {
      const meta = this.categoryLabel(item.category);
      const row = listBox.createDiv({ attr: { style: "padding:5px 6px;border-bottom:1px solid var(--background-modifier-border-hover);font-size:12px;" } });
      const head = row.createEl("div", { attr: { style: "display:flex;gap:8px;align-items:flex-start;" } });
      const box = head.createEl("input", { type: "checkbox" });
      const key = this.itemKey(item);
      box.checked = this.selected.has(key);
      box.addEventListener("change", () => {
        if (box.checked) this.selected.add(key);
        else this.selected.delete(key);
        this.updateSelectionUI();
      });
      this.itemCheckboxes.push({ key, box });

      const textWrap = head.createDiv({ attr: { style: "flex:1;min-width:0;" } });
      textWrap.createEl("div", { text: `${meta.icon} ${meta.text} · ${item.fieldKey}` });
      textWrap.createEl("div", { text: item.path, attr: { style: "opacity:0.75;word-break:break-all;" } });
      if (item.failedRules.length) {
        const rules = textWrap.createEl("div", { attr: { style: "margin-top:2px;" } });
        rules.createSpan({ text: "未匹配的规则：" });
        item.failedRules.forEach((rule) => {
          rules.createEl("div", { attr: { style: "margin-left:10px;" } }).createEl("code", { text: rule });
        });
      }
      if (item.text) {
        const details = textWrap.createEl("details");
        details.createEl("summary", { text: `查看实际值（${item.text.length} 字符）` });
        details.createEl("pre", {
          text: item.text,
          attr: { style: "white-space:pre-wrap;word-break:break-all;max-height:160px;overflow:auto;font-size:11px;margin:4px 0;" },
        });
      }
      const result = resultByKey.get(key);
      if (result) {
        const verdict = result.repairError
          ? `❌ 修复失败：${result.repairError}`
          : result.repaired
            ? "✅ 二次验证通过"
            : `⚠️ 二次验证仍不通过：${(result.after && result.after.reason) || ""}（请人工检查）`;
        textWrap.createEl("div", { text: verdict, attr: { style: `margin-top:2px;color:${result.repaired ? "var(--text-success)" : "var(--text-error)"};` } });
        if (result.after && result.after.failedRules && result.after.failedRules.length) {
          result.after.failedRules.forEach((rule) => {
            textWrap.createEl("div", { attr: { style: "margin-left:10px;" } }).createEl("code", { text: rule });
          });
        }
        if (result.after && result.after.text) {
          const afterDetails = textWrap.createEl("details");
          afterDetails.createEl("summary", { text: "查看修复后的值" });
          afterDetails.createEl("pre", {
            text: result.after.text,
            attr: { style: "white-space:pre-wrap;word-break:break-all;max-height:160px;overflow:auto;font-size:11px;margin:4px 0;" },
          });
        }
      }
    }

    if (totalItems > this.renderLimit) {
      const more = contentEl.createEl("button", { text: `显示更多（还有 ${totalItems - this.renderLimit} 条）` });
      more.addEventListener("click", () => {
        this.renderLimit += 200;
        this.render();
      });
    }

    this.updateSelectionUI();
  }

  // 只更新「选中数 + 修复按钮文字」，不重建 DOM。
  updateSelectionUI() {
    const selected = this.data ? this.data.items.filter((it) => this.selected.has(this.itemKey(it))) : [];
    const limit = this.repairLimit > 0 ? Math.min(this.repairLimit, selected.length) : selected.length;
    if (this.repairButtonEl) {
      this.repairButtonEl.setText(`AI 修复选中项（已选 ${selected.length}，本次修复 ${limit}）`);
      this.repairButtonEl.toggleClass("mod-warning", selected.length > 0);
    }
  }

  // 全选/全不选后把已渲染的复选框同步一下，避免视觉与状态不一致。
  syncSelectionToCheckboxes() {
    for (const entry of this.itemCheckboxes || []) {
      entry.box.checked = this.selected.has(entry.key);
    }
  }

  updateProgressUI() {
    if (!this.progressEl) return;
    if (!this.progressEl.isConnected) return;
    this.progressEl.setText(this.progressText || "");
  }

  async runInspection() {
    if (this.busy) return;
    this.busy = true;
    this.progressText = "正在巡检…";
    this.repairResults = null;
    this.selected.clear();
    this.render();
    try {
      this.data = await this.plugin.runFormatInspection({
        includeMissing: this.includeMissing,
        onProgress: (event) => {
          this.progressText = event.done
            ? `扫描完成：${event.total} 篇`
            : `正在扫描 ${event.scanned}/${event.total}…`;
          this.updateProgressUI();
        },
      });
    } catch (error) {
      new Notice(`xyblue135 私人·AI 元数据：巡检失败：${error instanceof Error ? error.message : String(error)}`, 8000);
      this.data = null;
    } finally {
      this.busy = false;
      this.progressText = "";
      if (this.contentEl.isConnected) this.render();
    }
  }

  async runRepair() {
    if (this.busy || !this.data) return;
    const all = this.data.items.filter((it) => this.selected.has(this.itemKey(it)));
    if (!all.length) {
      new Notice("xyblue135 私人·AI 元数据：请先勾选要修复的项");
      return;
    }
    // 全选之后按「本次修复数量」截取，默认一次修 10 项，避免一口气跑几百项。
    const items = this.plugin.pickRepairItems(all, this.repairLimit);
    this.busy = true;
    this.repairResults = null;
    this.progressText = `准备修复 ${items.length} 项（每次生成后等待 ${this.plugin.settings.requestIntervalSeconds} 秒）…`;
    this.render();
    try {
      this.repairResults = await this.plugin.repairInspectionItems(items, (event) => {
        this.progressText = `[${event.index}/${event.total}] ${event.path} · ${event.fieldKey}`
          + (event.phase === "success" ? " · ✅ 二次验证通过"
            : event.phase === "still-failing" ? " · ⚠️ 仍不通过"
              : event.phase === "error" ? " · ❌ 修复失败" : " · 生成中…");
        this.updateProgressUI();
      });
      const ok = this.repairResults.filter((r) => r.repaired).length;
      const still = this.repairResults.filter((r) => !r.repaired && !r.stopped).length;
      const remaining = all.length - items.length;
      new Notice(`xyblue135 私人·AI 元数据：修复完成 — 二次验证通过 ${ok} 项，仍需人工检查 ${still} 项`
        + `${remaining > 0 ? `；本次未处理 ${remaining} 项（受「本次修复数量」限制）` : ""}（不会自动重跑）`, 11000);
    } catch (error) {
      // 1.5：插件内部抛错时明确反馈，避免整批静默中断、用户误以为已完成
      this.repairResults = Array.isArray(this.repairResults) ? this.repairResults : [];
      new Notice("xyblue135 私人·AI 元数据：修复中断：" + (error instanceof Error ? error.message : String(error)), 9000);
    } finally {
      this.busy = false;
      this.progressText = "";
      if (this.contentEl.isConnected) this.render();
    }
  }
}

// 日志与报错查看器：只展示与清理，不修改任何笔记数据。
class LogViewerModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    // 1.23：日志列表单次渲染条数上限，初始 500，点「显示更多」按 500 递增。
    this.logRenderLimit = 500;
  }

  onOpen() {
    this.render();
  }

  render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ai-metadata-log-modal");
    const stats = this.plugin.getLogStats();

    contentEl.createEl("h2", { text: "日志与报错" });
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: `共 ${stats.total} 条（错误 ${stats.errors}、警告 ${stats.warns}）；条数上限 ${stats.maxEntries}；`
        + `保留 ${stats.retentionDays > 0 ? `${stats.retentionDays} 天` : "不限时间"}；`
        + `另有 ${stats.fileErrors} 篇笔记留有「上次错误」。日志不含笔记正文。`,
    });

    const actions = contentEl.createDiv({ attr: { style: "display:flex;gap:8px;flex-wrap:wrap;margin:8px 0 14px;" } });
    const addAction = (label, fn) => {
      const button = actions.createEl("button", { text: label });
      button.addEventListener("click", fn);
      return button;
    };
    addAction("立即清理（按保留天数）", () => {
      const removed = this.plugin.pruneLogs();
      new Notice(`xyblue135 私人·AI 元数据：已按保留天数清理 ${removed} 条`);
      // 1.21：写盘失败必须给出提示；弹窗已关闭时不再白渲染一次几百条日志
      void this.plugin.saveAllData()
        .then(() => { if (this.contentEl.isConnected) this.render(); })
        .catch((error) => new Notice(`xyblue135 私人·AI 元数据：保存失败：${error instanceof Error ? error.message : String(error)}`, 9000));
    });
    addAction("清空全部日志", () => {
      const count = this.plugin.clearLogs();
      new Notice(`xyblue135 私人·AI 元数据：已清空 ${count} 条日志`);
      // 1.21：同上，失败要提示、关闭后不渲染
      void this.plugin.saveAllData()
        .then(() => { if (this.contentEl.isConnected) this.render(); })
        .catch((error) => new Notice(`xyblue135 私人·AI 元数据：保存失败：${error instanceof Error ? error.message : String(error)}`, 9000));
    });
    addAction("刷新", () => this.render());
    addAction("复制全部日志", async () => {
      const all = (Array.isArray(this.plugin.state.logs) ? this.plugin.state.logs : []);
      const text = all.map((entry) => this.plugin.formatLogEntryForCopy(entry)).join("\n\n");
      const ok = await this.plugin.copyTextToClipboard(text);
      new Notice(ok ? `xyblue135 私人·AI 元数据：已复制 ${all.length} 条日志` : "xyblue135 私人·AI 元数据：复制失败");
    });

    const icon = (level) => (level === "error" ? "❌" : level === "warn" ? "⚠️" : level === "success" ? "✅" : "ℹ️");

    const logs = Array.isArray(this.plugin.state.logs) ? this.plugin.state.logs.slice().reverse() : [];
    // 1.23：固定只渲染 500 条，但设置允许保留 2000 条：改为可增量显示，并在表头标明显示范围。
    if (!Number.isFinite(this.logRenderLimit) || this.logRenderLimit < 500) this.logRenderLimit = 500;
    const shown = Math.min(this.logRenderLimit, logs.length);
    contentEl.createEl("h4", {
      text: logs.length > shown
        ? `运行日志（最新在前，仅显示最新 ${shown}/${logs.length} 条）`
        : "运行日志（最新在前）",
    });
    if (!logs.length) {
      contentEl.createEl("p", { cls: "setting-item-description", text: "（暂无日志）" });
    }
    const listBox = contentEl.createDiv({
      attr: { style: "max-height:380px;overflow:auto;border:1px solid var(--background-modifier-border);border-radius:6px;padding:6px;" },
    });
    for (const entry of logs.slice(0, shown)) {
      const level = String(entry.level || "info");
      const row = listBox.createDiv({
        attr: {
          style: "padding:4px 6px;border-bottom:1px solid var(--background-modifier-border-hover);"
            + `font-size:12px;${level === "error" ? "color:var(--text-error);" : level === "warn" ? "color:var(--text-warning);" : ""}`,
        },
      });
      const head = `${icon(level)} ${this.plugin.formatLogTime(entry.at)}`;
      const where = [entry.phase, entry.errorType].filter(Boolean).join(" / ");
      const headRow = row.createEl("div", { attr: { style: "display:flex;gap:8px;align-items:center;flex-wrap:wrap;" } });
      headRow.createEl("span", { text: `${head}${where ? `  [${where}]` : ""}` });
      // 单条复制：只复制这一条（含模型原始输出）
      const copyOne = headRow.createEl("button", { text: "复制", attr: { type: "button", style: "font-size:11px;padding:1px 6px;" } });
      copyOne.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        const ok = await this.plugin.copyTextToClipboard(this.plugin.formatLogEntryForCopy(entry));
        new Notice(ok ? "xyblue135 私人·AI 元数据：已复制这一条日志" : "xyblue135 私人·AI 元数据：复制失败（请手动选中文本）");
      });
      if (entry.file) row.createEl("div", { text: entry.file, attr: { style: "opacity:0.75;" } });
      row.createEl("div", { text: String(entry.message || ""), attr: { style: "white-space:pre-wrap;word-break:break-all;" } });
      if (entry.raw) {
        const details = row.createEl("details");
        details.createEl("summary", { text: "模型原始输出" });
        details.createEl("pre", {
          text: String(entry.raw),
          attr: { style: "white-space:pre-wrap;word-break:break-all;max-height:200px;overflow:auto;font-size:11px;" },
        });
      }
    }

    // 1.23：日志超过当前显示上限时提供「显示更多」，让旧日志可查（原先固定 500 条且无任何提示）
    if (logs.length > shown) {
      const more = contentEl.createEl("button", { text: `显示更多（还有 ${logs.length - shown} 条）` });
      more.addEventListener("click", () => {
        this.logRenderLimit += 500;
        this.render();
      });
    }

    contentEl.createEl("h4", { text: "按笔记汇总的「上次错误」" });
    const fileErrors = this.plugin.getFileErrorSummary();
    if (!fileErrors.length) {
      contentEl.createEl("p", { cls: "setting-item-description", text: "（所有笔记都没有遗留错误）" });
      return;
    }
    const errBox = contentEl.createDiv({
      attr: { style: "max-height:300px;overflow:auto;border:1px solid var(--background-modifier-border);border-radius:6px;padding:6px;" },
    });
    for (const item of fileErrors) {
      const row = errBox.createDiv({ attr: { style: "padding:4px 6px;border-bottom:1px solid var(--background-modifier-border-hover);font-size:12px;" } });
      const errHead = row.createEl("div", { attr: { style: "display:flex;gap:8px;align-items:center;flex-wrap:wrap;" } });
      errHead.createEl("span", { text: `❌ ${item.path}${item.lastErrorType ? `  [${item.lastErrorType}]` : ""}` });
      const copyErr = errHead.createEl("button", { text: "复制", attr: { type: "button", style: "font-size:11px;padding:1px 6px;" } });
      copyErr.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        const text = [`文件：${item.path}`, `类型：${item.lastErrorType || "ERROR"}`, `错误：${item.lastError}`]
          .concat(item.lastRawModelOutput ? ["", "模型原始输出：", item.lastRawModelOutput] : [])
          .join("\n");
        const ok = await this.plugin.copyTextToClipboard(text);
        new Notice(ok ? "xyblue135 私人·AI 元数据：已复制该笔记的错误信息" : "xyblue135 私人·AI 元数据：复制失败");
      });
      row.createEl("div", { text: item.lastError, attr: { style: "white-space:pre-wrap;word-break:break-all;color:var(--text-error);" } });
      if (item.lastRawModelOutput) {
        const details = row.createEl("details");
        details.createEl("summary", { text: "模型原始输出" });
        details.createEl("pre", {
          text: item.lastRawModelOutput,
          attr: { style: "white-space:pre-wrap;word-break:break-all;max-height:200px;overflow:auto;font-size:11px;" },
        });
      }
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

// 格式校验结果弹窗：只展示，不修改任何数据。
class FormatCheckModal extends Modal {
  constructor(app, plugin, result, file) {
    super(app);
    this.plugin = plugin;
    this.result = result;
    this.file = file;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ai-metadata-format-check-modal");
    contentEl.createEl("h2", { text: `格式校验 · ${this.result.fieldKey}` });
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: `笔记：${this.file.path}`,
    });

    if (this.result.skipped) {
      contentEl.createEl("p", { text: `⏭ 已跳过：${this.result.reason}` });
      contentEl.createEl("p", {
        cls: "setting-item-description",
        text: "可在 设置 → 对应 AI 模块 → 格式校验 里启用并编辑规则。",
      });
      return;
    }

    if (!this.result.present) {
      contentEl.createEl("p", { text: `❌ 不通过：frontmatter 里没有 ${this.result.fieldKey} 这个键。` });
      return;
    }

    const failed = this.result.rules.filter((rule) => !rule.ok);
    contentEl.createEl("p", {
      text: this.result.passed
        ? `✅ 通过：${this.result.rules.length} 条规则全部匹配。`
        : `❌ 不通过：${failed.length} / ${this.result.rules.length} 条规则未匹配。`,
    });

    const list = contentEl.createDiv();
    for (const rule of this.result.rules) {
      const row = list.createDiv({
        attr: { style: "margin:6px 0;white-space:pre-wrap;word-break:break-all;line-height:1.5;" },
      });
      row.createEl("span", { text: rule.ok ? "✓ " : "✗ " });
      row.createEl("code", { text: rule.source });
      if (rule.error) {
        row.createEl("span", { text: `  ← 正则本身有错：${rule.error}` });
      }
    }

    contentEl.createEl("h4", { text: "实际值预览" });
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: `校验目标：${this.result.targetDescription}；实际长度 ${this.result.text.length} 字符。`,
    });
    contentEl.createEl("pre", {
      text: this.result.text,
      attr: {
        style: "white-space:pre-wrap;word-break:break-all;max-height:340px;overflow:auto;"
          + "background:var(--background-secondary);padding:8px;border-radius:6px;font-size:12px;",
      },
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

class TagCaseCleanupModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.running = false;
  }

  onOpen() {
    this.modalEl.addClass("ai-metadata-tag-cleanup-modal");
    void this.render();
  }

  onClose() {
    this.contentEl.empty();
  }

  async render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "整理已有 Tag 大小写冲突" });
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: "只扫描并修改白名单目录中的 frontmatter tags。规则与新生成 Tag 一致：同名变体按出现次数最多的现有写法统一；次数并列且技术词规范写法已经存在时，优先该写法。整个过程不调用 AI。",
    });

    const status = contentEl.createDiv({ cls: "ai-metadata-pending-loading" });
    status.setText("正在扫描 frontmatter tags…");
    let conflicts;
    try {
      conflicts = await this.plugin.getFrontmatterTagCaseConflicts();
    } catch (error) {
      status.setText(`扫描失败：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (!contentEl.isConnected) return;
    status.remove();

    if (!conflicts.length) {
      contentEl.createDiv({ cls: "ai-metadata-pending-empty", text: "没有发现仅大小写不同的 frontmatter Tag 冲突。" });
      return;
    }

    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: `发现 ${conflicts.length} 组冲突。下面是执行前预览：`,
    });
    const list = contentEl.createDiv({ cls: "ai-metadata-tag-catalog-preview" });
    for (const group of conflicts) {
      const row = list.createDiv({ cls: "ai-metadata-result-file" });
      const variants = group.variants.map((item) => `${item.value} ×${item.count}`).join("  /  ");
      row.setText(`${variants}  →  ${group.target}`);
    }

    const actions = contentEl.createDiv({ cls: "ai-metadata-pending-toolbar" });
    const execute = actions.createEl("button", { text: `执行统一（${conflicts.length} 组）`, cls: "mod-cta" });
    const cancel = actions.createEl("button", { text: "取消" });
    cancel.addEventListener("click", () => this.close());
    execute.addEventListener("click", async () => {
      if (this.running) return;
      this.running = true;
      execute.disabled = true;
      cancel.disabled = true;
      execute.setText("正在统一…");
      const progress = contentEl.createDiv({ cls: "ai-metadata-tree-live-progress" });
      try {
        const result = await this.plugin.applyFrontmatterTagCaseConflicts(conflicts, (event) => {
          if (progress.isConnected && event.changed) progress.setText(`[${event.index}/${event.total}] ${event.filePath}`);
        });
        new Notice(`xyblue135 私人·AI 元数据：已统一 ${result.changedFiles} 篇笔记中的 ${result.changedTags} 个 Tag 大小写`);
        await this.render();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        new Notice(`xyblue135 私人·AI 元数据：Tag 整理失败：${message}`, 7000);
        if (progress.isConnected) progress.setText(`整理失败：${message}`);
        execute.disabled = false;
        cancel.disabled = false;
        execute.setText("重新执行");
      } finally {
        this.running = false;
      }
    });
  }
}

class PendingNotesDashboardModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.lastResult = null;
    this.loading = false;
    this.expandedFolders = new Set();
    // 每篇巡检结果缓存（按 mtime + 上次错误信息失效），避免每次刷新整库重读
    this.inspectCache = new Map();
  }

  onOpen() {
    this.modalEl.addClass("ai-metadata-pending-modal", "ai-metadata-tree-modal");
    void this.render();
  }

  onClose() {
    this.contentEl.empty();
  }

  async render() {
    // 1.7：渲染序号：重复点「重新统计」、或识别结束后的自动 render 会并发跑全量扫描，
    // 期间各自 empty() 后再追加，会渲染出两份标题和两棵树。这里只保留最后一次渲染。
    const seq = (this.renderSeq = (this.renderSeq || 0) + 1);
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "待更新笔记 / 文件夹识别" });
    const intro = contentEl.createEl("div", { cls: "ai-metadata-pending-intro" });
    intro.setText("这里只负责「补充空数据」：按目录树列出白名单里缺失字段或字段为空的 Markdown，逐篇或按文件夹补全 AI 元数据（缺哪个补哪个，时效性三键作为一个整体生成）。"
      + "是否允许生成由全局的「元数据 status 校验」决定（见设置）；文章内的 ✨ 单字段按钮不受此限制。");

    const toolbar = contentEl.createDiv({ cls: "ai-metadata-pending-toolbar" });
    const refreshButton = toolbar.createEl("button", { text: "重新统计", cls: "mod-cta" });
    refreshButton.addEventListener("click", () => void this.render());

    if (this.plugin.manualFolderRun && !this.plugin.manualFolderRun.controller.signal.aborted) {
      const stopCurrentButton = toolbar.createEl("button", {
        text: "停止当前识别",
        cls: "ai-metadata-tree-stop",
        attr: { type: "button", title: `停止正在运行的目录：${this.plugin.manualFolderRun.folder}` },
      });
      stopCurrentButton.addEventListener("click", () => {
        const stopped = this.plugin.stopPendingFolderRun();
        if (stopped) {
          stopCurrentButton.disabled = true;
          stopCurrentButton.setText("正在停止…");
        }
      });
    }

    const status = contentEl.createDiv({ cls: "ai-metadata-pending-loading" });
    status.setText("正在扫描 00_docs…");

    let data;
    try {
      data = await this.plugin.getPendingDashboardData(true, this.inspectCache);
      this.lastData = data;
    } catch (error) {
      status.setText(`统计失败：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    // 1.7：期间又发起了新的渲染：丢弃这次（过期）结果，避免双份面板
    if (!this.contentEl.isConnected || seq !== this.renderSeq) return;

    const root = this.plugin.normalizeWhitelistFolder();
    if (!this.expandedFolders.size) this.expandedFolders.add(root);

    status.empty();
    status.addClass("ai-metadata-pending-summary");
    if (data.statusFilterEnabled) {
      status.createSpan({ text: `可识别 ${data.total}/${data.whitelistTotal} 篇 · ` });
      status.createSpan({ text: `仅 status: done`, cls: "ai-metadata-filter-badge" });
      status.createSpan({ text: ` · 状态过滤 ${data.statusFilteredSkipped} 篇`, cls: "is-skipped" });
      status.createSpan({ text: " · " });
    } else {
      status.createSpan({ text: `总计 ${data.total} 篇 · ` });
    }
    status.createSpan({ text: `待更新 ${data.pending} 篇`, cls: data.pending ? "is-pending" : "is-done" });
    status.createSpan({ text: ` · 已完成 ${data.done} 篇` });
    if (data.emptySkipped) status.createSpan({ text: ` · 无正文跳过 ${data.emptySkipped} 篇`, cls: "is-skipped" });

    if (this.lastResult) this.renderLastResult(contentEl, this.lastResult);

    const visibleGroups = data.folders.filter((group) => group.recursivePending > 0 || group.recursiveEmptySkipped > 0);
    if (!visibleGroups.length) {
      contentEl.createDiv({ cls: "ai-metadata-pending-empty", text: "当前没有待更新的 Markdown。" });
      return;
    }

    const byPath = new Map(visibleGroups.map((group) => [group.folder, group]));
    const childrenByParent = new Map();
    const pushChild = (parent, group) => {
      if (!childrenByParent.has(parent)) childrenByParent.set(parent, []);
      childrenByParent.get(parent).push(group);
    };
    for (const group of visibleGroups) {
      if (group.folder === root) continue;
      const slash = group.folder.lastIndexOf("/");
      const parent = slash >= 0 ? group.folder.slice(0, slash) : root;
      pushChild(byPath.has(parent) ? parent : root, group);
    }
    for (const children of childrenByParent.values()) {
      children.sort((a, b) => {
        if ((a.recursivePending > 0) !== (b.recursivePending > 0)) return a.recursivePending > 0 ? -1 : 1;
        return a.folder.localeCompare(b.folder, "zh-CN");
      });
    }

    const tree = contentEl.createDiv({ cls: "ai-metadata-folder-tree" });
    const rootGroup = byPath.get(root) || {
      folder: root,
      files: [],
      recursivePending: data.pending,
      recursiveTotal: data.total,
      recursiveEmptySkipped: data.emptySkipped || 0,
    };
    this.renderFolderNode(tree, rootGroup, childrenByParent, 0, root);
  }

  renderFolderNode(parent, group, childrenByParent, depth, root) {
    const children = childrenByParent.get(group.folder) || [];
    const directFiles = group.files.filter((item) => item.pending || item.emptyBody);
    const hasContent = children.length > 0 || directFiles.length > 0;
    const expanded = this.expandedFolders.has(group.folder);
    const node = parent.createDiv({ cls: "ai-metadata-tree-node" });
    node.dataset.folder = group.folder;

    const row = node.createDiv({ cls: "ai-metadata-tree-folder-row" });
    row.style.setProperty("--ai-tree-depth", String(depth));
    row.setAttribute("title", group.folder);

    const chevron = row.createEl("button", {
      cls: "ai-metadata-tree-chevron clickable-icon",
      attr: { type: "button", "aria-label": expanded ? "折叠文件夹" : "展开文件夹" },
    });
    setIcon(chevron, hasContent ? (expanded ? "chevron-down" : "chevron-right") : "minus");
    if (!hasContent) chevron.addClass("is-empty");

    const folderButton = row.createEl("button", { cls: "ai-metadata-tree-folder-label", attr: { type: "button" } });
    const folderIcon = folderButton.createSpan({ cls: "ai-metadata-tree-folder-icon" });
    setIcon(folderIcon, expanded ? "folder-open" : "folder");
    folderButton.createSpan({
      text: group.folder === root ? root : group.folder.slice(group.folder.lastIndexOf("/") + 1),
      cls: "ai-metadata-tree-folder-name",
    });

    const counts = row.createDiv({ cls: "ai-metadata-tree-counts" });
    if (group.recursivePending > 0) counts.createSpan({ text: `${group.recursivePending} 待更新`, cls: "is-pending" });
    else counts.createSpan({ text: "已完成", cls: "is-done" });
    counts.createSpan({ text: `${group.recursiveTotal} 篇` });
    if (group.recursiveEmptySkipped) counts.createSpan({ text: `${group.recursiveEmptySkipped} 无正文`, cls: "is-skipped" });

    if (group.folder === root) {
      const rootTag = row.createSpan({ text: "总览", cls: "ai-metadata-tree-root-tag" });
      rootTag.setAttribute("title", "根目录仅总览，避免误触发全部处理");
    } else if (group.recursivePending > 0) {
      const identifyButton = row.createEl("button", {
        text: `识别 ${group.recursivePending}`,
        cls: "ai-metadata-tree-identify mod-cta",
        attr: { type: "button", title: `识别 ${group.folder} 及其子文件夹中的 ${group.recursivePending} 篇待更新笔记` },
      });
      identifyButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void this.runFolderIdentification(group, identifyButton, node);
      });
    }

    const body = node.createDiv({ cls: "ai-metadata-tree-folder-body" });
    if (!expanded) body.addClass("is-collapsed");

    for (const info of directFiles) this.renderFileInfo(body, info, depth + 1);
    for (const child of children) this.renderFolderNode(body, child, childrenByParent, depth + 1, root);

    const toggle = () => {
      if (!hasContent) return;
      const next = !this.expandedFolders.has(group.folder);
      if (next) this.expandedFolders.add(group.folder);
      else this.expandedFolders.delete(group.folder);
      body.toggleClass("is-collapsed", !next);
      setIcon(chevron, next ? "chevron-down" : "chevron-right");
      setIcon(folderIcon, next ? "folder-open" : "folder");
      chevron.setAttribute("aria-label", next ? "折叠文件夹" : "展开文件夹");
    };
    chevron.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggle();
    });
    folderButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggle();
    });
  }

  renderFileInfo(parent, info, depth) {
    const row = parent.createDiv({ cls: "ai-metadata-file-row ai-metadata-tree-file-row" });
    row.style.setProperty("--ai-tree-depth", String(depth));
    const head = row.createDiv({ cls: "ai-metadata-file-head" });
    const docIcon = head.createSpan({ cls: "ai-metadata-tree-file-icon" });
    setIcon(docIcon, "file-text");
    const openButton = head.createEl("button", { cls: "ai-metadata-file-link", text: info.file.basename });
    openButton.setAttribute("title", info.file.path);
    openButton.addEventListener("click", async () => {
      const leaf = this.app.workspace.getLeaf(false);
      await leaf.openFile(info.file);
    });
    const badges = head.createDiv({ cls: "ai-metadata-file-badges" });
    if (info.emptyBody) badges.createSpan({ text: "无正文", cls: "ai-metadata-pending-badge is-skipped" });
    else {
      // 7 个字段一个都不能少：之前漏了 Take 与 QA，导致只缺这两项的笔记看不到任何徽章。
      if (!info.titleDone) badges.createSpan({ text: "AI Title", cls: "ai-metadata-pending-badge" });
      if (!info.summaryShortDone) badges.createSpan({ text: "Summary Short", cls: "ai-metadata-pending-badge" });
      if (!info.summaryLongDone) badges.createSpan({ text: "Summary Long", cls: "ai-metadata-pending-badge" });
      if (!info.tagsDone) badges.createSpan({ text: "Tags", cls: "ai-metadata-pending-badge" });
      if (!info.technicalDepthDone) badges.createSpan({ text: "Technical Depth", cls: "ai-metadata-pending-badge" });
      if (!info.takeDone) badges.createSpan({ text: "Take", cls: "ai-metadata-pending-badge" });
      if (!info.qaDone) badges.createSpan({ text: "QA", cls: "ai-metadata-pending-badge" });
    }
    row.createDiv({ cls: "ai-metadata-file-path", text: info.file.path });
    row.createDiv({ cls: "ai-metadata-file-preview", text: info.preview || "（无可预览正文）" });

    // 逐篇操作：只补缺失字段（不会覆盖已有内容），并遵守 status: done 规则。
    if (info.pending && !info.emptyBody) {
      const actions = row.createDiv({ attr: { style: "display:flex;gap:8px;flex-wrap:wrap;margin-top:2px;" } });
      const fillButton = actions.createEl("button", { cls: "ai-metadata-inline-action", text: "补全缺失字段" });
      fillButton.setAttribute("title", "只生成这篇笔记中缺失的字段；已有内容的字段不会被动到");
      fillButton.addEventListener("click", async () => {
        if (this.loading) return;
        this.loading = true;
        fillButton.disabled = true;
        fillButton.setText("处理中…");
        try {
          await this.plugin.retrySingleMetadataFile(info.file, true);
        } finally {
          this.loading = false;
          if (this.contentEl.isConnected) await this.render();
        }
      });
    }

    if (info.lastError) {
      const errRow = row.createDiv({ cls: "ai-metadata-file-error" });
      errRow.createSpan({ text: `上次错误：${info.lastError}` });
      const copyError = errRow.createEl("button", { text: "复制", attr: { type: "button", style: "font-size:11px;padding:1px 6px;margin-left:6px;" } });
      copyError.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        const text = [`文件：${info.file.path}`, `类型：${info.lastErrorType || "ERROR"}`, `错误：${info.lastError}`]
          .concat(info.lastRawModelOutput ? ["", "模型原始输出：", info.lastRawModelOutput] : [])
          .join("\n");
        const ok = await this.plugin.copyTextToClipboard(text);
        new Notice(ok ? "xyblue135 私人·AI 元数据：已复制该笔记的错误信息" : "xyblue135 私人·AI 元数据：复制失败");
      });
      if (info.lastRawModelOutput) {
        const raw = row.createEl("details", { cls: "ai-metadata-raw-output" });
        raw.createEl("summary", { text: "查看上次模型原始输出" });
        raw.createEl("pre", { text: info.lastRawModelOutput });
      }
    }
  }

  async runFolderIdentification(group, identifyButton, node) {
    if (this.loading) return;
    this.loading = true;
    this.expandedFolders.add(group.folder);
    // 1.6：折叠状态下点「识别」时同步展开 DOM：逐篇进度行写在文件夹 body 里，
    // 只改 Set 不改 DOM 会被 .is-collapsed 隐藏，看起来像卡死。
    const folderBody = node.querySelector(".ai-metadata-tree-folder-body");
    if (folderBody) folderBody.removeClass("is-collapsed");
    identifyButton.disabled = true;
    identifyButton.setText("识别中…");

    const stopButton = identifyButton.parentElement.createEl("button", {
      text: "停止识别",
      cls: "ai-metadata-tree-stop mod-warning",
      attr: { type: "button", title: "停止当前文件夹识别：不再处理后续文件，并中止当前等待中的 API 请求" },
    });
    const liveProgress = node.createDiv({ cls: "ai-metadata-tree-live-progress" });
    stopButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const stopped = this.plugin.stopPendingFolderRun(group.folder);
      if (stopped) {
        stopButton.disabled = true;
        stopButton.setText("正在停止…");
        liveProgress.setText("正在停止当前识别任务…");
      }
    });

    const updateProgress = (event) => {
      if (!liveProgress.isConnected) return;
      if (event.phase === "start") liveProgress.setText(`准备识别 ${event.total} 篇…`);
      else if (event.phase === "processing") liveProgress.setText(`[${event.index}/${event.total}] ${event.filePath}`);
      else if (event.phase === "success") liveProgress.setText(`✓ [${event.index}/${event.total}] ${event.filePath}${event.message ? ` — ${event.message}` : ""}`);
      else if (event.phase === "error") liveProgress.setText(`✕ [${event.index}/${event.total}] ${event.filePath}`);
      else if (event.phase === "skipped") liveProgress.setText(`⚠ [${event.index}/${event.total}] ${event.filePath} — ${event.message}`);
      else if (event.phase === "stopping") liveProgress.setText("正在停止当前识别任务…");
      else if (event.phase === "cancelled") liveProgress.setText(`已停止：成功 ${event.processed}，失败 ${event.failed}，跳过 ${event.skipped || 0}，剩余 ${event.remaining}`);
      else if (event.phase === "complete") liveProgress.setText(`完成：成功 ${event.processed}，失败 ${event.failed}，跳过 ${event.skipped || 0}，剩余 ${event.remaining}${event.untouched ? `｜未重新生成 ${event.untouched} 项已有内容` : ""}`);
    };
    try {
      this.lastResult = await this.plugin.runPendingFolder(group.folder, true, updateProgress);
    } finally {
      this.loading = false;
      if (stopButton.isConnected) stopButton.remove();
      if (this.contentEl.isConnected) await this.render();
    }
  }

  renderLastResult(parent, result) {
    const box = parent.createEl("details", { cls: "ai-metadata-last-result" });
    box.open = true;
    const title = box.createEl("summary", { text: `${result.cancelled ? "最近同步（已停止）" : "最近同步"}：${result.folder}` });
    title.setAttribute("title", result.folder);
    const body = box.createDiv({ cls: "ai-metadata-last-result-body" });
    body.createDiv({ text: `${result.cancelled ? "已停止 · " : ""}成功 ${result.processedFiles.length} · 失败 ${result.failedFiles.length} · 跳过 ${result.skippedFiles.length}${result.alreadyComplete ? ` · 已有全部内容未参与 ${result.alreadyComplete}` : ""} · 剩余 ${result.remaining}` });
    if (result.processedFiles.length) {
      // 汇总"重新生成了多少项 / 因已有内容跳过了多少项"，避免只看"成功 N 篇"就以为所有字段都被刷新了。
      const totalRegenerated = result.processedFiles.reduce((sum, item) => sum + (typeof item === "string" ? 0 : (item.regenerated || []).length), 0);
      const totalUntouched = result.processedFiles.reduce((sum, item) => sum + (typeof item === "string" ? 0 : (item.untouched || []).length), 0);
      const fieldSummary = totalUntouched
        ? `本次共重新生成 ${totalRegenerated} 项；另有 ${totalUntouched} 项因已有内容被跳过（只补缺失字段，不会覆盖已有内容）`
        : `本次共重新生成 ${totalRegenerated} 项`;
      body.createDiv({ cls: "ai-metadata-result-detail", text: fieldSummary });

      const ok = body.createEl("details");
      ok.createEl("summary", { text: `成功文件（${result.processedFiles.length}）` });
      for (const item of result.processedFiles) {
        const path = typeof item === "string" ? item : item.path;
        const row = ok.createDiv({ cls: "ai-metadata-result-file is-success" });
        row.createDiv({ text: `✓ ${path}` });
        if (typeof item !== "string") {
          if ((item.regenerated || []).length) {
            row.createDiv({ cls: "ai-metadata-result-detail", text: `重新生成：${item.regenerated.join("、")}` });
          }
          if ((item.untouched || []).length) {
            row.createDiv({ cls: "ai-metadata-result-detail is-skipped", text: `已有内容未重新生成：${item.untouched.join("、")}` });
          }
        }
      }
    }
    if (result.failedFiles.length) {
      const fail = body.createEl("details");
      fail.open = true;
      fail.createEl("summary", { text: `失败文件（${result.failedFiles.length}）` });
      for (const item of result.failedFiles) {
        const row = fail.createDiv({ cls: "ai-metadata-result-file is-error" });
        row.createDiv({ text: `✕ ${item.path} — ${item.message}` });
        if (item.rawOutput) {
          const raw = row.createEl("details", { cls: "ai-metadata-raw-output" });
          raw.createEl("summary", { text: "查看模型原始输出" });
          raw.createEl("pre", { text: item.rawOutput });
        }
      }
    }
    if (result.skippedFiles.length) {
      const skipped = body.createEl("details");
      skipped.createEl("summary", { text: `跳过文件（${result.skippedFiles.length}）` });
      for (const item of result.skippedFiles) {
        const path = typeof item === "string" ? item : item.path;
        const message = typeof item === "string" ? "跳过" : item.message;
        skipped.createDiv({ cls: "ai-metadata-result-file is-skipped", text: `⚠ ${path} — ${message}` });
      }
    }
  }
}

