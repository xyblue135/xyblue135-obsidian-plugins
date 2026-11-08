# xyblue135 · AI 检索

本地召回的**零 API 成本**检索 + AI 精排的两阶段检索，可再进一层做流式 AI 问答（RAG，带引用）。

> **1.0.0 起，原 `00_xyblue135-interview-rag`（面试检索）已并入本插件**，作为「面试问答模式」。
> 两者共用同一份索引、同一个 `baseUrl` / `apiKey`，但评分权重、模型、超时由 `iv*` 前缀的设置独立控制。
> 旧 `data.json` 的键会自动迁移，无需手填。

## 两阶段检索

| 阶段 | 做什么 | 成本 |
| --- | --- | --- |
| ① 本地召回 | 标题 / 标签 / AI 摘要 / 正文分词打分，从白名单目录里捞出候选（默认 50 条） | 0 |
| ② AI 精排 | 把候选交给 `chat/completions` 按相关度重排、丢弃无关项，并给一句理由 | 1 次调用 |

可选的第三阶段：

- **语义向量召回** —— 打开 `embeddingEnabled` 后额外用向量相似度补召回（本地算，仍不花 API）。
- **流式 AI 问答** —— 取精排前列文章的相关段落作资料，边生成边显示，答案带 `[n]` 引用，可点击跳原文。

## 面试问答模式

面试时 OBS 把面试官的话转写成文字，桥接程序写 `query.json`，本插件在毫秒级内召回知识库并把
`answer.json` 写回去，悬浮卡上直接是**能照着说出口的话**。整条链不经过网络端口，只读本地文件。

```
OBS 转写 ──→ bridge.py ──写 query.json──→ 本插件 ──写 answer.json──→ 悬浮卡
                                    ↑
                          同一份 index.json（与 AI 检索共用）
```

### 文件握手契约

```
query.json  = {"id": <毫秒时间戳 int>, "question": "..."}
answer.json = {"id": <同 id>, "answer": "...", "sources": [{"path", "title"}]}
           或 {"id": <同 id>, "error": "..."}
```

- `id` 必须原样回传；读到文件缺失 / 半截 JSON 时跳过，下个 tick 再试。
- 应答用 `.tmp` + rename **原子写**，UTF-8 **无 BOM** —— 桥接端可能在任意时刻读到它。
- 兜底时限（`ivAnswerDeadlineMs`，默认 12s）到点直接回错误应答，绝不静默（桥接端 15s 超时）。
- 这套字段名/编码是被外部 Python 程序消费的接口，**改动等于破坏契约**。

### 三级降级，不静默

```
直答模式（第一人称口语） → AI 精答（要点式） → 本地要点（零 API）
```

任一级失败都退回下一级并在弹 Notice 说明；`ivAiFallbackLocal` 关掉时 AI 失败会直接回错误应答。

### 检索差异（为什么面试要另一套权重）

- 查询侧先挖掉疑问/礼貌词（`怎么/如何/请问…`）再切二元组。否则「故障怎么处理」会被切成
  `障怎`、`么处` 这类跨词碎片，df 极低、idf 反而最高，把无关笔记顶到第一。
- 词频取对数（`log1p`），长文（命令手册式笔记）不靠堆词频霸榜。
- idf 封顶 3.5，稀有碎片不会一枝独秀。
- 命中段挑选时**标题命中额外加 3 倍权**。
- 热词表（`ivHotwordsFile`，与桥接共用的 `hotwords.txt`）每命中一个给整篇加分。

合并前的老插件与现在这套在 8 个真实问题上做过对比：TOP1、前 5 排序、最终本地要点文本**逐字节一致**。

### 命令

| 命令 | 用途 |
| --- | --- |
| `面试问答：打开控制台（模拟提问试答）` | 不开真面试也能试管线，与桥接走完全相同的代码路径 |
| `面试问答：开/关 ragfile 监听` | 面试前确认状态栏是「监听中」 |
| `面试问答：开/关 直答模式` | 临时切第一人称 / 要点式 |
| `面试问答：重建索引` | 与 AI 检索共用同一份索引，等价于「重建检索索引」 |
| `面试风格 → <预设名>` | `ivSpokenPromptPresets` 里每个键自动注册一条，可盲绑热键 |

