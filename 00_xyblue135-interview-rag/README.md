# xyblue135 · 面试检索

面试场景的知识库即时检索：外部桥接把面试官的问题写进来，本插件在**本地**加权召回笔记，
再用 AI 组织成一段可以直接说出口的回答。

> 这个插件是为「线上面试 + OBS 实时转写」的私人工作流写的，
> 依赖一个外部的 Python bridge 脚本（不在本仓库内）。

## 工作流

```
OBS 转写 → bridge.py 组句 → rag/query.json
        → 本插件监听、检索、组织回答
        → rag/answer.json → bridge 读到后上悬浮卡
```

### 文件握手协议

```json
// query.json
{ "id": 1730000000000, "question": "讲讲你对 K8s 调度器的理解" }

// answer.json
{ "id": 1730000000000,
  "answer": "……",
  "sources": [{ "path": "my_blog/00_docs/...", "title": "..." }] }
```

- `id` 是毫秒时间戳；同一个 `id` 只应答一次。
- 监听用 `fs.watch`，同时保留 `pollMs` 轮询兜底（默认 300ms）。
- 应答有硬时限 `answerDeadlineMs`（默认 12s，bridge 侧超时 15s，留余量），
  **超时一定回错误应答，绝不静默**。

## 三级降级链

```
直答模式（第一人称口语，需网关在线）
  ↓ 失败
AI 精答（用召回笔记作资料组织答案）
  ↓ 失败
本地要点（纯抽取式摘要，零 API）
```

任何一级失败都不会拖住应答。

## 召回打分

| 权重项 | 默认 | 含义 |
| --- | --- | --- |
| `wStrong` | 6 | 标题 / 标签 / AI 摘要命中 |
| `wBody` | 1 | 正文命中 |
| `phraseBonusStrong` | 25 | 整句问题出现在标题/摘要区 |
| `phraseBonusBody` | 12 | 整句问题出现在正文 |
| `hotwordBoost` | 8 | 每命中一个面试领域热词 |

热词表放在外部 `hotwords.txt`（`#` 开头为注释），与 bridge 共用。

## 命令

- `打开面试检索控制台` —— 不依赖 bridge 的调参 / 试问界面
- `重建面试检索索引`
- `开/关 ragfile 监听`
- `开/关 直答模式（第一人称代替回答）`
- `面试风格 → …` —— 切换回答风格预设

## 设置

- **桥接**：`bridgeEnabled`、`ragDir`、`pollMs`、`answerDeadlineMs`、`hotwordsFile`
- **索引**：`autoIndexOnStartup`、`whitelistFolder`（默认 `my_blog/00_docs,my_blog/00_agent_for_projects`）、`includeSubfolders`
- **召回**：`recallLimit`、`maxSources`、`minScore`、`wStrong`、`wBody`、`phraseBonusStrong`、`phraseBonusBody`、`hotwordBoost`
- **回答**：`snippetRadius`、`answerTitle`、`maxAnswerChars`、`showSourcePaths`
- **清洗**：`minQuestionChars`、`noiseRegex`（多行正则，命中的问题视为转写噪声）
- **AI**：`aiEnabled`、`baseUrl`、`apiKey`、`model`、`aiTimeoutMs`、`aiMaxTokens`、`aiContextDocs`、
  `aiContextCharsPerDoc`、`aiAssist`、`aiFallbackLocal`、`aiSystemPrompt`
- **直答**：`spokenEnabled` 及配套提示词

## 配置与密钥

配置存在插件目录的 `data.json`，**不进 git** —— 里面是明文 API Key。
仓库里只放模板 `data.example.json`，第一次用照抄一份即可：

```bash
cd .obsidian/plugins/00_xyblue135-interview-rag
cp data.example.json data.json
# 然后编辑 data.json，把下面这些字段填上
```

本插件需要填的凭证字段：`apiKey`（AI 组织回答用；不填则退化为纯本地召回）

> ⚠️ 填好 key 的 `data.json` 永远不要提交（`.gitignore` 已挡住）。

## 注意

- 默认 `ragDir` 是 **`D:\obs-interview\rag`**（Windows 绝对路径），**首次使用必须改成你自己的目录**。
  同理 `hotwordsFile` 默认 `D:\obs-interview\hotwords.txt`。
- 索引存在插件目录的 `index.json`，不入 git，可随时重建。
- `data.json` 含明文 `apiKey`，不进 git。
