# xyblue135-obsidian-plugins

xyblue135 的 Obsidian 插件合集（自研 13 个 + 打包的第三方 6 个）。

> **仓库根 = `<vault>/.obsidian/plugins/`**，也就是「要备份的东西本身」。
> 克隆下来直接放进 vault 的 `.obsidian/plugins/` 即可，插件可以原样加载。
>
> 文章与附件在另一个**私有**仓库 `obsidian_data` 里维护，位于 vault 的 `my_blog/` 目录，
> 二者各自独立成仓、互不干扰（vault 根、`.obsidian` 本身都不是 git 仓库）。

## 目录结构

```
<vault>/
├── .obsidian/
│   ├── plugins/             # ← 本仓库（仓库根）
│   │   ├── 00_xyblue135-*/  # 自研插件（13 个）
│   │   ├── <第三方插件>/     # 打包进来的社区插件（6 个）
│   │   ├── .gitignore
│   │   └── README.md        # 就是本文件
│   ├── snippets/            # 个人 CSS 片段，不进任何仓库
│   ├── themes/              # 第三方主题，不进任何仓库
│   └── *.json               # Obsidian 本体个人配置，不进任何仓库
├── .trash/                  # Obsidian 废纸篓，不进任何仓库
└── my_blog/                 # 另一个仓库（私有）：文章 + 附件
```

> 仓库根为什么放在 `plugins` 而不是 `.obsidian`：后者还装着 Obsidian 本体的
> 个人配置（`workspace.json`、`hotkeys.json`、`snippets/`、`themes/` …），
> 那些既不叫插件、也不该公开。根下移之后，`git status` 的结果就是
> 「哪些插件改过 / 哪个新插件还没入库」，不用再靠 `.gitignore` 一条条挡。

## 自研插件

| 插件 | 版本 | 说明 |
|---|---|---|
| `00_xyblue135-ai-search` | 1.0.1 | 本地召回 + AI 精排两阶段检索白名单文章，支持语义向量召回、标签/深度过滤、流式 AI 问答与引用跳转；**含面试问答模式**（ragfile 桥接 + 第一人称直答） |
| `00_xyblue135-char-count-updater` | 4.1.3 | 按白名单更新 `token_count` 字段，中英文分倍率粗略估算 |
| `00_xyblue135-docs-archiver` | 1.0.3 | 为 `my_blog/00_docs` 下笔记推荐归档文件夹：AI 推荐为主，本地打分兜底；一键移动 |
| `00_xyblue135-docs-logo` | 1.0.3 | 仅对白名单目录显示状态图标，支持文件夹 / Markdown / 自定义 SVG |
| `00_xyblue135-docs-nav` | 0.3.2 | 五种交互视图浏览知识库：技能树、树状图、旭日图、矩形树图、标签星图（ECharts 内置） |
| `00_xyblue135-files-hider` | 1.0.1 | 右键视觉隐藏指定文件夹，不影响搜索与其他插件访问 |
| `00_xyblue135-image-zoom` | 1.4.3 | Shift + 滚轮临时调整正文图片尺寸，并提供可配置相框 |
| `00_xyblue135-metadata-ai` | 0.10.0 | 用 OpenAI 兼容 API 维护 AI 摘要 / 标签 / 技术深度 / 时效性等 frontmatter 字段；**含模板补全**（新建笔记自动补齐缺失字段） |
| `00_xyblue135-mirror` | 2.1.2 | 单层共享附件结构，同名笔记共享附件目录，引用计数保护删除 |
| `00_xyblue135-skill-miner` | 0.11.1 | 把 frontmatter 变成技能资产：技能矩阵、AI 技术画像、模拟面试、简历生成；**含岗位透镜**（目标岗位画像 + 缺口比对） |
| `00_xyblue135-theme` | 1.1.1 | 无需写 CSS 即可自定义背景 / 文字 / 链接 / 标题 / 代码 / 标签等样式 |
| `00_xyblue135-undone-workbench` | 0.1.2 | 筛选 `status: undone` 笔记并逐篇引导处理（缺失项分析 / 联动补全） |
| `00_xyblue135-video-triage` | 0.1.1 | B 站链接 → 字幕 → 要点 → 知识库比对 → 三档判定 → 自动写信箱笔记 |

### 2026-11 的合并（17 → 14）

三个插件被并入别处，不是功能被砍，而是**职责本来就重叠**——拆着反而要跨插件读对方的 `data.json`：