## 功能

- 命令面板：`打开 AI 检索`、`重建检索索引` + 上表 4/5 条面试命令
- 结果行显示：标题、路径、标签、命中摘要（关键词 `<mark>` 高亮）、AI 精排理由、评分
- 结果行还会读 `metadataCache` 显示状态灯（🟢 done / 🔴 undone）和时效灯（`AI_freshness`）
- 点击结果直接用 Obsidian 的 `[[链接]]` 打开对应位置
- 状态栏一格显示两件事：`AI 检索：765 篇 · 监听中 · 直答`

## 索引

索引存在插件目录的 `index.json`（**不入 git**），检索与面试共用同一份。
启动时增量比对文件 hash，只重建变动的笔记；`autoRebuildHours > 0` 时定期全量重建（默认 0 = 关）。
只索引白名单目录（`whitelistFolder`，默认 `my_blog/00_docs` + `my_blog/00_agent_for_projects`，含子目录）。
面试监听在**索引加载完成后**才启动，避免启动瞬间的提问查到空索引。

### 什么时候需要重建

| 情况 | 说明 |
|---|---|
| 状态栏显示「0 篇」 | 索引没加载上，先重建 |
| 大批笔记改过名 / 挪过目录 | 增量比对按路径认文件，搬家会留残影 |
| 改了白名单目录 | 旧索引的 `whitelist` 不匹配会被整体丢弃，必须重建 |
| 新笔记死活搜不到 | 先确认它在白名单目录里，再重建 |
| 升级插件后 | 索引结构与插件版本绑定，可能需重建 |

### 怎么重建（三选一）

**① 面板工具栏**：检索框右侧 🔄 —— 普通重建，只处理变动项。

**② 命令面板**：搜「重建检索索引」—— 强制全量，清空后重扫。

**③ 命令行程序 xyindex（推荐）**

配套的独立程序，不打开 Obsidian 就能重建，并给出可以直接判读的数字。
路径 `D:\2document\obsidian_data\ai_index`，只要 Node ≥ 18，零依赖。

```bash
xyindex config vault "D:\2document\obsidian_data"   # 设一次默认 vault
xyindex rebuild                  # 真重建并写盘
xyindex rebuild --dry            # 只看统计，不写盘
xyindex stats                    # 索引体检
xyindex verify                   # 结构 / 一致性 / 死链 / 能否真 load()
```

它走的是本插件自己的 `reconcile()` + `saveNow()`，产物与点按钮完全同构
（用假 `obsidian` 模块在 Node 里真跑插件代码，不启动 Obsidian、不联网、不调 API）。
所以插件升级后它的结果自动跟着变，不存在「两份索引算法对不上」的问题。

正常输出：

```
  白名单外（不进索引）  33  vault 内 .md 共 798
  进索引                765  whitelist = my_blog/00_docs,my_blog/00_agent_for_projects
    ├ 正文为空          14  只有 frontmatter，靠摘要文本检索
    ├ strongText 为空   0
    └ 带向量            0 / 765  embeddingEnabled 关闭
  正文总字数       2,134,665
  index.json       4.44 MB
  补丁重放         2 篇  agent 写的内容已盖回索引
  fmFallback 标记  0  正常
  耗时             0.4s  onload 自动对账
```

**判读标准**（任一条不对就继续查）

- `进索引` 应等于白名单目录里的 md 数量。少于它 = 白名单配错，或有文件读不到
- `strongText 为空` 必须是 0。非 0 说明这些笔记连标题都没解析出来，搜不到
- `fmFallback 标记` 必须是 0。非 0 表示写入时元数据没就绪，Obsidian 下次启动会把全部文档重解析一遍
- `带向量` 只有开着 `embeddingEnabled` 时才应该 > 0

