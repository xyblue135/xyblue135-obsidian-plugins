/*
 * xyblue135 私人 · 笔记状态
 * 类型：xyblue135 私人插件（非公共发布版）
 * 说明：用户可见文案与维护注释已中文化；内部插件 ID 与 data.json 保持不变，以兼容原有设置和数据。
 */
const { Plugin, Notice, TFile, TFolder, normalizePath } = require("obsidian");

const STYLE_ID = "xyblue135-docs-logo-styles";
const SVG_SIZE = 16;

const COLORS = {
  done: "#4CAF50",
  undone: "#F44336"
};

const DONE_VALUES = new Set([
  "done",
  "complete",
  "completed",
  "finished",
  "已完成",
  "完成"
]);

const OPEN_VALUES = new Set([
  "open",
  "公开"
]);

const LOCK_SVG = `<svg xmlns="http://www.w3.org/2000/svg"
     width="16"
     height="16"
     viewBox="0 0 16 16"
     shape-rendering="crispEdges">

  <!-- 红色外框 -->
  <path fill="#d90000" d="
    M4 2 H12 V3 H14 V5 H15 V11 H14 V13 H12 V14 H4 V13 H2 V11 H1 V5 H2 V3 H4 Z

    M4 4 V5 H3 V11 H4 V12 H12 V11 H13 V5 H12 V4 Z
  " fill-rule="evenodd"/>

  <!-- 中间斜杠 -->
  <path fill="#d90000" d="
    M10 4 H13 V6
    L6 13
    H3 V10
    Z
  "/>

</svg>`;

