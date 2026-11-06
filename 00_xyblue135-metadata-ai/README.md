# xyblue135 · AI 元数据

用兼容 OpenAI 的接口，为 `my_blog/00_docs` 下的笔记维护一整套 frontmatter 元数据。
**每个字段都能单独生成、单独校验**，不强迫你一次跑完整套。

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
- `缺失元数据补全 / 顺序修正：巡检一次`
- `时效复检：对照 GitHub 仓库活动与核验时间` —— 用 `pushed_at` 判断笔记对应的仓库是否已更新（缓存 1h，限流时降级），结合 `AI_last_verified` 的年龄（默认 90 天）挑出该复检的笔记

**定期巡检**：`autoInspectionHours` > 0 时后台定时跑格式巡检并弹 Notice 摘要（默认 0 = 关闭）。

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
