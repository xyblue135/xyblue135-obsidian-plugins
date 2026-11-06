# xyblue135 · AI 元数据

用兼容 OpenAI 的接口，为 `my_blog/00_docs` 下的笔记维护一整套 frontmatter 元数据。
**每个字段都能单独生成、单独校验**，不强迫你一次跑完整套。

> **0.10.0 起，原 `00_xyblue135-docs-template`（元数据补全）已并入本插件。**
> 原因：字段清单原本定义在那边、AI 字段顺序定义在这边，同一套 schema 拆两处维护；
> 而且本插件 sidecar 的 create 监听本来就在等它先跑完，是一处隐式跨插件依赖。
> 现在「一篇笔记该有哪些字段」只在本插件的模板里定义一次。

## 两件事，一个地方

| 能力 | 触发方式 | 是否调 AI |
| --- | --- | --- |
| **模板骨架**：补齐缺失的 frontmatter 字段 | 新建 / 移入作用目录时自动；也可手动命令 | 否，纯本地 |
| **AI 字段生成**：生成摘要/标签/深度/时效等 | 命令、Properties 里的 ✨ 按钮 | 是 |

模板只负责「键该不该存在」，AI 只负责「值写什么」——分工不重叠。

## 管理的 10 个字段

| 字段 | 含义 | 命令 |
| --- | --- | --- |
| `AI_summary_short` | 一句话短摘要 | 生成短摘要 |
| `AI_summary_long` | 一段长摘要 | 生成长摘要 |
| `AI_tags` | 加权标签（按重要度排序） | 生成加权标签 |
| `AI_technical_depth` | 技术深度 0–100 | 评估技术深度 |
| `AI_take` | 客观评价（值不值得读、适合谁） | 生成客观评价 |
| `AI_qa` | 面试问答对 | 生成面试问答 |
| `AI_title` | 参考标题 | 生成参考标题 |
| `AI_freshness` | 时效性灯（🟢/🟡/⚪…） | 评估时效性 |
| `AI_freshness_note` | 时效说明 | 同上，一起写 |
| `AI_last_verified` | 最后核验日期 | 同上，一起写 |

## 命令

**生成**

- 为当前笔记生成**短摘要 / 长摘要 / 两者 / 加权标签 / 技术深度 / 客观评价 / 面试问答 / 参考标题 / 时效性**
- `为当前 00_docs 笔记生成全部 AI 元数据（10 个字段）` —— 一次跑完整套

**查看与巡检**

- `打开当前文章的元数据 sidecar（00_metadata）`
- `打开待更新元数据笔记面板` —— 列出缺字段 / 空值 / 格式不合规的笔记
- `格式巡检：手动巡检一次` —— 正则校验全部字段格式
- `缺失元数据补全 / 顺序修正：巡检一次` —— 只看 10 个 `AI_` 字段，缺失/为空的重跑，顺序按配置摆正
- `时效复检：对照 GitHub 仓库活动与核验时间` —— 用 `pushed_at` 判断笔记对应的仓库是否已更新（缓存 1h，限流时降级），结合 `AI_last_verified` 的年龄（默认 90 天）挑出该复检的笔记

**模板骨架**

- `模板补全：审查并补全当前笔记的模板字段`
- `模板补全：审查并补全白名单内全部笔记` —— 给历史笔记批量补齐，先弹确认框

> 「缺失元数据补全」和「模板补全」的区别：前者**只动 10 个 AI 字段**且会调 AI 重跑值；
> 后者**动模板里的全部字段**（含 `status` / `visibility` / `token_count`），只补键、不调 AI、不改已有值。

**定期巡检**：`autoInspectionHours` > 0 时后台定时跑格式巡检并弹 Notice 摘要（默认 0 = 关闭）。

## 模板骨架

设置 → 「模板骨架（新建笔记自动补字段）」里定义 `---` 包裹的 YAML 块：

```yaml
---
status: 🟢 undone
visibility: 🟢 unopen
updated: {{timestamp}}
token_count: 0
AI_tags: []
AI_summary_short: 
---
```