| 被并入 | 并入到 | 为什么 |
|---|---|---|
| `docs-template`（元数据补全） | `metadata-ai` | 新建笔记补字段 vs 已有笔记补字段，是同一件事的两个时机；字段清单原本在 A 插件、字段顺序在 B 插件，靠启动顺序碰运气 |
| `job-lens`（岗位透镜） | `skill-miner` | 岗位透镜只读 `skill-miner/data.json` 做比对，本质是这个插件的第二个视图 |
| `interview-rag`（面试检索） | `ai-search` | 两套索引算法几乎逐行相同、白名单同一份、索引文件 4.6MB 各存一份；面试只是「另一套评分权重 + 一个文件握手」 |

视图 id（`xyblue135-job-lens-view`）与旧 `data.json` 里的设置会自动迁移（`migratedFrom*` 标记防重跑），
已打开的面板不会变空白；命令 id 变了（加了 `job-lens-` / `template-` / `iv-` 前缀），之前绑的热键要重绑。

### 侧边栏图标怎么变成现在这样

侧栏（ribbon）放哪些图标**不由插件决定，由 CSS 片段决定**：
`snippets/xyblue135-brand.css` 里有一份「隐藏清单」，按 `aria-label` 精确匹配把图标 `display:none`。

| 现象 | 原因 |
|---|---|
| 合并后侧栏出现「面试问答控制台」 | 它替换了原来的「面试检索控制台」，按设计**保留可见**（面试要一键直达） |
| 「岗位透镜」看不见了 | 它是 `skill-miner` 的副入口，与主入口「技能提炼」一起收进隐藏清单；进法是命令面板搜「岗位透镜」 |
| 改了图标文案，隐藏就失效 | 清单按 `aria-label` 精确匹配，改名必须同步改清单（`1.0.1` 起已核对过一轮） |

图标要重新显示：删掉 `brand.css` 里对应那行即可。插件自己只负责 `addClass('xyblue135-ribbon xyblue135-ai')`
上品牌色，不再用 `document.querySelector` 事后查找（那种写法一改文案就静默失效）。

### 没有启动台了，藏起来的入口怎么进

2026-11-06 移除了 `00_xyblue135-launcher`（插件启动台）：它本身也被 `workspace.json` 的
`hiddenItems` 藏着，只能从命令面板唤起，实际用不上。被它收编的入口改为：

| 想打开 | 怎么进 |
|---|---|
| 岗位透镜 | 命令面板搜「岗位透镜」（`00_xyblue135-skill-miner:job-lens-open`） |
| 模板补全 | 命令面板搜「模板补全」（`00_xyblue135-metadata-ai:template-audit-*`） |
| 面试问答控制台 | 侧栏图标（保留可见），或命令面板搜「面试」 |
| 其它被隐藏的图标 | 删掉 `brand.css` 隐藏清单里对应那行 |

### 快捷键

**自研插件不注册任何默认热键**：`addCommand` 里没有 `hotkeys` 字段，
`.obsidian/hotkeys.json` 里也没有任何 `00_xyblue135-*` 条目（旧插件 `code-wrap-toggle`
遗留的 `Mod+Numpad9` 已于 2026-11-06 清掉）。命令都在，只是不绑键——
要绑自己去 设置 → 快捷键，键位不会随插件升级被覆盖。

插件内仍保留的按键都是**输入框内行为**，与全局热键无关：
搜索框的 `Enter` / `Ctrl+Enter`（提交/追问）、归档面板的 `↑↓ Enter`、
`mirror` 在文件树里拦 `Delete` 弹附件回收确认、`image-zoom` 的 `Shift/Alt + 滚轮`（鼠标手势）。
## 打包的第三方插件

社区插件放到本仓库里，是为了**换机时一次 clone 全恢复**，不用去插件市场逐个搜、逐个装。
代码未做任何修改，版权归各自作者。升级时重新覆盖 `main.js` / `manifest.json` / `styles.css` 即可。

