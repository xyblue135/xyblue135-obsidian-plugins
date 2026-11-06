# xyblue135 · AI 检索

本地召回的**零 API 成本**检索 + AI 精排的两阶段检索，可再进一层做流式 AI 问答（RAG，带引用）。

## 两阶段检索

| 阶段 | 做什么 | 成本 |
| --- | --- | --- |
| ① 本地召回 | 标题 / 标签 / AI 摘要 / 正文分词打分，从白名单目录里捞出候选（默认 50 条） | 0 |
| ② AI 精排 | 把候选交给 `chat/completions` 按相关度重排、丢弃无关项，并给一句理由 | 1 次调用 |

可选的第三阶段：

- **语义向量召回** —— 打开 `embeddingEnabled` 后额外用向量相似度补召回（本地算，仍不花 API）。
- **流式 AI 问答** —— 取精排前列文章的相关段落作资料，边生成边显示，答案带 `[n]` 引用，可点击跳原文。

## 功能

- 命令面板：`打开 AI 检索`、`重建检索索引`
- 结果行显示：标题、路径、标签、命中摘要（关键词 `<mark>` 高亮）、AI 精排理由、评分
- 结果行还会读 `metadataCache` 显示状态灯（🟢 done / 🔴 undone）和时效灯（`AI_freshness`）
- 点击结果直接用 Obsidian 的 `[[链接]]` 打开对应位置

## 索引

- 索引存在插件目录的 `index.json`（**不入 git**，可由「重建检索索引」随时重建）
- 启动时增量比对文件 hash，只重建变动的笔记
- `autoRebuildHours` > 0 时定期全量重建（默认 0 = 关闭）
- 只索引白名单目录（默认 `my_blog/00_docs`，含子目录）

## 设置

**接口**：`baseUrl`（默认 `http://127.0.0.1:31415/v1`）、`apiKey`、`model`、`requestTimeoutSeconds`、
`structuredJsonModeEnabled`、`jsonRepairEnabled`

**索引范围**：`whitelistFolder`、`includeSubfolders`、`localRecallLimit`、`autoIndexOnStartup`、
`incrementalUpdateEnabled`、`autoRebuildHours`

**语义召回**：`embeddingEnabled`、`embeddingModel`、`embeddingBatchSize`

**精排 / 问答**：`rerankEnabled`、`rerankShowLimit`、`qaEnabled`、`qaContextDocs`、`qaContextCharsPerDoc`、
`rerankHarness`、`qaHarness`

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

本插件需要填的凭证字段：`apiKey`（兼容 OpenAI 的接口密钥）

> ⚠️ 填好 key 的 `data.json` 永远不要提交（`.gitignore` 已挡住）。

## 注意

- **索引里的 `path` 用库内相对路径**，改白名单目录或大规模移动笔记后建议重建一次索引。
- `data.json` 里有明文 `apiKey`，本插件的 `data.json` 不进 git。
