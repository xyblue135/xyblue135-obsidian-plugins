# xyblue135 私人 · 文档归档推荐

为 `my_blog/00_docs` 下的**未归档笔记**推荐该放进哪个文件夹，一键移动。

## 设计前提

附件已经集中放在 `my_blog/00_assets`（按文件名索引），所以**移动笔记不需要搬迁附件** ——
这也是本插件敢于「一键移动」的原因。配对使用的插件是 `00_xyblue135-mirror`。

## 两种推荐引擎

| 引擎 | 做法 | 何时生效 |
| --- | --- | --- |
| AI 推荐（主） | 把笔记标题 + 摘要 + 现有目录结构喂给 `/v1/chat/completions`，让它给出目标文件夹和理由 | `aiEnabled` 且接口可用 |
| 本地打分（兜底） | 按标签 / 标题词与各目录已有笔记的相似度打分 | AI 不可用、或调用失败时 |

## 功能

- 命令面板 / 侧栏 `归档当前笔记（推荐目标文件夹）`（只在当前笔记位于 `notesRoot` 下时可用）
- 弹窗列出 Top N 个候选文件夹（默认 3），每个带推荐理由
- 可在弹窗里选已有文件夹，也可以直接输入新文件夹名
- 确认后移动笔记；已有同名笔记时会提示

## 设置

| 项 | 默认 | 说明 |
| --- | --- | --- |
| `notesRoot` | `my_blog/00_docs` | 要归档的笔记根目录 |
| `assetsRoot` | `my_blog/00_assets` | 附件根目录（仅用于生成说明，不搬文件） |
| `aiEnabled` | `true` | 关掉就只用本地打分 |
| `aiBaseUrl` | `http://127.0.0.1:31415/v1` | OpenAI 兼容接口 |
| `aiApiKey` | 空 | 存在 `data.json`，不在源码里 |
| `aiModel` | `auto` | |
| `requestTimeoutSeconds` | 90 | |
| `maxSuggestions` | 3 | 弹窗里列几个候选 |
| `profileTagLimit` | 6 | 喂给 AI 的笔记最多带几个标签 |
| `profileTitleLimit` | 2 | 喂给 AI 的标题词数量 |

## 配置与密钥

配置存在插件目录的 `data.json`，**不进 git** —— 里面是明文 API Key。
仓库里只放模板 `data.example.json`，第一次用照抄一份即可：

```bash
cd .obsidian/plugins/00_xyblue135-docs-archiver
cp data.example.json data.json
# 然后编辑 data.json，把下面这些字段填上
```

本插件需要填的凭证字段：`aiApiKey` —— 注意字段名是 `aiApiKey`，不是 `apiKey`

> ⚠️ 填好 key 的 `data.json` 永远不要提交。
> 提交前在 `.obsidian` 目录跑 `node tools/check-secrets.js`，
> 扫到疑似密钥会返回非 0 并列出位置。

## 注意

- 只处理 `notesRoot` 下的 Markdown，其他位置不接管。
- `data.json` 含明文 `aiApiKey`，不进 git。