### 补内容：scan → agent → apply

索引里的摘要、别名标题靠 `rebuild` 是补不出来的（那需要读懂笔记）。这块交给 agent，
程序只负责校验和落盘 —— 它不调模型接口，也不读 `apiKey`。

```bash
xyindex scan --out=work.json      # 列出「有正文但缺字段」的笔记，导出待填模板
xyindex apply --from=work.json    # 校验后写回（同时写 index.overlay.json）
```

`apply` 写的内容落在补丁层 `index.overlay.json`，`rebuild` 重写 `index.json` 时会自动盖回去，
所以 agent 的活不会因为一次重建就白干。字段上限与允许写入的字段见程序 README。

只想让插件显示更好看、不折腾命令行的话，直接在笔记 frontmatter 里写
`AI_summary_short` / `AI_tags` 也可以，`rebuild` 会读进去。

### 索引所有者：谁写 index.json

`indexOwner` 决定索引由谁维护：

| 值 | 行为 |
|---|---|
| `plugin`（默认） | 插件自己扫描、自己写，和以前完全一样 |
| `external` | 插件**只读**，不再启动同步、不再定期重建；`index.json` 变化后 3 秒内自动重载 |

选 `external` 就是「程序建、插件读」：命令行跑完 `xyindex rebuild`，Obsidian 里几秒就生效，
不会出现「程序刚建完、插件启动又覆盖回去」。

代价只有一个：插件设置里那个「立即重建」按钮别再用 —— 它是插件自己重写索引，两边都写就又乱了。
改完这个开关要重启一次 Obsidian 才完全生效。

### 检索权重可调

`wStrong` / `wBody` / `phraseBonusStrong` / `phraseBonusBody` / `minScore` 五个键现在可配，
默认值 6 / 1 / 25 / 12 / 0 —— **等于历史硬编码值**，不动它们就完全等价于以前的行为。

调参别凭感觉，先用 `compare` 扫一遍看排序怎么动：

```bash
xyindex compare "回表" --sweep=wStrong:2,4,6,10,16 --top=5      # 看榜单变化
xyindex compare "索引" --sweep=wStrong:2,6,12 --target="隐藏row_id"  # 盯住某一篇的排名
xyindex config set wStrong 12                                   # 满意了写回插件
```

所有取值下排名都不变时，它会直接告诉你「这个参数对这个 query 不敏感」，省掉无效调参。

`xyindex search "词" --explain` 还能看出某篇是靠标题、摘要还是正文排上来的：

```
#1 【索引】索引简单说明
   mysql S2 B1  索引 T2 S26 B42
```

T = 标题命中，S = strongText（标题+标签+AI 摘要）命中，B = 正文命中，数字是次数。

### 为什么有的笔记搜出来没有正文

约 47 篇笔记的 frontmatter 占了全文 85% 以上——内容全在 `AI_summary_long` / `AI_take` / `AI_qa` 里，
正文是空的（多为「待补正文的占位笔记」）。索引把 `title` / `AI_title` / `tags` / `AI_summary_short` /
`AI_summary_long` 都算作检索文本，所以这些笔记搜得到；结果行没有正文片段时用摘要兜底显示。
想彻底解决只能补正文，补完重建会自动收进去。

### 语义向量（可选，默认关）

`embeddingEnabled` 默认 `false`。开启后走 `/v1/embeddings` 给每篇算向量，用于语义召回。
**开之前先看代价**：当前模型 `gemini-embedding-001` 是 3072 维，以 JSON 数字数组存进 `index.json`，
每篇约 40 KB —— 765 篇会把索引从 4.4 MB 撑到 30 MB 上下，而且每批 16 篇就要整份重写一次盘。
要开建议先把维度降下来（`dimensions` 参数或量化），否则重建会明显卡顿。

## 设置