| 变量 | 值 |
| --- | --- |
| `{{folder}}` | 所在文件夹名 |
| `{{filename}}` | 文件名（不含 .md） |
| `{{path}}` | 所在文件夹路径 |
| `{{datetime}}` / `{{date}}` / `{{time}}` | 当前时间 |
| `{{timestamp}}` | 17 位毫秒时间戳 |

规则：

- 只追加缺失字段，**已有字段的值与顺序一律不动**（空值也算有意留空）。
- 笔记正在编辑器里打开时改缓冲区而不是磁盘，避免和未落盘的输入互相覆盖。
- 你正在这篇笔记里打字时自动顺延（最多 8 轮），不会打断你；但「刚新建、还是空白」不算打字。
- `frontmatter` 没有闭合（写到一半）时跳过，不硬塞整块模板。
- 保留原有行尾风格（CRLF 的笔记补出来还是 CRLF）。

## 写作习惯支持

- **生成前清空字段值**（`clearFieldsBeforeRunEnabled`，默认开）：先手动建好空属性行、再用 ✨ 逐项生成时，不会残留旧值。只清值，保留 key。
- **正文指纹**（`contentFingerprintEnabled`）：记录内容哈希，正文没变就跳过重跑。
- **合并请求**（`experimentalCombinedRequestEnabled`）：多个字段合成一次调用，省时间也省钱。
- **把标题喂给 AI**（`feedTitleToAiEnabled`，默认开）。
- **只处理 status: done 的笔记**（`statusDoneOnlyEnabled`，默认关）。
- **自动更新**（`autoUpdateEnabled` + `autoUpdateMinutes`，默认关）：定期给内容有变的笔记补元数据。

## 设置

| 分组 | 项 |
| --- | --- |
| 接口 | `baseUrl`、`apiKey`、`model`、`requestTimeoutSeconds`、`requestIntervalSeconds` |
| 范围 | `whitelistFolder`（默认 `my_blog/00_docs`）、`statusDoneOnlyEnabled` |
| 摘要 | `summaryShortMaxChars`、`summaryLongMaxChars`（各带一个 `…Enabled` 开关）、`summaryMarkdownCleanupEnabled` |
| 标签 | `maxTags`（默认 7）、`technicalTagCanonicalList` |
| 自动化 | `autoUpdateEnabled`、`autoUpdateMinutes`、`contentFingerprintEnabled`、`experimentalCombinedRequestEnabled` |
| 巡检 | `formatChecks`（14 条正则规则）、`autoInspectionHours`、`recheckAgeDays` |
| 模板骨架 | `templateNote`（YAML 模板）、`templateAuditFolders`（作用目录，逗号分隔）、`templateAuditOnCreate`（新建时自动补）、`templateAuditDelayMs`（延迟，默认 1500） |
| 提示词 | `summaryLongHarness`、`technicalDepthHarness`、`takeHarness`、`qaHarness` 等，全部可在设置里改 |

> 设置里的提示词（harness）都可以直接编辑，改完立刻生效，不用改代码。

## 配置与密钥

配置存在插件目录的 `data.json`，**不进 git** —— 里面是明文 API Key。
仓库里只放模板 `data.example.json`，第一次用照抄一份即可：

```bash
cd .obsidian/plugins/00_xyblue135-metadata-ai
cp data.example.json data.json
# 然后编辑 data.json，把下面这些字段填上
```

本插件需要填的凭证字段：`settings.apiKey`（嵌在 `settings` 对象里）

> ⚠️ 填好 key 的 `data.json` 永远不要提交（`.gitignore` 已挡住）。

## 注意

- 只对 `whitelistFolder` 下的笔记生效，其他位置不接管。
- `data.json` 含明文 `apiKey`，不进 git。`data.example.json` 是空配置模板，可以参照。
- 默认 `baseUrl` 是本地网关（`http://192.168.3.101:3001/v1`），**换机器要改成你自己的地址**。
