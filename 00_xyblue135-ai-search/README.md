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

- 索引存在插件目录的 `index.json`（**不入 git**，可由「重建检索索引」随时重建）；检索与面试共用
- 启动时增量比对文件 hash，只重建变动的笔记
- `autoRebuildHours` > 0 时定期全量重建（默认 0 = 关闭）
- 只索引白名单目录（默认 `my_blog/00_docs`，含子目录）
- 面试监听在**索引加载完成后**才启动，避免启动瞬间的提问查到空索引

## 设置

**接口**（两个模式共用）：`baseUrl`（默认 `http://127.0.0.1:31415/v1`）、`apiKey`、`requestTimeoutSeconds`、
`structuredJsonModeEnabled`、`jsonRepairEnabled`

**索引范围**：`whitelistFolder`、`includeSubfolders`、`localRecallLimit`、`autoIndexOnStartup`、
`incrementalUpdateEnabled`、`autoRebuildHours`

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