设置页分两段：**主检索**默认展开，**面试问答**默认折叠（右上角「↓ 面试问答设置」可一键跳转并展开）。
折叠不是为了藏参数，是因为两段加起来 50+ 项，改 API / 白名单不该先滚过整个面试参数。

**接口**（两个模式共用）：`baseUrl`（默认 `http://127.0.0.1:31415/v1`）、`apiKey`、`requestTimeoutSeconds`、
`structuredJsonModeEnabled`、`jsonRepairEnabled`

**索引范围**：`whitelistFolder`、`includeSubfolders`、`localRecallLimit`、`indexOwner`（`plugin` / `external`）、
`autoIndexOnStartup`、`incrementalUpdateEnabled`、`autoRebuildHours`

**检索权重**：`wStrong`、`wBody`、`phraseBonusStrong`、`phraseBonusBody`、`minScore`（默认 6 / 1 / 25 / 12 / 0）

**语义召回**：`embeddingEnabled`、`embeddingModel`、`embeddingBatchSize`

**精排 / 问答**：`rerankEnabled`、`rerankShowLimit`、`qaEnabled`、`qaContextDocs`、`qaContextCharsPerDoc`、
`rerankHarness`、`qaHarness`

**面试 · 监听与桥接**：`ivBridgeEnabled`、`ivRagDir`、`ivPollMs`、`ivAnswerDeadlineMs`

**面试 · 召回与权重**：`ivRecallLimit`、`ivMaxSources`、`ivMinScore`、`ivWStrong`、`ivWBody`、
`ivPhraseBonusStrong`、`ivPhraseBonusBody`、`ivHotwordBoost`、`ivHotwordsFile`

**面试 · 回答组装**：`ivSnippetRadius`、`ivAnswerTitle`、`ivMaxAnswerChars`、`ivShowSourcePaths`

**面试 · 问题清洗**：`ivMinQuestionChars`、`ivNoiseRegex`

**面试 · AI 与直答**：`ivAiEnabled`、`ivModel`、`ivTimeoutMs`、`ivMaxTokens`、`ivContextDocs`、
`ivContextCharsPerDoc`、`ivAiAssist`、`ivAiFallbackLocal`、`ivAiSystemPrompt`、`ivSpokenEnabled`、
`ivSpokenSystemPrompt`、`ivSpokenPromptPresets`

> `ivModel` 单独填的理由：面试要 3~5 秒出话，主检索可以慢慢精排。实测
> `cndeepseek-v4-flash` 平均 5.2s、内容最完整；`cnminimax-m3` 4.7s 偏短；`cnhy3` 4.4s 最省字但偏浅；
> `cnglm-5.3-flash`、`cnkimi-k2.8-preview` 8s 以上别用。

## 与其他插件的联动

- 被 `00_xyblue135-skill-miner` 调用（`openSearchWithQuery`），带初始关键词直接打开检索。
- 接口约定与 `00_xyblue135-metadata-ai` 一致（OpenAI 兼容），可共用同一个本地网关。

## 配置与密钥

配置存在插件目录的 `data.json`，**不进 git** —— 里面是明文 API Key。
仓库里只放模板 `data.example.json`，第一次用照抄一份即可：

```bash
cd .obsidian/plugins/00_xyblue135-ai-search
cp data.example.json data.json
# 然后编辑 data.json，把下面这些字段填上
```

本插件需要填的凭证字段只有一组：`baseUrl` + `apiKey`（兼容 OpenAI 的接口密钥），检索与面试共用。
面试的模型单独填 `ivModel`。

> ⚠️ 填好 key 的 `data.json` 永远不要提交（`.gitignore` 已挡住）。

## 注意

- **索引里的 `path` 用库内相对路径**，改白名单目录或大规模移动笔记后建议重建一次索引。
- 面试相关的外部路径（`ivRagDir`、`ivHotwordsFile`）是**绝对路径**，与桥接程序的 `bridge_config.json` 保持一致。
- `data.json` 里有明文 `apiKey`，本插件的 `data.json` 不进 git。