module.exports = class xyblue135NotesStatusPlugin extends Plugin {
  async onload() {
    // 7.8：manifest.dir 缺失时用 manifest.id 兜底，避免拼出并不存在的插件目录名
    this.pluginDir =
      this.manifest.dir || normalizePath(`${this.app.vault.configDir}/plugins/${this.manifest.id}`);
    this.whitelistPath = normalizePath(`${this.pluginDir}/whitelist.json`);
    this.iconsPath = normalizePath(`${this.pluginDir}/icons.json`);

    this.whitelistRoots = [];
    this.iconMap = new Map();
    this.iconSourcePaths = new Set();
    this.noteStatus = new Map();
    this.uriCache = new Map(); // 7.3：SVG → data URI 的预算缓存
    this.iconVersion = 0; // 7.3：图标配置版本号，参与签名，图标内容变化时强制重建
    this.lastCssSignature = ""; // 7.3：用轻量签名判断是否需要重建整份 CSS
    this.pendingRescansLeft = 3; // 7.5：待定项的兜底重扫次数
    this.pendingRescanTimer = null;
    this.lastSkippedSignature = ""; // 7.4：非 .md 文件只做调试记录，不告警

    this.styleEl = document.getElementById(STYLE_ID);
    if (!this.styleEl) {
      this.styleEl = document.createElement("style");
      this.styleEl.id = STYLE_ID;
      document.head.appendChild(this.styleEl);
    }

    await this.reloadConfiguration(false);

    this.rebuildSoon = this.debounce(() => this.rebuildStyles(), 180);
    this.reloadSoon = this.debounceAsync(() => this.reloadConfiguration(true), 260);
    // 7.5：兜底重扫定时器随插件卸载清理
    this.register(() => {
      if (this.pendingRescanTimer) window.clearTimeout(this.pendingRescanTimer);
    });

    this.registerEvent(this.app.vault.on("create", (file) => this.handleStructureChange(file)));
    this.registerEvent(this.app.vault.on("delete", (file) => this.handleStructureChange(file)));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.handleRename(file, oldPath)));
    this.registerEvent(this.app.vault.on("modify", (file) => this.handleModify(file)));
    this.registerEvent(this.app.metadataCache.on("changed", (file) => this.handleMetadataChange(file)));
    // 7.5：全文索引重建/缓存补全后（resolved）兜底重扫，避免缓存为空的笔记被永久画成红点+锁
    this.registerEvent(this.app.metadataCache.on("resolved", () => this.rebuildSoon()));

    this.addRibbonIcon("sticker", "文件 Logo · 重载白名单", () => {
      this.app.commands.executeCommandById("00_xyblue135-docs-logo:reload-whitelist-and-icons");
    }).addClass("xyblue135-ribbon xyblue135-tool");
    this.addCommand({
      id: "refresh-whitelist-status",
      name: "刷新白名单状态图标",
      callback: () => this.rebuildStyles()
    });

    this.addCommand({
      id: "reload-whitelist-and-icons",
      name: "重新加载白名单与自定义图标",
      callback: () => this.reloadConfiguration(true)
    });

    this.addCommand({
      id: "validate-whitelist-tree",
      name: "检查白名单目录结构",
      callback: () => {
        const result = this.collectRows();
        // 7.4：非 .md 文件不再视为结构错误，只统计数量；检查结果改为“扫描统计”式提示
        this.logSkippedFiles(result.skippedFiles);
        new Notice(
          `xyblue135 私人·笔记状态：白名单目录结构检查完成，共 ${result.rows.size} 个条目，` +
            `已跳过 ${result.skippedFiles.length} 个非 .md 文件（白名单内的附件按设计忽略）。`
        );
      }
    });

    this.app.workspace.onLayoutReady(() => this.rebuildStyles());
  }

  onunload() {
    if (this.styleEl) {
      this.styleEl.remove();
      this.styleEl = null;
    }
  }

  debounce(fn, delay) {
    let timeout = null;
    this.register(() => window.clearTimeout(timeout));
    return (...args) => {
      window.clearTimeout(timeout);
      timeout = window.setTimeout(() => fn(...args), delay);
    };
  }

  debounceAsync(fn, delay) {
    let timeout = null;
    this.register(() => window.clearTimeout(timeout));
    return (...args) => {
      window.clearTimeout(timeout);
      timeout = window.setTimeout(() => {
        Promise.resolve(fn(...args)).catch((e) => {
          console.error("xyblue135 私人·笔记状态： reload failed", e);
        });
      }, delay);
    };
  }

  normalizeValue(value) {
    // 1.0.2：值内嵌状态灯（🟢 done / 🔴 undone，与 AI_freshness 同风格）——判定前剥掉灯。
    // /u 标志必须有：emoji 是代理对，无 /u 时字符类会拆成孤立码元导致剥不干净。
    return String(value ?? "").trim().replace(/^[🟢🔴🟡⚪]\s*/u, "").toLowerCase();
  }

  normalizeConfigPath(value) {
    if (typeof value !== "string") return "";
    const trimmed = value.trim().replace(/^\/+/, "").replace(/\/+$/, "");
    if (!trimmed) return "";
    return normalizePath(trimmed);
  }

  minimizeRoots(paths) {
    const unique = [...new Set(paths.filter(Boolean))];
    unique.sort((a, b) => a.length - b.length || a.localeCompare(b));
    const roots = [];

    for (const path of unique) {
      if (roots.some((root) => path === root || path.startsWith(root + "/"))) {
        continue;
      }
      roots.push(path);
    }
    return roots;
  }

  async loadWhitelist() {
    try {
      const raw = await this.app.vault.adapter.read(this.whitelistPath);
      const parsed = JSON.parse(raw);
      const values = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed.paths)
          ? parsed.paths
          : Array.isArray(parsed.whitelist)
            ? parsed.whitelist
            : [];

      this.whitelistRoots = this.minimizeRoots(
        values.map((v) => this.normalizeConfigPath(v)).filter(Boolean)
      );
    } catch (e) {
      this.whitelistRoots = [];
      console.warn("xyblue135 私人·笔记状态： whitelist.json missing or invalid", e, this.whitelistPath);
      // 7.8：提示里带上实际解析到的路径，便于定位插件目录写错的情况
      new Notice(
        `xyblue135 私人·笔记状态：whitelist.json 读取失败（解析路径：${this.whitelistPath}），当前不会给任何目录添加状态图标。`
      );
    }
  }

  resolveSvgPath(rawPath) {
    if (typeof rawPath !== "string") return "";
    const value = rawPath.trim();
    if (!value) return "";

    if (value.startsWith("./")) {
      return normalizePath(`${this.pluginDir}/${value.slice(2)}`);
    }

    return normalizePath(value.replace(/^\/+/, ""));
  }

  async loadIconConfig() {
    this.iconMap.clear();
    this.iconSourcePaths.clear();
    // 7.3：图标内容变化（同一路径换了 SVG）也要让签名失效
    this.iconVersion += 1;

    try {
      const raw = await this.app.vault.adapter.read(this.iconsPath);
      const config = JSON.parse(raw);

      for (const [targetRaw, svgRaw] of Object.entries(config)) {
        if (targetRaw.startsWith("_")) continue;
        if (typeof svgRaw !== "string") continue;

        const targetPath = this.normalizeConfigPath(targetRaw);
        if (!targetPath || !this.isPathWhitelisted(targetPath)) {
          // 白名单优先级最高：白名单之外即使配置了 SVG，也完全不生效、不读取。
          continue;
        }

        const svgPath = this.resolveSvgPath(svgRaw);
        if (!svgPath) continue;

        try {
          const svgContent = await this.app.vault.adapter.read(svgPath);
          // 7.3：一次性预算成 data URI 缓存，buildCss 热路径不再重复 sanitize/encodeURIComponent
          this.iconMap.set(targetPath, this.svgToDataUri(svgContent));
          this.iconSourcePaths.add(svgPath);

          if (svgContent.length > 100 * 1024) {
            console.warn(
              `xyblue135 私人·笔记状态：图标 "${svgPath}" 体积约 ${Math.round(svgContent.length / 1024)}KB，过大可能拖慢文件树渲染，建议精简。`
            );
          }
        } catch (e) {
          console.warn(`xyblue135 私人·笔记状态： failed to load icon for "${targetPath}" from "${svgPath}"`, e);
        }
      }
    } catch (e) {
      console.warn("xyblue135 私人·笔记状态： icons.json missing or invalid", e);
    }
  }

  async reloadConfiguration(showNotice) {
    await this.loadWhitelist();
    await this.loadIconConfig();
    // 7.3：重载后图标内容可能变了，清空签名强制重建一次 CSS
    this.lastCssSignature = "";
    this.rebuildStyles();

    if (showNotice) {
      const roots = this.whitelistRoots.length ? this.whitelistRoots.join(", ") : "（空）";
      new Notice(`xyblue135 私人·笔记状态：配置已重新加载。白名单：${roots}`);
    }
  }

  isPathWhitelisted(path) {
    const normalized = this.normalizeConfigPath(path);
    if (!normalized) return false;
    return this.whitelistRoots.some(
      (root) => normalized === root || normalized.startsWith(root + "/")
    );
  }

  isWhitelistRelatedPath(path) {
    const normalized = this.normalizeConfigPath(path);
    if (!normalized) return false;

    return this.whitelistRoots.some(
      (root) =>
        normalized === root ||
        normalized.startsWith(root + "/") ||
        root.startsWith(normalized + "/")
    );
  }

  handleStructureChange(file) {
    if (!file || !file.path) return;

    if (file.path === this.whitelistPath || file.path === this.iconsPath) {
      this.reloadSoon();
      return;
    }

    if (this.isWhitelistRelatedPath(file.path)) {
      this.rebuildSoon();
    }
  }

  handleRename(file, oldPath) {
    const newPath = file && file.path ? file.path : "";

    if (
      newPath === this.whitelistPath ||
      newPath === this.iconsPath ||
      oldPath === this.whitelistPath ||
      oldPath === this.iconsPath
    ) {
      this.reloadSoon();
      return;
    }

    if (this.isWhitelistRelatedPath(newPath) || this.isWhitelistRelatedPath(oldPath)) {
      this.rebuildSoon();
    }
  }

  handleModify(file) {
    if (!file || !file.path) return;

    if (file.path === this.whitelistPath || file.path === this.iconsPath) {
      this.reloadSoon();
      return;
    }

    if (this.iconSourcePaths.has(file.path)) {
      this.reloadSoon();
    }

    // 普通 Markdown 正文修改不在这里触发重扫。
    // frontmatter 的 status / visibility 是否真正变化，由 metadataCache changed 精确判断。
  }

  handleMetadataChange(file) {
    if (!(file instanceof TFile) || file.extension.toLowerCase() !== "md") return;
    if (!this.isPathWhitelisted(file.path)) return;

    const next = this.getNoteMetadata(file);
    // 7.5：缓存还没就绪时不做比较，交给 resolved 事件兜底重扫
    if (!next) return;

    const nextKey = `${next.status}|${next.visibility}`;

    if (!this.noteStatus.has(file.path) || this.noteStatus.get(file.path) !== nextKey) {
      this.rebuildSoon();
    }
  }

  getNoteMetadata(file) {
    const metadataCache = this.app.metadataCache;
    const cache =
      typeof metadataCache.getCache === "function"
        ? metadataCache.getCache(file.path)
        : metadataCache.getFileCache(file);

    // 7.5：缓存未就绪（索引重建、刚创建、外部工具改文件）时返回 null，
    // 调用方按“待定”处理并跳过渲染，等 metadataCache resolved 事件后自愈。
    if (!cache) return null;

    const frontmatter = cache.frontmatter || {};

    const statusValue = this.normalizeValue(frontmatter.status);
    const visibilityValue = this.normalizeValue(frontmatter.visibility);

    return {
      status: DONE_VALUES.has(statusValue) ? "done" : "undone",
      visibility: OPEN_VALUES.has(visibilityValue) ? "open" : "unopen"
    };
  }

  collectRows() {
    const rows = new Map();
    const skippedFiles = [];
    const nextNoteStatus = new Map();

    const walkFolder = (folder) => {
      const folderRow = {
        path: folder.path,
        type: "folder",
        hasMd: false,
        hasUndone: false,
        hasUnopen: false,
        hasPending: false
      };

      rows.set(folder.path, folderRow);

      for (const child of folder.children) {
        if (child instanceof TFolder) {
          const childRow = walkFolder(child);
          if (childRow.hasMd) folderRow.hasMd = true;
          if (childRow.hasUndone) folderRow.hasUndone = true;
          if (childRow.hasUnopen) folderRow.hasUnopen = true;
          if (childRow.hasPending) folderRow.hasPending = true;
          continue;
        }

        if (!(child instanceof TFile)) continue;

        // 7.4：白名单内的非 .md 文件（截图、PDF、附件等）属于正常资源，直接跳过、不再告警；
        // 白名单里配置 00_assets 这类纯资源目录也是允许的。
        if (child.extension.toLowerCase() !== "md") {
          skippedFiles.push(child.path);
          continue;
        }

        const metadata = this.getNoteMetadata(child);

        // 7.5：元数据缓存未就绪，本条记为“待定”，既不渲染也不参与红绿聚合，等 resolved 重扫
        if (!metadata) {
          folderRow.hasPending = true;
          continue;
        }

        nextNoteStatus.set(child.path, `${metadata.status}|${metadata.visibility}`);

        const fileRow = {
          path: child.path,
          type: "file",
          status: metadata.status,
          unopen: metadata.visibility === "unopen"
        };

        rows.set(child.path, fileRow);

        folderRow.hasMd = true;
        if (metadata.status === "undone") folderRow.hasUndone = true;
        if (metadata.visibility === "unopen") folderRow.hasUnopen = true;
      }

      // 7.2/7.5：三态 —— 待定（缓存未就绪）> 空目录（无任何 Markdown）> 未完成 > 完成，
      // 空目录与待定不再被硬判成 undone（红色），避免 00_assets、新建空目录长期显示“未完成”。
      // 注意：只有“目录里一篇已解析的 Markdown 都没有”才算待定；目录里已有多篇正常笔记、
      // 仅个别笔记缓存缺失时仍按已知结果上色，否则一篇索引失败就会让整棵白名单树失去全部图标。
      folderRow.status = !folderRow.hasMd
        ? folderRow.hasPending
          ? "pending"
          : "empty"
        : folderRow.hasUndone
          ? "undone"
          : "done";
      folderRow.unopen = folderRow.hasUnopen;
      return folderRow;
    };

    for (const rootPath of this.whitelistRoots) {
      const root = this.app.vault.getAbstractFileByPath(rootPath);

      if (!root) {
        // 7.4 附带：非 .md 文件不再告警后，这里要保留真实异常的声音 ——
        // 白名单里写了不存在的目录时整棵树都会空着，必须能从控制台看出原因。
        console.warn(`xyblue135 私人·笔记状态：白名单目录不存在，已跳过：${rootPath}`);
        continue;
      }

      if (!(root instanceof TFolder)) {
        console.warn(`xyblue135 私人·笔记状态： whitelist entry is not a folder: ${rootPath}`);
        continue;
      }

      walkFolder(root);
    }

    this.noteStatus = nextNoteStatus;
    return { rows, skippedFiles };
  }

  // 7.4：白名单内出现非 .md 文件属于正常情况（附件、00_assets 资源目录），
  // 不再弹出 9 秒 Notice，只在调试控制台留痕，避免形成“永远消不掉的告警”。
  logSkippedFiles(files) {
    if (!files || files.length === 0) return;

    const signature = String(files.length);
    if (signature === this.lastSkippedSignature) return;
    this.lastSkippedSignature = signature;

    console.debug(
      `xyblue135 私人·笔记状态：已跳过 ${files.length} 个非 .md 文件（白名单内附件按设计忽略）。`,
      [...files].sort()
    );
  }

  sanitizeSvg(svg) {
    // 7.7：原来的正则只挡带引号的 on* 属性，漏掉无引号写法、javascript: 链接与 foreignObject。
    // 这里改为“危险构造一律剥离”：先整体删除可执行容器（连内容），再清事件属性与脚本协议。
    // 说明：没有采用纯白名单重建标签，是因为现有自定义图标大量使用 <defs>/<linearGradient>/<use>，
    // 白名单化会把用户图标渲染坏；剥离危险构造已能覆盖同一函数将来被复用到 <img>/DOM 的风险。
    return String(svg)
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<!DOCTYPE[\s\S]*?>/gi, "")
      .replace(/<!ENTITY[\s\S]*?>/gi, "")
      .replace(
        /<(script|style|foreignObject|iframe|object|embed|set|animate)\b[\s\S]*?(?:\/>|<\/\1\s*>)/gi,
        ""
      )
      .replace(/<\/?(script|style|foreignObject|iframe|object|embed|set|animate)\b[^>]*>/gi, "")
      // 事件属性：双引号、单引号、无引号三种写法全部删除
      .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
      // 所有指向脚本协议的属性值（href / xlink:href / src 等）
      .replace(
        /\s[a-z:_-]+\s*=\s*(?:"[^"]*(?:javascript|vbscript|data:text\/html)[^"]*"|'[^']*(?:javascript|vbscript|data:text\/html)[^']*'|[^\s>"']*(?:javascript|vbscript|data:text\/html)[^\s>]*)/gi,
        ""
      );
  }

  svgToDataUri(svg) {
    // 7.3：同一份 SVG 只清洗+编码一次（自定义图标在 loadIconConfig 已预算，这里覆盖徽标/锁图标）
    const key = String(svg);
    const cached = this.uriCache.get(key);
    if (cached) return cached;

    const safe = this.sanitizeSvg(key)
      .replace(/\r?\n/g, " ")
      .replace(/>\s+</g, "><");
    const uri = `url("data:image/svg+xml;charset=UTF-8,${encodeURIComponent(safe)}")`;
    this.uriCache.set(key, uri);
    return uri;
  }

  makeSquareSvg(color, badge = false) {
    const stroke = badge ? ` stroke="#ffffff" stroke-width="1.2"` : "";
    const x = badge ? 1.2 : 2.5;
    const y = badge ? 1.2 : 2.5;
    const size = badge ? 5.6 : 11;
    const rx = badge ? 1.1 : 1.8;
    const vb = badge ? "0 0 8 8" : "0 0 16 16";

    return this.svgToDataUri(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}">` +
      `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${rx}" fill="${color}"${stroke}/>` +
      `</svg>`
    );
  }

  makeCircleSvg(color, badge = false) {
    const vb = badge ? "0 0 8 8" : "0 0 16 16";
    const cx = badge ? 4 : 8;
    const cy = badge ? 4 : 8;
    const r = badge ? 3 : 5.8;
    const stroke = badge ? ` stroke="#ffffff" stroke-width="1.2"` : "";

    return this.svgToDataUri(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}">` +
      `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}"${stroke}/>` +
      `</svg>`
    );
  }

  cssString(value) {
    return String(value)
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\A ");
  }

  selectors(path, type, pseudo) {
    const p = this.cssString(path);
    const native =
      type === "folder"
        ? `.workspace-leaf-content[data-type="file-explorer"] .nav-folder-title[data-path="${p}"] > .nav-folder-title-content::${pseudo}`
        : `.workspace-leaf-content[data-type="file-explorer"] .nav-file-title[data-path="${p}"] > .nav-file-title-content::${pseudo}`;

    const fallback =
      `.workspace-leaf-content[data-type="file-explorer"] .tree-item-self[data-path="${p}"] > .tree-item-inner::${pseudo}`;

    return `${native},\n${fallback}`;
  }

  buildCss(rows) {
    // 7.6：不再对文件树标题内容全局加 display:flex —— 那会把文本变成匿名 flex item，
    // 使 text-overflow:ellipsis 失效（长文件名不再省略号截断），且影响白名单之外的条目。
    // 改为在每个条目自己的 ::before/::after 上做垂直居中，宿主 display 保持 Obsidian 原样。
    const lines = ["/* xyblue135 私人 · 笔记状态 - whitelist only */"];

    // 7.3：锁图标整份只需编码一次
    const lockUri = this.svgToDataUri(LOCK_SVG);

    for (const row of rows.values()) {
      // 7.2/7.5：empty（目录内没有任何 Markdown）与 pending（元数据未就绪）没有可信颜色，
      // 不再复用 COLORS.undone，避免 00_assets、空目录长期显示红点。
      const statusColor =
        row.status === "done" ? COLORS.done : row.status === "undone" ? COLORS.undone : null;
      // 7.3：iconMap 里存的已经是 data URI，热路径不再 sanitize + encodeURIComponent
      const customUri = this.iconMap.get(row.path);
      const before = this.selectors(row.path, row.type, "before");

      if (customUri) {
        // 没有可信状态色（empty/pending）时只画自定义图标，不叠加状态徽标
        const badgeUri = statusColor
          ? row.type === "folder"
            ? this.makeSquareSvg(statusColor, true)
            : this.makeCircleSvg(statusColor, true)
          : "";

        lines.push(
          `${before} {`,
          `  content: "";`,
          `  display: inline-block !important;`,
          `  vertical-align: middle !important;`,
          `  width: ${SVG_SIZE}px;`,
          `  height: ${SVG_SIZE}px;`,
          `  min-width: ${SVG_SIZE}px;`,
          `  background-image: ${badgeUri ? `${badgeUri}, ${customUri}` : customUri};`,
          `  background-size: ${badgeUri ? "7px 7px, contain" : "contain"};`,
          `  background-repeat: ${badgeUri ? "no-repeat, no-repeat" : "no-repeat"};`,
          `  background-position: ${badgeUri ? "right bottom, center" : "center"};`,
          `  margin-right: 6px;`,
          `  pointer-events: none;`,
          `  opacity: 0.92;`,
          `  flex-shrink: 0;`,
          `}`
        );
      } else if (statusColor) {
        const statusUri =
          row.type === "folder"
            ? this.makeSquareSvg(statusColor, false)
            : this.makeCircleSvg(statusColor, false);

        lines.push(
          `${before} {`,
          `  content: "";`,
          `  display: inline-block !important;`,
          `  vertical-align: middle !important;`,
          `  width: ${SVG_SIZE}px;`,
          `  height: ${SVG_SIZE}px;`,
          `  min-width: ${SVG_SIZE}px;`,
          `  background-image: ${statusUri};`,
          `  background-size: contain;`,
          `  background-repeat: no-repeat;`,
          `  background-position: center;`,
          `  margin-right: 6px;`,
          `  pointer-events: none;`,
          `  opacity: 0.74;`,
          `  flex-shrink: 0;`,
          `}`
        );
      }
      // 既没有状态色、也没有自定义图标时（空目录/待定目录）不输出任何东西，保持文件树干净。

      // 7.1：文件夹现在也渲染“聚合未公开”锁标记（此前只有 file 能进这个分支，hasUnopen 成了死代码）。
      // 文件夹与文件共用同一个 LOCK_SVG 方形锁徽标，保持既有样式体系；pending/empty 的 unopen 为假值，自然跳过。
      if (row.unopen) {
        const after = this.selectors(row.path, row.type, "after");
        lines.push(
          `${after} {`,
          `  content: "";`,
          `  display: inline-block !important;`,
          `  vertical-align: middle !important;`,
          `  width: ${SVG_SIZE}px;`,
          `  height: ${SVG_SIZE}px;`,
          `  min-width: ${SVG_SIZE}px;`,
          `  background-image: ${lockUri};`,
          `  background-size: contain;`,
          `  background-repeat: no-repeat;`,
          `  background-position: center;`,
          `  margin-left: 4px;`,
          `  opacity: 0.78;`,
          `  pointer-events: none;`,
          `  flex-shrink: 0;`,
          `}`
        );
      }
    }

    return lines.join("\n");
  }

  // 7.3：只用轻量签名（路径+类型+状态+是否有锁/图标）判断是否需要重建，避免比较约 1MB 的整份 CSS
  buildSignature(rows) {
    const parts = [`icon-v${this.iconVersion}`];
    for (const row of rows.values()) {
      parts.push(
        `${row.type}|${row.path}|${row.status || ""}|${row.unopen ? 1 : 0}|${this.iconMap.has(row.path) ? 1 : 0}`
      );
    }
    return parts.join("\n");
  }

  rebuildStyles() {
    if (!this.styleEl) return;

    const { rows, skippedFiles } = this.collectRows();
    // 7.4：非 .md 文件不再弹 9 秒告警，只做调试记录
    this.logSkippedFiles(skippedFiles);

    // 7.5：本次扫描存在待定项时，做有限次延迟重扫，防止极端情况下 resolved 事件缺失而永久停留在“待定”
    this.schedulePendingRescan(rows);

    // 7.3：先比轻量签名，签名没变就不再生成/比较整份 CSS
    const signature = this.buildSignature(rows);
    if (signature === this.lastCssSignature) return;
    this.lastCssSignature = signature;

    this.styleEl.textContent = this.buildCss(rows);
  }

  // 7.5：待定项兜底重扫（最多 3 次，恢复正常后自动补满配额）
  schedulePendingRescan(rows) {
    let hasPending = false;
    for (const row of rows.values()) {
      if (row.status === "pending") {
        hasPending = true;
        break;
      }
    }

    if (!hasPending) {
      this.pendingRescansLeft = 3;
      return;
    }

    if (this.pendingRescansLeft <= 0 || this.pendingRescanTimer) return;

    this.pendingRescansLeft -= 1;
    this.pendingRescanTimer = window.setTimeout(() => {
      this.pendingRescanTimer = null;
      this.rebuildStyles();
    }, 2000);
  }
};
