# xyblue135 · 技能提炼

把笔记的 frontmatter 变成可用的**技能资产**：技能矩阵 → AI 技术画像 → 简历素材 → 简历 HTML → 岗位方向。

> **0.11.0 起，原 `00_xyblue135-job-lens`（岗位透镜）已并入本插件。**
> 技能矩阵与岗位分析本来就是一件事的两面，拆成两个插件只会让人在两处找入口。
> 合并后：视图 id `xyblue135-job-lens-view` 保持不变（已打开的面板能正常恢复），
> 命令加了 `岗位透镜：` 前缀，历史报告自动迁到本插件的 `reports/`。

## 八个页面

| 页 | 内容 |
| --- | --- |
| **总览** | 技能数量、覆盖率、最近变化 |
| **技能树** | 按方向分组的多层技能簇，每簇标 ✅ 可写 / ⚠️ 待补 / ❌ 不足 |
| **简历素材** | 从笔记里提炼的可勾选素材条目，勾选即进简历 |
| **GitHub 项目** | 白名单仓库项目融入画像（只读公开信息） |
| **简历生成** | 按版式 D（GitHub 风格）一键输出简历 HTML |
| **行业雷达** | 目标方向的市场需求 vs 你的技能，找缺口 |
| **学习计划** | 按技能树缺口生成学习候选，可一键导入为待办 |
| **岗位透镜** | 从技能矩阵反推适合投哪些岗位；也可贴 JD 做定向分析（侧栏罗盘图标 / 独立面板） |

## 岗位透镜

两种模式，同一个输入框里切换：

| 模式 | 触发方式 | 产出 |
| --- | --- | --- |
| **岗位发现**（零输入） | 不填岗位，直接分析 | 6~10 个岗位按契合度排序，分「直接可投 / 补强后强 / 差异化蓝海」三档，带 Boss 搜索词与薪资保守区间 |
| **定向分析** | 填岗位名，可选贴真实 JD | 该岗位的技能需求画像 + 逐项比对 + 学习方向 Top5 |

- 技能清单直接取本插件已算好的 `data.refined`，不再跨插件读 `data.json`。
- 报告 MD 存在本插件目录的 `reports/` 内（**不入 git**），面板右上角可切换历史报告。
- 「导出待办」把学习方向 / 技能缺口写成 `status: 🔴 undone` 笔记到收件箱，由待完成工作台接管。
- 市场数据来自模型知识，**非实时**，报告里已标注。

## 技能矩阵

- **只统计 `status: done` 的笔记**，所以矩阵反映的是你真做完的东西，不是收藏夹。
- 一簇技能需要至少 `minDocsPerSkill` 篇笔记（默认 3）才计入。
- 支持标签规范化（`tagCanonicalList`）——同一个技能的不同写法会合并成一簇。
- `ignoreTags` 里的标签不参与统计（每行一个）。

## 可视化

象限图 / 雷达图 / 时间线 / 技能树，四种口径看同一份数据。

## AI 链路

| 用途 | 提示词设置项 |
| --- | --- |
| 技能聚类 | `clusterHarness` |
| 技术画像综合 | `synthHarness` |
| 模拟面试提问 | `askHarness` |
| 技能定级 | `gradeHarness` |
| 行业雷达 | `pulseHarness` |
| 学习计划 | `planHarness` |
| GitHub 项目解读 | `ghHarness` |
| 简历生成 | `resumeHarness` |

全部提示词都能在设置里改，改完立即生效。

## 命令

- `打开技能提炼`
- `重建技能矩阵`
- `开始模拟面试`
- `岗位透镜：打开面板`
- `岗位透镜：岗位契合度发现（从技能矩阵反推）`
- `岗位透镜：导出最近分析的缺口为收件箱待办`

## 设置

| 分组 | 项 |
| --- | --- |
| 接口 | `baseUrl`、`apiKey`、`model`、`requestTimeoutSeconds`、`structuredJsonModeEnabled`、`jsonRepairEnabled` |
| 统计 | `folders`（默认 `my_blog/00_docs`）、`minDocsPerSkill`（默认 3）、`tagCanonicalList`、`ignoreTags` |
| 输出 | `outputFolder`（生成的学习计划/画像落这里）、`interviewCount`（模拟面试题数，默认 5） |
| 岗位透镜 | `jobLensInbox`（缺口导出的收件箱目录，默认 `my_blog/00_docs/收件箱`） |
| 简历 | `resumeAppendixEnabled`、`resumeHarness` |
| GitHub | `githubUsername`、`repoWhitelist`（仓库白名单，每行一个） |
| 搜索（可选） | `searchProvider`（默认 `off`）、`searchApiKey` |

## 与其他插件的联动

- **被 `00_xyblue135-docs-nav` 读取**：导航图的「技能树」视图直接读本插件的 `data.json`，
  复用同一套 AI 定级与方向修正，保证两个插件的口径一致。
- 可调用 `00_xyblue135-ai-search` 带关键词打开检索。
- 岗位透镜导出的待办由 `00_xyblue135-undone-workbench` 接管。

> 因为 `docs-nav` 直接读 `data.json`，改动本插件 `data.json` 的**字段名**会让它失效。
> 改结构时要同步检查 `docs-nav`。

## 配置与密钥

配置存在插件目录的 `data.json`，**不进 git** —— 里面是明文 API Key。
仓库里只放模板 `data.example.json`，第一次用照抄一份即可：

```bash
cd .obsidian/plugins/00_xyblue135-skill-miner
cp data.example.json data.json
# 然后编辑 data.json，把下面这些字段填上
```

本插件需要填的凭证字段：`settings.apiKey`（主用）、`settings.searchApiKey`（可选，联网搜索用）

> ⚠️ 填好 key 的 `data.json` 永远不要提交（`.gitignore` 已挡住）。

## 注意

- `data.json` 较大（约 118 KB），里面除了设置还有技能矩阵缓存（`refined` / `pulse` 等），
  **含明文 `apiKey`，不进 git**。
- 本插件的 `templates/` 目录是简历模板资源，属于源码，会进 git。