| 插件 | 版本 | 用途 | 为什么留在这 |
|---|---|---|---|
| `editing-toolbar` | 2.4.16 | 笔记顶部浮动工具栏（类 Word）：加粗、标题、表格、公式、代码块等一键插入 | 自定义了一套按钮顺序，重装会丢 |
| `file-explorer-note-count` | 1.2.2 | 文件列表里每个文件夹旁显示笔记数 | 无配置，纯功能 |
| `lookout` | 1.2.2 | 宽表格 / Mermaid 大图横向查看：滚轮或 Ctrl+滚轮平移缩放、一键适配画布、全屏打开 | 看知识库里的架构图、流程图离不开 |
| `obsidian-pandoc` | 0.4.1 | 调本机 pandoc 导出 DOCX / ePub / PDF | 依赖本机已装 pandoc；仅桌面端 |
| `recent-files-obsidian` | 1.7.9 | 按最近打开时间列文件，快速回到上次看到的位置 | 配置里 50 条历史，迁移后已修正路径 |
| `unicode-search` | 0.7.1 | 搜索并插入 Unicode 字符（箭头、数学符号、框线等） | 写技术笔记常用 |

> 各插件的 `data.json`（`editing-toolbar`、`recent-files-obsidian`、`unicode-search` 三个有）
> 同样**不入库** —— 里面是个人界面配置。恢复后需要自己在设置里再调一次。

## 注意

- **插件的 `data.json` 不在本仓库**：自研插件的含明文 API Key，第三方插件的是个人界面配置，一并不入库。
- `index.json`、`reports/`、`node_modules/` 等运行时产物、`*.bak` 备份均不跟踪。
- 克隆本仓库到 `<vault>/.obsidian/plugins` 后，插件能正常加载；需要凭证的照 `data.example.json` 抄一份填上（见下节）。
- `docs-logo` 的 `icons.json` / `whitelist.json` 不跟踪 —— 那是「某个库」的图标映射，换库就失效。

### 配置与密钥

约定很简单，两条：

| 文件 | 内容 | 是否入库 |
|---|---|---|
| `data.example.json` | 模板，凭证字段留空 | **入库**，供照抄 |
| `data.json` | 真实配置，含明文 key | **永不入库**（已被 `.gitignore` 挡住） |

第一次用某个插件（在本仓库根，也就是 `.obsidian/plugins` 下）：

```bash
cd 00_xyblue135-ai-search
cp data.example.json data.json
# 编辑 data.json，填上 apiKey
```

模板是照各插件的 `DEFAULT_SETTINGS` 生成的，**列出全部可配置项及其默认值**，
可以当设置项速查表用；凭证字段一律空串。没写进模板的键也不影响加载 ——
插件启动时会用默认值补齐。

需要填凭证的插件。**字段名已统一**：凡是「OpenAI 兼容接口」的凭证，一律叫
`baseUrl` / `apiKey` / `model`，值填同一套（同一台本地网关，直接复制粘贴）：

| 插件 | 字段 | 说明 |
|---|---|---|
| `ai-search` | `baseUrl` `apiKey` `model` | |
| `docs-archiver` | `baseUrl` `apiKey` `model` | 1.0.3 起统一，旧 `ai*` 键自动迁移 |
| `ai-search`（面试模式） | 共用 `baseUrl` `apiKey`，模型单独 `ivModel` | 面试要快、要短，模型常与主检索不同；其余 `iv*` 键各有默认值 |
| `metadata-ai` | `settings.baseUrl` `settings.apiKey` `settings.model` | 整份配置包在 `settings` 下 |
| `skill-miner` | `settings.baseUrl` `settings.apiKey` `settings.model` | 同上 |
| `skill-miner`（可选） | `settings.searchApiKey` | **不是** LLM 的 key，是 Tavily 搜索的 key，用途不同，保留独立字段 |

> 为什么 `metadata-ai` / `skill-miner` 多一层 `settings.`：这两个插件把整个配置
> 包在 `settings` 子对象里（含版本号、harness 提示词等上百个键），是它们的配置
> 结构如此，不是命名不统一。**字段名本身仍是 `apiKey`**，不该为了整齐去动那一层。

> 真要把 key 放出去过（比如曾经提交过），换 key 才算真解决 —— 从历史里删掉的对象
> 在 GitHub 上还会残留一段时间，且任何拉过旧历史的人手里都有。

### 路径约定

所有插件的目录设置项都是**相对 vault 根**的路径，不是相对 `.obsidian`。

本套环境把文章放在 vault 的子目录 `my_blog/` 下，因此插件的默认值统一带 `my_blog/` 前缀
（`my_blog/00_docs`、`my_blog/00_assets`、`my_blog/00_agent_for_projects` …）。
如果你的库把文章直接放在根目录，把设置里的 `my_blog/` 前缀去掉即可 —— 没有硬编码。
