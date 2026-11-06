# tools/ —— 已被独立程序取代

这两个脚本是 2026-11 早期为了「不打开 Obsidian 也能重建索引」临时写的，
功能已经全部合并进独立程序 **`xyindex`**：

```
D:\2document\00_github_private\xyblue-index
```

用法见插件 README 的「索引」章节，或 `xyindex --help`。

| 旧脚本 | 新命令 |
|---|---|
| `node tools/rebuild-index.js` | `xyindex rebuild` |
| `node tools/rebuild-index.js --dry` | `xyindex rebuild --dry` |

**为什么保留**：作为「不依赖外部程序」的最小退路。但它内部自带一份
`offline-harness.js`，与 `xyindex` 里那份是重复实现 —— 插件 `main.js` 的导出变了，
这里可能先坏。日常请用 `xyindex`，它会跟着插件一起维护。
